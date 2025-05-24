const axios = require('axios');
const fs = require('fs');
const path = require('path');

function loadPredefinedLocations() {
    try {
        const filePath = path.join(__dirname, '../data/predefinedLocations.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            const locations = JSON.parse(data);
            
            // Convert to the format used in the application
            const formattedLocations = {};
            locations.forEach(loc => {
                formattedLocations[loc.name.toLowerCase()] = {
                    lat: loc.latitude,
                    lon: loc.longitude
                };
            });
            return formattedLocations;
        }
    } catch (error) {
        console.error("Error loading predefined locations:", error);
    }
    
    // Return default locations if file doesn't exist or has errors
    return {
        "bus stand": { lat: 9.4758, lon: 77.8033 },
        "sivakasi railway station": { lat: 9.4707, lon: 77.8079 },
        "sivakasi main road": { lat: 9.4743, lon: 77.8012 }
    };
}

const predefinedLocations = loadPredefinedLocations();

async function resolveTextLocation(query) {
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');
    console.log(`Received query: "${query}"`);

    if (predefinedLocations[normalizedQuery]) {
        const locationData = predefinedLocations[normalizedQuery];
        console.log(`✅ Predefined location resolved for query "${query}":`, locationData);
        return locationData;
    }
    
    // Try to find partial matches in predefined locations
    for (const [key, location] of Object.entries(predefinedLocations)) {
        if (normalizedQuery.includes(key) || key.includes(normalizedQuery)) {
            console.log(`✅ Partial match found for "${query}" with "${key}":`, location);
            return location;
        }
    }
    
    const apiKey = '5b3ce3597851110001cf62489574382a0ad9442cacc6d12d5564db39';
    const bbox = [77.75, 9.40, 77.85, 9.50]; // [min_lon, min_lat, max_lon, max_lat]
    const url = `https://api.openrouteservice.org/geocode/search?api_key=${apiKey}&text=${encodeURIComponent(query)}&boundary.rect=${bbox.join(',')}&size=1`;

    try {
        const res = await axios.get(url);

        if (res.data && res.data.features && res.data.features.length > 0) {
            const place = res.data.features[0];
            const locationData = {
                name: place.properties.label,
                lat: place.geometry.coordinates[1],
                lon: place.geometry.coordinates[0]
            };
            console.log(`✅ Location resolved for query "${query}":`, locationData);
            return locationData;
        } else {
            console.log(`⚠️ No location found for query: "${query}"`);
            return null;
        }
    } catch (err) {
        console.error(`❌ Error resolving location for query "${query}":`, err.message || err);
        return null;
    }
}

module.exports = {
    resolveTextLocation
};