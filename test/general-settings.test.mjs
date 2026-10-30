import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneralSettings, projectGeneralSettings, readGeneralSettings, saveGeneralSettings } from '../lib/panel/general-settings.js';
test('settings expose only understandable fields with real defaults', () => {
  const data = projectGeneralSettings({
    revision: 'r',
    source: JSON.stringify({ 'alemonjs-agent-link': { apiKey: 'secret', privateAutoReply: false, groupWakeNames: [] } })
  });
  assert.equal(data.values.privateAutoReply, false);
  assert.deepEqual(data.values.groupWakeNames, []);
  assert.equal(data.values.privateChatAccess, 'all');
  assert.equal(JSON.stringify(data).includes('secret'), false);
});
test('settings reject unrelated fields and invalid values', () => {
  for (const input of [
    { apiKey: 'x' },
    { transport: 'other' },
    { persona: 'other' },
    { aiEnabled: 'false' },
    { privateChatAccess: 'other' },
    { maxMessageLength: 0 },
    { bubbleDelayMs: 5001 },
    { privateHistoryMaxTurns: 1.5 },
    { groupWakeNames: ['/x'] }
  ])
    assert.throws(() => validateGeneralSettings(input));
  assert.deepEqual(validateGeneralSettings({ groupWakeNames: [], privateAutoReply: false }), { groupWakeNames: [], privateAutoReply: false });
});
test('settings save preserves secrets and unrelated configuration, rejects stale revision', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parse } = await import('yaml');
  const { initializeAdminPanel, disposeAdminPanel } = await import('../lib/panel/admin-panel.js');
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  const path = join(dir, 'config.yaml');
  const previous = globalThis.__config;
  try {
    await writeFile(path, JSON.stringify({ 'alemonjs-agent-link': { apiKey: 'private-test-secret', model: 'preserved', aiEnabled: false } }));
    globalThis.__config = { path, value: { 'alemonjs-agent-link': {} }, reload() {} };
    await initializeAdminPanel();
    const before = await readGeneralSettings();
    await saveGeneralSettings({ revision: before.revision, values: { aiEnabled: true, groupWakeNames: ['小鱼'] } });
    const saved = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'];
    assert.equal(saved.apiKey, 'private-test-secret');
    assert.equal(saved.model, 'preserved');
    assert.ok(saved.aiNoticeEpoch);
    assert.deepEqual(saved.groupWakeNames, ['小鱼']);
    await assert.rejects(saveGeneralSettings({ revision: before.revision, values: { aiEnabled: false } }), /配置已/);
  } finally {
    disposeAdminPanel();
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
