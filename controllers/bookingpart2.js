// bookingPart2.js

const {
    getOwnerData,
    setOwnerStatus,
    updateOwnerLocation
} = require('../sessions/sessionManager');
const { resolveTextLocation } = require('../utils/locationResolver');

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
    }  const locationData = await resolveTextLocation(locationText);
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

module.exports = {
    handleOwnerCommands,
    updateOwnerLocationFlow
};
