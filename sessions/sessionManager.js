const { db } = require('../database/db');
const { eq, and } = require('drizzle-orm');
const {
  owners,
  slots,
  ownerVehicleTypes
} = require('../database/schema');
const { get_user_by_id } = require('../lib/userDb');
const { getOwnerByPhone, createOwnerIfNotExists } = require('../lib/ownerDb');
const { normalizePhone } = require('../utils/normalizePhone');

const sessions = {};

// Debug helper
function logSession(action, userId, data = {}) {
  console.log(`[SESSION-${action}] userId=${userId}`, data);
  console.log(`[SESSION-STATE] All sessions:`, Object.keys(sessions));
}

async function getUserMode(userId) {
  const mode = sessions[userId]?.mode || 'AI';
  logSession('GET_MODE', userId, { mode });
  return mode;
}

async function setUserMode(userId, mode) {
  if (!userId) return;

  const normalizedMode = mode.toLowerCase() === 'parking' ? 'booking' : mode.toLowerCase();
  
  if (!sessions[userId]) {
    sessions[userId] = {};
  }

  const oldMode = sessions[userId].mode;
  sessions[userId].mode = normalizedMode;

  logSession('SET_MODE', userId, { from: oldMode, to: normalizedMode });

  // Clear booking data when switching AWAY from booking mode
  if (oldMode === 'booking' && normalizedMode !== 'booking') {
    delete sessions[userId].booking;
    logSession('CLEAR_BOOKING', userId);
  }

  // For owner mode, also create phone-based session
  if (normalizedMode === 'owner') {
    try {
      const user = await get_user_by_id(userId);
      if (user?.number) {
        const phoneId = normalizePhone(user.number);
        if (!sessions[phoneId]) {
          sessions[phoneId] = {};
        }
        sessions[phoneId].mode = 'owner';
        sessions[phoneId].userId = userId;
        logSession('OWNER_PHONE_SESSION', userId, { phoneId });
      }
    } catch (error) {
      console.error('Error setting up owner phone session:', error);
    }
  }
}

async function getUserBooking(userId) {
  const booking = sessions[userId]?.booking || null;
  logSession('GET_BOOKING', userId, { 
    hasBooking: !!booking, 
    step: booking?.step,
    sessionExists: !!sessions[userId]
  });
  return booking;
}

async function setUserBooking(userId, booking) {
  if (!userId) {
    console.error('[setUserBooking] No userId provided');
    return;
  }

  if (!sessions[userId]) {
    sessions[userId] = {};
  }

  sessions[userId].booking = booking;
  sessions[userId].mode = 'booking';

  logSession('SET_BOOKING', userId, { 
    step: booking?.step, 
    name: booking?.name 
  });
}

async function clearBookingSession(userId) {
  logSession('CLEAR_SESSION', userId);
  
  if (sessions[userId]) {
    delete sessions[userId].booking;
    if (sessions[userId].mode === 'booking') {
      sessions[userId].mode = 'AI';
    }
  }
}

// Owner-related functions
async function getOwnerData(userId, forceRefresh = false) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) return null;
    
    const phoneId = normalizePhone(user.number);
    
    if (!forceRefresh && sessions[phoneId]?.ownerData) {
      return sessions[phoneId].ownerData;
    }

    const [owner] = await db
      .select()
      .from(owners)
      .where(eq(owners.phone_num, phoneId))
      .limit(1);

    if (!owner) return null;

    const vehicleTypes = await db
      .select()
      .from(ownerVehicleTypes)
      .where(eq(ownerVehicleTypes.owner_id, owner.id));

    const slotList = await db
      .select()
      .from(slots)
      .where(eq(slots.owner_id, owner.id));

    const formatted = {
      ...owner,
      phoneNum: `+91${phoneId}`,
      vehicleTypes: vehicleTypes.map((v) => v.vehicle_type),
      slots: slotList,
      totalSlots: slotList.length,
      status: owner.is_active ? 'active' : 'inactive'
    };

    if (!sessions[phoneId]) sessions[phoneId] = {};
    sessions[phoneId].ownerData = formatted;

    return formatted;
  } catch (err) {
    console.error('getOwnerData error:', err);
    return null;
  }
}

async function setOwnerStatus(userId, isActive) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) return false;
    
    const phoneId = normalizePhone(user.number);
    
    const [owner] = await db.select().from(owners).where(eq(owners.phone_num, phoneId)).limit(1);
    if (!owner) return false;

    await db.update(owners).set({
      is_active: isActive,
      last_updated: new Date()
    }).where(eq(owners.id, owner.id));

    if (sessions[phoneId]?.ownerData) {
      sessions[phoneId].ownerData.is_active = isActive;
      sessions[phoneId].ownerData.status = isActive ? 'active' : 'inactive';
    }
    
    return true;
  } catch (err) {
    console.error('setOwnerStatus error:', err);
    return false;
  }
}

async function saveOwnerLocation(userId, { lat, lon, text }) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) return false;
    
    const phoneId = normalizePhone(user.number);
    
    const [owner] = await db.select().from(owners).where(eq(owners.phone_num, phoneId)).limit(1);
    if (!owner) return false;

    await db.update(owners)
      .set({
        lat,
        lon,
        location: text,
        last_updated: new Date()
      })
      .where(eq(owners.id, owner.id));

    if (sessions[phoneId]?.ownerData) {
      sessions[phoneId].ownerData.lat = lat;
      sessions[phoneId].ownerData.lon = lon;
      sessions[phoneId].ownerData.location = text;
    }

    return true;
  } catch (err) {
    console.error('saveOwnerLocation error:', err);
    return false;
  }
}

async function updateOwnerLocation(userId, textLocation) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) return false;
    
    const phoneId = normalizePhone(user.number);
    
    const [owner] = await db.select().from(owners).where(eq(owners.phone_num, phoneId)).limit(1);
    if (!owner) return false;

    await db.update(owners)
      .set({ location: textLocation, last_updated: new Date() })
      .where(eq(owners.id, owner.id));

    if (sessions[phoneId]?.ownerData) {
      sessions[phoneId].ownerData.location = textLocation;
    }

    return true;
  } catch (err) {
    console.error('updateOwnerLocation error:', err);
    return false;
  }
}

async function addSlotsToOwner(userId, slotArray) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) return false;
    
    const phoneId = normalizePhone(user.number);
    
    const [owner] = await db.select().from(owners).where(eq(owners.phone_num, phoneId)).limit(1);
    if (!owner) return false;

    const ownerId = owner.id;

    await db.delete(slots).where(eq(slots.owner_id, ownerId));

    if (Array.isArray(slotArray) && slotArray.length > 0) {
      const newSlotData = slotArray.map((slot) => ({
        id: `${ownerId}-${slot.index}`,
        owner_id: ownerId,
        index: slot.index,
        type: slot.type ?? 'Two-wheeler',
        state: slot.state ?? 'available',
        is_occupied: slot.state === 'occupied',
        connected_to: slot.connectedTo ?? null,
        notes: slot.notes ?? '',
        created_at: new Date(),
        last_status_change: new Date()
      }));

      await db.insert(slots).values(newSlotData);
    }

    await db.update(owners)
      .set({ 
        total_slots: slotArray.length, 
        last_updated: new Date() 
      })
      .where(eq(owners.id, ownerId));

    if (sessions[phoneId]?.ownerData) {
      delete sessions[phoneId].ownerData;
    }

    return true;
  } catch (error) {
    console.error(`Failed to add slots to owner "${userId}":`, error);
    return false;
  }
}

async function updateSlotState(userId, slotIndex, state) {
  try {
    const user = await get_user_by_id(userId);
    if (!user?.number) return false;
    
    const phoneId = normalizePhone(user.number);
    
    const [owner] = await db.select().from(owners).where(eq(owners.phone_num, phoneId)).limit(1);
    if (!owner) return false;

    const [updated] = await db.update(slots)
      .set({ 
        state, 
        is_occupied: state === 'occupied',
        last_status_change: new Date() 
      })
      .where(and(eq(slots.owner_id, owner.id), eq(slots.index, slotIndex)))
      .returning();

    if (sessions[phoneId]?.ownerData?.slots) {
      const slot = sessions[phoneId].ownerData.slots.find(s => s.index === slotIndex);
      if (slot) {
        slot.state = state;
        slot.is_occupied = state === 'occupied';
      }
    }

    return !!updated;
  } catch (err) {
    console.error('updateSlotState error:', err);
    return false;
  }
}

async function setPendingAction(userId, action, data = null) {
  if (!sessions[userId]) sessions[userId] = {};
  sessions[userId].pendingAction = action;
  sessions[userId].pendingData = data;
}

async function getPendingAction(userId) {
  return sessions[userId]?.pendingAction || null;
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

    const owner = await getOwnerByPhone(user.number);
    if (!owner) {
      return {
        isOwner: false,
        message: "🚫 You're not registered as a parking owner. Contact admin."
      };
    }

    const wasOwnerBefore = sessions[userId]?.mode === 'owner';

    await setUserMode(userId, 'owner');
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

async function markSlotBooked(ownerId, slotIndex) {
  try {
    const [updated] = await db
      .update(slots)
      .set({
        state: 'occupied',
        is_occupied: true,
        last_status_change: new Date()
      })
      .where(and(
        eq(slots.owner_id, ownerId),
        eq(slots.index, slotIndex)
      ))
      .returning();

    const [owner] = await db.select().from(owners).where(eq(owners.id, ownerId)).limit(1);
    if (owner) {
      const phoneId = owner.phone_num;
      if (sessions[phoneId]?.ownerData?.slots) {
        const slot = sessions[phoneId].ownerData.slots.find(s => s.index === slotIndex);
        if (slot) {
          slot.state = 'occupied';
          slot.is_occupied = true;
        }
      }
    }

    return !!updated;
  } catch (err) {
    console.error('markSlotBooked error:', err);
    return false;
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
      last_updated: new Date(),
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

function debugSession(userId) {
  console.log(`=== DEBUG SESSION ${userId} ===`);
  console.log('Direct session:', sessions[userId]);
  console.log('All session keys:', Object.keys(sessions));
  console.log('Total sessions:', Object.keys(sessions).length);
  console.log('================================');
}

module.exports = {
  getUserMode,
  setUserMode,
  getUserBooking,
  setUserBooking,
  clearBookingSession,
  getOwnerData,
  addOwner,
  setOwnerStatus,
  updateOwnerLocation,
  addSlotsToOwner,
  updateSlotState,
  setPendingAction,
  getPendingAction,
  check_and_switch_to_owner_mode,
  markSlotBooked,
  saveOwnerLocation,
  createOwnerIfNotExists,
  debugSession
};