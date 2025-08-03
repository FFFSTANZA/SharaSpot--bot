const { db } = require('../database/db');
const { eq, and } = require('drizzle-orm');
const {
  owners,
  slots,
  ownerVehicleTypes
} = require('../database/schema');
const { get_user_by_id } = require('../lib/userDb');
const { getOwnerByPhone } = require('../lib/ownerDb');
const { normalizePhone } = require('../utils/normalizePhone');

const sessions = {};

// Helper to resolve session ID (based on normalized phone number)
async function getSessionId(userId) {
  const user = await get_user_by_id(userId);
  return user?.number ? normalizePhone(user.number) : null;
}

async function getUserMode(userId) {
  const id = await getSessionId(userId);
  return sessions[id]?.mode || 'AI';
}

async function setUserMode(userId, mode) {
  const id = await getSessionId(userId);
  if (!id) return;
  sessions[id] = sessions[id] || {};
  if (sessions[id].mode !== mode) {
    sessions[id].mode = mode;
    sessions[id].justSwitched = true;
  }
}

async function getUserBooking(userId) {
  const id = await getSessionId(userId);
  return sessions[id]?.booking || null;
}

async function setUserBooking(userId, booking) {
  const id = await getSessionId(userId);
  if (!id) return;
  sessions[id] = sessions[id] || {};
  sessions[id].booking = booking;
}

// Preserved existing session keys (pendingAction, mode, etc.)
async function getOwnerData(userId, forceRefresh = false) {
  const id = await getSessionId(userId);
  if (!id) return null;

  if (!forceRefresh && sessions[id]?.ownerData) {
    return sessions[id].ownerData;
  }

  try {
    const [owner] = await db
      .select()
      .from(owners)
      .where(eq(owners.phone_num, id))
      .limit(1);

    if (!owner) return null;

    const ownerId = owner.id;
    const phoneNumber = owner.phone_num;

    const ownerData = await getOwnerByPhone(phoneNumber);
    if (!ownerData) throw new Error('Owner not found');

    const vehicleTypes = await db
      .select()
      .from(ownerVehicleTypes)
      .where(eq(ownerVehicleTypes.owner_id, ownerId));

    const slotList = await db
      .select()
      .from(slots)
      .where(eq(slots.owner_id, ownerId));

    const formatted = {
      ...owner,
      phoneNum: `+${phoneNumber}`,
      vehicleTypes: vehicleTypes.map((v) => v.vehicle_type),
      slots: slotList,
      totalSlots: slotList.length,
      status: owner.is_active ? 'active' : 'inactive'
    };

    sessions[id] = {
      ...sessions[id],  // Preserved any other session data
      ownerData: formatted
    };

    return formatted;
  } catch (err) {
    console.error('getOwnerData error:', err);
    return null;
  }
}

async function addOwner(phone, name = 'New Owner') {
  const id = normalizePhone(phone);
  try {
    const [existing] = await db.select().from(owners).where(eq(owners.phone_num, id)).limit(1);
    if (existing) return { success: false, message: 'Owner already exists' };

    const [newOwner] = await db.insert(owners).values({
      phone_num: id,
      name,
      is_active: false,
      total_slots: 0,
      location: 'Unknown',
      lastUpdated: new Date(),
      created_at: new Date(),
      updated_at: new Date()
    }).returning();

    await db.insert(ownerVehicleTypes).values(
      ['Two-wheeler', '4-seat car', '8-seat car', 'Van'].map((type) => ({
        owner_id: newOwner.id,
        vehicle_type: type
      }))
    );

    return { success: true, owner: newOwner };
  } catch (err) {
    console.error('addOwner error:', err);
    return { success: false, message: 'Database error' };
  }
}

async function setOwnerStatus(userId, status) {
  const id = await getSessionId(userId);
  if (!id) return false;
  try {
    await db.update(owners).set({
      is_active: status === 'active',
      lastUpdated: new Date()
    }).where(eq(owners.phone_num, id));

    if (sessions[id]?.ownerData) {
      sessions[id].ownerData.status = status;
    }
    return true;
  } catch (err) {
    console.error('setOwnerStatus error:', err);
    return false;
  }
}
async function saveOwnerLocation(userId, { lat, lon, text }) {
  const id = await getSessionId(userId);
  if (!id) return false;

  try {
    await db.update(owners)
      .set({
        lat,
        lon,
        location: text,
        last_updated: new Date()
      })
      .where(eq(owners.phone_num, id));

    // Update session cache
    if (sessions[id]?.ownerData) {
      sessions[id].ownerData.lat = lat;
      sessions[id].ownerData.lon = lon;
      sessions[id].ownerData.location = text;
    }

    return true;
  } catch (err) {
    console.error('saveOwnerLocation error:', err);
    return false;
  }
}


async function updateOwnerLocation(userId, textLocation) {
  const id = await getSessionId(userId);
  if (!id) return false;

  const [owner] = await db.select().from(owners).where(eq(owners.phone_num, id)).limit(1);
  if (!owner) return false;

  await db.update(owners)
    .set({ location: textLocation, last_updated: new Date() })
    .where(eq(owners.id, owner.id));

  // Update session cache
  if (sessions[id]?.ownerData) {
    sessions[id].ownerData.location = textLocation;
  }

  return true;
}

// Always update session after changing slots
async function addSlotsToOwner(userId, slotList = []) {
  const id = await getSessionId(userId);
  if (!id) return false;

  try {
    const [owner] = await db
      .select()
      .from(owners)
      .where(eq(owners.phone_num, id))
      .limit(1);

    if (!owner) return false;

    // Delete existing slots
    await db.delete(slots).where(eq(slots.owner_id, owner.id));

    // Format new slots
    const formattedSlots = slotList.map((slot, i) => ({
      owner_id: owner.id,
      index: slot.index ?? i,
      type: slot.type ?? 'Two-wheeler',
      state: slot.state ?? 'available',
      is_occupied: false,
      connected_to: null,
      notes: ''
    }));

    // Insert new slots
    await db.insert(slots).values(formattedSlots);

    // Update total_slots in owners table
    await db
      .update(owners)
      .set({
        total_slots: formattedSlots.length,
        last_updated: new Date()
      })
      .where(eq(owners.id, owner.id));

    // Refresh session
    await getOwnerData(userId, true);

    return true;
  } catch (err) {
    console.error('addSlotsToOwner error:', err);
    return false;
  }
}


async function updateSlotState(userId, slotIndex, state) {
  const id = await getSessionId(userId);
  if (!id) return false;

  try {
    const [owner] = await db.select().from(owners).where(eq(owners.phone_num, id)).limit(1);
    if (!owner) return false;

    await db.update(slots)
      .set({ state, last_status_change: new Date() })
      .where(and(eq(slots.owner_id, owner.id), eq(slots.index, slotIndex)));

    if (sessions[id]?.ownerData?.slots) {
      const slot = sessions[id].ownerData.slots.find(s => s.index === slotIndex);
      if (slot) slot.state = state;
    }

    return true;
  } catch (err) {
    console.error('updateSlotState error:', err);
    return false;
  }
}

async function setPendingAction(userId, action, data = null) {
  const id = await getSessionId(userId);
  if (!id) return;
  sessions[id] = sessions[id] || {};
  sessions[id].pendingAction = action;
  sessions[id].pendingData = data;
}

async function getPendingAction(userId) {
  const id = await getSessionId(userId);
  return sessions[id]?.pendingAction || null;
}

async function check_and_switch_to_owner_mode(userId) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) {
      return {
        isOwner: false,
        message: "❌ No phone number found for your account"
      };
    }

    const phone = normalizePhone(user.number);
    const owner = await getOwnerByPhone(user.number);

    if (!owner) {
      return {
        isOwner: false,
        message: "🚫 You're not registered as a parking owner. Contact admin."
      };
    }

    const id = normalizePhone(user.number);
    const wasOwnerBefore = sessions[id]?.mode === 'OWNER';

    await setUserMode(userId, 'OWNER');
    const ownerData = await getOwnerData(userId, true);

    return {
      isOwner: true,
      justSwitched: !wasOwnerBefore,
      message: !wasOwnerBefore ? `🅿️ Owner Mode Activated for ${owner.name || 'Unknown Owner'}` : null,
      ownerData
    };
  } catch (error) {
    console.error('Owner mode switch error:', error);
    return {
      isOwner: false,
      message: "⚠️ System error checking owner status. Try again later."
    };
  }
}

module.exports = {
  normalizePhone,
  getUserMode,
  setUserMode,
  getUserBooking,
  setUserBooking,
  getOwnerData,
  addOwner,
  setOwnerStatus,
  updateOwnerLocation,
  addSlotsToOwner,
  updateSlotState,
  setPendingAction,
  getPendingAction,
  check_and_switch_to_owner_mode
};
