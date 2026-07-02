const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || '8781119793:AAESRUPn6-d4XAfMevf8ETdBS2ordbyc6eQ';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // e.g. https://your-app.up.railway.app  (set this AFTER first deploy)
const MINI_APP_URL = process.env.MINI_APP_URL || 'YOUR_NETLIFY_URL_HERE'; // <-- PASTE YOUR index.html NETLIFY LINK HERE
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://smmhub-1e20c-default-rtdb.firebaseio.com';
const PORT = process.env.PORT || 3000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '6270522295';

// ---- Force-join channels ----
const FORCE_CHANNELS = [
    { name: 'SMM Hub Official', username: '@smmhubrobo', url: 'https://t.me/smmhubrobo' },
    { name: 'Notification Channel', username: '@smmhuboffical', url: 'https://t.me/smmhuboffical' }
];

// ---- Referral free-views reward ----
const REFERRAL_FREE_VIEWS = 10000;

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

// Tracks the message_id of the "please join channels" prompt per user,
// so we can delete it once they successfully join.
const joinPromptMsg = {};

// ===================== FORCE-JOIN HELPERS =====================
async function isMemberOfChannel(chatId, channelUsername) {
    try {
        const member = await bot.getChatMember(channelUsername, chatId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (e) {
        console.error('getChatMember error for', channelUsername, e.message);
        return false; // if bot isn't admin in channel or any error, treat as not-joined
    }
}

async function getUnjoinedChannels(chatId) {
    const results = await Promise.all(
        FORCE_CHANNELS.map(async (ch) => ({
            ch,
            joined: await isMemberOfChannel(chatId, ch.username)
        }))
    );
    return results.filter(r => !r.joined).map(r => r.ch);
}

function joinKeyboard(unjoined) {
    const rows = unjoined.map(ch => ([{ text: `📢 Join ${ch.name}`, url: ch.url }]));
    rows.push([{ text: "✅ I've Joined", callback_data: 'check_join' }]);
    return { reply_markup: { inline_keyboard: rows } };
}

async function sendJoinPrompt(chatId) {
    const unjoined = await getUnjoinedChannels(chatId);
    if (unjoined.length === 0) return null;

    const sent = await bot.sendMessage(
        chatId,
        `🔒 *Access Locked!*\n\n🚀 Humare official channels join karo taaki bot start ho sake:\n\n${unjoined.map(c => `📢 ${c.name}`).join('\n')}\n\nJoin karne ke baad neeche "✅ I've Joined" dabao 👇`,
        { parse_mode: 'Markdown', ...joinKeyboard(unjoined) }
    );
    joinPromptMsg[chatId] = sent.message_id;
    return sent;
}

// Deletes the "please join" prompt message (the rough/clutter message)
async function clearJoinPrompt(chatId) {
    const mid = joinPromptMsg[chatId];
    if (mid) {
        try { await bot.deleteMessage(chatId, mid); } catch (e) {}
        delete joinPromptMsg[chatId];
    }
}

// Animated welcome sequence after successful join / start
async function playWelcomeAnimation(chatId, username) {
    const frames = ['🚀', '🚀 ✨', '🚀 ✨ 🎉'];
    let m;
    try {
        m = await bot.sendMessage(chatId, `${frames[0]} Starting up...`);
        for (let i = 1; i < frames.length; i++) {
            await new Promise(r => setTimeout(r, 400));
            try { await bot.editMessageText(`${frames[i]} Starting up...`, { chat_id: chatId, message_id: m.message_id }); } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 400));
        try {
            await bot.editMessageText(`✅ *Welcome, ${username}!*\n\n🎊 You're all set to explore SMM Hub 🎊`, {
                chat_id: chatId,
                message_id: m.message_id,
                parse_mode: 'Markdown'
            });
        } catch (e) {}
    } catch (e) {
        console.error('welcome animation error', e);
    }
}

// ===================== REFERRAL CLAIM HELPERS =====================
async function offerReferralClaim(referrerChatId) {
    try {
        const refUser = await fbGet(`users/${referrerChatId}`);
        if (!refUser) return;
        await bot.sendMessage(
            referrerChatId,
            `🎉 *Your friend just joined using your link!*\n\n🎁 You've unlocked *${REFERRAL_FREE_VIEWS.toLocaleString()} Free Views*!\n\nClaim it now 👇`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `🎁 Claim ${REFERRAL_FREE_VIEWS.toLocaleString()} Views Free`, callback_data: 'claim_free_views' }
                    ]]
                }
            }
        );
    } catch (e) {
        console.error('offerReferralClaim error', e);
    }
}

// ===================== KEYBOARD =====================
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

// ===================== /start =====================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const payload = match && match[1];

    try {
        if (payload && payload.startsWith('ref_')) {
            userState[chatId] = { ...(userState[chatId] || {}), pendingRef: payload.replace('ref_', '') };
        }

        const unjoined = await getUnjoinedChannels(chatId);
        if (unjoined.length > 0) {
            await sendJoinPrompt(chatId);
            return; // bot will NOT start until they join
        }

        await completeStart(chatId, msg.from, userState[chatId]?.pendingRef);
    } catch (e) {
        console.error('start error', e);
        bot.sendMessage(chatId, '⚠️ Something went wrong, please try again.', mainKeyboard());
    }
});

// Runs the actual account-creation + welcome flow once channel membership is confirmed
async function completeStart(chatId, from, pendingRef) {
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
        if (pendingRef && pendingRef !== chatId) {
            newUser.referredBy = pendingRef;
        }
        await fbSet(`users/${chatId}`, newUser);

        if (pendingRef && pendingRef !== chatId) {
            offerReferralClaim(pendingRef);
        }
    } else {
        await fbUpdate(`users/${chatId}`, { username, firstName: from.first_name || '' });
    }

    delete userState[chatId];
    await playWelcomeAnimation(chatId, username);
    await bot.sendMessage(chatId, `👇 Neeche menu se choose karo:`, mainKeyboard());
}

// ===================== CALLBACK QUERIES (inline buttons) =====================
bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const data = query.data;

    try {
        if (data === 'check_join') {
            const unjoined = await getUnjoinedChannels(chatId);
            if (unjoined.length > 0) {
                await bot.answerCallbackQuery(query.id, {
                    text: '❌ Abhi tak sabhi channels join nahi kiye!',
                    show_alert: true
                });
                try {
                    await bot.editMessageText(
                        `🔒 *Access Locked!*\n\n🚀 Ye channels bache hain, join karo:\n\n${unjoined.map(c => `📢 ${c.name}`).join('\n')}\n\nJoin karne ke baad neeche "✅ I've Joined" dabao 👇`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            parse_mode: 'Markdown',
                            ...joinKeyboard(unjoined)
                        }
                    );
                } catch (e) {}
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: '✅ Verified! Starting bot...' });
            try { await bot.deleteMessage(chatId, query.message.message_id); } catch (e) {}
            delete joinPromptMsg[chatId];

            const pendingRef = userState[chatId]?.pendingRef;
            await completeStart(chatId, query.from, pendingRef);
            return;
        }

        if (data === 'claim_free_views') {
            await bot.answerCallbackQuery(query.id);
            userState[chatId] = { step: 'awaiting_claim_reel_link' };
            try {
                await bot.editMessageText(
                    `🎁 *${REFERRAL_FREE_VIEWS.toLocaleString()} Free Views Unlocked!*\n\n📩 Send your Reel/Post link neeche — views us par bhej denge!`,
                    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
                );
            } catch (e) {}
            return;
        }
    } catch (e) {
        console.error('callback_query error', e);
    }
});

// ===================== MESSAGE ROUTER =====================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const state = userState[chatId];

    try {
        // ---- Block any interaction if user hasn't joined required channels ----
        const unjoined = await getUnjoinedChannels(chatId);
        if (unjoined.length > 0) {
            await sendJoinPrompt(chatId);
            return;
        }

        // ---- Step 0: waiting for reel link to claim free views (referral reward) ----
        if (state && state.step === 'awaiting_claim_reel_link') {
            if (text === '🏠 Home') {
                delete userState[chatId];
                bot.sendMessage(chatId, '🏠 Wapas aa gaye! Kya karna hai?', mainKeyboard());
                return;
            }

            const isLikelyLink = /^https?:\/\/.+/i.test(text);
            if (!isLikelyLink) {
                bot.sendMessage(chatId, '❌ Valid Reel/Post link bhejo (https:// se shuru hona chahiye):', homeKeyboard());
                return;
            }

            const claimant = (await fbGet(`users/${chatId}`)) || {};
            const claimantName = claimant.username || msg.from.username || msg.from.first_name || ('user' + chatId);

            await fbPush('freeViewClaims', {
                userId: chatId,
                username: claimantName,
                reelLink: text,
                views: REFERRAL_FREE_VIEWS,
                status: 'pending',
                createdAt: Date.now()
            });

            bot.sendMessage(
                chatId,
                `✅ *Order Placed Successfully!*\n\n🎁 ${REFERRAL_FREE_VIEWS.toLocaleString()} Views\n🔗 ${text}\n\n⏳ Views 24-48 hours me deliver ho jayengi!`,
                { parse_mode: 'Markdown', ...mainKeyboard() }
            );

            if (ADMIN_CHAT_ID) {
                bot.sendMessage(
                    ADMIN_CHAT_ID,
                    `🎁 *New Free Views Claim*\n\n👤 User: @${claimantName} (${chatId})\n🔗 Link: ${text}\n📊 Views: ${REFERRAL_FREE_VIEWS.toLocaleString()}`,
                    { parse_mode: 'Markdown' }
                ).catch(e => console.error('admin notify error', e));
            }

            delete userState[chatId];
            return;
        }

        // ---- Step 1: waiting for deposit amount ----
        if (state && state.step === 'awaiting_deposit_amount') {
            // Home button press - cancel flow
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

        // ---- Step 2: waiting for UTR ----
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
