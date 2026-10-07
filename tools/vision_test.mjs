// node tools/vision_test.mjs : unit test of the camera trigger matcher in app.js (extracted between the <vision-match> markers)
import fs from 'fs';
const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('// <vision-match>'), src.indexOf('// </vision-match>'));
const { cameraIntent, backIntent } = new Function(code + '\nreturn { cameraIntent, backIntent };')();
const cases = [
  ['take a look', 'vision'], ['Hey Gibson, take a look.', 'vision'], ['look at this', 'vision'], ['look', 'vision'], ['Look!', 'vision'], ['hey gibson look', 'vision'],
  ['what do you see', 'vision'], ['What do you see?', 'vision'], ['what is this', 'vision'], ["what's this", 'vision'], ['whats this', 'vision'], ['um what is this thing', 'vision'],
  ['can you read this', 'label'], ['read this', 'label'], ['hey gibson can you read this for me', 'label'], ['read the label', 'label'], ['what does this say', 'label'], ['what does it say', 'label'],
  ['take a picture', 'photo'], ['take a photo', 'photo'], ['take a pic', 'photo'], ['snap a pic', 'photo'], ['hey gibson take a selfie', 'photo'], ['record a video', 'video'], ['start recording', 'video'], ['Gibson, film me', null], ['record a short clip', 'video'], ['how is your battery', null], ['hey look what you see behind you', 'vision', true], ["what's behind you", 'vision', true], ['look behind you', 'vision', true], ['take a picture behind you', 'photo', true],
  ['record a video behind you', 'video', true], ['use your back camera', 'vision', true], ['what do you see with your rear camera', 'vision', true], ['read this label with your back camera', 'label', true], ['what do you see', 'vision', false], ['take a selfie', 'photo', false], ['are you running hot', null], ['check this out', 'vision'], ['what am I holding', 'vision'],
  ['see this', 'vision'], ['can you see', 'vision'], ['can you see me', 'vision'], ['tell me what this is', 'vision'], ['look here', 'vision'], ['okay gibson uh look at this', 'vision'],
  ['what does the label say', 'label'], ['read my prescription', 'label'], ['what medicine is this', 'label'], ['hey Gibson. Check this out!', 'vision'], ['do you see this', 'vision'],
  ['look up the weather', null], ["what's the stock price", null], ["what's the stock price of apple", null], ['what is the weather today', null], ['tell me a joke', null],
  ['look for a pizza place nearby', null], ['see you later', null], ["what's this weekend's forecast", null], ['what is the capital of France', null], ['how are you', null],
  ["let's see if it rains", null], ['I look forward to it', null], ['what time is it', null], ['what is that song about', null], ['explain how a fan works', null]
];
let fail = 0;
for (const [t, want, wantBack] of cases) { const got = cameraIntent(t); const ok = got === want && (wantBack == null || backIntent(t) === wantBack); if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(t).padEnd(44)} -> ${got} ${ok ? '' : '(want ' + want + ')'}`); }
console.log(`\n${cases.length - fail}/${cases.length} passed`); process.exit(fail ? 1 : 0);
