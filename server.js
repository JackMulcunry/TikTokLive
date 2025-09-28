import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { WebcastPushConnection } from 'tiktok-live-connector';

const PORT = process.env.PORT || 8080;
const HANDLE = process.env.TIKTOK_USERNAME;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!HANDLE) {
  console.error('Set TIKTOK_USERNAME in .env');
  process.exit(1);
}

const app = express();
app.use(express.json());

// --- WebSocket hub (browser pages connect here) ---
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

// --- Health check ---
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Optional: manual injection endpoint (secured with simple token) ---
app.post('/inject', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { ref, text, audioUrl, user } = req.body || {};
  if (!ref) return res.status(400).json({ error: 'missing ref' });
  broadcast({ type: 'read', ref, text, audioUrl, user: user || 'admin' });
  res.json({ ok: true });
});

// --- Verse parsing & anti-spam ---
const VERSE_RE = /\b[0-9a-zA-Z]+\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/i;
const USER_COOLDOWN_MS = 75_000; // per-user 75s
const GLOBAL_MIN_INTERVAL_MS = 12_000; // one verse every 12s
const MAX_RANGE_SPAN = 5; // cap to 5 verses if "a-b" given
const recentUsers = new Map(); // userId -> lastTime
let lastGlobal = 0;

function looksLikeVerse(s = '') {
  return VERSE_RE.test(s);
}
function clampRange(ref) {
  // If "John 3:16-99" collapse to a limited span
  const m = ref.match(/^(.*?:)(\d+)-(\d+)$/i);
  if (!m) return ref;
  const [ , prefix, a, b ] = m;
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

// --- TikTok Chat Listener ---
const tiktok = new WebcastPushConnection(HANDLE, {
  enableExtendedGiftInfo: false,
  requestOptions: { timeout: 10000 }
});

tiktok
  .connect()
  .then(state => console.log(`Connected to @${HANDLE}`, state?.roomId ? `(room ${state.roomId})` : ''))
  .catch(err => console.error('Failed to connect:', err?.message || err));

tiktok.on('disconnected', () => console.warn('Disconnected—reconnecting…'));
tiktok.on('liveEnd', () => console.warn('Live ended.'));
tiktok.on('streamEnd', () => console.warn('Stream ended.'));

tiktok.on('chat', data => {
  try {
    const userId = String(data?.userId || data?.uniqueId || 'anon');
    const text = String(data?.comment || '').trim();

    if (!looksLikeVerse(text)) return; // ignore non-verse chat

    if (!allowedToEnqueue(userId)) return; // cooldowns

    // Normalize simple oddities (allow "john3:16" → "john 3:16")
    const norm = text.replace(/([a-zA-Z])(\d)/, '$1 $2');
    const safe = clampRange(norm);

    console.log(`Queue: ${safe} (from ${data?.uniqueId || 'user'})`);
    broadcast({ type: 'read', ref: safe, user: data?.uniqueId || 'user' });
  } catch (e) {
    console.error('chat handler error', e);
  }
});



