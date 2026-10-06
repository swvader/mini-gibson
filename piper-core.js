// Piper (VITS) text -> phoneme ids, same as piper-phonemize: eSpeak-NG IPA, punctuation kept, "^" start, "_" pad after each phoneme, "$" end.
import { phonemize } from './vendor/phonemizer.js';
export async function textToIds(text, cfg) {
  const map = cfg.phoneme_id_map, lang = (cfg.espeak && cfg.espeak.voice) || 'en-us';
  const ids = [...map['^'], ...map['_']];
  const push = ch => { const id = map[ch]; if (id) ids.push(...id, ...map['_']); };
  // split on punctuation ourselves so it can be put back between the phonemized pieces (it drives pauses and intonation)
  const parts = String(text).replace(/\s+/g, ' ').trim().split(/([.,!?;:]+)/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg.trim()) continue;
    if (/^[.,!?;:]+$/.test(seg)) { push(seg[seg.length - 1]); if (i < parts.length - 1) push(' '); continue; }
    const ph = (await phonemize(seg, lang)).join(' ');
    for (const ch of ph) push(ch);
  }
  ids.push(...map['$']);
  return ids;
}
