// api/vip-list.js
//
// Protected endpoint the daily GitHub Actions run (football_bot's vip.py)
// calls each morning to get the current list of active (non-expired) VIP
// Telegram user ids. Auth via a shared secret header -- set VIP_LIST_SECRET
// to the SAME value here (Vercel env var) and in the sigmaspread-bots
// GitHub repo secret of the same name.
//
// Nothing to clean up here for expired memberships -- Vercel KV's TTL
// (set at verification time, see telegram-webhook.js) means an expired
// vip:<user_id> key is already gone from KV by the time this scans for it.

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.headers['x-vip-secret'] !== process.env.VIP_LIST_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const userIds = [];
  let cursor = 0;
  do {
    const [nextCursor, keys] = await kv.scan(cursor, { match: 'vip:*', count: 100 });
    cursor = Number(nextCursor);
    for (const key of keys) {
      userIds.push(key.replace('vip:', ''));
    }
  } while (cursor !== 0);

  return res.status(200).json({ vip_user_ids: userIds });
}
