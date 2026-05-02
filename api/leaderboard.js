// Vercel serverless function: leaderboard read/write.
//
// Storage tiers (auto-detected):
//   1. Upstash Redis (preferred — install via Vercel Marketplace, sets KV_REST_API_URL + KV_REST_API_TOKEN)
//   2. In-memory fallback — works on a warm function instance only; resets on cold start.
//      OK for local dev / preview / demo, NOT for production traffic.
//
// API:
//   POST /api/leaderboard  { score, combo, hard, name? }  → { rank, top: [...] }
//   GET  /api/leaderboard                                  → { top: [{ score, combo, hard, name, ts }] }
//
// CORS: open by default — tighten in production.

const LIST_KEY = 'css3d:leaderboard:v1';
const MAX_ENTRIES = 100;
const RETURN_TOP = 25;

let memoryStore = [];

async function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch (e) {
    console.warn('[lb] @upstash/redis unavailable:', e?.message || e);
    return null;
  }
}

async function readAll(redis) {
  if (!redis) return memoryStore.slice();
  // Stored as JSON-encoded list under LIST_KEY
  const raw = await redis.get(LIST_KEY);
  return Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
}

async function writeAll(redis, list) {
  const trimmed = list.slice(0, MAX_ENTRIES);
  if (!redis) { memoryStore = trimmed; return; }
  await redis.set(LIST_KEY, trimmed);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function cleanEntry(e) {
  return {
    score: Number(e?.score) || 0,
    combo: Number(e?.combo) || 0,
    hard:  !!e?.hard,
    name:  String(e?.name || 'Anonymous Hero').slice(0, 20),
    ts:    Number(e?.ts) || Date.now(),
  };
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    res.status(204).end();
    return;
  }
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  try {
    const redis = await getRedis();

    if (req.method === 'GET') {
      const all = await readAll(redis);
      const top = all.slice().sort((a, b) => b.score - a.score).slice(0, RETURN_TOP);
      res.status(200).json({ top, source: redis ? 'upstash' : 'memory' });
      return;
    }

    if (req.method === 'POST') {
      // Vercel parses JSON for us when content-type is set
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const entry = cleanEntry(body);
      if (entry.score < 0 || entry.score > 1_000_000) {
        res.status(400).json({ error: 'invalid score' });
        return;
      }
      const all = await readAll(redis);
      all.push(entry);
      all.sort((a, b) => b.score - a.score);
      const trimmed = all.slice(0, MAX_ENTRIES);
      await writeAll(redis, trimmed);
      const rank = trimmed.findIndex((e) => e === entry) + 1;
      const top = trimmed.slice(0, RETURN_TOP);
      res.status(200).json({ rank, top, source: redis ? 'upstash' : 'memory' });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[lb] error:', e);
    res.status(500).json({ error: 'internal' });
  }
}
