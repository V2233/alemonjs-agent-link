import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMemoryStore } from '../lib/memory/store.js';
import { getChatArchive } from '../lib/history/store.js';
import { MemoryConsolidator } from '../lib/memory/consolidation.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runCoordinatedChat } from '../lib/dsh/orchestrator.js';

const scope = { platform: 'qq', channelId: 'group' };
const plan = source => ({
  action: 'add',
  text: source.text,
  kind: 'fact',
  sourceSeqs: [source.seq],
  evidence: source.text,
  tags: [],
  confidence: 0.9,
  importance: 0.5
});
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'memory-pipeline-'));
  const oldConfig = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'workspaces'),
        dshHomeRoot: join(root, 'homes'),
        modules: { settings: { memory: { automatic: false } } }
      }
    }
  };
  const config = getDSHConfig();
  const store = getMemoryStore(config);
  const archive = getChatArchive(config);
  try {
    await run({ root, config, store, archive });
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
};

test('actual model transport receives scoped sources without tools and its validated result is persisted', () =>
  fixture(async f => {
    f.archive.append(scope, { id: 'one', text: '我喜欢杭州茶馆', speakerId: 'one', speaker: '甲', role: 'user' });
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.length, 2);
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.sources.length, 1);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ changes: [plan(input.sources[0])] }) } }] });
    };
    const worker = new MemoryConsolidator(f.config);
    try {
      assert.equal((await worker.consolidate(scope, true)).added, 1);
      assert.equal(calls, 1);
      assert.equal(f.store.recall(scope, '杭州茶馆', 'one')[0].sourceRefs[0].text, '我喜欢杭州茶馆');
    } finally {
      worker.stop();
    }
  }));

test('periodic consolidation respects its interval and automatic-off leaves new archive data unprocessed', () =>
  fixture(async f => {
    f.archive.append(scope, { id: 'one', text: '我喜欢杭州茶馆', speakerId: 'one', speaker: '甲', role: 'user' });
    f.store.observe(scope);
    let calls = 0;
    const ask = async sources => {
      calls++;
      return [plan(sources[0])];
    };
    const disabled = new MemoryConsolidator(f.config, { ask });
    await disabled.tick();
    assert.equal(calls, 0);
    disabled.stop();
    const automatic = new MemoryConsolidator({ ...f.config, modules: { settings: { memory: { automatic: true } } } }, { ask });
    try {
      await automatic.tick();
      assert.equal(calls, 1);
      await automatic.tick();
      assert.equal(calls, 1);
    } finally {
      automatic.stop();
    }
  }));

test('learned facts enter a real group turn with person attribution and cannot leak a private scope', () =>
  fixture(async f => {
    const add = (target, seq, text) => {
      f.store.observe(target);
      f.store.applyExtraction(
        target,
        f.store.state(target),
        [plan({ seq, text })],
        [{ seq, text, speakerId: 'one', speaker: '甲', timestamp: Date.now() }],
        seq,
        false
      );
    };
    add(scope, 1, '我喜欢杭州茶馆');
    add({ platform: 'qq', channelId: 'private:secret' }, 2, '仅私聊可见的秘密偏好');
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls++;
      const content = JSON.stringify(body.messages);
      assert.ok(content.includes('杭州茶馆'));
      assert.ok(!content.includes('秘密偏好'));
      if (calls === 1) {
        assert.ok(content.includes('currentPerson'));
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'recall',
                    type: 'function',
                    function: { name: 'recall_memories', arguments: '{"query":"杭州茶馆"}' }
                  }
                ]
              }
            }
          ]
        });
      }
      const result = JSON.parse(body.messages.at(-1).content);
      assert.equal(result.items[0].about.id, 'one');
      assert.equal(result.items[0].sources[0].seq, 1);
      return Response.json({ choices: [{ message: { content: '你提到喜欢杭州茶馆。' } }] });
    };
    const output = [];
    const result = await runCoordinatedChat(
      { ChannelId: 'group', Platform: 'qq', UserId: 'one', UserKey: 'one', MessageId: 'ask' },
      '你记得我喜欢的茶馆吗',
      async event => {
        if (event.type === 'content') output.push(event.content);
      },
      undefined,
      undefined,
      undefined,
      async () => {}
    );
    await result.confirmDelivery();
    assert.deepEqual(output, ['你提到喜欢杭州茶馆。']);
    assert.equal(calls, 2);
  }));
