const {
    getOwnerData,
    setOwnerStatus,
    updateOwnerLocation,
    addSlotsToOwner,
    updateSlotState,
    setPendingAction
} = require('../sessions/sessionManager');

const { resolveTextLocation } = require('../utils/locationResolver');

async function handle_owner_commands(userId, incomingMessage) {
    try {
        const originalMessage = incomingMessage.trim();
        const command = originalMessage.toLowerCase();

        if (!command) return '🅿️ Owner Mode: Please enter a valid command. Type "help" for options.';

        const ownerData = await getOwnerData(userId, true); // ✅ force refresh

        if (!ownerData) return '🅿️ Owner Mode: You are not registered as an owner!';

        // Greetings
        if (["hi", "hello", "hey"].includes(command)) {
            return '👋 Hello Owner! Type "help" to see what I can do.';
        }

        // View Slots
        if (command === 'slots') return await handleViewSlots(userId);

        // Book a slot
        if (command.startsWith('book ')) {
            const slotNumber = parseInt(command.split(' ')[1]);
            if (isNaN(slotNumber)) return '❌ Invalid slot number.';
            return await handleSlotStateChange(userId, slotNumber, 'occupied');
        }

        // Free a slot
        if (command.startsWith('free ')) {
            const slotNumber = parseInt(command.split(' ')[1]);
            if (isNaN(slotNumber)) return '❌ Invalid slot number.';
            return await handleSlotStateChange(userId, slotNumber, 'available');
        }

        // Update total slots
        if (command.startsWith('update slots')) {
            const parts = command.split(' ');
            const num = parseInt(parts[2]);
            if (isNaN(num)) return '❌ Please enter number of slots like: update slots 5';
            return await handleUpdateSlotCount(userId, num);
        }

        // Update location
        if (command.startsWith('location:')) {
            const locationText = originalMessage.substring(9).trim();
            return await updateOwnerLocationFlow(userId, locationText);
        }

        // Ask for location manually
        if (command === 'location' || command === '3') {
            return '📍 Please send your location or type: location: [your address here]';
        }

        // Activate/Deactivate
        if (command === 'active' || command === 'a') {
            return await handleSetActive(userId, true);
        }

        if (command === 'inactive' || command === 'd') {
            return await handleSetActive(userId, false);
        }

        // Status and Help
        if (command === 'status') return await getOwnerStatus(userId);
        if (command === 'help') return getHelpMessage();

        return '🅿️ Owner Mode: ❌ Invalid command. Type "help" to see available commands.';
    } catch (error) {
        console.error('Error in handle_owner_commands:', error);
        return '🅿️ Owner Mode: ❌ An error occurred. Please try again.';
    }
}




async function handleViewSlots(userId) {
    const owner = await getOwnerData(userId);
    if (!owner.slots || owner.slots.length === 0) {
        return '🅿️ Owner Mode: No slots configured. Use "update slots" to set capacity.';
    }
    let response = '🅿️ Current Slot Status:\n\n';
    owner.slots.forEach((slot) => {
        response += `Slot ${slot.index}: ${slot.state === 'occupied' ? 'occupied' : 'Available'}\n`;
    });
    response += `\nUse "free [slot]" or "book [slot]" to manage slots.`;
    return response;
}

async function handleSlotStateChange(userId, slotNumber, newState) {
    const ownerData = await getOwnerData(userId, true); // ✅ force refresh

    const slot = ownerData.slots.find(s => s.index === slotNumber);

    if (!slot) return `🅿️ Owner Mode: ❌ Slot ${slotNumber} does not exist.`;

    if (slot.state === newState) {
        return `🅿️ Owner Mode: Slot ${slotNumber} is already ${newState}.`;
    }

    const success = await updateSlotState(userId, slotNumber, newState);
    return success
        ? `🅿️ Owner Mode: ✅ Slot ${slotNumber} is now marked as ${newState}.`
        : `🅿️ Owner Mode: ❌ Could not update Slot ${slotNumber}.`;
}

async function handleUpdateSlotCount(userId, newCount) {
    if (isNaN(newCount)) return '🅿️ Owner Mode: ❌ Please enter a valid number.';
    if (newCount < 1) return '🅿️ Owner Mode: ❌ Must have at least 1 slot.';

    const ownerData = await getOwnerData(userId, true);
    const currentSlots = ownerData.slots || [];

    const currentCount = currentSlots.length;

    if (newCount === currentCount) {
        await setPendingAction(userId, null);
        return `🅿️ Owner Mode: You already have ${newCount} slots. No changes made.`;
    }

    if (newCount > currentCount) {
        // Add new slots
        const slotsToAdd = Array.from({ length: newCount - currentCount }, (_, i) => ({
            index: currentCount + i,
            type: 'Two-wheeler',
            state: 'available'
        }));

        const updatedSlots = [...currentSlots, ...slotsToAdd];
        await addSlotsToOwner(userId, updatedSlots); // ✅ CORRECT

        await setPendingAction(userId, null);
        return `🅿️ Owner Mode: ✅ Increased to ${newCount} slots.`;
    }

    if (newCount < currentCount) {
        // Optional safety: ensure we're not deleting occupied slots
        const toDelete = currentSlots.slice(newCount);
        const hasBooked = toDelete.some(slot => slot.state === 'occupied');
        if (hasBooked) {
            return '🅿️ Owner Mode: ❌ Cannot reduce slots. Some of the last slots are occupied.';
        }

        const updatedSlots = currentSlots.slice(0, newCount);
        await addSlotsToOwner(userId, updatedSlots);

        await setPendingAction(userId, null);
        return `🅿️ Owner Mode: ✅ Reduced to ${newCount} slots.`;
    }
}

async function getOwnerStatus(userId) {
    const ownerData = await getOwnerData(userId);
    const available = ownerData.slots?.filter(s => s.state === 'available').length || 0;
    const total = ownerData.slots?.length || 0;

    return `🅿️ Owner Status:
Status: ${ownerData.status === 'active' ? '🟢 ACTIVE' : '🔴 INACTIVE'}
Location: ${ownerData.location?.text || ownerData.location || 'Not set'}
Total Slots: ${total}
Available Slots: ${available}
Booked Slots: ${total - available}`;
}


async function updateOwnerLocationFlow(userId, message) {
  const owner = await getOwnerData(userId);
  if (!owner) return '🅿️ Owner Mode: You are not registered as an owner!';

  // ✅ Handle LOCATION:lat=...,lon=...,text=...
  if (message.startsWith('LOCATION:')) {
    try {
      const parts = message.split(',');
      const lat = parseFloat(parts[0].split('=')[1]);
      const lon = parseFloat(parts[1].split('=')[1]);
      const text = parts[2]?.split('=')[1] || 'Custom Location';

      const updated = await saveOwnerLocation(userId, { lat, lon, text }); // direct call!
      if (updated) {
        await setPendingAction(userId, null);
        return `🅿️ Owner Mode: ✅ Location updated to "${text}".`;
      }
      return '🅿️ Owner Mode: ❌ Failed to update location.';
    } catch (e) {
      return '🅿️ Owner Mode: ❌ Error parsing GPS location.';
    }
  }

  // Save plain location text directly (without ORS)
  const updated = await updateOwnerLocation(userId, message);
  if (updated) {
    await setPendingAction(userId, null);
    return `🅿️ Owner Mode: ✅ Location set to "${message}".`;
  }

  return '🅿️ Owner Mode: ❌ Could not set location.';
}


function getHelpMessage() {
    return `🅿️ Owner Mode Commands:

🔹 Availability:
active / a - Set active  
inactive / d - Set inactive

🔹 Slot Management:
slots - View slot status  fff
free [n] - Free a slot  
book [n] - Book a slot  
update slots [number]- Change total slots

🔹 Location:
location: [address] lat lon - Trigger location update  
location: [address] - Update location manually

🔹 Info:
status - View current status  
help - Show this help message`;
}

module.exports = {
    handle_owner_commands,
    updateOwnerLocationFlow
};
