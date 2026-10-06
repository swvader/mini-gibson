/* generated from gibson-face/index.html by tools/build.py */

/*  Mini Gibson face engine  (single file, no dependencies)
 *  ----------------------------------------------------------------------------
 *  Layers:   THEMES (colors / line widths / glow / background / post-fx hooks)
 *            EXPRESSIONS (target poses; numeric params morphed with easing)
 *            Behaviours (blink, saccades, drift, breathing, think, listen, talk)
 *            Renderer (Canvas2D: crisp neon line layer + 2-level bloom + scanlines + glitch)
 *  API:      window.Gibson.*  and window.postMessage({cmd:...}) / GibsonBridge.receive(json)
 *  Face space: origin = face centre, y down, face height ~1000 units (= 80% of screen height).
 */
(() => {
'use strict';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
let rand = Math.random;
function seedRandom(n) { let a = n >>> 0; rand = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = (a, b) => a + (b - a) * rand();
const se = (u, p) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), p)), 1 / p);   // superellipse profile

// ---------------------------------------------------------------- config
const Q = new URLSearchParams(location.search);
const CFG = {
  offsetX: 70,          // px at refWidth; positive = shift face right (toward USB end)
  refWidth: 2400,
  safeFrac: 132 / 141,  // visible window width / display width
  windowHFrac: 61 / 63.5,
  faceHeight: 0.8,      // face height as fraction of screen height
  showSafe: false,
  theme: 'red',
  maxDPR: 3,
  transitionMs: 380,
  captions: false,
  renderScale: 1,       // <1 renders fewer pixels (CSS upscales; glow hides it)
  autoQuality: true     // drop renderScale automatically if fps < ~48
};
try { Object.assign(CFG, JSON.parse(localStorage.getItem('gibson.cfg') || '{}')); } catch (e) {}
if (Q.has('ox')) CFG.offsetX = +Q.get('ox');
if (Q.has('safe')) CFG.showSafe = Q.get('safe') === '1';
if (Q.has('theme')) CFG.theme = Q.get('theme');
if (Q.has('captions')) CFG.captions = Q.get('captions') === '1';
if (Q.has('dpr')) CFG.maxDPR = +Q.get('dpr');
if (Q.has('scale')) { CFG.renderScale = +Q.get('scale'); CFG.autoQuality = false; }
function saveCfg() { try { localStorage.setItem('gibson.cfg', JSON.stringify({ offsetX: CFG.offsetX, showSafe: CFG.showSafe, theme: CFG.theme })); } catch (e) {} }

// ---------------------------------------------------------------- themes
// Copy a theme object to make a new look. All sizes are face-space units (face height = 1000).
const THEMES = {
  red: {
    name: 'red', label: 'Red Glow',
    bg: '#000000',
    core: '#fff3f0',          // hot centre of the neon tube
    mid: '#ff2616',           // tube rim colour
    glow: '#ff1608',          // bloom colour
    coreW: 0.52,              // core width as fraction of line width
    bloomW: 2.3,              // bloom stroke width multiplier
    lines: { eye: 28, mouth: 17, brow: 15, glyph: 13, pupilRim: 0.2 },
    bloom: { a: { scale: .25, blur: .010, alpha: 1.0 }, b: { scale: .125, blur: .05, alpha: 1.2 } }, // blur = fraction of screen height
    fillA: 0.055,              // faint fill inside open mouth / hearts
    scan: { alpha: .26, lines: 270 },   // scanline darkness, approx line count over screen height
    band: { alpha: .035, period: 6.5 },  // slow CRT refresh band
    flicker: 0.025,           // brightness shimmer
    microGlitch: true,        // occasional tiny digital glitch while idle
    pixel: 0,                 // >1 = render line layer at 1/pixel resolution, nearest-neighbour (retro themes)
    background: null,         // optional fn(ctx, W, H, t, state) - draw custom background
    drawPrims: null,          // optional fn(ctx, prims, mode, theme) - replace line rendering style
    post: null,               // optional fn(ctx, W, H, t, state) - extra post fx
    overrides: {}             // optional per-expression pose overrides {happy:{eye:{...}}}
  }
};

// ---------------------------------------------------------------- pose model
const EYE_X = 820, EYE_Y = -200, MOUTH_Y = 310;
const EYE0 = { x: 0, y: 0, s: 1, w: 190, up: 230, lo: 230, p: 2, pl: 2, rot: 0, lidT: 0, lidTs: 0, lidB: 0, lidBs: 0, lowVis: 1, pup: 72, pupA: 1, a: 1, heart: 0, spiral: 0, ring: 0, xx: 0, star: 0 };
const BROW0 = { a: 0, x: 0, y: 90, w: 185, rot: 0, curve: 22 };
const MOUTH0 = { x: 0, y: 0, w: 400, smile: 40, open: 0, us: .5, p: 2.4, uf: 0, wave: 0, wf: 3, wsq: 0, asym: 0, rot: 0, lw: 1, a: 1, teeth: 0 };
const FACE0 = { dx: 0, dy: 0, s: 1, tilt: 0, jit: 0, bounce: 0, sway: 0, float: 1 };
const GAZE0 = { x: 0, y: 0, w: 0 };
const FX0 = { tears: 0, blush: 0, zzz: 0, sparkle: 0, sweat: 0, glitch: 0, think: 0, listen: 0, hearts: 0, q: 0, excl: 0, vein: 0, load: 0, droop: 0, chatter: 0 };

const ARCH = { w: 345, up: 300, lo: 0, lowVis: 0, pup: 0, pupA: 0 };
const EXPRESSIONS = {
  smile:      { eye: ARCH, mouth: { w: 690, smile: 190 } },                       // approved reference look (default)
  neutral:    { eye: {}, mouth: { w: 400, smile: 35 } },
  happy:      { eye: { w: 235, up: 255, lo: -70, pup: 0, pupA: 0 }, mouth: { w: 580, smile: 160, open: 70, us: .12, uf: .75 } },
  laughing:   { eye: { w: 150, up: 175, lo: 0, lowVis: 0, p: 1.05, rot: 1.5708, x: 70, pup: 0, pupA: 0 }, mouth: { w: 520, smile: 100, open: 210, us: 0, uf: 1 }, face: { bounce: 1 } },
  sad:        { eye: { w: 185, up: 205, lo: 200, lidT: .3, lidTs: -.38, pup: 62 }, brow: { a: 1, rot: -.38, y: 70, curve: 6 }, mouth: { w: 330, smile: -110 }, gaze: { y: .5, w: .85 }, face: { dy: 25 } },
  crying:     { eye: { w: 215, up: 115, lo: 0, lowVis: 0, p: 1.7, rot: -.28, pup: 0, pupA: 0 }, brow: { a: 1, rot: -.42, y: 120, curve: 0 }, mouth: { w: 250, smile: -120, open: 60, us: .5, p: 2.2, wave: 6, wf: 2 }, face: { dy: 25, jit: .18 }, fx: { tears: 1 } },
  angry:      { eye: { w: 200, up: 225, lo: 205, lidT: .38, lidTs: .5, pup: 64 }, brow: { a: 1, rot: .5, y: 40, curve: -10, w: 205 }, mouth: { w: 360, smile: -70, open: 46, p: 7, teeth: 1 }, face: { jit: .12 }, fx: { vein: 1 } },
  annoyed:    { eye: { w: 200, up: 220, lo: 210, lidT: .5, lidTs: .05, pup: 64 }, brow: { a: .85, rot: .08, y: 22, curve: 0 }, mouth: { w: 270, smile: -12, asym: -28, x: 70 }, gaze: { x: .65, y: -.15, w: 1 } },
  surprised:  { eye: { w: 225, up: 262, lo: 258, pup: 52, y: 15 }, brow: { a: 1, y: 80, curve: 40, rot: -.08 }, mouth: { w: 110, smile: 0, open: 150, p: 2 } },
  shocked:    { eye: { w: 245, up: 280, lo: 280, pup: 36, y: 30 }, brow: { a: 1, y: 80, curve: 50 }, mouth: { w: 170, smile: -15, open: 260, p: 2.2 }, face: { jit: .5, dy: -10 }, fx: { excl: 1 } },
  scared:     { eye: { w: 215, up: 262, lo: 250, pup: 40 }, brow: { a: 1, rot: -.45, y: 80, curve: -6 }, mouth: { w: 330, smile: -30, open: 46, wave: 22, wf: 5, wsq: 1 }, face: { jit: .38, dy: 10, s: .96 }, fx: { sweat: 1 } },
  worried:    { eye: { w: 200, up: 240, lo: 235, pup: 62 }, brow: { a: 1, rot: -.4, y: 75, curve: -4 }, mouth: { w: 270, smile: -45, wave: 12, wf: 3 }, gaze: { x: .2, y: .2, w: .4 }, fx: { sweat: .6 } },
  confused:   { eyeL: { w: 222, up: 245, lo: 240, pup: 66, y: 15 }, eyeR: { w: 200, up: 105, lo: 85, pup: 50 }, browL: { a: 1, y: 75, curve: 40 }, browR: { a: 1, rot: .22, y: 55, curve: 0 }, mouth: { w: 300, smile: 0, wave: 28, wf: 3 }, face: { tilt: .07 }, fx: { q: 1 } },
  thinking:   { eye: { w: 195, up: 228, lo: 225, pup: 66, lidB: .07 }, browL: { a: .9, y: 115, curve: 36 }, browR: { a: .7, y: 50, rot: .15, curve: 10 }, mouth: { w: 175, smile: -12, asym: -22, x: 150 }, gaze: { x: .6, y: -.65, w: 1 }, fx: { think: 1 } },
  curious:    { eyeL: { w: 228, up: 268, lo: 258, pup: 82, s: 1.06 }, eyeR: { w: 198, up: 232, lo: 228, pup: 72 }, browL: { a: .9, y: 125, curve: 40 }, mouth: { w: 120, open: 46, p: 2, smile: 8 }, face: { tilt: -.07 }, gaze: { x: -.25, y: .05, w: .5 } },
  skeptical:  { eyeL: { w: 205, up: 248, lo: 228, pup: 66 }, eyeR: { w: 200, up: 220, lo: 215, lidT: .44, lidTs: .1, pup: 62 }, browL: { a: 1, y: 145, curve: 45, rot: -.15 }, browR: { a: 1, y: 15, rot: .16, curve: 0 }, mouth: { w: 300, smile: -18, asym: 48 }, face: { tilt: .04 } },
  suspicious: { eye: { w: 210, up: 130, lo: 110, lidT: .22, lidTs: .14, pup: 54 }, brow: { a: .8, y: 12, rot: .18, curve: 0 }, mouth: { w: 240, smile: -10, asym: -20, x: -80 }, gaze: { x: .9, y: .05, w: 1 }, face: { dx: -40 } },
  sleepy:     { eye: { w: 200, up: 215, lo: 210, lidT: .6, lidTs: -.08, pup: 60 }, mouth: { w: 200, smile: 8, open: 10 }, gaze: { y: .35, w: .7 }, face: { dy: 22, float: 1.6 }, fx: { droop: 1 } },
  sleeping:   { eye: { w: 235, up: -70, lo: 0, lowVis: 0, pup: 0, pupA: 0, y: 40 }, mouth: { w: 95, open: 26, p: 2, smile: 0 }, face: { dy: 35, float: 2.2, s: .98 }, fx: { zzz: 1 } },
  bored:      { eye: { w: 200, up: 220, lo: 210, lidT: .55, lidB: .08, pup: 62 }, mouth: { w: 300, smile: 0, wave: 7, wf: 1.5, x: -40, asym: 10 }, gaze: { x: -.5, y: -.4, w: .9 }, face: { dy: 15 } },
  excited:    { eye: { w: 235, up: 278, lo: 268, pup: 96 }, brow: { a: .75, y: 130, curve: 40 }, mouth: { w: 480, smile: 120, open: 165, us: .1, uf: .85 }, face: { bounce: .55, s: 1.02 }, fx: { sparkle: 1 } },
  starstruck: { eye: { star: 1, pup: 0, pupA: 0 }, mouth: { w: 430, smile: 150, open: 140, us: .1, uf: .8 }, face: { bounce: .3 }, fx: { sparkle: 1 } },
  love:       { eye: { heart: 1, pup: 0, pupA: 0 }, mouth: { w: 460, smile: 150, open: 30, uf: .6, us: .2 }, fx: { hearts: 1, blush: .55 } },
  wink:       { eyeL: { w: 205, up: 248, lo: 232, pup: 74 }, eyeR: { w: 240, up: 150, lo: 0, lowVis: 0, pup: 0, pupA: 0, p: 1.6, rot: .12 }, browR: { a: .8, y: 75, rot: .15 }, mouth: { w: 430, smile: 120, asym: 45, open: 14, uf: .5 }, face: { tilt: -.05 } },
  embarrassed:{ eye: { w: 240, up: 185, lo: -35, pup: 0, pupA: 0 }, mouth: { w: 230, smile: 40, wave: 14, wf: 3 }, gaze: { x: -.6, y: .5, w: 1 }, face: { dy: 15, tilt: .05 }, fx: { blush: 1 } },
  proud:      { eye: { w: 225, up: 200, lo: 215, lidT: .18, lidB: .36, pup: 66 }, brow: { a: .7, y: 120, curve: 30 }, mouth: { w: 560, smile: 170, asym: 20 }, gaze: { y: .25, w: .6 }, face: { dy: -35, s: 1.04 }, fx: { sparkle: .35 } },
  smug:       { eye: { w: 215, up: 205, lo: 200, lidT: .46, lidTs: -.05, pup: 64 }, browL: { a: .8, y: 95, curve: 30 }, mouth: { w: 420, smile: 80, asym: 75 }, gaze: { x: .3, y: .1, w: .6 } },
  determined: { eye: { w: 205, up: 218, lo: 205, lidT: .3, lidTs: .26, pup: 70 }, brow: { a: 1, y: 25, rot: .3, curve: -6, w: 210 }, mouth: { w: 330, smile: -35, lw: 1.3 }, face: { dy: -5, s: 1.02 } },
  relieved:   { eye: { w: 280, up: -65, lo: 0, lowVis: 0, pup: 0, pupA: 0 }, brow: { a: .6, rot: -.2, y: 80 }, mouth: { w: 430, smile: 95 } },
  listening:  { eye: { w: 212, up: 252, lo: 246, pup: 82 }, brow: { a: .5, y: 112, curve: 35 }, mouth: { w: 220, smile: 30 }, gaze: { w: .6 }, face: { tilt: .04 }, fx: { listen: 1 } },
  speaking:   { eye: { w: 200, up: 230, lo: 225, pup: 72, lidB: .08 }, mouth: { w: 420, smile: 60 }, fx: { chatter: 1 } },
  mischievous:{ eye: { w: 215, up: 215, lo: 205, lidT: .35, lidTs: .3, lidB: .28, lidBs: -.1, pup: 66 }, browL: { a: 1, y: 40, rot: .35 }, browR: { a: 1, y: 95, rot: .1, curve: 30 }, mouth: { w: 400, smile: 110, asym: -70, x: 20 }, gaze: { x: -.45, w: 1 }, face: { tilt: -.05 } },
  dizzy:      { eye: { spiral: 1, pup: 0, pupA: 0 }, mouth: { w: 320, smile: -20, wave: 30, wf: 3, open: 20 }, face: { sway: 1 } },
  loading:    { eye: { ring: 1, pup: 0, pupA: 0 }, mouth: { a: 0, w: 120, smile: 0 }, fx: { load: 1 } },
  error:      { eye: { xx: 1, pup: 0, pupA: 0 }, mouth: { w: 360, smile: 0, wave: 30, wf: 6, wsq: 1 }, fx: { glitch: 1 } }
};
const ALIASES = { default: 'smile', arch: 'smile', smileClosedEyes: 'smile', 'smile-closed-eyes': 'smile', veryHappy: 'laughing', 'very-happy': 'laughing', laugh: 'laughing',
  cry: 'crying', glitch: 'error', processing: 'loading', heart: 'love', idle: 'smile', talk: 'speaking', listen: 'listening', think: 'thinking', sleep: 'sleeping', blush: 'embarrassed' };
const LABELS = { smile: 'smile (closed-eye arches)', laughing: 'very happy / laughing', error: 'error / glitch', loading: 'loading / processing', love: 'love (heart eyes)', excited: 'excited (sparkle)', sleeping: 'sleeping (zZz)', crying: 'crying (tears)', confused: 'confused (?)', embarrassed: 'embarrassed (blush)', suspicious: 'suspicious (side-glance)', skeptical: 'skeptical (raised brow)', dizzy: 'dizzy (spiral eyes)' };
const TOUR = ['neutral', 'happy', 'smile', 'laughing', 'sad', 'crying', 'angry', 'annoyed', 'surprised', 'shocked', 'scared', 'worried', 'confused', 'thinking', 'curious', 'skeptical', 'suspicious', 'sleepy', 'sleeping', 'bored', 'excited', 'starstruck', 'love', 'wink', 'embarrassed', 'proud', 'smug', 'determined', 'relieved', 'listening', 'speaking', 'mischievous', 'dizzy', 'loading', 'error'];

function buildPose(def, theme) {
  const ov = (theme && theme.overrides && theme.overrides[def.__name]) || {};
  const P = {};
  const put = (pre, base, ...over) => { const o = Object.assign({}, base, ...over.filter(Boolean)); for (const k in base) P[pre + k] = o[k]; };
  put('eL.', EYE0, def.eye, def.eyeL, ov.eye, ov.eyeL); put('eR.', EYE0, def.eye, def.eyeR, ov.eye, ov.eyeR);
  put('bL.', BROW0, def.brow, def.browL, ov.brow, ov.browL); put('bR.', BROW0, def.brow, def.browR, ov.brow, ov.browR);
  put('m.', MOUTH0, def.mouth, ov.mouth); put('f.', FACE0, def.face, ov.face); put('g.', GAZE0, def.gaze, ov.gaze); put('fx.', FX0, def.fx, ov.fx);
  return P;
}
function view(P, pre) { const o = {}; const n = pre.length; for (const k in P) if (k.startsWith(pre)) o[k.slice(n)] = P[k]; return o; }
for (const k in EXPRESSIONS) EXPRESSIONS[k].__name = k;

// ---------------------------------------------------------------- visemes (procedural lip-sync)
const VIS = {
  rest: { o: 0, w: 1, p: 2.4, u: .5 }, MBP: { o: 0, w: .84, p: 2.4, u: .5 }, AA: { o: 150, w: .86, p: 2.3, u: .35 }, AE: { o: 118, w: 1, p: 2.6, u: .4 },
  EH: { o: 88, w: 1.02, p: 2.8, u: .45 }, EE: { o: 46, w: 1.15, p: 4, u: .45 }, OH: { o: 128, w: .52, p: 2, u: .5 }, OO: { o: 80, w: .36, p: 2, u: .5 },
  FV: { o: 20, w: .95, p: 3, u: .12 }, TH: { o: 52, w: .92, p: 3, u: .5 }, SZ: { o: 26, w: 1.07, p: 5, u: .5 }, CH: { o: 48, w: .66, p: 2.4, u: .5 },
  TDN: { o: 40, w: .96, p: 3, u: .5 }, KG: { o: 68, w: .9, p: 2.6, u: .45 }, R: { o: 54, w: .64, p: 2.2, u: .5 }, L: { o: 60, w: .9, p: 2.8, u: .45 }, H: { o: 70, w: .95, p: 2.6, u: .45 }
};
const VOWELS = { AA: 1, AE: 1, EH: 1, EE: 1, OH: 1, OO: 1 };
const DI = { th: 'TH', sh: 'CH', ch: 'CH', ph: 'FV', oo: 'OO', ee: 'EE', ea: 'EE', ou: 'OH', ow: 'OH', oa: 'OH', ai: 'AE', ay: 'EH', qu: 'OO', wh: 'OO', ng: 'KG', ck: 'KG', ie: 'EE', ey: 'EE', oi: 'OH', au: 'AA', aw: 'AA' };
const SI = { a: 'AA', e: 'EH', i: 'EE', o: 'OH', u: 'OO', y: 'EE', b: 'MBP', m: 'MBP', p: 'MBP', f: 'FV', v: 'FV', l: 'L', t: 'TDN', d: 'TDN', n: 'TDN', s: 'SZ', z: 'SZ', x: 'SZ', c: 'KG', k: 'KG', q: 'KG', g: 'KG', h: 'H', j: 'CH', r: 'R', w: 'OO' };
const DIGIT = ['SZ EE R OH', 'OO AA TDN', 'TDN OO', 'TH R EE', 'FV OH R', 'FV AA EE FV', 'SZ EE KG SZ', 'SZ EH FV EH TDN', 'EE TDN', 'TDN AA EE TDN'];
function textToVisemes(text) {
  const s = String(text).toLowerCase(); const items = []; const words = []; let t = 0; let i = 0; let inWord = false;
  const push = (v, d) => { items.push({ v, t, d }); t += d; };
  while (i < s.length) {
    const c = s[i];
    if (/[a-z0-9'\u00e0-\u00ff]/.test(c)) {
      if (!inWord) { words.push({ ci: i, t }); inWord = true; }
      if (c === "'") { i++; continue; }
      if (c >= '0' && c <= '9') { for (const v of DIGIT[+c].split(' ')) push(v, VOWELS[v] ? .1 : .065); i++; continue; }
      const tri = s.substr(i, 3);
      if (tri === 'igh') { push('AA', .1); push('EE', .06); i += 3; continue; }
      const di = s.substr(i, 2);
      if (DI[di]) { const v = DI[di]; push(v, VOWELS[v] ? .12 : .085); i += 2; continue; }
      if (c === s[i + 1]) { i++; continue; }                         // double letters
      if (c === 'e' && !/[a-z]/.test(s[i + 1] || '') && i > 1 && /[a-z]/.test(s[i - 1]) && /[a-z]/.test(s[i - 2])) { i++; continue; } // silent e
      const v = SI[c] || 'EH';
      push(v, VOWELS[v] ? .105 : v === 'MBP' ? .085 : v === 'H' ? .045 : .065);
      i++; continue;
    }
    inWord = false;
    if (/[.!?]/.test(c)) push('rest', .38); else if (/[,;:\u2014-]/.test(c)) push('rest', .22); else if (/\s/.test(c)) { if (items.length && items[items.length - 1].v !== 'rest') push('rest', .035); }
    i++;
  }
  push('rest', .15);
  for (const it of items) it.k = 0.85 + 0.25 * rand();
  return { items, words, dur: t };
}

// ---------------------------------------------------------------- canvases
const cv = document.getElementById('face');
const ctx = cv.getContext('2d', { alpha: false });
const mk = () => document.createElement('canvas');
const sharp = mk(), sctx = sharp.getContext('2d');
const bSrc = mk(), bsctx = bSrc.getContext('2d');
const bA = mk(), bactx = bA.getContext('2d');
const bB = mk(), bbctx = bB.getContext('2d');
const tmp = mk(), tctx = tmp.getContext('2d');
const ghost = mk(), gctx = ghost.getContext('2d');
const FILTER_OK = (() => { try { const c = mk().getContext('2d'); c.filter = 'blur(2px)'; return c.filter === 'blur(2px)'; } catch (e) { return false; } })();
let W = 0, H = 0, DPR = 1;

const S = {
  theme: THEMES[CFG.theme] || THEMES.red,
  t: 0, base: 'smile', P: null, trans: null,
  idleOn: true, idleW: 1, thinkOn: false, listenOn: false, beforeMode: 'smile',
  blinkT: 1.5, blinkStart: -9, blinkDur: .17, blinkQueue: 0, blinkVal: 0,
  sac: { x: 0, y: 0 }, sacT: 1, gx: 0, gy: 0, look: null, lookX: 0, lookY: 0, thinkSide: 1, thinkT: 2,
  jx: 0, jy: 0, jT: 0,
  talk: null, mouth: { o: 0, w: 1, p: 2.4, u: .5, k: 0 }, babble: { v: 'rest', T: 0 },
  audio: null, ext: { v: 0, t: -9 }, listenLevel: 0,
  glitch: { T: 9, until: -1, amt: 0, seedT: -1, params: null },
  demo: null, caption: '', manual: false, fps: 60
};
S.P = buildPose(EXPRESSIONS.smile, S.theme);

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, CFG.maxDPR) * CFG.renderScale;
  const w = Math.max(2, Math.round(innerWidth * DPR)), h = Math.max(2, Math.round(innerHeight * DPR));
  if (w === W && h === H) return;
  W = cv.width = w; H = cv.height = h;
  const px = S.theme.pixel > 1 ? S.theme.pixel : 1;
  sharp.width = Math.ceil(W / px); sharp.height = Math.ceil(H / px);
  const sa = S.theme.bloom.a.scale, sb = S.theme.bloom.b.scale;
  bSrc.width = bA.width = Math.ceil(W * sa); bSrc.height = bA.height = Math.ceil(H * sa);
  bB.width = Math.ceil(W * sb); bB.height = Math.ceil(H * sb);
  tmp.width = W; tmp.height = H; ghost.width = Math.ceil(W / 2); ghost.height = Math.ceil(H / 2);
  styleOverlays();
}
// scanlines + refresh band are CSS layers: composited by the GPU for free, no per-frame canvas fill
const scanEl = document.getElementById('scan'), bandEl = document.getElementById('band');
function styleOverlays() {
  const th = S.theme, dpr = window.devicePixelRatio || 1;
  const sp = Math.max(2, Math.round(innerHeight * dpr / th.scan.lines)) / dpr;
  scanEl.style.background = th.scan.alpha > 0 ? `repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) ${sp / 2}px, rgba(0,0,0,${th.scan.alpha}) ${sp / 2}px, rgba(0,0,0,${th.scan.alpha}) ${sp}px)` : 'none';
  const c = th.band.color || '255,60,40';
  bandEl.style.background = th.band.alpha > 0 ? `linear-gradient(to bottom, rgba(${c},0), rgba(${c},${th.band.alpha}), rgba(${c},0))` : 'none';
  bandEl.style.mixBlendMode = 'screen';
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- geometry helpers
const NS = 44;
function xf(pts, ang, s, tx, ty) { const c = Math.cos(ang) * s, si = Math.sin(ang) * s; const o = new Array(pts.length); for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; o[i] = x * c - y * si + tx; o[i + 1] = x * si + y * c + ty; } return o; }
function line(out, pts, w, a, closed, fill) { if (a > .004) out.push({ pts, w, a, closed: !!closed, fill: fill || 0 }); }
function dot(out, x, y, r, a, clip) { if (a > .004 && r > .5) out.push({ dot: 1, x, y, r, a, clip }); }
function heartPts(k) { const o = []; for (let i = 0; i <= 60; i++) { const t = i / 60 * TAU; const s = Math.sin(t); o.push(16 * s * s * s / 16 * k, (-(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) - 2.5) / 16 * k); } return o; }
function starPts(k, n, inner) { const o = []; for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? inner : 1; o.push(Math.cos(a) * r * k, Math.sin(a) * r * k); } return o; }
function dropPts(k) { const o = []; for (let i = 0; i <= 32; i++) { const t = i / 32 * TAU; o.push(Math.sin(t) * Math.pow(Math.abs(Math.sin(t / 2)), 1.3) * k, -Math.cos(t) * 1.35 * k); } return o; }
function arcPts(cx, cy, r, a0, a1, n) { const o = []; for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); o.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } return o; }
const GLYPH = {
  Z: [[-1, -1, 1, -1, -1, 1, 1, 1]],
  '!': [[0, -1, 0, .38]], '!dot': [0, .78],
  '?': [arcPts(0, -.42, .46, -Math.PI * 1.05, Math.PI * .42, 18).concat([0.05, .2, 0.05, .38])], '?dot': [0.05, .78],
  vein: [0, 1, 2, 3].map(k => { const a = Math.PI / 4 + k * Math.PI / 2; return arcPts(Math.cos(a) * 1.05, Math.sin(a) * 1.05, .62, a + Math.PI - .75, a + Math.PI + .75, 10); })
};
function glyph(out, name, x, y, k, rot, w, a) {
  for (const g of GLYPH[name]) line(out, xf(g, rot, k, x, y), w, a);
  const d = GLYPH[name + 'dot']; if (d) { const p = xf(d, rot, k, x, y); dot(out, p[0], p[1], w * .75, a); }
}
function shrink(pts, d) { // pull polygon toward its centroid by ~d units (keeps pupils off the rim)
  let mx = 0, my = 0; const n = pts.length / 2; for (let i = 0; i < pts.length; i += 2) { mx += pts[i]; my += pts[i + 1]; } mx /= n; my /= n;
  const o = new Array(pts.length); for (let i = 0; i < pts.length; i += 2) { const dx = pts[i] - mx, dy = pts[i + 1] - my, l = Math.hypot(dx, dy) || 1, k = Math.max(0, l - d) / l; o[i] = mx + dx * k; o[i + 1] = my + dy * k; } return o;
}

// ---------------------------------------------------------------- face construction
function buildEye(out, e, side, cv2) {
  const th = S.theme, t = S.t;
  const spec = Math.max(e.heart, e.spiral, e.ring, e.xx, e.star);
  const s = e.s * (1 + 0.07 * cv2.lookX * side);
  const cx = side * (EYE_X + e.x) + cv2.gx * 48, cy = EYE_Y + e.y + cv2.gy * 36;
  const lw = th.lines.eye * Math.min(1.15, s);
  const baseA = e.a * (1 - spec);
  if (baseA > .01) {
    const w = e.w, up = e.up, lo = e.lo, Ht = Math.max(30, up + lo);
    const lidT = clamp(e.lidT + cv2.droop, 0, 1), lidB = e.lidB;
    const U = new Array((NS + 1) * 2), L = new Array((NS + 1) * 2);
    const bl = cv2.blink;
    for (let i = 0; i <= NS; i++) {
      const u = -1 + 2 * i / NS, ss = -side * u;
      let yu = -up * se(u, e.p), yl = lo * se(u, e.pl);
      if (lidT > .001) yu = Math.max(yu, lerp(yu, -up + lidT * Ht + e.lidTs * ss * w, clamp(lidT * 12, 0, 1)));
      if (lidB > .001) yl = Math.min(yl, lerp(yl, lo - lidB * Ht + e.lidBs * ss * w, clamp(lidB * 12, 0, 1)));
      if (yu > yl) { const m = (yu + yl) / 2; yu = yl = m; }
      const yc = lerp(yu * 0.12, yu + (yl - yu) * 0.62, e.lowVis);
      yu = lerp(yu, yc, bl); yl = lerp(yl, yc, bl);
      U[i * 2] = L[i * 2] = u * w; U[i * 2 + 1] = yu; L[i * 2 + 1] = yl;
    }
    const ang = -side * e.rot;
    const Ux = xf(U, ang, s, cx, cy), Lx = xf(L, ang, s, cx, cy);
    let pts, closed = false;
    if (e.lowVis >= .995) {
      pts = Ux.slice(); for (let i = NS - 1; i >= 1; i--) pts.push(Lx[i * 2], Lx[i * 2 + 1]); closed = true;
    } else {
      pts = [];
      const f = clamp(e.lowVis, 0, 1) * NS / 2, iL = Math.floor(f), fr = f - iL;
      if (f > .05) {
        if (iL < NS) pts.push(lerp(Lx[iL * 2], Lx[iL * 2 + 2], fr), lerp(Lx[iL * 2 + 1], Lx[iL * 2 + 3], fr));
        for (let i = iL; i >= 1; i--) pts.push(Lx[i * 2], Lx[i * 2 + 1]);
      }
      for (let i = 0; i < Ux.length; i++) pts.push(Ux[i]);
      if (f > .05) {
        for (let i = NS - 1; i >= NS - iL; i--) pts.push(Lx[i * 2], Lx[i * 2 + 1]);
        const j = NS - iL; if (j > 0) pts.push(lerp(Lx[j * 2], Lx[j * 2 - 2], fr), lerp(Lx[j * 2 + 1], Lx[j * 2 - 1], fr));
      }
    }
    line(out, pts, lw, baseA, closed);
    // pupil (clipped by the lids so it hides naturally behind them)
    const pa = e.pupA * baseA * clamp(e.lowVis * 2 - 1, 0, 1);
    if (e.pup > 2 && pa > .01) {
      const r = e.pup;
      const lim = Math.max(0, w - r - lw * .8);
      const px = clamp(cv2.gx * w * .5, -lim, lim);
      const fi = clamp((px / w + 1) / 2 * NS, 0, NS - .001), i0 = Math.floor(fi), fr = fi - i0;
      const yu = lerp(U[i0 * 2 + 1], U[i0 * 2 + 3], fr), yl = lerp(L[i0 * 2 + 1], L[i0 * 2 + 3], fr);
      const room = (yl - yu) / 2 - r - lw * .7;
      let py = (yu + yl) / 2 + clamp(cv2.gy * Math.max(0, room) * 1.1, -Math.max(0, room), Math.max(0, room));
      if (room < 0) py = clamp((yu + yl) / 2 + cv2.gy * 40, yu + r * .3, yl - r * .3);
      const pp = xf([px, py], ang, s, cx, cy);
      const clipPoly = []; for (let i = 0; i <= NS; i++) clipPoly.push(Ux[i * 2], Ux[i * 2 + 1]); for (let i = NS; i >= 0; i--) clipPoly.push(Lx[i * 2], Lx[i * 2 + 1]);
      dot(out, pp[0], pp[1], r * s * cv2.pupScale, pa, shrink(clipPoly, lw * .9 * s));
    }
  }
  if (spec > .01) {
    const k = 230 * s;
    if (e.heart > .01) { const beat = 1 + .08 * Math.pow(Math.max(0, Math.sin(t * TAU * 1.25)), 8) + .04 * Math.pow(Math.max(0, Math.sin(t * TAU * 1.25 - .9)), 8); line(out, xf(heartPts(k * (.55 + .45 * e.heart) * beat), 0, 1, cx, cy + 10), lw, e.heart * e.a, true, 1.6); }
    if (e.spiral > .01) { const o = [], tm = 3.1 * TAU, kk = k * (.6 + .4 * e.spiral); for (let i = 0; i <= 120; i++) { const th2 = i / 120 * tm, r = th2 / tm * kk; const a = th2 * side + t * 4.2 * side; o.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } line(out, o, lw * .85, e.spiral * e.a); }
    if (e.ring > .01) {
      const kk = k * .78 * (.6 + .4 * e.ring), sp = t * 5.2 + (side > 0 ? .8 : 0), len = 1.6 + 1.6 * (.5 + .5 * Math.sin(t * 2.4));
      line(out, arcPts(cx, cy, kk, 0, TAU, 60), lw * .45, e.ring * .32 * e.a, true);
      line(out, arcPts(cx, cy, kk, sp, sp + len, 40), lw, e.ring * e.a);
      for (let d = 0; d < 3; d++) { const a = -t * 3 + d * TAU / 3; dot(out, cx + Math.cos(a) * kk * .45, cy + Math.sin(a) * kk * .45, lw * .45, e.ring * e.a * (.5 + .5 * Math.sin(t * 6 + d))); }
    }
    if (e.xx > .01) { const kk = k * .62 * (.6 + .4 * e.xx), j = (rand() - .5) * 6 * e.xx; line(out, [cx - kk + j, cy - kk, cx + kk, cy + kk + j], lw, e.xx * e.a); line(out, [cx + kk, cy - kk - j, cx - kk + j, cy + kk], lw, e.xx * e.a); }
    if (e.star > .01) { const kk = k * (.6 + .4 * e.star) * (1 + .06 * Math.sin(t * 7 + side)); line(out, xf(starPts(kk, 5, .45), Math.sin(t * 2 + side) * .12, 1, cx, cy + 10), lw * .9, e.star * e.a, true, 1.4); }
  }
}
function buildBrow(out, b, e, side, cv2) {
  if (b.a < .01) return;
  const cx = side * (EYE_X + e.x + b.x) + cv2.gx * 48;
  const top = EYE_Y + e.y - Math.max(e.up, 80) * e.s + cv2.gy * 36;
  const cy = Math.max(top - b.y, -555 + Math.max(0, b.curve) + Math.abs(Math.sin(b.rot)) * b.w);   // keep brows inside the visible window
  const o = []; for (let i = 0; i <= 20; i++) { const u = -1 + i / 10; o.push(u * b.w, -b.curve * (1 - u * u)); }
  line(out, xf(o, -side * b.rot, 1, cx, cy), S.theme.lines.brow, b.a);
}
function buildMouth(out, m, cv2) {
  const th = S.theme, t = S.t, M = S.mouth, k = M.k;
  if (m.a < .01) return;
  let w = m.w, open = m.open, p = m.p, us = m.us, smile = m.smile, uf = m.uf;
  if (k > .001) {
    const tw = Math.min(m.w, 470);
    w = lerp(w, tw * M.w, k); open = lerp(open, M.o, k); p = lerp(p, M.p, k); us = lerp(us, M.u, k); smile = smile * (1 - .45 * k); uf = uf * (1 - k);
  }
  if (cv2.bounce > .01) open *= 1 - .35 * cv2.bounce * (.5 + .5 * Math.sin(t * TAU * 3.4));
  if (cv2.zzz > .01) open += 10 * Math.sin(t * TAU / 4.4) * cv2.zzz;
  open = Math.max(0, open);
  const U = [], L = [];
  for (let i = 0; i <= NS; i++) {
    const u = -1 + 2 * i / NS;
    let wv = 0; if (m.wave > .1) { const ph = u * m.wf * Math.PI + t * m.wsq * 7; const sn = Math.sin(ph); const tri = 2 / Math.PI * Math.asin(sn); wv = m.wave * lerp(sn, tri, m.wsq) * (1 - Math.pow(Math.abs(u), 6)); }
    const mid = smile * (1 - u * u) + m.asym * u + wv, cl = m.asym * u + wv;
    const g = se(u, p);
    U.push(u * w, lerp(mid, cl, uf) - open * us * g); L.push(u * w, mid + open * (1 - us) * g);
  }
  const cx = m.x, cy = MOUTH_Y + m.y - open * .3;   // big openings lift the upper lip too (keeps the mouth in frame)
  const Ux = xf(U, m.rot, 1, cx, cy), Lx = xf(L, m.rot, 1, cx, cy);
  const pts = Ux.slice(); for (let i = NS - 1; i >= 1; i--) pts.push(Lx[i * 2], Lx[i * 2 + 1]);
  line(out, pts, th.lines.mouth * m.lw, m.a, true, clamp(open / 60, 0, 1));
  if (m.teeth > .01 && open > 15) {
    const tl = []; for (let i = 4; i <= NS - 4; i++) tl.push(Ux[i * 2], (Ux[i * 2 + 1] + Lx[i * 2 + 1]) / 2);
    line(out, tl, th.lines.mouth * .55, m.teeth * m.a * .8);
    for (let j = 1; j < 6; j++) { const i = Math.round(NS * j / 6); line(out, [Ux[i * 2], Ux[i * 2 + 1] + 6, Lx[i * 2], Lx[i * 2 + 1] - 6], th.lines.mouth * .45, m.teeth * m.a * .6); }
  }
}
function buildFx(out, P, cv2) {
  const th = S.theme, t = S.t, gw = th.lines.glyph;
  const f = view(P, 'fx.');
  if (f.tears > .01) for (const side of [-1, 1]) {
    const e = view(P, side < 0 ? 'eL.' : 'eR.');
    const x0 = side * (EYE_X + e.x + e.w * .55 * e.s) + cv2.gx * 48, y0 = EYE_Y + e.y + 30;
    line(out, [x0, y0, x0 + side * 6, y0 + 90, x0 + side * 14, y0 + 210], gw * .7, f.tears * .45);
    for (let i = 0; i < 3; i++) {
      const ph = (t * .62 + i / 3 + (side > 0 ? .17 : 0)) % 1;
      const y = y0 + 40 + ph * ph * 520 + ph * 40, x = x0 + side * (12 + ph * 30);
      line(out, xf(dropPts(36 * (1.1 - ph * .3)), 0, 1, x, y), gw, f.tears * Math.min(1, ph * 8) * Math.pow(1 - ph, .6), true, 1);
    }
  }
  if (f.sweat > .01) { const ph = (t * .45) % 1; line(out, xf(dropPts(30), -.2, 1, 1100, -390 + ph * 110), gw, f.sweat * Math.sin(Math.PI * ph), true, 1); }
  if (f.zzz > .01) for (let i = 0; i < 3; i++) { const ph = (t * .32 + i / 3) % 1; glyph(out, 'Z', 850 + ph * 190 + Math.sin(ph * 7) * 16, -300 - ph * 190, 28 + ph * 34, -.14, gw * (.8 + ph * .4), f.zzz * Math.sin(Math.PI * ph)); }
  if (f.sparkle > .01) {
    const pos = [[-1100, -440, 1], [1100, -400, .8], [-430, -490, .6], [470, -500, .7], [-1110, 60, .6], [1110, 90, .75], [0, -520, .5]];
    pos.forEach(([x, y, sz], i) => { const tw = Math.pow(Math.max(0, Math.sin(t * TAU * .75 + i * 1.7)), 2); line(out, xf(starPts(70 * sz * tw * (.4 + .6 * f.sparkle), 4, .2), t * .4 + i, 1, x, y), gw * .8, f.sparkle * tw, true, 1.5); });
  }
  if (f.hearts > .01) for (let i = 0; i < 4; i++) { const ph = (t * .28 + i / 4) % 1, sd = i % 2 ? 1 : -1; line(out, xf(heartPts(38 + 12 * (i % 3)), Math.sin(ph * 6 + i) * .2, 1, sd * (1080 + Math.sin(ph * TAU + i) * 40), 380 - ph * 820), gw * .8, f.hearts * Math.sin(Math.PI * ph), true, 1.5); }
  if (f.q > .01) glyph(out, '?', 1120, -440 + Math.sin(t * 2.2) * 12, 90 * (.6 + .4 * f.q), Math.sin(t * 1.6) * .14, gw * 1.1, f.q);
  if (f.excl > .01) glyph(out, '!', 1130, -430, 100 * (.6 + .4 * f.excl) * (1 + .12 * Math.abs(Math.sin(t * 9))), .1, gw * 1.2, f.excl);
  if (f.vein > .01) for (const g of GLYPH.vein) line(out, xf(g, 0, 62 * (1 + .1 * Math.max(0, Math.sin(t * 7))), -1090, -450), gw * .9, f.vein);
  if (f.blush > .01) for (const side of [-1, 1]) for (let i = 0; i < 3; i++) { const x = side * (EYE_X + 10) + (i - 1) * 62, y = EYE_Y + 280 + cv2.gy * 20; line(out, [x - 18, y + 30, x + 18, y - 30], gw * .8, f.blush * .9); }
  if (f.load > .01) for (let i = 0; i < 3; i++) { const pl = Math.max(0, Math.sin(t * TAU * 1.1 - i * .9)); dot(out, (i - 1) * 95, MOUTH_Y + 25 - pl * 18, 16 + pl * 8, f.load * (.35 + .65 * pl)); }
  if (f.think > .01) { const pos = [[990, -385, 11], [1055, -450, 17], [1135, -525, 24]]; pos.forEach(([x, y, r], i) => { const a = Math.max(0, Math.sin(t * TAU * .55 - i * .7)); line(out, arcPts(x, y, r, 0, TAU, 20), gw * .7, f.think * (.25 + .75 * a), true); }); }
}
function buildPrims() {
  const P = S.P;
  const cv2 = { gx: S.gx, gy: S.gy, lookX: S.lookX, blink: S.blinkVal || 0, droop: 0, pupScale: 1, bounce: P['f.bounce'], zzz: P['fx.zzz'] };
  if (P['fx.droop'] > .01) cv2.droop = P['fx.droop'] * .28 * Math.pow(Math.max(0, Math.sin(S.t * .9)), 3);
  if (P['fx.listen'] > .01) cv2.pupScale = 1 + .06 * P['fx.listen'] * (.5 + .5 * Math.sin(S.t * TAU * .9)) + .15 * S.listenLevel;
  const out = [];
  buildEye(out, view(P, 'eL.'), -1, cv2); buildEye(out, view(P, 'eR.'), 1, cv2);
  buildBrow(out, view(P, 'bL.'), view(P, 'eL.'), -1, cv2); buildBrow(out, view(P, 'bR.'), view(P, 'eR.'), 1, cv2);
  buildMouth(out, view(P, 'm.'), cv2);
  buildFx(out, P, cv2);
  return out;
}

// ---------------------------------------------------------------- rendering
function tracePath(c, pts, closed) { c.beginPath(); c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); if (closed) c.closePath(); }
function defaultDrawPrims(c, prims, mode, th) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const p of prims) {
    if (p.dot) {
      c.save();
      if (p.clip) { tracePath(c, p.clip, true); c.clip(); }
      if (mode === 'bloom') { c.globalAlpha = p.a; c.fillStyle = th.glow; c.beginPath(); c.arc(p.x, p.y, p.r * 1.2, 0, TAU); c.fill(); }
      else {
        c.globalAlpha = p.a; c.fillStyle = th.mid; c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill();
        c.fillStyle = th.core; c.beginPath(); c.arc(p.x, p.y, p.r * (1 - th.lines.pupilRim), 0, TAU); c.fill();
      }
      c.restore(); continue;
    }
    if (p.pts.length < 4) continue;
    tracePath(c, p.pts, p.closed);
    if (p.fill > 0) { c.globalAlpha = Math.min(1, p.a * th.fillA * p.fill * (mode === 'bloom' ? .9 : 1)); c.fillStyle = mode === 'bloom' ? th.glow : th.mid; c.fill(); }
    if (mode === 'bloom') { c.globalAlpha = p.a; c.strokeStyle = th.glow; c.lineWidth = p.w * th.bloomW; c.stroke(); }
    else {
      c.globalAlpha = p.a; c.strokeStyle = th.mid; c.lineWidth = p.w; c.stroke();
      c.strokeStyle = th.core; c.lineWidth = p.w * th.coreW; c.stroke();
    }
  }
  c.globalAlpha = 1;
}
function render() {
  const th = S.theme, P = S.P, t = S.t;
  const drawPrims = th.drawPrims || defaultDrawPrims;
  const safeW = W * CFG.safeFrac, ox = CFG.offsetX * W / CFG.refWidth;
  const s0 = Math.min(H * CFG.faceHeight / 1000, safeW * .96 / 2380);
  const mX = Math.max(0, (safeW / 2) / s0 - 1195), mY = Math.max(0, (H * CFG.windowHFrac / 2) / s0 - 548);
  // ---- face placement: drift, think sway, look shift, breathing, bounce, jitter, dizzy sway
  const iw = S.idleW;
  let dx = (Math.sin(t * .37 + 1.3) * .6 + Math.sin(t * .23 + .4) * .4) * mX * .42 * iw;
  let dy = (Math.sin(t * .29 + 2.1) * .6 + Math.sin(t * .17) * .4) * mY * .3 * iw;
  dx += Math.sin(t * TAU / 5.5) * mX * .9 * P['fx.think'];
  dx += S.lookX * mX * .55; dy += S.lookY * mY * .5;
  dx += P['f.dx']; dy += P['f.dy'];
  const br = Math.sin(t * TAU / 4.4);
  dy += br * 9 * P['f.float'] * (.3 + .7 * iw);
  dy -= Math.abs(Math.sin(t * TAU * 1.7)) * 22 * P['f.bounce'];
  dx += S.jx * P['f.jit']; dy += S.jy * P['f.jit'];
  dy += S.mouth.o * .05 * S.mouth.k;   // tiny nod with speech
  const sw = P['f.sway'];
  dx += Math.sin(t * 2.4) * 50 * sw; dy += Math.cos(t * 2.4) * 22 * sw;
  dx = clamp(dx, -mX, mX); dy = clamp(dy, -mY - 10, mY + 10);
  const lp = P['fx.listen'] * (.5 + .5 * Math.sin(t * TAU * .9));
  const sc = s0 * P['f.s'] * (1 + br * .006 * P['f.float']) * (1 + lp * .018 + S.listenLevel * .03);
  const tilt = P['f.tilt'] + Math.sin(t * 2.4 + 1) * .07 * sw;
  const cx = W / 2 + ox + dx * s0, cy = H / 2 + dy * s0;
  const cs = Math.cos(tilt) * sc, sn = Math.sin(tilt) * sc;
  const prims = buildPrims();
  // ---- sharp line layer (offscreen only when needed: pixel themes / shimmer band; else drawn straight onto the screen)
  const px = th.pixel > 1 ? 1 / th.pixel : 1;
  const shim = Math.max(P['fx.think'], P['fx.load'] * .7);
  const useLayer = th.pixel > 1 || shim > .01;
  if (useLayer) {
    sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, sharp.width, sharp.height);
    sctx.setTransform(cs * px, sn * px, -sn * px, cs * px, cx * px, cy * px);
    drawPrims(sctx, prims, 'sharp', th);
  }
  // ---- bloom source (thick glow strokes at low res)
  const ka = th.bloom.a.scale;
  bsctx.setTransform(1, 0, 0, 1, 0, 0); bsctx.clearRect(0, 0, bSrc.width, bSrc.height);
  bsctx.setTransform(cs * ka, sn * ka, -sn * ka, cs * ka, cx * ka, cy * ka);
  drawPrims(bsctx, prims, 'bloom', th);
  // processing shimmer band (thinking / loading)
  if (shim > .01) {
    const L0 = cx - 1300 * sc, L1 = cx + 1300 * sc, bx = lerp(L0, L1, (t / 1.7) % 1), bw = 260 * sc;
    for (const [c, k, col, a] of [[sctx, px, '255,200,190', .28], [bsctx, ka, '255,120,90', .7]]) {
      c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-atop';
      const g = c.createLinearGradient((bx - bw) * k, 0, (bx + bw) * k, 0);
      g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(.5, `rgba(${col},${a * shim})`); g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g; c.fillRect((bx - bw) * k, 0, bw * 2 * k, H * k + 2); c.globalCompositeOperation = 'source-over';
    }
  }
  // blur passes
  const FH = s0 * 1250;   // bloom radius follows face size (= screen height in the 80% landscape layout)
  const rA = FH * th.bloom.a.blur * ka, kb = th.bloom.b.scale, rB = FH * th.bloom.b.blur * kb;
  const skipA = FPS_CAP && (++blurTick & 1);   // while capped: refresh the full-size bloom every other frame (soft glow, not visible)
  if (!skipA) bactx.clearRect(0, 0, bA.width, bA.height); bbctx.clearRect(0, 0, bB.width, bB.height);
  if (FILTER_OK) {
    if (!skipA) { bactx.filter = `blur(${rA.toFixed(2)}px)`; bactx.drawImage(bSrc, 0, 0); bactx.filter = 'none'; }
    bbctx.filter = `blur(${rB.toFixed(2)}px)`; bbctx.drawImage(bSrc, 0, 0, bB.width, bB.height); bbctx.filter = 'none';
  } else { bactx.drawImage(bSrc, 0, 0); bbctx.drawImage(bSrc, 0, 0, bB.width, bB.height); }
  // ---- composite
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (th.background) th.background(ctx, W, H, t, S); else { ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); }
  const flick = 1 - th.flicker * (.5 + .5 * Math.sin(t * 53.7) * Math.sin(t * 31.3)) - (rand() < .02 ? th.flicker : 0);
  const glowMul = (1 + lp * .35 + S.listenLevel * .4) * flick;
  ctx.globalCompositeOperation = 'lighter'; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const ab = th.bloom.b.alpha * glowMul, aa = th.bloom.a.alpha * glowMul;
  ctx.globalAlpha = Math.min(1, ab); ctx.drawImage(bB, 0, 0, W, H);
  if (ab > 1) { ctx.globalAlpha = Math.min(1, ab - 1); ctx.drawImage(bB, 0, 0, W, H); }
  ctx.globalAlpha = Math.min(1, aa); ctx.drawImage(bA, 0, 0, W, H);
  if (aa > 1) { ctx.globalAlpha = Math.min(1, aa - 1); ctx.drawImage(bA, 0, 0, W, H); }
  if (useLayer) { ctx.globalAlpha = flick; ctx.imageSmoothingEnabled = !(th.pixel > 1); ctx.drawImage(sharp, 0, 0, W, H); ctx.imageSmoothingEnabled = true; }
  else { ctx.globalAlpha = 1; ctx.setTransform(cs, sn, -sn, cs, cx, cy); drawPrims(ctx, prims, 'sharp', th); ctx.setTransform(1, 0, 0, 1, 0, 0); }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // ---- refresh band position (CSS layer)
  if (th.band.alpha > 0) bandEl.style.transform = `translateY(${(((t / th.band.period) % 1) * 1.4 - .3) * innerHeight}px)`;
  // ---- glitch
  const gl = Math.max(P['fx.glitch'] * (.35 + .65 * (Math.sin(t * 3.1) * Math.sin(t * 7.7) > -.1 ? 1 : .2)), S.glitch.amt);
  if (gl > .02) glitchPost(gl);
  if (th.post) th.post(ctx, W, H, t, S);
  if (CFG.showSafe) {
    ctx.strokeStyle = 'rgba(0,255,120,.8)'; ctx.lineWidth = Math.max(1, H / 540); ctx.setLineDash([8, 6]);
    const vh = H * CFG.windowHFrac; ctx.strokeRect(W / 2 + ox - safeW / 2, (H - vh) / 2, safeW, vh); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(W / 2 + ox, H / 2 - 12); ctx.lineTo(W / 2 + ox, H / 2 + 12); ctx.moveTo(W / 2 + ox - 12, H / 2); ctx.lineTo(W / 2 + ox + 12, H / 2); ctx.stroke();
  }
}
function glitchPost(amt) {
  const G = S.glitch, step = Math.floor(S.t * 14);
  if (G.seedT !== step || !G.params) {
    G.seedT = step;
    const sl = []; const n = 2 + Math.floor(amt * 7);
    for (let i = 0; i < n; i++) sl.push([rand() * H, (4 + rand() * H * .07) * (0.4 + amt), (rand() - .5) * W * .07 * amt]);
    const bl = []; for (let i = 0; i < Math.floor(amt * 8); i++) bl.push([W * .2 + rand() * W * .6, H * .15 + rand() * H * .7, (6 + rand() * 30) * H / 1080, (3 + rand() * 12) * H / 1080, rand()]);
    G.params = { sl, bl, cs: (rand() - .5) * W * .012 * amt + W * .003 * amt, dim: rand() < .18 * amt };
  }
  const p = G.params;
  tctx.globalCompositeOperation = 'copy'; tctx.drawImage(cv, 0, 0); tctx.globalCompositeOperation = 'source-over';
  for (const [y, h, dx] of p.sl) { ctx.fillStyle = '#000'; ctx.fillRect(0, y, W, h); ctx.drawImage(tmp, 0, y, W, h, dx, y, W, h); }
  gctx.globalCompositeOperation = 'copy'; gctx.drawImage(tmp, 0, 0, ghost.width, ghost.height);
  gctx.globalCompositeOperation = 'multiply'; gctx.fillStyle = '#00e8ff'; gctx.fillRect(0, 0, ghost.width, ghost.height); gctx.globalCompositeOperation = 'source-over';
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .7 * amt; ctx.drawImage(ghost, p.cs, 0, W, H);
  ctx.globalAlpha = .35 * amt; ctx.drawImage(tmp, -p.cs * 1.4, 0, W, H);
  for (const [x, y, w, h, c] of p.bl) { ctx.globalAlpha = .5 * amt; ctx.fillStyle = c > .6 ? '#fff0ec' : '#ff2414'; ctx.fillRect(x, y, w, h); }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (p.dim) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, W, H); }
}

// ---------------------------------------------------------------- behaviour update
function update(dt) {
  S.t += dt; const t = S.t;
  if (S.demo) demoTick();
  const tr = S.trans;
  if (tr) { const k = clamp((t - tr.t0) / tr.d, 0, 1), e = easeIO(k); for (const key in tr.to) S.P[key] = tr.from[key] + (tr.to[key] - tr.from[key]) * e; if (k >= 1) S.trans = null; }
  const P = S.P;
  S.idleW = approach(S.idleW, S.idleOn ? 1 : 0, 2, dt);
  // blink
  const closed = P['fx.zzz'] > .4 || (P['eL.up'] < 90 && P['eL.lowVis'] < .5 && P['eR.up'] < 90) || P['fx.glitch'] > .5 || P['eL.ring'] > .5;
  if (S.idleOn && !closed) {
    S.blinkT -= dt;
    if (S.blinkT <= 0) { blink(); S.blinkT = P['fx.droop'] > .5 ? R(3, 6) : R(2.2, 5.8); if (rand() < .16) S.blinkQueue = 1; }
  }
  const bp = (t - S.blinkStart) / S.blinkDur;
  if (bp >= 0 && bp < 1) S.blinkVal = bp < .42 ? Math.sin(bp / .42 * Math.PI / 2) : 1 - easeIO((bp - .42) / .58);
  else { S.blinkVal = 0; if (bp >= 1 && S.blinkQueue) { S.blinkQueue = 0; S.blinkStart = t + .06; } }
  if (closed) S.blinkVal = 0;
  // gaze: saccades + glances + lookAt + pose gaze + thinking glances
  let tx = 0, ty = 0;
  if (S.look) { tx = S.look.x; ty = S.look.y; }
  S.sacT -= dt;
  if (S.sacT <= 0) {
    if (rand() < .2) { S.sac = { x: R(-.8, .8), y: R(-.35, .3) }; S.sacT = R(.6, 1.4); }
    else { S.sac = { x: R(-.22, .22), y: R(-.13, .13) }; S.sacT = R(.45, 2.2); }
    if (!S.idleOn) S.sac = { x: 0, y: 0 };
  }
  tx += S.sac.x * (S.look ? .3 : 1); ty += S.sac.y * (S.look ? .3 : 1);
  const think = P['fx.think'];
  if (think > .01) { S.thinkT -= dt; if (S.thinkT <= 0) { S.thinkSide *= -1; S.thinkT = R(2.2, 3.8); } }
  const gw = P['g.w'];
  tx = lerp(tx, P['g.x'] + S.sac.x * .2, gw); ty = lerp(ty, P['g.y'] + S.sac.y * .2, gw);
  tx = lerp(tx, S.thinkSide * .62 + S.sac.x * .25, think); ty = lerp(ty, -.62 + S.sac.y * .2, think);
  if (P['f.jit'] > .2) { tx += (rand() - .5) * .08 * P['f.jit']; ty += (rand() - .5) * .08 * P['f.jit']; }
  S.gx = approach(S.gx, clamp(tx, -1, 1), 22, dt); S.gy = approach(S.gy, clamp(ty, -1, 1), 22, dt);
  S.lookX = approach(S.lookX, S.look ? S.look.x : 0, 3.5, dt); S.lookY = approach(S.lookY, S.look ? S.look.y : 0, 3.5, dt);
  S.jT -= dt; if (S.jT <= 0) { S.jT = 1 / 28; S.jx = (rand() - .5) * 14; S.jy = (rand() - .5) * 10; }
  S.listenLevel = approach(S.listenLevel, 0, 3, dt);
  updateTalk(dt);
  const G = S.glitch;
  if (S.theme.microGlitch && S.idleOn && !S.noMicroGlitch) { G.T -= dt; if (G.T <= 0) { G.until = t + R(.08, .22); G.T = R(8, 20); } }
  G.amt = t < G.until ? .35 : 0;
}
function blink() { S.blinkStart = S.t; S.blinkDur = S.P['fx.droop'] > .5 ? R(.32, .45) : R(.14, .2); }

// ---------------------------------------------------------------- talking
function updateTalk(dt) {
  const M = S.mouth, now = S.t; let tgt = null, amp = 1;
  if (S.audio && S.audio.analyser) {
    const a = S.audio; a.analyser.getFloatTimeDomainData(a.buf); let sum = 0; for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
    const rms = Math.sqrt(sum / a.buf.length); const lvl = clamp((rms - .008) * 7, 0, 1);
    a.lvl = lvl > a.lvl ? lerp(a.lvl, lvl, .6) : lerp(a.lvl, lvl, .18);
    a.analyser.getByteFrequencyData(a.fbuf); let num = 0, den = 0; for (let i = 2; i < a.fbuf.length; i++) { num += i * a.fbuf[i]; den += a.fbuf[i]; }
    const cen = den ? clamp((num / den) / (a.fbuf.length * .25), 0, 1) : .5;
    if (a.lvl > .02 || a.playing) tgt = { o: a.lvl * 160, w: lerp(.55, 1.1, cen), p: lerp(2, 3.5, cen), u: .45 };
  }
  if (!tgt && now - S.ext.t < .25) tgt = { o: clamp(S.ext.v, 0, 1) * 160, w: .9, p: 2.6, u: .45 };
  if (!tgt && S.talk) {
    const T = S.talk; T.pos += dt * T.rate;
    while (T.idx < T.items.length && T.pos > T.items[T.idx].t + T.items[T.idx].d) T.idx++;
    if (T.idx >= T.items.length) { if (!T.waitTTS) finishTalk(); else tgt = babble(dt, .5); }
    else { const it = T.items[T.idx]; tgt = VIS[it.v]; amp = it.k; }
  }
  if (!tgt && S.P['fx.chatter'] > .5) tgt = babble(dt, 1);
  const active = !!tgt; tgt = tgt || VIS.rest;
  const r = 26;
  M.o = approach(M.o, tgt.o * amp * TALK_OPEN, r, dt); M.w = approach(M.w, tgt.w, r * .8, dt); M.p = approach(M.p, tgt.p, r * .6, dt); M.u = approach(M.u, tgt.u, r * .6, dt);
  M.k = approach(M.k, active ? 1 : 0, active ? 14 : 5, dt);
}
function babble(dt, k) {
  const B = S.babble; B.T -= dt;
  if (B.T <= 0) { if (rand() < .1) { B.v = 'rest'; B.T = R(.18, .35); } else { const keys = ['AA', 'EH', 'EE', 'OH', 'OO', 'MBP', 'TDN', 'SZ', 'KG', 'L', 'AE', 'R']; B.v = keys[Math.floor(rand() * keys.length)]; B.T = R(.07, .15); } }
  const v = VIS[B.v]; return { o: v.o * k, w: v.w, p: v.p, u: v.u };
}
let talkToken = 0;
const TALK_OPEN = 1.45;   // overall lip-sync amplitude
function startTimeline(text, opts = {}) {
  const tl = textToVisemes(text);
  S.talk = { items: tl.items, words: tl.words, dur: tl.dur, pos: 0, idx: 0, rate: opts.rate || 1, waitTTS: !!opts.waitTTS, done: opts.done || null };
  if (opts.durationMs) S.talk.rate = tl.dur / (opts.durationMs / 1000);
  return S.talk;
}
function finishTalk() { const T = S.talk; S.talk = null; if (T && T.done) T.done(); }
function syncWord(ci) {
  const T = S.talk; if (!T) return; let w = null; for (const x of T.words) { if (x.ci <= ci) w = x; else break; } if (!w) return;
  if (Math.abs(T.pos - w.t) > .04) T.rate = clamp(T.rate * (T.pos > w.t ? .93 : 1.07), .55, 1.8);
  T.pos = w.t; T.idx = 0; while (T.idx < T.items.length && T.pos > T.items[T.idx].t + T.items[T.idx].d) T.idx++;
}
function speak(text, opts = {}) {
  stopSpeaking(true);
  return new Promise(resolve => {
    const my = ++talkToken; let started = false, finished = false, fellBack = false;
    const end = () => { if (finished) return; finished = true; if (S.talk && S.talk.tok === my) S.talk = null; emit({ event: 'speakEnd', text }); resolve(); };
    const silent = () => { if (finished || fellBack) return; fellBack = true; const T = startTimeline(text, { rate: opts.rate || 1, durationMs: opts.durationMs, done: end }); T.tok = my; emit({ event: 'speakStart', text, tts: false }); };
    const synth = window.speechSynthesis;
    if (opts.silent || !synth || !window.SpeechSynthesisUtterance) return silent();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate || 1; u.pitch = opts.pitch != null ? opts.pitch : 1.05; u.volume = opts.volume != null ? opts.volume : 1; u.lang = opts.lang || 'en-US';
    try { const vs = synth.getVoices(); const v = (opts.voice && vs.find(x => x.name === opts.voice)) || vs.find(x => /^en[-_]US/i.test(x.lang)) || vs.find(x => /^en/i.test(x.lang)); if (v) u.voice = v; } catch (e) {}
    u.onstart = () => { if (my !== talkToken || fellBack) return; started = true; const T = startTimeline(text, { rate: u.rate, waitTTS: true }); T.tok = my; emit({ event: 'speakStart', text, tts: true }); };
    u.onboundary = e => { if (my !== talkToken || fellBack) return; if (!e.name || e.name === 'word') syncWord(e.charIndex); };
    u.onend = () => { if (!fellBack) end(); };
    u.onerror = () => { if (my !== talkToken || fellBack) return; if (!started) silent(); else end(); };
    try { synth.cancel(); synth.speak(u); } catch (e) { return silent(); }
    setTimeout(() => { if (!started && !finished && my === talkToken) { try { synth.cancel(); } catch (e) {} silent(); } }, opts.startTimeout || 1500);
  });
}
function stopSpeaking(quiet) { talkToken++; S.talk = null; try { if (window.speechSynthesis && !quiet) speechSynthesis.cancel(); } catch (e) {} }
async function say(text, expression, opts = {}) {
  const prev = S.base;
  if (expression) setExpression(expression);
  await speak(text, opts);
  if (expression && S.base === expression && opts.revert !== false) setTimeout(() => { if (S.base === expression) setExpression(prev); }, 500);
}
// amplitude-driven lip sync (Web Audio API)
let actx = null; const srcCache = new WeakMap();
function attachAudio(src) {
  detachAudio();
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  let el = null, node, toSpeakers = false;
  if (typeof src === 'string') { el = new Audio(); el.crossOrigin = 'anonymous'; el.src = src; }
  else if (src instanceof HTMLMediaElement) el = src;
  if (el) { node = srcCache.get(el); if (!node) { node = actx.createMediaElementSource(el); srcCache.set(el, node); } toSpeakers = true; }
  else if (src instanceof MediaStream) node = actx.createMediaStreamSource(src);   // mic: analyse only, no feedback
  else if (src && src.connect) { node = src; toSpeakers = true; }
  const an = actx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = .5;
  node.connect(an); if (toSpeakers) an.connect(actx.destination);
  S.audio = { analyser: an, node, el, buf: new Float32Array(an.fftSize), fbuf: new Uint8Array(an.frequencyBinCount), lvl: 0, playing: !el };
  if (el) { el.addEventListener('play', () => { if (S.audio) S.audio.playing = true; }); el.addEventListener('pause', () => { if (S.audio) S.audio.playing = false; }); el.addEventListener('ended', () => detachAudio(), { once: true }); }
  return el || node;
}
function detachAudio() { if (S.audio) { try { S.audio.node.disconnect(); S.audio.analyser.disconnect(); } catch (e) {} } S.audio = null; }
function playAudio(url, expression) {
  const prev = S.base; if (expression) setExpression(expression);
  const el = attachAudio(url);
  return new Promise(res => { el.addEventListener('ended', () => { if (expression && S.base === expression) setExpression(prev); emit({ event: 'audioEnd' }); res(); }, { once: true }); el.play().catch(() => res()); });
}

// ---------------------------------------------------------------- public state changes
function resolveName(n) { if (!n) return 'smile'; if (EXPRESSIONS[n]) return n; if (ALIASES[n]) return ALIASES[n]; const k = Object.keys(EXPRESSIONS).find(x => x.toLowerCase() === String(n).toLowerCase()); return k || null; }
function setExpression(name, ms) {
  const n = resolveName(name); if (!n) { console.warn('Gibson: unknown expression', name); return false; }
  const d = (ms == null ? CFG.transitionMs : ms) / 1000;
  const to = buildPose(EXPRESSIONS[n], S.theme);
  S.base = n;
  if (n !== 'thinking') S.thinkOn = S.thinkOn && false;
  if (d <= 0) { S.P = to; S.trans = null; }
  else S.trans = { from: Object.assign({}, S.P), to, t0: S.t, d };
  emit({ event: 'expression', name: n });
  return true;
}
function think(on = true) {
  if (on) { if (!S.thinkOn && !S.listenOn) S.beforeMode = S.base; S.listenOn = false; setExpression('thinking', 600); S.thinkOn = true; }
  else if (S.thinkOn || S.base === 'thinking') { S.thinkOn = false; setExpression(S.beforeMode || 'smile', 600); }
}
function listen(on = true) {
  if (on) { if (!S.thinkOn && !S.listenOn) S.beforeMode = S.base; S.thinkOn = false; setExpression('listening', 450); S.listenOn = true; }
  else if (S.listenOn || S.base === 'listening') { S.listenOn = false; setExpression(S.beforeMode || 'smile', 450); }
}
function lookAt(x, y) { if (x == null || x === false) S.look = null; else S.look = { x: clamp(+x || 0, -1, 1), y: clamp(+y || 0, -1, 1) }; }
function idle(on = true) { S.idleOn = !!on; }
function setTheme(name) { const th = typeof name === 'object' ? name : THEMES[name]; if (!th) return false; S.theme = th; CFG.theme = th.name; W = H = 0; resize(); setExpression(S.base, 300); return true; }
function registerTheme(name, obj) { THEMES[name] = Object.assign({}, THEMES.red, obj, { name }); return THEMES[name]; }

// ---------------------------------------------------------------- demo mode (also drives the preview recorder)
const DEMO_LINE = "Hi Lenny! I'm Gibson, your desktop terminal. Mmm... what should we build today?";
function demoScript() {
  const steps = [];
  const add = (d, cap, fn, subs) => steps.push({ d, cap, fn, subs: subs || [] });
  add(5.2, 'idle · blink · glance', () => { S.thinkOn = S.listenOn = false; lookAt(null); idle(true); setExpression('smile', 500); },
    [[1.0, blink], [2.0, () => lookAt(-.8, 0)], [3.0, () => lookAt(.7, -.25)], [4.0, () => lookAt(null)], [4.6, blink]]);
  add(4.4, 'neutral · look around', () => setExpression('neutral', 450),
    [[.8, () => lookAt(-.9, .1)], [1.8, () => lookAt(.9, -.4)], [2.7, () => lookAt(0, .7)], [3.4, () => lookAt(null)], [3.7, blink]]);
  add(5.8, 'thinking', () => { S.thinkSide = 1; S.thinkT = 2.6; think(true); });
  add(() => textToVisemes(DEMO_LINE).dur + .6, 'talking', () => { think(false); setExpression('neutral', 400); speak(DEMO_LINE, { silent: S.manual || S.demoSilent }); });
  add(3.8, 'listening', () => { stopSpeaking(true); listen(true); }, [[3.5, () => { S.listenOn = false; }]]);
  for (const n of TOUR) add(n === 'smile' ? 1.0 : (n === 'loading' || n === 'error' || n === 'dizzy') ? 1.1 : .9, LABELS[n] || n, () => { S.listenOn = S.thinkOn = false; setExpression(n, 330); });
  add(1.8, 'smile', () => setExpression('smile', 500));
  return steps;
}
function demo(on = true) {
  if (!on) { S.demo = null; caption(''); emit({ event: 'demo', on: false }); return; }
  S.demo = { steps: demoScript(), i: -1, next: S.t, subs: [] }; emit({ event: 'demo', on: true });
}
function demoTick() {
  const D = S.demo;
  for (let j = D.subs.length - 1; j >= 0; j--) if (S.t >= D.subs[j][0]) { const f = D.subs[j][1]; D.subs.splice(j, 1); f(); }
  while (S.demo && S.t >= D.next) {
    D.i++;
    if (D.i >= D.steps.length) { if (!S.manual) { D.steps = demoScript(); D.i = 0; } else { S.demo = null; emit({ event: 'demo', on: false, done: true }); return; } }
    const st = D.steps[D.i], t0 = D.next;
    caption(st.cap); st.fn();
    for (const [dt, f] of st.subs) D.subs.push([t0 + dt, f]);
    D.next = t0 + (typeof st.d === 'function' ? st.d() : st.d);
  }
}
const capEl = document.getElementById('cap');
function caption(txt) { S.caption = txt || ''; capEl.textContent = S.caption; capEl.style.display = CFG.captions && S.caption ? 'block' : 'none'; }

// ---------------------------------------------------------------- bridge (postMessage / Android WebView / iframe)
function emit(obj) {
  const s = JSON.stringify(obj);
  try { if (window.GibsonNative && window.GibsonNative.postMessage) window.GibsonNative.postMessage(s); } catch (e) {}
  try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s); } catch (e) {}
  try { if (window.parent && window.parent !== window) window.parent.postMessage(Object.assign({ source: 'gibson' }, obj), '*'); } catch (e) {}
  if (typeof API !== 'undefined' && typeof API.onEvent === 'function') try { API.onEvent(obj); } catch (e) {}
}
function receive(msg) {
  let m = msg; if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { return { ok: false, error: 'bad json' }; } }
  if (!m || typeof m !== 'object') return { ok: false };
  if (Array.isArray(m)) return m.map(receive);
  if (m.source === 'gibson') return { ok: false };
  const c = m.cmd || m.type || m.action;
  switch (c) {
    case 'setExpression': case 'expression': return { ok: setExpression(m.name || m.expression, m.ms) };
    case 'speak': speak(m.text || '', m); return { ok: true };
    case 'say': say(m.text || '', m.expression || m.name, m); return { ok: true };
    case 'stop': stopSpeaking(); return { ok: true };
    case 'lookAt': lookAt(m.x, m.y); return { ok: true };
    case 'think': think(m.on !== false); return { ok: true };
    case 'listen': listen(m.on !== false); return { ok: true };
    case 'idle': idle(m.on !== false); return { ok: true };
    case 'setTheme': case 'theme': return { ok: setTheme(m.name) };
    case 'blink': blink(); return { ok: true };
    case 'mouthLevel': setMouthLevel(m.v != null ? m.v : m.level); return { ok: true };
    case 'listenLevel': API.setListenLevel(m.v != null ? m.v : m.level); return { ok: true };
    case 'mouthText': speak(m.text || '', { silent: true, durationMs: m.ms || m.durationMs }); return { ok: true };
    case 'playAudio': playAudio(m.url, m.expression); return { ok: true };
    case 'quality': CFG.renderScale = clamp(+m.scale || 1, .3, 1); CFG.autoQuality = !!m.auto; W = H = 0; resize(); return { ok: true };
    case 'config': return { ok: true, config: config(m) };
    case 'demo': demo(m.on !== false); return { ok: true };
    case 'debug': toggleDebug(m.on); return { ok: true };
    case 'state': return { ok: true, state: API.state };
    case 'ping': emit({ event: 'pong' }); return { ok: true };
  }
  return { ok: false, error: 'unknown cmd ' + c };
}
addEventListener('message', e => { const d = e.data; if (d && (typeof d === 'string' || Array.isArray(d) || d.cmd || d.type || d.action)) receive(d); });
function setMouthLevel(v) { S.ext.v = clamp(+v || 0, 0, 1); S.ext.t = S.t; }
function config(o) { o = o || {}; for (const k of ['offsetX', 'safeFrac', 'faceHeight', 'showSafe', 'transitionMs', 'captions', 'maxDPR']) if (o[k] != null) CFG[k] = o[k]; if (o.maxDPR) { W = H = 0; resize(); } saveCfg(); return Object.assign({}, CFG); }

// ---------------------------------------------------------------- debug panel
const dbg = document.getElementById('dbg');
let dbgBuilt = false;
function toggleDebug(on) { if (!dbgBuilt) buildDebug(); dbg.hidden = on == null ? !dbg.hidden : !on; document.body.style.cursor = dbg.hidden ? 'none' : 'default'; }
function buildDebug() {
  dbgBuilt = true;
  const exprBtns = Object.keys(EXPRESSIONS).map(n => `<button data-e="${n}">${n}</button>`).join('');
  dbg.innerHTML = `
  <div class="row" style="justify-content:space-between"><b style="color:#ff5a4a">GIBSON FACE · debug</b><span id="fps"></span><button data-a="close">×</button></div>
  <h3>Expressions</h3><div>${exprBtns}</div>
  <h3>Speech</h3><input type="text" id="sayTxt" value="Hello Lenny! I am Gibson, your desktop robot. How can I help?">
  <div class="row"><button data-a="speak">speak()</button><button data-a="silent">mouth only</button><button data-a="sayHappy">say(…, 'happy')</button><button data-a="stop">stop</button></div>
  <h3>Modes</h3><div class="row"><button data-t="think">think</button><button data-t="listen">listen</button><button data-t="idle">idle</button><button data-t="demo">demo</button><button data-a="blink">blink</button><button data-t="safe">safe area</button><button data-a="glitch">micro-glitch</button></div>
  <h3>lookAt (drag; double-click = reset)</h3><div class="row"><div id="pad"><i></i></div><button data-a="lookReset">reset</button></div>
  <h3>Screen fit</h3><div class="row">offsetX <input type="range" id="ox" min="-250" max="250" step="1" value="${CFG.offsetX}"><span id="oxv">${CFG.offsetX}px</span></div>
  <div class="row">transition <input type="range" id="tms" min="0" max="1500" step="10" value="${CFG.transitionMs}"><span id="tmsv">${CFG.transitionMs}ms</span></div>
  <div class="row">theme <select id="thm">${Object.keys(THEMES).map(k => `<option ${k === S.theme.name ? 'selected' : ''}>${k}</option>`).join('')}</select></div>`;
  const $ = s => dbg.querySelector(s);
  dbg.addEventListener('pointerdown', e => e.stopPropagation());
  dbg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.e) { S.thinkOn = S.listenOn = false; if (S.demo) demo(false); setExpression(b.dataset.e); }
    const a = b.dataset.a, tg = b.dataset.t, txt = $('#sayTxt').value;
    if (a === 'close') toggleDebug(false);
    if (a === 'speak') speak(txt); if (a === 'silent') speak(txt, { silent: true }); if (a === 'sayHappy') say(txt, 'happy'); if (a === 'stop') stopSpeaking();
    if (a === 'blink') blink(); if (a === 'lookReset') { lookAt(null); $('#pad i').style.left = '50%'; $('#pad i').style.top = '50%'; }
    if (a === 'glitch') S.glitch.until = S.t + .25;
    if (tg === 'think') think(!S.thinkOn); if (tg === 'listen') listen(!S.listenOn); if (tg === 'idle') idle(!S.idleOn);
    if (tg === 'demo') demo(!S.demo); if (tg === 'safe') { CFG.showSafe = !CFG.showSafe; saveCfg(); }
    syncBtns();
  });
  const pad = $('#pad'); let drag = false;
  const padMove = e => { const r = pad.getBoundingClientRect(); const x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1); lookAt(x * 2 - 1, y * 2 - 1); pad.firstChild.style.left = x * 100 + '%'; pad.firstChild.style.top = y * 100 + '%'; };
  pad.addEventListener('pointerdown', e => { drag = true; pad.setPointerCapture(e.pointerId); padMove(e); });
  pad.addEventListener('pointermove', e => { if (drag) padMove(e); });
  pad.addEventListener('pointerup', () => drag = false);
  pad.addEventListener('dblclick', () => { lookAt(null); pad.firstChild.style.left = '50%'; pad.firstChild.style.top = '50%'; });
  $('#ox').addEventListener('input', e => { CFG.offsetX = +e.target.value; $('#oxv').textContent = CFG.offsetX + 'px'; saveCfg(); });
  $('#tms').addEventListener('input', e => { CFG.transitionMs = +e.target.value; $('#tmsv').textContent = CFG.transitionMs + 'ms'; });
  $('#thm').addEventListener('change', e => { setTheme(e.target.value); saveCfg(); });
  syncBtns();
}
function syncBtns() {
  if (!dbgBuilt) return;
  const m = { think: S.thinkOn, listen: S.listenOn, idle: S.idleOn, demo: !!S.demo, safe: CFG.showSafe };
  dbg.querySelectorAll('button[data-t]').forEach(b => b.classList.toggle('on', !!m[b.dataset.t]));
  dbg.querySelectorAll('button[data-e]').forEach(b => b.classList.toggle('on', b.dataset.e === S.base));
}
addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  if (e.key === 'd' || e.key === 'D') toggleDebug();
  else if (e.key === ' ') blink();
});
addEventListener('pointerdown', e => {   // tap the top-left corner to toggle the debug panel
  if (window.GIBSON_APP) return;
  const cs = Math.min(innerWidth, innerHeight) * .16;
  if (e.clientX < cs && e.clientY < cs) toggleDebug();
});

// ---------------------------------------------------------------- main loop
let last = performance.now(), fpsAcc = 0, fpsN = 0, FPS_CAP = 0, IDLE_CAP = 0, MAX_FPS = 0, lastDraw = 0, blurTick = 0, capAcc = 0;
function calmCap() {
  if (!IDLE_CAP || !S.idleOn || S.demo || S.trans || S.talk || S.mouth.k > .02 || S.glitch.amt > 0 || S.P['fx.think'] > .01 || S.P['fx.listen'] > .01 || S.listenLevel > .02) return 0;
  const moving = S.blinkVal > 0 || S.t - S.blinkStart < S.blinkDur + .08 || Math.abs(S.gx - (S.rgx || 0)) > .01 || Math.abs(S.gy - (S.rgy || 0)) > .01;
  return moving ? IDLE_CAP : Math.max(8, Math.round(IDLE_CAP * .55));
}
function frame(now) {
  requestAnimationFrame(frame);
  if (S.manual) return;
  const dt = Math.min(.05, Math.max(0, (now - last) / 1000)); last = now;
  update(dt);
  const cap = FPS_CAP || calmCap() || MAX_FPS;
  if (cap && now - lastDraw < 1000 / cap - 4) return;
  const fdt = Math.min(.25, Math.max(0, (now - lastDraw) / 1000)); lastDraw = now;
  render(); S.rgx = S.gx; S.rgy = S.gy;
  fpsAcc += fdt; fpsN++; capAcc += cap || 60;
  if (fpsAcc > .5) { const want = capAcc / fpsN; S.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; capAcc = 0; autoQuality(want); if (dbgBuilt && !dbg.hidden) { const f = dbg.querySelector('#fps'); if (f) f.textContent = S.fps.toFixed(0) + ' fps'; syncBtns(); } }
}
document.addEventListener('visibilitychange', () => { last = performance.now(); slowN = 0; });
let slowN = 0;
function autoQuality(want) {   // if the device can't hold ~60 fps, render fewer pixels (glow hides the softness)
  if (!CFG.autoQuality || document.hidden || S.t < 3) return;
  slowN = S.fps < Math.min(48, (want || 60) * .8) ? slowN + 1 : 0;   // while capped, 'slow' means below the cap
  if (slowN >= 4 && CFG.renderScale > .55) { CFG.renderScale = Math.round((CFG.renderScale - .15) * 100) / 100; slowN = 0; W = H = 0; resize(); emit({ event: 'quality', renderScale: CFG.renderScale }); }
}

const API = {
  setExpression, speak, say, lookAt, think, listen, setTheme, idle,
  stop: stopSpeaking, blink, demo, registerTheme, attachAudio, detachAudio, playAudio, setMouthLevel,
  mouthText: (text, ms) => speak(text, { silent: true, durationMs: ms }),
  setListenLevel: v => { S.listenLevel = Math.max(S.listenLevel, clamp(+v || 0, 0, 1)); },
  config, receive, debug: toggleDebug,
  setFpsCap: n => { FPS_CAP = Math.max(0, +n || 0); fpsAcc = 0; fpsN = 0; capAcc = 0; },
  setIdleCap: n => { IDLE_CAP = Math.max(0, +n || 0); }, setMaxFps: n => { MAX_FPS = Math.max(0, +n || 0); },
  get expressions() { return Object.keys(EXPRESSIONS); }, get tour() { return TOUR.slice(); }, get labels() { return Object.assign({}, LABELS); },
  get themes() { return Object.keys(THEMES); },
  get state() { return { expression: S.base, thinking: S.thinkOn, listening: S.listenOn, idle: S.idleOn, speaking: !!S.talk || S.mouth.k > .05, demo: !!S.demo, fps: Math.round(S.fps), caption: S.caption, t: S.t }; },
  THEMES, EXPRESSIONS, onEvent: null,
  // test / recording hooks (deterministic stepping)
  _manual(on) { S.manual = !!on; last = performance.now(); },
  _step(ms, sub) { const n = Math.max(1, Math.round(ms / (sub || ms))); for (let i = 0; i < n; i++) update(ms / n / 1000); render(); return S.caption; },
  _seed(n) { seedRandom(n); }, _noMicroGlitch(on) { S.noMicroGlitch = !!on; },
  _textToVisemes: textToVisemes,
  _bbox() { const pr = buildPrims(); let a = [1e9, 1e9, -1e9, -1e9]; for (const p of pr) { const pts = p.dot ? [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r] : p.pts; for (let i = 0; i < pts.length; i += 2) { a[0] = Math.min(a[0], pts[i]); a[1] = Math.min(a[1], pts[i + 1]); a[2] = Math.max(a[2], pts[i]); a[3] = Math.max(a[3], pts[i + 1]); } } return a.map(Math.round); }
};
window.Gibson = API;
window.GibsonBridge = { receive: s => JSON.stringify(receive(s)) };   // Android: webView.evaluateJavascript("GibsonBridge.receive('{...}')", cb)

resize();
if (Q.get('seed')) seedRandom(+Q.get('seed'));
if (Q.get('expr')) setExpression(Q.get('expr'), 0);
if (Q.get('demo') === '1') demo(true);
if (Q.get('debug') === '1') toggleDebug(true);
render();
requestAnimationFrame(frame);
emit({ event: 'ready', expressions: Object.keys(EXPRESSIONS) });
})();
