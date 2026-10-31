import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, symlinkSync, linkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceOperation, purgeWorkspaceHash } from '../lib/files/workspace.js';
import { filesModule } from '../lib/modules/files.js';
import { ModuleRuntime, executeTool } from '../lib/agent/modules.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { SessionRegistry, defaultGroupPolicy, ownerPrivatePolicy } from '../lib/state/registry.js';
import { getLocalStore } from '../lib/state/local-store.js';

const context = (extra = {}) => ({
  platform: 'qq',
  botId: 'bot',
  channelId: 'group',
  userId: 'one',
  private: false,
  owner: false,
  capabilities: { chat: true, web: true, files: true, terminal: false },
  signal: new AbortController().signal,
  userText: '保存群清单',
  ...extra
});
const fixture = t => {
  const base = mkdtempSync(join(tmpdir(), 'agent-files-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, run: (action, args, ctx = context()) => workspaceOperation(base, ctx, action, args) };
};
const assigned = base => {
  const parent = join(base, 'scoped-files', 'groups');
  const bucket = join(parent, readdirSync(parent)[0]);
  return join(bucket, readdirSync(bucket)[0]);
};

test('group files are shared, persistent, and isolated from other groups, users, platforms and bots', t => {
  const { base, run } = fixture(t);
  run('mkdir', { path: 'notes' });
  run('write', { path: 'notes/公告.txt', content: '周六活动' });
  assert.equal(run('read', { path: 'notes/公告.txt' }, context({ userId: 'two' })).content, '周六活动');
  for (const extra of [{ channelId: 'other' }, { platform: 'onebot' }, { botId: 'other' }, { private: true }]) {
    assert.throws(() => run('read', { path: 'notes/公告.txt' }, context(extra)));
  }
  run('write', { path: 'private.txt', content: '个人' }, context({ private: true }));
  assert.throws(() => run('read', { path: 'private.txt' }, context({ private: true, userId: 'two' })));
  assert.equal(workspaceOperation(base, context(), 'read', { path: 'notes/公告.txt' }).content, '周六活动');
  assert.throws(() => run('write', { path: 'notes/公告.txt', content: '覆盖' }));
  run('write', { path: 'notes/公告.txt', content: '周日', overwrite: true });
  run('move', { path: 'notes/公告.txt', destination: 'notes/新公告.txt' });
  assert.equal(run('read', { path: 'notes/新公告.txt' }).content, '周日');
  assert.throws(() => run('delete', { path: 'notes' }));
  run('delete', { path: 'notes/新公告.txt' });
  run('delete', { path: 'notes' });
});

test('absolute paths, traversal, symlinks, hardlinks and root deletion are rejected', t => {
  const { base, run } = fixture(t);
  const outside = join(base, 'secret.txt');
  writeFileSync(outside, 'secret');
  run('write', { path: 'ok.txt', content: 'ok' });
  for (const path of ['/etc/passwd', '../secret.txt', 'a/../../x', 'a/../x', 'a\\..\\x', 'C:\\secret', '', 'a//x', 'x\0y']) {
    for (const action of ['read', 'write', 'mkdir', 'delete', 'list']) assert.throws(() => run(action, { path, content: 'bad' }), `${action}: ${path}`);
    assert.throws(() => run('move', { path: 'ok.txt', destination: path }));
  }
  const root = assigned(base);
  symlinkSync(outside, join(root, 'link'));
  symlinkSync(base, join(root, 'directory-link'));
  linkSync(outside, join(root, 'hardlink'));
  for (const path of ['link', 'directory-link/secret.txt', 'hardlink']) {
    for (const action of ['read', 'write', 'delete']) assert.throws(() => run(action, { path, content: 'bad', overwrite: true }));
  }
  assert.throws(() => run('delete', { path: '.' }));
  assert.throws(() => run('move', { path: 'ok.txt', destination: 'directory-link/stolen' }));
  assert.equal(readFileSync(outside, 'utf8'), 'secret');
  assert.throws(() => run('read', { path: 'ok.txt' }, context({ capabilities: { files: false } })));
  assert.throws(() => run('read', { path: 'ok.txt' }, context({ autonomous: true })));
  assert.throws(() => run('read', { path: 'ok.txt' }, context({ platform: '' })));
  assert.throws(() => run('read', { path: 'ok.txt' }, context({ signal: AbortSignal.abort() })));
});

test('quotas and depth bounds apply to writes and directory operations', t => {
  const { run } = fixture(t);
  assert.throws(() => run('write', { path: 'large', content: 'x'.repeat(262145) }));
  for (let i = 0; i < 40; i++) run('write', { path: `f${i}`, content: 'x'.repeat(262144) });
  assert.throws(() => run('write', { path: 'overflow', content: 'x' }));
  run('write', { path: 'f0', content: 'small', overwrite: true });
  run('write', { path: 'room', content: 'x' });
  assert.throws(() => run('mkdir', { path: Array(17).fill('a').join('/') }));
});

test('trusted purge removes only the selected conversation and rejects invalid hashes', t => {
  const { base, run } = fixture(t);
  run('write', { path: 'group.txt', content: 'one' });
  run('write', { path: 'group.txt', content: 'two' }, context({ channelId: 'other' }));
  assert.throws(() => purgeWorkspaceHash(base, '../'));
  purgeWorkspaceHash(base, createHash('sha256').update('group').digest('hex'));
  assert.deepEqual(run('list', { path: '.' }).entries, []);
  assert.equal(run('read', { path: 'group.txt' }, context({ channelId: 'other' })).content, 'two');
});

test('module exposes scoped tools without Python and rechecks permissions at execution', async t => {
  const { base } = fixture(t);
  const config = getDSHConfig({ workspaceRoot: base, dshHomeRoot: join(base, 'homes') });
  const runtime = new ModuleRuntime(config, [filesModule(config)]);
  t.after(() => runtime.close());
  const lease = await runtime.acquire();
  t.after(() => lease.release());
  const tools = lease.tools(context());
  assert.equal(tools.length, 6);
  assert.match(await lease.context(context()), /本群共享/);
  const write = tools.find(tool => tool.name === 'workspace_write');
  await executeTool(write, { path: 'memo.txt', content: '清单' }, context());
  const read = tools.find(tool => tool.name === 'workspace_read');
  assert.equal((await executeTool(read, { path: 'memo.txt' }, context())).content, '清单');
  assert.equal(lease.tools(context({ capabilities: { files: false } })).length, 0);
  assert.equal(lease.tools(context({ autonomous: true })).length, 0);
  await assert.rejects(executeTool(write, { path: 'memo.txt', content: '越权' }, context({ capabilities: { files: false } })));
  await assert.rejects(executeTool(write, { path: 'memo.txt', content: '越权', root: '/' }, context()));
});

test('legacy policies enable scoped files, disable terminal, and preserve subsequent explicit file revocation', async t => {
  const { base } = fixture(t);
  const config = getDSHConfig({ workspaceRoot: base, dshHomeRoot: join(base, 'homes'), stateBackend: 'local' });
  const registry = new SessionRegistry(config);
  assert.equal(defaultGroupPolicy.files, true);
  assert.equal(ownerPrivatePolicy.terminal, false);
  const hash = createHash('sha256').update('legacy').digest('hex');
  const store = await getLocalStore(join(base, 'state.json'));
  await store.set(
    `data:agent-link:group:${hash}:meta.v1.json`,
    JSON.stringify({ generation: 1, isolated: true, policy: { version: 1, chat: true, web: false, files: false, terminal: true } })
  );
  assert.deepEqual(await registry.policy('legacy'), { version: 2, chat: true, web: false, files: true, terminal: false });
  await registry.setPolicy('legacy', { version: 2, chat: true, web: false, files: false, terminal: true });
  await registry.beginReset('legacy');
  assert.deepEqual(await registry.policy('legacy'), { version: 2, chat: true, web: false, files: false, terminal: false });
});

test('chat-only model tool loop saves and reads a real group file without sandbox or terminal', async t => {
  const { base } = fixture(t);
  const { runModuleTurn } = await import('../lib/agent/turn.js');
  const { getModuleRuntime } = await import('../lib/agent/modules.js');
  const oldConfig = globalThis.__config,
    oldFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: base,
        dshHomeRoot: join(base, 'homes'),
        modules: { disabled: ['proactive'], settings: { memory: { automatic: false } } }
      }
    }
  };
  const config = getDSHConfig();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(tool => tool.function.name === 'workspace_write'));
    assert.ok(!body.tools.some(tool => tool.function.name === 'agent_workspace'));
    calls++;
    if (calls === 2) assert.equal(JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content).ok, true);
    if (calls === 3) assert.equal(JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content).content, '周六活动');
    return Response.json({
      choices: [
        {
          message:
            calls < 3
              ? {
                  content: null,
                  tool_calls: [
                    {
                      id: `f${calls}`,
                      type: 'function',
                      function: {
                        name: calls === 1 ? 'workspace_write' : 'workspace_read',
                        arguments: JSON.stringify(calls === 1 ? { path: '活动.txt', content: '周六活动' } : { path: '活动.txt' })
                      }
                    }
                  ]
                }
              : { content: '已保存并核对活动记录。' }
        }
      ]
    });
  };
  try {
    const events = [];
    await runModuleTurn({
      config,
      sessionId: 'group-files-test',
      input: '保存并核对活动记录',
      context: context(),
      onEvent: async event => {
        events.push(event);
      }
    });
    assert.equal(calls, 3);
    assert.ok(events.some(event => event.type === 'content' && event.content.includes('已保存')));
    assert.equal(workspaceOperation(base, context({ userId: 'other-member' }), 'read', { path: '活动.txt' }).content, '周六活动');
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = oldConfig;
    globalThis.fetch = oldFetch;
  }
});
