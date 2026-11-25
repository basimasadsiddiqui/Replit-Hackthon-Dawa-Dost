// Run with:  npm test
// Starts a fake Gemini/Groq server (tests/mock-ai.mjs) and the real app server, then checks behaviour end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://localhost:3002';
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json().catch(() => null), r }));
const get = p => fetch(BASE + p).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const UR_CHEST = 'مجھے سینے میں درد ہے';

async function withServer(mode, env, fn) {
  const mock = spawn('node', [path.join(root, 'tests', 'mock-ai.mjs')], { env: { ...process.env, MOCK_MODE: mode } });
  const srv = spawn('node', [path.join(root, 'server.js')], { cwd: root, env: { ...process.env, PORT: '3002', GEMINI_API_KEY: 'x', GROQ_API_KEY: 'y',
    GEMINI_BASE: 'http://localhost:4010', GROQ_BASE: 'http://localhost:4010', ADMIN_KEY: 'k', ...env } });
  await wait(1500);
  try { await fn(); } finally { mock.kill(); srv.kill(); await wait(400); }
}

test('data: medicine list is consistent', () => {
  const meds = JSON.parse(fs.readFileSync(path.join(root, 'public', 'meds.json'), 'utf8'));
  assert.equal(meds.length, new Set(meds.map(m => m.id)).size, 'unique ids');
  for (const m of meds) {
    assert.ok(m.gp < m.bp, `${m.id}: cheaper price must be lower than brand price`);
    assert.ok(m.n > 0 && m.days > 0, `${m.id}: pack size and days`);
    assert.ok(m.slots.length && m.slots.every(s => ['morning', 'noon', 'night'].includes(s)), `${m.id}: slots`);
    assert.ok(['after', 'before', 'empty', 'any'].includes(m.food), `${m.id}: food`);
    for (const k of ['use', 'how', 'warn']) assert.ok(m[k][0] && m[k][1], `${m.id}: ${k} has English and Urdu`);
  }
});

test('normal mode: new Gemini API, agents call tools', async () => {
  await withServer('both', {}, async () => {
    const cfg = await get('/api/config');
    assert.deepEqual(cfg.j, { ai: true, tts: true, providers: { gemini: true, groq: true } });

    const chat = await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'cheaper than Panadol?' }], meds: [] });
    assert.equal(chat.s, 200);
    assert.match(chat.j.provider, /gemini:gemini-3\.8-flash:interactions/);
    assert.deepEqual(chat.j.trace, ['lookup_medicine', 'check_interactions']);

    const plan = await post('/api/plan', { lang: 'ur', meds: [{ name: 'Panadol', salt: 'Paracetamol', slots: ['morning'], days: 3 }] });
    assert.equal(plan.s, 200);
    assert.ok(plan.j.items.length >= 1 && Array.isArray(plan.j.watch_out) && Array.isArray(plan.j.ask_doctor));
    assert.ok(plan.j.trace.includes('lookup_medicine'));

    const scan = await post('/api/scan', { image: 'AAAA', mime: 'image/jpeg' });
    assert.equal(scan.s, 200);
    assert.equal(scan.j.medicines[0].name, 'Panadol');
    assert.equal(scan.j.medicines[0].frequency, '1+0+1');

    const tts = await fetch(BASE + '/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'salaam', lang: 'ur' }) });
    assert.equal(tts.status, 200);
    assert.equal(tts.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await tts.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  });
});

test('safety: emergency phrases skip the AI (English and Urdu)', async () => {
  await withServer('both', {}, async () => {
    for (const text of ['I have chest pain', 'I cannot breathe', 'he is unconscious', 'seene mein dard', UR_CHEST]) {
      const r = await post('/api/chat', { lang: text === UR_CHEST ? 'ur' : 'en', messages: [{ role: 'user', text }] });
      assert.equal(r.j.emergency, true, text);
      assert.deepEqual(r.j.trace, ['emergency_guard']);
      assert.match(r.j.reply, /1122/);
    }
    const ok = await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'Is Brufen cheaper than Ponstan?' }] });
    assert.equal(ok.j.emergency, undefined, 'a normal question must not trigger the guard');
  });
});

test('input validation', async () => {
  await withServer('both', {}, async () => {
    assert.equal((await post('/api/scan', { image: 'AAAA', mime: 'text/html' })).s, 400);
    assert.equal((await post('/api/scan', {})).s, 400);
    assert.equal((await post('/api/chat', { messages: [] })).s, 400);
    assert.equal((await post('/api/chat', { messages: [{ role: 'assistant', text: 'hi' }] })).s, 400);
    assert.equal((await post('/api/plan', { meds: [] })).s, 400);
    assert.equal((await post('/api/tts', { text: '' })).s, 400);
    assert.equal((await post('/api/live/vote', { type: 'mood', mood: 'angry' })).s, 400);
  });
});

test('fallback: new Gemini API rejected -> legacy API', async () => {
  await withServer('no-interactions', {}, async () => {
    const chat = await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'Panadol price?' }] });
    assert.match(chat.j.provider, /gemini:gemini-3\.8-flash:generate/);
    const scan = await post('/api/scan', { image: 'AAAA', mime: 'image/jpeg' });
    assert.match(scan.j.provider, /:generate/);
  });
});

test('fallback: top model rate-limited -> next Gemini model', async () => {
  await withServer('rl-first', {}, async () => {
    const chat = await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'Panadol price?' }] });
    assert.match(chat.j.provider, /gemini:gemini-3\.6-flash:interactions/);
  });
});

test('fallback: Gemini down -> Groq for chat and photo scan; voice fails cleanly', async () => {
  await withServer('gemini-down', {}, async () => {
    const chat = await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'Panadol price?' }] });
    assert.equal(chat.j.provider, 'groq:openai/gpt-oss-120b');
    assert.deepEqual(chat.j.trace, ['lookup_medicine']);
    const scan = await post('/api/scan', { image: 'AAAA', mime: 'image/jpeg' });
    assert.equal(scan.j.provider, 'groq:qwen/qwen3.8-27b');
    assert.equal(scan.j.medicines[0].name, 'Risek');
    assert.equal((await post('/api/tts', { text: 'salaam', lang: 'en' })).s, 502, 'client then falls back to the phone voice');
  });
});

test('no AI keys: AI endpoints say 503, emergency guard still works', async () => {
  await withServer('both', { GEMINI_API_KEY: '', GROQ_API_KEY: '' }, async () => {
    assert.deepEqual((await get('/api/config')).j.ai, false);
    assert.equal((await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'hello' }] })).s, 503);
    assert.equal((await post('/api/scan', { image: 'AAAA', mime: 'image/jpeg' })).s, 503);
    assert.equal((await post('/api/chat', { lang: 'en', messages: [{ role: 'user', text: 'chest pain' }] })).j.emergency, true);
  });
});

test('selftest is protected by ADMIN_KEY and reports each provider', async () => {
  await withServer('both', {}, async () => {
    assert.equal((await get('/api/selftest')).s, 401);
    assert.equal((await get('/api/selftest?key=wrong')).s, 401);
    const ok = await get('/api/selftest?key=k');
    assert.equal(ok.j.gemini.ok, true);
    assert.equal(ok.j.groq.ok, true);
    assert.equal(ok.j.tts.ok, true);
  });
});

test('live room: votes are counted and streamed; reset needs the key', async () => {
  await withServer('both', {}, async () => {
    await post('/api/live/vote', { type: 'mood', mood: 'great' });
    await post('/api/live/vote', { type: 'mood', mood: 'tired' });
    await post('/api/live/vote', { type: 'adopt' });
    const ctrl = new AbortController();
    const res = await fetch(BASE + '/api/live/stream', { signal: ctrl.signal });
    const chunk = new TextDecoder().decode((await res.body.getReader().read()).value);
    ctrl.abort();
    const d = JSON.parse(chunk.replace(/^data: /, '').trim());
    assert.equal(d.count, 2); assert.equal(d.adopted, 1); assert.equal(d.moods.great, 1);
    assert.equal((await post('/api/live/reset', { key: 'nope' })).s, 401);
    assert.equal((await post('/api/live/reset', { key: 'k' })).s, 200);
  });
});

test('rate limit protects the free API quota', async () => {
  await withServer('both', {}, async () => {
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await post('/api/scan', { image: 'AAAA', mime: 'image/jpeg' })).s;
    assert.equal(last, 429);
  });
});
