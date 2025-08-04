const TIMEOUT_LIMIT = 300000; // 5 minutes
const {
  getUserBooking,
  setUserBooking,
  getUserMode,
  setUserMode,
  markSlotBooked
} = require('../sessions/sessionManager');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { normalizePhone } = require('../utils/normalizePhone');
const { getOwnerByPhone } = require('../lib/ownerDb');
const { db } = require('../database/db');
const { owners, ownerVehicleTypes, slots } = require('../database/schema');
const { eq, and, or } = require('drizzle-orm');
const Fuse = require('fuse.js');
const { v4: uuidv4 } = require('uuid');

// Constants
const OWNERS_CACHE_TTL = 30000;
const MAX_SLOT_CHECK_ATTEMPTS = 3;
const BOOKING_RETRY_DELAY = 500; // ms
const MAX_BOOKING_ATTEMPTS = 3;
const SLOT_LOCK_TIMEOUT = 10000; // 10 seconds

const BOOKING_STATES = {
  START: 1,
  GET_PHONE_VEHICLE: 2,
  GET_DESTINATION: 3,
  CONFIRM_BOOKING: 4,
  PAYMENT: 5,
  COMPLETE: 6
};

const VEHICLE_TYPES = [
  { 
    type: 'two-wheeler', 
    aliases: ['bike', 'scooter', '2 wheeler', 'two wheeler', 'scooty'], 
    priority: 1,
    basePrice: 20
  },
  { 
    type: '4-seat car', 
    aliases: ['car', 'sedan', 'hatchback', '4 seater', '4-seater', 'normal car'], 
    priority: 2,
    basePrice: 50
  },
  { 
    type: '8-seat car', 
    aliases: ['suv', 'xl', '8 seater', '8-seater', 'big car'], 
    priority: 3,
    basePrice: 80
  },
  { 
    type: 'van', 
    aliases: ['van', 'minivan', 'traveller'], 
    priority: 4,
    basePrice: 100
  }
].sort((a, b) => b.priority - a.priority);

// In-memory locks for slot booking
const bookingLocks = new Map();

// Helper Functions
function truncate(str, length = 20) {
  return str?.length > length ? str.slice(0, length) + '...' : str;
}

function isSessionExpired(booking) {
  return booking?.lastInteractionTime && Date.now() - booking.lastInteractionTime > TIMEOUT_LIMIT;
}

function cleanupSession(userId) {
  setUserBooking(userId, null);
  setUserMode(userId, 'AI');
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

function matchVehicleType(input) {
  if (!input) return null;
  
  const lowerInput = input.toLowerCase();
  for (const vehicle of VEHICLE_TYPES) {
    if (vehicle.aliases.some(alias => lowerInput.includes(alias))) {
      return vehicle.type;
    }
  }
  return null;
}

function generateBookingTicket(booking, owner) {
  const ticketId = `TKT-${Date.now().toString().slice(-6)}`;
  const price = calculatePrice(booking.vehicleType, booking.duration);
  
  return {
    id: ticketId,
    slip: `\n🎫 *Parking Ticket Confirmed* 🅿️\n━━━━━━━━━━━━━━━━━━━━\n🆔 ${ticketId}\n👤 ${booking.name}\n📞 ${booking.phone}\n🚗 ${booking.vehicleType}\n📍 ${booking.destination}\n⏱️ Duration: ${booking.duration || '1 hour'}\n💰 Price: ₹${price}\n🕒 ${new Date().toLocaleString()}\n🅿️ Slot ${booking.slotNumber}\n👷 ${owner.name || owner.phone_num}\n━━━━━━━━━━━━━━━━━━━━\nℹ️ Present this ticket on arrival`,
    price
  };
}

function calculatePrice(vehicleType, duration = '1 hour') {
  const hours = duration.includes('hour') ? 
    parseInt(duration) : 
    Math.ceil(parseInt(duration) / 60);
  const vehicle = VEHICLE_TYPES.find(v => v.type === vehicleType);
  return (vehicle?.basePrice || 50) * Math.max(1, hours);
}

// Core Booking Functions
async function findAvailableOwner(vehicleType, destinationText) {
  try {
    const dbOwners = await db.select().from(owners)
      .where(eq(owners.is_active, true));
    
    const owner = fuzzyMatchOwnerLocation(destinationText, dbOwners);
    
    if (!owner || typeof owner.lat !== 'number' || typeof owner.lon !== 'number') {
      console.log('Owner validation failed:', { 
        exists: !!owner, 
        hasCoords: !!(owner?.lat && owner?.lon) 
      });
      return { owner: null, status: 'noNearbyOwner' };
    }

    const types = await db
      .select()
      .from(ownerVehicleTypes)
      .where(eq(ownerVehicleTypes.owner_id, owner.id));
    
    const vehicleTypes = types.map(t => t.vehicle_type.toLowerCase());
    
    if (vehicleTypes.length > 0 && !vehicleTypes.includes(vehicleType.toLowerCase())) {
      console.log('Vehicle type mismatch:', {
        ownerTypes: vehicleTypes,
        requested: vehicleType.toLowerCase()
      });
      return { owner: null, status: 'noNearbyOwner' };
    }
     
    return { owner, status: 'found', distance: 0 };
  } catch (err) {
    console.error("Error in findAvailableOwner:", err);
    return { owner: null, status: 'error' };
  }
}

function fuzzyMatchOwnerLocation(inputText, ownerList) {
  const fuse = new Fuse(ownerList, {
    keys: ['location', 'name'],
    threshold: 0.4,
    includeScore: true,
    minMatchCharLength: 3,
    ignoreLocation: true,
    shouldSort: true
  });

  const results = fuse.search(inputText.trim().toLowerCase());
  return results.length ? results[0].item : null;
}

async function findAvailableSlot(ownerId, vehicleType, attempt = 1) {
  try {
    const availableSlots = await db.select()
      .from(slots)
      .where(
        and(
          eq(slots.owner_id, ownerId),
          eq(slots.type, vehicleType),
          or(
            eq(slots.state, 'available'),
            eq(slots.is_occupied, false)
          )
        )
      )
      .orderBy(slots.index) // Get lowest numbered slot first
      .limit(1);

    if (availableSlots.length > 0) {
      return availableSlots[0].index;
    }

    if (attempt < MAX_SLOT_CHECK_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, BOOKING_RETRY_DELAY));
      return await findAvailableSlot(ownerId, vehicleType, attempt + 1);
    }

    return null;
  } catch (err) {
    console.error('Error finding available slot:', err);
    throw err;
  }
}

async function bookSlotWithRetry(ownerId, slotIndex, vehicleType, retries = MAX_BOOKING_ATTEMPTS) {
  const lockKey = `${ownerId}-${slotIndex}`;
  const lockId = uuidv4();
  
  // Check for existing lock
  if (bookingLocks.has(lockKey)) {
    const { timestamp, id } = bookingLocks.get(lockKey);
    // If lock is expired, clear it
    if (Date.now() - timestamp > SLOT_LOCK_TIMEOUT) {
      bookingLocks.delete(lockKey);
    } else {
      throw new Error('Slot is currently being booked by another process');
    }
  }

  // Set new lock
  bookingLocks.set(lockKey, { timestamp: Date.now(), id: lockId });

  try {
    // Verify slot is available
    const [slot] = await db.select()
      .from(slots)
      .where(
        and(
          eq(slots.owner_id, ownerId),
          eq(slots.index, slotIndex),
          eq(slots.type, vehicleType),
          or(
            eq(slots.state, 'available'),
            eq(slots.is_occupied, false)
          )
        )
      );

    if (!slot) {
      throw new Error('Slot not available');
    }

    // Attempt to book
    const result = await db.update(slots)
      .set({ 
        state: 'occupied',
        is_occupied: true,
        last_updated: new Date()
      })
      .where(
        and(
          eq(slots.owner_id, ownerId),
          eq(slots.index, slotIndex),
          or(
            eq(slots.state, 'available'),
            eq(slots.is_occupied, false)
          )
        )
      );

    if (result.rowCount === 0) {
      throw new Error('Slot was booked by someone else');
    }

    return true;
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, BOOKING_RETRY_DELAY));
      return await bookSlotWithRetry(ownerId, slotIndex, vehicleType, retries - 1);
    }
    throw err;
  } finally {
    // Only clear our own lock
    const currentLock = bookingLocks.get(lockKey);
    if (currentLock && currentLock.id === lockId) {
      bookingLocks.delete(lockKey);
    }
  }
}

async function processBooking(userId, booking) {
  if (!booking?.matchedOwner?.phone_num) {
    throw new Error('No valid owner information in booking');
  }

  const owner = await getOwnerByPhone(booking.matchedOwner.phone_num);
  if (!owner || !owner.is_active) {
    throw new Error(`Parking at ${truncate(booking.destination)} is no longer available`);
  }

  // Find available slot
  const slotNumber = await findAvailableSlot(owner.id, booking.vehicleType);
  if (slotNumber === null) {
    throw new Error(`${owner.name || 'This location'} has no available ${booking.vehicleType} slots`);
  }

  // Book the slot
  try {
    await bookSlotWithRetry(owner.id, slotNumber, booking.vehicleType);
  } catch (err) {
    console.error('Slot booking failed:', err);
    throw new Error('Failed to reserve parking slot. Please try again.');
  }

  // Generate ticket with price
  const ticket = generateBookingTicket(booking, owner);
  
  try {
    // Send notifications
    await Promise.all([
      sendWhatsAppMessage(userId, ticket.slip),
      sendWhatsAppMessage(owner.phone_num, `📥 New Booking Received!\n${ticket.slip}`),
      markSlotBooked(owner.id, slotNumber)
    ]);

    // Update booking with price
    booking.price = ticket.price;
    booking.currency = 'INR';
    
    return {
      ...booking,
      slotNumber,
      confirmed: true,
      assignedOwner: owner.phone_num,
      ticket
    };
  } catch (err) {
    // Rollback slot booking if messaging fails
    await db.update(slots)
      .set({ 
        state: 'available',
        is_occupied: false
      })
      .where(
        and(
          eq(slots.owner_id, owner.id),
          eq(slots.index, slotNumber)
        )
      );
    throw new Error('Failed to complete booking. Please try again.');
  }
}

// State Handlers
function handleStartState(userId, message, booking) {
  const name = message.trim();
  if (!name || name.length < 2) {
    return '👋 Please enter your name (at least 2 characters).';
  }
  
  booking.name = name;
  booking.step = BOOKING_STATES.GET_PHONE_VEHICLE;
  setUserBooking(userId, booking);
  return `👍 Got your name, *${name}*!\nPlease send:\n📱 Your phone number\n🚗 Your vehicle type\n\nExample: 9876543210, car`;
}

function handlePhoneVehicleState(userId, message, booking) {
  const [phonePart, ...vehicleParts] = message.split(/[|,;]/).map(p => p.trim());
  const vehiclePart = vehicleParts.join(' ');
  
  const phone = normalizePhone(phonePart);
  if (!isValidPhone(phone)) {
    return '⚠️ Please enter a valid 10-digit Indian phone number\nExample: 9876543210, car';
  }
  
  if (!vehiclePart) {
    return '⚠️ Please specify your vehicle type\nExample: 9876543210, car';
  }
  
  const vehicleType = matchVehicleType(vehiclePart);
  if (!vehicleType) {
    const validTypes = VEHICLE_TYPES.map(v => `- ${v.type}`).join('\n');
    return `🚗 Please specify a valid vehicle type:\n${validTypes}\n\nExample: 9876543210, car`;
  }
  
  booking.phone = `+91${phone}`;
  booking.vehicleType = vehicleType;
  booking.step = BOOKING_STATES.GET_DESTINATION;
  setUserBooking(userId, booking);
  
  return '📍 Please send your destination (address or live location)\n\nExamples:\n- Rajapalayam bus stand\n- Near Gandhi statue\n- *Send your current location*';
}

async function handleDestinationState(userId, message, booking) {
  if (typeof message === 'object' && message.lat && message.lon) {
    // Handle live location
    booking.destination = "Your current location";
    booking.destinationLat = message.lat;
    booking.destinationLon = message.lon;
  } else {
    // Handle text destination
    const destinationText = message.trim();
    if (!destinationText || destinationText.length < 3) {
      return '📍 Please enter a valid destination (at least 3 characters) or send your location';
    }
    
    const result = await findAvailableOwner(booking.vehicleType, destinationText);
    
    if (!result.owner) {
      return `❌ Couldn't find parking near "${destinationText}".\n\nPlease try:\n- A nearby landmark\n- More specific location\n- Or send your current location`;
    }
    
    booking.matchedOwner = result.owner;
    booking.destination = result.owner.location || destinationText;
    booking.destinationLat = result.owner.lat;
    booking.destinationLon = result.owner.lon;
  }
  
  booking.step = BOOKING_STATES.CONFIRM_BOOKING;
  await setUserBooking(userId, booking);
  
  const price = calculatePrice(booking.vehicleType);
  
  return `📍 You selected: *${booking.destination}*\n\n🅿️ Parking: ${booking.matchedOwner?.name || 'Local parking'}\n🚗 Vehicle: ${booking.vehicleType}\n💰 Estimated Price: ₹${price} (1 hour)\n\nType *Confirm* to book or *Cancel* to abort`;
}

async function handleConfirmationState(userId, message, booking, startTime) {
  const normalizedMessage = message.trim().toLowerCase();
  
  if (normalizedMessage === 'cancel') {
    cleanupSession(userId);
    return "🚫 Booking cancelled. You can start again by typing *Book*.";
  }
  
  if (normalizedMessage !== 'confirm') {
    return '❓ Please type *Confirm* to book or *Cancel* to abort';
  }
  
  try {
    const result = await processBooking(userId, booking);
    console.log(`Booking completed in ${Date.now() - startTime}ms`);
    
    // Move to complete state
    result.step = BOOKING_STATES.COMPLETE;
    setUserBooking(userId, result);
    
    return `✅ Booking Confirmed!\n\n${result.ticket.slip}\n\nThank you for using our service!`;
  } catch (error) {
    console.error('Booking confirmation failed:', error);
    cleanupSession(userId);
    
    if (error.message.includes('no available')) {
      return `❌ ${error.message}\n\nPlease try:\n- A different location\n- Another vehicle type\n- Or try again later`;
    }
    
    return `❌ ${error.message || 'Booking failed. Please try again.'}`;
  }
}

// Main Booking Handler
async function handleBooking(userId, incomingMessage) {
  const startTime = Date.now();
  const message = incomingMessage?.trim()?.toLowerCase() || '';

  try {
    // Handle cancellation commands
    if (["exit", "cancel", "stop", "abort"].some(cmd => message.startsWith(cmd))) {
      cleanupSession(userId);
      return "🚫 Booking cancelled. You can start again by typing *Book*.";
    }

    let booking = await getUserBooking(userId);
    if (!booking || typeof booking !== "object") {
      booking = { 
        step: BOOKING_STATES.START,
        lastInteractionTime: Date.now()
      };
    }

    if (isSessionExpired(booking)) {
      cleanupSession(userId);
      return "⌛ Your booking session expired. Please type *Book* to start again.";
    }

    booking.lastInteractionTime = Date.now();
    await setUserBooking(userId, booking);

    switch (booking.step) {
      case BOOKING_STATES.START:
        return handleStartState(userId, message, booking);
      case BOOKING_STATES.GET_PHONE_VEHICLE:
        return handlePhoneVehicleState(userId, message, booking);
      case BOOKING_STATES.GET_DESTINATION:
        return await handleDestinationState(userId, message, booking);
      case BOOKING_STATES.CONFIRM_BOOKING:
        return await handleConfirmationState(userId, message, booking, startTime);
      case BOOKING_STATES.COMPLETE:
        return "✅ Your booking is already confirmed. Do you need anything else?";
      default:
        cleanupSession(userId);
        return '❌ Unknown booking state. Please type *Book* to start again.';
    }
  } catch (err) {
    console.error('Booking flow error:', err);
    cleanupSession(userId);
    return '❌ System error. Please try again or contact support.';
  }
}

// Additional Utility Functions
async function cancelBooking(userId) {
  const booking = await getUserBooking(userId);
  if (!booking?.confirmed) return false;

  try {
    await db.update(slots)
      .set({ 
        state: 'available',
        is_occupied: false
      })
      .where(
        and(
          eq(slots.owner_id, booking.assignedOwner),
          eq(slots.index, booking.slotNumber)
        )
      );
    
    cleanupSession(userId);
    return true;
  } catch (err) {
    console.error('Failed to cancel booking:', err);
    return false;
  }
}

module.exports = {
  handleBooking,
  findAvailableOwner,
  handleConfirmationState,
  cancelBooking,
  getUserBookingStatus: async (userId) => {
    const booking = await getUserBooking(userId);
    if (!booking) return '📭 No active booking found.';
    
    let status = `📱 *Booking Status*: ${booking.confirmed ? '✅ Confirmed' : '🔄 In Progress'}`;
    if (booking.destination) status += `\n📍 ${truncate(booking.destination)}`;
    if (booking.slotNumber !== undefined) status += `\n🅿️ Slot ${booking.slotNumber}`;
    if (booking.price) status += `\n💰 Price: ₹${booking.price}`;
    
    return status;
  },
  hasActiveBooking: async (userId) => {
    const booking = await getUserBooking(userId);
    return booking?.confirmed;
  },
  VEHICLE_TYPES
};