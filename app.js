// ===== CONFIG =====
// Set to your Render WebSocket URL
const WS_URL = 'wss://tiktoklive-d3qe.onrender.com/ws';
const DEFAULT_TRANSLATION = 'kjv';

// ===== ELEMENTS =====
const elCurrent = document.getElementById('current');
const elRef     = document.getElementById('ref');
const elPreview = document.getElementById('preview');
const elAudio   = document.getElementById('player');
const elUnlock  = document.getElementById('unlock');
const elUnlockBtn = document.getElementById('unlockBtn');
const dot       = document.getElementById('dot');

// ===== STATE =====
let q = [];
let playing = false;
window.audioUnlocked = false; // global so inline onclick can set it

// ===== HELPERS =====
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const green = () => { if (dot) dot.style.background = '#2bb673'; };
const red   = () => { if (dot) dot.style.background = '#c33'; };
const titleCase = (s) => s.replace(/\b([a-z])([a-z]*)/gi, (_,a,b)=>a.toUpperCase()+b.toLowerCase());
function normalizeRef(raw){ const s = String(raw||'').trim().toLowerCase().replace(/\s+/g,' '); return titleCase(s); }

async function fetchVerseText(ref){
  const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${DEFAULT_TRANSLATION}`;
  const r = await fetch(url);
  if(!r.ok) throw new Error('Verse not found');
  const j = await r.json();
  if(j.text) return j.text.trim().replace(/\s+/g,' ');
  if(Array.isArray(j.verses)) return j.verses.map(v=>v.text.trim()).join(' ').replace(/\s+/g,' ');
  throw new Error('Unexpected API response');
}

function updatePreview(){ elPreview.textContent = q[0]?.ref || ''; }
async function showCurrent(item){ elCurrent.textContent = item.text || item.ref; elRef.textContent = item.ref || ''; }

function enqueue(ref, opts={}){
  const norm = normalizeRef(ref);
  q.push({ ref: norm, text: opts.text, audioUrl: opts.audioUrl, user: opts.user });
  updatePreview();
  if(!playing) playLoop();
}

async function playLoop(){
  playing = true;
  while(q.length){
    const item = q.shift();
    try{
      if(!item.text){ try{ item.text = await fetchVerseText(item.ref); } catch{ item.text = item.ref; } }
      await playItem(item);
      await sleep(1000);
    }catch(_){}
    updatePreview();
  }
  playing = false;
}

async function playItem(item){
  await showCurrent(item);

  if(!window.audioUnlocked){ await ensureAudioUnlocked(); }

  elAudio.volume = 1;

  if(item.audioUrl){
    elAudio.src = item.audioUrl;
    try { await elAudio.play(); } catch {}
    await new Promise(res => { elAudio.onended = () => res(); });
    return;
  }

  if('speechSynthesis' in window){
    const utter = new SpeechSynthesisUtterance(item.text || item.ref);
    utter.rate = 0.95; utter.pitch = 1.0; utter.volume = 1;
    const done = new Promise(res => { utter.onend = () => res(); });
    const watchdog = sleep(15000).then(() => { try{ speechSynthesis.cancel(); }catch{} });
    try {
      try { speechSynthesis.cancel(); } catch {}
      try { speechSynthesis.speak(utter); } catch {}
      await Promise.race([done, watchdog]);
    } catch { await sleep(4000); }
    return;
  }

  await sleep(4000); // final fallback
}

// Global click handler (called by inline onclick on the button)
async function enableAudio(){
  try { await elAudio.play(); } catch {}
  try { elAudio.pause(); } catch {}
  if('speechSynthesis' in window){
    try {
      const test = new SpeechSynthesisUtterance(' ');
      try { speechSynthesis.cancel(); } catch {}
      try { speechSynthesis.speak(test); } catch {}
      setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 60);
    } catch {}
  }
  window.audioUnlocked = true;
  if(elUnlock) elUnlock.hidden = true;
}
window.enableAudio = enableAudio; // ensure global

async function ensureAudioUnlocked(){
  if(window.audioUnlocked) return;
  if(elUnlock) elUnlock.hidden = false;
  while(!window.audioUnlocked){ await sleep(100); }
}

// ===== WS =====
let ws;
function connectWS(){
  if(!WS_URL) return;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => green();
  ws.onclose = () => { red(); setTimeout(connectWS, 2500); };
  ws.onerror = () => red();
  ws.onmessage = (evt) => {
    try{
      const msg = JSON.parse(evt.data);
      if(msg.type === 'read' && msg.ref){ enqueue(msg.ref, { text: msg.text, audioUrl: msg.audioUrl, user: msg.user }); }
      if(msg.type === 'bulk' && Array.isArray(msg.items)) msg.items.forEach(it=> enqueue(it.ref, { text: it.text, audioUrl: it.audioUrl, user: it.user }));
      if(msg.type === 'clear'){ q.length = 0; updatePreview(); }
      if(!window.audioUnlocked && elUnlock) elUnlock.hidden = false;
    }catch(e){ /* ignore bad message */ }
  };
}
connectWS();

// For manual local demo, uncomment:
// enqueue('Psalm 23:1-3');
// enqueue('John 3:16');


