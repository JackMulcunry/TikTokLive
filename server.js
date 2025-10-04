import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { WebcastPushConnection } from 'tiktok-live-connector';

// ----- ENV -----
const PORT = process.env.PORT || 8080;
const HANDLE = (process.env.TIKTOK_USERNAME || '').trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

if (!HANDLE) {
  console.error('Set TIKTOK_USERNAME in .env');
  process.exit(1);
}

const app = express();
app.use(express.json());

// --- HTTP + WS ---
const server = app.listen(PORT, () => {
  console.log(`HTTP/WS listening on :${PORT}`);
});
const wss = new WebSocketServer({ server, path: '/ws' });

let lastActivityAt = Date.now();
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  lastActivityAt = Date.now();
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', () => {
  console.log('[ws] client connected; total:', wss.clients.size);
});

// --- Health ---
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Inject (admin) ---
app.post('/inject', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { ref, text, audioUrl, user } = req.body || {};
  if (!ref) return res.status(400).json({ error: 'missing ref' });
  console.log(`[inject] ${ref}`);
  lastActivityAt = Date.now();
  broadcast({ type: 'read', ref, text, audioUrl, user: user || 'admin' });
  res.json({ ok: true });
});

// --- Verse parsing / cooldowns (server-side sanity, same as before) ---
const VERSE_RE = /\b[0-9a-zA-Z]+\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/i;
const USER_COOLDOWN_MS = 75_000;
const GLOBAL_MIN_INTERVAL_MS = 12_000;
const MAX_RANGE_SPAN = 5;
const recentUsers = new Map(); // userId -> lastTime
let lastGlobal = 0;

const looksLikeVerse = (s='') => VERSE_RE.test(s);
function clampRange(ref) {
  const m = (ref||'').match(/^(.*?:)(\d+)-(\d+)$/i);
  if (!m) return ref;
  const [, p, a, b] = m;
  const A = +a, B = +b;
  if (Number.isFinite(A) && Number.isFinite(B) && B - A > MAX_RANGE_SPAN) {
    return `${p}${A}-${A + MAX_RANGE_SPAN}`;
  }
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

// --- TikTok connection with auto-retry ---
const tiktok = new WebcastPushConnection(HANDLE, {
  enableExtendedGiftInfo: false,
  requestOptions: { timeout: 10000 }
});

async function connectTikTok() {
  try {
    const state = await tiktok.connect();
    console.log(`Connected to @${HANDLE}`, state?.roomId ? `(room ${state.roomId})` : '');
  } catch (err) {
    console.error('Failed to connect:', err?.message || err);
    setTimeout(connectTikTok, 15_000);
  }
}
connectTikTok();

tiktok.on('disconnected', () => {
  console.warn('Disconnected — retrying in 15s…');
  setTimeout(connectTikTok, 15_000);
});
tiktok.on('liveEnd',   () => console.warn('Live ended.'));
tiktok.on('streamEnd', () => console.warn('Stream ended.'));

tiktok.on('chat', (data) => {
  try {
    const userId = String(data?.userId || data?.uniqueId || 'anon');
    const text = String(data?.comment || '').trim();

    if (!looksLikeVerse(text)) return;
    if (!allowedToEnqueue(userId)) return;

    const norm = text.replace(/([a-zA-Z])(\d)/, '$1 $2');
    const safe = clampRange(norm);

    console.log(`Queue: ${safe} (from ${data?.uniqueId || 'user'})`);
    lastActivityAt = Date.now();
    broadcast({ type: 'read', ref: safe, user: data?.uniqueId || 'user' });
  } catch (e) {
    console.error('chat handler error', e);
  }
});

// --- Keepalive auto-verse (ONLY if a client is connected & idle) ---
const KEEPALIVE_INTERVAL_MS = 60_000;  // try every 60s
const QUIET_GAP_MS          = 55_000;  // inject only if no activity ~55s
const AUTO_VERSES = [
  'John 3:16',
  'Psalm 23:1',
  'Proverbs 3:5-6',
  'Romans 12:2',
  'Philippians 4:6-7',
  'Matthew 11:28'
];

setInterval(() => {
  const clients = [...wss.clients].filter(c => c.readyState === 1).length;
  const idleFor = Date.now() - lastActivityAt;

  if (clients > 0 && idleFor > QUIET_GAP_MS) {
    const ref = AUTO_VERSES[Math.floor(Math.random() * AUTO_VERSES.length)];
    console.log(`[auto] clients=${clients} idle=${Math.round(idleFor/1000)}s → ${ref}`);
    lastActivityAt = Date.now();
    broadcast({ type: 'read', ref, user: 'auto' });
  }
}, KEEPALIVE_INTERVAL_MS);



