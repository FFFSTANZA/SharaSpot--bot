const TIMEOUT_LIMIT = 300000; // 5 minutes timeout
const {
    getUserBooking,
    setUserBooking,
    getUserMode,
    setUserMode,
    findAvailableSlot,
    markSlotBooked
} = require('../sessions/sessionManager');
const { resolveTextLocation } = require('../utils/locationResolver');
const { haversine } = require('../utils/haversine');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('../utils/normalizePhone');

// Cached owners data for faster access
let cachedOwners = [];
let lastOwnersUpdate = 0;
const OWNERS_CACHE_TTL = 30000; // 30 seconds cache

// Booking flow states
const BOOKING_STATES = {
    START: 1,
    GET_PHONE_VEHICLE: 2,
    GET_DESTINATION: 3,
    CONFIRM_BOOKING: 4
};


const VEHICLE_TYPES = [
    {
        type: 'two-wheeler',
        aliases: ['bike', 'scooter', '2 wheeler', 'two wheeler', 'bike', 'scooty'],
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
].sort((a, b) => b.priority - a.priority); // Sort by priority for better matching

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
    // Use cached data if available and fresh
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

    // Use for-of loop for better async handling if needed
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
    let booking = getUserBooking(userId) || {};
    const message = incomingMessage.trim();
    
    // Session timeout check
    if (isSessionExpired(booking)) {
        cleanupSession(userId);
        return '⌛ Session expired. Please type *Book* to start fresh.';
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
                const result = await handleConfirmationState(userId, booking);
                console.log(`Booking completed in ${Date.now() - startTime}ms`);
                return result;
                
            default:
                cleanupSession(userId);
                return '❌ Oops! Something went wrong. Type *Book* to restart.';
        }
    } catch (error) {
        console.error('Booking error:', error);
        cleanupSession(userId);
        return '❌ We hit a snag. Please type *Book* to try again.';
    }
}

// State handlers with improved validation
function handleStartState(userId, message, booking) {
    if (!message.trim()) return '👋 Welcome to SharaSpot! What\'s your name?';
    
    if (message.length > 50) {
        return 'Please enter a shorter name (under 50 characters)';
    }

    booking.name = message.trim();
    booking.step = BOOKING_STATES.GET_PHONE_VEHICLE;
    setUserBooking(userId, booking);
    return `👍 Got your name, ${booking.name}!

    Now, please share your:
    📱 *Phone Number*  
    🚗 *Vehicle Type(s)*
    For example:  
    _9876543210, car, van, scooty_`;

}

function handlePhoneVehicleState(userId, message, booking) {
    const [phonePart, ...vehicleParts] = message.split(',').map(p => p.trim());
    const vehiclePart = vehicleParts.join(','); // Handle commas in vehicle type
    
    if (!phonePart || !vehiclePart) {
        return '⚠️ Please include both:\n- Your phone number\n- Vehicle type\nExample: _9876543210, car_';
    }
    
    const phone = normalizePhone(phonePart);
    if (!isValidPhone(phone)) {
        return '📱 Please enter a valid 10-digit Indian phone number';
    }
    
    const vehicleType = matchVehicleType(vehiclePart.toLowerCase());
    if (!vehicleType) {
        return `🚗 We support these vehicle types:\n${VEHICLE_TYPES.map(v => `- ${v.type}`).join('\n')}\n\nPlease choose one`;
    }
    
    booking.phone = `+91${phone}`; // Store with country code
    booking.vehicleType = vehicleType;
    booking.step = BOOKING_STATES.GET_DESTINATION;
    setUserBooking(userId, booking);
    
    return `📍 Where are you heading? Please:\n• Type an address\n• Or share your location`;
}

async function handleDestinationState(userId, message, booking) {
    if (!message) return '📍 Please share your destination location';
    
    try {
        const locationData = await resolveTextLocation(message);
        if (!locationData) {
            return '❌ Couldn\'t find that location. Try being more specific or share your GPS location.';
        }
        
        booking.destination = message;
        booking.destinationLat = locationData.lat;
        booking.destinationLon = locationData.lon;
        booking.step = BOOKING_STATES.CONFIRM_BOOKING;
        setUserBooking(userId, booking);
        
        return `🔍 Finding parking near ${truncate(message, 30)}...`;
    } catch (error) {
        console.error('Location error:', error);
        return '❌ Error processing location. Please try again.';
    }
}

async function handleConfirmationState(userId, booking) {
    try {
        const result = await processBooking(userId, booking);
        cleanupSession(userId);
        return result;
    } catch (error) {
        console.error('Confirmation error:', error);
        cleanupSession(userId);
        return '❌ Failed to complete booking. Please try again.';
    }
}

// Core booking processor
async function processBooking(userId, booking) {
    const searchStart = Date.now();
    const result = await findAvailableOwner(booking.vehicleType, {
        lat: booking.destinationLat,
        lon: booking.destinationLon
    });

    console.log(`Owner search took ${Date.now() - searchStart}ms`);

    if (!result.owner) {
        return result.status === 'noNearbyOwner'
            ? `No parking within 1km of ${truncate(booking.destination, 20)}.\nTry another location.`
            : '😔 No parking owners available currently. Try again later.';
    }

    const slotNumber = findAvailableSlot(result.owner.phone);
    if (!slotNumber) {
        return `🅿️ ${result.owner.name || 'This location'} has no available slots. Try again later.`;
    }

    // Finalize booking
    booking.slotNumber = slotNumber;
    booking.confirmed = true;
    booking.assignedOwner = result.owner.phone;
    
    const ticket = generateBookingTicket(booking, result.owner);
    await sendConfirmationMessages(userId, result.owner.phone, ticket);
    
    markSlotBooked(result.owner.phone, slotNumber);
    
    return `✅ occupied! Slot ${slotNumber} at ${result.owner.name || 'your location'}.\n${ticket.slip}`;
}

// Helper functions
async function sendConfirmationMessages(userId, ownerPhone, ticket) {
    try {
        await Promise.all([
            sendWhatsAppMessage(userId, `🅿️ ${ticket.slip}`),
            sendWhatsAppMessage(
                ownerPhone,
                `📥 New Booking!\n${ticket.slip}\n\nUser will arrive soon.`
            )
        ]);
    } catch (error) {
        console.error('Message send error:', error);
        // Don't fail the booking if messages fail
    }
}



function isValidPhone(phone) {
    return /^[6-9]\d{9}$/.test(phone); // Valid Indian mobile number
}

function matchVehicleType(input) {
    // Check for exact matches first
    for (const vehicle of VEHICLE_TYPES) {
        if (vehicle.aliases.some(a => a === input.toLowerCase())) {
            return vehicle.type;
        }
    }
    
    // Then check partial matches
    for (const vehicle of VEHICLE_TYPES) {
        if (vehicle.aliases.some(a => input.toLowerCase().includes(a))) {
            return vehicle.type;
        }
    }
    
    return null;
}

function isSessionExpired(booking) {
    return booking.lastInteractionTime && 
           Date.now() - booking.lastInteractionTime > TIMEOUT_LIMIT;
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
        if (!booking) return 'No active booking. Type *Book* to start.';
        
        return `📱 Your Booking:\n` +
               `Status: ${booking.confirmed ? '✅ Confirmed' : '🔄 In Progress'}\n` +
               `${booking.destination ? `📍 ${truncate(booking.destination, 30)}\n` : ''}` +
               `${booking.slotNumber ? `🅿️ Slot ${booking.slotNumber}\n` : ''}`;
    },
    refreshOwnersCache: () => {
        lastOwnersUpdate = 0;
    }
};