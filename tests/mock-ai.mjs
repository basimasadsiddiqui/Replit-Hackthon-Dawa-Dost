// Mock of Gemini (Interactions + legacy generateContent) and Groq, to test routing/fallback logic.
// MOCK_MODE: both | no-interactions | rl-first (429 on gemini-3.8-flash) | gemini-down
import http from 'node:http';
const MODE = process.env.MOCK_MODE || 'both';
const seen = [];
const interactions = new Map();
http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const j = b ? JSON.parse(b) : {}; const url = req.url;
    const send = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    seen.push(url + ' ' + (j.model || ''));
    if (url === '/__seen') return send(seen);
    // ---------- Groq ----------
    if (url.startsWith('/openai/v1/chat/completions')) {
      const msgs = j.messages; const nTool = msgs.filter(m => m.role === 'tool').length;
      if (j.model === 'qwen/qwen3.8-27b') return send({ choices: [{ message: { role: 'assistant', content: '{"legible":true,"medicines":[{"name":"Risek","salt":"Omeprazole","strength":"20 mg","frequency":"BD","days":14,"timing":"before food","confidence":"high"}]}' } }] });
      if (nTool === 0 && j.tools) return send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup_medicine', arguments: '{"query":"Panadol"}' } }] } }] });
      return send({ choices: [{ message: { role: 'assistant', content: 'groq says: Panadol about Rs 38' } }] });
    }
    if (MODE === 'gemini-down') return send({ error: { message: 'down' } }, 503);
    if (j.model === 'gemini-3.8-flash' && MODE === 'rl-first') return send({ error: { message: 'quota' } }, 429);
    // ---------- Gemini Interactions ----------
    if (url.startsWith('/v1beta/interactions')) {
      if (MODE === 'no-interactions') return send({ error: { message: 'bad request' } }, 400);
      if (req.headers['api-revision'] !== '2026-05-20') return send({ error: 'missing revision' }, 400);
      if (/tts/.test(j.model)) {
        const pcm = Buffer.alloc(4800); const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + 4800, 4);
        return send({ id: 'tts1', steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.concat([h, pcm]).toString('base64'), mime_type: 'audio/wav' }] }] });
      }
      const prev = j.previous_interaction_id; const n = prev ? (interactions.get(prev) || 0) : 0; const id = 'i' + Math.random().toString(36).slice(2);
      interactions.set(id, n + 1);
      if (!j.tools) return send({ id, steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"legible":true,"note":"","medicines":[{"name":"Panadol","salt":"Paracetamol","strength":"500 mg","frequency":"1+0+1","days":5,"timing":"after food","confidence":"high"}]}' }] }] });
      if (n === 0) return send({ id, steps: [{ type: 'thought', signature: 'x' }, { type: 'function_call', id: 'fc1', name: 'lookup_medicine', arguments: { query: 'Panadol' } }] });
      if (n === 1) { if (!Array.isArray(j.input) || j.input[0].type !== 'function_result' || j.input[0].call_id !== 'fc1') return send({ error: 'bad function_result' }, 400);
        return send({ id, steps: [{ type: 'function_call', id: 'fc2', name: 'check_interactions', arguments: { medicines: ['Panadol', 'Panadol Extra'] } }] }); }
      const plan = JSON.stringify(j.system_instruction).includes('Pharmacist agent');
      return send({ id, steps: [{ type: 'model_output', content: [{ type: 'text', text: plan ? '{"summary":"s","items":[{"name":"Panadol","explanation":"e","tip":"t"}],"watch_out":["w"],"ask_doctor":["q"],"savings_pkr":9}' : 'interactions says: Panadol about Rs 38' }] }] });
    }
    // ---------- Gemini legacy generateContent ----------
    if (url.includes(':generateContent')) {
      if (/tts/.test(url)) return send({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4800).toString('base64') } }] } }] });
      const nResp = j.contents.filter(c => c.parts.some(p => p.functionResponse)).length;
      if (!j.tools) return send({ candidates: [{ content: { role: 'model', parts: [{ text: '{"legible":true,"medicines":[{"name":"Panadol"}]}' }] } }] });
      if (nResp === 0) return send({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'lookup_medicine', args: { query: 'Panadol' } } }] } }] });
      return send({ candidates: [{ content: { role: 'model', parts: [{ text: 'legacy says: Panadol about Rs 38' }] } }] });
    }
    send({ error: 'unknown ' + url }, 404);
  });
}).listen(4010, () => console.log('mock up', MODE));
