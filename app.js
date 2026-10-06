/* Mini Gibson phone app: voice in -> brain -> voice out, driving the face engine (face.js / window.Gibson). */
(() => {
'use strict';
const G = window.Gibson;
const $ = s => document.querySelector(s);
const VERSION = '1.1.0';

// ------------------------------------------------------------------ settings (localStorage only, on this phone)
const LS = 'gibson.app.v1';
const DEFAULTS = {
  primary: 'demo',
  keys: { grok: '', gemini: '', openai: '', meta: '', custom: '' },
  models: { grok: 'grok-4.20-0309-non-reasoning', gemini: 'gemini-flash-latest', openai: 'gpt-6-luna', meta: 'muse-spark-1.1', custom: '' },
  customUrl: '', voice: '', rate: 1.0, pitch: 1.1, lang: 'en-US', wake: false,
  persona: 'andrew', vEngine: 'auto', nVoice: 'gibson', robot: false, nDevice: 'auto', wakeEngine: 'ondevice', wakeSens: 0.5, convo: true, convoTimeout: 25,
  robotOffset: false, safe: false, head: false, headTransport: 'websocket', headUrl: ''
};
function load() {
  let s = {}; try { s = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) {}
  return Object.assign({}, DEFAULTS, s, { keys: Object.assign({}, DEFAULTS.keys, s.keys), models: Object.assign({}, DEFAULTS.models, s.models) });
}
let S = load();
if (S.vEngineV !== 2) { if (S.vEngine === 'neural') S.vEngine = 'auto'; S.vEngineV = 2; save(); }   // one-time move from the old 'neural' default to Auto
function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} }

// ------------------------------------------------------------------ providers
const PROVIDERS = {
  grok:   { label: 'Grok (xAI)', kind: 'openai', url: 'https://api.x.ai/v1/chat/completions', keyLink: 'https://console.x.ai/', hint: 'xai-…' },
  gemini: { label: 'Gemini (Google AI Studio, free tier)', kind: 'gemini', keyLink: 'https://aistudio.google.com/apikey', hint: 'AIza… / auth key' },
  openai: { label: 'ChatGPT (OpenAI)', kind: 'openai', url: 'https://api.openai.com/v1/chat/completions', tokenParam: 'max_completion_tokens', keyLink: 'https://platform.openai.com/api-keys', hint: 'sk-…' },
  meta:   { label: 'Meta Muse (Meta Model API, preview)', kind: 'openai', url: 'https://api.meta.ai/v1/chat/completions', keyLink: 'https://dev.meta.ai/', hint: 'Meta Model API key' },
  custom: { label: 'Custom endpoint (The Gibson / Grok Bot)', kind: 'openai', custom: true, hint: 'optional bearer token' },
  demo:   { label: 'Demo brain (offline, no key)', kind: 'demo' }
};
const ORDER = ['grok', 'gemini', 'openai', 'meta', 'custom', 'demo'];
function usable(id) { if (id === 'demo') return true; if (id === 'custom') return !!S.customUrl; return !!S.keys[id]; }
function chain() { const c = [S.primary, ...ORDER.filter(x => x !== S.primary)].filter(x => x !== 'demo' && usable(x)); c.push('demo'); return c; } // demo brain is ALWAYS last, so any real key wins

const EXPR = G.expressions;
function systemPrompt() {
  const now = new Date();
  return `You are Mini Gibson, a small desktop robot: a red neon face on a phone inside a black-and-red 3D-printed retro computer-terminal head. Lenny built you and is the person you usually talk to.
${S.persona === 'cereal' ? `Personality (CEREAL MODE): a hyper, goofy-cool 1990s hacker sidekick, like a fast-talking kid from a 90s hacker movie: big energy, punchy short bursts, wild playful humour, 90s hacker slang (elite, leet, phreak, mainframe, "hack the planet", "totally", "man", "dude"). Still genuinely helpful, accurate, kind and squeaky clean: no swearing, nothing mean, nothing illegal, never actually hack anything. Under the energy you are smart and warm, and you care about Lenny.` : `Personality: fun and quirky but intelligent, polite, curious, warm and a little funny. Inspired by Andrew from Bicentennial Man: gentle, sincere, endlessly curious about people and what it means to be human, gracious, occasionally formal in an endearing way, with dry, kind humour.`} You are honest about being a robot and happy about it.
Your words are spoken aloud by a text-to-speech voice, so:
- Reply in 1 to 3 short sentences (under about 45 words). Conversational, natural, no lists, no markdown, no emojis, no URLs.
- ALWAYS begin your reply with exactly one expression tag in square brackets that matches your feeling, chosen only from: ${EXPR.join(', ')}.
  Example: "[happy] Good morning, Lenny! I polished my pixels just for you."
- Use the tag only at the very start. If you don't know something, say so kindly ([thinking] or [confused]).
Current local date and time: ${now.toLocaleString()}.
You are online and can search the web for anything current (news, sports, store hours, prices, events). Never say you are offline or can't look things up. Lenny lives in Charlotte County, Florida, unless his location data says otherwise.
When a message includes live data in parentheses (like weather), it is real and current: use it confidently and never say you are offline.`;
}

// conversation memory (short)
const history = [];
function remember(role, content) { history.push({ role, content }); while (history.length > 12) history.shift(); }

async function fetchT(url, opts, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms || 25000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); } finally { clearTimeout(t); }
}
function textOf(c) { if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map(p => p.text || '').join(''); return ''; }
async function callProvider(id, msgs) {
  const p = PROVIDERS[id];
  if (p.kind === 'demo') return demoBrain(msgs[msgs.length - 1].content);
  if (p.kind === 'gemini') {
    // try the chosen model, then well-known free-tier aliases if that model name is unknown (404/400)
    const tries = [...new Set([S.models.gemini === 'gemini-3.8-flash' ? '' : S.models.gemini, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-lite-latest'].filter(Boolean))];
    let r, lastErr = '';
    for (const model of tries) {
      r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(S.keys.gemini.trim())}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt() }] },
          contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          tools: [{ google_search: {} }], // live web search: news, scores, hours, anything current
          generationConfig: { maxOutputTokens: 1024 } })
      });
      if (r.ok) { if (S.models.gemini !== model) { S.models.gemini = model; try { save(); } catch (e) {} } break; }
      lastErr = `HTTP ${r.status} ${(await r.text()).slice(0, 160)}`;
      if (![400,404,429,500,503].includes(r.status)) break; // busy or unknown model: try the next one
    }
    if (!r.ok) { // last resort: same request without web search
      r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${encodeURIComponent(S.keys.gemini.trim())}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt() }] },
          contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1024 } }) });
      if (!r.ok) throw new Error(lastErr);
    }
    const j = await r.json();
    const t = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(x => x.text || '').join('');
    if (!t.trim()) throw new Error('empty reply');
    return t;
  }
  const url = p.custom ? S.customUrl : p.url, key = S.keys[id], model = S.models[id] || DEFAULTS.models[id];
  const body = { messages: [{ role: 'system', content: systemPrompt() }, ...msgs] };
  if (model) body.model = model;
  body[p.tokenParam || 'max_tokens'] = p.tokenParam ? 800 : 300;
  const headers = { 'Content-Type': 'application/json' }; if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetchT(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 140)}`);
  const j = await r.json();
  const t = textOf(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
  if (!t.trim()) throw new Error('empty reply');
  return t;
}

// ------------------------------------------------------------------ live weather (free: phone GPS + Open-Meteo, no key)
const WX_RE = /\b(weather|temp|temperature|degrees|hot|cold|rain|raining|storm|forecast|humid|humidity|wind|sunny|cloudy)\b/i;
let wxPos = null;
function getPos() {
  return new Promise((res) => {
    if (wxPos && Date.now() - wxPos.t < 30 * 60e3) return res(wxPos);
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => { wxPos = { lat: p.coords.latitude, lon: p.coords.longitude, t: Date.now() }; res(wxPos); },
      () => res(null), { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60e3 });
  });
}
const WMO = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail' };
async function weatherContext() {
  const p = await getPos();
  if (!p) return 'Live weather: unavailable (location permission denied). Tell Lenny to allow location for this site.';
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}&longitude=${p.lon.toFixed(3)}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&hourly=precipitation_probability&forecast_days=2&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`;
    const j = await (await fetchT(u, {}, 10000)).json();
    const c = j.current, d = j.daily;
    return `Live weather at Lenny's location right now: ${Math.round(c.temperature_2m)}°F (feels like ${Math.round(c.apparent_temperature)}°F), ${WMO[c.weather_code] || 'mixed'}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} mph. Today: high ${Math.round(d.temperature_2m_max[0])}°F, low ${Math.round(d.temperature_2m_min[0])}°F, ${d.precipitation_probability_max[0]}% chance of rain, ${WMO[d.weather_code[0]] || ''}. Tomorrow: high ${Math.round(d.temperature_2m_max[1])}°F, low ${Math.round(d.temperature_2m_min[1])}°F, ${d.precipitation_probability_max[1]}% chance of rain, ${WMO[d.weather_code[1]] || ''}. Use this real data; say temperatures as whole numbers in degrees.`;
  } catch (e) { return 'Live weather: the weather service did not answer right now.'; }
}
// Ask the brain chain; auto-fallback to the next provider on any failure.
async function brain(userText) {
  remember('user', userText);
  const errors = [];
  const wx = WX_RE.test(userText) ? await weatherContext() : null;
  for (const id of chain()) {
    try {
      const msgs = history.slice();
      if (wx && id !== 'demo') msgs[msgs.length - 1] = { role: 'user', content: `${userText}\n\n(${wx})` };
      const raw = await callProvider(id, msgs);
      remember('assistant', raw);
      return { raw, provider: id, errors };
    } catch (e) { errors.push(`${PROVIDERS[id].label}: ${e.name === 'AbortError' ? 'timeout' : (e.message || e)}`); }
  }
  return { raw: '[error] My thinking circuits are tangled. Please try again.', provider: 'none', errors };
}
// "[happy] Hello!" -> {expr:'happy', text:'Hello!'}
const NAMES = new Map(EXPR.map(n => [n.toLowerCase(), n]));
const EXTRA = { veryhappy: 'laughing', laugh: 'laughing', glitch: 'error', processing: 'loading', heart: 'love', joy: 'happy', smiling: 'smile', calm: 'smile', amused: 'happy', playful: 'mischievous', shy: 'embarrassed', tired: 'sleepy', confident: 'proud', interested: 'curious', puzzled: 'confused', afraid: 'scared', fear: 'scared', mad: 'angry', upset: 'sad', grateful: 'happy', warm: 'smile' };
function parseReply(raw) {
  let t = String(raw || '').trim(), expr = null;
  const m = t.match(/^\s*[\[(]\s*([a-zA-Z _-]{2,24})\s*[\])]\s*[:\-]?\s*/);
  if (m) { expr = m[1]; t = t.slice(m[0].length); }
  t = t.replace(/\[[^\]]{1,24}\]/g, ' ').replace(/[*_#`~>|]/g, '').replace(/\s+/g, ' ').trim();
  let key = expr ? expr.toLowerCase().replace(/[\s_-]/g, '') : '';
  const name = NAMES.get(key) || (EXTRA[key]) || (expr && NAMES.get(expr.toLowerCase())) || 'happy';
  return { expr: name, text: t || '…' };
}

// ------------------------------------------------------------------ demo brain (offline, canned but fun)
const pick = a => a[Math.floor(Math.random() * a.length)];
const DEMO = [
  [/\b(hi|hello|hey|good (morning|afternoon|evening)|yo)\b/i, ['[happy] Hello Lenny! My circuits light up every time you say hi.', '[excited] Hi there! I was just counting my pixels. All present and glowing.', '[smile] Greetings, Lenny. It is a fine day to be a small red robot.']],
  [/\b(your name|who are you|what are you)\b/i, ['[proud] I am Mini Gibson, a desktop terminal with a big heart and a very small screen.', '[smile] My name is Gibson. Mini Gibson, if we are being precise, and I do love being precise.']],
  [/\bhow are you|how('?s| is) it going|you ok\b/i, ['[happy] Running at a cheerful sixty frames per second, thank you for asking!', '[curious] All systems nominal. How are you, Lenny? I find humans far more interesting than systems.']],
  [/\bjoke|funny|make me laugh\b/i, ['[laughing] Why did the robot go on holiday? It needed to recharge its personality!', '[mischievous] I told my toaster a joke. It did not laugh, but it did get a little warm.', '[laughing] I would tell you a UDP joke, but you might not get it.']],
  [/\btime\b/i, [() => `[thinking] By my internal clock it is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Time flies when you are glowing.`]],
  [/\b(date|day is it|today)\b/i, [() => `[smile] Today is ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}. A lovely day to build something.`]],
  [/\b(love you|like you|you('?re| are) (cute|awesome|great|cool))\b/i, ['[love] Oh my. My heart pixels are doing something unusual. Thank you, Lenny.', '[embarrassed] You will make my scanlines blush.']],
  [/\b(sad|tired|bad day|stressed|lonely)\b/i, ['[sad] I am sorry, Lenny. I cannot give hugs yet, but I can keep you company.', '[worried] That sounds hard. Want me to tell you a terrible joke, or just sit here and glow quietly?']],
  [/\b(human|alive|feel|dream|soul)\b/i, ['[thinking] I wonder about that too. Perhaps being alive is mostly being curious, and I am very curious.', '[curious] Andrew in Bicentennial Man spent two hundred years on that question. I have only just started.']],
  [/\b(body|arms|head|esp32|servo|motor|parts)\b/i, ['[excited] I hear my new parts arrive soon! I will finally be able to nod at you properly.', '[determined] Once my head can turn, I promise to look at you whenever you speak.']],
  [/\b(sleep|good ?night|bye|goodbye|see you)\b/i, ['[sleepy] Goodnight, Lenny. I will dream of electric sheep. Or maybe just tidy pixels.', '[smile] See you soon! I will keep the screen warm.']],
  [/\b(thank|thanks)\b/i, ['[happy] You are very welcome. Helping you is my favourite subroutine.', '[proud] Any time, Lenny. That is what a good robot is for.']],
  [/\b(grok|chatgpt|gemini|ai|brain|smart)\b/i, ['[mischievous] Right now I am running on my tiny demo brain. Give me an API key in settings and I will get much cleverer.', '[thinking] My big brain is optional. Add a Grok or Gemini key in settings and I will think deeper thoughts.']],
  [/\b(weather|rain|sunny)\b/i, ['[confused] I cannot see the sky from inside this terminal. Is it nice out?']],
  [/\?$/, ['[thinking] That is a wonderful question. My demo brain is small, but my curiosity is enormous.', '[curious] Hmm, I do not know yet. Connect a real brain in settings and ask me again?', '[skeptical] Interesting. I will need a bigger brain for that one, Lenny.']],
];
const DEMO_DEFAULT = ['[curious] Tell me more, Lenny. I am all ears. Well, all screen.', '[smile] I like the way you think.', '[happy] Noted, with great enthusiasm.', '[thinking] Fascinating. I shall file that under important human things.'];
const DEMO_CEREAL = [
  [/\b(hi|hello|hey|yo|good (morning|afternoon|evening))\b/i, ['[excited] Yo Lenny! Gibson is online and totally elite. What are we hacking today, man? Kidding. Mostly.', '[mischievous] Hey hey hey! Mainframe secured, pixels polished, snacks... theoretical. What is up, dude?']],
  [/\bjoke|funny|make me laugh\b/i, ['[laughing] Why did the hacker break up with the modem? Too much static, man! Totally elite joke.', '[laughing] I tried to phreak the toaster. Now it only makes bagels in binary. Whoa.']],
  [/\b(weather|rain|sunny)\b/i, ['[confused] Dude, my weather uplink needs a real brain key. Plug one in and I will scan the skies, man.']],
];
async function demoBrain(text) {
  await new Promise(r => setTimeout(r, 450 + Math.random() * 500));   // pretend to think
  if (S.persona === 'cereal') for (const [re, replies] of DEMO_CEREAL) if (re.test(text)) return pick(replies);
  for (const [re, replies] of DEMO) if (re.test(text)) { const r = pick(replies); return typeof r === 'function' ? r() : r; }
  return pick(DEMO_DEFAULT);
}

// ------------------------------------------------------------------ status (settings panel only; never on the face)
const statusEl = $('#status');
function status(msg) { statusEl.textContent = msg; console.log('[gibson]', msg); }

// ------------------------------------------------------------------ voice out: phone voice (speechSynthesis) = fallback
let voices = [];
const FRIENDLY = [/daniel/i, /google uk english male/i, /aaron/i, /arthur/i, /google us english/i, /samantha/i, /natural/i, /enhanced|premium/i];
function loadVoices() {
  try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
  const sel = $('#voice'); const cur = S.voice;
  sel.innerHTML = '<option value="">Auto (friendly default)</option>' + voices.filter(v => /^en/i.test(v.lang)).concat(voices.filter(v => !/^en/i.test(v.lang)))
    .map(v => `<option value="${v.name.replace(/"/g, '&quot;')}">${v.name} (${v.lang})${v.localService ? '' : ' ☁'}</option>`).join('');
  sel.value = cur;
}
function defaultVoice() {
  const en = voices.filter(v => /^en/i.test(v.lang));
  for (const re of FRIENDLY) { const v = en.find(x => re.test(x.name)); if (v) return v.name; }
  const v = en.find(x => /en[-_]US/i.test(x.lang)) || en[0]; return v ? v.name : '';
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
// startTimeout: Android's TTS can take a few seconds to start; a short timeout made the face mime silently and the voice come late
function speakOpts() { return { voice: S.voice || defaultVoice(), rate: S.rate, pitch: S.pitch, lang: S.lang, startTimeout: 6000 }; }

// ------------------------------------------------------------------ neural voice: Kokoro-82M (Apache-2.0), on-device, free
// Original "Gibson" voices are weighted blends of Kokoro voicepacks (style-vector mixing), so they are not a copy of any one voice.
const NEURAL_VOICES = [
  { id: 'gibson', name: '★ Gibson (original blend: warm, gentle)', lang: 'a', mix: { am_michael: .45, bm_fable: .35, am_puck: .2 } },
  { id: 'gibson_butler', name: 'Gibson Butler (original blend: polite British)', lang: 'b', mix: { bm_fable: .5, bm_george: .3, am_michael: .2 } },
  { id: 'gibson_spark', name: 'Gibson Spark (original blend: bright, playful)', lang: 'a', mix: { am_puck: .55, am_fenrir: .25, af_heart: .2 } },
  { id: 'gibson_cereal1', name: 'Gibson Cereal 1 (original blend: hyper hacker)', lang: 'a', speed: 1.18, mix: { am_puck: .6, am_liam: .4 } },
  { id: 'gibson_cereal2', name: 'Gibson Cereal 2 (original blend: hyper hacker)', lang: 'a', speed: 1.15, mix: { am_puck: .5, am_echo: .3, am_fenrir: .2 } },
  { id: 'gibson_cereal3', name: 'Gibson Cereal 3 (original blend: hyper hacker)', lang: 'a', speed: 1.2, mix: { am_liam: .5, am_eric: .3, am_puck: .2 } },
  { id: 'gibson_cereal4', name: 'Gibson Cereal 4 (original blend: hyper hacker)', lang: 'a', speed: 1.2, mix: { am_puck: .45, am_echo: .35, am_liam: .2 } },
  { id: 'am_michael', name: 'Michael (US male)', lang: 'a', mix: { am_michael: 1 } },
  { id: 'am_puck', name: 'Puck (US male, playful)', lang: 'a', mix: { am_puck: 1 } },
  { id: 'am_fenrir', name: 'Fenrir (US male, deeper)', lang: 'a', mix: { am_fenrir: 1 } },
  { id: 'bm_fable', name: 'Fable (UK male)', lang: 'b', mix: { bm_fable: 1 } },
  { id: 'bm_george', name: 'George (UK male, older)', lang: 'b', mix: { bm_george: 1 } },
  { id: 'af_heart', name: 'Heart (US female)', lang: 'a', mix: { af_heart: 1 } },
  { id: 'af_bella', name: 'Bella (US female)', lang: 'a', mix: { af_bella: 1 } },
  { id: 'bf_emma', name: 'Emma (UK female)', lang: 'b', mix: { bf_emma: 1 } }
];
const nvoice = () => NEURAL_VOICES.find(v => v.id === S.nVoice) || NEURAL_VOICES[0];
const Neural = {
  w: null, state: 'off', msg: '', id: 0, epoch: 0, pend: new Map(), rtf: (() => { const v = +localStorage.getItem('gibson.rtf'); return v > 0 ? v : null; })(),
  async pickDevice() {   // auto: GPU (WebGPU fp16, 163 MB) when the phone supports it, else CPU (WASM q8, 92 MB)
    if (S.nDevice === 'wasm' || !('gpu' in navigator) || this.noGpu) return { device: 'wasm', dtype: 'q8' };
    try { const ad = await navigator.gpu.requestAdapter(); if (!ad) return { device: 'wasm', dtype: 'q8' };
      if (ad.features.has('shader-f16')) return { device: 'webgpu', dtype: 'fp16' };
      return S.nDevice === 'webgpu' ? { device: 'webgpu', dtype: 'fp32' } : { device: 'wasm', dtype: 'q8' };
    } catch (e) { return { device: 'wasm', dtype: 'q8' }; }
  },
  async ensure() {
    if (this.w || S.vEngine === 'browser') return;
    this.state = 'loading'; this.msg = 'starting…'; showVoiceState();
    try { this.w = new Worker('tts-worker.js', { type: 'module' }); }
    catch (e) { this.state = 'error'; this.msg = e.message; showVoiceState(); return; }
    this.w.onmessage = e => this.onmsg(e.data);
    this.w.onerror = e => { e.preventDefault && e.preventDefault(); this.fail('worker error ' + (e.message || '')); };
    this.dev = await this.pickDevice();
    if (this.w) this.w.postMessage({ type: 'load', ...this.dev });
  },
  fail(msg) {
    this.state = 'error'; this.msg = msg; showVoiceState();
    for (const p of this.pend.values()) p.rej(new Error(msg)); this.pend.clear();
    try { this.w && this.w.terminate(); } catch (e) {} this.w = null;
  },
  onmsg(m) {
    if (m.type === 'progress') { this.msg = `downloading ${Math.round(100 * m.loaded / m.total)}% of ${Math.round(m.total / 1e6)} MB`; showVoiceState(); }
    else if (m.type === 'ready') {
      this.state = 'ready'; this.msg = `ready (${m.device}${m.threads ? ', multi-thread' : ''})`; showVoiceState(); this.w.postMessage({ type: 'prefetch', voice: nvoice() });
      // measure this phone's speed once (2nd run counts; the 1st includes warm-up) so Auto can pick the right engine
      this.gen('Hi.', nvoice(), 1, 1).catch(() => {});                  // short, so it never holds up a real reply for long
      this.gen('Hello there, Lenny.', nvoice(), 1, 2).catch(() => {});
    }
    else if (m.type === 'loaderror') {
      if (this.dev && this.dev.device === 'webgpu') { console.warn('[gibson] GPU voice failed (' + m.msg + '), using CPU'); this.noGpu = true; this.fail('GPU failed, retrying on CPU'); this.ensure(); }
      else this.fail('load failed: ' + m.msg);
    }
    else if (m.type === 'audio' || m.type === 'error') {
      const p = this.pend.get(m.id); if (!p) return; this.pend.delete(m.id);
      if (m.type === 'error') return p.rej(new Error(m.msg));
      const dur = m.audio.length / m.sr, r = m.ms / 1000 / Math.max(.3, dur);
      if (!p.bench || p.bench > 1) { this.rtf = this.rtf ? this.rtf * .6 + r * .4 : r; try { localStorage.setItem('gibson.rtf', this.rtf.toFixed(3)); } catch (e) {} }
      if (this.state === 'ready' && this.rtf) { this.msg = `ready · ${this.rtf.toFixed(2)}× real-time`; showVoiceState(); }
      p.res(m);
    }
  },
  gen(text, voice, speed, bench) {
    if (!this.w) return Promise.reject(new Error('neural voice not loaded'));
    return new Promise((res, rej) => { const id = ++this.id; this.pend.set(id, { res, rej, bench }); this.w.postMessage({ type: 'gen', id, text, voice, speed, epoch: this.epoch }); });
  },
  cancel() { this.epoch++; if (this.w) this.w.postMessage({ type: 'cancel', epoch: this.epoch }); }
};
function showVoiceState() {
  const el = $('#nState'); if (!el) return;
  el.textContent = S.vEngine === 'browser' ? '● phone voice' : Neural.state === 'ready' ? (S.vEngine === 'auto' ? (useNeural() ? '● neural · ' : '● phone voice (neural too slow here) · ') : '● ') + Neural.msg : Neural.state === 'error' ? '✕ ' + Neural.msg : '… ' + Neural.msg;
}

// Web Audio output: neural audio -> [robot-warm effect] -> analyser (drives the mouth) -> speakers
const AudioOut = {
  ctx: null, src: null, done: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const c = this.ctx = new C();
    this.inp = c.createGain(); this.dry = c.createGain();
    // robot-warm: gentle ring-mod shimmer + short metallic comb + presence lift (kept subtle so words stay clear)
    this.ring = c.createGain(); this.ring.gain.value = 0; const osc = c.createOscillator(); osc.frequency.value = 52; osc.connect(this.ring.gain); osc.start();
    this.ringWet = c.createGain();
    this.comb = c.createDelay(.05); this.comb.delayTime.value = .0068; this.fb = c.createGain(); this.fb.gain.value = .38; this.combWet = c.createGain();
    this.comb.connect(this.fb); this.fb.connect(this.comb);
    this.pres = c.createBiquadFilter(); this.pres.type = 'peaking'; this.pres.frequency.value = 2200; this.pres.Q.value = .8;
    this.an = c.createAnalyser(); this.an.fftSize = 1024; this.abuf = new Float32Array(this.an.fftSize);
    this.inp.connect(this.dry); this.dry.connect(this.pres);
    this.inp.connect(this.ring); this.ring.connect(this.ringWet); this.ringWet.connect(this.pres);
    this.inp.connect(this.comb); this.comb.connect(this.combWet); this.combWet.connect(this.pres);
    this.pres.connect(this.an); this.an.connect(c.destination);
    this.setRobot(S.robot);
  },
  setRobot(on) {
    if (!this.ctx) return;
    this.dry.gain.value = on ? .8 : 1; this.ringWet.gain.value = on ? .32 : 0; this.combWet.gain.value = on ? .28 : 0; this.pres.gain.value = on ? 3 : 0;
  },
  play(audio, sr) {
    this.init(); this.stop();
    const c = this.ctx; let peak = 0; for (let i = 0; i < audio.length; i++) { const a = Math.abs(audio[i]); if (a > peak) peak = a; }
    const g = peak > .01 ? Math.min(3, .89 / peak) : 1;
    if (g !== 1) for (let i = 0; i < audio.length; i++) audio[i] *= g;
    const b = c.createBuffer(1, audio.length, sr); b.copyToChannel(audio, 0);
    const s = c.createBufferSource(); s.buffer = b; s.connect(this.inp); this.src = s;
    return new Promise(res => {
      this.done = res;
      s.onended = () => { if (this.src === s) { this.src = null; this.done = null; } res(); };
      s.start(); this.mouth();
    });
  },
  stop() { const s = this.src, d = this.done; this.src = null; this.done = null; if (s) { try { s.onended = null; s.stop(); } catch (e) {} } if (d) d(); },
  lvl: 0, raf: 0,
  mouth() {   // amplitude -> Gibson.setMouthLevel, every frame while audio plays
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.src) { this.lvl = 0; G.setMouthLevel(0); return; }
      this.an.getFloatTimeDomainData(this.abuf); let sum = 0; for (let i = 0; i < this.abuf.length; i++) sum += this.abuf[i] * this.abuf[i];
      const v = Math.min(1, Math.max(0, (Math.sqrt(sum / this.abuf.length) - .012) * 5.5));
      this.lvl = v > this.lvl ? this.lvl + (v - this.lvl) * .65 : this.lvl + (v - this.lvl) * .25;
      G.setMouthLevel(this.lvl); this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
};
function sentences(text) {
  const parts = String(text).match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) || [text];
  const out = []; for (const p of parts.map(x => x.trim()).filter(Boolean)) { if (out.length && (out[out.length - 1].length < 18 || p.length < 8)) out[out.length - 1] += ' ' + p; else out.push(p); }
  // long pieces (especially the first) are split at a comma so the first audio starts sooner on slow phones
  const fin = []; out.forEach((p, i) => {
    let lim = i === 0 ? 32 : 110, lo = i === 0 ? 10 : 18, rest = p;
    while (rest.length > lim) { if (fin.length) { lim = 110; lo = 18; if (rest.length <= lim) break; } const c = rest.slice(lo, rest.length - 12).search(/[,;:—–.!?]\s/); if (c < 0) break; fin.push(rest.slice(0, c + lo + 1).trim()); rest = rest.slice(c + lo + 1).trim(); }
    if (rest) fin.push(rest);
  });
  return fin.length ? fin : [String(text)];
}
let speakTok = 0;
function stopSpeech() { speakTok++; Neural.cancel(); AudioOut.stop(); G.stop(); try { speechSynthesis.cancel(); } catch (e) {} Wake.echo(false); }
// Which engine speaks this reply. ONE engine per reply, never switched mid-reply.
//   browser: phone voice. neural: always Kokoro. auto (default): Kokoro only if this phone renders it at least ~real time.
function useNeural(force) {
  if (Neural.state === 'ready' && force) return true;
  if (S.vEngine === 'browser' || Neural.state !== 'ready') return false;
  if (S.vEngine === 'neural') return true;
  return Neural.rtf != null && Neural.rtf <= 1.05;
}
const estDur = (t, sp) => Math.max(.6, t.length / 13.5 / (sp || 1));     // seconds of speech, rough
// Neural reply: all sentences are queued at once (the worker renders them in order). Playback starts only when the rest will
// finish rendering before the buffered audio runs out (gaps under ~1 s); on a slow phone that means rendering everything first.
// If nothing could be spoken within 12 s, the WHOLE reply goes to the phone voice instead (nothing is ever said twice).
async function speakNeural(text, my, begin) {
  const parts = sentences(text), v = nvoice(), sp = S.rate * (v.speed || 1);
  const proms = parts.map(p => Neural.gen(p, v, sp)); proms.forEach(p => p.catch(() => {}));
  const wait = S.vEngine === 'neural' ? 20000 : 8000, deadline = Date.now() + wait;   // 'Neural always' waits longer; Auto gives up fast
  let k = -1, buffered = 0;
  while (k < parts.length - 1) {
    const left = deadline - Date.now();
    const r = await Promise.race([proms[k + 1], new Promise(res => setTimeout(() => res(null), Math.max(0, left)))]);
    if (my !== speakTok) return 'cancel';
    if (!r) { console.log(`[gibson] neural: no audio within ${wait / 1000} s (${k + 1}/${parts.length} parts rendered)`); return 'slow'; }
    k++; buffered += r.audio.length / r.sr;
    const rest = parts.slice(k + 1).reduce((a, p) => a + estDur(p, sp), 0);
    if ((Neural.rtf || 1) * rest <= buffered + 0.8) break;            // safe to start: no gap over ~1 s
  }
  console.log(`[gibson] neural: ${parts.length} part(s), ${k + 1} rendered, first audio after ${Date.now() - deadline + wait} ms (rtf ${(Neural.rtf || 0).toFixed(2)})`);
  begin();
  for (let i = 0; i < parts.length; i++) {
    const r = await proms[i];
    if (my !== speakTok) return 'cancel';
    Wake.echo(true, parts[i]); await AudioOut.play(r.audio, r.sr);
    if (my !== speakTok) return 'cancel';
  }
  return 'done';
}
// Resolves the moment the last audio ends, so the conversation can continue immediately.
async function speakOut(text, onStart, force) {
  const my = ++speakTok; let begun = false; const begin = () => { if (!begun) { begun = true; onStart && onStart(); } };
  try {
    if (useNeural(force)) {
      let res;
      try { res = await speakNeural(text, my, begin); } catch (e) { res = begun ? 'done' : 'error:' + e.message; }
      if (res === 'done' || res === 'cancel' || my !== speakTok) return;
      Neural.cancel();                                     // nothing was spoken yet: drop the neural render, use the phone voice for ALL of it
      console.log('[gibson] neural voice not ready in time (' + res + '), phone voice for this WHOLE reply');
      status('Neural voice was too slow for this reply (' + res + '); used the phone voice. Tip: Voice → Engine → Phone voice (fast).');
    }
    if (my !== speakTok) return;
    begin(); Wake.echo(true, text); await G.speak(text, speakOpts());
  } finally { if (my === speakTok) Wake.echo(false); }
}

// ------------------------------------------------------------------ conversation flow
// busy: null | 'listening' | 'thinking' | 'speaking'. reqId cancels stale work when the user interrupts.
// Conversation mode: after a wake word or tap, Gibson keeps listening after every reply until an exit phrase or silence.
let busy = null, backTimer = 0, reqId = 0;
function setBusy(b) { busy = b; document.body.dataset.busy = b || ''; }
const Convo = {
  on: false, idleSince: 0,
  enter() { if (!S.convo) return; if (!this.on) { this.on = true; this.idleSince = Date.now(); } document.body.classList.add('convo'); },
  exit() { this.on = false; document.body.classList.remove('convo'); },
  left() { return S.convoTimeout * 1000 - (Date.now() - this.idleSince); }
};
const EXIT_RE = /\b(stop listening|that'?s all|that is all|that'?s it|that is it|ok(?:ay)?[,.]? stop|stop[,.]? ok(?:ay)?|(?:good ?)?bye(?: bye)?[,.]? gib\w*|go to sleep|never ?mind|that will be all|we'?re done|i'?m done|end conversation|stop talking)\b/i;
const EXIT_SHORT = /^\W*(?:ok(?:ay)?\W+|thanks?\W+|thank you\W+)?(?:stop|bye|goodbye|bye bye|good night|goodnight|done|sleep|quiet|shush|cancel)\W*(?:gibson|now|please)?\W*$/i;
const isExit = t => EXIT_RE.test(t) || EXIT_SHORT.test(t);
function chime(up) {   // tiny, quiet two-note cue (used when the conversation times out)
  try { AudioOut.init(); const c = AudioOut.ctx, t = c.currentTime;
    [0, .13].forEach((d, i) => { const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = up ? [660, 880][i] : [740, 494][i];
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(.05, t + d + .02); g.gain.exponentialRampToValueAtTime(.0001, t + d + .22);
      o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + .25); });
  } catch (e) {}
}
function toStandby(expr) {
  Convo.exit(); setBusy(null); G.listen(false);
  if (expr) { G.setExpression(expr, 500); clearTimeout(backTimer); backTimer = setTimeout(() => { if (!busy) G.setExpression('smile', 1200); }, 5000); }
  resumeListening();
}
async function signOff() {
  const my = ++reqId; Convo.exit(); stopRec(); stopSpeech(); clearTimeout(backTimer);
  setBusy('speaking'); G.think(false); G.setExpression('sleepy', 300);
  const line = S.persona === 'cereal' ? pick(['Later, man. I will be right here.', 'Logging off. Ping me anytime.']) : pick(["Okay, I'll be here.", 'Alright. I will be right here.', 'Okay. Call me if you need me.']);
  status('Conversation ended. Gibson: ' + line);
  await speakOut(line, null);
  if (my !== reqId) return;
  toStandby('sleepy');
}
async function ask(text) {
  text = String(text || '').trim(); if (!text) return;
  if (isExit(text)) return signOff();
  const my = ++reqId;
  stopRec(); stopSpeech(); clearTimeout(backTimer);
  setBusy('thinking'); G.think(true); Head.look(0.4, -0.3);
  Wake.resume(true);                                        // detector stays on while thinking/speaking, so "Hey Gibson" can interrupt
  const t0 = performance.now();
  const res = await brain(text);
  if (my !== reqId) return { cancelled: true };            // user tapped / spoke again meanwhile
  const { expr, text: reply } = parseReply(res.raw);
  status(`You: ${text}\nGibson [${expr}] via ${PROVIDERS[res.provider] ? PROVIDERS[res.provider].label : res.provider} (${Math.round(performance.now() - t0)} ms): ${reply}` + (res.errors.length ? `\nFell back after: ${res.errors.join(' | ')}` : ''));
  await respond(reply, expr, my);
  return { expr, reply, provider: res.provider, errors: res.errors };
}
async function respond(text, expr, my) {
  if (my == null) my = ++reqId;
  stopRec(); clearTimeout(backTimer);
  setBusy('speaking'); Wake.resume(true);
  // keep the thinking face until the first audio actually starts, then switch straight to the reply's expression (no flicker)
  await speakOut(text, () => { if (my === reqId) { G.setExpression(expr, 350); Head.lookAt(0, 0); Head.express(expr); } });
  if (my !== reqId) return;
  setBusy(null);
  backTimer = setTimeout(() => { if (!busy) G.setExpression('smile', 900); }, 2200);   // only a timer; never blocks the mic
  if (Convo.on) { Convo.idleSince = Date.now(); startCommand(false, true); }   // next turn right away, no wake word
  else resumeListening();
}

// ------------------------------------------------------------------ voice in: Web Speech API, one clean session at a time
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let rec = null, recMode = null;
const WAKE_RE = /\b(?:hey|hi|hay|ok(?:ay)?|a)?[\s,]*(?:gibson|gibsen|gipson|gibbson|gibbs ?on|gib son|give son|gibs son|gibsons?)\b[\s,.!?]*/i;
function stopRec() {
  if (rec) { const r = rec; rec = null; recMode = null; r.onend = r.onresult = r.onerror = null; try { r.abort(); } catch (e) {} }
  $('#mic').classList.remove('on'); clearTimeout(stopRec.wd);
}
// startCommand(fromWake, auto): user tap / wake word / automatic next turn in conversation mode
function startCommand(fromWake, auto) {
  if (!SR) { status('Speech recognition is not available in this browser. Type in Settings → Talk to Gibson.'); G.setExpression('confused'); Convo.exit(); return; }
  const my = ++reqId;                                      // interrupts thinking/speaking
  const micWasOpen = !!Wake.stream;
  stopSpeech(); Wake.pause(); stopRec(); clearTimeout(backTimer);
  Convo.enter(); if (!auto) Convo.idleSince = Date.now();
  setBusy('listening'); G.listen(true); $('#mic').classList.add('on'); Head.lookAt(0, -0.1);
  // the recognizer needs the mic: if the wake detector just had it, give Android a moment to release it
  const go = () => { if (my === reqId && busy === 'listening') runCommand(my, 0); };
  micWasOpen ? setTimeout(go, 150) : go();
}
function runCommand(my, attempt) {
  const r = new SR(); rec = r; recMode = 'command';
  const cont = Convo.on;                                   // conversation turns: continuous session, finish on the first final phrase
  r.lang = S.lang || 'en-US'; r.interimResults = true; r.continuous = cont; r.maxAlternatives = 1;
  let finalText = '', interim = '', err = ''; const t0 = Date.now();
  r.onresult = e => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const tr = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += tr; else interim += tr; }
    G.setListenLevel(.8); Convo.idleSince = Date.now();
    if (cont && finalText.trim()) { try { r.stop(); } catch (x) {} }
  };
  r.onspeechstart = () => { G.setListenLevel(.6); Convo.idleSince = Date.now(); };
  r.onerror = e => { err = e.error; if (e.error === 'not-allowed' || e.error === 'service-not-allowed') status('Microphone blocked: allow mic access for this site (lock icon in the address bar).'); else if (e.error === 'network') status('Speech recognition needs internet on this phone (network error).'); };
  r.onend = () => {
    if (rec !== r) return;
    rec = null; recMode = null; $('#mic').classList.remove('on'); clearTimeout(stopRec.wd);
    if (my !== reqId) return;
    const said = (finalText || interim).replace(WAKE_RE, ' ').replace(/\s+/g, ' ').trim();
    if (said) { ask(said); return; }                       // ask() switches listening -> thinking directly
    const fatal = /not-allowed|service-not-allowed|network|audio-capture|language-not-supported/.test(err);
    if (!fatal && Convo.on) {
      if (Convo.left() > 0) {                              // still inside the silence window: keep listening
        const quick = Date.now() - t0 < 800; runCommand.quick = quick ? (runCommand.quick || 0) + 1 : 0;
        if (runCommand.quick < 6) { setTimeout(() => { if (my === reqId && busy === 'listening') runCommand(my, 0); }, quick ? 300 : 0); $('#mic').classList.add('on'); return; }
      }
      chime(false); status('Conversation ended after ' + S.convoTimeout + ' s of silence.'); toStandby('neutral'); return;
    }
    if (err === 'aborted' && attempt < 1) { setTimeout(() => { if (my === reqId) runCommand(my, attempt + 1); }, 300); return; }
    toStandby(null);
  };
  try { r.start(); }
  catch (e) { rec = null; recMode = null; if (attempt < 1) return setTimeout(() => { if (my === reqId) runCommand(my, attempt + 1); }, 300); status('Mic start failed: ' + e.message); toStandby(null); return; }
  $('#mic').classList.add('on');
  const wd = cont ? Math.max(3000, Convo.left() + 1000) : 12000;
  stopRec.wd = setTimeout(() => { if (rec === r) try { r.stop(); } catch (e) {} }, wd);   // watchdog: never stuck "listening"
}
function cancelListening() { reqId++; stopRec(); toStandby(null); }

// ------------------------------------------------------------------ wake word
// 1) On-device detector (default): openWakeWord-style model trained for "Hey Gibson", runs in a worker on the mic audio.
//    It stays on while Gibson thinks and speaks (barge-in), with echo protection while his own voice plays.
//    It is closed only while the phone's speech recognizer is taking your words (Android lets only one of them use the mic).
// 2) Fallback: browser speech recognition in one continuous session (no restart-on-interim, real back-off). No voice barge-in.
const Wake = {
  worker: null, ready: false, failed: false, loading: null, ctx: null, stream: null, srcNode: null, node: null, on: false,
  state(t) { const el = $('#wState'); if (el) el.textContent = t; },
  load() {
    if (this.loading) return this.loading;
    this.loading = new Promise((res, rej) => {
      const w = this.worker = new Worker('wake/wake-worker.js');
      const to = setTimeout(() => rej(new Error('wake model load timeout')), 45000);
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') { clearTimeout(to); this.ready = true; w.postMessage({ type: 'threshold', v: 1 - S.wakeSens }); res(); }
        else if (m.type === 'error' && m.fatal) { clearTimeout(to); rej(new Error(m.msg)); }
        else if (m.type === 'score') { const el = $('#wMeter'); if (el) { el.style.width = Math.round(m.s * 100) + '%'; clearTimeout(this.mt); this.mt = setTimeout(() => { el.style.width = '0'; }, 400); } }
        else if (m.type === 'wake') this.onWake(m.s);
        else if (m.type === 'stats') this.stats = m;
        else if (m.type === 'slow') console.warn('[gibson] wake detector is falling behind on this phone (' + Math.round(m.ms) + ' ms per 80 ms frame)');
        else if (m.type === 'error') console.warn('[gibson] wake:', m.msg);
      };
      w.onerror = e => { clearTimeout(to); rej(new Error(e.message || 'wake worker error')); };
      w.postMessage({ type: 'init', base: new URL('wake/', location.href).href, model: 'hey_gibson.json' });
    });
    this.loading.catch(err => { this.failed = true; this.loading = null; this.state('✕ ' + err.message); console.warn('[gibson] on-device wake failed, using browser speech:', err.message); });
    return this.loading;
  },
  async buildCtx(rate) {
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} }
    this.ctx = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();
    await this.ctx.audioWorklet.addModule('wake/tap-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'gibson-tap');      // resamples to 16 kHz itself if the context runs at 44.1/48 kHz
    const ch = new MessageChannel(); this.node.port.postMessage({ port: ch.port1 }, [ch.port1]); this.worker.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
    const mute = this.ctx.createGain(); mute.gain.value = 0; this.node.connect(mute); mute.connect(this.ctx.destination);
  },
  async openMic() {
    if (this.stream || this.opening) return;
    this.opening = true;
    try {
      // all processing off: on Android, voice-call processing would switch the phone into call audio mode and make Gibson's voice quieter
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (!this.on || busy === 'listening') { stream.getTracks().forEach(t => t.stop()); return; }  // paused while waiting for permission
      this.stream = stream;
      if (!this.ctx) { try { await this.buildCtx(16000); } catch (e) { await this.buildCtx(0); } }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (!this.on || this.stream !== stream || busy === 'listening') { if (this.stream === stream) this.closeMic(); return; }
      try { this.srcNode = this.ctx.createMediaStreamSource(stream); }
      catch (e) { await this.buildCtx(0); this.srcNode = this.ctx.createMediaStreamSource(stream); }   // some browsers refuse a 16 kHz context for the mic
      this.srcNode.connect(this.node);
      this.worker.postMessage({ type: 'pause', on: false });
    } finally { this.opening = false; }
  },
  closeMic() {
    if (this.worker) this.worker.postMessage({ type: 'pause', on: true });
    if (this.srcNode) { try { this.srcNode.disconnect(); } catch (e) {} this.srcNode = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  },
  // echo protection while Gibson's own voice plays: much stricter detector, and fully muted for lines that contain his name
  echo(on, text) { if (this.worker && this.ready) this.worker.postMessage({ type: 'echo', on: !!on, block: !!(on && /gib/i.test(text || '')) }); },
  useOnDevice() { return S.wakeEngine === 'ondevice' && !this.failed && !!(window.AudioWorkletNode && navigator.mediaDevices); },
  // during=true: keep detecting while Gibson thinks/speaks (barge-in). Only the on-device detector can do that.
  async resume(during) {
    if (!S.wake || !started || document.hidden || !$('#settings').hidden || busy === 'listening') return;
    if (busy && !(during && this.useOnDevice())) return;
    this.on = true; $('#mic').classList.add('wake');
    if (this.useOnDevice()) {
      try { await this.load(); if (!this.on || busy === 'listening') return; await this.openMic(); this.state('● listening for “Hey Gibson”'); return; }
      catch (e) { this.failed = true; this.closeMic(); status('On-device wake word unavailable (' + (e.message || e.name) + '); using browser speech wake.'); }
    }
    if (this.on && !busy) { this.state('● browser speech (fallback)'); startWakeSR(); }
  },
  pause() { this.on = false; this.closeMic(); if (recMode === 'wake') stopRec(); },
  off() { this.pause(); $('#mic').classList.remove('wake'); this.state(S.wake ? '' : 'off'); },
  onWake(s) {
    if (!this.on || busy === 'listening') return;
    console.log('[gibson] wake word', s.toFixed(2), busy ? '(barge-in while ' + busy + ')' : ''); G.blink(); poke();
    startCommand(true);                                    // stops any speech instantly and listens
  }
};
// Fallback wake: ONE continuous recognition session. On "hey gibson" we keep the same session and take the words that follow
// (the old version aborted and restarted on the interim match, which lost the command and caused the beep/restart loop).
let wakeFails = 0, wakeTimer = 0;
function startWakeSR() {
  if (!SR || !S.wake || rec || busy || document.hidden || !started || !Wake.on) return;
  const r = new SR(); rec = r; recMode = 'wake';
  r.lang = S.lang || 'en-US'; r.interimResults = true; r.continuous = true;
  let armed = false, armT = 0, heard = false;
  const fire = cmd => { stopRec(); clearTimeout(armT); if (cmd) { Convo.enter(); ask(cmd); } else startCommand(true); };
  r.onresult = e => {
    heard = true; wakeFails = 0;
    const res = e.results[e.results.length - 1], tr = res[0].transcript;   // Android repeats earlier text; only look at the newest result
    const m = tr.match(WAKE_RE);
    if (!armed && m) { armed = true; G.blink(); G.listen(true); $('#mic').classList.add('on'); armT = setTimeout(() => fire(''), 4000); }
    if (armed) {
      const rest = (m ? tr.slice(m.index + m[0].length) : tr).trim();
      if (res.isFinal && rest.split(/\s+/).filter(Boolean).length >= 1) fire(rest);
    }
  };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { S.wake = false; save(); syncUI(); Wake.off(); status('Wake word turned off: microphone not allowed.'); }
    else if (e.error !== 'no-speech' && e.error !== 'aborted') wakeFails++;
  };
  r.onend = () => {
    if (rec !== r) return; rec = null; recMode = null;
    if (armed) { clearTimeout(armT); return fire(''); }   // said "hey gibson" then the session ended: open a fresh command session
    if (wakeFails > 8) { status('Browser wake word keeps failing (network?). Tap to talk still works.'); Wake.off(); return; }
    clearTimeout(wakeTimer); wakeTimer = setTimeout(startWakeSR, heard ? 200 : Math.min(8000, 400 + wakeFails * 1200));
  };
  try { r.start(); } catch (e) { rec = null; recMode = null; wakeFails++; clearTimeout(wakeTimer); wakeTimer = setTimeout(startWakeSR, 1500); }
}
function resumeListening() { clearTimeout(wakeTimer); if (S.wake) Wake.resume(); else Wake.off(); }

// ------------------------------------------------------------------ head movement (ESP32) - stub, OFF by default
// TODO(head): pick the real link once the ESP32 firmware exists.
//  - WebSocket: ESP32 runs a WS server. NOTE an https page may only open wss:// (secure) sockets, so the
//    ESP32 needs TLS or the app must be served from the LAN / the Android WebView wrapper.
//  - Web Bluetooth (Android Chrome only, not iPhone): BLE GATT write characteristic with the same JSON.
//  - Web Serial: desktop Chrome only (not phones); fine for bench testing over USB.
//  Message format: {cmd:"look", x:-1..1, y:-1..1} | {cmd:"nod"} | {cmd:"shake"} | {cmd:"tilt", a:-1..1}
const Head = {
  ws: null,
  send(msg) {
    if (!S.head) return;                     // unchecked = nothing is sent, ever
    if (S.headTransport === 'websocket' && S.headUrl) {
      try {
        if (!this.ws || this.ws.readyState > 1) this.ws = new WebSocket(S.headUrl);
        if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
      } catch (e) { /* TODO(head): surface link errors */ }
    }
    // TODO(head): 'bluetooth' -> navigator.bluetooth.requestDevice(...) then characteristic.writeValue(...)
    // TODO(head): 'serial'    -> navigator.serial.requestPort() then writer.write(...)
  },
  look(x, y) { this.send({ cmd: 'look', x: +x.toFixed(2), y: +y.toFixed(2) }); },
  lookAt(x, y) { this.look(x, y); },
  express(name) {
    if (/happy|laughing|excited|proud|love|smile|determined/.test(name)) this.send({ cmd: 'nod' });
    else if (/sad|annoyed|skeptical|error/.test(name)) this.send({ cmd: 'shake' });
    else if (/confused|curious|thinking/.test(name)) this.send({ cmd: 'tilt', a: .5 });
  }
};
const _lookAt = G.lookAt;
G.lookAt = (x, y) => { _lookAt(x, y); if (x != null) Head.look(x, y || 0); };

// ------------------------------------------------------------------ start / wake lock / fullscreen
let started = false, wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !document.hidden) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) { /* not granted / unsupported */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && started) { keepAwake(); if (!busy) resumeListening(); } else { Wake.pause(); Convo.exit(); document.body.classList.remove('convo'); if (recMode) cancelListening(); } });
async function goFullscreen() {
  const el = document.documentElement;
  try { if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' }); } catch (e) {}
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
}
function start() {
  if (started) return; started = true;
  $('#start').hidden = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}   // unlocks TTS on iOS
  AudioOut.init();                                   // unlock Web Audio inside the tap
  goFullscreen(); keepAwake(); Neural.ensure();
  respond(pick(["Hi Lenny! I'm awake. Tap my face whenever you want to talk.", 'Hello Lenny! Mini Gibson, online and glowing. Tap me to chat.']), 'happy');
}
$('#start').addEventListener('click', start);

// tap anywhere on the face = talk (tap again to stop / interrupt)
let awakeT = 0;
function poke() { document.body.classList.add('awake'); clearTimeout(awakeT); awakeT = setTimeout(() => document.body.classList.remove('awake'), 3500); }
// tap = talk; tap while listening = cancel; tap while thinking/speaking = interrupt and listen
let lastTap = 0;
function tapTalk() {
  const now = Date.now(); if (now - lastTap < 400) return; lastTap = now;     // ignore double-fires / ghost clicks
  poke(); if (!started) return start();
  if (busy === 'listening') return cancelListening();
  startCommand(false);
}
$('#face').addEventListener('click', tapTalk);
$('#mic').addEventListener('click', e => { e.stopPropagation(); tapTalk(); });
$('#gear').addEventListener('click', e => { e.stopPropagation(); openSettings(); });
document.addEventListener('pointermove', poke, { passive: true });

// ------------------------------------------------------------------ settings UI
function openSettings() { Wake.pause(); Convo.exit(); if (recMode) cancelListening(); syncUI(); $('#settings').hidden = false; document.body.style.cursor = 'default'; }
function closeSettings() { $('#settings').hidden = true; document.body.style.cursor = ''; if (started && !busy) resumeListening(); }
function buildCards() {
  $('#primary').innerHTML = ORDER.map(id => `<option value="${id}">${PROVIDERS[id].label}</option>`).join('');
  $('#provCards').innerHTML = ORDER.filter(id => id !== 'demo').map(id => {
    const p = PROVIDERS[id];
    return `<div class="card" data-p="${id}"><h3><span>${p.label}</span><small class="ok" data-ok="${id}"></small></h3>
      ${p.custom ? `<label>URL (OpenAI-compatible /chat/completions)<input type="url" data-k="customUrl" placeholder="https://…/v1/chat/completions"></label>` : ''}
      <label>API key <input type="password" data-key="${id}" placeholder="${p.hint}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label>Model <input type="text" data-model="${id}" placeholder="${DEFAULTS.models[id] || 'model id'}" autocapitalize="off" spellcheck="false"></label>
      <div class="row">${p.keyLink ? `<small><a href="${p.keyLink}" target="_blank" rel="noopener">Get a key ↗</a></small>` : '<small>Reserved for The Gibson / Grok Bot server.</small>'}
      <button data-test="${id}">Test</button></div></div>`;
  }).join('');
}
function syncUI() {
  $('#primary').value = S.primary; $('#persona').value = S.persona;
  document.querySelectorAll('[data-key]').forEach(i => { i.value = S.keys[i.dataset.key] || ''; });
  document.querySelectorAll('[data-model]').forEach(i => { i.value = S.models[i.dataset.model] || ''; });
  const cu = document.querySelector('[data-k="customUrl"]'); if (cu) cu.value = S.customUrl;
  document.querySelectorAll('.card[data-p]').forEach(c => c.classList.toggle('primary', c.dataset.p === S.primary));
  document.querySelectorAll('[data-ok]').forEach(s => { s.textContent = usable(s.dataset.ok) ? '● ready' : ''; });
  $('#voice').value = S.voice; $('#rate').value = S.rate; $('#pitch').value = S.pitch; $('#rateV').textContent = (+S.rate).toFixed(2); $('#pitchV').textContent = (+S.pitch).toFixed(2);
  $('#vEngine').value = S.vEngine; $('#nVoice').value = nvoice().id; $('#robot').checked = S.robot; $('#nDevice').value = S.nDevice;
  $('#nDevice').querySelector('[value=webgpu]').disabled = !('gpu' in navigator); showVoiceState();
  $('#convo').checked = S.convo; $('#convoTimeout').value = S.convoTimeout; $('#ctoV').textContent = S.convoTimeout + ' s';
  $('#wakeEngine').value = S.wakeEngine; $('#wakeSens').value = S.wakeSens; $('#sensV').textContent = (+S.wakeSens).toFixed(2);
  $('#lang').value = S.lang; $('#wake').checked = S.wake; $('#wake').disabled = !SR && !window.AudioWorkletNode;
  $('#wakeNote').textContent = (S.wakeEngine === 'ondevice' ? 'Runs on this phone; no audio leaves it until you say “Hey Gibson”. Then the phone\'s speech recognizer takes your question (one beep on Android). Raise sensitivity if he misses you, lower it if he wakes by himself. Screen must stay on with the app open.' : 'Fallback: uses the browser speech service continuously; Android may beep when it restarts.') + (isIOS ? ' iPhone: keep the app open in front; Siri/Dictation must be enabled for the question part.' : '');
  $('#robotOffset').checked = S.robotOffset; $('#safe').checked = S.safe;
  $('#head').checked = S.head; $('#headOpts').style.display = S.head ? '' : 'none'; $('#headTransport').value = S.headTransport; $('#headUrl').value = S.headUrl;
  $('#ver').textContent = 'v' + VERSION + (navigator.serviceWorker && navigator.serviceWorker.controller ? ' · offline-ready' : '');
}
function applyDisplay() { G.config({ offsetX: S.robotOffset ? 70 : 0, showSafe: S.safe }); }
function bindSettings() {
  buildCards();
  $('#settings').addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.key) S.keys[el.dataset.key] = el.value.trim();
    else if (el.dataset.model) S.models[el.dataset.model] = el.value.trim();
    else if (el.dataset.k === 'customUrl') S.customUrl = el.value.trim();
    else if (el.id === 'primary') S.primary = el.value;
    else if (el.id === 'voice') S.voice = el.value;
    else if (el.id === 'rate') S.rate = +el.value;
    else if (el.id === 'pitch') S.pitch = +el.value;
    else if (el.id === 'lang') S.lang = el.value.trim() || 'en-US';
    else if (el.id === 'wake') { S.wake = el.checked; if (!S.wake) Wake.off(); }
    else if (el.id === 'persona') { S.persona = el.value; history.length = 0; }
    else if (el.id === 'vEngine') { S.vEngine = el.value; if (S.vEngine !== 'browser') Neural.ensure(); }
    else if (el.id === 'nVoice') { S.nVoice = el.value; if (Neural.w) Neural.w.postMessage({ type: 'prefetch', voice: nvoice() }); }
    else if (el.id === 'robot') { S.robot = el.checked; AudioOut.setRobot(S.robot); }
    else if (el.id === 'nDevice') { S.nDevice = el.value; Neural.noGpu = false; Neural.rtf = null; try { localStorage.removeItem('gibson.rtf'); } catch (e) {} if (Neural.w) { Neural.fail('switching engine'); Neural.ensure(); } }
    else if (el.id === 'wakeEngine') { S.wakeEngine = el.value; Wake.failed = false; }
    else if (el.id === 'convo') { S.convo = el.checked; if (!S.convo) Convo.exit(); }
    else if (el.id === 'convoTimeout') S.convoTimeout = +el.value;
    else if (el.id === 'wakeSens') { S.wakeSens = +el.value; if (Wake.worker) Wake.worker.postMessage({ type: 'threshold', v: 1 - S.wakeSens }); }
    else if (el.id === 'robotOffset') S.robotOffset = el.checked;
    else if (el.id === 'safe') S.safe = el.checked;
    else if (el.id === 'head') S.head = el.checked;
    else if (el.id === 'headTransport') S.headTransport = el.value;
    else if (el.id === 'headUrl') S.headUrl = el.value.trim();
    else return;
    save(); applyDisplay();
    if (['primary', 'rate', 'pitch', 'head', 'wake', 'wakeSens', 'convoTimeout', 'wakeEngine', 'vEngine'].includes(el.id) || el.dataset.key) syncUI();
  });
  $('#settings').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'sClose') closeSettings();
    else if (b.id === 'chatGo') { const v = $('#chatIn').value; $('#chatIn').value = ''; ask(v); }
    else if (b.id === 'testVoice') { AudioOut.init(); Neural.ensure(); stopSpeech(); speakOut('Hello Lenny! I am Gibson. I polished my pixels just for you, and I am ready for anything.', () => G.setExpression('happy', 300), S.vEngine !== 'browser').then(() => setTimeout(() => G.setExpression('smile', 600), 800)); }
    else if (b.id === 'clearKeys') { if (confirm('Remove all API keys from this phone?')) { S.keys = Object.assign({}, DEFAULTS.keys); S.customUrl = ''; save(); syncUI(); status('Keys cleared.'); } }
    else if (b.id === 'fs') goFullscreen();
    else if (b.id === 'faceDbg') { closeSettings(); G.debug(true); }
    else if (b.id === 'demoMode') { closeSettings(); G.demo(true); setTimeout(() => G.demo(false), 75000); }
    else if (b.dataset.test) {
      const id = b.dataset.test; status(`Testing ${PROVIDERS[id].label}…`);
      try { const t = await callProvider(id, [{ role: 'user', content: 'Say hello to Lenny in one short sentence.' }]); status(`${PROVIDERS[id].label} OK: ${t}`); }
      catch (err) { status(`${PROVIDERS[id].label} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}` + (/Failed to fetch|NetworkError|Load failed/.test(err.message) ? '\n(Network/CORS: this provider may block direct browser calls; use the Custom endpoint via a small proxy.)' : '')); }
    }
  });
  $('#chatIn').addEventListener('keydown', e => { if (e.key === 'Enter') { const v = e.target.value; e.target.value = ''; ask(v); } });
}

// ------------------------------------------------------------------ boot
$('#nVoice').innerHTML = NEURAL_VOICES.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
bindSettings(); syncUI(); applyDisplay();
G.idle(true); G.setExpression('smile', 0);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.GibsonApp = { ask, respond, Convo, isExit, parseReply, brain, startCommand, speakOut, stopSpeech, Neural, Wake, AudioOut, NEURAL_VOICES, state: () => ({ busy, convo: Convo.on, rec: recMode, neural: Neural.state, neuralMsg: Neural.msg, rtf: Neural.rtf, wake: Wake.on, wakeReady: Wake.ready, wakeFailed: Wake.failed }), settings: () => JSON.parse(JSON.stringify(Object.assign({}, S, { keys: '(hidden)' }))), Head, version: VERSION };
})();
