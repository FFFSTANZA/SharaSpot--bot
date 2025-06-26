// bookingPart3.js

const fs = require('fs');
const path = require('path');
const { addOwner, removeOwner, getAllOwners, getActiveBookings } = require('../sessions/sessionManager');

const ADMIN_NUMBERS = ['+919790294221', '9790294221', '+91 9790294221', '919790294221', '916003160229']; // Add your admin numbers here

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
    // Normalize phone numbers for comparison
    const normalizePhone = (phone) => {
        return phone.replace(/[\s\-\(\)]/g, '').replace(/^\+/, '');
    };
    
    const normalizedUserId = normalizePhone(userId);
    const owners = readOwnerData();
    
    const owner = owners.find(owner => {
        const normalizedOwnerPhone = normalizePhone(owner.phone);
        return normalizedOwnerPhone === normalizedUserId || 
               normalizedOwnerPhone.endsWith(normalizedUserId) ||
               normalizedUserId.endsWith(normalizedOwnerPhone);
    });
    
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
    handleAdminCommand,
    checkAndSwitchToOwnerMode
};
