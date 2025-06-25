const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Simple fuzzy matching function
function fuzzyMatch(input, target, threshold = 0.6) {
    const inputLower = input.toLowerCase();
    const targetLower = target.toLowerCase();
    
    // Exact match
    if (inputLower === targetLower) return 1;
    
    // Contains match
    if (targetLower.includes(inputLower) || inputLower.includes(targetLower)) {
        return 0.8;
    }
    
    // Levenshtein distance based similarity
    const distance = levenshteinDistance(inputLower, targetLower);
    const maxLength = Math.max(inputLower.length, targetLower.length);
    const similarity = 1 - (distance / maxLength);
    
    return similarity >= threshold ? similarity : 0;
}

function levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
}

function loadPredefinedLocations() {
    try {
        const filePath = path.join(__dirname, '../data/predefinedLocations.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("Error loading predefined locations:", error);
    }
    return [];
}

async function resolveTextLocation(locationText) {
    try {
        // First, try fuzzy matching with predefined locations
        const predefinedLocations = loadPredefinedLocations();
        let bestMatch = null;
        let bestScore = 0;
        
        for (const location of predefinedLocations) {
            const score = fuzzyMatch(locationText, location.name);
            if (score > bestScore && score > 0.6) {
                bestScore = score;
                bestMatch = location;
            }
        }
        
        if (bestMatch) {
            console.log(`Found predefined location: ${bestMatch.name} (score: ${bestScore})`);
            return {
                lat: bestMatch.latitude,
                lon: bestMatch.longitude,
                name: bestMatch.name
            };
        }
        
        // If no predefined location matches, try OpenRouteService
        const apiKey = process.env.OPENROUTE_API_KEY;
        if (!apiKey) {
            console.error('OpenRouteService API key not found');
            return null;
        }
        
        const url = `https://api.openrouteservice.org/geocode/search?api_key=${apiKey}&text=${encodeURIComponent(locationText)}&boundary.country=IN&size=1`;
        
        const response = await axios.get(url);
        
        if (response.data.features && response.data.features.length > 0) {
            const location = response.data.features[0];
            const coordinates = location.geometry.coordinates;
            
            return {
                lat: coordinates[1],
                lon: coordinates[0],
                name: location.properties.label
            };
        }
        
        return null;
    } catch (error) {
        console.error('Location resolution error:', error);
        return null;
    }
}

module.exports = { resolveTextLocation };