const {
    getOwnerData,
    setOwnerStatus,
    updateOwnerLocation,
    addSlotsToOwner,
    updateSlotState,
    setPendingAction,
} = require('../sessions/sessionManager');

const { createOwnerIfNotExists } = require('../lib/ownerDb');
const { resolveTextLocation } = require('../utils/locationResolver');

// Constants for validation
const CONSTANTS = {
    MAX_SLOTS: 50,
    MIN_SLOTS: 1,
    MAX_LOCATION_LENGTH: 200,
    VALID_SLOT_STATES: ['available', 'occupied'],
    SLOT_TYPES: ['Two-wheeler', '4-seat car', '8-seat car', 'Van'],
    CONFIRMATION_TIMEOUT: 300000 // 5 minutes
};

// Input sanitization utility
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim().replace(/[<>\"'&]/g, ''); // Enhanced XSS protection
}

// Validate slot number
function validateSlotNumber(slotNumber, totalSlots) {
    if (isNaN(slotNumber) || !Number.isInteger(Number(slotNumber))) {
        return { valid: false, error: 'Slot number must be a valid integer.' };
    }
    
    const num = Number(slotNumber);
    if (num < 1) {
        return { valid: false, error: 'Slot number must be greater than 0.' };
    }
    if (num > totalSlots) {
        return { valid: false, error: `Slot number cannot exceed total slots (${totalSlots}).` };
    }
    return { valid: true };
}

// Enhanced command parser with better validation
function parseCommand(message) {
    const sanitized = sanitizeInput(message);
    if (!sanitized) return { command: '', args: [], fullCommand: '', original: message, sanitized: '' };
    
    const parts = sanitized.split(/\s+/).filter(part => part.length > 0);
    
    return {
        original: message,
        sanitized,
        command: parts[0]?.toLowerCase() || '',
        args: parts.slice(1),
        fullCommand: sanitized.toLowerCase().trim()
    };
}

// Main handler function
async function handle_owner_commands(userId, incomingMessage) {
    try {
        // Input validation
        if (!userId) {
            throw new Error('Invalid userId provided');
        }

        if (!incomingMessage || typeof incomingMessage !== 'string') {
            return '🅿️ Owner Mode: Please enter a valid command. Type "help" for options.';
        }

        const parsed = parseCommand(incomingMessage);
        
        if (!parsed.command) {
            return '🅿️ Owner Mode: Please enter a valid command. Type "help" for options.';
        }

        // Get or create owner data with error handling
        let ownerData;
        try {
            // First, ensure the owner exists in the database
            const ownerCreated = await createOwnerIfNotExists(userId);
            if (!ownerCreated) {
                console.warn(`Could not create or verify owner for user ${userId}`);
            }
            
            ownerData = await getOwnerData(userId, true);
        } catch (error) {
            console.error('Error fetching/creating owner data:', error);
            return '🅿️ Owner Mode: ❌ Unable to retrieve your data. Please try again later.';
        }

        if (!ownerData) {
            // Try to create owner again if getOwnerData still fails
            try {
                console.log(`Attempting to create owner for user ${userId}`);
                const created = await createOwnerIfNotExists(userId);
                if (created) {
                    ownerData = await getOwnerData(userId, true);
                }
            } catch (createError) {
                console.error('Error creating owner:', createError);
            }
            
            if (!ownerData) {
                return '🅿️ Owner Mode: ❌ Unable to initialize owner account. Please contact support.';
            }
        }

        // Check for pending confirmations first
        const pendingAction = ownerData.pendingAction;
        if (pendingAction) {
            return await handlePendingConfirmation(userId, parsed.command, pendingAction);
        }

        // Command routing with enhanced validation
        const { command, args, fullCommand, original } = parsed;

        // Greetings
        if (['hi', 'hello', 'hey', 'start'].includes(command)) {
            return await handleGreeting(userId, ownerData);
        }

        // View Slots
        if (command === 'slots' || command === 'status-slots') {
            return await handleViewSlots(userId);
        }

        // Slot management commands
        if (command === 'book') {
            return await handleBookSlot(userId, args);
        }

        if (command === 'free' || command === 'release') {
            return await handleFreeSlot(userId, args);
        }

        // Bulk slot operations
        if (command === 'free-all') {
            return await handleFreeAllSlots(userId);
        }

        // Update total slots
        if (command === 'update' && args[0] === 'slots') {
            return await handleUpdateSlotCount(userId, args.slice(1));
        }

        // Location commands
        if (fullCommand.startsWith('location:')) {
            const locationText = original.substring(original.indexOf(':') + 1).trim();
            return await updateOwnerLocationFlow(userId, locationText);
        }

        if (command === 'location' || command === '3') {
            return getLocationHelp();
        }

        // Status commands
        if (['active', 'activate', 'a', 'on'].includes(command)) {
            return await handleSetActive(userId, true);
        }

        if (['inactive', 'deactivate', 'd', 'off'].includes(command)) {
            return await handleSetActive(userId, false);
        }

        // Information commands
        if (command === 'status' || command === 'info') {
            return await getOwnerStatus(userId);
        }

        if (command === 'help' || command === '?') {
            return getHelpMessage();
        }

        // Advanced commands
        if (command === 'reset') {
            return await handleResetSlots(userId);
        }

        if (command === 'analytics') {
            return await getOwnerAnalytics(userId);
        }

        // Unknown command
        return `🅿️ Owner Mode: ❌ Unknown command "${command}". Type "help" to see available commands.`;

    } catch (error) {
        console.error('Error in handle_owner_commands:', error);
        return '🅿️ Owner Mode: ❌ An unexpected error occurred. Please try again or contact support if the issue persists.';
    }
}

// Handle pending confirmation actions
async function handlePendingConfirmation(userId, command, pendingAction) {
    try {
        // Check if confirmation has expired
        if (pendingAction.timestamp && (Date.now() - pendingAction.timestamp) > CONSTANTS.CONFIRMATION_TIMEOUT) {
            await setPendingAction(userId, null);
            return '🅿️ Owner Mode: ⏰ Confirmation expired. Please try your command again.';
        }

        // Handle reset confirmation
        if (pendingAction.action === 'reset_slots') {
            if (['confirm', 'yes', 'y'].includes(command)) {
                const result = await handleFreeAllSlots(userId);
                await setPendingAction(userId, null);
                return result.replace('All', 'Reset completed! All');
            } else if (['cancel', 'no', 'n'].includes(command)) {
                await setPendingAction(userId, null);
                return '🅿️ Owner Mode: ❌ Reset cancelled. No changes made.';
            } else {
                return '🅿️ Owner Mode: Please type "confirm" to proceed or "cancel" to abort the reset.';
            }
        }

        // Clear unknown pending actions
        await setPendingAction(userId, null);
        return '🅿️ Owner Mode: Previous action cleared. Please try your command again.';
        
    } catch (error) {
        console.error('Error in handlePendingConfirmation:', error);
        await setPendingAction(userId, null);
        return '🅿️ Owner Mode: ❌ Error processing confirmation. Please try again.';
    }
}

// Greeting handler
async function handleGreeting(userId, ownerData) {
    try {
        const available = ownerData.slots?.filter(s => s.state === 'available').length || 0;
        const total = ownerData.slots?.length || 0;
        const status = ownerData.is_active ? '🟢 Active' : '🔴 Inactive';
        
        return `👋 Hello Owner! 
        
${status} | ${available}/${total} slots available
Type "help" to see all commands or "status" for detailed info.`;
    } catch (error) {
        console.error('Error in handleGreeting:', error);
        return '👋 Hello Owner! Type "help" to see available commands.';
    }
}

// View slots handler
async function handleViewSlots(userId) {
    try {
        const owner = await getOwnerData(userId, true);
        
        if (!owner.slots || owner.slots.length === 0) {
            return '🅿️ Owner Mode: No slots configured. Use "update slots [number]" to set capacity.';
        }

        let response = '🅿️ Current Slot Status:\n\n';
        
        // Sort slots by index for consistent display
        const sortedSlots = [...owner.slots].sort((a, b) => a.index - b.index);
        
        sortedSlots.forEach((slot) => {
            const stateIcon = slot.state === 'occupied' ? '🔴' : '🟢';
            const stateText = slot.state === 'occupied' ? 'Occupied' : 'Available';
            response += `${stateIcon} Slot ${slot.index}: ${stateText}\n`;
        });

        const available = sortedSlots.filter(s => s.state === 'available').length;
        const occupied = sortedSlots.length - available;

        response += `\n📊 Summary: ${available} Available | ${occupied} Occupied`;
        response += `\n\n💡 Use "free [slot]" or "book [slot]" to manage slots.`;
        
        return response;
    } catch (error) {
        console.error('Error in handleViewSlots:', error);
        return '🅿️ Owner Mode: ❌ Unable to retrieve slot information. Please try again.';
    }
}

// Book slot handler
async function handleBookSlot(userId, args) {
    if (args.length === 0 || !args[0]) {
        return '🅿️ Owner Mode: ❌ Please specify a slot number. Usage: book [slot_number]';
    }

    const slotNumber = parseInt(args[0]);
    return await handleSlotStateChange(userId, slotNumber, 'occupied', 'book');
}

// Free slot handler
async function handleFreeSlot(userId, args) {
    if (args.length === 0 || !args[0]) {
        return '🅿️ Owner Mode: ❌ Please specify a slot number. Usage: free [slot_number]';
    }

    const slotNumber = parseInt(args[0]);
    return await handleSlotStateChange(userId, slotNumber, 'available', 'free');
}

// Generic slot state change handler
async function handleSlotStateChange(userId, slotNumber, newState, action) {
    try {
        const ownerData = await getOwnerData(userId, true);

        if (!ownerData.slots || ownerData.slots.length === 0) {
            return '🅿️ Owner Mode: ❌ No slots configured. Use "update slots [number]" first.';
        }

        // Validate slot number
        const validation = validateSlotNumber(slotNumber, ownerData.slots.length);
        if (!validation.valid) {
            return `🅿️ Owner Mode: ❌ ${validation.error}`;
        }

        // Find slot
        const slot = ownerData.slots.find(s => s.index === slotNumber);

        if (!slot) {
            return `🅿️ Owner Mode: ❌ Slot ${slotNumber} does not exist. Available slots: 1-${ownerData.slots.length}`;
        }

        // Check if already in desired state
        if (slot.state === newState) {
            const stateText = newState === 'occupied' ? 'occupied' : 'available';
            return `🅿️ Owner Mode: ℹ️ Slot ${slotNumber} is already ${stateText}.`;
        }

        // Update slot state
        const success = await updateSlotState(userId, slotNumber, newState);
        
        if (success) {
            const actionText = newState === 'occupied' ? 'booked' : 'freed';
            const icon = newState === 'occupied' ? '🔴' : '🟢';
            return `🅿️ Owner Mode: ✅ ${icon} Slot ${slotNumber} has been ${actionText}.`;
        } else {
            return `🅿️ Owner Mode: ❌ Failed to update Slot ${slotNumber}. Please try again.`;
        }

    } catch (error) {
        console.error(`Error in handleSlotStateChange:`, error);
        return '🅿️ Owner Mode: ❌ Unable to update slot. Please try again.';
    }
}

// Update slot count handler
async function handleUpdateSlotCount(userId, args) {
    try {
        if (args.length === 0 || !args[0]) {
            return '🅿️ Owner Mode: ❌ Please specify number of slots. Usage: update slots [number]';
        }

        const newCount = parseInt(args[0]);
        
        if (isNaN(newCount) || !Number.isInteger(newCount)) {
            return '🅿️ Owner Mode: ❌ Please enter a valid number.';
        }

        if (newCount < CONSTANTS.MIN_SLOTS) {
            return `🅿️ Owner Mode: ❌ Must have at least ${CONSTANTS.MIN_SLOTS} slot.`;
        }

        if (newCount > CONSTANTS.MAX_SLOTS) {
            return `🅿️ Owner Mode: ❌ Maximum ${CONSTANTS.MAX_SLOTS} slots allowed.`;
        }

        // Ensure owner exists before proceeding
        const ownerExists = await createOwnerIfNotExists(userId);
        if (!ownerExists) {
            return '🅿️ Owner Mode: ❌ Unable to verify owner account. Please try again.';
        }

        const ownerData = await getOwnerData(userId, true);
        if (!ownerData) {
            return '🅿️ Owner Mode: ❌ Unable to retrieve owner data. Please try again.';
        }

        // Ensure slots array exists
        const currentSlots = Array.isArray(ownerData.slots) ? ownerData.slots : [];
        const currentCount = currentSlots.length;

        if (newCount === currentCount) {
            await setPendingAction(userId, null);
            return `🅿️ Owner Mode: ℹ️ You already have ${newCount} slots. No changes made.`;
        }

        if (newCount > currentCount) {
            // Adding slots - ensure proper indexing
            let maxIndex = 0;
            if (currentSlots.length > 0) {
                maxIndex = Math.max(...currentSlots.map(s => s.index || 0));
            }
            
            const slotsToAdd = [];
            for (let i = 0; i < newCount - currentCount; i++) {
                slotsToAdd.push({
                    index: maxIndex + i + 1,
                    type: 'Two-wheeler',
                    state: 'available'
                });
            }

            const updatedSlots = [...currentSlots, ...slotsToAdd];
            
            console.log(`Adding slots for user ${userId}:`, {
                currentCount,
                newCount,
                slotsToAdd: slotsToAdd.length,
                totalSlots: updatedSlots.length
            });
            
            const success = await addSlotsToOwner(userId, updatedSlots);
            
            if (success) {
                await setPendingAction(userId, null);
                return `🅿️ Owner Mode: ✅ ${currentCount === 0 ? 'Created' : 'Increased to'} ${newCount} slots. ${currentCount === 0 ? 'Added' : 'Added'} ${newCount - currentCount} new slots.`;
            } else {
                console.error(`Failed to add slots for user ${userId}`);
                return '🅿️ Owner Mode: ❌ Failed to add slots. Please try again.';
            }
        }

        if (newCount < currentCount) {
            // Reducing slots - sort by index and remove highest numbered slots
            const sortedSlots = [...currentSlots].sort((a, b) => (a.index || 0) - (b.index || 0));
            const slotsToKeep = sortedSlots.slice(0, newCount);
            const slotsToRemove = sortedSlots.slice(newCount);
            
            const occupiedToRemove = slotsToRemove.filter(slot => slot.state === 'occupied');
            
            if (occupiedToRemove.length > 0) {
                const occupiedNumbers = occupiedToRemove.map(s => s.index).join(', ');
                return `🅿️ Owner Mode: ❌ Cannot reduce slots. Slots ${occupiedNumbers} are currently occupied. Free them first.`;
            }

            console.log(`Reducing slots for user ${userId}:`, {
                currentCount,
                newCount,
                slotsToKeep: slotsToKeep.length,
                slotsToRemove: slotsToRemove.length
            });

            const success = await addSlotsToOwner(userId, slotsToKeep);
            
            if (success) {
                await setPendingAction(userId, null);
                return `🅿️ Owner Mode: ✅ Reduced to ${newCount} slots. Removed ${currentCount - newCount} slots.`;
            } else {
                console.error(`Failed to reduce slots for user ${userId}`);
                return '🅿️ Owner Mode: ❌ Failed to reduce slots. Please try again.';
            }
        }

    } catch (error) {
        console.error('Error in handleUpdateSlotCount:', error);
        return `🅿️ Owner Mode: ❌ Unable to update slot count. Error: ${error.message}`;
    }
}

// Free all slots handler
async function handleFreeAllSlots(userId) {
    try {
        const ownerData = await getOwnerData(userId, true);
        
        if (!ownerData.slots || ownerData.slots.length === 0) {
            return '🅿️ Owner Mode: ❌ No slots configured.';
        }

        const occupiedSlots = ownerData.slots.filter(s => s.state === 'occupied');
        
        if (occupiedSlots.length === 0) {
            return '🅿️ Owner Mode: ℹ️ All slots are already available.';
        }

        // Free all occupied slots
        let successCount = 0;
        const failedSlots = [];
        
        for (const slot of occupiedSlots) {
            try {
                const success = await updateSlotState(userId, slot.index, 'available');
                if (success) {
                    successCount++;
                } else {
                    failedSlots.push(slot.index);
                }
            } catch (error) {
                console.error(`Error freeing slot ${slot.index}:`, error);
                failedSlots.push(slot.index);
            }
        }

        if (successCount === occupiedSlots.length) {
            return `🅿️ Owner Mode: ✅ All ${successCount} occupied slots have been freed.`;
        } else if (successCount > 0) {
            return `🅿️ Owner Mode: ⚠️ Freed ${successCount}/${occupiedSlots.length} slots. Failed: ${failedSlots.join(', ')}`;
        } else {
            return `🅿️ Owner Mode: ❌ Failed to free any slots. Please try again.`;
        }

    } catch (error) {
        console.error('Error in handleFreeAllSlots:', error);
        return '🅿️ Owner Mode: ❌ Unable to free all slots. Please try again.';
    }
}

// Reset slots handler (with confirmation)
async function handleResetSlots(userId) {
    try {
        const ownerData = await getOwnerData(userId, true);
        
        if (!ownerData.slots || ownerData.slots.length === 0) {
            return '🅿️ Owner Mode: ❌ No slots configured to reset.';
        }

        const occupiedSlots = ownerData.slots.filter(s => s.state === 'occupied');
        
        if (occupiedSlots.length === 0) {
            return '🅿️ Owner Mode: ℹ️ All slots are already available. Nothing to reset.';
        }

        await setPendingAction(userId, { 
            action: 'reset_slots', 
            timestamp: Date.now(),
            slotsToReset: occupiedSlots.length
        });
        
        return `🅿️ Owner Mode: ⚠️ This will free all ${occupiedSlots.length} occupied slots. Type "confirm" to proceed or "cancel" to abort.`;
        
    } catch (error) {
        console.error('Error in handleResetSlots:', error);
        return '🅿️ Owner Mode: ❌ Unable to initiate reset. Please try again.';
    }
}

// Set active status handler
async function handleSetActive(userId, isActive) {
    try {
        const success = await setOwnerStatus(userId, isActive);
        
        if (success) {
            const status = isActive ? '🟢 ACTIVE' : '🔴 INACTIVE';
            const message = isActive ? 'activated' : 'deactivated';
            return `🅿️ Owner Mode: ✅ Status ${message}. You are now ${status}.`;
        } else {
            return '🅿️ Owner Mode: ❌ Failed to update status. Please try again.';
        }
    } catch (error) {
        console.error('Error in handleSetActive:', error);
        return '🅿️ Owner Mode: ❌ Unable to update status. Please try again.';
    }
}

// Get owner status
async function getOwnerStatus(userId) {
    try {
        const ownerData = await getOwnerData(userId, true);
        
        if (!ownerData) {
            return '🅿️ Owner Mode: ❌ Unable to retrieve status.';
        }

        // Ensure slots is an array
        const slots = Array.isArray(ownerData.slots) ? ownerData.slots : [];
        const available = slots.filter(s => s.state === 'available').length;
        const occupied = slots.filter(s => s.state === 'occupied').length;
        const total = slots.length;

        const statusIcon = ownerData.is_active ? '🟢' : '🔴';
        const statusText = ownerData.is_active ? 'ACTIVE' : 'INACTIVE';

        let locationText = 'Not set';
        if (ownerData.location && ownerData.location !== 'Unknown' && ownerData.location !== 'unknown') {
            locationText = ownerData.location;
        }

        return `🅿️ Owner Status:

${statusIcon} Status: ${statusText}
📍 Location: ${locationText}
📊 Slots: ${total} total
    🟢 Available: ${available}
    🔴 Occupied: ${occupied}
    
📈 Occupancy Rate: ${total > 0 ? Math.round((occupied / total) * 100) : 0}%`;

    } catch (error) {
        console.error('Error in getOwnerStatus:', error);
        return '🅿️ Owner Mode: ❌ Unable to retrieve status. Please try again.';
    }
}

// Get owner analytics
async function getOwnerAnalytics(userId) {
    try {
        const ownerData = await getOwnerData(userId, true);
        
        if (!ownerData.slots || ownerData.slots.length === 0) {
            return '🅿️ Owner Mode: No slots configured for analytics.';
        }

        // Basic analytics
        const total = ownerData.slots.length;
        const available = ownerData.slots.filter(s => s.state === 'available').length;
        const occupied = total - available;
        const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

        let utilizationStatus = '💤 Low utilization';
        if (occupancyRate >= 80) {
            utilizationStatus = '🔥 High demand!';
        } else if (occupancyRate >= 50) {
            utilizationStatus = '📊 Moderate usage';
        }

        return `📊 Parking Analytics:

🅿️ Total Capacity: ${total} slots
🟢 Available: ${available} (${100 - occupancyRate}%)
🔴 Occupied: ${occupied} (${occupancyRate}%)

📈 Current Utilization: ${occupancyRate}%
${utilizationStatus}`;

    } catch (error) {
        console.error('Error in getOwnerAnalytics:', error);
        return '🅿️ Owner Mode: ❌ Unable to generate analytics.';
    }
}

// Location help message
function getLocationHelp() {
    return `📍 Location Update Options:

1. Text Address:
   location: 123 Main Street, City

2. GPS Coordinates:
   location: LOCATION:lat=12.34,lon=56.78,text=My Parking

3. Share your live location through the chat interface

Current location will be used for customer searches.`;
}

// Update owner location
async function updateOwnerLocationFlow(userId, message) {
    try {
        const owner = await getOwnerData(userId);
        if (!owner) {
            return '🅿️ Owner Mode: You are not registered as an owner!';
        }

        // Validate input length
        if (message.length > CONSTANTS.MAX_LOCATION_LENGTH) {
            return `🅿️ Owner Mode: ❌ Location text too long (max ${CONSTANTS.MAX_LOCATION_LENGTH} characters).`;
        }

        // Handle GPS coordinates format
        if (message.startsWith('LOCATION:')) {
            try {
                const parts = message.split(',');
                if (parts.length < 3) {
                    return '🅿️ Owner Mode: ❌ Invalid GPS format. Use: LOCATION:lat=12.34,lon=56.78,text=Description';
                }

                const lat = parseFloat(parts[0].split('=')[1]);
                const lon = parseFloat(parts[1].split('=')[1]);
                const text = parts[2]?.split('=')[1] || 'GPS Location';

                if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                    return '🅿️ Owner Mode: ❌ Invalid GPS coordinates.';
                }

                const locationData = { lat, lon, text: sanitizeInput(text) };
                const updated = await updateOwnerLocation(userId, locationData);
                
                if (updated) {
                    await setPendingAction(userId, null);
                    return `🅿️ Owner Mode: ✅ GPS location updated to "${text}".`;
                }
                return '🅿️ Owner Mode: ❌ Failed to update GPS location.';
                
            } catch (e) {
                console.error('GPS parsing error:', e);
                return '🅿️ Owner Mode: ❌ Error parsing GPS location.';
            }
        }

        // Handle plain text location
        const sanitizedMessage = sanitizeInput(message);
        if (!sanitizedMessage) {
            return '🅿️ Owner Mode: ❌ Please provide a valid location.';
        }

        const updated = await updateOwnerLocation(userId, sanitizedMessage);
        
        if (updated) {
            await setPendingAction(userId, null);
            return `🅿️ Owner Mode: ✅ Location updated to "${sanitizedMessage}".`;
        }

        return '🅿️ Owner Mode: ❌ Failed to update location. Please try again.';

    } catch (error) {
        console.error('Error in updateOwnerLocationFlow:', error);
        return '🅿️ Owner Mode: ❌ Unable to update location. Please try again.';
    }
}

// Help message
function getHelpMessage() {
    return `🅿️ Owner Mode Commands:

🔹 Status Management:
• active / a - Set status to active
• inactive / d - Set status to inactive
• status - View detailed status

🔹 Slot Management:
• slots - View all slot statuses
• book [number] - Mark slot as occupied
• free [number] - Mark slot as available  
• free-all - Free all occupied slots
• update slots [number] - Change total slots (1-${CONSTANTS.MAX_SLOTS})

🔹 Location:
• location - Get location help
• location: [address] - Update location manually
• location: LOCATION:lat=X,lon=Y,text=Name - Set GPS location

🔹 Information:
• help - Show this help message
• analytics - View usage analytics
• reset - Reset all slots (with confirmation)

🔹 Quick Actions:
• hi/hello - Greeting with status summary

💡 Tip: Slot numbers start from 1. Always free occupied slots before reducing total count.`;
}

module.exports = {
    handle_owner_commands,
    updateOwnerLocationFlow,
    validateSlotNumber,
    sanitizeInput,
    CONSTANTS
};