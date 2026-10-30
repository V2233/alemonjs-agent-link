import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readIntelligenceLevel } from '../lib/agent/intelligence.js';
import handler from '../lib/response/agent-intelligence/res.js';

test('permissions query cannot change intelligence; settings command still can', async () => {
  const root = await mkdtemp(join(tmpdir(), 'command-rights-'));
  const config = { workspaceRoot: join(root, 'workspaces'), stateBackend: 'local' };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const identity = { platform: 'qq-bot', channelId: 'private:["qq-bot","100"]', userId: '100', owner: true, private: true };
  const run = (key, args) =>
    app.runHandler(
      handler,
      app.events.privateMessage(
        {},
        {
          Platform: 'qq-bot',
          UserId: '100',
          IsMaster: true,
          MessageText: `/${key} ${args.join(' ')}`,
          __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
        }
      ),
      'alemonjs-agent-link'
    );
  try {
    await run('智能程度', ['轻快']);
    assert.equal(readIntelligenceLevel(config, identity, true), '轻快');
    await run('我的权限', ['专研']);
    assert.equal(readIntelligenceLevel(config, identity, true), '轻快');
    await run('智能程度', ['专研']);
    assert.equal(readIntelligenceLevel(config, identity, true), '专研');
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy persona entries deny group administrators without key entitlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-rights-'));
  const config = { workspaceRoot: join(root, 'workspaces'), dshHomeRoot: join(root, 'homes'), stateBackend: 'local' };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const { getPersonaStore } = await import('../lib/companion/personas.js');
  const { getDSHConfig } = await import('../lib/dsh/runtime-config.js');
  try {
    for (const [name, key, args] of [
      ['agent-persona', '人格', ['使用', 'assistant']],
      ['agent-group-settings', '群设置', ['人设', '测试内容']]
    ]) {
      const handler = (await import(`../lib/response/${name}/res.js`)).default;
      const event = app.events.groupMessage(
        {},
        {
          Platform: 'qq-bot',
          ChannelId: 'g1',
          UserId: '100',
          IsMaster: false,
          IsAdmin: true,
          Role: 'admin',
          MessageText: `/${key} ${args.join(' ')}`,
          __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
        }
      );
      const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
      assert.equal(result.errors.length, 0);
      assert.match(JSON.stringify(result.messages), /Key/);
      await app.invoke(
        event,
        () => {
          const store = getPersonaStore(getDSHConfig());
          const scope = { platform: 'qq-bot', channelId: 'g1' };
          assert.ok(!store.selected(scope));
          assert.ok(!store.scopeAdditions(scope));
        },
        'alemonjs-agent-link'
      );
    }
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
