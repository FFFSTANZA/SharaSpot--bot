const express = require('express');
const router = express.Router();
const { getUserMode, setUserMode, getUserBooking, check_and_switch_to_owner_mode } = require('../sessions/sessionManager');
const { getAIResponse } = require('../services/aiService');
const { sendWhatsAppMessage, sendTyping } = require('../services/whatsappService');
const {
    handleBooking,
    handle_owner_commands,
    updateOwnerLocationFlow,
    handle_admin_command,
    getUserBookingStatus,

} = require('../controllers/bookingController');
const { create_user, get_user_by_id, get_user_by_number,  push_ai_msg, update_user} = require('../lib/userDb'); // adjust path
const { eq } = require('drizzle-orm');
const {getOwnerByPhone} =require('../lib/ownerDb')
// routes/webhook.js
const { normalizePhone} = require('../utils/normalizePhone'); // Ensure// At the top
const createDbConnection = require('../database/connect');

// In your handler
async function handleIncomingMessage(req, res) {
    try {
        const db = await createDbConnection();
    } catch (error) {
        console.error('Critical error:', error);
        res.status(500).send('Server error');
    }
}





function buildResponseMessage(mode, message) {
    // Unified mode indicator with emojis
    if (mode === "AD") {
        return message
    }
    const prefix = mode === 'PARKING' ? '🅿️ Parking Mode' :
        (mode === 'OWNER' ? '🅿️ Owner Mode' : '💬 Shara AI');
    return `${prefix}: ${message}`;
}

const VERIFY_TOKEN = 'sharaspot';


const Ads_arr = [
  {
    title: "🎨 40% Off at Etsy",
    desc: `Use code *WRIXTAN40* to save 40% on your favorite handmade goods.\nCopy and paste this code at Etsy.`,
    imageUrl: "https://via.placeholder.com/300x200?text=Etsy+40%25+Off",
    link: "https://www.etsy.com/"
  },
  {
    title: "🎉 15% Off Storewide at Crunchyroll",
    desc: `Code *CR15* copied to your clipboard!\nEnjoy 15% off on all anime merchandise and subscriptions.`,
    imageUrl: "https://via.placeholder.com/300x200?text=Crunchyroll+15%25+Off",
    link: "https://www.crunchyroll.com/"
  },
  {
    title: "🏷️ $1 Off Gold Star Executive Membership at Costco",
    desc: `Code *CJRTLMN* copied to your clipboard!\nSave $1 on your next Costco membership.`,
    imageUrl: "https://via.placeholder.com/300x200?text=Costco+Deal",
    link: "https://www.costco.com/"
  },
  {
    title: "🛏️ $117 Off Queen Deluxe Mattress on Amazon",
    desc: `Use code *GROKC5Q5* and save $117 on a 10-inch Hybrid Queen Mattress.\nCode copied to your clipboard!`,
    imageUrl: "https://via.placeholder.com/300x200?text=Amazon+Mattress+Deal",
    link: "https://www.amazon.com/"
  },
  {
    title: "🎁 Free Canva Credit",
    desc: `Get 1 Canva credit as a free gift when you sign up.\nUse code *INCENTIVISED-REFERRAL* — copied to your clipboard!`,
    imageUrl: "https://via.placeholder.com/300x200?text=Canva+Free+Credit",
    link: "https://www.canva.com/"
  }
];


router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook verified successfully!');
            return res.status(200).send(challenge);
        } else {
            console.log('❌ Webhook verification failed: wrong token.');
            return res.sendStatus(403);
        }
    } else {
        return res.sendStatus(400);
    }
});



async function handleUser(req) {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    
    if (!value?.contacts?.[0]?.wa_id) {
        console.log("No contact info - ignoring status update");
        return null; // Return null instead of undefined
    }

    const phoneNumber = value.contacts[0].wa_id;
    const message = value.messages?.[0]?.text?.body || '';

    try {
        let user = await get_user_by_number(phoneNumber);
        const updates = {};

        if (message) {
            const prevMessages = user?.prev_msg || [];
            if (!prevMessages.includes(message)) {
                updates.prev_msg = [...prevMessages, message];
                updates.lastInteraction = new Date();
            }
        }

        if (Object.keys(updates).length > 0) {
            if (user) {
                user = await update_user(user.id, updates);
                console.log(`User ${user.id} updated`);
            } else {
                user = await create_user({
                    number: phoneNumber,
                    prev_msg: [message],
                    lastInteraction: new Date()
                });
                console.log(`New user created: ${user.id}`);
            }
        }
        
        return user; // Return the user object for use in the main handler
    } catch (error) {
        console.error("User handling error:", error.message);
        return null;
    }
}


router.post('/', async (req, res) => {
    try {
        const user = await handleUser(req);
        
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const messageObj = value?.messages?.[0];
        
        if (!messageObj || !user) {
            return res.sendStatus(200);
        }

        const phoneNumber = messageObj.from;
        const userId = user.id;
        const incomingMessage = (messageObj.text?.body || '').trim();
        const lowerCaseMessage = incomingMessage.toLowerCase();

       if (lowerCaseMessage === 'owner' || lowerCaseMessage === 'owner mode') {
    const ownerCheck = await check_and_switch_to_owner_mode(userId);
    const responseMessage = ownerCheck.isOwner 
        ? ownerCheck.message 
        : "🚫 You're not registered as a parking owner. Contact admin if this is incorrect.";
    
    await sendWhatsAppMessage(phoneNumber, responseMessage);
    return res.sendStatus(200);
    }


        // Auto-switch existing owners
        const ownerCheck = await check_and_switch_to_owner_mode(userId);

    if (ownerCheck.isOwner) {
    if (ownerCheck.justSwitched && !['hi', 'talk', 'help'].includes(lowerCaseMessage)) {
        const openSlots = ownerCheck.ownerData.slots?.filter(slot => slot.state === 'available')?.length || 0;
        const totalSlots = ownerCheck.ownerData.slots?.length || 0;

        const welcomeMsg = `🅿️ OWNER MODE ACTIVATED\n\n` +
                           `Welcome ${ownerCheck.ownerData.name || ''}!\n` +
                           `Status: ${ownerCheck.ownerData.is_active ? '🟢 ACTIVE' : '🔴 INACTIVE'}\n` +
                           `Slots: ${openSlots}/${totalSlots} available\n` +
                           `Location: ${ownerCheck.ownerData.location || 'Not set'}`;

        await sendWhatsAppMessage(phoneNumber, welcomeMsg);
    }

    const ownerReply = await handle_owner_commands(userId, incomingMessage);
    if (ownerReply) {
        await sendWhatsAppMessage(phoneNumber, ownerReply);
    }

    return res.sendStatus(200);
}


        // Admin commands
    if (
    lowerCaseMessage.startsWith('admin') ||
    lowerCaseMessage.includes('add owner') ||
    lowerCaseMessage.includes('remove owner') ||
    lowerCaseMessage.includes('list owners') ||
    lowerCaseMessage.includes('add location') ||
    lowerCaseMessage.includes('remove location') ||
    lowerCaseMessage.includes('list locations') ||
    lowerCaseMessage.includes('show stats')
) {
    const adminResponse = await handle_admin_command(incomingMessage, phoneNumber);
    if (adminResponse) {
        await sendWhatsAppMessage(phoneNumber, adminResponse);
        return res.sendStatus(200);
    }
}


        // Mode switching
        if (lowerCaseMessage === 'hi' || lowerCaseMessage === 'talk') {
            await setUserMode(userId, 'AI');
            const reply1 = buildResponseMessage(
               'AI',
               `Welcome to SharaSpot!\nWherever you drive, Park Nearby.\n\nType "Book" to reserve your parking space,\nor say "Help" for guidance,\nor ask Shara AI anything for more info.\n\nPowered by Folonite.`
            );


            const randomNum = Math.floor(Math.random() * 3) + 1;
            const ad_title = Ads_arr[randomNum].title;
            const ad_desc = Ads_arr[randomNum].desc;
            const reply2 = buildResponseMessage(
                'AD',
                `🎟️ ${ad_title}: ${ad_desc}`
            );

            await sendWhatsAppMessage(phoneNumber, reply1);
            await sendWhatsAppMessage(phoneNumber, reply2);
            return res.sendStatus(200);
        }

        if (lowerCaseMessage === 'book') {
            await setUserMode(userId, 'PARKING');
            await sendWhatsAppMessage(phoneNumber, buildResponseMessage('PARKING', `You are now in Parking Mode. Let's start your reservation. \nEnter your name:`));
            return res.sendStatus(200);
        }

        // Status command
        if (lowerCaseMessage === 'status') {
            const currentMode = await getUserMode(userId);
            if (currentMode === 'OWNER') {
                const ownerReply = await handle_owner_commands(userId, lowerCaseMessage);
                await sendWhatsAppMessage(phoneNumber, ownerReply);
            } else {
                const statusMessage = await getUserBookingStatus(userId);
                await sendWhatsAppMessage(phoneNumber, buildResponseMessage(currentMode, statusMessage));
            }
            return res.sendStatus(200);
        }

        // Help command
        if (lowerCaseMessage === 'help') {
            const currentMode = await getUserMode(userId);
            let helpText = '';

            if (currentMode === 'OWNER') {
                helpText = `Commands:\n- 1: Set Active\n- 0: Set Inactive\n- 2: Accept Current Booking\n- 3: Update Location\n- status: View Your Status\n- hi/talk: Switch to AI Mode`;
            } else if (currentMode === 'PARKING') {
                helpText = `Commands:\n- hi/talk: Switch to AI Mode\n- status: Check booking status\n- help: Show this menu`;
            } else {
                helpText = `Commands:\n- book: Start a parking reservation\n- status: Check booking status\n- help: Show this menu`;
            }

            await sendWhatsAppMessage(phoneNumber, buildResponseMessage(currentMode, helpText));
            return res.sendStatus(200);
        }

        // Process messages based on current mode
        const currentMode = await getUserMode(userId);
        const messageId = messageObj.id;

        if (currentMode === 'AI') {
    try {
        await sendTyping(messageId);
        const aiReply = await getAIResponse(incomingMessage, userId); 
        
        // Push both user and AI messages to history
        await push_ai_msg(userId, aiReply); 
        await update_user(userId, {
            prev_msg: [...(user.prev_msg || []), incomingMessage],
            lastInteraction: new Date()
        });

        await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', aiReply));
    } catch (error) {
        console.error('AI conversation error:', {
            userId,
            phoneNumber,
            error: error.message
        });
        await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', 'Hmm, something went wrong while I was thinking 😅. Try again later!'));
    }
    return res.sendStatus(200);
}
        else if (currentMode === 'PARKING') {
            try {
                let userInput = '';
                if (messageObj.type === 'text') {
                    userInput = messageObj.text.body;
                } else if (messageObj.type === 'location') {
                    const loc = messageObj.location;
                    userInput = `LOCATION: lat=${loc.latitude}, lon=${loc.longitude}, name=${loc.name || 'Unnamed Location'}, address=${loc.address || 'No Address'}`;
                } else {
                    userInput = '[Unsupported message type]';
                }
                const bookingReply = await handleBooking(userId, userInput);
                if (bookingReply) {
                    await sendWhatsAppMessage(phoneNumber, buildResponseMessage('PARKING', bookingReply));
                }
            } catch (error) {
                console.error('Booking error:', error);
                await sendWhatsAppMessage(phoneNumber, buildResponseMessage('PARKING', 'We hit a snag with your booking 😔. Please try again shortly.'));
            }
            return res.sendStatus(200);
        }
        else if (currentMode === 'OWNER') {
            let ownerReply;
            if (messageObj.type === 'location') {
                const loc = messageObj.location;
                const locationInput = `LOCATION: lat=${loc.latitude}, lon=${loc.longitude}, name=${loc.name || 'Unnamed Location'}, address=${loc.address || 'No Address'}`;
                ownerReply = await updateOwnerLocationFlow(userId, locationInput);
            } else if (lowerCaseMessage === '3') {
                ownerReply = await handle_owner_commands(userId, lowerCaseMessage);
            } else {
                ownerReply = await handle_owner_commands(userId, incomingMessage);
            }
            await sendWhatsAppMessage(phoneNumber, ownerReply);
            return res.sendStatus(200);
        }

        // Default fallback
        await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', `I didn't get that. Please type 'help' to see available commands.`));
        return res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        return res.sendStatus(500);
    }
});

module.exports = router;









