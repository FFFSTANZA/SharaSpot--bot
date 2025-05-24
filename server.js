const express = require('express');
const bodyParser = require('body-parser');
const webhookRoutes = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON and URL-encoded bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/webhook', webhookRoutes);

app.get('/', (req, res) => {
    res.send('SharaSpot WhatsApp Bot is running 🚗');
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
