const { eq } = require('drizzle-orm');
const { db } = require('../database/db');
const { predefinedLocations } = require('../database/schema');


// Get all users
async function getAllLocation() {
  const result = await db.select().from(predefinedLocations);
  return result;
}

// Get user by uniqueId
async function getLocationByname(name) {
  const result = await db
    .select()
    .from(predefinedLocations)
    .where(eq(predefinedLocations.name, name))
    .limit(1);

  return result[0] || null;
}

// create location

async function createLocation(data) {
  
  const newLocation = await db.insert(predefinedLocations).values({
   name: data.name,
   latitude: data.latitude,
   longitude: data.longitude
  }).returning()
  return newLocation[0];

}



module.exports = {
getAllLocation,
getLocationByname,
createLocation
};
