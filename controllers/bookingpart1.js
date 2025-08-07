// bookingController.js - FIXED VERSION that actually works

const { getUserBooking, setUserBooking, setUserMode } = require('../sessions/sessionManager');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { normalizePhone } = require('../utils/normalizePhone');
const { getOwnerByPhone } = require('../lib/ownerDb');
const { get_user_by_id } = require('../lib/userDb');
const { db } = require('../database/db');
const { owners, ownerVehicleTypes, slots, bookings } = require('../database/schema');
const { eq, and, isNull, desc, or, sql, lt } = require('drizzle-orm');
const Fuse = require('fuse.js');
const { v4: uuidv4 } = require('uuid');

// Constants
const TIMEOUT_LIMIT = 300000; // 5 minutes
const BOOKING_TIMEOUT = 3600000; // 1 hour
const MAX_RETRY_ATTEMPTS = 3;

const BOOKING_STATES = {
  START: 1,
  GET_PHONE_VEHICLE: 2,
  GET_DESTINATION: 3,
  CONFIRM_BOOKING: 4,
  PROCESSING: 5,
};

const VEHICLE_TYPES = [
  { type: 'Two-wheeler', aliases: ['bike', 'scooter', '2 wheeler', 'two', '2w', 'motorcycle'], icon: '🛵', slotPrefix: 'M' },
  { type: '4-seat car', aliases: ['car', 'sedan', 'hatchback', '4 seater', '4s', '4 seat', 'small car'], icon: '🚗', slotPrefix: 'C' },
  { type: '8-seat car', aliases: ['suv', 'xl', '8 seater', '8s', 'big car', 'large car', 'xuv'], icon: '🚙', slotPrefix: 'L' },
  { type: 'Van', aliases: ['van', 'minivan', 'traveller', 'tempo'], icon: '🚐', slotPrefix: 'V' },
];

// FIXED: More flexible cancel patterns
const CANCEL_PATTERNS = [
  'cancel ticket',
  'cancel booking', 
  'cancel my booking',
  'cancel my ticket',
  'cancel reservation',
  'cancel slot',
  'abort booking',
  'delete booking',
  'remove booking',
  'stop booking',
  'cancel',
  'abort'
];

const EXIT_KEYWORDS = ['exit', 'stop', 'quit', 'back', 'home', 'menu'];

// Helper Functions
function truncate(str, length = 25) {
  if (!str) return 'N/A';
  return str.length > length ? str.slice(0, length) + '...' : str;
}

function isSessionExpired(booking) {
  return booking?.lastInteractionTime && Date.now() - booking.lastInteractionTime > TIMEOUT_LIMIT;
}

function cleanupSession(userId) {
  try {
    setUserBooking(userId, null);
    setUserMode(userId, 'AI');
    console.log(`✅ Session cleaned for user: ${userId}`);
  } catch (error) {
    console.error('Session cleanup error:', error);
  }
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

function normalize(text) {
  return text?.toLowerCase().replace(/[-\s_]/g, '') || '';
}

function matchVehicleType(input) {
  if (!input) return null;
  const norm = normalize(input);
  
  for (const vehicle of VEHICLE_TYPES) {
    if (vehicle.aliases.some(alias => 
      normalize(alias) === norm || 
      normalize(alias).includes(norm) || 
      norm.includes(normalize(alias))
    )) {
      return vehicle.type;
    }
  }
  return null;
}

// FIXED: Better cancellation detection
function isCancelRequest(message) {
  if (!message) return false;
  
  const lowerMsg = message.toLowerCase().trim();
  
  // Direct match
  if (CANCEL_PATTERNS.includes(lowerMsg)) {
    return true;
  }
  
  // Contains any cancel pattern
  return CANCEL_PATTERNS.some(pattern => lowerMsg.includes(pattern));
}

// Auto-cleanup expired bookings
async function cleanupExpiredBookings() {
  try {
    const now = new Date();
    const expiredTime = new Date(now - BOOKING_TIMEOUT);
    
    const expiredBookings = await db
      .select({
        id: bookings.id,
        slot_id: bookings.slot_id,
        user_id: bookings.user_id
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          lt(bookings.created_at, expiredTime)
        )
      );

    console.log(`🧹 Found ${expiredBookings.length} expired bookings to clean`);

    if (expiredBookings.length === 0) return;

    // Update bookings to expired
    await db
      .update(bookings)
      .set({ 
        status: 'expired',
        updated_at: now
      })
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          lt(bookings.created_at, expiredTime)
        )
      );

    // Free up slots
    const slotIds = expiredBookings.map(b => b.slot_id).filter(Boolean);
    if (slotIds.length > 0) {
      for (const slotId of slotIds) {
        await db
          .update(slots)
          .set({
            state: 'available',
            is_occupied: false,
            last_status_change: now
          })
          .where(eq(slots.id, slotId));
      }
    }

    console.log(`✅ Cleaned up ${expiredBookings.length} expired bookings`);
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

// Check for active bookings with auto-cleanup
async function hasActiveBooking(userId) {
  try {
    // Clean expired bookings first
    await cleanupExpiredBookings();
    
    const [activeBooking] = await db
      .select({
        id: bookings.id,
        user_id: bookings.user_id,
        slot_id: bookings.slot_id,
        slot_number: bookings.slot_number,
        vehicle_type: bookings.vehicle_type,
        destination: bookings.destination,
        status: bookings.status,
        created_at: bookings.created_at,
        expires_at: bookings.expires_at,
        owner_id: bookings.owner_id
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.user_id, userId),
          eq(bookings.status, 'confirmed')
        )
      )
      .orderBy(desc(bookings.created_at))
      .limit(1);

    return activeBooking || null;
  } catch (error) {
    console.error('Error checking active booking:', error);
    return null;
  }
}

// CRITICAL FIX: Complete cancellation function
async function cancelUserBooking(userId, forceCancel = false) {
  try {
    console.log(`🔄 Attempting to cancel booking for user: ${userId}`);
    
    // Get active booking
    const activeBooking = await hasActiveBooking(userId);
    
    if (!activeBooking) {
      console.log(`❌ No active booking found for user: ${userId}`);
      return { 
        success: false, 
        message: '❌ No active booking found to cancel.\n\n💡 Type *Book* to make a new reservation.' 
      };
    }

    console.log(`📋 Found booking to cancel: ${activeBooking.id}`);

    // Start transaction-like operations
    let updateSuccess = false;
    let slotFreeSuccess = false;

    try {
      // 1. Update booking status to cancelled
      const [updatedBooking] = await db
        .update(bookings)
        .set({ 
          status: 'cancelled',
          updated_at: new Date()
        })
        .where(
          and(
            eq(bookings.id, activeBooking.id),
            eq(bookings.status, 'confirmed') // Only cancel if still confirmed
          )
        )
        .returning();

      updateSuccess = !!updatedBooking;
      console.log(`📝 Booking update success: ${updateSuccess}`);

      if (!updateSuccess) {
        return { 
          success: false, 
          message: '❌ Booking could not be cancelled (may already be cancelled).' 
        };
      }

      // 2. Free the slot
      if (activeBooking.slot_id) {
        const [updatedSlot] = await db
          .update(slots)
          .set({ 
            state: 'available', 
            is_occupied: false,
            last_status_change: new Date()
          })
          .where(eq(slots.id, activeBooking.slot_id))
          .returning();
        
        slotFreeSuccess = !!updatedSlot;
        console.log(`🅿️ Slot free success: ${slotFreeSuccess}`);
      } else {
        slotFreeSuccess = true; // No slot to free
      }

      // 3. Generate success message
      const vehicleInfo = VEHICLE_TYPES.find(v => v.type === activeBooking.vehicle_type) || {};
      const slotDisplay = `${vehicleInfo.slotPrefix}${activeBooking.slot_number || ''}`;
      
      const successMessage = `🚫 *Booking Cancelled Successfully* ✅

━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 Ticket: ${activeBooking.id}
📍 Location: ${truncate(activeBooking.destination, 30)}
${vehicleInfo.icon} Vehicle: ${activeBooking.vehicle_type}
🅿️ Slot: ${slotDisplay}
🕒 Cancelled: ${new Date().toLocaleString('en-IN')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Your slot has been freed up
💰 No charges applied

💡 Type *"Book"* to make a new booking!`;

      console.log(`✅ Booking cancelled successfully: ${activeBooking.id}`);
      
      return { 
        success: true, 
        message: successMessage,
        bookingId: activeBooking.id
      };

    } catch (dbError) {
      console.error('Database operation failed:', dbError);
      return { 
        success: false, 
        message: '❌ Database error occurred. Please try again or contact support.' 
      };
    }

  } catch (error) {
    console.error('❌ Cancel booking error:', error);
    return { 
      success: false, 
      message: '❌ System error. Please try again.\n\nIf problem persists, contact support.' 
    };
  }
}

// Enhanced owner finding
async function findAvailableOwner(vehicleType, destinationText) {
  try {
    const activeOwners = await db
      .select()
      .from(owners)
      .where(eq(owners.is_active, true));
    
    if (activeOwners.length === 0) {
      return { owner: null, message: 'No parking available currently' };
    }

    const fuseOptions = {
      keys: ['location', 'name'],
      threshold: 0.4,
      includeScore: true
    };

    const fuse = new Fuse(activeOwners, fuseOptions);
    const results = fuse.search(destinationText.trim());
    
    if (results.length === 0) {
      return { owner: null, message: `No parking found near "${truncate(destinationText)}"` };
    }

    return { owner: results[0].item, score: results[0].score };

  } catch (err) {
    console.error('Error in findAvailableOwner:', err);
    return { owner: null, message: 'Error searching for parking' };
  }
}

// Slot reservation
async function findAndReserveSlot(ownerId, vehicleType, bookingId) {
  try {
    const availableSlots = await db
      .select()
      .from(slots)
      .where(
        and(
          eq(slots.owner_id, ownerId),
          eq(slots.state, 'available')
        )
      )
      .orderBy(slots.index)
      .limit(1);

    if (availableSlots.length === 0) {
      return { slot: null, message: 'No slots available' };
    }

    const slot = availableSlots[0];
    
    const [updatedSlot] = await db
      .update(slots)
      .set({ 
        state: 'occupied', 
        is_occupied: true,
        last_status_change: new Date()
      })
      .where(eq(slots.id, slot.id))
      .returning();

    return { slot: updatedSlot };

  } catch (err) {
    console.error('Error reserving slot:', err);
    return { slot: null, message: 'Error reserving slot' };
  }
}

// Create booking record
async function createBookingRecord(userId, ownerId, slot, bookingDetails) {
  const bookingId = `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  
  try {
    const [booking] = await db
      .insert(bookings)
      .values({
        id: bookingId,
        user_id: userId,
        owner_id: ownerId,
        slot_id: slot.id,
        slot_number: slot.index,
        vehicle_type: bookingDetails.vehicleType,
        destination: bookingDetails.destination,
        status: 'confirmed',
        created_at: new Date(),
        expires_at: new Date(Date.now() + BOOKING_TIMEOUT),
        updated_at: new Date()
      })
      .returning();

    return booking.id;
  } catch (error) {
    console.error('Error creating booking:', error);
    throw error;
  }
}

// Generate ticket
function generateBookingTicket(booking, owner, slotInfo) {
  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === booking.vehicleType) || {};
  const slotDisplay = `${vehicleInfo.slotPrefix}${booking.slotNumber}`;
  
  return `🎫 *Parking Ticket Confirmed* 🅿️
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 ID: ${booking.bookingId}
👤 Name: ${booking.name}
📞 Phone: ${booking.phone}
${vehicleInfo.icon} Vehicle: ${booking.vehicleType}
📍 Location: ${truncate(booking.destination, 30)}
🕒 Booked: ${new Date().toLocaleString('en-IN')}
🅿️ Slot: ${slotDisplay}
👷 Owner: ${owner.name || 'Parking Manager'}
📱 Contact: +91${owner.phone_num}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
ℹ️ Present this ticket on arrival
⏰ Valid for 1 hour
🚫 To cancel: Type "cancel ticket"
━━━━━━━━━━━━━━━━━━━━━━━━━━━`.trim();
}

// State Handlers
async function handleStartState(userId, message, booking) {
  const name = message.trim();
  
  if (!name || name.length < 2) {
    return '👋 Please enter your full name (at least 2 characters):\n\nExample: `Raj Kumar`';
  }

  booking.name = name;
  booking.step = BOOKING_STATES.GET_PHONE_VEHICLE;
  booking.retryCount = 0;
  setUserBooking(userId, booking);

  const vehicleOptions = VEHICLE_TYPES.map(v => `${v.icon} ${v.type}`).join('\n');
  return `👍 Hello *${name}*!\n\nPlease send:\n📱 Phone number, 🚗 Vehicle type\n\n*Available vehicles:*\n${vehicleOptions}\n\n*Example:* \`9876543210, car\``;
}

async function handlePhoneVehicleState(userId, message, booking) {
  const parts = message.split(',').map(p => p.trim());
  
  if (parts.length < 2) {
    booking.retryCount = (booking.retryCount || 0) + 1;
    if (booking.retryCount >= MAX_RETRY_ATTEMPTS) {
      cleanupSession(userId);
      return '❌ Too many attempts. Please start over by typing *Book*.';
    }
    
    return `⚠️ Please provide: phone, vehicle\n\n*Example:* \`9876543210, car\`\n\nAttempt ${booking.retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  const phoneRaw = parts[0];
  const vehicleRaw = parts[1];

  const phone = normalizePhone(phoneRaw);
  if (!isValidPhone(phone)) {
    booking.retryCount = (booking.retryCount || 0) + 1;
    if (booking.retryCount >= MAX_RETRY_ATTEMPTS) {
      cleanupSession(userId);
      return '❌ Too many attempts. Please start over.';
    }
    
    return `⚠️ Enter valid 10-digit mobile number\n*Format:* 9876543210\nAttempt ${booking.retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  const vehicleType = matchVehicleType(vehicleRaw);
  if (!vehicleType) {
    booking.retryCount = (booking.retryCount || 0) + 1;
    if (booking.retryCount >= MAX_RETRY_ATTEMPTS) {
      cleanupSession(userId);
      return '❌ Too many attempts. Please start over.';
    }
    
    const validTypes = VEHICLE_TYPES.map(v => `${v.icon} *${v.type}*`).join('\n');
    return `🚗 Choose valid vehicle:\n\n${validTypes}\n\nAttempt ${booking.retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  booking.phone = `+91${phone}`;
  booking.vehicleType = vehicleType;
  booking.step = BOOKING_STATES.GET_DESTINATION;
  booking.retryCount = 0;
  setUserBooking(userId, booking);

  const vehicleEmoji = VEHICLE_TYPES.find(v => v.type === vehicleType)?.icon || '🚗';
  return `✅ Details confirmed:\n📱 +91${phone}\n${vehicleEmoji} ${vehicleType}\n\n📍 *Where do you want to park?*\nExample: "Marina Beach", "T Nagar"`;
}

async function handleDestinationState(userId, message, booking) {
  const destinationText = message.trim();
  
  if (destinationText.length < 3) {
    booking.retryCount = (booking.retryCount || 0) + 1;
    if (booking.retryCount >= MAX_RETRY_ATTEMPTS) {
      cleanupSession(userId);
      return '❌ Too many attempts. Please start over.';
    }
    
    return `📍 Enter destination (at least 3 characters)\nExample: "Central Station"\n\nAttempt ${booking.retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  // Find parking
  const result = await findAvailableOwner(booking.vehicleType, destinationText);
  
  if (!result.owner) {
    booking.retryCount = (booking.retryCount || 0) + 1;
    
    if (booking.retryCount >= MAX_RETRY_ATTEMPTS) {
      cleanupSession(userId);
      return `❌ No parking found after ${MAX_RETRY_ATTEMPTS} attempts.\n\nTry different locations or type *Book* to start fresh.`;
    }
    
    return `❌ ${result.message}\n\nTry:\n• Different spelling\n• Nearby landmarks\n• Major areas\n\nAttempt ${booking.retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  booking.matchedOwner = result.owner;
  booking.destination = result.owner.location || destinationText;
  booking.step = BOOKING_STATES.CONFIRM_BOOKING;
  booking.retryCount = 0;
  setUserBooking(userId, booking);

  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === booking.vehicleType) || {};
  
  return `🎯 *Parking Found!*\n\n📍 *Location:* ${result.owner.location}\n🅿️ *Owner:* ${result.owner.name || 'Manager'}\n${vehicleInfo.icon} *Vehicle:* ${booking.vehicleType}\n👤 *Name:* ${booking.name}\n📱 *Phone:* ${booking.phone}\n\n✅ Type *"CONFIRM"* to book\n❌ Type *"CANCEL"* to change`;
}

async function handleConfirmationState(userId, message, booking) {
  const response = message.trim().toLowerCase();
  
  if (!['confirm', 'yes', 'ok', 'book'].includes(response)) {
    if (['cancel', 'no', 'change'].includes(response)) {
      booking.step = BOOKING_STATES.GET_DESTINATION;
      setUserBooking(userId, booking);
      return '📍 Please enter a different destination.';
    }
    
    return '❓ Type *"CONFIRM"* to book or *"CANCEL"* to change location.';
  }

  // Process booking
  try {
    const owner = booking.matchedOwner;
    
    // Find and reserve slot
    const slotResult = await findAndReserveSlot(owner.id, booking.vehicleType, 'temp');
    if (!slotResult.slot) {
      cleanupSession(userId);
      return `🚗 No slots available at *${booking.destination}*.\n\nType *Book* to try other locations.`;
    }

    // Create booking
    booking.slotNumber = slotResult.slot.index;
    booking.slotId = slotResult.slot.id;
    booking.bookingId = await createBookingRecord(userId, owner.id, slotResult.slot, booking);

    // Generate ticket
    const ticket = generateBookingTicket(booking, owner, slotResult.slot);

    // Send notifications
    sendWhatsAppMessage(userId, ticket).catch(err => console.error('User notification failed:', err));
    sendWhatsAppMessage(owner.phone_num, `📥 *New Booking!*\n\n${ticket}`).catch(err => console.error('Owner notification failed:', err));

    // Cleanup session
    cleanupSession(userId);

    return `🎉 *Booking Successful!*\n\n${ticket}\n\n📱 Screenshot this ticket!\n💡 Type *"status"* to check booking anytime.`;

  } catch (error) {
    console.error('Booking error:', error);
    cleanupSession(userId);
    return '❌ Booking failed. Please try again.\n\nType *Book* to restart.';
  }
}

// MAIN HANDLER - COMPLETELY FIXED
async function handleBooking(userId, incomingMessage) {
  try {
    const message = (incomingMessage || '').trim();
    console.log(`📥 Processing message for user ${userId}: "${message}"`);

    // PRIORITY 1: Handle cancellation requests FIRST
    if (isCancelRequest(message)) {
      console.log(`🚫 Cancel request detected from user: ${userId}`);
      const result = await cancelUserBooking(userId);
      console.log(`🚫 Cancel result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      return result.message;
    }

    // Handle exit commands
    if (EXIT_KEYWORDS.some(keyword => message.toLowerCase().startsWith(keyword))) {
      cleanupSession(userId);
      return '🏠 Back to main menu.\n\n💡 Type *Book* anytime to start booking.';
    }

    // Check for existing booking before starting new one
    if (['book', 'start', 'new'].some(cmd => message.toLowerCase().includes(cmd))) {
      const activeBooking = await hasActiveBooking(userId);
      if (activeBooking) {
        const vehicleInfo = VEHICLE_TYPES.find(v => v.type === activeBooking.vehicle_type) || {};
        return `🚫 *You already have an active booking!*

🎫 Current Booking:
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 ${activeBooking.id}
${vehicleInfo.icon} ${activeBooking.vehicle_type}
📍 ${truncate(activeBooking.destination, 30)}
🅿️ ${vehicleInfo.slotPrefix}${activeBooking.slot_number}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Options:
🚫 *"cancel ticket"* - Cancel current booking
📱 *"status"* - View booking details
🏠 *"menu"* - Main menu`;
      }
    }

    // Get/create booking session
    let booking = getUserBooking(userId);
    if (!booking) {
      booking = { 
        step: BOOKING_STATES.START,
        lastInteractionTime: Date.now(),
        retryCount: 0
      };
    }

    // Check session expiry
    if (isSessionExpired(booking)) {
      cleanupSession(userId);
      return `⌛ *Session Expired*\n\nType *Book* to start fresh.`;
    }

    // Update interaction time
    booking.lastInteractionTime = Date.now();
    setUserBooking(userId, booking);

    // Route to handlers
    switch (booking.step) {
      case BOOKING_STATES.START:
        return await handleStartState(userId, message, booking);
        
      case BOOKING_STATES.GET_PHONE_VEHICLE:
        return await handlePhoneVehicleState(userId, message, booking);
        
      case BOOKING_STATES.GET_DESTINATION:
        return await handleDestinationState(userId, message, booking);
        
      case BOOKING_STATES.CONFIRM_BOOKING:
        return await handleConfirmationState(userId, message, booking);
        
      case BOOKING_STATES.PROCESSING:
        return '⏳ Processing... Please wait.\n\nType *Book* if stuck.';
        
      default:
        cleanupSession(userId);
        return '❌ Session error. Type *Book* to restart.';
    }

  } catch (error) {
    console.error('❌ Main booking error:', error);
    cleanupSession(userId);
    return '❌ System error. Type *Book* to try again.';
  }
}

// FIXED: Status function
async function getUserBookingStatus(userId) {
  try {
    const activeBooking = await hasActiveBooking(userId);
    
    if (!activeBooking) {
      return '📭 *No Active Booking*\n\nYou don\'t have any parking bookings.\n\n💡 Type *Book* to make a reservation.';
    }
    
    const vehicleInfo = VEHICLE_TYPES.find(v => v.type === activeBooking.vehicle_type) || {};
    const createdTime = new Date(activeBooking.created_at).toLocaleString('en-IN');
    
    // Calculate remaining time
    const now = new Date();
    const expiry = new Date(activeBooking.created_at);
    expiry.setTime(expiry.getTime() + BOOKING_TIMEOUT);
    const timeLeft = Math.max(0, Math.floor((expiry - now) / (1000 * 60)));
    
    const timeStatus = timeLeft > 0 
      ? `⏰ ${timeLeft} minutes remaining`
      : '🔴 Booking expired';

    return `📱 *Your Active Booking*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 ${activeBooking.id}
${vehicleInfo.icon} ${activeBooking.vehicle_type}
📍 ${truncate(activeBooking.destination, 30)}
🅿️ Slot: ${vehicleInfo.slotPrefix}${activeBooking.slot_number}
🕒 Booked: ${createdTime}
${timeStatus}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 Type "cancel ticket" to cancel`;

  } catch (error) {
    console.error('Status error:', error);
    return '❌ Unable to get booking status. Try again.';
  }
}

// Start cleanup job (call this when server starts)
setInterval(cleanupExpiredBookings, 300000); // Every 5 minutes

module.exports = {
  handleBooking,
  getUserBookingStatus,
  hasActiveBooking,
  cancelUserBooking, // FIXED: Export the working cancel function
  cleanupExpiredBookings,
  VEHICLE_TYPES,
  BOOKING_STATES,
  truncate,
  normalize,
  matchVehicleType,
};