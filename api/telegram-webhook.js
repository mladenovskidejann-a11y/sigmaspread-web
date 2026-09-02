// api/telegram-webhook.js
//
// Vercel serverless function -- receives Telegram webhook updates for the
// SigmaSpread bot. Right now it only handles /start and /verify <wallet>.
//
// Required Vercel env vars (Project Settings -> Environment Variables):
//   TELEGRAM_BOT_TOKEN      -- the SAME bot token football_bot/instagram_poster use
//   TELEGRAM_WEBHOOK_SECRET -- a random string YOU make up (e.g. openssl rand -hex 24).
//                              Set the identical value when registering the
//                              webhook with Telegram (see SETUP notes) --
//                              Telegram echoes it back on every request so
//                              we can reject anything that didn't really
//                              come from Telegram.
//
// Also requires Vercel KV connected to this project: Vercel dashboard ->
// this project -> Storage tab -> Create Database -> KV. That auto-injects
// KV_REST_API_URL / KV_REST_API_TOKEN, which @vercel/kv picks up on its own
// -- no extra config needed here.
//
// package.json needs "@vercel/kv" as a dependency (npm install @vercel/kv).

import { kv } from '@vercel/kv';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const VIP_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
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
        'VIP access (every pick we find, not just the free one) -- you need real ' +
        'trading activity on that wallet for it to count.'
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

    const existingVip = await kv.get(`vip:${userId}`);
    if (existingVip) {
      await sendMessage(chatId, 'You already have active VIP access. No need to verify again yet.');
      return res.status(200).send('OK');
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

    await kv.set(`vip:${userId}`, wallet, { ex: VIP_TTL_SECONDS });
    await kv.set(`wallet_used:${wallet}`, userId); // no expiry -- permanent, prevents reuse forever

    const expiryDate = new Date(Date.now() + VIP_TTL_SECONDS * 1000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
    await sendMessage(
      chatId,
      `✅ Verified! You now have VIP access until *${expiryDate} UTC*.\n\n` +
        "You'll get every pick we find each day, not just the one free pick. Enjoy!"
    );
    return res.status(200).send('OK');
  }

  await sendMessage(chatId, 'Unknown command. Send `/verify <wallet_address>` to unlock VIP access.');
  return res.status(200).send('OK');
}
