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
    cancelUserBooking, // FIXED: Import the working cancel function
    hasActiveBooking   // FIXED: Import active booking checker
} = require('../controllers/bookingController');
const { create_user, get_user_by_id, get_user_by_number, push_ai_msg, update_user} = require('../lib/userDb');
const { eq } = require('drizzle-orm');
const {getOwnerByPhone} = require('../lib/ownerDb');
const { normalizePhone} = require('../utils/normalizePhone');
const createDbConnection = require('../database/connect');

// FIXED: Robust cancellation detection
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
    
    // Direct match or contains pattern
    return cancelPatterns.some(pattern => 
        lowerMsg === pattern || lowerMsg.includes(pattern)
    );
}

// FIXED: Enhanced mode detection
function isBookingModeRequest(message) {
    if (!message) return false;
    
    const lowerMsg = message.toLowerCase().trim();
    const bookingTriggers = ['book', 'booking', 'park', 'parking', 'reserve', 'reservation'];
    
    return bookingTriggers.some(trigger => 
        lowerMsg === trigger || lowerMsg.includes(trigger)
    );
}

// FIXED: Better message building with consistent formatting
function buildResponseMessage(mode, message) {
    if (mode === "AD") {
        return message;
    }
    
    const prefix = mode === 'PARKING' ? '🅿️ Parking Mode' :
        (mode === 'OWNER' ? '🅿️ Owner Mode' : '💬 Shara AI');
    return `${prefix}: ${message}`;
}

// Database connection handler
async function handleIncomingMessage(req, res) {
    try {
        const db = await createDbConnection();
    } catch (error) {
        console.error('Critical error:', error);
        res.status(500).send('Server error');
    }
}

const VERIFY_TOKEN = 'sharaspot';

const Ads_arr = [
    {
        title: "40% Off at Etsy",
        desc: `Use code *WRIXTAN40* to save 40% on your favorite handmade goods.\nCopy and paste this code at Etsy.`,
        imageUrl: "https://via.placeholder.com/300x200?text=Etsy+40%25+Off",
        link: "https://www.etsy.com/"
    },
    {
        title: "15% Off Storewide at Crunchyroll",
        desc: `Code *CR15* copied to your clipboard!\nEnjoy 15% off on all anime merchandise and subscriptions.`,
        imageUrl: "https://via.placeholder.com/300x200?text=Crunchyroll+15%25+Off",
        link: "https://www.crunchyroll.com/"
    },
    {
        title: "$1 Off Gold Star Executive Membership at Costco",
        desc: `Code *CJRTLMN* copied to your clipboard!\nSave $1 on your next Costco membership.`,
        imageUrl: "https://via.placeholder.com/300x200?text=Costco+Deal",
        link: "https://www.costco.com/"
    },
    {
        title: "$117 Off Queen Deluxe Mattress on Amazon",
        desc: `Use code *GROKC5Q5* and save $117 on a 10-inch Hybrid Queen Mattress.\nCode copied to your clipboard!`,
        imageUrl: "https://via.placeholder.com/300x200?text=Amazon+Mattress+Deal",
        link: "https://www.amazon.com/"
    },
    {
        title: "Free Canva Credit",
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

// FIXED: Enhanced user handling with better error management
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

// MAIN WEBHOOK HANDLER - COMPLETELY FIXED
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

        console.log(`📥 Message from ${userId}: "${incomingMessage}"`);

        // PRIORITY 1: CANCELLATION HANDLING - MUST BE FIRST!
        if (isCancelRequest(incomingMessage)) {
            console.log(`🚫 Cancel request detected from user: ${userId}`);
            try {
                const result = await cancelUserBooking(userId);
                await sendWhatsAppMessage(phoneNumber, result.message);
                console.log(`🚫 Cancel result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
                return res.sendStatus(200);
            } catch (error) {
                console.error('❌ Cancel error:', error);
                await sendWhatsAppMessage(phoneNumber, '❌ Failed to cancel booking. Please try again.');
                return res.sendStatus(200);
            }
        }

        // PRIORITY 2: OWNER MODE SWITCHING
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

                const welcomeMsg = `🅿️ *OWNER MODE ACTIVATED*\n\n` +
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

        // PRIORITY 3: ADMIN COMMANDS
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

        // PRIORITY 4: STATUS COMMAND (handles both booking and owner status)
        if (lowerCaseMessage === 'status') {
            const currentMode = await getUserMode(userId);
            if (currentMode === 'OWNER') {
                const ownerReply = await handle_owner_commands(userId, lowerCaseMessage);
                await sendWhatsAppMessage(phoneNumber, ownerReply);
            } else {
                const statusMessage = await getUserBookingStatus(userId);
                await sendWhatsAppMessage(phoneNumber, statusMessage);
            }
            return res.sendStatus(200);
        }

        // PRIORITY 5: MODE SWITCHING COMMANDS
        if (lowerCaseMessage === 'hi' || lowerCaseMessage === 'talk') {
            await setUserMode(userId, 'AI');
            const reply1 = buildResponseMessage(
               'AI',
               `Welcome to SharaSpot!\nWherever you drive, Park Nearby.\n\nType "Book" to reserve your parking space,\nor say "Help" for guidance,\nor ask Shara AI anything for more info.\n\nPowered by Folonite.`
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

        // PRIORITY 6: BOOKING MODE (with active booking check)
        if (isBookingModeRequest(incomingMessage)) {
            // Check if user already has active booking
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

            // No active booking, start new booking
            await setUserMode(userId, 'PARKING');
            await sendWhatsAppMessage(phoneNumber, buildResponseMessage('PARKING', `🅿️ *Parking Reservation Started*\n\nLet's get your parking sorted!\n\n👤 Please enter your full name:`));
            return res.sendStatus(200);
        }

        // PRIORITY 7: HELP COMMAND
        if (lowerCaseMessage === 'help' || lowerCaseMessage === 'menu') {
            const currentMode = await getUserMode(userId);
            let helpText = '';

            if (currentMode === 'OWNER') {
                helpText = `🅿️ *Owner Commands:*\n\n• *1* - Set Active\n• *0* - Set Inactive\n• *2* - Accept Booking\n• *3* - Update Location\n• *status* - View Status\n• *hi/talk* - Switch to AI Mode`;
            } else if (currentMode === 'PARKING') {
                helpText = `🅿️ *Parking Commands:*\n\n• *cancel ticket* - Cancel booking\n• *status* - Check booking\n• *hi/talk* - Switch to AI Mode\n• *help* - Show this menu`;
            } else {
                helpText = `🏠 *Main Menu:*\n\n🅿️ *Book* - Start parking reservation\n📱 *Status* - Check booking status\n💬 *Hi/Talk* - Chat with AI\n🅿️ *Owner* - Owner mode (if registered)\n❓ *Help* - Show this menu`;
            }

            await sendWhatsAppMessage(phoneNumber, buildResponseMessage(currentMode, helpText));
            return res.sendStatus(200);
        }

        // PRIORITY 8: PROCESS MESSAGES BASED ON CURRENT MODE
        const currentMode = await getUserMode(userId);
        const messageId = messageObj.id;

        if (currentMode === 'AI') {
            try {
                await sendTyping(messageId);
                const aiReply = await getAIResponse(incomingMessage, userId); 
                
                await push_ai_msg(userId, aiReply); 
                await update_user(userId, {
                    prev_msg: [...(user.prev_msg || []), incomingMessage],
                    lastInteraction: new Date()
                });

                await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', aiReply));
            } catch (error) {
                console.error('❌ AI conversation error:', {
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
                    userInput = '[Unsupported message type - please send text]';
                    await sendWhatsAppMessage(phoneNumber, buildResponseMessage('PARKING', 'Please send a text message. Other message types are not supported in booking mode.'));
                    return res.sendStatus(200);
                }
                
                const bookingReply = await handleBooking(userId, userInput);
                if (bookingReply) {
                    await sendWhatsAppMessage(phoneNumber, bookingReply);
                }
            } catch (error) {
                console.error('❌ Booking error:', error);
                await sendWhatsAppMessage(phoneNumber, buildResponseMessage('PARKING', '❌ We hit a snag with your booking 😔. Please try again or type "hi" to return to main menu.'));
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

        // FALLBACK: Unknown command
        const fallbackMsg = `❓ I didn't understand that command.\n\n💡 Try:\n• *Book* - Start parking\n• *Status* - Check booking\n• *Help* - See all commands\n• *Hi* - Chat with AI`;
        await sendWhatsAppMessage(phoneNumber, buildResponseMessage('AI', fallbackMsg));
        return res.sendStatus(200);
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        
        // Send user-friendly error message
        if (req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from) {
            const phoneNumber = req.body.entry[0].changes[0].value.messages[0].from;
            await sendWhatsAppMessage(phoneNumber, '❌ System error occurred. Please try again in a moment.');
        }
        
        return res.sendStatus(500);
    }
});

module.exports = router;