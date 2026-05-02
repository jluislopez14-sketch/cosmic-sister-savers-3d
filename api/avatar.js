// Vercel serverless function: photo → Hyper3D Rodin → GLB.
//
// Three sub-routes share this file (path matched in handler):
//   POST /api/avatar                  — accept photo upload, kick off a Rodin job
//   GET  /api/avatar/:uuid/status     — poll job status
//   GET  /api/avatar/:uuid/glb        — proxy the resulting GLB binary
//
// Required env (`vercel env add HYPER3D_API_KEY production`):
//   HYPER3D_API_KEY    — your Hyper3D Rodin Bearer token
//
// IMPORTANT: the Rodin API key MUST stay server-side. Never expose it to
// the browser. The client uploads a photo here; this function forwards it
// with the secret token attached.

import { Buffer } from 'node:buffer';
import { verifyToken } from './auth.js';

const RODIN_BASE = 'https://hyperhuman.deemos.com';

// Coarse rate limiting (per-IP, per-process). On warm Fluid instances this
// lasts; on cold starts we get a fresh window. For real production use, swap
// for an Upstash-backed sliding window.
const ipBuckets = new Map();
const RATE_WINDOW_MS = 3600_000;   // 1h
const RATE_MAX_CALLS = 5;

function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const list = (ipBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  ipBuckets.set(ip, list);
  return list.length > RATE_MAX_CALLS;
}

function requireAuth(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1]);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function applyCors(res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
}

function notConfigured(res) {
  applyCors(res);
  res.status(501).json({ error: 'HYPER3D_API_KEY not set on server' });
}

/** POST /api/avatar — start a Rodin job from a photo upload. */
async function handleSubmit(req, res, apiKey) {
  // Vercel parses multipart/form-data on Node Runtime via the `formidable`
  // pattern; we lean on the raw stream to avoid extra deps. For now we
  // accept JSON with a base64-encoded photo to keep this minimal:
  //   { imageBase64: 'iVBOR...', ext: 'jpg' }
  // The client side calls this directly without extra libraries.
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch { body = {}; }
  if (!body.imageBase64) { res.status(400).json({ error: 'imageBase64 required' }); return; }

  const buf = Buffer.from(body.imageBase64, 'base64');
  const ext = (body.ext || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';

  // Build multipart manually for Rodin
  const boundary = `----CSS3D-${Date.now().toString(36)}`;
  const parts = [];
  const push = (s) => parts.push(typeof s === 'string' ? Buffer.from(s) : s);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="0.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`);
  push(buf);
  push('\r\n');
  push(`--${boundary}\r\nContent-Disposition: form-data; name="tier"\r\n\r\nSketch\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="mesh_mode"\r\n\r\nRaw\r\n`);
  push(`--${boundary}--\r\n`);
  const payload = Buffer.concat(parts);

  const upstream = await fetch(`${RODIN_BASE}/api/v2/rodin`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: payload,
  });
  const data = await upstream.json();
  applyCors(res);
  res.status(upstream.ok ? 200 : upstream.status).json(data);
}

/** GET /api/avatar/<uuid>/status?key=<subscription_key> */
async function handleStatus(req, res, apiKey, uuid) {
  const url = new URL(req.url, 'http://x');
  const subKey = url.searchParams.get('key');
  if (!subKey) { res.status(400).json({ error: 'subscription key required' }); return; }
  const upstream = await fetch(`${RODIN_BASE}/api/v2/status`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription_key: subKey }),
  });
  const data = await upstream.json();
  applyCors(res);
  res.status(200).json({
    uuid,
    statuses: (data?.jobs || []).map((j) => j.status),
    done: (data?.jobs || []).every((j) => j.status === 'Done'),
    raw: data,
  });
}

/** GET /api/avatar/<uuid>/glb — proxy the GLB download. */
async function handleDownload(req, res, apiKey, uuid) {
  const upstream = await fetch(`${RODIN_BASE}/api/v2/download`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_uuid: uuid }),
  });
  if (!upstream.ok) {
    applyCors(res);
    res.status(upstream.status).json({ error: 'download failed' });
    return;
  }
  const data = await upstream.json();
  // The download endpoint returns a list of files (URLs) — pick the GLB.
  const items = data?.list || data?.items || [];
  const glb = items.find((it) => /\.glb(\?|$)/i.test(it?.url || ''));
  if (!glb) {
    applyCors(res);
    res.status(404).json({ error: 'no glb in result' });
    return;
  }
  // Proxy the binary
  const bin = await fetch(glb.url);
  applyCors(res);
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  const ab = await bin.arrayBuffer();
  res.send(Buffer.from(ab));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); res.status(204).end(); return; }
  const apiKey = process.env.HYPER3D_API_KEY;
  if (!apiKey) return notConfigured(res);

  // Auth + rate-limit on POST (the only endpoint that costs Rodin credits).
  // Status + GLB downloads are read-only and don't burn the budget.
  if (req.method === 'POST') {
    const userId = requireAuth(req);
    if (!userId) {
      applyCors(res);
      res.status(401).json({ error: 'auth required — POST /api/auth/anonymous first' });
      return;
    }
    if (rateLimited(req)) {
      applyCors(res);
      res.status(429).json({ error: 'rate limit: 5 generations per hour per IP' });
      return;
    }
  }

  // Routes (after vercel.json rewrites):
  //   POST /api/avatar                                      (submit)
  //   GET  /api/avatar?uuid=X&action=status                  (status)
  //   GET  /api/avatar?uuid=X&action=glb                     (download)
  const url = new URL(req.url, 'http://x');
  const uuid = url.searchParams.get('uuid');
  const action = url.searchParams.get('action');

  try {
    if (req.method === 'POST' && !uuid) return handleSubmit(req, res, apiKey);
    if (req.method === 'GET'  && uuid && action === 'status') return handleStatus(req, res, apiKey, uuid);
    if (req.method === 'GET'  && uuid && action === 'glb')    return handleDownload(req, res, apiKey, uuid);
    applyCors(res);
    res.status(404).json({ error: 'not found' });
  } catch (e) {
    console.error('[avatar] error', e);
    applyCors(res);
    res.status(500).json({ error: 'internal' });
  }
}
