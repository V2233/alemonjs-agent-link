import { speechOptions } from '../lib/media/speech-config.js';
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
    await updateVoiceSettings({
      ...initial,
      localSpeech: { enabled: false, fallback: false, voice: 'Tingting' },
      voices: initial.voices.map(v => ({ ...v, enabled: false }))
    });
    const saved = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].media;
    assert.deepEqual(saved.localSpeech, { enabled: false, fallback: false, voice: 'Tingting' });
    assert.equal(saved.voices[0].enabled, false);
    assert.equal(saved.voices[0].speech.apiKey, 'voice-private-secret');
    await assert.rejects(updateVoiceSettings(initial), /配置已/);
  } finally {
    disposeAdminPanel();
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('voice preview with enabled chat budget needs no conversation and retains validation', async () => {
  const { previewVoice } = await import('../lib/panel/voice-service.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'voice-preview-'));
  const previous = globalThis.__config;
  const previousFetch = globalThis.fetch;
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        workspaceRoot: join(root, 'work'),
        budget: { enabled: true },
        media: {
          voices: [
            { id: 'remote', name: '测试', speech: { engine: 'breeze', url: 'https://example.com', apiKey: 'test', voiceId: 'one', fallback: false } },
            { id: 'disabled', name: '停用', enabled: false, speech: { engine: 'system' } }
          ]
        }
      }
    }
  };
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return new Response(mp3);
  };
  try {
    await assert.rejects(previewVoice({ id: 'remote', text: ' ' }));
    await assert.rejects(previewVoice({ id: 'remote', text: '字'.repeat(201) }));
    await assert.rejects(previewVoice({ id: 'disabled', text: '你好' }));
    assert.equal(count, 0);
    const audio = await previewVoice({ id: 'remote', text: '你好' });
    assert.equal(audio.engine, 'breeze');
    assert.deepEqual(audio.fallbackFrom, []);
    assert.equal(count, 1);
    const { assertBudgetAvailable } = await import('../lib/billing/budget.js');
    await assert.rejects(assertBudgetAvailable({ budget: { enabled: true } }), /无法确定/);
    globalThis.__config.value['alemonjs-agent-link'].aiEnabled = false;
    await assert.rejects(previewVoice({ id: 'remote', text: '你好' }), /关闭/);
    assert.equal(count, 1);
  } finally {
    globalThis.__config = previous;
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy online voice migration preserves masked credentials and all speech fields', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parse } = await import('yaml');
  const { initializeAdminPanel, disposeAdminPanel } = await import('../lib/panel/admin-panel.js');
  const { readVoiceSettings, migrateVoiceSettings } = await import('../lib/panel/voice-service.js');
  const dir = await mkdtemp(join(tmpdir(), 'voice-migration-'));
  const path = join(dir, 'config.yaml');
  const previous = globalThis.__config;
  const speech = {
    engine: 'breeze',
    url: 'https://example.com',
    apiKey: 'test-secret-migrate',
    voiceId: 'one',
    language: 'zh',
    instruction: '轻快',
    fallback: true
  };
  try {
    await writeFile(path, JSON.stringify({ 'alemonjs-agent-link': { media: { speech } } }));
    globalThis.__config = { path, value: { 'alemonjs-agent-link': {} }, reload() {} };
    await initializeAdminPanel();
    const initial = await readVoiceSettings();
    assert.equal(initial.legacyAvailable, true);
    const result = await migrateVoiceSettings({ revision: initial.revision });
    assert.equal(result.data.legacyAvailable, false);
    assert.equal(JSON.stringify(result).includes(speech.apiKey), false);
    const media = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].media;
    assert.deepEqual(media.voices[0].speech, speech);
    assert.equal(media.activeVoice, media.voices[0].id);
    assert.deepEqual(media.speech, speech);
    await assert.rejects(migrateVoiceSettings({ revision: initial.revision }), /配置已/);
    await assert.rejects(migrateVoiceSettings({ revision: result.data.revision }), /尚未使用/);
  } finally {
    disposeAdminPanel();
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('changed speech can append Edge beside migrated Breeze and select it without losing either', async () => {
  const { migrateLegacyVoice, legacyVoiceAvailable } = await import('../lib/media/voice-migration.js');
  const breeze = {
    id: 'legacy-voice',
    name: 'Breeze',
    enabled: true,
    speech: { engine: 'breeze', url: 'https://example.com', apiKey: 'test', voiceId: 'one' }
  };
  const speech = { engine: 'edge', fallback: true, edgeVoice: 'zh-TW-HsiaoChenNeural' };
  const media = { voices: [breeze], activeVoice: breeze.id, speech };
  assert.equal(legacyVoiceAvailable(media), true);
  const next = migrateLegacyVoice(media);
  assert.equal(next.voices.length, 2);
  assert.deepEqual(next.voices[0], breeze);
  assert.deepEqual(selectVoice(next).speech, speechOptions(speech));
  assert.equal(legacyVoiceAvailable(next), false);
  assert.equal(media.activeVoice, 'legacy-voice');
});
