// server.js  — minimal, known-good relay

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { WebcastPushConnection } from 'tiktok-live-connector';

const PORT   = Number(process.env.PORT || 10000);
const HANDLE = (process.env.TIKTOK_USERNAME || '').trim();   // TikTok uniqueId (no @)
const ADMIN  = (process.env.ADMIN_TOKEN || '').trim();

const app = express();
app.use(cors());
app.use(express.json());

// ---- HTTP routes
app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'TikTok Verse Relay\n' +
    'WS: /ws\n' +
    'Health: /health\n' +
    'POST /inject (Authorization: Bearer <ADMIN_TOKEN>)\n'
  );
});
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/inject', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!ADMIN || auth !== `Bearer ${ADMIN}`) return res.status(401).json({ error: 'unauthorized' });
  const { ref, text, audioUrl, user } = req.body || {};
  if (!ref) return res.status(400).json({ error: 'missing ref' });
  broadcast({ type: 'read', ref, text, audioUrl, user: user || 'admin' });
  res.json({ ok: true });
});

// ---- HTTP + WS server
const server = app.listen(PORT, () => console.log(`HTTP/WS on :${PORT}`));
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

// ---- TikTok chat (optional; auto-retry)
const VERSE_RE = /\b[0-9a-zA-Z]+\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/i;
const USER_COOLDOWN_MS = 75_000;
const GLOBAL_MIN_INTERVAL_MS = 12_000;
const MAX_RANGE_SPAN = 5;
const recentUsers = new Map(); // userId -> ts
let lastGlobal = 0;

const looksLikeVerse = s => VERSE_RE.test(s || '');
const normalizeInline = s => (s || '').replace(/([a-zA-Z])(\d)/, '$1 $2'); // john3:16 -> john 3:16
function clampRange(ref) {
  const m = (ref || '').match(/^(.*?:)(\d+)-(\d+)$/i);
  if (!m) return ref;
  const [, p, a, b] = m; const A = +a, B = +b;
  return (Number.isFinite(A) && Number.isFinite(B) && B - A > MAX_RANGE_SPAN) ? `${p}${A}-${A + MAX_RANGE_SPAN}` : ref;
}
function allowed(userId) {
  const now = Date.now();
  if (now - lastGlobal < GLOBAL_MIN_INTERVAL_MS) return false;
  const prev = recentUsers.get(userId) || 0;
  if (now - prev < USER_COOLDOWN_MS) return false;
  recentUsers.set(userId, now); lastGlobal = now; return true;
}

if (HANDLE) {
  const tiktok = new WebcastPushConnection(HANDLE, {
    enableExtendedGiftInfo: false,
    requestOptions: { timeout: 10000 }
  });

  async function connectTikTok() {
    try {
      const state = await tiktok.connect();
      console.log(`Connected to @${HANDLE}`, state?.roomId ? `(room ${state.roomId})` : '');
    } catch (err) {
      console.warn('TikTok connect failed:', err?.message || err);
      setTimeout(connectTikTok, 15000);
    }
  }
  connectTikTok();

  tiktok.on('disconnected', () => { console.warn('TikTok disconnected — retrying in 15s'); setTimeout(connectTikTok, 15000); });
  tiktok.on('liveEnd',   () => console.warn('TikTok live ended'));
  tiktok.on('streamEnd', () => console.warn('TikTok stream ended'));

  tiktok.on('chat', (data) => {
    try {
      const userId = String(data?.userId || data?.uniqueId || 'anon');
      const text = String(data?.comment || '').trim();
      if (!looksLikeVerse(text)) return;
      if (!allowed(userId)) return;
      const safe = clampRange(normalizeInline(text));
      console.log(`Queue: ${safe} (from ${data?.uniqueId || 'user'})`);
      broadcast({ type: 'read', ref: safe, user: data?.uniqueId || 'user' });
    } catch (e) {
      console.error('chat handler error', e);
    }
  });
} else {
  console.log('TIKTOK_USERNAME not set — relay still serves WS and /inject.');
}

