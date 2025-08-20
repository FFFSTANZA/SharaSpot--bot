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
    cancelUserBooking,
    hasActiveBooking
} = require('../controllers/bookingController');
const { create_user, get_user_by_id, get_user_by_number, push_ai_msg, update_user } = require('../lib/userDb');
const { eq } = require('drizzle-orm');
const { getOwnerByPhone } = require('../lib/ownerDb');
const { normalizePhone } = require('../utils/normalizePhone');

const VERIFY_TOKEN = 'sharaspot';

const Ads_arr = [
  {
    title: "🛍️ 40% Off at Etsy",
    desc: `Use code *WRIXTAN40* to save 40% on your favorite handmade goods.\nCopy and paste this code at Etsy.`,
    imageUrl: "https://via.placeholder.com/300x200?text=Etsy+40%25+Off",
    link: "https://www.etsy.com/"
  },
  {
    title: "🎌 15% Off Storewide at Crunchyroll",
    desc: `Code *CR15* copied to your clipboard!\nEnjoy 15% off on all anime merchandise and subscriptions.`,
    imageUrl: "https://via.placeholder.com/300x200?text=Crunchyroll+15%25+Off",
    link: "https://www.crunchyroll.com/"
  },
  {
    title: "🛒 $1 Off Costco Executive Membership",
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
    title: "🎨 Free Canva Credit",
    desc: `Get 1 Canva credit as a free gift when you sign up.\nUse code *INCENTIVISED-REFERRAL* — copied to your clipboard!`,
    imageUrl: "https://via.placeholder.com/300x200?text=Canva+Free+Credit",
    link: "https://www.canva.com/"
  }
];


// Webhook verification
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

// Enhanced user handling
async function handleUser(req) {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value?.contacts?.[0]?.wa_id) {
        console.log("No contact info - ignoring status update");
        return null;
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
                console.log(`📝 User ${user.id} updated`);
            } else {
                user = await create_user({
                    number: phoneNumber,
                    prev_msg: [message],
                    lastInteraction: new Date()
                });
                console.log(`👤 New user created: ${user.id}`);
            }
        }
        return user;
    } catch (error) {
        console.error("❌ User handling error:", error.message);
        return null;
    }
}

// Robust cancellation detection
function isCancelRequest(message) {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const cancelPatterns = [
        'cancel ticket',
        'cancel booking',
        'cancel my booking',
        'cancel my ticket',
        'cancel reservation',
        'cancel slot',
        'abort booking',
        'delete booking',
        'remove booking',
        'stop booking',
        'cancel',
        'abort'
    ];
    return cancelPatterns.some(pattern =>
        lowerMsg === pattern || lowerMsg.includes(pattern)
    );
}

// Enhanced booking trigger
function isBookingModeRequest(message) {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const triggers = ['book', 'booking', 'park', 'parking', 'reserve', 'reservation'];
    return triggers.some(trigger =>
        lowerMsg === trigger || lowerMsg.startsWith(trigger)
    );
}

// Consistent message formatting
function buildResponseMessage(mode, message) {
    if (mode === "AD") return message;
    const prefix = mode === 'booking'
        ? '🅿️ Booking Mode'
        : mode === 'OWNER'
            ? '🅿️ Owner Mode'
            : '💬 Shara AI';
    return `${prefix}: ${message}`;
}

// MAIN WEBHOOK HANDLER
router.post('/', async (req, res) => {
    try {
        const user = await handleUser(req);
        const messageObj = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (!messageObj || !user) {
            return res.sendStatus(200);
        }

        const phoneNumber = messageObj.from;
        const userId = user.id;
        const incomingMessage = (messageObj.text?.body || '').trim();
        const lowerCaseMessage = incomingMessage.toLowerCase();

        console.log(`📥 Message from ${userId}: "${incomingMessage}"`);

        // === PRIORITY 1: CANCEL REQUEST ===
        if (isCancelRequest(incomingMessage)) {
            console.log(`🚫 Cancel request detected from user: ${userId}`);
            const result = await cancelUserBooking(userId);
            await sendWhatsAppMessage(phoneNumber, result.message);
            return res.sendStatus(200);
        }

        // === PRIORITY 2: OWNER MODE SWITCH ===
        if (['owner', 'owner mode'].includes(lowerCaseMessage)) {
            const ownerCheck = await check_and_switch_to_owner_mode(userId);
            const responseMessage = ownerCheck.isOwner
                ? ownerCheck.message
                : "🚫 You're not registered as a parking owner. Contact admin.";
            await sendWhatsAppMessage(phoneNumber, responseMessage);
            return res.sendStatus(200);
        }

        // === AUTO-SWITCH TO OWNER MODE IF REGISTERED ===
        const ownerCheck = await check_and_switch_to_owner_mode(userId);
        if (ownerCheck.isOwner) {
            if (ownerCheck.justSwitched && !['hi', 'talk', 'help'].includes(lowerCaseMessage)) {
                const openSlots = ownerCheck.ownerData.slots?.filter(s => s.state === 'available')?.length || 0;
                const totalSlots = ownerCheck.ownerData.slots?.length || 0;
                const welcomeMsg = `🅿️ *OWNER MODE ACTIVATED*
Welcome ${ownerCheck.ownerData.name || ''}!
Status: ${ownerCheck.ownerData.is_active ? '🟢 ACTIVE' : '🔴 INACTIVE'}
Slots: ${openSlots}/${totalSlots} available
Location: ${ownerCheck.ownerData.location || 'Not set'}`;
                await sendWhatsAppMessage(phoneNumber, welcomeMsg);
            }
            const ownerReply = await handle_owner_commands(userId, incomingMessage);
            if (ownerReply) {
                await sendWhatsAppMessage(phoneNumber, ownerReply);
            }
            return res.sendStatus(200);
        }

        // === PRIORITY 3: ADMIN COMMANDS ===
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
            }
            return res.sendStatus(200);
        }

        // === PRIORITY 4: STATUS COMMAND ===
        if (lowerCaseMessage === 'status') {
            const currentMode = await getUserMode(userId);
            if (currentMode === 'OWNER') {
                const ownerReply = await handle_owner_commands(userId, 'status');
                await sendWhatsAppMessage(phoneNumber, ownerReply);
            } else {
                const statusMessage = await getUserBookingStatus(userId);
                await sendWhatsAppMessage(phoneNumber, statusMessage);
            }
            return res.sendStatus(200);
        }

        // === PRIORITY 5: HI / TALK ===
        if (['hi', 'talk'].includes(lowerCaseMessage)) {
            await setUserMode(userId, 'AI');
             const reply1 = buildResponseMessage(
    'AI',
    `🚗 *Welcome to SharaSpot!*\n
Wherever you drive,\t Park Nearby.\n
🔹 Type *Book* — to reserve your parking space\n
🔹 Type *Help* — for quick guidance\n
🔹 Ask *Shara AI* — for anything else\n
──────────────\n
✨ *Powered by Folonite*`
);


            const randomNum = Math.floor(Math.random() * Ads_arr.length);
            const ad_title = Ads_arr[randomNum].title;
            const ad_desc = Ads_arr[randomNum].desc;
            const reply2 = buildResponseMessage(
                'AD',
                ` ${ad_title}: ${ad_desc}`
            );
            await sendWhatsAppMessage(phoneNumber, reply1);
            await sendWhatsAppMessage(phoneNumber, reply2);
            return res.sendStatus(200);
        }

        // === PRIORITY 6: BOOKING START (Manually trigger handleBooking) ===
        if (isBookingModeRequest(incomingMessage)) {
            const activeBooking = await hasActiveBooking(userId);
            if (activeBooking) {
                const vehicleTypes = [
                    { type: 'Two-wheeler', slotPrefix: 'M' },
                    { type: '4-seat car', slotPrefix: 'C' },
                    { type: '8-seat car', slotPrefix: 'L' },
                    { type: 'Van', slotPrefix: 'V' },
                ];
                const vehicleInfo = vehicleTypes.find(v => v.type === activeBooking.vehicle_type) || { slotPrefix: '' };
                const message = `🚫 *You already have an active booking!*
🎫 Current Booking:
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 ${activeBooking.id}
🚗 ${activeBooking.vehicle_type}
📍 ${activeBooking.destination}
🅿️ ${vehicleInfo.slotPrefix}${activeBooking.slot_number}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Options:
 *"cancel ticket"* - Cancel current booking
 *"status"* - View booking details
 *"hi"* - Main menu`;
                await sendWhatsAppMessage(phoneNumber, message);
                return res.sendStatus(200);
            }

            // ✅ SET MODE AND MANUALLY TRIGGER handleBooking
            await setUserMode(userId, 'booking');
            const bookingReply = await handleBooking(userId, incomingMessage); // This creates the session
            await sendWhatsAppMessage(phoneNumber, bookingReply);
            return res.sendStatus(200);
        }

        // === PRIORITY 7: HELP ===
        if (['help', 'menu'].includes(lowerCaseMessage)) {
            const currentMode = await getUserMode(userId);
            let helpText = '';
            if (currentMode === 'OWNER') {
                helpText = `🅿️ *Owner Commands:*
• *1* - Set Active
• *0* - Set Inactive
• *2* - Accept Booking
• *3* - Update Location
• *status* - View Status
• *hi/talk* - Switch to AI Mode`;
            } else if (currentMode === 'booking') {
                helpText = `🅿️ *Booking Commands:*
• *cancel ticket* - Cancel booking
• *status* - Check booking
• *hi/talk* - Switch to AI Mode
• *help* - Show this menu`;
            } else {
                helpText = `🏠 *Main Menu:*
🅿️ *Book* - Start parking reservation
📱 *Status* - Check booking status
💬 *Hi/Talk* - Chat with AI
🅿️ *Owner* - Owner mode (if registered)
❓ *Help* - Show this menu`;
            }
            await sendWhatsAppMessage(phoneNumber, buildResponseMessage(currentMode, helpText));
            return res.sendStatus(200);
        }

        // === PRIORITY 8: PROCESS BY CURRENT MODE ===
        const currentMode = await getUserMode(userId);

        if (currentMode === 'AI') {
            try {
                await sendTyping(messageObj.id);
                const aiReply = await getAIResponse(incomingMessage, userId);
                await push_ai_msg(userId, aiReply);
                await update_user(userId, {
                    prev_msg: [...(user.prev_msg || []), incomingMessage],
                    lastInteraction: new Date()
                });
                await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', aiReply));
            } catch (error) {
                console.error('❌ AI conversation error:', { userId, phoneNumber, error: error.message });
                await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', 'Hmm, something went wrong while I was thinking 😅. Try again later!'));
            }
            return res.sendStatus(200);
        }

        // ✅ Now correctly uses 'booking', not 'PARKING'
        else if (currentMode === 'booking') {
            try {
                let userInput = '';
                if (messageObj.type === 'text') {
                    userInput = messageObj.text.body;
                } else if (messageObj.type === 'location') {
                    const loc = messageObj.location;
                    userInput = `LOCATION: lat=${loc.latitude}, lon=${loc.longitude}, name=${loc.name || 'Unnamed'}, address=${loc.address || 'No Address'}`;
                } else {
                    await sendWhatsAppMessage(phoneNumber, buildResponseMessage('booking', 'Please send a text message.'));
                    return res.sendStatus(200);
                }
                const bookingReply = await handleBooking(userId, userInput);
                if (bookingReply) {
                    await sendWhatsAppMessage(phoneNumber, bookingReply);
                }
            } catch (error) {
                console.error('❌ Booking error:', error);
                await sendWhatsAppMessage(phoneNumber, buildResponseMessage('booking', '❌ We hit a snag with your booking 😔. Please try again.'));
            }
            return res.sendStatus(200);
        }

        else if (currentMode === 'OWNER') {
            let ownerReply;
            if (messageObj.type === 'location') {
                const loc = messageObj.location;
                const locationInput = `LOCATION: lat=${loc.latitude}, lon=${loc.longitude}, name=${loc.name || 'Unnamed'}, address=${loc.address || 'No Address'}`;
                ownerReply = await updateOwnerLocationFlow(userId, locationInput);
            } else if (lowerCaseMessage === '3') {
                ownerReply = await handle_owner_commands(userId, '3');
            } else {
                ownerReply = await handle_owner_commands(userId, incomingMessage);
            }
            await sendWhatsAppMessage(phoneNumber, ownerReply);
            return res.sendStatus(200);
        }

        // === FALLBACK ===
        const fallbackMsg = `❓ I didn't understand that command.
💡 Try:
• *Book* - Start parking
• *Status* - Check booking
• *Help* - See all commands
• *Hi* - Chat with AI`;
        await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', fallbackMsg));
        return res.sendStatus(200);

    } catch (error) {
        console.error('❌ Webhook error:', error);
        if (req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from) {
            const phoneNumber = req.body.entry[0].changes[0].value.messages[0].from;
            await sendWhatsAppMessage(phoneNumber, '❌ System error occurred. Please try again in a moment.');
        }
        return res.sendStatus(500);
    }
});

module.exports = router;