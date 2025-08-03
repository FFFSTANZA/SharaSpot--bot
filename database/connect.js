const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');
const schema = require('./schema');
const { configDotenv } = require('dotenv');
const retry = require('async-retry');

configDotenv();

async function createDbConnection() {
    return await retry(
        async (bail) => {
            try {
                const sql = neon(process.env.DATABASE_URL, {
                    fetchOptions: { 
                        keepalive: true,
                        timeout: 10000 
                    }
                });
                const db = drizzle(sql, { schema });
                // Test connection
                await db.select().from(schema.users).limit(1);
                return db;
            } catch (error) {
                console.error('Database connection failed, retrying...', error);
                throw error;
            }
        },
        {
            retries: 5,
            minTimeout: 1000,
            maxTimeout: 5000
        }
    );
}

module.exports = createDbConnection;




