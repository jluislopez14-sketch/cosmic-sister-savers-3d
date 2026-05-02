// Vercel serverless function: per-user CloudSync save state.
//
//   GET  /api/save   Authorization: Bearer <token>  →  saved JSON or 404
//   POST /api/save   Authorization: Bearer <token>  →  { ok, lastModified }
//
// Storage: Upstash Redis if env present (KV_REST_API_URL/TOKEN), else memory.

import { verifyToken } from './auth.js';

const KEY_PREFIX = 'css3d:save:';
let memoryStore = new Map();

async function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch { return null; }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function getUserId(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1]);
}

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'unauthorized' }); return; }

  try {
    const redis = await getRedis();
    const key = KEY_PREFIX + userId;
    if (req.method === 'GET') {
      const data = redis ? await redis.get(key) : memoryStore.get(key);
      if (!data) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json(typeof data === 'string' ? JSON.parse(data) : data);
      return;
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const lastModified = Date.now();
      const value = { ...body, lastModified };
      if (redis) await redis.set(key, value);
      else memoryStore.set(key, value);
      res.status(200).json({ ok: true, lastModified });
      return;
    }
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[save] error', e);
    res.status(500).json({ error: 'internal' });
  }
}
