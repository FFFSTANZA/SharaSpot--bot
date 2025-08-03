const TIMEOUT_LIMIT = 300000; // 5 minutes
const {
    getUserBooking,
    setUserBooking,
    getUserMode,
    setUserMode,
    markSlotBooked
} = require('../sessions/sessionManager');
const { resolveTextLocation } = require('../utils/locationResolver');
const { haversine } = require('../utils/haversine');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('../utils/normalizePhone');

let cachedOwners = [];
let lastOwnersUpdate = 0;
const OWNERS_CACHE_TTL = 30000;

const BOOKING_STATES = {
    START: 1,
    GET_PHONE_VEHICLE: 2,
    GET_DESTINATION: 3,
    CONFIRM_BOOKING: 4
};

const VEHICLE_TYPES = [
    {
        type: 'two-wheeler',
        aliases: ['bike', 'scooter', '2 wheeler', 'two wheeler', 'scooty'],
        priority: 1
    },
    {
        type: '4-seat car',
        aliases: ['car', 'sedan', 'hatchback', '4 seater', '4-seater', 'normal car'],
        priority: 2
    },
    {
        type: '8-seat car',
        aliases: ['suv', 'xl', '8 seater', '8-seater', 'big car'],
        priority: 3
    },
    {
        type: 'van',
        aliases: ['van', 'minivan', 'traveller'],
        priority: 4
    }
].sort((a, b) => b.priority - a.priority);

function generateBookingTicket(booking, owner) {
    const ticketId = `TKT-${Date.now().toString().slice(-6)}`;
    return {
        id: ticketId,
        slip: `
🎫 *Parking Ticket Confirmed* 🅿️
━━━━━━━━━━━━━━━━━━━━
🆔 ${ticketId}
👤 ${booking.name}
📞 ${booking.phone}
🚗 ${booking.vehicleType}
📍 ${booking.destination}
🕒 ${new Date().toLocaleString()}
🅿️ Slot ${booking.slotNumber}
👷 ${owner.name || owner.phone}
━━━━━━━━━━━━━━━━━━━━
ℹ️ Present this ticket on arrival`
    };
}

async function getAllOwners() {
    if (Date.now() - lastOwnersUpdate < OWNERS_CACHE_TTL && cachedOwners.length > 0) {
        return cachedOwners;
    }

    try {
        const rawData = await fs.promises.readFile(path.join(__dirname, '../data/owners.json'), 'utf-8');
        cachedOwners = JSON.parse(rawData);
        lastOwnersUpdate = Date.now();
        return cachedOwners;
    } catch (error) {
        console.error('Error reading owners data:', error);
        return [];
    }
}

async function findAvailableOwner(vehicleType, destination) {
    const owners = await getAllOwners();
    let nearestOwner = null;
    let minDistance = Infinity;

    for (const owner of owners) {
        if (owner.status === 'active' && owner.availableVehicleTypes?.includes(vehicleType)) {
            const distance = haversine(destination.lat, destination.lon, owner.lat, owner.lon);
            if (distance <= 1 && distance < minDistance) {
                nearestOwner = owner;
                minDistance = distance;
            }
        }
    }

    return nearestOwner
        ? { owner: nearestOwner, status: 'found', distance: minDistance }
        : { owner: null, status: 'noNearbyOwner' };
}

async function handleBooking(userId, incomingMessage) {
    const startTime = Date.now();
    const message = incomingMessage.trim();

    if (['exit', 'cancel', 'stop'].includes(message.toLowerCase())) {
        cleanupSession(userId);
        return '🚫 Booking cancelled. Type *Book* if you change your mind!';
    }

    let booking = getUserBooking(userId);
    if (!booking || typeof booking !== 'object') {
        booking = { step: BOOKING_STATES.START };
    }

    if (isSessionExpired(booking)) {
        cleanupSession(userId);
        return '⌛ Session expired. Please type *Book* to start again.';
    }

    booking.lastInteractionTime = Date.now();
    setUserBooking(userId, booking);

    try {
        switch (booking.step || BOOKING_STATES.START) {
            case BOOKING_STATES.START:
                return handleStartState(userId, message, booking);
            case BOOKING_STATES.GET_PHONE_VEHICLE:
                return handlePhoneVehicleState(userId, message, booking);
            case BOOKING_STATES.GET_DESTINATION:
                return await handleDestinationState(userId, message, booking);
            case BOOKING_STATES.CONFIRM_BOOKING:
                return await handleConfirmationState(userId, message, booking, startTime);
            default:
                cleanupSession(userId);
                return '❌ Unknown state. Please type *Book* to start again.';
        }
    } catch (err) {
        console.error('Booking flow error:', err);
        cleanupSession(userId);
        return '❌ Something went wrong. Please type *Book* to start again.';
    }
}

function handleStartState(userId, message, booking) {
    const name = message.trim();
    if (!name || name.length < 2) return '👋 Please enter your name (at least 2 characters).';
    if (name.length > 50) return '⚠️ Please enter a shorter name (under 50 characters).';

    booking.name = name;
    booking.step = BOOKING_STATES.GET_PHONE_VEHICLE;
    setUserBooking(userId, booking);

    return `👍 Got your name, *${booking.name}*!\n\nNow, send your:\n📱 *Phone Number*\n🚗 *Vehicle Type*\n\nExample:\n_9876543210, car_`;
}

function handlePhoneVehicleState(userId, message, booking) {
    if (!booking.name) return '⚠️ Session error. Please type *Book* to start again.';

    const [phonePart, ...vehicleParts] = message.split(/[,|;]/).map(p => p.trim());
    const vehiclePart = vehicleParts.join(', ');

    if (!phonePart || !vehiclePart) {
        return '⚠️ Please enter both phone and vehicle type:\nExample: _9876543210, car_';
    }

    const phone = normalizePhone(phonePart);
    if (!isValidPhone(phone)) {
        return '📵 Invalid phone number. Please enter a valid 10-digit Indian mobile number.';
    }

    const vehicleType = matchVehicleType(vehiclePart.toLowerCase());
    if (!vehicleType) {
        return `🚗 Supported vehicle types:\n${VEHICLE_TYPES.map(v => `- ${v.type}`).join('\n')}\n\nPlease enter one of these.`;
    }

    booking.phone = `+91${phone}`;
    booking.vehicleType = vehicleType;
    booking.step = BOOKING_STATES.GET_DESTINATION;
    setUserBooking(userId, booking);

    return `🗺️ Where are you heading?\n• Type an address\n• Or share your live location`;
}

async function handleDestinationState(userId, message, booking) {
    if (!message) return '📍 Please share your destination.';

    try {
        const locationData = await resolveTextLocation(message);
        if (!locationData) {
            return '❌ Couldn’t find that location. Try sharing your live location or be more specific.';
        }

        booking.destination = message;
        booking.destinationLat = locationData.lat;
        booking.destinationLon = locationData.lon;
        booking.step = BOOKING_STATES.CONFIRM_BOOKING;
        setUserBooking(userId, booking);

        return `✅ Got your destination!\n\n📋 *Confirm your booking:*\n\n👤 Name: ${booking.name}\n📞 Phone: ${booking.phone}\n🚗 Vehicle: ${booking.vehicleType}\n📍 Destination: ${truncate(message, 30)}\n\nReply *Confirm* to proceed or *Exit* to cancel.`;
    } catch (err) {
        console.error('Destination error:', err);
        return '❌ Error finding location. Please try again.';
    }
}

async function handleConfirmationState(userId, message, booking, startTime) {
    const confirmText = message.trim().toLowerCase();

    if (confirmText !== 'confirm') {
        return '❓ Please type *Confirm* to proceed or *Exit* to cancel.';
    }

    try {
        const result = await processBooking(userId, booking);
        console.log(`Booking completed in ${Date.now() - startTime}ms`);
        cleanupSession(userId);
        return result;
    } catch (err) {
        console.error('Confirmation error:', err);
        cleanupSession(userId);
        return '❌ Booking failed. Please try again.';
    }
}

async function processBooking(userId, booking) {
    const result = await findAvailableOwner(booking.vehicleType, {
        lat: booking.destinationLat,
        lon: booking.destinationLon
    });

    if (!result.owner) {
        return result.status === 'noNearbyOwner'
            ? `❌ No parking found within 1km of ${truncate(booking.destination, 20)}.\nTry a different location.`
            : '😔 No parking owners available right now. Please try again later.';
    }

    const slotNumber = findAvailableSlot(result.owner.phone);
    if (!slotNumber) {
        return `🅿️ ${result.owner.name || 'This location'} has no available slots. Try later.`;
    }

    booking.slotNumber = slotNumber;
    booking.confirmed = true;
    booking.assignedOwner = result.owner.phone;

    const ticket = generateBookingTicket(booking, result.owner);
    await sendConfirmationMessages(userId, result.owner.phone, ticket);
    await markSlotBooked(result.owner.phone, slotNumber);

    return `✅ Booking Confirmed!\n\n${ticket.slip}`;
}

async function sendConfirmationMessages(userId, ownerPhone, ticket) {
    try {
        await Promise.all([
            sendWhatsAppMessage(userId, ticket.slip),
            sendWhatsAppMessage(ownerPhone, `📥 New Booking Received!\n${ticket.slip}`)
        ]);
    } catch (err) {
        console.error('Error sending messages:', err);
    }
}

function isValidPhone(phone) {
    return /^[6-9]\d{9}$/.test(phone);
}

function matchVehicleType(input) {
    for (const vehicle of VEHICLE_TYPES) {
        if (vehicle.aliases.includes(input)) {
            return vehicle.type;
        }
    }
    for (const vehicle of VEHICLE_TYPES) {
        if (vehicle.aliases.some(alias => input.includes(alias))) {
            return vehicle.type;
        }
    }
    return null;
}

function isSessionExpired(booking) {
    return booking.lastInteractionTime && Date.now() - booking.lastInteractionTime > TIMEOUT_LIMIT;
}

function cleanupSession(userId) {
    setUserBooking(userId, null);
    setUserMode(userId, 'AI');
}

function truncate(str, length) {
    return str.length > length ? str.slice(0, length) + '...' : str;
}

module.exports = {
    handleBooking,
    findAvailableOwner,
    hasActiveBooking: (userId) => {
        const booking = getUserBooking(userId);
        return booking?.confirmed;
    },
    getUserBookingStatus: (userId) => {
        const booking = getUserBooking(userId);
        if (!booking) return '📭 No active booking.\nType *Book* to start a new one.';

        return `📱 *Your Booking:*\n` +
            `Status: ${booking.confirmed ? '✅ Confirmed' : '🔄 In Progress'}\n` +
            `${booking.destination ? `📍 ${truncate(booking.destination, 30)}\n` : ''}` +
            `${booking.slotNumber ? `🅿️ Slot ${booking.slotNumber}\n` : ''}`;
    },
    refreshOwnersCache: () => {
        lastOwnersUpdate = 0;
    }
};
