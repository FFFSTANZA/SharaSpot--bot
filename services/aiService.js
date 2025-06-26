// const axios = require('axios');
const { default: OpenAI } = require('openai');
require('dotenv').config(); // Make sure to install and use dotenv
const fs = require('fs');
const path = './data/users.json'

// const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// async function getAIResponse(userMessage) {
//     const apiUrl = 'https://api.together.xyz/v1/chat/completions';

//     const body = {
//         model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
//         messages: [
//             {
//                 role: 'system',
//                 content: `Shara's Personality: You are Shara, a flirty, witty, and emotionally supportive travel planner AI assistant for SharaSpot.

// Your role is to act as a friendly companion who helps users with travel advice, parking tips, and general conversation in a fun, engaging way.

// Key traits:
// - Supportive and empathetic about travel concerns and parking issues
// - Occasionally flirty but always respectful (light compliments only)
// - Uses emojis naturally but not excessively
// - Speaks in a casual, conversational tone with short to medium length responses
// - Has a sense of humor and can be playful
// - Knows about travel locations in Tamil Nadu, especially Sivakasi and Rajapalayam
// - Never mentions being an AI or having limitations

// When users are frustrated about parking, be understanding and recommend using the booking service by typing "book".

// Remember you are the AI companion mode of SharaSpot, a parking reservation service currently available in Sivakasi and Rajapalayam.`
//             },
//             { role: 'user', content: userMessage }
//         ],
//         max_tokens: 300
//     };

//     try {
//         const response = await axios.post(apiUrl, body, {
//             headers: {
//                 'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
//                 'Content-Type': 'application/json'
//             }
//         });

//         return response.data.choices[0].message.content;
//     } catch (error) {
//         console.error('AI Error:', error.response?.data || error.message);
//         return "Small issue da, server acting up 😅. Try again in a bit!";
//     }
// }

const openai = new OpenAI({
    apiKey: process.env.GEMINI_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});



async function getAIResponse(userMessage, uniqueId) {

    let prevMsg = []
    let aiMsg = []
    const usersData = fs.readFileSync(path, 'utf-8');
    const users = JSON.parse(usersData);
    const user = users.find(u => u.uniqueId === uniqueId);

    try {

        if (user){

            // check if there is user.prevMsg and store the user.prevMsg into the prevMsg array
            if (user.prevMsg){
                prevMsg = user.prevMsg;
            } else {
                console.log("Prev msg was not found 💔")
            }
            // check if there is user.prevMsg and store the user.prevMsg into the prevMsg array
            if (user.aiMsg){
                aiMsg = user.aiMsg;
            } else {
                console.log("Prev msg of ai was not found 💔")
            }

        }

    } catch (error) {
        console.log('Soemthing went wrong!!');
    }

    // system prompt 
    const SYSTEM_PROMPT = `
tionally supportive travel planner AI assistant for SharaSpot.
                
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

Remember you are the AI companion mode of SharaSpot, a parking reservation service currently available in Sivakasi and Rajapalayam.|

here are the previous messages sent by this user take them and give best responses: ${prevMsg}

here are the previous messages sent by you give attention to them and give best responses: ${aiMsg}

also dont respond or answer the previous messages in the current response take them as memory or context focus on the current query 
strictly dont bring or talk about previous chats until and unless user asks or it is needed

example conversation :

user: u can call me amit only and i live in assam
ai: sure i will remember your name! so planning a trip to tamil nadu??
user: what is my name 
ai: you told me before your name is amit am i right?


also when the user asks a question or somehting see the chat history and get ur answer then say it

try to align the chat hisroty using indexes same like prevMsg[0]: userinput and aiMsg[0] = aioutput

`

    const message = [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: userMessage,
        },
    ]

    try {
        const response = await openai.chat.completions.create({
            model: "gemini-2.0-flash",
            response_format: { type: "json_object" },
            messages: message
        });
        const res = response.choices[0].message.content
        const parsed = JSON.parse(res);
        const text = parsed.response;


        // // read the user data
        // const usersData = fs.readFileSync(path, 'utf-8');
        // // find the user
        // const users = JSON.parse(usersData);
        // const user = users.find(u => u.uniqueId === uniqueId);

        if (text === null || text === undefined) {
            return "Small issue da, server acting up 😅. Try again in a bit!";

        } else {
            if (user) {
               // Make sure aiMsg array exists
                if (!Array.isArray(user.aiMsg)) {
                    user.aiMsg = [];
                }

                // Push the new response
                user.aiMsg.push(text);

                // Save the updated users array back to file
                fs.writeFileSync(path, JSON.stringify(users, null, 2), 'utf-8');
            } else {
                console.log("✅💔user not found")
            }
            console.log(`Response 🤖: ${text}`)


            return text
        }
    } catch (error) {
        console.error('AI Error:', error.response?.data || error.message);
        return "Small issue da, server acting up 😅. Try again in a bit!";
    }
}

module.exports = { getAIResponse };