const {
  createOwner,
  getAllOwners,
  getOwner: getOwnerFull,
  updateOwnerSession,
  addSlotsToOwner
} = require('../lib/ownerDb');

const { createLocation, getAllLocation, getLocationByname } = require('../lib/preDefinedLocDb');
const { getOwnerByPhone, deleteOwner } = require('../lib/ownerDb');
const { eq } = require('drizzle-orm');
const { predefinedLocations } = require('../database/db');
const { db } = require('../database/db');

const ADMIN_NUMBERS = new Set([
    '9790294221',
    '6003160229'
]);

const normalizePhone = (phone) => phone.replace(/\D/g, '').slice(-10);

const verifyAdminStatus = (phone) => {
    const normalized = normalizePhone(phone);
    const isAdmin = ADMIN_NUMBERS.has(normalized);
    if (!isAdmin) console.log(`Admin access denied for: ${normalized}`);
    return isAdmin;
};

const handle_admin_command = async (message, senderNumber) => {
    try {
        if (!verifyAdminStatus(senderNumber)) return '🔒 Unauthorized: Admin access required';

        const [command, ...args] = message.trim().split(/\s+/);
        const action = command?.toUpperCase();

        if (!action) return '❌ Please specify a command. Type HELP for options.';

        switch (action) {
            case 'ADD': return await handleAddCommand(args);
            case 'REMOVE': return await handleRemoveCommand(args);
            case 'LIST': return await handleListCommand(args);
            case 'SHOW': return await handleShowCommand(args);
            case 'EXIT': return '👋 Exiting Admin Mode';
            case 'HELP': return getHelpMessage();
            default: return '❌ Unknown command. Type HELP for options.';
        }
    } catch (error) {
        console.error('Admin command error:', error);
        return '⚠️ An error occurred. Please try again.';
    }
};

async function handleAddCommand(args) {
    if (args.length < 2) return '❌ Invalid ADD command. Type HELP for usage.';

    const type = args[0]?.toUpperCase();
    const params = args.slice(1);

    switch (type) {
        case 'OWNER': return await addOwnerHandler(params);
        case 'LOCATION': return await addLocationHandler(params);
        default: return '❌ Invalid ADD type. Use OWNER or LOCATION.';
    }
}

async function addOwnerHandler(params) {
    if (params.length < 1) return '❌ Format: ADD OWNER <phone> [name]';

    const phone = params[0];
    const name = params.length > 1 ? params.slice(1).join(' ') : null;

    try {
        if (!phone.match(/^\+?\d{10,15}$/)) return '❌ Invalid phone format. Use +91XXXXXXXXXX or 91XXXXXXXXXX';

        const result = await createOwner({ phoneNum: phone, name });

        return `✅ Owner added successfully:\n` +
               `Name: ${result.name || 'Not provided'}\n` +
               `Phone: ${result.phoneNum}\n` +
               `Status: ${result.is_active ? 'Active' : 'Inactive'}`;
    } catch (error) {
        if (error.message.includes('already exists')) return '⚠️ Owner already exists. Use LIST OWNERS to view.';
        return `❌ Failed to add owner: ${error.message}`;
    }
}

async function addLocationHandler(params) {
    if (params.length < 3) return '❌ Format: ADD LOCATION <name> <lat> <lon>';

    const lat = parseFloat(params[params.length - 2]);
    const lon = parseFloat(params[params.length - 1]);
    const name = params.slice(0, -2).join(' ');

    if (!name || isNaN(lat) || isNaN(lon)) return '❌ Invalid location data. Provide valid name, lat, lon';

    try {
        const existing = await getLocationByname(name);
        if (existing) return '⚠️ Location already exists';

        await createLocation({ name, latitude: lat, longitude: lon });
        invalidateCache();
        return `✅ Added "${name}" at (${lat}, ${lon})`;
    } catch (error) {
        return `⚠️ Failed to add location: ${error.message}`;
    }
}

async function handleRemoveCommand(args) {
    if (args.length < 2) return '❌ Invalid REMOVE command. Type HELP for usage.';

    const type = args[0]?.toUpperCase();
    const params = args.slice(1);

    switch (type) {
        case 'OWNER': return await removeOwnerHandler(params);
        case 'LOCATION': return await removeLocationHandler(params);
        default: return '❌ Invalid REMOVE type. Use OWNER or LOCATION.';
    }
}

async function removeOwnerHandler(params) {
  if (params.length < 1) return '❌ Format: REMOVE OWNER <phone>';

  const phone = params[0];
  try {
    const owner = await getOwnerByPhone(phone);
    if (!owner) return `⚠️ Owner not found: ${phone}`;

    await deleteOwner(owner.id); // Actually delete
    invalidateCache();
    return `✅ Permanently deleted owner: ${phone}`;
  } catch (error) {
    return `⚠️ Failed to delete owner: ${error.message}`;
  }
}

async function removeLocationHandler(params) {
    if (params.length < 1) return '❌ Format: REMOVE LOCATION <name>';

    const name = params.join(' ');
    try {
        const allLocs = await getAllLocation();
        const loc = allLocs.find(l => l.name.toLowerCase() === name.toLowerCase());

        if (!loc) return `⚠️ Location not found: "${name}"`;

        await db.delete(predefinedLocations).where(eq(predefinedLocations.id, loc.id));
        invalidateCache();
        return `✅ Removed location: "${name}"`;
    } catch (error) {
        return `⚠️ Failed to remove location: ${error.message}`;
    }
}

async function handleListCommand(args) {
    if (args.length < 1) return '❌ Invalid LIST command. Type HELP for usage.';

    const type = args[0]?.toUpperCase();

    switch (type) {
        case 'OWNERS': return await listOwnersHandler();
        case 'LOCATIONS': return await listLocationsHandler();
        default: return '❌ Invalid LIST type. Use OWNERS or LOCATIONS.';
    }
}

async function listOwnersHandler() {
    try {
        const owners = await getAllOwners();

        if (!owners.length) return '📝 No owners registered';

        let response = '📋 *Registered Owners*\n';
        owners.forEach((owner, index) => {
            const status = owner.is_active ? '🟢 ACTIVE' : '🔴 INACTIVE';
            response += `${index+1}. ${status} ${owner.name || 'Unnamed'} ${owner.phoneNum}\n`;
        });

        return response;
    } catch (error) {
        return `⚠️ Failed to list owners: ${error.message}`;
    }
}

async function listLocationsHandler() {
    try {
        const locations = await getCachedData('locations', getAllLocation);

        if (!locations?.length) return '📝 No predefined locations';

        let response = '📍 *Predefined Locations*\n';
        locations.forEach((loc, index) => {
            response += `${index+1}. ${loc.name} (${loc.latitude}, ${loc.longitude})\n`;
        });

        return response;
    } catch (error) {
        return `⚠️ Failed to list locations: ${error.message}`;
    }
}

async function handleShowCommand(args) {
    if (args.length < 1 || args[0]?.toUpperCase() !== 'STATS') {
        return '❌ Invalid SHOW command. Use: SHOW STATS';
    }

    try {
        const owners = await getCachedData('owners', getAllOwners);
        const activeOwners = owners?.filter(o => o.is_active).length || 0;

        let totalSlots = 0;
        let openSlots = 0;
        let bookedSlots = 0;
        let closedSlots = 0;

        for (const owner of owners) {
            const slots = await getAllSlotsByOwner(owner.id);
            totalSlots += slots.length;
            for (const s of slots) {
                if (s.state === 'available') openSlots++;
                else if (s.state === 'occupied') bookedSlots++;
                else if (s.state === 'closed') closedSlots++;
            }
        }

        const locations = await getCachedData('locations', getAllLocation);

        return `📊 *System Statistics*\n` +
               `👷 Owners: ${activeOwners}/${owners.length} active\n` +
               `🅿️ Total Slots: ${totalSlots}\n` +
               `🟩 available: ${openSlots}, 🔴 occupied: ${bookedSlots}, 🚫 Closed: ${closedSlots}\n` +
               `📍 Locations: ${locations?.length || 0}`;
    } catch (error) {
        return `⚠️ Failed to show stats: ${error.message}`;
    }
}

function getHelpMessage() {
    return `🛠️ *Admin Command Reference*\n\n` +
           `*ADD*\n` +
           `- OWNER <phone> [name] - Register new owner\n` +
           `- LOCATION <name> <lat> <lon> - Add new location\n\n` +
           `*REMOVE*\n` +
           `- OWNER <phone> - Deactivate owner\n` +
           `- LOCATION <name> - Remove location\n\n` +
           `*LIST*\n` +
           `- OWNERS - Show all owners\n` +
           `- LOCATIONS - Show all locations\n\n` +
           `*SHOW*\n` +
           `- STATS - System statistics\n\n` +
           `*Other*\n` +
           `- HELP - Show this message\n` +
           `- EXIT - Exit admin mode`;
}

const cache = { lastUpdated: 0 };

async function getCachedData(type, fetchFn) {
    if (cache[type] && Date.now() - cache.lastUpdated < 10000) return cache[type];
    const data = await fetchFn();
    cache[type] = data;
    cache.lastUpdated = Date.now();
    return data;
}

function invalidateCache() {
    cache.lastUpdated = 0;
}

module.exports = {
    handle_admin_command,
    _test: { normalizePhone, verifyAdminStatus }
};