import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceLibrary, selectVoice } from '../lib/media/voice-library.js';
import { readBounded, MediaHttpError } from '../lib/media/providers.js';

test('voice selection preserves provider credentials and overrides voice', () => {
  const voices = voiceLibrary([
    { id: 'local', name: '本机', speech: { engine: 'system' } },
    { id: 'remote', name: '远程', speech: { engine: 'openai' }, ttsVoice: 'custom' }
  ]);
  const config = { voices, activeVoice: 'remote', tts: { baseUrl: 'https://example.com', apiKey: 'test', model: 'tts', voice: 'old' } };
  assert.equal(selectVoice(config).tts.voice, 'custom');
  assert.equal(selectVoice(config).tts.apiKey, 'test');
  assert.equal(config.tts.voice, 'old');
  assert.equal(selectVoice({ ...config, activeVoice: 'local' }).speech.engine, 'system');
  assert.throws(() => selectVoice({ ...config, activeVoice: 'missing' }));
  assert.throws(() => voiceLibrary([voices[0], voices[0]]));
});

test('HTTP status remains structured for quota fallback', async () => {
  await assert.rejects(readBounded(new Response('', { status: 402 }), 100), error => error instanceof MediaHttpError && error.status === 402);
});

import { fetchVoiceBalance, voiceBalanceExhausted } from '../lib/media/voice-status.js';
test('voice diagnostics preserve currency, cache by account and distinguish unknown from exhaustion', async t => {
  const voices = voiceLibrary([
    { id: 'paid', name: '付费', enabled: false, speech: { engine: 'openai' }, balanceUrl: 'https://example.com/balance?key={key}' }
  ]);
  const config = { voices, activeVoice: 'paid', tts: { baseUrl: 'https://example.com', apiKey: 'private-key' } };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.match(String(url), /key=private-key/);
    return new Response(JSON.stringify({ data: { balance: 0, currency: 'USD' } }));
  });
  const result = await fetchVoiceBalance(config, voices[0]);
  assert.equal(result.currency, 'USD');
  assert.equal(result.status, 'exhausted');
  assert.equal(voiceBalanceExhausted(config), true);
  await fetchVoiceBalance(config, voices[0]);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
  assert.equal(selectVoice(config).speech.engine, 'system');
  const unknown = await fetchVoiceBalance({ ...config, tts: { ...config.tts, apiKey: 'other' } }, { ...voices[0], balanceUrl: undefined });
  assert.equal(unknown.status, 'unsupported');
  assert.equal(unknown.amount, undefined);
});

test('unsafe diagnostics URLs rejected even for disabled voices', () => {
  for (const url of ['http://example.com/{key}', 'https://user:pass@example.com/{key}', 'https://example.com/no-placeholder']) {
    assert.throws(() => voiceLibrary([{ id: 'x', name: 'x', enabled: false, speech: { engine: 'system' }, balanceUrl: url }]));
  }
  assert.throws(() => voiceLibrary([{ id: 'x', name: 'x', speech: { engine: 'system' }, probeUrl: 'http://localhost/test' }]));
});

test('voice settings persist disable/default and retain masked credentials with revision protection', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parse } = await import('yaml');
  const { initializeAdminPanel, disposeAdminPanel } = await import('../lib/panel/admin-panel.js');
  const { readVoiceSettings, updateVoiceSettings } = await import('../lib/panel/voice-service.js');
  const dir = await mkdtemp(join(tmpdir(), 'voice-settings-'));
  const path = join(dir, 'config.yaml');
  const previous = globalThis.__config;
  try {
    await writeFile(
      path,
      JSON.stringify({
        'alemonjs-agent-link': {
          media: {
            voices: [{ id: 'paid', name: '付费', speech: { engine: 'breeze', url: 'https://example.com', apiKey: 'voice-private-secret', voiceId: 'one' } }],
            activeVoice: 'paid'
          }
        }
      })
    );
    globalThis.__config = { path, value: { 'alemonjs-agent-link': {} }, reload() {} };
    await initializeAdminPanel();
    const initial = await readVoiceSettings();
    assert.equal(JSON.stringify(initial).includes('voice-private-secret'), false);
    await updateVoiceSettings({ ...initial, voices: initial.voices.map(v => ({ ...v, enabled: false })) });
    const saved = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].media;
    assert.equal(saved.voices[0].enabled, false);
    assert.equal(saved.voices[0].speech.apiKey, 'voice-private-secret');
    await assert.rejects(updateVoiceSettings(initial), /配置已/);
  } finally {
    disposeAdminPanel();
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
