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

// Store advanced bookings
const advancedBookings = {};

// Reminder scheduler object to track upcoming bookings
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
                
                await sendWhatsAppMessage(userId, `🅿️ ${slip}`);
                await sendWhatsAppMessage(
                    result.owner.phone,
                    `📥 *New Booking Received!*\n${slip}\n\nReply '2' to confirm.`
                );
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

async function handleOwnerCommands(userId, incomingMessage) {
    const owner = getOwnerData(userId);
    if (!owner) {
        return '🅿️ Owner Mode: You are not registered as an owner!';
    }

    const command = incomingMessage.trim();
    switch (command) {
        case '1':
            setOwnerStatus(userId, 'active');
            return '🅿️ Owner Mode: ✅ Your status has been set to ACTIVE. You will now receive booking requests automatically.';
        case '0':
            setOwnerStatus(userId, 'inactive');
            return '🅿️ Owner Mode: 🔴 Your status has been set to INACTIVE. You will not receive booking requests until activated again.';
        case '2':
            // Process booking acceptance - could be improved to check which booking is being accepted
            // For now, just acknowledge the acceptance
            return '🅿️ Owner Mode: ✅ You have accepted the booking. The user has been notified.';
        case '3':
            return '🅿️ Owner Mode: Please send your new location in the format: "LOCATION: <location name>".';
        case 'help':
            return '🅿️ Owner Mode Commands:\n1 - Set status to Active\n0 - Set status to Inactive\n2 - Accept current booking\n3 - Update your location\nhelp - Show this menu\nstatus - Check your current status';
        case 'status':
            // Enhanced owner status with more details
            let bookingsCount = owner.bookings || 0;
            let statusEmoji = owner.status === 'active' ? '🟢' : '🔴';
            
            return `🅿️ Owner Mode: ${statusEmoji} Your current status is ${owner.status.toUpperCase()}.
📍 Location: ${owner.location || "Not set"}
🚗 Vehicle Types: ${owner.availableVehicleTypes?.join(', ') || "All types"}
📊 Total bookings: ${bookingsCount}`;
        default:
            // Check if this is a location update message
            if (command.toLowerCase().startsWith('location:')) {
                const locationText = command.substring(9).trim();
                return updateOwnerLocationFlow(userId, locationText);
            }
            return '🅿️ Owner Mode: ❌ Invalid command. Type "help" to see all available commands.';
    }
}

async function updateOwnerLocationFlow(userId, locationMessage) {
    const owner = getOwnerData(userId);
    if (!owner) {
        return '🅿️ Owner Mode: You are not registered as an owner!';
    }
    
    // Handle both WhatsApp location and text location
    let locationText = locationMessage;
    if (locationMessage.startsWith('LOCATION:')) {
        const parts = locationMessage.split(',');
        if (parts.length >= 3) {
            // Extract lat/lon from WhatsApp location format
            try {
                const latMatch = parts[0].match(/lat=([\d\.]+)/);
                const lonMatch = parts[1].match(/lon=([\d\.]+)/);
                const lat = latMatch ? parseFloat(latMatch[1]) : null;
                const lon = lonMatch ? parseFloat(lonMatch[1]) : null;
                
                if (lat && lon) {
                    updateOwnerLocation(userId, {
                        lat,
                        lon,
                        text: parts[2].replace('name=', '').trim() || 'Custom Location'
                    });
                    return `🅿️ Owner Mode: ✅ Your location has been updated with coordinates (${lat}, ${lon}).`;
                }
            } catch (e) {
                console.error("Error parsing location:", e);
            }
        }
    }
    
    // Text-based location
    const locationData = await resolveTextLocation(locationText);
    if (locationData) {
        updateOwnerLocation(userId, {
            lat: locationData.lat,
            lon: locationData.lon,
            text: locationText
        });
        return `🅿️ Owner Mode: ✅ Your location has been updated to: "${locationText}" (${locationData.lat}, ${locationData.lon}).`;
    } else {
        return `🅿️ Owner Mode: ❌ Couldn't resolve that location. Please try a more specific address or send your location via WhatsApp.`;
    }
}

const ADMIN_NUMBERS = ['+919790294221', '9790294221']; // Add your admin numbers here

const handleAdminCommand = async (message, sender) => {
    if (!ADMIN_NUMBERS.includes(sender)) {
        return '🔒 Unauthorized: Admin access required';
    }

    const parts = message.trim().split(' ');
    const command = parts[0].toUpperCase();
    
    switch (command) {
        case 'ADD':
            if (parts[1] === 'OWNER' && parts.length >= 3) {
                const phone = parts[2];
                const name = parts.length > 3 ? parts.slice(3).join(' ') : null;
                
                if (!phone.startsWith('+')) {
                    return '❌ Phone number must start with country code (e.g., +91)';
                }
                
                const result = addOwner(phone, name);
                if (result.success) {
                    return `✅ Added owner: ${phone}${name ? ' (' + name + ')' : ''}`;
                } else {
                    return `⚠️ ${result.message}`;
                }
            } else if (parts[1] === 'LOCATION' && parts.length >= 5) {
                const name = parts.slice(2, -2).join(' ');
                const lat = parseFloat(parts[parts.length - 2]);
                const lon = parseFloat(parts[parts.length - 1]);

                if (!name || isNaN(lat) || isNaN(lon)) {
                    return '❌ Invalid format. Use: ADD LOCATION <Name> <Lat> <Lon>';
                }

                const filePath = path.join(__dirname, '../data/predefinedLocations.json');
                let locations = [];
                
                try {
                    locations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                } catch (e) {
                    // Create file if it doesn't exist
                    locations = [];
                }

                if (locations.some(loc => loc.name.toLowerCase() === name.toLowerCase())) {
                    return '⚠️ Location already exists';
                }

                locations.push({ name, latitude: lat, longitude: lon });
                fs.writeFileSync(filePath, JSON.stringify(locations, null, 2));
                return `✅ Added "${name}" at (${lat}, ${lon})`;
            }
            return '❌ Invalid ADD command. Use: ADD OWNER <phone> [name] or ADD LOCATION <name> <lat> <lon>';
            
        case 'REMOVE':
            if (parts[1] === 'OWNER' && parts.length >= 3) {
                const phone = parts[2];
                const result = removeOwner(phone);
                if (result.success) {
                    return `✅ Removed owner: ${phone}`;
                } else {
                    return `⚠️ ${result.message}`;
                }
            } else if (parts[1] === 'LOCATION' && parts.length >= 3) {
                const locationName = parts.slice(2).join(' ');
                const filePath = path.join(__dirname, '../data/predefinedLocations.json');
                
                try {
                    let locations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    const initialLength = locations.length;
                    
                    locations = locations.filter(loc => 
                        loc.name.toLowerCase() !== locationName.toLowerCase());
                    
                    if (locations.length < initialLength) {
                        fs.writeFileSync(filePath, JSON.stringify(locations, null, 2));
                        return `✅ Removed location: "${locationName}"`;
                    } else {
                        return `⚠️ Location "${locationName}" not found`;
                    }
                } catch (e) {
                    return '❌ Error accessing locations file';
                }
            }
            return '❌ Invalid REMOVE command. Use: REMOVE OWNER <phone> or REMOVE LOCATION <name>';
            
        case 'LIST':
            if (parts[1] === 'OWNERS') {
                const owners = getAllOwners();
                if (owners.length === 0) {
                    return '📝 No owners registered';
                }
                
                let response = '📋 *Registered Owners:*\n';
                owners.forEach((owner, index) => {
                    const statusEmoji = owner.status === 'active' ? '🟢' : '🔴';
                    response += `${index+1}. ${statusEmoji} ${owner.name || 'Unnamed'} (${owner.phone})\n`;
                });
                return response;
            } else if (parts[1] === 'LOCATIONS') {
                const filePath = path.join(__dirname, '../data/predefinedLocations.json');
                try {
                    const locations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    
                    if (locations.length === 0) {
                        return '📝 No predefined locations found';
                    }
                    
                    let response = '📍 *Predefined Locations:*\n';
                    locations.forEach((loc, index) => {
                        response += `${index+1}. ${loc.name} (${loc.latitude}, ${loc.longitude})\n`;
                    });
                    return response;
                } catch (e) {
                    return '❌ Error reading locations file';
                }
            }
            return '❌ Invalid LIST command. Use: LIST OWNERS or LIST LOCATIONS';
            
        case 'SHOW':
            if (parts[1] === 'STATS') {
                const owners = getAllOwners();
                const activeOwners = owners.filter(o => o.status === 'active').length;
                const activeBookings = getActiveBookings();
                
                // For simplicity, we'll just use length of advancedBookings as the queue count
                const usersInQueue = Object.keys(advancedBookings).length;
                
                return `📊 *SharaSpot Stats*\n` +
                       `📱 Active Owners: ${activeOwners}/${owners.length}\n` +
                       `🎫 Active Bookings: ${activeBookings}\n` +
                       `⏳ Users in Queue: ${usersInQueue}`;
            }
            return '❌ Invalid SHOW command. Use: SHOW STATS';
            
        case 'EXIT':
            return '👋 Exiting Admin Mode';
            
        case 'HELP':
            return '🛠️ *Admin Commands:*\n' +
                   '- ADD OWNER <phone> [name]\n' +
                   '- REMOVE OWNER <phone>\n' +
                   '- LIST OWNERS\n' +
                   '- LIST LOCATIONS\n' +
                   '- ADD LOCATION <name> <lat> <lon>\n' +
                   '- REMOVE LOCATION <name>\n' +
                   '- SHOW STATS\n' +
                   '- EXIT\n' +
                   '- HELP';
                   
        default:
            return '❓ Unknown command. Type HELP for available commands.';
    }
};

// Function to detect if user is an owner and switch to owner mode
function checkAndSwitchToOwnerMode(userId) {
    const owner = getOwnerData(userId);
    if (owner) {
        setUserMode(userId, 'OWNER');
        const statusEmoji = owner.status === 'active' ? '🟢' : '🔴';
        return {
            isOwner: true,
            message: `🅿️ Owner Mode: Welcome back ${owner.name || ''}! Your status is ${statusEmoji} ${owner.status.toUpperCase()}.

Available Commands:
1 - Set Active
0 - Set Inactive
2 - Accept Current Booking
3 - Update Location
status - View Your Status
help - More options`
        };
    }
    return { isOwner: false };
}

module.exports = {
    handleBooking,
    handleOwnerCommands,
    findAvailableOwner,
    updateOwnerLocationFlow,
    handleAdminCommand,
    checkAndSwitchToOwnerMode,
    hasActiveBooking,
    getUserBookingStatus
};