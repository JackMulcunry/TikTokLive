import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { WebcastPushConnection } from 'tiktok-live-connector';

const PORT = Number(process.env.PORT || 10000);
const HANDLE = (process.env.TIKTOK_USERNAME || '').trim(); // uniqueId (no @)
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- HTTP ROUTES ----------
app.get('/', (_req, res) => {
  res
    .type('text/plain')
    .send(
      'TikTok Verse Relay is running.\n' +
      'WS: /ws\n' +
      'Health: /health\n' +
      'POST /inject (Authorization: Bearer <ADMIN_TOKEN>)'
    );
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/inject', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { ref, text, audioUrl, user } = req.body || {};
  if (!ref) return res.status(400).json({ error: 'missing ref' });
  broadcast({ type: 'read', ref, text, audioUrl, user: user || 'admin' });
  return res.json({ ok: true });
});

// ---------- HTTP + WS SERVER ----------
const server = app.listen(PORT, () => {
  console.log(`HTTP/WS listening on :${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---------- TikTok CHAT (optional / auto-retry) ----------
const VERSE_RE = /\b[0-9a-zA-Z]+\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/i;
const USER_COOLDOWN_MS = 75_000;
const GLOBAL_MIN_INTERVAL_MS = 12_000;
const MAX_RANGE_SPAN = 5;

const recentUsers = new Map();
let lastGlobal = 0;

function looksLikeVerse(s = '') { return VERSE_RE.test(s); }
function clampRange(ref) {
  const m = ref.match(/^(.*?:)(\d+)-(\d+)$/i);
  if (!m) return ref;
  const [, prefix, a, b] = m;
  const A = parseInt(a, 10), B = parseInt(b, 10);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return ref;
  if (B - A > MAX_RANGE_SPAN) return `${prefix}${A}-${A + MAX_RANGE_SPAN}`;
  return ref;
}
function allowedToEnqueue(userId) {
  const now = Date.now();
  if (now - lastGlobal < GLOBAL_MIN_INTERVAL_MS) return false;
  const prev = recentUsers.get(userId) || 0;
  if (now - prev < USER_COOLDOWN_MS) return false;
  recentUsers.set(userId, now);
  lastGlobal = now;
  return true;
}
function normalizeInline(s) { return s.replace(/([a-zA-Z])(\d)/, '$1 $2'); }

// Only start connector if a handle is provided
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

  tiktok.on('disconnected', () => {
    console.warn('TikTok disconnected — retrying in 15s…');
    setTimeout(connectTikTok, 15000);
  });
  tiktok.on('streamEnd', () => console.warn('TikTok stream ended'));
  tiktok.on('liveEnd', () => console.warn('TikTok live ended'));

  tiktok.on('chat', data => {
    try {
      const userId = String(data?.userId || data?.uniqueId || 'anon');
      const text = String(data?.comment || '').trim();
      if (!looksLikeVerse(text)) return;
      if (!allowedToEnqueue(userId)) return;

      const norm = normalizeInline(text);
      const safe = clampRange(norm);
      console.log(`Queue: ${safe} (from ${data?.uniqueId || 'user'})`);
      broadcast({ type: 'read', ref: safe, user: data?.uniqueId || 'user' });
    } catch (e) {
      console.error('chat handler error', e);
    }
  });
} else {
  console.log('TIKTOK_USERNAME not set — relay will still accept /inject and serve WS.');
}


    broadcast({ type: 'read', ref: safe, user: data?.uniqueId || 'user' });
  } catch (e) {
    console.error('chat handler error', e);
  }
});
