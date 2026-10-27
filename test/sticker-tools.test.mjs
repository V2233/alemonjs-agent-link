import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stickerModule } from '../lib/modules/stickers.js';
import { executeTool } from '../lib/agent/modules.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';

test('sticker tools search without exposing paths and report actual delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-tools-'));
  const previous = globalThis.__config;
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { stickerRoot: root } } } };
  const tools = [];
  stickerModule().setup({ tool: item => tools.push(item) });
  let sent = 0;
  const context = {
    channelId: 'private:test', userId: '1', platform: 'onebot', private: true, owner: false,
    userText: '发个开心表情', capabilities: { chat: true, web: false, files: false, terminal: false },
    signal: new AbortController().signal,
    onSticker: async (item, image) => { sent++; assert.equal(item.id, 'happy'); assert.deepEqual(image, data); }
  };
  try {
    await mkdir(join(root, 'images'));
    await writeFile(join(root, 'images', 'happy.png'), data);
    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ id: 'happy', file: 'images/happy.png', tags: ['开心', '笑'] }]));
    const list = tools.find(item => item.name === 'list_stickers');
    const send = tools.find(item => item.name === 'send_sticker');
    assert.deepEqual(await executeTool(list, { query: '开' }, context), { ok: true, count: 1, items: [{ id: 'happy', tags: ['开心', '笑'] }] });
    assert.deepEqual(await executeTool(send, { query: '开心' }, context), { ok: true, id: 'happy', message: '平台已接受表情发送。' });
    assert.equal(sent, 1);
    assert.equal((await executeTool(send, { query: '开' }, context)).ok, false);
    assert.equal(sent, 1);
    assert.equal(send.available({ ...context, autonomous: true }), false);
    assert.equal(send.available({ ...context, onSticker: undefined }), false);
    const failed = await executeTool(send, { query: 'happy' }, { ...context, onSticker: async () => { throw new Error('transport failure'); } });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /未获成功回执/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(send.execute({ query: 'happy' }, { ...context, signal: abort.signal }));
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('model turn receives the real sticker delivery result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-turn-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  globalThis.__config = { value: { 'alemonjs-agent-link': {
    apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local',
    workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), media: { stickerRoot: root }
  } } };
  const config = getDSHConfig();
  let calls = 0;
  let delivered = 0;
  let output = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    assert.ok(body.tools.some(tool => tool.function.name === 'send_sticker'));
    if (calls === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 's1', type: 'function', function: { name: 'send_sticker', arguments: '{"query":"开心"}' } }
    ] } }] });
    const result = body.messages.find(message => message.role === 'tool');
    assert.equal(JSON.parse(result.content).ok, true);
    assert.equal(delivered, 1);
    return Response.json({ choices: [{ message: { content: '收到。' } }] });
  };
  try {
    await writeFile(join(root, 'happy.png'), image);
    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ id: 'happy', file: 'happy.png', tags: ['开心'] }]));
    await runModuleTurn({
      config, sessionId: 'test', input: '发个开心表情',
      context: { channelId: 'private:test', userId: '1', platform: 'onebot', private: true, owner: false,
        userText: '发个开心表情', capabilities: { chat: true, web: false, files: false, terminal: false }, signal: new AbortController().signal },
      onSticker: async (_item, data) => { assert.deepEqual(data, image); delivered++; },
      onEvent: async event => { if (event.type === 'content') output += event.content; }
    });
    assert.equal(calls, 2);
    assert.equal(output, '收到。');
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
