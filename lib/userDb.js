const { eq } = require('drizzle-orm');
const { db } = require('../database/db');
const { users } = require('../database/schema');
const { normalizePhone } = require('../utils/normalizePhone');


// GET USER BY NUMBER

async function get_user_by_number(number) {
  if (!number) {
    console.warn('get_user_by_number: No number provided');
    return null;
  }

  const numStr = normalizePhone(number.toString());
  try {
    const [user] = await db.select().from(users).where(eq(users.number, numStr)).limit(1);
    if (!user) {
      console.warn(`User with number ${numStr} not found`);
      return null;
    }

    console.log(`Found user by number ${numStr}: ${user.id}`);
    return user;
  } catch (error) {
    console.error('Error getting user by number:', {
      number: numStr,
      error: error.message
    });
    return null;
  }
}


// GET USER BY ID

async function get_user_by_id(id) {
  if (!id) return null;
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id.toString())).limit(1);
    return user ? { ...user, number: normalizePhone(user.number) } : null;
  } catch (error) {
    console.error('Error getting user by ID:', {
      userId: id,
      error: error.message,
      stack: error.stack
    });
    return null;
  }
}


// CREATE USER

async function create_user(data) {
  if (!data?.number) throw new Error('create_user: Missing phone number');

  const numStr = normalizePhone(data.number.toString());

  console.log(`Creating user with number: ${numStr}`);

  try {
    const existing = await get_user_by_number(numStr);
    if (existing) {
      console.log(`User already exists - ID: ${existing.id}`);
      return existing;
    }

    const userId = data.id || generate_id();
    const [newUser] = await db.insert(users).values({
      id: userId,
      number: numStr,
      name: data.name || `User_${numStr.slice(-4)}`,
      prev_msg: data.prev_msg || [],
      ai_msg: data.ai_msg || [],
      isAdmin: data.is_admin || false,
      currentMode: data.current_mode || 'AI',
      bookingData: data.booking_data || null,
      lastInteraction: new Date(),
      createdAt: new Date()
    }).returning();

    console.log(`Successfully created user ${userId}`);
    return newUser;
  } catch (error) {
    console.error('Failed to create user:', {
      number: numStr,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}


// UPDATE USER

async function update_user(identifier, updates) {
  try {
    if (!updates || Object.keys(updates).length === 0) {
      throw new Error('update_user: No fields provided to update');
    }

    let user;
    if (typeof identifier === 'string' && identifier.match(/^\d{10,15}$/)) {
      user = await get_user_by_number(identifier);
    } else {
      user = await get_user_by_id(identifier);
    }

    if (!user) throw new Error('User not found');

    const updateFields = {
      ...updates,
      last_interaction: new Date() // ✅ use snake_case here
    };

    const [updatedUser] = await db.update(users)
      .set(updateFields)
      .where(eq(users.id, user.id))
      .returning();

    return updatedUser;
  } catch (error) {
    console.error('Failed to update user:', {
      identifier,
      updates,
      error: error.message
    });
    throw error;
  }
}



// PUSH AI MESSAGE

async function push_ai_msg(identifier, text) {
  if (!identifier || !text) {
    console.error('push_ai_msg: Missing parameters', {
      identifier,
      text: text?.substring(0, 50)
    });
    return false;
  }

  try {
    let user;
    if (typeof identifier === 'string' && identifier.match(/^\d{10,15}$/)) {
      user = await get_user_by_number(identifier);
    } else {
      user = await get_user_by_id(identifier);
    }

    if (!user) {
      console.error('push_ai_msg: User not found', { identifier });
      return false;
    }

    const currentMessages = Array.isArray(user.ai_msg) ? user.ai_msg : [];
    const updatedMessages = [...currentMessages, text];

    const [result] = await db.update(users)
      .set({
        ai_msg: updatedMessages,
        lastInteraction: new Date()
      })
      .where(eq(users.id, user.id))
      .returning();

    if (!result) throw new Error('Database update failed - no rows affected');

    console.log(`AI message pushed successfully to user ${user.id}`);
    return true;
  } catch (error) {
    console.error('push_ai_msg failed:', {
      identifier,
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}


// DELETE USER

async function delete_user_by_id(id) {
  try {
    const [deleted_user] = await db.delete(users).where(eq(users.id, id)).returning();
    return deleted_user;
  } catch (error) {
    console.error('Error deleting user:', error.message);
    throw error;
  }
}


// GET ALL USERS

async function get_all_users() {
  try {
    return await db.select().from(users);
  } catch (error) {
    console.error('Error getting all users:', error.message);
    return [];
  }
}


// CHECK ADMIN STATUS

async function is_user_admin(identifier) {
  try {
    let user = await get_user_by_number(identifier);
    if (!user) user = await get_user_by_id(identifier);
    return !!user?.isAdmin;
  } catch (error) {
    console.error('Error checking admin status:', error.message);
    return false;
  }
}


// HELPER FUNCTION

function generate_id() {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}


module.exports = {
  get_user_by_number,
  get_user_by_id,
  create_user,
  update_user,
  delete_user_by_id,
  push_ai_msg,
  get_all_users,
  is_user_admin
};
