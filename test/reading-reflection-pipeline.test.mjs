import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleRuntime, executeTool } from '../lib/agent/modules.js';
import { biliModule } from '../lib/modules/bili.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMemoryStore } from '../lib/memory/store.js';
import { readingContinuity } from '../lib/bili/diary.js';

test('independent reading persists structured questions with actual source links and sends no message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-reflection-'));
  const app = createTestApp({
    config: {
      'alemonjs-agent-link': {
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        stateBackend: 'local',
        runtimeMode: 'chat-only',
        modules: { settings: { bili: { allowProactiveBrowse: true } } }
      }
    }
  });
  const oldFetch = globalThis.fetch;
  const bv = 'BV1234567890';
  globalThis.fetch = async url => {
    const address = String(url);
    if (address.endsWith('/nav'))
      return Response.json({
        data: { wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } }
      });
    if (address.includes('/wbi/view')) return Response.json({ code: 0, data: { bvid: bv, aid: 123, cid: 456, title: '鲸鱼交流', desc: '简介' } });
    if (address.includes('/player/')) return Response.json({ code: 0, data: { subtitle: { subtitles: [] } } });
    if (address.includes('/reply/')) return Response.json({ code: 0, data: { replies: [] } });
    throw new Error('unexpected request');
  };
  try {
    const result = await app.invoke(
      app.events.privateMessage(),
      async () => {
        const config = getDSHConfig();
        const runtime = new ModuleRuntime(config, [biliModule(config)]);
        const lease = await runtime.acquire();
        const context = {
          platform: 'onebot',
          channelId: 'private:owner',
          userId: 'owner',
          botId: 'fish',
          private: true,
          owner: true,
          autonomous: true,
          independentReading: true,
          requestId: 'reading',
          inputId: 'reading',
          userText: '',
          signal: new AbortController().signal,
          capabilities: { chat: true, web: false, files: false, terminal: false }
        };
        const store = getMemoryStore(config);
        try {
          const tool = lease.tools(context).find(item => item.name === 'bili_watch');
          assert.ok(tool);
          const read = await executeTool(tool, { link: bv }, context);
          assert.equal(read.ok, true);
          const reflection = { learned: '目前只有简介', changed: '', unresolved: '鲸鱼如何交流？' };
          await lease.activity('', JSON.stringify(reflection), context);
          const rows = store.list(context, { subjectId: 'fish' });
          const note = rows.find(item => item.origin === 'diary');
          assert.ok(note);
          assert.ok(note.tags.some(tag => tag.startsWith('reading:')));
          const recalled = readingContinuity(rows, '鲸鱼');
          assert.deepEqual(recalled[0].reflection, reflection);
          assert.equal(recalled[0].sourceEvidence[0].contentBasis, 'metadata');
        } finally {
          await lease.release();
          await runtime.close();
          store.close();
        }
      },
      'alemonjs-agent-link'
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.actions, []);
  } finally {
    globalThis.fetch = oldFetch;
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
