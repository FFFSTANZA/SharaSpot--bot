const sessions = {};
const fs = require('fs');
const path = require('path');

// Load owners data
function loadOwnersData() {
    try {
        const filePath = path.join(__dirname, '../data/owners.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("Error loading owners data:", error);
    }
    
    // Return empty array if file doesn't exist or has errors
    return [];
}

// Initialize owners data
let ownersData = loadOwnersData();

function getUserMode(userId) {
    return sessions[userId]?.mode || 'AI';
}

function setUserMode(userId, mode) {
    if (!sessions[userId]) sessions[userId] = {};
    sessions[userId].mode = mode;
}

function getUserBooking(userId) {
    return sessions[userId]?.booking || null;
}

function setUserBooking(userId, booking) {
    if (!sessions[userId]) sessions[userId] = {};
    sessions[userId].booking = booking;
}

function getOwnerData(userId) {
    return ownersData.find(owner => owner.phone === userId) || null;
}

function getAllOwners() {
    return [...ownersData];
}

function setOwnerStatus(userId, status) {
    const owner = getOwnerData(userId);
    if (owner) {
        owner.status = status;
        saveOwnersData();
        return true;
    }
    return false;
}

function updateOwnerLocation(userId, location) {
    const owner = getOwnerData(userId);
    if (owner) {
        // Handle both object and string formats
        if (typeof location === 'object') {
            owner.lat = location.lat;
            owner.lon = location.lon;
            owner.location = location.text || 'Custom Location';
        } else {
            owner.location = location;
            // Optionally, you could resolve this text to coordinates here
        }
        saveOwnersData();
        return true;
    }
    return false;
}

function addOwner(phone, name = null) {
    if (getOwnerData(phone)) {
        return { success: false, message: 'Owner already exists' };
    }
    
    ownersData.push({
        phone: phone,
        name: name,
        status: 'inactive',
        lat: 0,
        lon: 0,
        location: null,
        bookings: 0,
        availableVehicleTypes: ['Two-wheeler', '4-seat car', '8-seat car', 'Van']
    });
    
    saveOwnersData();
    return { success: true };
}

function removeOwner(phone) {
    const index = ownersData.findIndex(owner => owner.phone === phone);
    if (index === -1) {
        return { success: false, message: 'Owner not found' };
    }
    
    ownersData.splice(index, 1);
    saveOwnersData();
    return { success: true };
}

function getActiveBookings() {
    // Count all active bookings across all sessions
    let count = 0;
    for (const userId in sessions) {
        if (sessions[userId].booking && sessions[userId].booking.confirmed) {
            count++;
        }
    }
    return count;
}

function saveOwnersData() {
    const filePath = path.join(__dirname, '../data/owners.json');
    fs.writeFileSync(filePath, JSON.stringify(ownersData, null, 2));
}

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

// Function to refresh owners data from file
function refreshOwnersData() {
    ownersData = loadOwnersData();
}

module.exports = {
    getUserMode,
    setUserMode,
    getUserBooking,
    setUserBooking,
    getOwnerData,
    getAllOwners,
    setOwnerStatus,
    updateOwnerLocation,
    addOwner,
    removeOwner,
    getActiveBookings,
    checkAndSwitchToOwnerMode,
    refreshOwnersData
};