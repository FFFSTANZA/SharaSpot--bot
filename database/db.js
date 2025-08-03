require('dotenv').config(); 

const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');
const schema = require('./schema');

// Expose db after connection
let db;

(async () => {
  try {
    // Created a Neon client using the full connection string
    const sql = neon(process.env.DATABASE_URL); // Don't pass extra options here for drizzle-orm

    db = drizzle(sql, { schema });

    // Testing query to make sure the connection is alive
    await db.select().from(schema.users).limit(1);

    console.log('✅ Database connected successfully');
  } catch (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  }
})();

module.exports = {
  get db() {
    if (!db) {
      throw new Error("❌ DB not initialized yet");
    }
    return db;
  }
};
