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
const QR_TIMEOUT_MS = 10 * 60 * 1000;

const bot = new TelegramBot(BOT_TOKEN);
const app = express();
app.use(express.json());

// ===================== FIREBASE =====================
async function fbGet(path) {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`);
    if (!r.ok) return null;
    return r.json();
}
async function fbSet(path, data) {
    await fetch(`${FIREBASE_DB_URL}/${path}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
async function fbUpdate(path, data) {
    await fetch(`${FIREBASE_DB_URL}/${path}.json`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
async function fbPush(path, data) {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return r.json();
}

// ===================== STATE =====================
const userState = {};
const qrTimers = {};

// ===================== CORE HELPERS =====================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function typing(chatId, ms = 500) {
    try { await bot.sendChatAction(chatId, 'typing'); } catch (e) {}
    await sleep(ms);
}

async function react(chatId, msgId, emoji) {
    try { await bot.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji }]); } catch (e) {}
}

async function del(chatId, msgId) {
    if (!msgId) return;
    try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
}

// Morphing animation — edits a single message through frames
async function morph(chatId, frames, delay = 300, opts = {}) {
    const msg = await bot.sendMessage(chatId, frames[0], { parse_mode: 'Markdown', ...opts });
    for (let i = 1; i < frames.length; i++) {
        await sleep(delay);
        try {
            await bot.editMessageText(frames[i], {
                chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown'
            });
        } catch (e) {}
    }
    return msg;
}

// ===================== BATTERY ANIMATION =====================
// Fills from 10% to 100% — label shows above bar
async function batteryFill(chatId, label) {
    const bar = (n) => {
        const filled = Math.floor(n / 10);
        const empty = 10 - filled;
        return '🟩'.repeat(filled) + '⬛'.repeat(empty) + `  ${n}%`;
    };
    const frames = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(
        n => `${label}\n\n${bar(n)}`
    );
    // Replace last frame with checkmark
    frames[frames.length - 1] = `${label}\n\n🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩  100% ✅`;
    const msg = await bot.sendMessage(chatId, frames[0]);
    for (let i = 1; i < frames.length; i++) {
        await sleep(180);
        try { await bot.editMessageText(frames[i], { chat_id: chatId, message_id: msg.message_id }); } catch (e) {}
    }
    return msg;
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
    return { reply_markup: { keyboard: [[{ text: '🏠 Home' }]], resize_keyboard: true } };
}

function joinKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: `📢 ${CHANNEL_1.label}`, url: CHANNEL_1.link }],
                [{ text: `🔔 ${CHANNEL_2.label}`, url: CHANNEL_2.link }],
                [{ text: '✅ Done — Verify Me', callback_data: 'verify_join' }]
            ]
        }
    };
}

function claimKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [[{ text: '🎁 Claim 10,000 Free Views', callback_data: 'claim_views' }]]
        }
    };
}

// ===================== CHANNEL CHECK =====================
async function isMember(chatId, username) {
    try {
        const m = await bot.getChatMember(`@${username}`, chatId);
        return ['member', 'administrator', 'creator'].includes(m.status);
    } catch (e) { return false; }
}

async function allJoined(chatId) {
    for (const ch of REQUIRED_CHANNELS) {
        if (!(await isMember(chatId, ch.username))) return false;
    }
    return true;
}

// ===================== JOIN GATE =====================
async function sendJoinGate(chatId) {
    await typing(chatId, 500);

    // Clean minimal scan animation
    const scanMsg = await morph(chatId, [
        '🔍 Checking your membership...',
        '🔍 Checking your membership..',
        '🔍 Checking your membership.',
        '❌ Not a member yet!'
    ], 280);
    await react(chatId, scanMsg.message_id, '🤔');
    await sleep(400);

    await typing(chatId, 400);

    // Clean gate message — minimal, no boxes
    const gateMsg = await bot.sendMessage(chatId,
        `🔒 *Join to unlock access*\n\n` +
        `Join both channels below to use this bot.\n` +
        `It's completely free! 👇`,
        { parse_mode: 'Markdown', ...joinKeyboard() }
    );
    await react(chatId, gateMsg.message_id, '👑');
}

// ===================== REFERRAL HELPERS =====================
async function getUnclaimedCount(referrerChatId) {
    const users = (await fbGet('users')) || {};
    let count = 0;
    for (const uid in users) {
        const u = users[uid];
        if (u.referredBy === referrerChatId && !u.viewsClaimedForThisReferral) count++;
    }
    return count;
}

async function getNextUnclaimedUserId(referrerChatId) {
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
    const unclaimed = await getUnclaimedCount(chatId);
    if (unclaimed > 0) {
        await typing(chatId, 400);
        await bot.sendMessage(chatId,
            `🎉 *Referral reward ready!*\n\n` +
            `You have *${unclaimed}* pending referral${unclaimed > 1 ? 's' : ''}.\n` +
            `Claim your *10,000 Free Views* 👇`,
            { parse_mode: 'Markdown', ...claimKeyboard() }
        );
    }
}

// ===================== /start =====================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const payload = match && match[1];
    try {
        const joined = await allJoined(chatId);
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
        // ── NEW USER ──────────────────────────────────────
        const newUser = {
            chatId, username, firstName: from.first_name || '',
            balance: 0, isGuest: false, createdAt: Date.now()
        };
        if (payload && payload.startsWith('ref_')) {
            const refId = payload.replace('ref_', '');
            if (refId && refId !== chatId) {
                newUser.referredBy = refId;
                newUser.viewsClaimedForThisReferral = false;
            }
        }
        await fbSet(`users/${chatId}`, newUser);

        // Battery animation for account setup
        await typing(chatId, 300);
        const battMsg = await batteryFill(chatId, '⚙️ Setting up your account...');
        await react(chatId, battMsg.message_id, '⚡');
        await sleep(400);
        await del(chatId, battMsg.message_id);

        await typing(chatId, 400);

        // Clean welcome — no boxes
        const welcomeMsg = await bot.sendMessage(chatId,
            `🎉 *Welcome, ${username}!*\n\n` +
            `Your SMM Hub account is ready.\n\n` +
            `🎯 10,000 Views — on first referral\n` +
            `💰 Daily ₹2 reward — every day\n` +
            `🤝 Earn per friend you invite\n` +
            `🛍️ Best SMM prices in India\n\n` +
            `Tap anything below to start! 👇`,
            { parse_mode: 'Markdown', ...mainKeyboard() }
        );
        await react(chatId, welcomeMsg.message_id, '🔥');

        if (newUser.referredBy) await maybeSendClaimButton(newUser.referredBy);

    } else {
        // ── RETURNING USER ────────────────────────────────
        await fbUpdate(`users/${chatId}`, { username, firstName: from.first_name || '' });
        await typing(chatId, 400);

        // Animated typing greeting → delete → send final
        const greetMsg = await morph(chatId, [
            `👋 Hey ${username}!`,
            `👋 Hey ${username}! Welcome`,
            `👋 Hey ${username}! Welcome back`,
            `👋 Hey ${username}! Welcome back! 🎉`
        ], 320);
        await sleep(300);
        await del(chatId, greetMsg.message_id);

        await typing(chatId, 300);

        const emojis = ['🔥', '💪', '⚡', '🚀', '💎', '👑'];
        const e = emojis[Math.floor(Math.random() * emojis.length)];

        const retMsg = await bot.sendMessage(chatId,
            `${e} *You're back, ${username}!*\n\nGreat to see you again. 😎`,
            { parse_mode: 'Markdown', ...mainKeyboard() }
        );
        await react(chatId, retMsg.message_id, e);

        await maybeSendClaimButton(chatId);
    }
}

// ===================== CALLBACK QUERIES =====================
bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const data = query.data;

    try {
        // ── VERIFY JOIN ───────────────────────────────────
        if (data === 'verify_join') {
            const joined = await allJoined(chatId);
            if (!joined) {
                await bot.answerCallbackQuery(query.id, {
                    text: '❌ Please join both channels first, then tap Verify.',
                    show_alert: true
                });
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: '✅ Verifying...' });
            await del(chatId, query.message.message_id);
            await typing(chatId, 300);

            // Battery fills to 100% → Access Granted
            const battMsg = await batteryFill(chatId, '🔓 Unlocking access...');
            await sleep(300);
            await del(chatId, battMsg.message_id);

            await typing(chatId, 300);

            // Animated reveal of "Access Granted"
            const accessMsg = await morph(chatId, [
                '✅ 10%... Access Granted',
                '✅ 30%... Access Granted',
                '✅ 50%... Access Granted',
                '✅ 70%... Access Granted',
                '✅ 100% — *Access Granted!* 🎉'
            ], 280);
            await react(chatId, accessMsg.message_id, '🔥');
            await sleep(500);

            const pending = userState[chatId] || {};
            const payload = pending.pendingStartPayload || null;
            delete userState[chatId];

            await proceedAfterJoin(chatId, query.from, payload);
            return;
        }

        // ── CLAIM VIEWS ───────────────────────────────────
        if (data === 'claim_views') {
            const unclaimed = await getUnclaimedCount(chatId);
            if (unclaimed <= 0) {
                await bot.answerCallbackQuery(query.id, { text: 'No claims available right now.', show_alert: true });
                try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch (e) {}
                return;
            }
            await bot.answerCallbackQuery(query.id);
            try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch (e) {}

            userState[chatId] = { step: 'awaiting_reel_link' };
            await typing(chatId, 500);
            await bot.sendMessage(chatId,
                `🔗 *Paste your Instagram Reel link*\n\nWe'll send *10,000 Views* to it! 🎯`,
                { parse_mode: 'Markdown', ...homeKeyboard() }
            );
            return;
        }

        // ── CANCEL QR ─────────────────────────────────────
        if (data && data.startsWith('cancel_qr_')) {
            const target = data.replace('cancel_qr_', '');
            if (target !== chatId) return;
            if (qrTimers[chatId]) { clearTimeout(qrTimers[chatId]); delete qrTimers[chatId]; }
            delete userState[chatId];
            await bot.answerCallbackQuery(query.id, { text: '❌ Payment cancelled.' });
            await del(chatId, query.message.message_id);
            await bot.sendMessage(chatId,
                `❌ Payment cancelled.\n\nTap *💰 Add Fund* anytime to try again.`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );
            return;
        }

    } catch (e) {
        console.error('callback_query error', e);
        try { await bot.answerCallbackQuery(query.id, { text: '⚠️ Error. Try again.' }); } catch (er) {}
    }
});

// ===================== MESSAGE ROUTER =====================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const state = userState[chatId];

    try {

        // ── REEL LINK ─────────────────────────────────────
        if (state && state.step === 'awaiting_reel_link') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                await bot.sendMessage(chatId, '🏠 Back to home.', mainKeyboard());
                return;
            }
            const isLink = /^https?:\/\/(www\.)?instagram\.com\/(reel|p|reels)\//i.test(text) || /instagram\.com/i.test(text);
            if (!isLink) {
                await bot.sendMessage(chatId, '❌ That\'s not a valid Instagram Reel link. Please try again:', homeKeyboard());
                return;
            }
            const referredUserId = await getNextUnclaimedUserId(chatId);
            if (!referredUserId) {
                delete userState[chatId];
                await bot.sendMessage(chatId, '❌ No claims available right now.', mainKeyboard());
                return;
            }

            await typing(chatId, 300);
            const battMsg = await batteryFill(chatId, '🚀 Processing your order...');
            await fbUpdate(`users/${referredUserId}`, { viewsClaimedForThisReferral: true });
            await sleep(300);
            await del(chatId, battMsg.message_id);

            await fbPush('referralViewClaims', {
                referrerChatId: chatId,
                referrerUsername: msg.from.username || msg.from.first_name || ('user' + chatId),
                referredUserId, reelLink: text,
                views: REFERRAL_VIEWS_REWARD, status: 'placed', createdAt: Date.now()
            });
            delete userState[chatId];

            await typing(chatId, 300);
            const doneMsg = await bot.sendMessage(chatId,
                `✅ *Order placed!*\n\n` +
                `🎁 ${REFERRAL_VIEWS_REWARD.toLocaleString()} Views queued\n` +
                `🔗 ${text}\n\n` +
                `⏳ Views start within 24–48 hours.`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );
            await react(chatId, doneMsg.message_id, '🎉');

            if (ADMIN_CHAT_ID) {
                const ref = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
                bot.sendMessage(ADMIN_CHAT_ID,
                    `🆕 *New Referral Views Claim*\n\n👤 ${ref} (\`${chatId}\`)\n👥 Referred: \`${referredUserId}\`\n🔗 ${text}\n🎁 ${REFERRAL_VIEWS_REWARD.toLocaleString()} Views`,
                    { parse_mode: 'Markdown' }
                ).catch(e => console.error('admin notify failed', e));
            }

            await maybeSendClaimButton(chatId);
            return;
        }

        // ── DEPOSIT AMOUNT ────────────────────────────────
        if (state && state.step === 'awaiting_deposit_amount') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                await bot.sendMessage(chatId, '🏠 Cancelled.', mainKeyboard());
                return;
            }
            const amt = parseFloat(text);
            if (isNaN(amt) || amt < 10) {
                await bot.sendMessage(chatId, '❌ Minimum is ₹10. Enter a valid amount:', homeKeyboard());
                return;
            }
            if (state.promptMsgId) await del(chatId, state.promptMsgId);

            const settings = (await fbGet('settings')) || {};
            const upiId = settings.upiId || 'monisbhai@fam';
            const payeeName = settings.upiPayeeName || 'SMM Panel';
            const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amt.toFixed(2)}&cu=INR&tn=WalletDeposit`;

            await typing(chatId, 300);

            // Battery animation while generating QR
            const genMsg = await batteryFill(chatId, '⚙️ Generating your QR Code...');
            const qrBuffer = await QRCode.toBuffer(upiLink, {
                width: 512, margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            });
            await del(chatId, genMsg.message_id);

            // QR photo — clean caption, Cancel button only (no share)
            const qrMsg = await bot.sendPhoto(chatId, qrBuffer, {
                caption:
                    `💳 *Payment QR*\n\n` +
                    `Amount: *₹${amt.toFixed(2)}*\n` +
                    `UPI ID: \`${upiId}\`\n\n` +
                    `Scan with PhonePe · GPay · Paytm · BHIM\n\n` +
                    `After paying, send your *12-digit UTR* here.\n` +
                    `⚠️ This QR expires in *10 minutes*.`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancel', callback_data: `cancel_qr_${chatId}` }]
                    ]
                }
            });
            await react(chatId, qrMsg.message_id, '💳');

            userState[chatId] = { step: 'awaiting_utr', amount: amt, qrMsgId: qrMsg.message_id };

            // 10-min timeout
            if (qrTimers[chatId]) clearTimeout(qrTimers[chatId]);
            qrTimers[chatId] = setTimeout(async () => {
                const cur = userState[chatId];
                if (cur && cur.step === 'awaiting_utr') {
                    delete userState[chatId];
                    delete qrTimers[chatId];
                    try {
                        await bot.editMessageCaption(
                            `⏰ *QR Expired*\n\nThis payment session has timed out.\nTap *💰 Add Fund* to generate a new QR.`,
                            { chat_id: chatId, message_id: cur.qrMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
                        );
                    } catch (e) {}
                    await typing(chatId, 300);
                    const expMsg = await bot.sendMessage(chatId,
                        `⏰ *Session expired.*\n\nYour QR code timed out after 10 minutes.\nTap *💰 Add Fund* to try again.`,
                        { parse_mode: 'Markdown', ...mainKeyboard() }
                    );
                    await react(chatId, expMsg.message_id, '⏰');
                }
            }, QR_TIMEOUT_MS);

            return;
        }

        // ── UTR ───────────────────────────────────────────
        if (state && state.step === 'awaiting_utr') {
            if (text === '🏠 Home') {
                if (qrTimers[chatId]) { clearTimeout(qrTimers[chatId]); delete qrTimers[chatId]; }
                delete userState[chatId];
                await bot.sendMessage(chatId, '🏠 Payment cancelled.', mainKeyboard());
                return;
            }
            if (text.length < 12) {
                await bot.sendMessage(chatId, '❌ Send a valid 12-digit UTR / Transaction ID:', homeKeyboard());
                return;
            }

            if (qrTimers[chatId]) { clearTimeout(qrTimers[chatId]); delete qrTimers[chatId]; }

            const savedAmt = state.amount;
            const savedQrMsgId = state.qrMsgId;
            if (savedQrMsgId) await del(chatId, savedQrMsgId);

            const username = msg.from.username || msg.from.first_name || ('user' + chatId);
            await fbPush('deposits', {
                userId: chatId, username,
                amount: savedAmt, utr: text,
                status: 'pending', createdAt: Date.now()
            });
            delete userState[chatId];

            await typing(chatId, 300);
            const battMsg2 = await batteryFill(chatId, '📤 Submitting payment proof...');
            await sleep(300);
            await del(chatId, battMsg2.message_id);

            await typing(chatId, 300);
            const confirmMsg = await bot.sendMessage(chatId,
                `✅ *Payment submitted!*\n\n` +
                `Amount: ₹${Number(savedAmt).toFixed(2)}\n` +
                `UTR: \`${text}\`\n` +
                `Status: Pending verification\n\n` +
                `Admin will verify and credit your wallet within 30 minutes. 📩`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );
            await react(chatId, confirmMsg.message_id, '👍');
            return;
        }

        // ── MENU GATE ─────────────────────────────────────
        const menuTexts = ['🛍️ Social Media Service', '💰 Add Fund', '👛 Wallet', '🤝 Refer and Earn', '🎁 Daily Reward'];
        if (menuTexts.includes(text)) {
            const joined = await allJoined(chatId);
            if (!joined) { await sendJoinGate(chatId); return; }
        }

        // ── SOCIAL MEDIA SERVICE ──────────────────────────
        if (text === '🛍️ Social Media Service') {
            await typing(chatId, 400);

            // Animated launch sequence then send the button
            const launchMsg = await morph(chatId, [
                '🛍️ Loading SMM Panel...',
                '🛍️ Loading SMM Panel..',
                '🛍️ Loading SMM Panel.',
                '🚀 Ready! Tap below to open 👇'
            ], 300);
            await react(chatId, launchMsg.message_id, '🚀');

            await sleep(300);
            await del(chatId, launchMsg.message_id);

            const panelMsg = await bot.sendMessage(chatId,
                `🛍️ *SMM Panel*\n\nTap below to open the app:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🚀 Open SMM Panel', web_app: { url: MINI_APP_URL } }]]
                    }
                }
            );
            await react(chatId, panelMsg.message_id, '🛍️');
            return;
        }

        // ── ADD FUND ──────────────────────────────────────
        if (text === '💰 Add Fund') {
            await typing(chatId, 400);
            const promptMsg = await bot.sendMessage(chatId,
                `💰 *Add Funds*\n\nEnter the amount to deposit:\n_(Minimum ₹10)_\n\nTap 🏠 Home to cancel.`,
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

            const depositLines = myDeposits.length === 0
                ? 'No deposits yet.'
                : myDeposits.map(d => {
                    const icon = d.status === 'approved' ? '✅' : d.status === 'rejected' ? '❌' : '⏳';
                    return `${icon} ₹${Number(d.amount).toFixed(2)} · UTR: ${d.utr}`;
                }).join('\n');

            const walletMsg = await bot.sendMessage(chatId,
                `👛 *Your Wallet*\n\n` +
                `Balance: *₹${balance}*\n\n` +
                `Recent deposits:\n${depositLines}`,
                { parse_mode: 'Markdown' }
            );
            await react(chatId, walletMsg.message_id, '💎');
            return;
        }

        // ── REFER AND EARN ────────────────────────────────
        if (text === '🤝 Refer and Earn') {
            try {
                await typing(chatId, 400);
                const settings = (await fbGet('settings')) || {};
                const bonus = settings.referralBonus != null ? settings.referralBonus : 10;
                const me = await bot.getMe();
                const refLink = `https://t.me/${me.username}?start=ref_${chatId}`;

                const refMsg = await bot.sendMessage(chatId,
                    `🤝 *Refer & Earn*\n\n` +
                    `Share your link and earn rewards:\n\n` +
                    `🎯 10,000 Free Instagram Views\n` +
                    `💰 ₹${bonus} on their first deposit\n\n` +
                    `Your link:\n\`${refLink}\``,
                    { parse_mode: 'Markdown' }
                );
                await react(chatId, refMsg.message_id, '🤝');
                await maybeSendClaimButton(chatId);
            } catch (e) {
                console.error('Refer and Earn error:', e);
                await bot.sendMessage(chatId, '⚠️ Could not load referral link. Please try again.', mainKeyboard());
            }
            return;
        }

        // ── DAILY REWARD ──────────────────────────────────
        if (text === '🎁 Daily Reward') {
            await typing(chatId, 400);
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
                const waitMsg = await bot.sendMessage(chatId,
                    `⏳ *Already claimed today!*\n\nCome back in *${h}h ${m}m*. 👋`,
                    { parse_mode: 'Markdown' }
                );
                await react(chatId, waitMsg.message_id, '⏰');
            } else {
                const newBalance = (user.balance || 0) + rewardAmt;
                await fbUpdate(`users/${chatId}`, { balance: newBalance, lastDailyClaim: now });

                const battMsg3 = await batteryFill(chatId, '🎁 Claiming your reward...');
                await sleep(300);
                await del(chatId, battMsg3.message_id);

                await typing(chatId, 300);
                const claimMsg = await bot.sendMessage(chatId,
                    `🎁 *Reward claimed!*\n\n` +
                    `+₹${rewardAmt} added to your wallet!\n` +
                    `New balance: *₹${newBalance.toFixed(2)}*\n\n` +
                    `Come back tomorrow for more! 🔄`,
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

// ===================== WEBHOOK =====================
if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    console.log('Webhook active:', `${WEBHOOK_URL}/bot${BOT_TOKEN}`);
} else {
    console.warn('⚠️ WEBHOOK_URL not set. Configure it after deploy.');
}

app.get('/', (req, res) => res.send('SMM Hub Bot ✅'));
app.listen(PORT, () => console.log('Listening on port ' + PORT));
