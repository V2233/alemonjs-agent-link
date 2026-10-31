import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getMediaConfig } from '../lib/media/config.js';
import { renderSpeech, pcmWave } from '../lib/media/speech.js';
const voice = (id, enabled = true, fallback = true) => ({ id, name: id, enabled, speech: { engine: 'fish', url: 'https://api.fish.audio', apiKey: 'test', model: 's2.1-pro-free', voiceId: id, fallback } });

test('rotation uses stored order, skips disabled, ignores legacy active choice, and stops after success', async () => {
  const original = globalThis.fetch, previous = globalThis.__config;
  const root = await mkdtemp(join(tmpdir(), 'voice-order-'));
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  const calls = [];
  try {
    globalThis.fetch = async (_, init) => {
      const id = JSON.parse(init.body).reference_id;
      calls.push(id);
      return id === 'first' ? new Response('', { status: 503 }) : new Response(Buffer.from('ID3ok'), { headers: { 'content-type': 'audio/mpeg' } });
    };
    const config = getMediaConfig({ media: { voiceRotation: true, activeVoice: 'third', voices: [voice('first'), voice('disabled', false), voice('second'), voice('third')] } });
    const result = await renderSpeech('你好', config, AbortSignal.timeout(5000), { workspaceRoot: join(root, 'work') });
    assert.deepEqual(calls, ['first', 'second']);
    assert.deepEqual(result.fallbackFrom, ['first']);
    calls.length = 0;
    const reordered = { ...config, voices: [voice('third'), ...config.voices.filter(v => v.id !== 'third')] };
    await renderSpeech('你好', reordered, AbortSignal.timeout(5000), { workspaceRoot: join(root, 'work') });
    assert.deepEqual(calls, ['third']);
    calls.length = 0;
    await assert.rejects(renderSpeech('你好', { ...config, voices: [voice('first', true, false), voice('second')] }, AbortSignal.timeout(5000), { workspaceRoot: join(root, 'work') }), /停止轮转/);
    assert.deepEqual(calls, ['first']);
    calls.length = 0;
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(renderSpeech('你好', config, cancelled.signal, { workspaceRoot: join(root, 'work') }));
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = original; globalThis.__config = previous; await rm(root, { recursive: true, force: true }); }
});

test('rotation only falls back to local after all candidates fail and respects local fallback switch', async () => {
  const original = globalThis.fetch, previous = globalThis.__config;
  const root = await mkdtemp(join(tmpdir(), 'voice-final-'));
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  let localCalls = 0;
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    const config = getMediaConfig({ media: { voiceRotation: true, voices: [voice('one'), voice('two')] } });
    const services = { system: async (_, path) => { localCalls++; await writeFile(path, pcmWave(Buffer.alloc(200), 22050)); } };
    const result = await renderSpeech('你好', config, AbortSignal.timeout(5000), { workspaceRoot: join(root, 'work') }, services);
    assert.equal(result.engine, 'system');
    assert.deepEqual(result.fallbackFrom, ['one', 'two']);
    assert.equal(localCalls, 1);
    await assert.rejects(renderSpeech('你好', { ...config, localSpeech: { enabled: true, fallback: false } }, AbortSignal.timeout(5000), { workspaceRoot: join(root, 'work') }, services), /轮转已用尽/);
    assert.equal(localCalls, 1);
  } finally { globalThis.fetch = original; globalThis.__config = previous; await rm(root, { recursive: true, force: true }); }
});
