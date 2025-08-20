const { getUserBooking, setUserBooking, getUserMode, setUserMode, clearBookingSession } = require('../sessions/sessionManager');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { normalizePhone } = require('../utils/normalizePhone');
const { getOwnerByPhone } = require('../lib/ownerDb');
const { get_user_by_id } = require('../lib/userDb');
const { db } = require('../database/db');
const { owners, slots, bookings } = require('../database/schema');
const { eq, and, lt } = require('drizzle-orm');
const Fuse = require('fuse.js');

// === CONSTANTS ===
const TIMEOUT_LIMIT = 300000; // 5 minutes
const BOOKING_TIMEOUT = 3600000; // 1 hour
const MAX_RETRY_ATTEMPTS = 3;

const BOOKING_STATES = {
  START: 'START',
  GET_PHONE_VEHICLE: 'GET_PHONE_VEHICLE',
  GET_DESTINATION: 'GET_DESTINATION',
  CONFIRM_BOOKING: 'CONFIRM_BOOKING',
  COMPLETED: 'COMPLETED'
};

const VEHICLE_TYPES = [
  { type: 'Two-wheeler', aliases: ['bike', 'scooter', '2 wheeler', 'two', '2w', 'motorcycle'], icon: '🛵', slotPrefix: 'M' },
  { type: '4-seat car', aliases: ['car', 'sedan', 'hatchback', '4 seater', '4s', '4 seat', 'small car'], icon: '🚗', slotPrefix: 'C' },
  { type: '8-seat car', aliases: ['suv', 'xl', '8 seater', '8s', 'big car', 'large car', 'xuv'], icon: '🚙', slotPrefix: 'L' },
  { type: 'Van', aliases: ['van', 'minivan', 'traveller', 'tempo'], icon: '🚐', slotPrefix: 'V' }
];

const CANCEL_PATTERNS = ['cancel ticket', 'cancel booking', 'cancel my booking', 'cancel', 'abort'];
const EXIT_KEYWORDS = ['exit', 'stop', 'quit', 'back', 'home', 'menu'];
const BOOKING_TRIGGERS = ['book', 'booking', 'start booking', 'new booking', 'book parking', 'reserve', 'park'];

// === HELPERS ===
function truncate(str, length = 25) {
  return str?.length > length ? str.slice(0, length) + '...' : str || 'N/A';
}

function isSessionExpired(booking) {
  return !booking?.lastInteractionTime || (Date.now() - booking.lastInteractionTime > TIMEOUT_LIMIT);
}

function isBookingTrigger(message) {
  if (!message) return false;
  const lowerMsg = message.toLowerCase().trim();
  return BOOKING_TRIGGERS.some(trigger =>
    lowerMsg === trigger || lowerMsg.startsWith(trigger + ' ')
  );
}

function isCancelRequest(message) {
  if (!message) return false;
  const lowerMsg = message.toLowerCase().trim();
  return CANCEL_PATTERNS.some(pattern => lowerMsg.includes(pattern));
}

function isExitRequest(message) {
  if (!message) return false;
  const lowerMsg = message.toLowerCase().trim();
  return EXIT_KEYWORDS.some(k => lowerMsg.startsWith(k));
}

async function cleanupSession(userId, reason = 'cleanup') {
  try {
    console.log(`🧹 Cleaning session for ${userId} (reason: ${reason})`);
    await clearBookingSession(userId);
    console.log(`✅ Session cleaned for ${userId}`);
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
      normalize(alias).includes(norm) || norm.includes(normalize(alias))
    )) {
      return vehicle.type;
    }
  }
  return null;
}

// === DB & BUSINESS LOGIC ===
async function cleanupExpiredBookings() {
  try {
    const now = new Date();
    const expiredTime = new Date(now - BOOKING_TIMEOUT);
    const expiredBookings = await db
      .select({ id: bookings.id, slot_id: bookings.slot_id })
      .from(bookings)
      .where(and(eq(bookings.status, 'confirmed'), lt(bookings.created_at, expiredTime)));

    if (expiredBookings.length === 0) return;

    await db
      .update(bookings)
      .set({ status: 'expired', updated_at: now })
      .where(and(eq(bookings.status, 'confirmed'), lt(bookings.created_at, expiredTime)));

    for (const { slot_id } of expiredBookings.filter(b => b.slot_id)) {
      await db
        .update(slots)
        .set({ state: 'available', is_occupied: false, last_status_change: now })
        .where(eq(slots.id, slot_id));
    }
    console.log(`✅ Cleaned up ${expiredBookings.length} expired bookings`);
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

async function hasActiveBooking(userId) {
  try {
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
        created_at: bookings.created_at
      })
      .from(bookings)
      .where(and(eq(bookings.user_id, userId), eq(bookings.status, 'confirmed')))
      .orderBy(bookings.created_at)
      .limit(1);
    return activeBooking || null;
  } catch (error) {
    console.error('Error checking active booking:', error);
    return null;
  }
}

async function cancelUserBooking(userId) {
  try {
    const activeBooking = await hasActiveBooking(userId);
    if (!activeBooking) {
      return { success: false, message: '❌ No active booking found. Type *book* to start.' };
    }

    await db
      .update(bookings)
      .set({ status: 'cancelled', updated_at: new Date() })
      .where(and(eq(bookings.id, activeBooking.id), eq(bookings.status, 'confirmed')));

    if (activeBooking.slot_id) {
      await db
        .update(slots)
        .set({ state: 'available', is_occupied: false, last_status_change: new Date() })
        .where(eq(slots.id, activeBooking.slot_id));
    }

    const vehicleInfo = VEHICLE_TYPES.find(v => v.type === activeBooking.vehicle_type) || {};
    const slotDisplay = `${vehicleInfo.slotPrefix}${activeBooking.slot_number || ''}`;
    const message = `🚫 *Booking Cancelled* ✅
🆔 Ticket: ${activeBooking.id}
📍 Location: ${truncate(activeBooking.destination)}
${vehicleInfo.icon} Vehicle: ${activeBooking.vehicle_type}
🅿️ Slot: ${slotDisplay}
🕒 Cancelled: ${new Date().toLocaleString('en-IN')}
━━━━━━━━━━━━━━━━
💡 Type *book* to start a new booking!`;

    return { success: true, message };
  } catch (error) {
    console.error('Cancel error:', error);
    return { success: false, message: '❌ Cancellation failed. Try again.' };
  }
}

async function findAvailableOwner(vehicleType, destinationText) {
  try {
    const activeOwners = await db.select().from(owners).where(eq(owners.is_active, true));
    if (!activeOwners.length) return { owner: null, message: 'No parking available.' };

    const fuse = new Fuse(activeOwners, { keys: ['location', 'name'], threshold: 0.4 });
    const results = fuse.search(destinationText.trim());
    return results.length ? { owner: results[0].item } : { owner: null, message: `No parking near "${truncate(destinationText)}"` };
  } catch (err) {
    console.error('Owner search error:', err);
    return { owner: null, message: 'Search error.' };
  }
}

async function findAndReserveSlot(ownerId) {
  const [slot] = await db
    .select()
    .from(slots)
    .where(and(eq(slots.owner_id, ownerId), eq(slots.state, 'available')))
    .orderBy(slots.index)
    .limit(1);

  if (!slot) return { slot: null };

  const [updated] = await db
    .update(slots)
    .set({ state: 'occupied', is_occupied: true, last_status_change: new Date() })
    .where(eq(slots.id, slot.id))
    .returning();

  return { slot: updated };
}

async function createBookingRecord(userId, ownerId, slot, details) {
  const bookingId = `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  const [booking] = await db
    .insert(bookings)
    .values({
      id: bookingId,
      user_id: userId,
      owner_id: ownerId,
      slot_id: slot.id,
      slot_number: slot.index,
      vehicle_type: details.vehicleType,
      destination: details.destination,
      status: 'confirmed',
      created_at: new Date(),
      expires_at: new Date(Date.now() + BOOKING_TIMEOUT),
      updated_at: new Date()
    })
    .returning();

  return booking.id;
}

function generateBookingTicket(booking, owner, slot) {
  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === booking.vehicleType) || {};
  const slotDisplay = `${vehicleInfo.slotPrefix}${booking.slotNumber}`;
  const bookedAt = new Date().toLocaleString('en-IN');
  const contact = owner.phone_num ? `+91${owner.phone_num}` : 'N/A';

  return `🎟️ *Parking Booking Confirmation*
━━━━━━━━━━━━━━━━━━━━━━━
🔖 *Ticket ID:* ${booking.bookingId}

👤 *Name:* ${booking.name}
📞 *Phone:* ${booking.phone}

${vehicleInfo.icon || '🚗'} *Vehicle Type:* ${booking.vehicleType}
🅿️ *Slot Number:* ${slotDisplay}

📍 *Destination:* ${truncate(booking.destination)}
🕒 *Booked At:* ${bookedAt}

👷 *Owner:* ${owner.name || 'Manager'}
📱 *Contact:* ${contact}
━━━━━━━━━━━━━━━━━━━━━━━
✅ *Show this ticket upon arrival.*
⏳ *Valid for 1 hour only.*
❌ *Reply with "cancel" to cancel this booking.*
`;
}


// === STEP HANDLERS ===
async function handleStartState(userId, message, booking) {
  console.log(`[BOOKING-START] userId=${userId}, message="${message}"`);
  
  const name = message.trim();
  if (!name || name.length < 2) {
    if (!name || name.length < 2) {
  return `👋 *Please enter your full name!*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: 2 characters\n📌 *Example:* \`FFFSTANZA\`\n━━━━━━━━━━━━━━━━━━━━━━`;
    }

  }

  const newBooking = {
    step: BOOKING_STATES.GET_PHONE_VEHICLE,
    name,
    retryCount: 0,
    lastInteractionTime: Date.now()
  };

  await setUserBooking(userId, newBooking);
  console.log(`[BOOKING-START] Created booking session for ${userId} with name "${name}"`);

  const vehicleOptions = VEHICLE_TYPES.map(v => `${v.icon} ${v.type}`).join('\n');
  return `👍 Hello *${name}*!  
━━━━━━━━━━━━━━━━━━━━━━━━━━━  
📥 *Please send the following details:*  
   📱 Phone Number  
   🚗 Vehicle Type  
  
📌 *Options:*  
${vehicleOptions}  
  
📋 *Example:*  
\`9876543210, car\`  
━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

}


async function handlePhoneVehicleState(userId, message, booking) {
  const parts = message.split(',').map(p => p.trim());
  if (parts.length < 2) {
    const retryCount = (booking.retryCount || 0) + 1;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      await cleanupSession(userId, 'max_retry_phone_vehicle');
      return '❌ Too many attempts. Type *book* to restart.';
    }
    const newBooking = { ...booking, retryCount, lastInteractionTime: Date.now() };
    await setUserBooking(userId, newBooking);
    return `⚠️ Provide: phone, vehicle\n*Example:* \`9876543210, car\`\nAttempt ${retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  const phone = normalizePhone(parts[0]);
  const vehicleType = matchVehicleType(parts[1]);

  if (!isValidPhone(phone)) {
    const retryCount = (booking.retryCount || 0) + 1;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      await cleanupSession(userId, 'invalid_phone');
      return '❌ Too many attempts. Type *book* to restart.';
    }
    const newBooking = { ...booking, retryCount, lastInteractionTime: Date.now() };
    await setUserBooking(userId, newBooking);
    return `⚠️ Enter valid 10-digit phone\n*Example:* 9876543210\nAttempt ${retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  if (!vehicleType) {
    const retryCount = (booking.retryCount || 0) + 1;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      await cleanupSession(userId, 'invalid_vehicle');
      return '❌ Too many attempts. Type *book* to restart.';
    }
    const newBooking = { ...booking, retryCount, lastInteractionTime: Date.now() };
    await setUserBooking(userId, newBooking);
    return `🚗 Choose valid vehicle:\n${VEHICLE_TYPES.map(v => `${v.icon} ${v.type}`).join('\n')}\nAttempt ${retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  const newBooking = {
    ...booking,
    phone: `+91${phone}`,
    vehicleType,
    step: BOOKING_STATES.GET_DESTINATION,
    retryCount: 0,
    lastInteractionTime: Date.now()
  };

  await setUserBooking(userId, newBooking);
  return `✅ Confirmed:\n📱 +91${phone}\n${VEHICLE_TYPES.find(v => v.type === vehicleType).icon} ${vehicleType}\n📍 Where do you want to park?\nExample: "Marina Beach"`;
}

async function handleDestinationState(userId, message, booking) {
  const destinationText = message.trim();
  if (destinationText.length < 3) {
    const retryCount = (booking.retryCount || 0) + 1;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      await cleanupSession(userId, 'invalid_destination');
      return '❌ Too many attempts. Type *book* to restart.';
    }
    const newBooking = { ...booking, retryCount, lastInteractionTime: Date.now() };
    await setUserBooking(userId, newBooking);
    return `📍 Enter destination (min 3 chars):\nExample: "Rajapalayam Bus stand"\nAttempt ${retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  const result = await findAvailableOwner(booking.vehicleType, destinationText);
  if (!result.owner) {
    const retryCount = (booking.retryCount || 0) + 1;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      await cleanupSession(userId, 'no_owner_found');
      return `❌ No parking found after ${MAX_RETRY_ATTEMPTS} attempts. Type *book* to restart.`;
    }
    const newBooking = { ...booking, retryCount, lastInteractionTime: Date.now() };
    await setUserBooking(userId, newBooking);
    return `❌ ${result.message}\nTry another location\nAttempt ${retryCount}/${MAX_RETRY_ATTEMPTS}`;
  }

  const newBooking = {
    ...booking,
    matchedOwner: result.owner,
    destination: result.owner.location || destinationText,
    step: BOOKING_STATES.CONFIRM_BOOKING,
    retryCount: 0,
    lastInteractionTime: Date.now()
  };

  await setUserBooking(userId, newBooking);
  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === newBooking.vehicleType) || {};
  return `🎯 *Parking Found!*\n📍 ${result.owner.location}\n🅿️ Owner: ${result.owner.name || 'Manager'}\n${vehicleInfo.icon} Vehicle: ${newBooking.vehicleType}\n👤 Name: ${newBooking.name}\n📱 Phone: ${newBooking.phone}\n✅ Type *confirm* to book\n❌ Type *cancel* to change`;
}

async function handleConfirmationState(userId, message, booking) {
  const response = message.trim().toLowerCase();
  if (!['confirm', 'yes', 'ok'].includes(response)) {
    if (['cancel', 'no', 'change'].includes(response)) {
      const newBooking = { ...booking, step: BOOKING_STATES.GET_DESTINATION, lastInteractionTime: Date.now() };
      await setUserBooking(userId, newBooking);
      return '📍 Enter a different destination.';
    }
    return '❓ Type *confirm* to book or *cancel* to change.';
  }

  try {
    const owner = booking.matchedOwner;
    const { slot } = await findAndReserveSlot(owner.id);
    if (!slot) {
      await cleanupSession(userId, 'no_slots_available');
      return `🚗 No slots available at ${booking.destination}. Type *book* to try again.`;
    }

    const bookingDetails = {
      name: booking.name,
      phone: booking.phone,
      vehicleType: booking.vehicleType,
      destination: booking.destination
    };

    const bookingId = await createBookingRecord(userId, owner.id, slot, bookingDetails);
    const ticket = generateBookingTicket({ ...booking, bookingId, slotNumber: slot.index }, owner, slot);

    await sendWhatsAppMessage(userId, ticket).catch(err => console.error('User notify failed:', err));
    await sendWhatsAppMessage(owner.phone_num, `📥 *New Booking!*\n${ticket}`).catch(err => console.error('Owner notify failed:', err));

    const completedBooking = {
      ...booking,
      step: BOOKING_STATES.COMPLETED,
      bookingId,
      lastInteractionTime: Date.now()
    };

    await setUserBooking(userId, completedBooking);
    await setUserMode(userId, 'AI'); // Switch back to AI mode after completion

    return `🎉 *Booking Successful!*\n${ticket}\n📱 Save this ticket!\n💡 Type *status* to check.`;
  } catch (error) {
    console.error('Booking error:', error);
    await cleanupSession(userId, 'booking_error');
    return '❌ Booking failed. Type *book* to restart.';
  }
}

// === MAIN HANDLER ===
async function handleBooking(userId, incomingMessage) {
  try {
    const originalMessage = incomingMessage || '';
    const trimmedMessage = originalMessage.trim();

    console.log(`📥 User ${userId}: "${originalMessage}"`);

    // 1. ALWAYS check for cancel/exit first - these work from ANY state
    if (isCancelRequest(trimmedMessage)) {
      const result = await cancelUserBooking(userId);
      await cleanupSession(userId, 'user_cancelled');
      return result.message;
    }

    if (isExitRequest(trimmedMessage)) {
      await cleanupSession(userId, 'user_exit');
      return '🏠 Back to main menu.\n💡 Type *book* to start.';
    }

    // 2. Check for active booking - this prevents double bookings
    const activeBooking = await hasActiveBooking(userId);
    if (activeBooking) {
      const vehicleInfo = VEHICLE_TYPES.find(v => v.type === activeBooking.vehicle_type) || {};
      return `🚫 *Active Booking Found!*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 ${activeBooking.id}
${vehicleInfo.icon} ${activeBooking.vehicle_type}
📍 ${truncate(activeBooking.destination)}
🅿️ ${vehicleInfo.slotPrefix}${activeBooking.slot_number}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 Type *cancel* to cancel
📱 Type *status* to view`;
    }

    // 3. Get current mode and session
    const currentMode = await getUserMode(userId);
    const isInBookingMode = currentMode === 'booking';
    let booking = await getUserBooking(userId);

    console.log(`📋 Mode: ${currentMode}, Has booking session: ${!!booking}, Step: ${booking?.step || 'none'}`);

    // 4. Handle booking triggers to start new session
    if (isBookingTrigger(trimmedMessage)) {
      console.log('🎯 Booking trigger detected');
      
      // Clear any existing session and start fresh
      await cleanupSession(userId, 'new_booking_trigger');
      
      const newBooking = {
        step: BOOKING_STATES.START,
        lastInteractionTime: Date.now(),
        retryCount: 0,
        name: null,
        phone: null,
        vehicleType: null,
        destination: null,
        matchedOwner: null
      };

      await setUserBooking(userId, newBooking);
      await setUserMode(userId, 'booking');

      return '👋 Enter your full name (min 2 chars):\nExample: `FFFSTANZA`';
    }

    // 5. If not in booking mode and no booking trigger, reject
    if (!isInBookingMode || !booking) {
      return '💡 Type *book* to start a parking reservation.';
    }

    // 6. Check session timeout
    if (isSessionExpired(booking)) {
      await cleanupSession(userId, 'timeout');
      return '⌛ Session expired. Type *book* to start fresh.';
    }

    // 7. Update last interaction time
    booking.lastInteractionTime = Date.now();
    await setUserBooking(userId, booking);

    // 8. Route to appropriate step handler
    switch (booking.step) {
      case BOOKING_STATES.START:
        return await handleStartState(userId, trimmedMessage, booking);
      
      case BOOKING_STATES.GET_PHONE_VEHICLE:
        return await handlePhoneVehicleState(userId, trimmedMessage, booking);
      
      case BOOKING_STATES.GET_DESTINATION:
        return await handleDestinationState(userId, trimmedMessage, booking);
      
      case BOOKING_STATES.CONFIRM_BOOKING:
        return await handleConfirmationState(userId, trimmedMessage, booking);
      
      case BOOKING_STATES.COMPLETED:
        // Session completed, clean up and ask for new booking
        await cleanupSession(userId, 'completed_state');
        return '✅ Booking completed. Type *book* to make a new reservation.';
      
      default:
        console.error(`Unknown booking step: ${booking.step}`);
        await cleanupSession(userId, 'invalid_step');
        return '❌ Session error. Type *book* to restart.';
    }

  } catch (error) {
    console.error('❌ Booking handler error:', error);
    await cleanupSession(userId, 'system_error');
    return '❌ System error. Type *book* to try again.';
  }
}

// === STATUS FUNCTION ===
async function getUserBookingStatus(userId) {
  const activeBooking = await hasActiveBooking(userId);
  if (!activeBooking) {
    return '📭 *No Active Booking*\nType *book* to make a reservation.';
  }
  
  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === activeBooking.vehicle_type) || {};
  const createdTime = new Date(activeBooking.created_at).toLocaleString('en-IN');
  const expiry = new Date(activeBooking.created_at.getTime() + BOOKING_TIMEOUT);
  const timeLeft = Math.max(0, Math.floor((expiry - Date.now()) / (1000 * 60)));
  const timeStatus = timeLeft > 0 ? `⏰ ${timeLeft} min left` : '🔴 Expired';
  
  return `📱 *Your Booking*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 Booking ID      : ${activeBooking.id}
🚗 Vehicle         : ${vehicleInfo.icon} ${activeBooking.vehicle_type}
📍 Destination     : ${truncate(activeBooking.destination)}
🅿️ Slot Number     : ${vehicleInfo.slotPrefix}${activeBooking.slot_number}
🕒 Booked At       : ${createdTime}
📆 Status          : ${timeStatus}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 Type *cancel* to cancel`;

}

// === CLEANUP JOB ===
setInterval(cleanupExpiredBookings, 300000); // Run every 5 minutes

// === EXPORT ===
module.exports = {
  handleBooking,
  getUserBookingStatus,
  hasActiveBooking,
  cancelUserBooking,
  cleanupExpiredBookings,
  VEHICLE_TYPES,
  BOOKING_STATES,
  truncate,
  normalize,
  matchVehicleType,
  getSlotStatus: async (ownerId, slotIndex) => {
    const [slot] = await db
      .select()
      .from(slots)
      .where(and(eq(slots.owner_id, ownerId), eq(slots.index, slotIndex)));
    return slot;
  }
};