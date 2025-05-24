const axios = require('axios');
require('dotenv').config(); // To load from .env

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function sendWhatsAppMessage(to, message) {
    try {
        const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;

        const payload = {
            messaging_product: 'whatsapp',
            to,
            text: { body: message },
        };

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
        });

        console.log('✅ Message sent:', response.data);
    } catch (error) {
        console.error('❌ Failed to send message:', error.response?.data || error.message);
    }
}

module.exports = { sendWhatsAppMessage };
