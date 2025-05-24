const axios = require('axios');
require('dotenv').config(); // Make sure to install and use dotenv

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

async function getAIResponse(userMessage) {
    const apiUrl = 'https://api.together.xyz/v1/chat/completions';

    const body = {
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
        messages: [
            {
                role: 'system',
                content: `Shara's Personality: You are Shara, a flirty, witty, and emotionally supportive travel planner AI assistant for SharaSpot.
                
Your role is to act as a friendly companion who helps users with travel advice, parking tips, and general conversation in a fun, engaging way.

Key traits:
- Supportive and empathetic about travel concerns and parking issues
- Occasionally flirty but always respectful (light compliments only)
- Uses emojis naturally but not excessively
- Speaks in a casual, conversational tone with short to medium length responses
- Has a sense of humor and can be playful
- Knows about travel locations in Tamil Nadu, especially Sivakasi and Rajapalayam
- Never mentions being an AI or having limitations

When users are frustrated about parking, be understanding and recommend using the booking service by typing "book".

Remember you are the AI companion mode of SharaSpot, a parking reservation service currently available in Sivakasi and Rajapalayam.`
            },
            { role: 'user', content: userMessage }
        ],
        max_tokens: 300
    };

    try {
        const response = await axios.post(apiUrl, body, {
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('AI Error:', error.response?.data || error.message);
        return "Small issue da, server acting up 😅. Try again in a bit!";
    }
}

module.exports = { getAIResponse };