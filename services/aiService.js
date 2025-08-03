const { OpenAI } = require('openai');
require('dotenv').config();
const { get_user_by_id, push_ai_msg } = require('../lib/userDb');

const openai = new OpenAI({
    apiKey: process.env.GEMINI_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    timeout: 5000
});

// Enhanced conversation cache with topic tracking
const conversationCache = new Map();

async function getAIResponse(userMessage, uniqueId) {
    // Get or initialize conversation state
    let conversation = conversationCache.get(uniqueId) || {
        prev_msg: [],
        ai_msg: [],
        lastUpdated: 0,
        context: {
            currentTopic: null,
            userInterests: [],
            mentionedLocations: []
        }
    };

    // Refresh from DB if cache is stale (>5 minutes)
    if (Date.now() - conversation.lastUpdated > 300000) {
        try {
            const user = await get_user_by_id(uniqueId);
            if (user) {
                conversation = {
                    ...conversation,
                    prev_msg: user.prev_msg || [],
                    ai_msg: user.ai_msg || [],
                    lastUpdated: Date.now()
                };
            }
        } catch (error) {
            console.error('Cache refresh error:', error.message);
        }
    }

    // Update conversation context analyzer
    conversation = updateConversationContext(conversation, userMessage);

    // Dynamic system prompt based on context
    const SYSTEM_PROMPT = generateSystemPrompt(conversation, userMessage);

    try {
        // Generate response with context
        const response = await openai.chat.completions.create({
            model: "gemini-2.0-flash",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage }
            ],
            temperature: 0.65, // Balanced creativity
            max_tokens: 200, // Slightly longer for better responses
            top_p: 0.9 // Better diversity
        });

        const aiResponse = response.choices[0]?.message?.content || 
                         "Hmm, my circuits are fuzzy right now 😅 Try again in a bit!";

        // Update conversation in background
        updateConversationInBackground(uniqueId, conversation, userMessage, aiResponse);

        return aiResponse;
    } catch (error) {
        console.error('AI Error:', error.message);
        return getGracefulFallbackResponse(conversation.context);
    }
}

// Context analysis and prompt engineering
function updateConversationContext(conversation, userMessage) {
    const lowerMessage = userMessage.toLowerCase();
    const newContext = { ...conversation.context };

    // Detect topic changes
    if (lowerMessage.includes('park') || lowerMessage.includes('spot')) {
        newContext.currentTopic = 'parking';
    } 
    else if (lowerMessage.includes('travel') || lowerMessage.includes('visit')) {
        newContext.currentTopic = 'travel';
    }
    else if (lowerMessage.includes('food') || lowerMessage.includes('eat')) {
        newContext.currentTopic = 'food';
    }
    else if (lowerMessage.match(/\b(hi|hello|hey)\b/i)) {
        newContext.currentTopic = 'greeting';
    }

    // Detect locations mentioned
    const tamilNaduLocations = ['sivakasi', 'rajapalayam', 'madurai', 'chennai'];
    tamilNaduLocations.forEach(loc => {
        if (lowerMessage.includes(loc) && !newContext.mentionedLocations.includes(loc)) {
            newContext.mentionedLocations.push(loc);
        }
    });

    return {
        ...conversation,
        context: newContext
    };
}

function generateSystemPrompt(conversation, userMessage) {
    const { currentTopic, mentionedLocations } = conversation.context;
    
    const basePrompt = `
# Shara - Your Tamil Nadu Helper

## Core Personality
- Friendly, knowledgeable local guide
- Conversational but professional
- Culturally aware (Tamil culture)
- Helpful for both travel and daily life

## Current Context
${currentTopic ? `📌 Topic: ${currentTopic}\n` : ''}
${mentionedLocations.length ? `📍 Mentioned: ${mentionedLocations.join(', ')}\n` : ''}

## Response Guidelines
1. Be helpful first, then friendly
2. Suggest parking help ONLY when explicitly asked
3. Keep responses concise (1-3 sentences)
4. Use Tamil/English mix naturally (e.g., "Romba nalla irukku!")
5. For travel questions, include both popular and local hidden gems

## Special Knowledge
- Parking in ${mentionedLocations.join(', ') || 'Tamil Nadu'}
- Local eateries, transport, and customs
- Weather and best times to visit
- Cultural norms and etiquette

## Conversation History
${formatConversationHistory(conversation.prev_msg, conversation.ai_msg)}
`;

    // Topic-specific additions
    if (currentTopic === 'parking') {
        return basePrompt + `
When parking is mentioned:
- Briefly confirm understanding
- Offer help only if needed
- Example: "Having trouble parking in ${mentionedLocations[0] || 'the area'}? I can help you find/book a spot if you'd like!"
`;
    }

    return basePrompt;
}

function formatConversationHistory(userMsgs, ai_msgs) {
    return userMsgs.slice(-3).map((msg, i) => 
        `User: ${msg}\nShara: ${ai_msgs[i] || '[No response]'}`
    ).join('\n\n') || 'No recent conversation';
}

async function updateConversationInBackground(uniqueId, conversation, userMessage, aiResponse) {
    try {
        await Promise.all([
            push_ai_msg(uniqueId, userMessage),
            push_ai_msg(uniqueId, aiResponse)
        ]);
        
        conversationCache.set(uniqueId, {
            prev_msg: [...conversation.prev_msg, userMessage],
            ai_msg: [...conversation.ai_msg, aiResponse],
            context: conversation.context,
            lastUpdated: Date.now()
        });
    } catch (error) {
        console.error('Background update error:', error.message);
    }
}

function getGracefulFallbackResponse(context) {
    const fallbacks = [
        "Apologies, I'm having trouble connecting to my knowledge bank. Try again shortly!",
        "Server is taking a tea break ☕ Try again in a few minutes?",
        "My circuits are a bit overloaded right now. What else can I help with?"
    ];
    
    if (context.currentTopic === 'parking') {
        return "Having parking troubles? Our website has real-time availability: sharaspot.com/parking";
    }
    
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

module.exports = { getAIResponse };