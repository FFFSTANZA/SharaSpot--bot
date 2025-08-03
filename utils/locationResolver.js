const axios = require('axios');
const { getAllLocation } = require('../lib/preDefinedLocDb');
require('dotenv').config();

// Cache configuration
const LOCATION_CACHE_TTL = 3600000; // 1 hour cache
const locationCache = new Map();

// Enhanced fuzzy matching with multiple strategies
function fuzzyMatch(input, target, threshold = 0.7) {
    if (!input || !target) return 0;
    
    const inputLower = input.toLowerCase().trim();
    const targetLower = target.toLowerCase().trim();
    
    // 1. Exact match check
    if (inputLower === targetLower) return 1;
    
    // 2. Tokenized match (split by spaces/special chars)
    const inputTokens = inputLower.split(/[\s,.-]+/);
    const targetTokens = targetLower.split(/[\s,.-]+/);
    
    const commonTokens = inputTokens.filter(token => 
        targetTokens.some(t => t.includes(token) || token.includes(t))
    );
    
    const tokenScore = commonTokens.length / Math.max(inputTokens.length, targetTokens.length);
    if (tokenScore >= 0.8) return tokenScore;
    
    // 3. Levenshtein distance with normalization
    const distance = levenshteinDistance(inputLower, targetLower);
    const maxLength = Math.max(inputLower.length, targetLower.length);
    const similarity = 1 - (distance / maxLength);
    
    // Weighted combination of scores
    const weightedScore = (tokenScore * 0.4) + (similarity * 0.6);
    return weightedScore >= threshold ? weightedScore : 0;
}

// Optimized Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
    if (str1.length === 0) return str2.length;
    if (str2.length === 0) return str1.length;
    
    const matrix = Array(str2.length + 1)
        .fill(null)
        .map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            const cost = str1[i-1] === str2[j-1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i-1] + 1,
                matrix[j-1][i] + 1,
                matrix[j-1][i-1] + cost
            );
        }
    }
    
    return matrix[str2.length][str1.length];
}

async function resolveTextLocation(locationText) {
    if (!locationText?.trim()) return null;
    
    // Check cache first
    const cacheKey = locationText.toLowerCase().trim();
    const cached = locationCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < LOCATION_CACHE_TTL)) {
        return cached.result;
    }
    
    try {
        // 1. Try predefined locations with enhanced matching
        const predefinedLocations = await getAllLocation();
        const bestPredefinedMatch = findBestPredefinedMatch(locationText, predefinedLocations);
        
        if (bestPredefinedMatch) {
            cacheResult(cacheKey, bestPredefinedMatch);
            return bestPredefinedMatch;
        }
        
        // 2. Fallback to OpenRouteService API
        const apiResult = await queryOpenRouteService(locationText);
        if (apiResult) {
            cacheResult(cacheKey, apiResult);
            return apiResult;
        }
        
        return null;
    } catch (error) {
        console.error('📍 Location resolution error:', error.message);
        return null;
    }
}

// Helper functions
function findBestPredefinedMatch(locationText, predefinedLocations) {
    let bestMatch = null;
    let bestScore = 0;
    const threshold = 0.75; // Higher threshold for better accuracy
    
    for (const location of predefinedLocations) {
        // Try matching against both name and alternative names if available
        const scores = [
            fuzzyMatch(locationText, location.name),
            ...(location.aliases || []).map(alias => fuzzyMatch(locationText, alias))
        ];
        
        const currentScore = Math.max(...scores);
        
        if (currentScore > bestScore && currentScore >= threshold) {
            bestScore = currentScore;
            bestMatch = {
                lat: location.latitude,
                lon: location.longitude,
                name: location.name,
                source: 'predefined',
                score: bestScore
            };
        }
    }
    
    if (bestMatch) {
        console.log(`📍 Predefined match: ${bestMatch.name} (score: ${bestScore.toFixed(2)})`);
        return bestMatch;
    }
    return null;
}

async function queryOpenRouteService(locationText) {
    const apiKey = process.env.OPENROUTE_API_KEY || "tgp_v1_Ax7480k6rfnG5mIWcJlr18mLtZPc6HsGh1_E90-NNxc";
    if (!apiKey) {
        console.error('OpenRouteService API key not configured');
        return null;
    }
    
    try {
        const response = await axios.get(
            'https://api.openrouteservice.org/geocode/search', {
                params: {
                    api_key: apiKey,
                    text: locationText,
                    'boundary.country': 'IN',
                    size: 1,
                    layers: 'venue,address' // Focus on more precise results
                },
                timeout: 3000 // 3 second timeout
            }
        );
        
        if (response.data?.features?.length > 0) {
            const feature = response.data.features[0];
            return {
                lat: feature.geometry.coordinates[1],
                lon: feature.geometry.coordinates[0],
                name: feature.properties.label,
                source: 'openrouteservice',
                confidence: feature.properties.confidence
            };
        }
    } catch (error) {
        console.error('OpenRouteService API error:', error.message);
    }
    return null;
}

function cacheResult(key, result) {
    if (result) {
        locationCache.set(key, {
            result: result,
            timestamp: Date.now()
        });
    }
}

module.exports = { 
    resolveTextLocation,
    _test: {
        fuzzyMatch,
        levenshteinDistance
    }
};