const { eq, and } = require('drizzle-orm');
const { db } = require('../database/db');
const { normalizePhone } = require('../utils/normalizePhone');
const { owners, ownerVehicleTypes, vehicleEnum, slots } = require('../database/schema');

//HELPERS

function formatPhoneForDisplay(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `+91${normalized}` : 'undefined';
}

function formatPhoneNumber(rawPhone) {
  if (!rawPhone) return 'undefined';
  return rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
}

// CREATE OWNER IF NOT EXISTS (Missing function)
async function createOwnerIfNotExists(userId) {
  try {
    // Get user by userId to find phone number
    const { get_user_by_id } = require('./userDb');
    const user = await get_user_by_id(userId);
    
    if (!user || !user.number) {
      console.error(`No user or phone number found for userId: ${userId}`);
      return false;
    }

    const normalizedPhone = normalizePhone(user.number);
    if (!normalizedPhone || normalizedPhone.length !== 10) {
      console.error(`Invalid phone number for userId ${userId}: ${user.number}`);
      return false;
    }

    // Check if owner already exists
    const [existing] = await db
      .select()
      .from(owners)
      .where(eq(owners.phone_num, normalizedPhone))
      .limit(1);

    if (existing) {
      console.log(`Owner already exists for phone: ${normalizedPhone}`);
      return true; // Owner exists, return success
    }

    // Create new owner
    const [newOwner] = await db
      .insert(owners)
      .values({
        phone_num: normalizedPhone,
        name: user.name || 'New Owner',
        lat: 0,
        lon: 0,
        is_active: false,
        total_slots: 0,
        location: 'Unknown',
        last_updated: new Date(),
        updated_at: new Date(),
        created_at: new Date()
      })
      .returning();

    // Add default vehicle types
    const defaultVehicleTypes = ['Two-wheeler', '4-seat car', '8-seat car', 'Van'];
    const vehicleTypeInserts = defaultVehicleTypes.map(type => ({
      owner_id: newOwner.id,
      vehicle_type: type
    }));

    await db.insert(ownerVehicleTypes).values(vehicleTypeInserts);

    console.log(`Created new owner for phone: ${normalizedPhone}, ID: ${newOwner.id}`);
    return true;

  } catch (error) {
    console.error('Error in createOwnerIfNotExists:', error);
    return false;
  }
}

//CREATE OWNER

async function createOwner(data) {
  try {
    const phone_num = data.phone_num ?? data.phoneNum;
    const name = data.name ?? '';
    const lat = typeof data.lat === 'number' ? data.lat : 0;
    const lon = typeof data.lon === 'number' ? data.lon : 0;
    const is_active = data.is_active ?? false;
    const total_slots = Number(data.total_slots ?? data.totalSlots) || 0;
    const location = data.location || 'Unknown';

    if (!phone_num) throw new Error('Phone number is required');

    const normalizedPhone = normalizePhone(phone_num);
    if (!normalizedPhone || normalizedPhone.length !== 10) {
      throw new Error('Phone number must be 10 digits after normalization');
    }

    const [existing] = await db
      .select()
      .from(owners)
      .where(eq(owners.phone_num, normalizedPhone))
      .limit(1);

    if (existing) throw new Error('Owner with this phone number already exists');

    const [newOwner] = await db
      .insert(owners)
      .values({
        phone_num: normalizedPhone,
        name,
        lat,
        lon,
        is_active,
        total_slots,
        location,
        last_updated: new Date(),
        updated_at: new Date(),
        created_at: new Date()
      })
      .returning();

    const types = Array.isArray(data.availableVehicleTypes)
      ? data.availableVehicleTypes
      : ['Two-wheeler', '4-seat car', '8-seat car', 'Van'];

    const vehicleTypeInserts = types.map(type => ({
      owner_id: newOwner.id,
      vehicle_type: type
    }));

    if (vehicleTypeInserts.length > 0) {
      await db.insert(ownerVehicleTypes).values(vehicleTypeInserts);
    }

    if (Array.isArray(data.slots) && data.slots.length > 0) {
      await addSlotsToOwner(newOwner.id, data.slots);
    }

    return {
      ...newOwner,
      phoneNum: formatPhoneForDisplay(newOwner.phone_num)
    };
  } catch (error) {
    console.error('❌ Error creating owner:', { input: data, error });
    throw error;
  }
}


//GET OWNER BY PHONE

async function getOwnerByPhone(phoneNum) {
  try {
    if (!phoneNum || typeof phoneNum !== 'string') {
      throw new Error('Phone number must be a non-empty string');
    }

    const normalizedPhone = normalizePhone(phoneNum);
    if (!normalizedPhone || normalizedPhone.length < 10) {
      throw new Error(`Invalid phone number format: ${phoneNum}`);
    }

    const [owner] = await db
      .select()
      .from(owners)
      .where(eq(owners.phone_num, normalizedPhone))
      .limit(1);

    if (!owner) return null;

    const [vehicleTypes, slotList] = await Promise.all([
      db.select().from(ownerVehicleTypes).where(eq(ownerVehicleTypes.owner_id, owner.id)),
      db.select().from(slots).where(eq(slots.owner_id, owner.id))
    ]);

    return {
      ...owner,
      phoneNum: formatPhoneNumber(owner.phone_num),
      vehicleTypes: vehicleTypes.map(v => v.vehicle_type),
      slots: slotList,
      totalSlots: slotList.length
    };
  } catch (error) {
    console.error(`❌ Failed to get owner by phone "${phoneNum}":`, error);
    throw error;
  }
}


// GET FULL OWNER BY ID

async function getOwnerFull(id) {
  try {
    if (!id) throw new Error('No owner ID provided');

    const [owner] = await db.select().from(owners).where(eq(owners.id, id)).limit(1);
    if (!owner) throw new Error(`Owner with ID "${id}" not found`);

    const [vehicleTypes, slotList] = await Promise.all([
      db.select().from(ownerVehicleTypes).where(eq(ownerVehicleTypes.owner_id, id)),
      db.select().from(slots).where(eq(slots.owner_id, id))
    ]);

    return {
      ...owner,
      phoneNum: formatPhoneNumber(owner.phone_num),
      vehicleTypes: vehicleTypes.map(v => v.vehicle_type),
      slots: slotList
    };
  } catch (error) {
    console.error(`❌ Failed to get full owner data with ID "${id}":`, error);
    throw error;
  }
}


// GET ALL OWNERS

async function getAllOwners() {
  try {
    const ownersList = await db.select().from(owners);
    return ownersList.map(owner => ({
      ...owner,
      phoneNum: formatPhoneNumber(owner.phone_num)
    }));
  } catch (error) {
    console.error('❌ Error fetching owners:', error);
    throw error;
  }
}


// UPDATE OWNER SESSION

async function updateOwnerSession(id, updates) {
  try {
    if (!id) throw new Error('No owner ID provided');

    const updatePayload = {
      ...updates,
      updated_at: new Date(),
      last_updated: new Date()
    };

    const [result] = await db
      .update(owners)
      .set(updatePayload)
      .where(eq(owners.id, id))
      .returning();

    if (!result) throw new Error(`Owner with ID "${id}" not found`);

    return result;
  } catch (error) {
    console.error(`❌ Failed to update owner "${id}":`, error);
    throw error;
  }
}


// ADD SLOTS TO OWNER (WITH INDEX CONTROL)

async function addSlotsToOwner(ownerId, slotArray) {
  try {
    if (!ownerId || !Array.isArray(slotArray)) throw new Error('Invalid slot input');

    // Delete existing slots first (for complete replacement)
    await db.delete(slots).where(eq(slots.owner_id, ownerId));

    // Insert new slots
    const newSlotData = slotArray.map((slot) => {
      return {
        id: `${ownerId}-${slot.index}`, // Ensure proper ID format
        owner_id: ownerId,
        index: slot.index,
        type: slot.type ?? 'Two-wheeler',
        state: slot.state ?? 'available',
        is_occupied: slot.state === 'occupied',
        connected_to: slot.connectedTo ?? null,
        notes: slot.notes ?? '',
        created_at: new Date(),
        last_status_change: new Date()
      };
    });

    if (newSlotData.length > 0) {
      await db.insert(slots).values(newSlotData);
    }

    return true;
  } catch (error) {
    console.error(`❌ Failed to add slots to owner "${ownerId}":`, error);
    throw error;
  }
}


// UPDATE SLOT STATE

async function updateSlotState(ownerId, index, updates) {
  try {
    if (!ownerId || index === undefined) throw new Error('Invalid ownerId or index');

    const updateData = {
      ...updates,
      last_status_change: new Date()
    };

    const [updated] = await db
      .update(slots)
      .set(updateData)
      .where(and(eq(slots.owner_id, ownerId), eq(slots.index, index)))
      .returning();

    return updated || null;
  } catch (error) {
    console.error(`❌ Failed to update slot ${index} of owner "${ownerId}":`, error);
    throw error;
  }
}


// DELETE OWNER

async function deleteOwner(id) {
  try {
    await db.delete(slots).where(eq(slots.owner_id, id));
    await db.delete(ownerVehicleTypes).where(eq(ownerVehicleTypes.owner_id, id));
    const [deletedOwner] = await db.delete(owners).where(eq(owners.id, id)).returning();
    return deletedOwner;
  } catch (error) {
    console.error(`❌ Failed to delete owner ${id}:`, error);
    throw error;
  }
}

module.exports = {
  createOwner,
  createOwnerIfNotExists, // Export the missing function
  getAllOwners,
  getOwner: getOwnerFull,
  updateOwnerSession,
  addSlotsToOwner,
  getOwnerByPhone,
  updateSlotState,
  deleteOwner
};