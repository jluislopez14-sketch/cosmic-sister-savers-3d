// Vercel serverless function: anonymous auth for CloudSync.
//
// POST /api/auth/anonymous  →  { id, token }
//
// Mints an anonymous user ID and a signed token. Tokens are HMAC'd with
// AUTH_SECRET so the same secret can verify them on /api/save without a
// database lookup.
//
// Required env: AUTH_SECRET (any random 32+ char string).
// Add via: `vercel env add AUTH_SECRET production`

import { createHmac, randomBytes } from 'node:crypto';

const AUTH_SECRET = process.env.AUTH_SECRET || '';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function sign(id) {
  if (!AUTH_SECRET) return null;
  const h = createHmac('sha256', AUTH_SECRET).update(id).digest('hex');
  return `${id}.${h}`;
}

export function verifyToken(token) {
  if (!AUTH_SECRET || !token) return null;
  const [id, sig] = String(token).split('.');
  if (!id || !sig) return null;
  const expected = createHmac('sha256', AUTH_SECRET).update(id).digest('hex');
  // timing-safe-ish compare
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? id : null;
}

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!AUTH_SECRET)             { res.status(501).json({ error: 'AUTH_SECRET not set' }); return; }

  const id = `anon-${randomBytes(8).toString('hex')}`;
  const token = sign(id);
  res.status(200).json({ id, token });
}
