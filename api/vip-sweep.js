// api/vip-sweep.js
//
// Runs once a day via Vercel Cron (see vercel.json) -- finds every VIP
// record whose 7-day window has passed and removes that person from the
// private VIP Telegram group (ban immediately followed by unban, so
// they're kicked but free to rejoin later after a fresh /verify).
//
// Vercel Cron invocations always carry User-Agent "vercel-cron/1.0" -- we
// check that as a light sanity gate. Worth noting this isn't airtight
// (headers are spoofable), but the blast radius here is low: even a forged
// call only ever removes people whose vip_until has ALREADY passed, i.e.
// it can only enforce the access policy a little early, never incorrectly
// remove someone whose access is still active or do anything else.

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VIP_CHAT_ID = process.env.TELEGRAM_VIP_CHAT_ID;

async function telegramApi(method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return resp.json();
}

async function removeFromVipGroup(userId) {
  // ban then immediately unban -- removes them now, but doesn't leave a
  // permanent ban that would block a future re-verification from working.
  await telegramApi('banChatMember', { chat_id: VIP_CHAT_ID, user_id: Number(userId) });
  await telegramApi('unbanChatMember', {
    chat_id: VIP_CHAT_ID,
    user_id: Number(userId),
    only_if_banned: true,
  });
}

export default async function handler(req, res) {
  if (req.headers['user-agent'] !== 'vercel-cron/1.0' && req.query.manual !== '1') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!VIP_CHAT_ID) {
    return res.status(200).json({ skipped: 'TELEGRAM_VIP_CHAT_ID not set' });
  }

  const now = Date.now();
  let removed = 0;
  let checked = 0;
  let cursor = 0;

  do {
    const [nextCursor, keys] = await kv.scan(cursor, { match: 'vip:*', count: 100 });
    cursor = Number(nextCursor);

    for (const key of keys) {
      checked += 1;
      const userId = key.replace('vip:', '');
      const raw = await kv.get(key);
      if (!raw) continue;
      const record = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (record.vip_until && record.vip_until < now) {
        try {
          await removeFromVipGroup(userId);
          removed += 1;
        } catch (exc) {
          console.error(`Failed to remove expired VIP user ${userId}:`, exc);
          continue; // leave the key in place, try again on tomorrow's sweep
        }
        await kv.del(key);
      }
    }
  } while (cursor !== 0);

  return res.status(200).json({ checked, removed });
}
