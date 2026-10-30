import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDSHConfig } from '../lib/dsh/client.js';
import { ModuleRuntime, executeTool, getModuleConfig } from '../lib/agent/modules.js';
import { memoryModule } from '../lib/modules/memory.js';
import { SessionRegistry } from '../lib/state/registry.js';

const turn = (overrides = {}) => ({
  channelId: 'private:one',
  userId: 'one',
  platform: 'qq',
  private: true,
  owner: false,
  userText: '记住我喜欢茶',
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal: new AbortController().signal,
  ...overrides
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-modules-'));
  // dshHomeRoot is where the local state backend keeps state.json. Without it the
  // test writes into the real deployment directory and its conversation metadata
  // shows up as live groups that keep resetting.
  const config = getDSHConfig({
    workspaceRoot: join(root, 'workspaces'),
    dshHomeRoot: join(root, 'home'),
    stateBackend: 'local'
  });

  return { root, config, modules: join(root, 'modules') };
};

test('local module reload includes dependencies and keeps the previous turn on its original revision', async () => {
  const f = await fixture();
  const runtime = new ModuleRuntime(f.config, []);
  const dir = join(f.modules, 'greeting');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'word.mjs'), "export const word = 'first';\n");
  await writeFile(
    join(dir, 'index.mjs'),
    `import { word } from './word.mjs';
    export default {id:'greeting', name:'问候', version:'1', apiVersion:1, setup(api) {
      api.on('context', () => word);
      api.on('reply', text => text + word);
      api.tool({name:'greet', description:'问候', parameters:{type:'object',properties:{}},
        execute:async () => ({word})});
    }};`
  );
  try {
    const old = await runtime.acquire();
    assert.equal(await old.context(turn()), 'first');
    await writeFile(join(dir, 'word.mjs'), "export const word = 'second';\n");
    const updated = await runtime.acquire();
    assert.equal(await updated.context(turn()), 'second');
    assert.equal(await old.context(turn()), 'first');
    assert.equal(await updated.reply('hello ', turn()), 'hello second');
    assert.deepEqual(await executeTool(updated.tools(turn())[0], {}, turn()), { word: 'second' });
    await rm(dir, { recursive: true });
    const removed = await runtime.acquire();
    assert.equal(await removed.context(turn()), '');
    assert.equal(await updated.context(turn()), 'second');
    await Promise.all([old.release(), updated.release(), removed.release()]);
    assert.deepEqual(runtime.status(), []);
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('failed and disabled replacements never silently activate the builtin; duplicate tools are rejected', async () => {
  const f = await fixture();
  const builtin = {
    id: 'sample',
    name: 'sample',
    version: '1',
    apiVersion: 1,
    setup(api) {
      api.on('context', () => 'builtin');
    }
  };
  const runtime = new ModuleRuntime(f.config, [builtin]);
  const dir = join(f.modules, 'sample');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.mjs'), 'export default broken syntax');
  try {
    const lease = await runtime.acquire();
    assert.equal(await lease.context(turn()), '');
    assert.equal(runtime.status()[0].state, 'failed');
    assert.equal(runtime.status()[0].source, 'local');
    await lease.release();
    f.config.modules = { disabled: ['sample'] };
    const disabled = await runtime.acquire();
    assert.equal(runtime.status()[0].state, 'disabled');
    assert.equal(await disabled.context(turn()), '');
    await disabled.release();
    await runtime.close();
    const def = id => ({
      id,
      name: id,
      version: '1',
      apiVersion: 1,
      setup(api) {
        api.tool({ name: 'same', description: 'x', parameters: { type: 'object' }, execute: async () => 'x' });
      }
    });
    const duplicate = new ModuleRuntime({ ...f.config, modules: { directory: join(f.root, 'empty') } }, [def('first'), def('second')]);
    const current = await duplicate.acquire();
    assert.equal(current.tools(turn()).length, 1);
    assert.equal(duplicate.status().find(s => s.id === 'second').state, 'failed');
    await current.release();
    await duplicate.close();
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('retired module cleanup runs after its last turn and release is idempotent', async () => {
  const f = await fixture();
  let disposed = 0;
  const runtime = new ModuleRuntime(f.config, [
    {
      id: 'lifecycle',
      name: 'lifecycle',
      version: '1',
      apiVersion: 1,
      setup(api) {
        api.onDispose(() => {
          disposed++;
        });
      }
    }
  ]);
  try {
    const lease = await runtime.acquire();
    await runtime.close();
    assert.equal(disposed, 0);
    await lease.release();
    assert.equal(disposed, 1);
    await lease.release();
    assert.equal(disposed, 1);
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('module loader rejects symlinks and validates configuration', async () => {
  const f = await fixture();
  assert.equal(getModuleConfig(f.config).maxToolContinuations, 2);
  const runtime = new ModuleRuntime(f.config, []);
  await mkdir(f.modules, { recursive: true });
  await symlink(f.root, join(f.modules, 'escape'));
  try {
    const lease = await runtime.acquire();
    assert.equal(runtime.status()[0].state, 'failed');
    assert.equal(lease.tools(turn()).length, 0);
    for (const modules of [
      { maxToolRounds: 0 },
      { maxToolContinuations: -1 },
      { maxToolContinuations: 5 },
      { disabled: ['../escape'] },
      { settings: { sample: null } }
    ]) {
      assert.throws(() => getModuleConfig({ ...f.config, modules }));
    }
    await lease.release();
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private memory tools require current-user intent, enforce scope and write real persisted notes', async () => {
  const f = await fixture();
  const runtime = new ModuleRuntime(f.config, [memoryModule(f.config)]);
  const registry = new SessionRegistry(f.config);
  try {
    const lease = await runtime.acquire();
    assert.deepEqual(
      lease
        .tools(turn({ private: false, channelId: 'group' }))
        .map(tool => tool.name)
        .sort(),
      [
        'inspect_memory_source',
        'inspect_memory_status',
        'inspect_shared_thread',
        'link_shared_execution',
        'recall_memories',
        'record_shared_thread',
        'trace_memory_links'
      ]
    );
    const save = lease.tools(turn()).find(t => t.name === 'remember_private_fact');
    const recall = lease.tools(turn()).find(t => t.name === 'recall_private_memory');
    assert.equal((await executeTool(save, { text: '喜欢茶' }, turn())).ok, true);
    assert.equal((await executeTool(recall, {}, turn())).notes[0].text, '喜欢茶');
    assert.equal((await executeTool(recall, {}, turn({ channelId: 'private:two' }))).notes.length, 0);
    assert.equal((await executeTool(save, { text: '不该记住' }, turn({ userText: '不要记住我说的内容' }))).ok, false);
    assert.equal((await executeTool(save, { text: '推测' }, turn({ userText: '今天聊点什么' }))).ok, false);
    await assert.rejects(executeTool(save, { text: '越权' }, turn({ private: false, channelId: 'group' })), /权限/);
    await assert.rejects(executeTool(save, { text: '鲸'.repeat(201) }, turn()), /参数/);
    assert.equal((await registry.privateMemories('private:one', conversationQueueScope(f.config, turn()))).length, 1);
    await lease.release();
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
