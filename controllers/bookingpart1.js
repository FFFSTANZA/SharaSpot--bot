// bookingPart1.js

const TIMEOUT_LIMIT = 50000;
const {
    getUserBooking,
    setUserBooking,
    getUserMode,
    setUserMode,
    setOwnerStatus,
    updateOwnerLocation,
    getOwnerData,
    getAllOwners,
    addOwner,
    removeOwner,
    getActiveBookings
} = require('../sessions/sessionManager');
const { resolveTextLocation } = require('../utils/locationResolver');
const { haversine } = require('../utils/haversine');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const fs = require('fs');
const path = require('path');

const advancedBookings = {};
const reminderSchedules = {};


function generateBookingTicket(booking, owner) {
  const ticketId = `TKT-${Date.now().toString().slice(-6)}`;
  return {
    id: ticketId,
    slip: `
🎫 *Parking Ticket Confirmed*
----------------------------
🆔 Ticket ID: ${ticketId}
👤 Name: ${booking.name}
📞 Phone: ${booking.phone}
🚗 Vehicle: ${booking.vehicleType}
📍 Destination: ${booking.destination}
🕒 Booking Time: ${new Date().toLocaleString()}
${booking.scheduledTime ? `📅 Scheduled: ${booking.scheduledTime}` : ''}
👷 Assigned Owner: ${owner.name || owner.phone}
----------------------------
ℹ️ Present this ticket on arrival`
  };
}

function readOwnerData() {
    const filePath = path.join(__dirname, '../data/owners.json');
    try {
        const rawData = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(rawData); 
    } catch (error) {
        console.error("Error reading owner data:", error);
        return []; 
    }
}

function findAvailableOwner(vehicleType, destination) {
    const owners = readOwnerData();
    const destinationLat = destination.lat;
    const destinationLon = destination.lon;
    const maxDistance = 1; // 1 km radius

    let nearestOwner = null;
    let minDistance = Infinity;
    let activeOwnersExist = false;

    for (let owner of owners) {
        if (owner.status === 'active') {
            activeOwnersExist = true;
            const distance = haversine(destinationLat, destinationLon, owner.lat, owner.lon);
            if (distance <= maxDistance && distance < minDistance) {
                nearestOwner = owner;
                minDistance = distance;
            }
        }
    }
    if (nearestOwner) {
        return { owner: nearestOwner, status: 'found' };
    } else if (activeOwnersExist) {
        return { owner: null, status: 'noNearbyOwner' }; 
    } else {
        return { owner: null, status: 'noActiveOwners' }; 
    }
}

// Check if user has a pending booking
function hasActiveBooking(userId) {
    const booking = getUserBooking(userId);
    return booking !== null && booking.confirmed;
}

// Schedule a reminder for an advanced booking
function scheduleReminderForBooking(userId, booking) {
    const scheduledDate = new Date(booking.scheduledTime);
    const reminderTime = new Date(scheduledDate.getTime() - (15 * 60 * 1000)); // 15 minutes before
    const now = new Date();
    
    // Calculate time until reminder (in milliseconds)
    const timeUntilReminder = reminderTime.getTime() - now.getTime();
    
    // Only schedule if the reminder time is in the future
    if (timeUntilReminder > 0) {
        console.log(`Scheduling reminder for ${userId} at ${reminderTime.toLocaleString()} (in ${timeUntilReminder/60000} minutes)`);
        
        // Clear any existing timer for this user
        if (reminderSchedules[userId]) {
            clearTimeout(reminderSchedules[userId]);
        }
        
        // Set the new timer
        reminderSchedules[userId] = setTimeout(async () => {
            // Make sure booking is still valid before sending reminder
            const currentBooking = getUserBooking(userId);
            if (currentBooking && currentBooking.scheduledTime) {
                const reminderMessage = `🔔 *Reminder:* Your parking reservation is coming up in ~15 minutes!\n\n📌 Destination: ${booking.destination}\n🚗 Vehicle: ${booking.vehicleType}\n⏰ Scheduled for: ${booking.scheduledTime}`;
                
                await sendWhatsAppMessage(userId, `🅿️ Parking Mode: ${reminderMessage}`);
                console.log(`Reminder sent to ${userId} for booking at ${booking.scheduledTime}`);
                
                // Process the booking automatically after sending reminder
                const result = findAvailableOwner(currentBooking.vehicleType, {
                    lat: currentBooking.destinationLat,
                    lon: currentBooking.destinationLon
                });
                
                if (result.owner) {
                    const { id, slip } = generateBookingTicket(currentBooking, result.owner);
                    currentBooking.confirmed = true;
                    currentBooking.ticketId = id;
                    setUserBooking(userId, currentBooking);
                    
                    await sendWhatsAppMessage(userId, `🅿️ ${slip}`);
                    await sendWhatsAppMessage(
                        result.owner.phone,
                        `📥 *New Booking Received!*\n${slip}\n\nReply '2' to confirm.`
                    );
                }
                
                // Remove from schedule after sending
                delete reminderSchedules[userId];
            }
        }, timeUntilReminder);
    }
}

// Function to get user booking status with enhanced formatting
async function getUserBookingStatus(userId) {
    const booking = getUserBooking(userId);
    
    if (!booking) {
        return "You don't have any active bookings at the moment. Type 'Book' to make a reservation.";
    }
    
    // Create a formatted status message
    let statusMessage = `📱 *Your Booking Status*\n`;
    
    if (booking.confirmed) {
        statusMessage += `✅ Status: Confirmed\n`;
    } else if (booking.scheduledTime) {
        statusMessage += `⏳ Status: Scheduled\n`;
        // Add countdown if scheduled
        const scheduledTime = new Date(booking.scheduledTime).getTime();
        const now = Date.now();
        const timeLeft = scheduledTime - now;
        
        if (timeLeft > 0) {
            const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
            const minsLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            statusMessage += `⏱️ Coming up in: ${hoursLeft}h ${minsLeft}m\n`;
        }
    } else {
        statusMessage += `🔄 Status: In Progress\n`;
    }
    
    // Add booking details
    if (booking.name) statusMessage += `👤 Name: ${booking.name}\n`;
    if (booking.phone) statusMessage += `📞 Phone: ${booking.phone}\n`;
    if (booking.vehicleType) statusMessage += `🚗 Vehicle: ${booking.vehicleType}\n`;
    if (booking.destination) statusMessage += `📍 Destination: ${booking.destination}\n`;
    if (booking.scheduledTime) statusMessage += `⏰ Scheduled for: ${booking.scheduledTime}\n`;
    if (booking.ticketId) statusMessage += `🎫 Ticket ID: ${booking.ticketId}\n`;
    
    // Add step information for in-progress bookings
    if (!booking.confirmed && !booking.scheduledTime && booking.step) {
        statusMessage += `\n⏳ Booking in progress (step ${booking.step}/4)\n`;
        statusMessage += `Type 'Book' to continue where you left off.`;
    }
    
    return statusMessage;
}

async function handleBooking(userId, incomingMessage) {
    let booking = getUserBooking(userId) || {};
    const message = incomingMessage.trim();
    const currentTime = Date.now();

    // Check for duplicate booking
    if (hasActiveBooking(userId) && (!booking.step || booking.step === 1)) {
        return '⚠️ You already have an active booking. Please use "status" to check your current booking or complete it first.';
    }

    // Handle session timeout
    if (booking.lastInteractionTime && currentTime - booking.lastInteractionTime > TIMEOUT_LIMIT) {
        setUserBooking(userId, null);
        setUserMode(userId, 'AI');
        return '⏳ Your session has timed out due to inactivity. Please start the booking process again by typing Book.';
    }

    booking.lastInteractionTime = currentTime;
    setUserBooking(userId, booking);
    if (!booking.step) booking.step = 1;

    switch (booking.step) {
        case 1:
            if (!message) {
                return 'Please enter your name to begin the booking.';
            }
            booking.name = message;
            booking.step = 2;
            setUserBooking(userId, booking);
            return `Got it! Now please share your phone number and vehicle type in the following format:\n\nPhone, Vehicle Type\n\nExample:\n1234567890, 4-seat car\n\nAvailable vehicle types:\n- Two-wheeler\n- 4-seat car\n- 8-seat car\n- Van`;

        case 2:
            const parts = message.split(',');
            if (parts.length !== 2) {
                return 'Please use the correct format: Phone, Vehicle Type\nExample: 1234567890, 4-seat car';
            }

            let phone = parts[0].trim();
            let vehicleTypeRaw = parts[1].trim().toLowerCase();

            if (!phone.startsWith('+')) {
                if (/^\d{10}$/.test(phone)) {
                    phone = '+91' + phone;
                } else if (/^\d{11,15}$/.test(phone)) {
                    phone = '+' + phone;
                } else {
                    return 'That phone number looks invalid. Please provide a valid number (e.g., 1234567890 or +911234567890).';
                }
            }

            const vehicleTypeMap = {
                'two wheeler': 'Two-wheeler',
                '2 wheeler': 'Two-wheeler',
                '4 seat car': '4-seat car',
                '4-seater': '4-seat car',
                '4-seats': '4-seat car',
                '4 seater': '4-seat car',
                '4-seat car': '4-seat car',
                '8 seat car': '8-seat car',
                '8-seater': '8-seat car',
                '8 seats': '8-seat car',
                'van': 'Van',
                '4 seat': '4-seat car'
            };

            let vehicleTypeStandard = null;
            for (const key in vehicleTypeMap) {
                if (vehicleTypeRaw.includes(key)) {
                    vehicleTypeStandard = vehicleTypeMap[key];
                    break;
                }
            }

            if (!vehicleTypeStandard) {
                return `Please specify a valid vehicle type.\nAvailable types:\n- Two-wheeler\n- 4-seat car\n- 8-seat car\n- Van`;
            }

            booking.phone = phone;
            booking.vehicleType = vehicleTypeStandard;
            booking.step = 3;
            setUserBooking(userId, booking);
            return 'Great! Now send your destination location (just type the location name or share location via WhatsApp).';

        case 3:
            if (!message) {
                return 'Please provide your destination location.';
            }
            const locationData = await resolveTextLocation(message);  
            if (!locationData) {
                return `Sorry, we couldn't find a location for "${message}". Please try a more specific address.`;
            }
            booking.destination = message;  
            booking.destinationLat = locationData.lat;
            booking.destinationLon = locationData.lon;
            
            // Add option for advanced booking
            booking.step = 3.5;
            setUserBooking(userId, booking);
            return `Would you like to book for now or schedule for later?\n\n1. Book Now\n2. Schedule for Later`;
            
        case 3.5:
            if (message === "1" || message.toLowerCase().includes("now")) {
                booking.step = 4;
                setUserBooking(userId, booking);
                return `🅿️ Parking Mode: Thanks, ${booking.name}! We are finding the nearest parking spot for your ${booking.vehicleType}. Your destination coordinates are Lat: ${booking.destinationLat}, Lon: ${booking.destinationLon}. Please wait...`;
            } else if (message === "2" || message.toLowerCase().includes("later") || message.toLowerCase().includes("schedule")) {
                booking.step = 3.75;
                setUserBooking(userId, booking);
                return `Please enter the date and time for your scheduled parking in format: DD/MM/YYYY HH:MM (24-hour format)\nExample: 20/05/2025 14:30`;
            } else {
                return `Please select a valid option:\n1. Book Now\n2. Schedule for Later`;
            }
            
        case 3.75:
            // Process scheduled time
            const timeRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2})/;
            const match = message.match(timeRegex);
            
            if (!match) {
                return `Invalid format. Please enter the date and time as: DD/MM/YYYY HH:MM\nExample: 20/05/2025 14:30`;
            }
            
            const [_, day, month, year, hour, minute] = match;
            const scheduledDate = new Date(year, month-1, day, hour, minute);
            
            if (isNaN(scheduledDate.getTime()) || scheduledDate < new Date()) {
                return `Please enter a valid future date and time.`;
            }
            
            booking.scheduledTime = scheduledDate.toLocaleString();
            booking.step = 4;
            
            // Store in advanced bookings for later processing
            if (!advancedBookings[userId]) {
                advancedBookings[userId] = [];
            }
            advancedBookings[userId].push({...booking});
            
            // Schedule a reminder for this booking
            scheduleReminderForBooking(userId, booking);
            
            setUserBooking(userId, booking);
            if (scheduledDate > new Date(Date.now() + 30 * 60 * 1000)) {
                return `🅿️ Parking Mode: Your booking has been scheduled for ${booking.scheduledTime}. We'll notify you 15 minutes before your booking time. Type "status" anytime to check your booking.`;
            } else {
                // If scheduled within 30 minutes, treat as immediate booking
                return `🅿️ Parking Mode: Thanks, ${booking.name}! We are finding the nearest parking spot for your ${booking.vehicleType} for ${booking.scheduledTime}. Please wait...`;
            }

case 4:
    const result = findAvailableOwner(booking.vehicleType, {
        lat: booking.destinationLat,
        lon: booking.destinationLon
    });

    if (result.owner) {
        const { id, slip } = generateBookingTicket(booking, result.owner);
        booking.confirmed = true;
        booking.ticketId = id;
        booking.assignedOwner = result.owner.phone;
        setUserBooking(userId, booking);
        
        // Send to user
        await sendWhatsAppMessage(userId, `🅿️ ${slip}`);
        
        // Send to owner with proper notification
        const ownerNotification = `📥 *New Booking Received!*\n${slip}\n\nReply '2' to confirm acceptance.`;
        console.log(`Sending notification to owner: ${result.owner.phone}`);
        await sendWhatsAppMessage(result.owner.phone, ownerNotification);
        
        setUserMode(userId, 'AI');
        return '';
    } else {
        let reasonMsg = '';
        if (result.status === 'noNearbyOwner') {
            reasonMsg = '🚗 No owner found within 1 km of your destination.';
        } else if (result.status === 'noActiveOwners') {
            reasonMsg = '😔 No active owners available at the moment.';
        }
        
        // Keep the booking but mark it as pending for advanced bookings
        if (booking.scheduledTime) {
            booking.confirmed = false;
            booking.pendingOwner = true;
            setUserBooking(userId, booking);
            return `🅿️ Parking Mode: ${reasonMsg} Your scheduled booking will be processed again closer to the scheduled time.`;
        } else {
            // Clear booking if it's an immediate booking with no available owners
            setUserBooking(userId, null);
            setUserMode(userId, 'AI');
            return `🅿️ Parking Mode: ${reasonMsg} Please try again later or choose a different location.`;
        }
    }


        default:
            return 'Unexpected error. Please start your booking again.';
    }
}


module.exports = {
    handleBooking,
    findAvailableOwner,
    hasActiveBooking,
    getUserBookingStatus,
    scheduleReminderForBooking,
};
