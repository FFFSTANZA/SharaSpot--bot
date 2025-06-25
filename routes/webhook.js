const express = require('express');
const router = express.Router();
const fs = require('fs')
const { getUserMode, setUserMode, getUserBooking, checkAndSwitchToOwnerMode } = require('../sessions/sessionManager');
const { getAIResponse } = require('../services/aiService');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const {
    handleBooking,
    handleOwnerCommands,
    updateOwnerLocationFlow,
    handleAdminCommand,
    getUserBookingStatus,

} = require('../controllers/bookingController');

function buildResponseMessage(mode, message) {
    // Unified mode indicator with emojis
    const prefix = mode === 'PARKING' ? '🅿️ Parking Mode' :
        (mode === 'OWNER' ? '🅿️ Owner Mode' : '💬 Shara AI');
    return `${prefix}: ${message}`;
}

const VERIFY_TOKEN = 'sharaspot';


const Ads_arr = [
    {
        title: "Summer Sale Bonanza!",
        desc: "Get up to 50% off on all fashion wear. Limited time offer.",
        imageUrl: "https://via.placeholder.com/300x200?text=Summer+Sale",
    },
    {
        title: "Upgrade Your Tech",
        desc: "Grab the latest gadgets at unbeatable prices. Shop now!",
        imageUrl: "https://via.placeholder.com/300x200?text=Tech+Deals",
    },
    {
        title: "Travel the World",
        desc: "Book your dream vacation today with exclusive discounts on flights and hotels.",
        imageUrl: "https://via.placeholder.com/300x200?text=Travel+Deals",
    },
    {
        title: "Delicious Meals Delivered",
        desc: "Order from your favorite restaurants and get fast home delivery.",
        imageUrl: "https://via.placeholder.com/300x200?text=Food+Delivery",
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

router.post('/', async (req, res) => {
    try {
        console.log('✅ Webhook received:', JSON.stringify(req.body, null, 2));

        // saving the user data initially when user enters
        const path = './data/users.json';

        // Extract data safely
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;


        // Only process if it's a contact message (not status)
        if (!value || !value.contacts || !Array.isArray(value.contacts) || value.contacts.length === 0) {
            console.log("📭 No contact info (probably a status update). Ignored.");
        } else {

            const contact = value.contacts[0];
            const name = contact?.profile?.name || "Unknown";
            const number = contact?.wa_id;
            const uniqueId = number;


            try {
                let users = [];

                // Initialize file if missing
                if (!fs.existsSync(path)) {
                    fs.writeFileSync(path, '[]', 'utf-8');
                }

                // Load and parse existing data safely
                const fileData = fs.readFileSync(path, 'utf-8');
                if (fileData.trim()) {
                    users = JSON.parse(fileData);
                }

                // Check for existing user
                const userExists = users.some(user => user.uniqueId === uniqueId);

                if (!userExists) {
                    const messageObj = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
                    const incomingMessage = (messageObj.text?.body || '').trim();

                    const prevMsg = []
                    const aiMsg = []
                    if (incomingMessage) {
                        prevMsg.push(incomingMessage);
                    }
                    const newUser = { name, number, uniqueId, prevMsg, aiMsg };
                    users.push(newUser);

                    fs.writeFileSync(path, JSON.stringify(users, null, 2));
                    console.log("✅ New user added:", newUser);
                } else {

                    const uniqueId = number;
                    const userIndex = users.findIndex(user => user.uniqueId === uniqueId);

                    // to push new messages to prevMsg array 
                    const messageObj = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
                    const incomingMessage = (messageObj.text?.body || '').trim();


                    if (userIndex !== -1) {
                        const existingMessages = users[userIndex].prevMsg;

                        // Avoid duplicate if already last message
                        if (existingMessages[existingMessages.length - 1] !== incomingMessage) {
                            users[userIndex].prevMsg.push(incomingMessage);
                            fs.writeFileSync(path, JSON.stringify(users, null, 2));
                            console.log("✅ Message added to existing user.");
                        } else {
                            console.log("⚠️ Duplicate message skipped.");
                        }
                    }



                    console.log("ℹ️ User already exists. Skipping.");
                }



            } catch (error) {
                console.log("❌ Error handling user data:", error);

            }
        }



        const messageObj = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!messageObj) return res.sendStatus(200);

        const userId = messageObj.from;
        const incomingMessage = (messageObj.text?.body || '').trim();
        const lowerCaseMessage = incomingMessage.toLowerCase();

        // First check if the user is an owner
        const ownerCheck = checkAndSwitchToOwnerMode(userId);
        if (ownerCheck.isOwner && !['hi', 'talk'].includes(lowerCaseMessage)) {
            // If user is an owner and not trying to switch to AI mode
            await sendWhatsAppMessage(userId, ownerCheck.message);
            
            // Now handle the message if it's not the initial greeting
            if (incomingMessage) {
                const ownerReply = await handleOwnerCommands(userId, incomingMessage);
                if (ownerReply) {
                    await sendWhatsAppMessage(userId, ownerReply);
                }
            }
            return res.sendStatus(200);
        }

        // Admin commands check
        if (lowerCaseMessage.startsWith('admin') || lowerCaseMessage.includes('add owner') ||
            lowerCaseMessage.includes('remove owner') || lowerCaseMessage.includes('list owner') ||
            lowerCaseMessage.includes('show stats')) {
            const adminResponse = await handleAdminCommand(incomingMessage, userId);
            if (adminResponse) {
                await sendWhatsAppMessage(userId, adminResponse);
                return res.sendStatus(200);
            }
        }

        // Handle mode switching commands
        if (lowerCaseMessage === 'hi' || lowerCaseMessage === 'talk') {
            setUserMode(userId, 'AI');
            const reply1 = buildResponseMessage(
                'AI',
                `Welcome to SharaSpot!\nWherever you drive, Park Nearby\nOur service is currently available in Sivakasi and Rajapalayam, and we're expanding soon!\n\nType "Book" to reserve your parking space, or ask Shara AI anything for more info.\n\nPowered by Folonite.`
            );
            const reply2 = buildResponseMessage(
                'AI',
                `🎟️ Roaman's Coupon: **50% Off Your Order**\nCopy and paste this code at roamans.com: **CASMS**\nEnjoy 50% off on dresses, suites, shoes and more at Roaman's.`
            );

            await sendWhatsAppMessage(userId, reply1);
            await sendWhatsAppMessage(userId, reply2);
            return res.sendStatus(200);
        }

        if (lowerCaseMessage === 'book') {
            setUserMode(userId, 'PARKING');
            await sendWhatsAppMessage(userId, buildResponseMessage('PARKING', `You are now in Parking Mode. Let's start your reservation. \nEnter your name:`));
            return res.sendStatus(200);
        }

        // Handle status command 
        if (lowerCaseMessage === 'status') {
            const currentMode = getUserMode(userId);
            if (currentMode === 'OWNER') {
                // Owner mode status is already handled in handleOwnerCommands
                const ownerReply = await handleOwnerCommands(userId, lowerCaseMessage);
                await sendWhatsAppMessage(userId, ownerReply);
            } else {
                // Handle user status command
                const statusMessage = await getUserBookingStatus(userId);
                await sendWhatsAppMessage(userId, buildResponseMessage(currentMode, statusMessage));
            }
            return res.sendStatus(200);
        }

        // Help command
        if (lowerCaseMessage === 'help') {
            const currentMode = getUserMode(userId);
            let helpText = '';

            if (currentMode === 'OWNER') {
                helpText = `Commands:\n- 1: Set Active\n- 0: Set Inactive\n- 2: Accept Current Booking\n- 3: Update Location\n- status: View Your Status\n- hi/talk: Switch to AI Mode`;
            } else if (currentMode === 'PARKING') {
                helpText = `Commands:\n- hi/talk: Switch to AI Mode\n- status: Check booking status\n- help: Show this menu`;
            } else {
                helpText = `Commands:\n- book: Start a parking reservation\n- status: Check booking status\n- help: Show this menu`;
            }

            await sendWhatsAppMessage(userId, buildResponseMessage(currentMode, helpText));
            return res.sendStatus(200);
        }

        // Process messages based on current mode
        const currentMode = getUserMode(userId);
        const contact = value.contacts[0];
        const number = contact?.wa_id;
        const uniqueId = number;
       


        if (currentMode === 'AI') {
            try {
                
                const aiReply = await getAIResponse(incomingMessage, uniqueId);
                await sendWhatsAppMessage(userId, buildResponseMessage('AI', aiReply));
            } catch (error) {
                console.error('AI error:', error);
                await sendWhatsAppMessage(userId, buildResponseMessage('AI', 'Hmm, something went wrong while I was thinking 😅. Try again later!'));
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
                    await sendWhatsAppMessage(userId, buildResponseMessage('PARKING', bookingReply));
                }
            } catch (error) {
                console.error('Booking error:', error);
                await sendWhatsAppMessage(userId, buildResponseMessage('PARKING', 'We hit a snag with your booking 😔. Please try again shortly.'));
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
                ownerReply = await handleOwnerCommands(userId, lowerCaseMessage);
            } else {
                ownerReply = await handleOwnerCommands(userId, incomingMessage);
            }
            await sendWhatsAppMessage(userId, ownerReply);
            return res.sendStatus(200);
        }

        // Default fallback for unrecognized commands
        await sendWhatsAppMessage(userId, buildResponseMessage('AI', `I didn't get that. Please type 'help' to see available commands.`));
        return res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        return res.sendStatus(500);
    }
});

module.exports = router;