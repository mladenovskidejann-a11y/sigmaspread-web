// api/telegram-webhook.js
//
// Vercel serverless function -- receives Telegram webhook updates for the
// SigmaSpread bot. Handles /start and /verify <wallet>.
//
// VIP access model: a private VIP Telegram GROUP (not per-user DMs) --
// football_bot posts VIP picks there directly, same as the free channel.
// This function's job is just membership: on a successful /verify, it
// creates a single-use invite link into that group and DMs it to the user.
// Removing people when their 7 days are up is api/vip-sweep.js's job (runs
// daily via Vercel Cron -- see vercel.json).
//
// Required Vercel env vars (Project Settings -> Environment Variables):
//   TELEGRAM_BOT_TOKEN      -- the SAME bot token football_bot/instagram_poster use
//   TELEGRAM_WEBHOOK_SECRET -- a random string YOU make up (e.g. openssl rand -hex 24).
//                              Set the identical value when registering the
//                              webhook with Telegram (see SETUP notes) --
//                              Telegram echoes it back on every request so
//                              we can reject anything that didn't really
//                              come from Telegram.
//   TELEGRAM_VIP_CHAT_ID    -- the private VIP group's chat id (negative
//                              number, e.g. -1001234567890). The bot MUST
//                              be an admin of that group with "Invite Users
//                              via Link" permission for this to work.
//
// Also requires an Upstash Redis database connected to this project:
// Vercel dashboard -> this project -> Storage -> Create Database ->
// Upstash for Redis -> Connect to Project. That auto-injects
// KV_REST_API_URL / KV_REST_API_TOKEN (Vercel kept the old "KV_" names for
// backwards compatibility even though the underlying store is now Upstash
// Redis) -- built explicitly below rather than via Redis.fromEnv(), which
// looks for differently-named UPSTASH_REDIS_REST_* vars that this
// integration does NOT set.
//
// package.json needs "@upstash/redis" as a dependency (npm install @upstash/redis).

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const VIP_CHAT_ID = process.env.TELEGRAM_VIP_CHAT_ID;
const VIP_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Safety-net TTL on the KV record itself -- well beyond the real 7-day
// window, so a record still hangs around (with its real vip_until inside)
// for api/vip-sweep.js to read and act on even if a sweep run gets missed
// for a few days. Not the real expiry -- vip_until is.
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

async function telegramApi(method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return resp.json();
}

async function sendMessage(chatId, text) {
  await telegramApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
}

function isValidWalletAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

// Real, free, public, no-auth-required Polymarket endpoint -- returns actual
// trades made ON Polymarket by this address. Far stronger signal than a
// generic Polygon balance check (which only proves the address holds SOME
// crypto, not that it's ever touched Polymarket).
async function hasPolymarketActivity(address) {
  const resp = await fetch(`https://data-api.polymarket.com/trades?user=${address}&limit=1`);
  if (!resp.ok) return false;
  const data = await resp.json();
  return Array.isArray(data) && data.length > 0;
}

// Single-use, short-lived invite link into the VIP group -- expires in 1
// hour or after one join, whichever comes first, so it can't be shared
// around or reused later once someone else has already claimed it.
async function createVipInvite() {
  const result = await telegramApi('createChatInviteLink', {
    chat_id: VIP_CHAT_ID,
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600,
    name: 'VIP verify auto-invite',
  });
  return result.ok ? result.result.invite_link : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  // Reject anything that isn't really from Telegram.
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const update = req.body;
  const message = update && update.message;
  if (!message || !message.text) {
    // Nothing to do (e.g. an edited message, a reaction, etc.) -- ack with
    // 200 anyway so Telegram doesn't keep retrying this update forever.
    return res.status(200).send('OK');
  }

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text.trim();

  if (text === '/start') {
    await sendMessage(
      chatId,
      "Welcome to SigmaSpread!\n\n" +
        'Send `/verify <your Polymarket wallet address>` to unlock 7 days of ' +
        'access to our private VIP group (every pick we find, not just the free ' +
        'one) -- you need real trading activity on that wallet for it to count.'
    );
    return res.status(200).send('OK');
  }

  if (text.startsWith('/verify')) {
    const parts = text.split(/\s+/);
    const wallet = (parts[1] || '').toLowerCase();

    if (!isValidWalletAddress(wallet)) {
      await sendMessage(
        chatId,
        "That doesn't look like a valid wallet address (should start with 0x, " +
          '42 characters total). Try again: `/verify 0x...`'
      );
      return res.status(200).send('OK');
    }

    const existingRaw = await kv.get(`vip:${userId}`);
    if (existingRaw) {
      const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
      if (existing.vip_until > Date.now()) {
        await sendMessage(chatId, 'You already have active VIP access. No need to verify again yet.');
        return res.status(200).send('OK');
      }
    }

    // One wallet can only ever unlock VIP once -- for anyone, ever. Stops
    // one address (e.g. copied off Polymarket's public leaderboard) from
    // being reused by many different Telegram accounts.
    const walletUsed = await kv.get(`wallet_used:${wallet}`);
    if (walletUsed) {
      await sendMessage(
        chatId,
        'This wallet address has already been used for VIP verification. Each wallet can only unlock VIP once.'
      );
      return res.status(200).send('OK');
    }

    const hasActivity = await hasPolymarketActivity(wallet);
    if (!hasActivity) {
      await sendMessage(
        chatId,
        "We couldn't find any Polymarket trading activity on that address yet. " +
          'Make at least one trade on Polymarket, then try `/verify` again.'
      );
      return res.status(200).send('OK');
    }

    if (!VIP_CHAT_ID) {
      await sendMessage(chatId, "Verification passed, but the VIP group isn't configured yet -- tell the admin.");
      return res.status(200).send('OK');
    }

    const inviteLink = await createVipInvite();
    if (!inviteLink) {
      await sendMessage(
        chatId,
        "Verification passed, but we couldn't generate a VIP invite link right now -- " +
          "make sure the bot is an admin of the VIP group with 'Invite Users via Link' permission, then try /verify again."
      );
      return res.status(200).send('OK');
    }

    const vipUntil = Date.now() + VIP_DURATION_MS;
    await kv.set(`vip:${userId}`, JSON.stringify({ wallet, vip_until: vipUntil }), { ex: RECORD_TTL_SECONDS });
    await kv.set(`wallet_used:${wallet}`, userId); // no expiry -- permanent, prevents reuse forever

    const expiryDate = new Date(vipUntil).toISOString().slice(0, 16).replace('T', ' ');
    await sendMessage(
      chatId,
      `✅ Verified! Here's your one-time invite to the VIP group:\n${inviteLink}\n\n` +
        `Your access lasts until *${expiryDate} UTC* -- after that you'll be removed automatically ` +
        "unless you verify a new trade with /verify again."
    );
    return res.status(200).send('OK');
  }

  await sendMessage(chatId, 'Unknown command. Send `/verify <wallet_address>` to unlock VIP access.');
  return res.status(200).send('OK');
}
