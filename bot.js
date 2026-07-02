const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || '8781119793:AAESRUPn6-d4XAfMevf8ETdBS2ordbyc6eQ';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // e.g. https://your-app.up.railway.app  (set this AFTER first deploy)
const MINI_APP_URL = process.env.MINI_APP_URL || 'YOUR_NETLIFY_URL_HERE'; // <-- PASTE YOUR index.html NETLIFY LINK HERE
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://smmhub-1e20c-default-rtdb.firebaseio.com';
const PORT = process.env.PORT || 3000;

// ---- Admin (fixed chat id jaha reel link + claim notify jayega) ----
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'PASTE_YOUR_ADMIN_CHAT_ID_HERE';

// ---- Mandatory Join Channels ----
const CHANNEL_1 = { username: 'smmhubrobo', label: 'SMM Hub Official', link: 'https://t.me/smmhubrobo' };
const CHANNEL_2 = { username: 'smmhuboffical', label: 'Notification Channel', link: 'https://t.me/smmhuboffical' };
const REQUIRED_CHANNELS = [CHANNEL_1, CHANNEL_2];

// ---- Referral reward ----
const REFERRAL_VIEWS_REWARD = 10000; // 10k views

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
// Tracks multi-step flows like "Add Fund" (amount -> UTR) and "Claim Views" (reel link)
const userState = {};

// ===================== SMALL ANIMATION HELPERS =====================
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Edits a message a few times to fake a "loading" animation (dots cycling)
async function animateLoading(chatId, baseText, frames = 3, delay = 350) {
    const dots = ['.', '..', '...'];
    const sent = await bot.sendMessage(chatId, `${baseText}${dots[0]}`);
    for (let i = 1; i < frames; i++) {
        await sleep(delay);
        try {
            await bot.editMessageText(`${baseText}${dots[i % dots.length]}`, {
                chat_id: chatId,
                message_id: sent.message_id
            });
        } catch (e) { /* ignore edit race errors */ }
    }
    return sent;
}

// Simple "typing..." presence animation before a message
async function withTyping(chatId, ms = 700) {
    try { await bot.sendChatAction(chatId, 'typing'); } catch (e) {}
    await sleep(ms);
}

// Progress-bar style animation, e.g. for order placement
async function animateProgressBar(chatId, label = '🚀 Placing your order') {
    const sent = await bot.sendMessage(chatId, `${label}\n▱▱▱▱▱▱▱▱▱▱ 0%`);
    const steps = [
        '▰▰▱▱▱▱▱▱▱▱ 20%',
        '▰▰▰▰▱▱▱▱▱▱ 40%',
        '▰▰▰▰▰▰▱▱▱▱ 60%',
        '▰▰▰▰▰▰▰▰▱▱ 80%',
        '▰▰▰▰▰▰▰▰▰▰ 100% ✅'
    ];
    for (const s of steps) {
        await sleep(300);
        try {
            await bot.editMessageText(`${label}\n${s}`, {
                chat_id: chatId,
                message_id: sent.message_id
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
            keyboard: [
                [{ text: '🏠 Home' }]
            ],
            resize_keyboard: true
        }
    };
}

function joinChannelsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: `📢 Join ${CHANNEL_1.label}`, url: CHANNEL_1.link }],
                [{ text: `🔔 Join ${CHANNEL_2.label}`, url: CHANNEL_2.link }],
                [{ text: '✅ I Have Joined - Verify', callback_data: 'verify_join' }]
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

// ===================== CHANNEL MEMBERSHIP CHECK =====================
async function isMemberOf(chatId, channelUsername) {
    try {
        const member = await bot.getChatMember(`@${channelUsername}`, chatId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (e) {
        console.error(`getChatMember failed for @${channelUsername}:`, e.message);
        // If bot isn't admin in the channel or channel is wrong, fail closed (treat as not joined)
        return false;
    }
}

async function checkAllChannelsJoined(chatId) {
    for (const ch of REQUIRED_CHANNELS) {
        const joined = await isMemberOf(chatId, ch.username);
        if (!joined) return false;
    }
    return true;
}

async function sendJoinGate(chatId) {
    await bot.sendMessage(
        chatId,
        `🔒 *Access Locked*\n\nBot use karne ke liye pehle neeche diye gaye channels join karo, phir "✅ I Have Joined" dabao.`,
        { parse_mode: 'Markdown', ...joinChannelsKeyboard() }
    );
}

// ===================== COUNT UNCLAIMED REFERRAL REWARDS =====================
// Returns how many of "referrerChatId"'s referred users have not yet been claimed for views
async function getUnclaimedReferralCount(referrerChatId) {
    const users = (await fbGet('users')) || {};
    let count = 0;
    for (const uid in users) {
        const u = users[uid];
        if (u.referredBy === referrerChatId && !u.viewsClaimedForThisReferral) {
            count++;
        }
    }
    return count;
}

// Finds the oldest unclaimed referred user id for a given referrer (to mark claimed)
async function getNextUnclaimedReferredUserId(referrerChatId) {
    const users = (await fbGet('users')) || {};
    let candidates = [];
    for (const uid in users) {
        const u = users[uid];
        if (u.referredBy === referrerChatId && !u.viewsClaimedForThisReferral) {
            candidates.push({ uid, createdAt: u.createdAt || 0 });
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    return candidates[0].uid;
}

async function maybeSendClaimButton(chatId) {
    const unclaimed = await getUnclaimedReferralCount(chatId);
    if (unclaimed > 0) {
        await withTyping(chatId, 500);
        await bot.sendMessage(
            chatId,
            `🎉 *Referral Bonus Available!*\n\nAapke ${unclaimed} referral${unclaimed > 1 ? 's' : ''} ke liye 10,000 Free Views claim kar sakte ho!`,
            { parse_mode: 'Markdown', ...claimViewsKeyboard() }
        );
    }
}

// ===================== /start =====================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || msg.from.first_name || ('user' + chatId);
    const payload = match && match[1];

    try {
        // ---- STEP 1: Channel join gate ----
        const joined = await checkAllChannelsJoined(chatId);
        if (!joined) {
            // Stash the /start payload so we remember referral even before verification
            userState[chatId] = { pendingStartPayload: payload || null };
            await sendJoinGate(chatId);
            return;
        }

        await proceedAfterJoin(chatId, msg.from, payload);
    } catch (e) {
        console.error('start error', e);
        bot.sendMessage(chatId, '⚠️ Something went wrong, please try again.', mainKeyboard());
    }
});

// Runs once we know the user has joined both channels (either directly on /start, or after verify button)
async function proceedAfterJoin(chatId, from, payload) {
    const username = from.username || from.first_name || ('user' + chatId);
    const existing = await fbGet(`users/${chatId}`);

    if (!existing) {
        const newUser = {
            chatId,
            username,
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

        // Nice welcome animation
        await withTyping(chatId, 600);
        await bot.sendMessage(chatId, `✅ *Welcome ${username}!*\n\n🎉 Aapka account ready hai!`, { parse_mode: 'Markdown' });
        await sleep(400);
        await bot.sendMessage(chatId, `🛍️ Ab aap services order kar sakte ho, wallet manage kar sakte ho, aur refer karke earn kar sakte ho!`, mainKeyboard());

        // If this new user was referred, notify the referrer that a claim is now available
        if (newUser.referredBy) {
            await maybeSendClaimButton(newUser.referredBy);
        }
    } else {
        await fbUpdate(`users/${chatId}`, { username, firstName: from.first_name || '' });
        await withTyping(chatId, 400);
        await bot.sendMessage(chatId, `✅ *Welcome back, ${username}!*`, { parse_mode: 'Markdown', ...mainKeyboard() });

        // Also show claim button if they have unclaimed referrals sitting around
        await maybeSendClaimButton(chatId);
    }
}

// ===================== CALLBACK QUERIES (inline buttons) =====================
bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const data = query.data;

    try {
        if (data === 'verify_join') {
            const joined = await checkAllChannelsJoined(chatId);
            if (!joined) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Aapne abhi tak dono channels join nahi kiye!', show_alert: true });
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: '✅ Verified! Starting bot...' });

            // Remove the join-gate message so old prompt doesn't linger in chat
            try { await bot.deleteMessage(chatId, query.message.message_id); } catch (e) {}

            const pending = userState[chatId] || {};
            const payload = pending.pendingStartPayload || null;
            delete userState[chatId];

            await proceedAfterJoin(chatId, query.from, payload);
            return;
        }

        if (data === 'claim_views') {
            // Re-check they actually still have an unclaimed referral (avoid double-claim races)
            const unclaimed = await getUnclaimedReferralCount(chatId);
            if (unclaimed <= 0) {
                await bot.answerCallbackQuery(query.id, { text: 'Koi claim available nahi hai.', show_alert: true });
                try {
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
                } catch (e) {}
                return;
            }

            await bot.answerCallbackQuery(query.id);

            // Remove the claim button immediately so it can't be double-tapped
            try {
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            } catch (e) {}

            userState[chatId] = { step: 'awaiting_reel_link' };
            await withTyping(chatId, 500);
            await bot.sendMessage(
                chatId,
                `🔗 *Reel Link Bhejo*\n\nApni Instagram Reel ka link paste karo jispe 10,000 views chahiye:`,
                { parse_mode: 'Markdown', ...homeKeyboard() }
            );
            return;
        }
    } catch (e) {
        console.error('callback_query error', e);
        try { await bot.answerCallbackQuery(query.id, { text: '⚠️ Error, try again.' }); } catch (er) {}
    }
});

// ===================== MESSAGE ROUTER =====================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const state = userState[chatId];

    try {
        // ---- Gate: block all interactions until channels are joined ----
        // (skip this check for users mid-flow with no state, to avoid extra API calls on every message spam;
        //  we still gate the actual menu actions below via a single check)

        // ---- Step: waiting for reel link (referral claim) ----
        if (state && state.step === 'awaiting_reel_link') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                bot.sendMessage(chatId, '🏠 Wapas aa gaye! Kya karna hai?', mainKeyboard());
                return;
            }

            const isLikelyLink = /^https?:\/\/(www\.)?instagram\.com\/(reel|p|reels)\//i.test(text) || /instagram\.com/i.test(text);
            if (!isLikelyLink) {
                bot.sendMessage(chatId, '❌ Ye valid Instagram Reel link nahi lag raha. Sahi link bhejo:', homeKeyboard());
                return;
            }

            const referrerChatId = chatId;
            const referredUserId = await getNextUnclaimedReferredUserId(referrerChatId);

            if (!referredUserId) {
                delete userState[chatId];
                bot.sendMessage(chatId, '❌ Koi claim available nahi hai ab.', mainKeyboard());
                return;
            }

            // Animate "placing order"
            const progressMsg = await animateProgressBar(chatId, '🚀 Placing your order');

            // Mark this referral as claimed (backend)
            await fbUpdate(`users/${referredUserId}`, { viewsClaimedForThisReferral: true });

            // Log the claim/order in Firebase for admin panel visibility
            await fbPush('referralViewClaims', {
                referrerChatId,
                referrerUsername: msg.from.username || msg.from.first_name || ('user' + referrerChatId),
                referredUserId,
                reelLink: text,
                views: REFERRAL_VIEWS_REWARD,
                status: 'placed',
                createdAt: Date.now()
            });

            delete userState[chatId];

            await sleep(300);
            await bot.sendMessage(
                chatId,
                `✅ *Order Placed Successfully!*\n\n🎁 ${REFERRAL_VIEWS_REWARD.toLocaleString()} Views\n🔗 ${text}\n\n⏳ Views 24-48 hours me start ho jayenge.`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );

            // Forward reel link + user info to admin
            if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'PASTE_YOUR_ADMIN_CHAT_ID_HERE') {
                const referrerUsername = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
                bot.sendMessage(
                    ADMIN_CHAT_ID,
                    `🆕 *New Referral Views Claim*\n\n👤 Referrer: ${referrerUsername} (\`${referrerChatId}\`)\n👥 Referred User ID: \`${referredUserId}\`\n🔗 Reel Link: ${text}\n🎁 Views: ${REFERRAL_VIEWS_REWARD.toLocaleString()}\n\n⚡ Please fulfill this order manually / via provider.`,
                    { parse_mode: 'Markdown' }
                ).catch(e => console.error('admin notify failed', e));
            }

            // If there are still more unclaimed referrals, show the button again
            await maybeSendClaimButton(chatId);
            return;
        }

        // ---- Step: waiting for deposit amount ----
        if (state && state.step === 'awaiting_deposit_amount') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                bot.sendMessage(chatId, '🏠 Wapas aa gaye! Kya karna hai?', mainKeyboard());
                return;
            }
            const amt = parseFloat(text);
            if (isNaN(amt) || amt < 10) {
                bot.sendMessage(chatId, '❌ Minimum ₹10 enter karo:', homeKeyboard());
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

        // ---- Step: waiting for UTR ----
        if (state && state.step === 'awaiting_utr') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                bot.sendMessage(chatId, '🏠 Wapas aa gaye! Kya karna hai?', mainKeyboard());
                return;
            }
            if (text.length < 12) {
                bot.sendMessage(chatId, '❌ Valid 12-digit UTR bhejo:', homeKeyboard());
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

        // ---- All menu actions below require channel membership ----
        const menuTexts = ['🛍️ Social Media Service', '💰 Add Fund', '👛 Wallet', '🤝 Refer and Earn', '🎁 Daily Reward'];
        if (menuTexts.includes(text)) {
            const joined = await checkAllChannelsJoined(chatId);
            if (!joined) {
                await sendJoinGate(chatId);
                return;
            }
        }

        // ---- Menu: Social Media Service ----
        if (text === '🛍️ Social Media Service') {
            bot.sendMessage(chatId, '🛍️ Neeche button dabao:', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🚀 Open SMM Panel', web_app: { url: MINI_APP_URL } }
                    ]]
                }
            });
            return;
        }

        // ---- Menu: Add Fund ----
        if (text === '💰 Add Fund') {
            userState[chatId] = { step: 'awaiting_deposit_amount' };
            bot.sendMessage(chatId, '💰 Kitna add karna hai? (Minimum ₹10)\n\nCancel karne ke liye Home dabao:', homeKeyboard());
            return;
        }

        // ---- Menu: Wallet ----
        if (text === '👛 Wallet') {
            const user = (await fbGet(`users/${chatId}`)) || {};
            const balance = (user.balance || 0).toFixed(2);
            const deposits = (await fbGet('deposits')) || {};
            const myDeposits = Object.values(deposits)
                .filter(d => d.userId === chatId)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 5);

            let depositText = myDeposits.length === 0 ? 'Koi deposit nahi abhi tak.' :
                myDeposits.map(d => {
                    const status = d.status === 'approved' ? '✅' : d.status === 'rejected' ? '❌' : '⏳';
                    return `${status} ₹${Number(d.amount).toFixed(2)} — UTR: ${d.utr}`;
                }).join('\n');

            bot.sendMessage(chatId,
                `👛 *Tera Wallet*\n\n💰 Balance: *₹${balance}*\n\n📋 *Recent Deposits:*\n${depositText}`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // ---- Menu: Refer and Earn ----
        if (text === '🤝 Refer and Earn') {
            const settings = (await fbGet('settings')) || {};
            const bonus = settings.referralBonus != null ? settings.referralBonus : 10;
            const me = await bot.getMe();
            const refLink = `https://t.me/${me.username}?start=ref_${chatId}`;
            await bot.sendMessage(
                chatId,
                `🤝 *Refer & Earn*\n\nShare your link with friends. When they join, you get *${REFERRAL_VIEWS_REWARD.toLocaleString()} Free Views* claimable instantly! Plus ₹${bonus} on their first approved deposit.\n\nYour referral link:\n${refLink}`,
                { parse_mode: 'Markdown' }
            );
            // Also show claim button here if any pending
            await maybeSendClaimButton(chatId);
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

app.get('/', (req, res) => res.send('Fire SMM Bot is running ✅'));

app.listen(PORT, () => console.log('Server listening on port ' + PORT));
