const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || '8781119793:AAESRUPn6-d4XAfMevf8ETdBS2ordbyc6eQ';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://smmhu.netlify.app/';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://smmhub-1e20c-default-rtdb.firebaseio.com';
const PORT = process.env.PORT || 3000;

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '6270522295';

const CHANNEL_1 = { username: 'smmhubrobo',   label: 'SMM Hub Official',     link: 'https://t.me/smmhubrobo' };
const CHANNEL_2 = { username: 'smmhuboffical', label: 'Notification Channel', link: 'https://t.me/smmhuboffical' };
const REQUIRED_CHANNELS = [CHANNEL_1, CHANNEL_2];

const REFERRAL_VIEWS_REWARD = 10000;
const QR_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
}
async function fbUpdate(path, data) {
    await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
}
async function fbPush(path, data) {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return r.json();
}

// ===================== STATE =====================
const userState = {};     // per-user conversation state
const qrTimers = {};      // per-user QR timeout timers

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function typing(chatId, ms = 600) {
    try { await bot.sendChatAction(chatId, 'typing'); } catch (e) {}
    await sleep(ms);
}

async function react(chatId, msgId, emoji) {
    try {
        await bot.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji }]);
    } catch (e) {}
}

async function deleteMsg(chatId, msgId) {
    try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
}

// Delete a list of message IDs
async function deleteMsgs(chatId, ids = []) {
    for (const id of ids) await deleteMsg(chatId, id);
}

// Animated message — morphs through frames array
async function animate(chatId, frames, delay = 380, opts = {}) {
    const sent = await bot.sendMessage(chatId, frames[0], opts);
    for (let i = 1; i < frames.length; i++) {
        await sleep(delay);
        try {
            await bot.editMessageText(frames[i], {
                chat_id: chatId,
                message_id: sent.message_id,
                parse_mode: opts.parse_mode || undefined
            });
        } catch (e) {}
    }
    return sent;
}

// ===================== BATTERY-STYLE PROGRESS ANIMATION =====================
const BATTERY_FRAMES = [
    `⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛  0%  🔋`,
    `🟩⬛⬛⬛⬛⬛⬛⬛⬛⬛  10% 🔋`,
    `🟩🟩⬛⬛⬛⬛⬛⬛⬛⬛  20% 🔋`,
    `🟩🟩🟩⬛⬛⬛⬛⬛⬛⬛  30% 🔋`,
    `🟩🟩🟩🟩⬛⬛⬛⬛⬛⬛  40% 🔋`,
    `🟩🟩🟩🟩🟩⬛⬛⬛⬛⬛  50% 🔋`,
    `🟩🟩🟩🟩🟩🟩⬛⬛⬛⬛  60% 🔋`,
    `🟩🟩🟩🟩🟩🟩🟩⬛⬛⬛  70% 🔋`,
    `🟩🟩🟩🟩🟩🟩🟩🟩⬛⬛  80% 🔋`,
    `🟩🟩🟩🟩🟩🟩🟩🟩🟩⬛  90% 🔋`,
    `🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100% ✅`
];

async function batteryAnimation(chatId, label) {
    const sent = await bot.sendMessage(chatId, `${label}\n\n${BATTERY_FRAMES[0]}`);
    for (let i = 1; i < BATTERY_FRAMES.length; i++) {
        await sleep(220);
        try {
            await bot.editMessageText(`${label}\n\n${BATTERY_FRAMES[i]}`, {
                chat_id: chatId, message_id: sent.message_id
            });
        } catch (e) {}
    }
    return sent;
}

// ===================== KEYBOARDS =====================
function mainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '🛍️ Social Media Service' }],
                [{ text: '💰 Add Fund' }, { text: '👛 Wallet' }],
                [{ text: '🤝 Refer and Earn' }, { text: '🎁 Daily Reward' }]
            ],
            resize_keyboard: true
        }
    };
}

function homeKeyboard() {
    return {
        reply_markup: {
            keyboard: [[{ text: '🏠 Home' }]],
            resize_keyboard: true
        }
    };
}

function joinChannelsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: `🔥  Join ${CHANNEL_1.label}`, url: CHANNEL_1.link }],
                [{ text: `⚡  Join ${CHANNEL_2.label}`, url: CHANNEL_2.link }],
                [{ text: '✅  I\'ve Joined Both — Verify Now', callback_data: 'verify_join' }]
            ]
        }
    };
}

function claimViewsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎁 Claim 10,000 Free Views', callback_data: 'claim_views' }]
            ]
        }
    };
}

// ===================== CHANNEL CHECK =====================
async function isMemberOf(chatId, channelUsername) {
    try {
        const m = await bot.getChatMember(`@${channelUsername}`, chatId);
        return ['member', 'administrator', 'creator'].includes(m.status);
    } catch (e) { return false; }
}

async function checkAllChannelsJoined(chatId) {
    for (const ch of REQUIRED_CHANNELS) {
        if (!(await isMemberOf(chatId, ch.username))) return false;
    }
    return true;
}

// ===================== JOIN GATE =====================
async function sendJoinGate(chatId) {
    await typing(chatId, 700);

    // Flash intro
    const introMsg = await bot.sendMessage(chatId, `🔒 *Access Required*`, { parse_mode: 'Markdown' });
    await react(chatId, introMsg.message_id, '🔥');
    await sleep(600);

    // Scanning animation
    const scanMsg = await animate(chatId, [
        '🔍  Scanning your profile...',
        '🔍  Scanning your profile..',
        '🔍  Scanning your profile.',
        '📋  Checking memberships...',
        '📋  Checking memberships..',
        '❌  Access Denied — Not a member yet!'
    ], 320);
    await react(chatId, scanMsg.message_id, '🤔');
    await sleep(500);

    await typing(chatId, 500);

    // Main gate card
    const gateMsg = await bot.sendMessage(chatId,
        `╔══════════════════════╗\n` +
        `       🏆  *SMM HUB PANEL*  🏆\n` +
        `╚══════════════════════╝\n\n` +
        `🔐  *This bot is exclusive for members only.*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💎  *What you unlock by joining:*\n\n` +
        `   🎯  10,000 Free Instagram Views\n` +
        `   💰  Daily ₹2 Cash Reward\n` +
        `   🤝  Earn per Referral\n` +
        `   🛍️  Best SMM Prices in India\n` +
        `   ⚡  Instant Order Processing\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👇  *Join both channels below — it's FREE!*`,
        { parse_mode: 'Markdown', ...joinChannelsKeyboard() }
    );
    await react(chatId, gateMsg.message_id, '👑');

    await sleep(900);

    const urgentMsg = await bot.sendMessage(chatId,
        `⏳  *Don't wait!*\n\n` +
        `One tap to join → instant full access! 🚀`,
        { parse_mode: 'Markdown' }
    );
    await react(chatId, urgentMsg.message_id, '🎉');
}

// ===================== REFERRAL HELPERS =====================
async function getUnclaimedReferralCount(referrerChatId) {
    const users = (await fbGet('users')) || {};
    let count = 0;
    for (const uid in users) {
        const u = users[uid];
        if (u.referredBy === referrerChatId && !u.viewsClaimedForThisReferral) count++;
    }
    return count;
}

async function getNextUnclaimedReferredUserId(referrerChatId) {
    const users = (await fbGet('users')) || {};
    let candidates = [];
    for (const uid in users) {
        const u = users[uid];
        if (u.referredBy === referrerChatId && !u.viewsClaimedForThisReferral)
            candidates.push({ uid, createdAt: u.createdAt || 0 });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    return candidates[0].uid;
}

async function maybeSendClaimButton(chatId) {
    const unclaimed = await getUnclaimedReferralCount(chatId);
    if (unclaimed > 0) {
        await typing(chatId, 400);
        await bot.sendMessage(chatId,
            `🎉 *Referral Bonus Ready!*\n\n` +
            `You have *${unclaimed}* referral${unclaimed > 1 ? 's' : ''} waiting.\n` +
            `Claim your *10,000 Free Views* now! 🚀`,
            { parse_mode: 'Markdown', ...claimViewsKeyboard() }
        );
    }
}

// ===================== /start =====================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const payload = match && match[1];

    try {
        const joined = await checkAllChannelsJoined(chatId);
        if (!joined) {
            userState[chatId] = { pendingStartPayload: payload || null };
            await sendJoinGate(chatId);
            return;
        }
        await proceedAfterJoin(chatId, msg.from, payload);
    } catch (e) {
        console.error('start error', e);
        bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.', mainKeyboard());
    }
});

// ===================== PROCEED AFTER JOIN =====================
async function proceedAfterJoin(chatId, from, payload) {
    const username = from.first_name || from.username || ('User' + chatId);
    const existing = await fbGet(`users/${chatId}`);

    if (!existing) {
        // ── NEW USER ──────────────────────────────────────────
        const newUser = {
            chatId, username,
            firstName: from.first_name || '',
            balance: 0,
            isGuest: false,
            createdAt: Date.now()
        };
        if (payload && payload.startsWith('ref_')) {
            const refId = payload.replace('ref_', '');
            if (refId && refId !== chatId) {
                newUser.referredBy = refId;
                newUser.viewsClaimedForThisReferral = false;
            }
        }
        await fbSet(`users/${chatId}`, newUser);

        // Step 1 — Battery loading for account creation
        await typing(chatId, 400);
        const battMsg = await batteryAnimation(chatId, '⚙️  *Creating your account...*');
        await react(chatId, battMsg.message_id, '⚡');
        await sleep(600);

        // Step 2 — Delete battery message & send clean welcome
        await deleteMsg(chatId, battMsg.message_id);
        await typing(chatId, 500);

        const welcomeMsg = await bot.sendMessage(chatId,
            `┌─────────────────────────┐\n` +
            `│   🌟  *WELCOME TO SMM HUB!*  🌟   │\n` +
            `└─────────────────────────┘\n\n` +
            `Hey *${username}* 👋\n\n` +
            `Your account has been created successfully! ✅\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎁  *Your FREE Starter Pack:*\n\n` +
            `   ⭐  10,000 Instagram Views on referral\n` +
            `   💵  ₹2 Daily Cash — every single day\n` +
            `   🚀  Instant SMM services\n` +
            `   🏆  Earn ₹ for every friend you invite\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Tap anything below to get started! 👇`,
            { parse_mode: 'Markdown', ...mainKeyboard() }
        );
        await react(chatId, welcomeMsg.message_id, '🔥');

        if (newUser.referredBy) {
            await maybeSendClaimButton(newUser.referredBy);
        }

    } else {
        // ── RETURNING USER ────────────────────────────────────
        await fbUpdate(`users/${chatId}`, { username, firstName: from.first_name || '' });

        await typing(chatId, 400);

        // Animated greeting — then delete & replace
        const greetFrames = [
            `👋  Hey ${username}!`,
            `👋  Hey ${username}! Welcome`,
            `👋  Hey ${username}! Welcome back`,
            `👋  Hey ${username}! Welcome back! 🎉`
        ];
        const greetMsg = await animate(chatId, greetFrames, 350);
        await sleep(400);
        await deleteMsg(chatId, greetMsg.message_id);

        await typing(chatId, 300);

        const returnEmojis = ['🔥', '💪', '⚡', '🚀', '💎', '👑', '🎯', '🏆'];
        const emoji = returnEmojis[Math.floor(Math.random() * returnEmojis.length)];

        const returnMsg = await bot.sendMessage(chatId,
            `${emoji}  *You're back, ${username}!*\n\n` +
            `Great to see you again! 😎\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💡  Check your daily reward\n` +
            `💡  See if you have referral bonuses\n` +
            `💡  Order new SMM services\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━`,
            { parse_mode: 'Markdown', ...mainKeyboard() }
        );
        await react(chatId, returnMsg.message_id, emoji);

        await maybeSendClaimButton(chatId);
    }
}

// ===================== CALLBACK QUERIES =====================
bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const data = query.data;

    try {
        // ── VERIFY JOIN ─────────────────────────────────────
        if (data === 'verify_join') {
            const joined = await checkAllChannelsJoined(chatId);
            if (!joined) {
                await bot.answerCallbackQuery(query.id, {
                    text: '❌ You have not joined both channels yet! Please join and try again.',
                    show_alert: true
                });
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: '✅ Verified! Unlocking your access...' });
            await deleteMsg(chatId, query.message.message_id);

            await typing(chatId, 300);

            // Battery fill for "unlocking"
            const unlockBatt = await batteryAnimation(chatId, '🔓  *Unlocking your access...*');
            await sleep(300);
            await deleteMsg(chatId, unlockBatt.message_id);

            await typing(chatId, 300);

            const successMsg = await bot.sendMessage(chatId,
                `╔══════════════════════╗\n` +
                `    ✅  *ACCESS GRANTED!*  ✅\n` +
                `╚══════════════════════╝\n\n` +
                `🎊  *Welcome to the family!*\n\n` +
                `You are now a verified member of SMM Hub.\n` +
                `All features are unlocked for you! 🚀\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `✅  Free Views — Unlocked\n` +
                `✅  Daily Rewards — Unlocked\n` +
                `✅  Referral Earnings — Unlocked\n` +
                `✅  SMM Services — Unlocked\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━`,
                { parse_mode: 'Markdown' }
            );
            await react(chatId, successMsg.message_id, '🔥');

            await sleep(600);

            const pending = userState[chatId] || {};
            const payload = pending.pendingStartPayload || null;
            delete userState[chatId];

            await proceedAfterJoin(chatId, query.from, payload);
            return;
        }

        // ── CLAIM VIEWS ─────────────────────────────────────
        if (data === 'claim_views') {
            const unclaimed = await getUnclaimedReferralCount(chatId);
            if (unclaimed <= 0) {
                await bot.answerCallbackQuery(query.id, { text: 'No claims available at the moment.', show_alert: true });
                try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch (e) {}
                return;
            }

            await bot.answerCallbackQuery(query.id);
            try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch (e) {}

            userState[chatId] = { step: 'awaiting_reel_link' };
            await typing(chatId, 500);
            await bot.sendMessage(chatId,
                `🔗  *Send Your Reel Link*\n\n` +
                `Paste your Instagram Reel link below.\n` +
                `We'll deliver *10,000 Views* to it! 🎯`,
                { parse_mode: 'Markdown', ...homeKeyboard() }
            );
            return;
        }

    } catch (e) {
        console.error('callback_query error', e);
        try { await bot.answerCallbackQuery(query.id, { text: '⚠️ Error occurred. Try again.' }); } catch (er) {}
    }
});

// ===================== MESSAGE ROUTER =====================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const state = userState[chatId];

    try {
        // ── REEL LINK STEP ────────────────────────────────
        if (state && state.step === 'awaiting_reel_link') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                await bot.sendMessage(chatId, '🏠 Back to home!', mainKeyboard());
                return;
            }
            const isLink = /^https?:\/\/(www\.)?instagram\.com\/(reel|p|reels)\//i.test(text) || /instagram\.com/i.test(text);
            if (!isLink) {
                await bot.sendMessage(chatId, '❌  That doesn\'t look like a valid Instagram Reel link.\nPlease send the correct link:', homeKeyboard());
                return;
            }

            const referrerChatId = chatId;
            const referredUserId = await getNextUnclaimedReferredUserId(referrerChatId);

            if (!referredUserId) {
                delete userState[chatId];
                await bot.sendMessage(chatId, '❌  No claims available at this time.', mainKeyboard());
                return;
            }

            // Battery animation for placing order
            const battMsg = await batteryAnimation(chatId, '🚀  *Processing your order...*');
            await fbUpdate(`users/${referredUserId}`, { viewsClaimedForThisReferral: true });
            await sleep(300);
            await deleteMsg(chatId, battMsg.message_id);

            await fbPush('referralViewClaims', {
                referrerChatId,
                referrerUsername: msg.from.username || msg.from.first_name || ('user' + referrerChatId),
                referredUserId, reelLink: text,
                views: REFERRAL_VIEWS_REWARD, status: 'placed', createdAt: Date.now()
            });
            delete userState[chatId];

            const doneMsg = await bot.sendMessage(chatId,
                `┌─────────────────────────┐\n` +
                `│  ✅  *ORDER PLACED!*  ✅  │\n` +
                `└─────────────────────────┘\n\n` +
                `🎁  *${REFERRAL_VIEWS_REWARD.toLocaleString()} Views* — Queued!\n` +
                `🔗  ${text}\n\n` +
                `⏳  Views will start within *24–48 hours*.\n` +
                `📩  We'll notify you once delivered!`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );
            await react(chatId, doneMsg.message_id, '🎉');

            if (ADMIN_CHAT_ID) {
                const ref = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
                bot.sendMessage(ADMIN_CHAT_ID,
                    `🆕 *New Referral Views Claim*\n\n👤 Referrer: ${ref} (\`${referrerChatId}\`)\n👥 Referred User: \`${referredUserId}\`\n🔗 Reel: ${text}\n🎁 Views: ${REFERRAL_VIEWS_REWARD.toLocaleString()}`,
                    { parse_mode: 'Markdown' }
                ).catch(e => console.error('admin notify failed', e));
            }

            await maybeSendClaimButton(chatId);
            return;
        }

        // ── AMOUNT STEP ────────────────────────────────────
        if (state && state.step === 'awaiting_deposit_amount') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                await bot.sendMessage(chatId, '🏠 Cancelled. Back to home!', mainKeyboard());
                return;
            }
            const amt = parseFloat(text);
            if (isNaN(amt) || amt < 10) {
                await bot.sendMessage(chatId, '❌  Minimum deposit is ₹10. Please enter a valid amount:', homeKeyboard());
                return;
            }

            // Delete the prompt message if tracked
            if (state.promptMsgId) await deleteMsg(chatId, state.promptMsgId);

            const settings = (await fbGet('settings')) || {};
            const upiId = settings.upiId || 'monisbhai@fam';
            const payeeName = settings.upiPayeeName || 'SMM Panel';
            const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amt.toFixed(2)}&cu=INR&tn=WalletDeposit`;

            await typing(chatId, 400);

            // Battery animation while generating QR
            const genMsg = await batteryAnimation(chatId, '⚙️  *Generating your QR Code...*');
            const qrBuffer = await QRCode.toBuffer(upiLink, {
                width: 512,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            });
            await deleteMsg(chatId, genMsg.message_id);

            // Send QR with share button
            const qrMsg = await bot.sendPhoto(chatId, qrBuffer, {
                caption:
                    `╔══════════════════════╗\n` +
                    `│  💳  *PAYMENT QR CODE*  │\n` +
                    `╚══════════════════════╝\n\n` +
                    `💰  Amount: *₹${amt.toFixed(2)}*\n` +
                    `🏦  Pay to: \`${upiId}\`\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📲  *Scan this QR with any UPI app*\n` +
                    `     PhonePe · GPay · Paytm · BHIM\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `⏰  After payment, send your *12-digit UTR*\n` +
                    `     (Transaction ID) here.\n\n` +
                    `⚠️  *This QR expires in 10 minutes.*`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📤  Share QR Code', switch_inline_query: `Pay ₹${amt.toFixed(2)} to SMM Hub` }],
                        [{ text: '❌  Cancel Payment', callback_data: `cancel_qr_${chatId}` }]
                    ]
                }
            });
            await react(chatId, qrMsg.message_id, '💳');

            userState[chatId] = { step: 'awaiting_utr', amount: amt, qrMsgId: qrMsg.message_id };

            // 10-minute auto-cancel timer
            if (qrTimers[chatId]) clearTimeout(qrTimers[chatId]);
            qrTimers[chatId] = setTimeout(async () => {
                const currentState = userState[chatId];
                if (currentState && currentState.step === 'awaiting_utr') {
                    delete userState[chatId];
                    delete qrTimers[chatId];

                    // Edit the QR photo caption to "expired"
                    try {
                        await bot.editMessageCaption(
                            `⏰  *QR Expired*\n\n` +
                            `Your payment session has timed out after 10 minutes.\n` +
                            `Please tap *Add Fund* again to generate a new QR Code.`,
                            { chat_id: chatId, message_id: currentState.qrMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
                        );
                    } catch (e) {}

                    await typing(chatId, 400);

                    const expMsg = await bot.sendMessage(chatId,
                        `┌─────────────────────────┐\n` +
                        `│  ⏰  *SESSION EXPIRED*  │\n` +
                        `└─────────────────────────┘\n\n` +
                        `Your payment QR has expired after *10 minutes*.\n\n` +
                        `No worries! Tap *💰 Add Fund* again to\n` +
                        `generate a fresh QR Code instantly. 🔄`,
                        { parse_mode: 'Markdown', ...mainKeyboard() }
                    );
                    await react(chatId, expMsg.message_id, '⏰');
                }
            }, QR_TIMEOUT_MS);

            return;
        }

        // ── UTR STEP ────────────────────────────────────
        if (state && state.step === 'awaiting_utr') {
            if (text === '🏠 Home') {
                if (qrTimers[chatId]) { clearTimeout(qrTimers[chatId]); delete qrTimers[chatId]; }
                delete userState[chatId];
                await bot.sendMessage(chatId, '🏠 Payment cancelled. Back to home!', mainKeyboard());
                return;
            }
            if (text.length < 12) {
                await bot.sendMessage(chatId, '❌  Please send a valid 12-digit UTR / Transaction ID:', homeKeyboard());
                return;
            }

            // Clear timer — UTR received in time
            if (qrTimers[chatId]) { clearTimeout(qrTimers[chatId]); delete qrTimers[chatId]; }

            const savedAmt = state.amount;
            const savedQrMsgId = state.qrMsgId;

            // Delete QR message
            if (savedQrMsgId) await deleteMsg(chatId, savedQrMsgId);

            const username = msg.from.username || msg.from.first_name || ('user' + chatId);
            await fbPush('deposits', {
                userId: chatId, username,
                amount: savedAmt, utr: text,
                status: 'pending', createdAt: Date.now()
            });
            delete userState[chatId];

            await typing(chatId, 300);

            const battMsg2 = await batteryAnimation(chatId, '📤  *Submitting payment proof...*');
            await sleep(300);
            await deleteMsg(chatId, battMsg2.message_id);

            await typing(chatId, 300);

            const confirmMsg = await bot.sendMessage(chatId,
                `┌─────────────────────────┐\n` +
                `│  ✅  *PAYMENT SUBMITTED!*  │\n` +
                `└─────────────────────────┘\n\n` +
                `📋  *Details:*\n` +
                `   💰  Amount: ₹${Number(savedAmt).toFixed(2)}\n` +
                `   🔖  UTR: \`${text}\`\n` +
                `   🕐  Status: *Pending Verification*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `⏳  Admin will verify and credit your\n` +
                `     wallet within *30 minutes*.\n` +
                `📩  You will be notified once done! ✅`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );
            await react(chatId, confirmMsg.message_id, '👍');
            return;
        }

        // ── MENU GATE (require membership) ───────────────
        const menuTexts = ['🛍️ Social Media Service', '💰 Add Fund', '👛 Wallet', '🤝 Refer and Earn', '🎁 Daily Reward'];
        if (menuTexts.includes(text)) {
            const joined = await checkAllChannelsJoined(chatId);
            if (!joined) { await sendJoinGate(chatId); return; }
        }

        // ── SOCIAL MEDIA SERVICE ─────────────────────────
        if (text === '🛍️ Social Media Service') {
            await bot.sendMessage(chatId,
                `🛍️  *SMM Panel*\n\nTap below to open our full service panel:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🚀  Open SMM Panel', web_app: { url: MINI_APP_URL } }]]
                    }
                }
            );
            return;
        }

        // ── ADD FUND ──────────────────────────────────────
        if (text === '💰 Add Fund') {
            await typing(chatId, 400);
            const promptMsg = await bot.sendMessage(chatId,
                `💰  *Add Funds to Your Wallet*\n\n` +
                `Enter the amount you want to deposit:\n` +
                `_(Minimum: ₹10)_\n\n` +
                `Tap 🏠 Home to cancel.`,
                { parse_mode: 'Markdown', ...homeKeyboard() }
            );
            userState[chatId] = { step: 'awaiting_deposit_amount', promptMsgId: promptMsg.message_id };
            return;
        }

        // ── WALLET ────────────────────────────────────────
        if (text === '👛 Wallet') {
            await typing(chatId, 400);
            const user = (await fbGet(`users/${chatId}`)) || {};
            const balance = (user.balance || 0).toFixed(2);
            const deposits = (await fbGet('deposits')) || {};
            const myDeposits = Object.values(deposits)
                .filter(d => d.userId === chatId)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 5);

            const depositText = myDeposits.length === 0
                ? '   No deposits yet.'
                : myDeposits.map(d => {
                    const icon = d.status === 'approved' ? '✅' : d.status === 'rejected' ? '❌' : '⏳';
                    return `   ${icon}  ₹${Number(d.amount).toFixed(2)}  ·  UTR: ${d.utr}`;
                }).join('\n');

            const walletMsg = await bot.sendMessage(chatId,
                `╔══════════════════════╗\n` +
                `│  👛  *YOUR WALLET*  │\n` +
                `╚══════════════════════╝\n\n` +
                `💰  Balance: *₹${balance}*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📋  *Recent Deposits:*\n\n` +
                `${depositText}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━`,
                { parse_mode: 'Markdown' }
            );
            await react(chatId, walletMsg.message_id, '💎');
            return;
        }

        // ── REFER AND EARN ────────────────────────────────
        if (text === '🤝 Refer and Earn') {
            try {
                const settings = (await fbGet('settings')) || {};
                const bonus = settings.referralBonus != null ? settings.referralBonus : 10;
                const me = await bot.getMe();
                const refLink = `https://t.me/${me.username}?start=ref_${chatId}`;

                await typing(chatId, 400);

                const refMsg = await bot.sendMessage(chatId,
                    `╔══════════════════════╗\n` +
                    `│  🤝  *REFER & EARN*  │\n` +
                    `╚══════════════════════╝\n\n` +
                    `Share your link — earn rewards!\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🎁  *Per Referral Rewards:*\n\n` +
                    `   🎯  10,000 Free Instagram Views\n` +
                    `   💰  ₹${bonus} on their first deposit\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🔗  *Your Referral Link:*\n` +
                    `\`${refLink}\`\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Share this link with friends! 🚀`,
                    { parse_mode: 'Markdown' }
                );
                await react(chatId, refMsg.message_id, '🤝');
                await maybeSendClaimButton(chatId);
            } catch (e) {
                console.error('Refer and Earn error:', e);
                await bot.sendMessage(chatId, '⚠️ Could not generate referral link. Please try again.', mainKeyboard());
            }
            return;
        }

        // ── DAILY REWARD ──────────────────────────────────
        if (text === '🎁 Daily Reward') {
            const user = (await fbGet(`users/${chatId}`)) || {};
            const settings = (await fbGet('settings')) || {};
            const rewardAmt = settings.dailyRewardAmount != null ? settings.dailyRewardAmount : 2;
            const last = user.lastDailyClaim || 0;
            const now = Date.now();
            const hoursPassed = (now - last) / (1000 * 60 * 60);

            await typing(chatId, 400);

            if (hoursPassed < 24) {
                const remaining = 24 - hoursPassed;
                const h = Math.floor(remaining);
                const m = Math.floor((remaining - h) * 60);
                const waitMsg = await bot.sendMessage(chatId,
                    `⏳  *Daily Reward Not Ready Yet*\n\n` +
                    `You have already claimed today's reward.\n\n` +
                    `⏰  Come back in: *${h}h ${m}m*\n\n` +
                    `See you soon! 👋`,
                    { parse_mode: 'Markdown' }
                );
                await react(chatId, waitMsg.message_id, '⏰');
            } else {
                const newBalance = (user.balance || 0) + rewardAmt;
                await fbUpdate(`users/${chatId}`, { balance: newBalance, lastDailyClaim: now });

                const battMsg3 = await batteryAnimation(chatId, '🎁  *Claiming your daily reward...*');
                await sleep(300);
                await deleteMsg(chatId, battMsg3.message_id);

                await typing(chatId, 300);

                const claimMsg = await bot.sendMessage(chatId,
                    `┌─────────────────────────┐\n` +
                    `│  🎁  *REWARD CLAIMED!*  │\n` +
                    `└─────────────────────────┘\n\n` +
                    `💰  +₹${rewardAmt} added to your wallet!\n` +
                    `📊  New Balance: *₹${newBalance.toFixed(2)}*\n\n` +
                    `Come back tomorrow for another reward! 🔄`,
                    { parse_mode: 'Markdown' }
                );
                await react(chatId, claimMsg.message_id, '🎉');
            }
            return;
        }

    } catch (e) {
        console.error('message handler error', e);
        await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.', mainKeyboard());
    }
});

// ── CANCEL QR via inline button ───────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const data = query.data;
    if (data && data.startsWith('cancel_qr_')) {
        const targetChatId = data.replace('cancel_qr_', '');
        if (targetChatId !== chatId) return;

        if (qrTimers[chatId]) { clearTimeout(qrTimers[chatId]); delete qrTimers[chatId]; }
        delete userState[chatId];

        await bot.answerCallbackQuery(query.id, { text: '❌ Payment cancelled.' });
        await deleteMsg(chatId, query.message.message_id);

        await bot.sendMessage(chatId,
            `❌  *Payment Cancelled*\n\nNo worries! Tap *💰 Add Fund* anytime to try again.`,
            { parse_mode: 'Markdown', ...mainKeyboard() }
        );
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
    console.warn('⚠️ WEBHOOK_URL not set. Bot will not receive messages until this is configured.');
}

app.get('/', (req, res) => res.send('SMM Hub Bot is running ✅'));
app.listen(PORT, () => console.log('Server listening on port ' + PORT));
