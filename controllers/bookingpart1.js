// Enhanced Parking Booking System (Neon HTTP Compatible) - FIXED & OPTIMIZED
const TIMEOUT_LIMIT = 300000; // 5 minutes
const RESERVATION_EXPIRY_MS = 60000; // 1 minute reservation window
const {
  getUserBooking,
  setUserBooking,
  getUserMode,
  setUserMode
} = require('../sessions/sessionManager');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { normalizePhone } = require('../utils/normalizePhone');
const { getOwnerByPhone } = require('../lib/ownerDb');
const { db } = require('../database/db');
const { owners, ownerVehicleTypes, slots, bookings } = require('../database/schema');
const { eq, and, or, isNull, lt, gte } = require('drizzle-orm');
const Fuse = require('fuse.js');
const { v4: uuidv4 } = require('uuid');

// Constants
const OWNERS_CACHE_TTL = 30000;
const MAX_SLOT_CHECK_ATTEMPTS = 5;
const BOOKING_RETRY_DELAY = 1000;
const MAX_BOOKING_RETRIES = 5;
const SLOT_LOCK_TIMEOUT = 15000;
const BOOKING_STATES = {
  START: 1,
  GET_PHONE_VEHICLE: 2,
  GET_DESTINATION: 3,
  CONFIRM_BOOKING: 4
};

const VEHICLE_TYPES = [
  { 
    type: 'Two-wheeler', 
    aliases: ['bike', 'scooter', '2 wheeler', 'two wheeler', 'scooty'], 
    priority: 1,
    icon: '🛵',
    slotPrefix: 'M'
  },
  { 
    type: '4-seat car', 
    aliases: ['car', 'sedan', 'hatchback', '4 seater', '4-seater', 'normal car'], 
    priority: 2,
    icon: '🚗',
    slotPrefix: 'C'
  },
  { 
    type: '8-seat car', 
    aliases: ['suv', 'xl', '8 seater', '8-seater', 'big car'], 
    priority: 3,
    icon: '🚙',
    slotPrefix: 'L'
  },
  { 
    type: 'Van', 
    aliases: ['van', 'minivan', 'traveller'], 
    priority: 4,
    icon: '🚐',
    slotPrefix: 'V'
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
  return VEHICLE_TYPES.find(vehicle => 
    vehicle.aliases.some(alias => lowerInput.includes(alias))
  )?.type || null;
}

function generateBookingTicket(booking, owner) {
  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === booking.vehicleType) || {};
  const slotDisplay = booking.slotNumber ? `${vehicleInfo.slotPrefix || ''}${booking.slotNumber}` : 'Not assigned';
  return {
    id: booking.bookingId,
    slip: `
🎫 *Parking Ticket Confirmed* 🅿️
━━━━━━━━━━━━━━━━━━━━
🆔 ${booking.bookingId}
👤 ${booking.name}
📞 ${booking.phone}
${vehicleInfo.icon || '🚗'} ${booking.vehicleType}
📍 ${booking.destination}
🕒 ${new Date().toLocaleString()}
🅿️ Slot ${slotDisplay}
👷 ${owner.name || owner.phone_num}
━━━━━━━━━━━━━━━━━━━━
ℹ️ Present this ticket on arrival`
  };
}

// ✅ Ensure slot exists and create if missing (optional safety)
async function ensureSlotExists(ownerId, vehicleType, index) {
  const slotId = `${ownerId}-${index}`;
  const [existing] = await db.select().from(slots).where(eq(slots.id, slotId));
  if (existing) return existing;

  // Create slot if not exists
  await db.insert(slots).values({
    id: slotId,
    owner_id: ownerId,
    index: index,
    type: vehicleType,
    state: 'available',
    is_occupied: false,
    created_at: new Date(),
    last_updated: new Date()
  });
  console.log(`✅ Created missing slot: ${slotId}`);
  return { id: slotId, index };
}

// Core Booking Functions
async function findAvailableOwner(vehicleType, destinationText) {
  try {
    const dbOwners = await db.select().from(owners).where(eq(owners.is_active, true));
    const owner = fuzzyMatchOwnerLocation(destinationText, dbOwners);
    if (!owner || !owner.is_active || typeof owner.lat !== 'number' || typeof owner.lon !== 'number') {
      return { owner: null, status: 'noNearbyOwner' };
    }

    const types = await db.select()
      .from(ownerVehicleTypes)
      .where(eq(ownerVehicleTypes.owner_id, owner.id));

    const vehicleTypes = types.map(t => t.vehicle_type.toLowerCase());
    if (vehicleTypes.length > 0 && !vehicleTypes.includes(vehicleType.toLowerCase())) {
      return { owner: null, status: 'vehicleTypeNotSupported' };
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

// ✅ Fixed: Returns full slot object (with .id), not just index
async function findAndLockSlot(ownerId, vehicleType) {
  const lockKey = `${ownerId}-${vehicleType}`;
  if (bookingLocks.has(lockKey)) {
    throw new Error('Slot selection in progress');
  }
  bookingLocks.set(lockKey, true);

  try {
    // Find available slot
    const availableSlot = await db.select()
      .from(slots)
      .where(
        and(
          eq(slots.owner_id, ownerId),
          eq(slots.type, vehicleType),
          eq(slots.state, 'available')
        )
      )
      .limit(1);

    if (availableSlot.length > 0) {
      const slot = availableSlot[0];
      // Update to occupied
      await db.update(slots)
        .set({ 
          state: 'occupied',
          is_occupied: true,
          last_updated: new Date()
        })
        .where(eq(slots.id, slot.id));
      return slot; // Return full slot object
    }

    // Check for expired reservations
    const expiredReservation = await db.select()
      .from(slots)
      .where(
        and(
          eq(slots.owner_id, ownerId),
          eq(slots.type, vehicleType),
          eq(slots.state, 'occupied'),
          lt(slots.last_updated, new Date(Date.now() - RESERVATION_EXPIRY_MS))
        )
      )
      .limit(1);

    if (expiredReservation.length > 0) {
      const slot = expiredReservation[0];
      await db.update(slots)
        .set({ 
          state: 'occupied',
          is_occupied: true,
          last_updated: new Date()
        })
        .where(eq(slots.id, slot.id));
      return slot;
    }

    return null;
  } finally {
    bookingLocks.delete(lockKey);
  }
}

// ✅ Fixed: Use actual slot.id from DB
async function createBookingRecord(userId, ownerId, slot, bookingDetails) {
  const bookingId = `TKT-${uuidv4().slice(0, 8).toUpperCase()}`;
  
  await db.insert(bookings).values({
    id: bookingId,
    user_id: userId,
    owner_id: ownerId,
    slot_id: slot.id, // ✅ Use real slot.id
    slot_number: slot.index,
    vehicle_type: bookingDetails.vehicleType,
    destination: bookingDetails.destination,
    destination_lat: bookingDetails.destinationLat,
    destination_lon: bookingDetails.destinationLon,
    status: 'confirmed',
    created_at: new Date(),
    expires_at: new Date(Date.now() + 3600000) // 1 hour
  });

  return bookingId;
}

async function sendNotifications(userId, ownerPhone, ticketSlip) {
  await Promise.all([
    sendWhatsAppMessage(userId, ticketSlip),
    sendWhatsAppMessage(ownerPhone, `📥 New Booking Received!
${ticketSlip}`)
  ]).catch(err => console.error('Notification failed:', err));
}

// ✅ Fixed: Use full slot object
async function processBooking(userId, booking) {
  if (!booking?.matchedOwner?.phone_num) {
    throw new Error('No valid owner information in booking');
  }

  const owner = await getOwnerByPhone(booking.matchedOwner.phone_num);
  if (!owner || !owner.is_active) {
    throw new Error(`Parking at ${truncate(booking.destination)} is no longer available`);
  }

  let slot = null;
  let attempts = 0;

  while (attempts < MAX_BOOKING_RETRIES) {
    try {
      slot = await findAndLockSlot(owner.id, booking.vehicleType);
      if (slot) break;
      attempts++;
      if (attempts < MAX_BOOKING_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, BOOKING_RETRY_DELAY));
      }
    } catch (err) {
      console.error(`Slot assignment attempt ${attempts + 1} failed:`, err);
      attempts++;
      if (attempts >= MAX_BOOKING_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, BOOKING_RETRY_DELAY));
    }
  }

  if (!slot) {
    throw new Error(`${owner.name || 'This location'} has no available ${booking.vehicleType} slots`);
  }

  // ✅ Assign both index and id
  booking.slotNumber = slot.index;
  booking.slotId = slot.id;

  booking.bookingId = await createBookingRecord(userId, owner.id, slot, booking);
  const ticket = generateBookingTicket(booking, owner);

  sendNotifications(userId, owner.phone_num, ticket.slip);

  return {
    ...booking,
    confirmed: true,
    assignedOwner: owner.phone_num,
    ticket,
    bookingTime: new Date().toISOString()
  };
}

// State Handlers
async function handleStartState(userId, message, booking) {
  const name = message.trim();
  if (!name || name.length < 2) {
    return '👋 Please enter your name (at least 2 characters).';
  }
  booking.name = name;
  booking.step = BOOKING_STATES.GET_PHONE_VEHICLE;
  setUserBooking(userId, booking);

  const vehicleOptions = VEHICLE_TYPES.map(v => `${v.icon} ${v.type}`).join('\n');
  return `👍 Got your name, *${name}*!\nPlease send:\n📱 Your phone number\n🚗 Your vehicle type\nAvailable vehicle types:\n${vehicleOptions}\n\nExample: \`9876543210, car\``;
}

async function handlePhoneVehicleState(userId, message, booking) {
  const [phonePart, ...vehicleParts] = message.split(/[|,;]/).map(p => p.trim());
  const vehiclePart = vehicleParts.join(' ');
  const phone = normalizePhone(phonePart);

  if (!isValidPhone(phone)) {
    return '⚠️ Please enter a valid 10-digit Indian phone number.\n\nExample: `9876543210, car`';
  }

  const vehicleType = matchVehicleType(vehiclePart);
  if (!vehicleType) {
    const validTypes = VEHICLE_TYPES.map(v => `${v.icon} - ${v.type}`).join('\n');
    return `🚗 Please specify a valid vehicle type:\n${validTypes}\n\nExample: \`9876543210, car\``;
  }

  booking.phone = `+91${phone}`;
  booking.vehicleType = vehicleType;
  booking.step = BOOKING_STATES.GET_DESTINATION;
  setUserBooking(userId, booking);

  return '📍 Please send your destination (address or live location)\n\nExamples:\n- Rajapalayam bus stand\n- Near Gandhi statue\n- *Send your current location*';
}

async function handleDestinationState(userId, message, booking) {
  if (typeof message === 'object' && message.lat && message.lon) {
    booking.destination = "Your current location";
    booking.destinationLat = message.lat;
    booking.destinationLon = message.lon;
  } else {
    const destinationText = message.trim();
    if (!destinationText || destinationText.length < 3) {
      return '📍 Please enter a valid destination (at least 3 characters) or send your location';
    }

    const result = await findAvailableOwner(booking.vehicleType, destinationText);
    if (!result.owner) {
      const nearbyOwners = await db.select()
        .from(owners)
        .leftJoin(ownerVehicleTypes, eq(owners.id, ownerVehicleTypes.owner_id))
        .where(
          and(
            eq(owners.is_active, true),
            or(
              eq(ownerVehicleTypes.vehicle_type, booking.vehicleType),
              isNull(ownerVehicleTypes.vehicle_type)
            )
          )
        )
        .limit(3);

      let suggestion = '';
      if (nearbyOwners.length > 0) {
        suggestion = `\n\nNearby parking locations:\n${nearbyOwners.map(o => `- ${o.owners?.location}`).join('\n')}`;
      }

      return `❌ Couldn't find parking near "${destinationText}".${suggestion}\n\nTry:\n- A nearby landmark\n- More specific location\n- Or send your current location`;
    }

    booking.matchedOwner = result.owner;
    booking.destination = result.owner.location || destinationText;
    booking.destinationLat = result.owner.lat;
    booking.destinationLon = result.owner.lon;
  }

  booking.step = BOOKING_STATES.CONFIRM_BOOKING;
  await setUserBooking(userId, booking);

  const vehicleInfo = VEHICLE_TYPES.find(v => v.type === booking.vehicleType) || {};
  return `📍 You selected: *${booking.destination}*\n🅿️ Parking: ${booking.matchedOwner?.name || 'Local parking'}\n${vehicleInfo.icon || '🚗'} Vehicle: ${booking.vehicleType}\n\nType *Confirm* to book or *Cancel* to abort`;
}

async function handleConfirmationState(userId, message, booking, startTime) {
  const normalizedMessage = message.trim().toLowerCase();
  if (normalizedMessage !== 'confirm') {
    return '❓ Please type *Confirm* to book or *Cancel* to abort';
  }

  try {
    const result = await processBooking(userId, booking);
    console.log(`✅ Booking completed in ${Date.now() - startTime}ms`);
    cleanupSession(userId);
    return `✅ Booking Confirmed!\n${result.ticket.slip}\n\nThank you for using our service!`;
  } catch (error) {
    console.error('Booking confirmation failed:', error);
    cleanupSession(userId);

    if (error.message.includes('currently being booked')) {
      return `⏳ Someone is booking this slot right now. Please try again in a few seconds.`;
    }
    if (error.message.includes('was booked by someone else')) {
      return `😞 That slot was just taken. Would you like to try another slot?`;
    }
    if (error.message.includes('no available')) {
      return `🚗 No ${booking.vehicleType} slots available at ${booking.destination}.\n\nPlease try:\n- A different location\n- Another vehicle type\n- Or try again later`;
    }
    return `❌ ${error.message || 'Booking failed. Please try again.'}`;
  }
}

// Main Booking Handler
async function handleBooking(userId, incomingMessage) {
  const startTime = Date.now();
  const message = incomingMessage?.trim() || '';

  try {
    if (["exit", "cancel", "stop", "abort"].some(cmd => message.toLowerCase().startsWith(cmd))) {
      cleanupSession(userId);
      return "🚫 Booking cancelled. You can start again by typing *Book*.";
    }

    let booking = await getUserBooking(userId);
    if (!booking || typeof booking !== "object") {
      booking = { step: BOOKING_STATES.START, lastInteractionTime: Date.now() };
    }

    if (isSessionExpired(booking)) {
      cleanupSession(userId);
      return "⌛ Your booking session expired. Please type *Book* to start again.";
    }

    booking.lastInteractionTime = Date.now();
    await setUserBooking(userId, booking);

    switch (booking.step) {
      case BOOKING_STATES.START:
        return await handleStartState(userId, message, booking);
      case BOOKING_STATES.GET_PHONE_VEHICLE:
        return await handlePhoneVehicleState(userId, message, booking);
      case BOOKING_STATES.GET_DESTINATION:
        return await handleDestinationState(userId, message, booking);
      case BOOKING_STATES.CONFIRM_BOOKING:
        return await handleConfirmationState(userId, message, booking, startTime);
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

// Maintenance: Cleanup expired reservations
async function cleanupExpiredBookings() {
  const result = await db.update(slots)
    .set({ 
      state: 'available',
      is_occupied: false,
      last_updated: new Date()
    })
    .where(
      and(
        eq(slots.state, 'occupied'),
        lt(slots.last_updated, new Date(Date.now() - RESERVATION_EXPIRY_MS))
      )
    );
  console.log(`🧹 Cleaned up ${result.rowCount} expired slot reservations`);
  return result.rowCount;
}

setInterval(cleanupExpiredBookings, 300000); // Every 5 minutes

module.exports = {
  handleBooking,
  findAvailableOwner,
  handleConfirmationState,
  handleStartState,
  handlePhoneVehicleState,
  handleDestinationState,
  getUserBookingStatus: async (userId) => {
    const booking = await getUserBooking(userId);
    if (!booking) return '📭 No active booking found.';
    let status = `📱 *Booking Status*: ${booking.confirmed ? '✅ Confirmed' : '🔄 In Progress'}`;
    if (booking.destination) status += `\n📍 ${truncate(booking.destination)}`;
    if (booking.slotNumber !== undefined) {
      const vehicleInfo = VEHICLE_TYPES.find(v => v.type === booking.vehicleType) || {};
      status += `\n🅿️ Slot ${vehicleInfo.slotPrefix || ''}${booking.slotNumber}`;
    }
    return status;
  },
  hasActiveBooking: async (userId) => {
    const booking = await getUserBooking(userId);
    return !!booking?.confirmed;
  },
  VEHICLE_TYPES,
  getSlotStatus: async (ownerId, slotIndex) => {
    const [slot] = await db.select()
      .from(slots)
      .where(and(eq(slots.owner_id, ownerId), eq(slots.index, slotIndex)));
    return slot;
  },
  cleanupExpiredBookings
};