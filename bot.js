const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || '8781119793:AAESRUPn6-d4XAfMevf8ETdBS2ordbyc6eQ';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // e.g. https://your-app.up.railway.app  (set this AFTER first deploy)
const MINI_APP_URL = process.env.MINI_APP_URL || 'YOUR_NETLIFY_URL_HERE'; // <-- PASTE YOUR index.html NETLIFY LINK HERE
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://smmhub-1e20c-default-rtdb.firebaseio.com';
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN);
const app = express();
app.use(express.json());

// ===================== FIREBASE REST HELPERS =====================
async function fbGet(path) {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`);
    if (!r.ok) return null;
    return r.json();
}
async function fbSet(path, data) {
    await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}
async function fbUpdate(path, data) {
    await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}
async function fbPush(path, data) {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return r.json(); // { name: 'pushedKey' }
}

// ===================== IN-MEMORY CONVERSATION STATE =====================
// Tracks multi-step flows like "Add Fund" (amount -> UTR)
const userState = {};

// ===================== KEYBOARD =====================
function mainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '🛍️ Social Media Service', web_app: { url: MINI_APP_URL } }],
                [{ text: '💰 Add Fund' }, { text: '🤝 Refer and Earn' }],
                [{ text: '💸 Earn Money' }, { text: '🎁 Daily Reward' }]
            ],
            resize_keyboard: true
        }
    };
}

// ===================== /start =====================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || msg.from.first_name || ('user' + chatId);
    const payload = match && match[1];

    try {
        const existing = await fbGet(`users/${chatId}`);
        if (!existing) {
            const newUser = {
                chatId,
                username,
                firstName: msg.from.first_name || '',
                balance: 0,
                isGuest: false,
                createdAt: Date.now()
            };
            if (payload && payload.startsWith('ref_')) {
                const refId = payload.replace('ref_', '');
                if (refId && refId !== chatId) newUser.referredBy = refId;
            }
            await fbSet(`users/${chatId}`, newUser);
            bot.sendMessage(chatId, `✅ Welcome ${username}! You're all set 🎉`, mainKeyboard());
        } else {
            await fbUpdate(`users/${chatId}`, { username, firstName: msg.from.first_name || '' });
            bot.sendMessage(chatId, `✅ Welcome back! You're all set 🎉`, mainKeyboard());
        }
    } catch (e) {
        console.error('start error', e);
        bot.sendMessage(chatId, '⚠️ Something went wrong, please try again.', mainKeyboard());
    }
});

// ===================== MESSAGE ROUTER =====================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const state = userState[chatId];

    try {
        // ---- Step 1: waiting for deposit amount ----
        if (state && state.step === 'awaiting_deposit_amount') {
            const amt = parseFloat(text);
            if (isNaN(amt) || amt < 10) {
                bot.sendMessage(chatId, '❌ Please enter a valid amount (minimum ₹10).');
                return;
            }
            const settings = (await fbGet('settings')) || {};
            const upiId = settings.upiId || 'monisbhai@fam';
            const payeeName = settings.upiPayeeName || 'SMM Panel';
            const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amt.toFixed(2)}&cu=INR&tn=WalletDeposit`;

            const qrBuffer = await QRCode.toBuffer(upiLink, { width: 400 });
            await bot.sendPhoto(chatId, qrBuffer, {
                caption: `📲 Scan & Pay ₹${amt.toFixed(2)} to ${upiId}\n\nAfter payment, send me the 12-digit UTR / Transaction ID here.`
            });

            userState[chatId] = { step: 'awaiting_utr', amount: amt };
            return;
        }

        // ---- Step 2: waiting for UTR ----
        if (state && state.step === 'awaiting_utr') {
            if (text.length < 12) {
                bot.sendMessage(chatId, '❌ Please send a valid 12-digit UTR / Transaction ID.');
                return;
            }
            const username = msg.from.username || msg.from.first_name || ('user' + chatId);
            await fbPush('deposits', {
                userId: chatId,
                username,
                amount: state.amount,
                utr: text,
                status: 'pending',
                createdAt: Date.now()
            });
            bot.sendMessage(chatId, '✅ Payment proof submitted! Admin will verify and credit your wallet shortly.', mainKeyboard());
            delete userState[chatId];
            return;
        }

        // ---- Menu: Add Fund ----
        if (text === '💰 Add Fund') {
            userState[chatId] = { step: 'awaiting_deposit_amount' };
            bot.sendMessage(chatId, '💰 Enter the amount you want to add (minimum ₹10):');
            return;
        }

        // ---- Menu: Refer and Earn / Earn Money (same referral system) ----
        if (text === '🤝 Refer and Earn' || text === '💸 Earn Money') {
            const settings = (await fbGet('settings')) || {};
            const bonus = settings.referralBonus != null ? settings.referralBonus : 10;
            const me = await bot.getMe();
            const refLink = `https://t.me/${me.username}?start=ref_${chatId}`;
            bot.sendMessage(
                chatId,
                `🤝 *Refer & Earn*\n\nShare your link with friends. When they join and make their first approved deposit, you earn ₹${bonus}!\n\nYour referral link:\n${refLink}`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // ---- Menu: Daily Reward ----
        if (text === '🎁 Daily Reward') {
            const user = (await fbGet(`users/${chatId}`)) || {};
            const settings = (await fbGet('settings')) || {};
            const rewardAmt = settings.dailyRewardAmount != null ? settings.dailyRewardAmount : 2;
            const last = user.lastDailyClaim || 0;
            const now = Date.now();
            const hoursPassed = (now - last) / (1000 * 60 * 60);

            if (hoursPassed < 24) {
                const remaining = 24 - hoursPassed;
                const h = Math.floor(remaining);
                const m = Math.floor((remaining - h) * 60);
                bot.sendMessage(chatId, `⏳ You already claimed today's reward. Come back after ${h}h ${m}m.`);
            } else {
                const newBalance = (user.balance || 0) + rewardAmt;
                await fbUpdate(`users/${chatId}`, { balance: newBalance, lastDailyClaim: now });
                bot.sendMessage(chatId, `🎁 You claimed ₹${rewardAmt} daily reward! New balance: ₹${newBalance.toFixed(2)}`);
            }
            return;
        }
    } catch (e) {
        console.error('message handler error', e);
        bot.sendMessage(chatId, '⚠️ Something went wrong, please try again.');
    }
});

// ===================== WEBHOOK SETUP =====================
if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    console.log('Webhook mode active:', `${WEBHOOK_URL}/bot${BOT_TOKEN}`);
} else {
    console.warn('⚠️ WEBHOOK_URL not set. Bot will NOT receive messages until you set this env var to your deployed URL and redeploy.');
}

app.get('/', (req, res) => res.send('Quantum QR Bot is running ✅'));

app.listen(PORT, () => console.log('Server listening on port ' + PORT));
