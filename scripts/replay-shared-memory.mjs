#!/usr/bin/env node
// Synthetic conversations, real configured model, isolated SQLite. Never sends QQ messages.
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { getDSHCredentials } from '../lib/dsh/credentials.js';
import { requestModelMessage } from '../lib/agent/tool-chat.js';
import { getMemoryStore } from '../lib/memory/store.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { memoryModule } from '../lib/modules/memory.js';
import { getChatArchive } from '../lib/history/store.js';

const configFile = process.argv[2] || 'alemon.config.yaml';
const raw = parse(await readFile(configFile, 'utf8'));
const dir = await mkdtemp(join(tmpdir(), 'shared-live-'));
const namespace = raw['alemonjs-agent-link'];
namespace.budget = { enabled: false };
namespace.stateBackend = 'local';
namespace.runtimeMode = 'chat-only';
namespace.privateHistoryMaxTurns = 10;
namespace.privateHistoryMaxChars = 240;
namespace.workspaceRoot = join(dir, 'workspaces');
namespace.dshHomeRoot = join(dir, 'homes');
namespace.modules = { disabled: [], settings: { memory: { automatic: true, intervalHours: 168 } } };
globalThis.__config = { value: raw };
const config = resolveDSHConfig(namespace);
const credentials = await getDSHCredentials();
if (!credentials) throw new Error('No configured model credentials');
const store = getMemoryStore(config);
const archive = getChatArchive(config);
let handlers = [],
  disposers = [];
const setup = () => {
  handlers = [];
  disposers = [];
  memoryModule(config).setup({
    on: (event, handler) => {
      if (event === 'context') handlers.push(handler);
    },
    onDispose: cleanup => disposers.push(cleanup),
    tool: () => {},
    settings: {},
    dataDirectory: dir,
    id: 'memory'
  });
};
setup();
const reset = () => {
  for (const dispose of disposers) dispose();
  setup();
};
const scope = { platform: 'replay', channelId: 'synthetic', botId: 'fish' };
const registry = new SessionRegistry(config);
const isolated = await registry.beginReset('private:compression-replay');
await registry.completeReset('private:compression-replay', isolated.operationId);
const historyScope = { channelId: 'private:compression-replay', generation: isolated.generation };
let compactedHistory = [];
const report = { startedAt: new Date().toISOString(), kind: 'real-model-production-memory-hook-replay', turns: [], passed: false };
const ask = async (system, input, history = []) => {
  const result = await requestModelMessage(
    config,
    (await getDSHCredentials()) || credentials,
    [{ role: 'system', content: system }, ...history, { role: 'user', content: JSON.stringify(input) }],
    [],
    AbortSignal.timeout(45000)
  );
  return result.content || '';
};
let seq = 0;
const turn = async (userId, text, check) => {
  archive.append(scope, { id: `u${++seq}`, role: 'user', speakerId: userId, speaker: userId, text });
  const context = {
    ...scope,
    userId,
    botId: 'fish',
    userText: text,
    private: false,
    owner: false,
    autonomous: false,
    capabilities: { chat: true, web: false, files: false, terminal: false },
    signal: AbortSignal.timeout(60000)
  };
  const memoryContext = (await Promise.all(handlers.map(handler => handler(context)))).join('\n');
  const threads = store.sharedThreads(scope, userId);
  const extraction = { path: 'production-memory-context-hook' };
  const reply = await ask(config.defaultSystemPrompt, { userId, text, memoryContext }, userId === '甲' ? compactedHistory : []);
  if (userId === '甲') await registry.appendPrivateTurn(historyScope, text, reply);
  const outcome = check(threads, reply);
  report.turns.push({ userId, text, extraction, threads, reply, checks: outcome });
  archive.append(scope, { id: `a${seq}`, role: 'assistant', speakerId: 'fish', speaker: 'fish', text: reply, sourceMessageId: `u${seq}` });
};
try {
  await turn('甲', '说好了，明天晚上八点一起讨论比赛，先只是约定，不用创建提醒。', (items, reply) => ({
    agreement: items.some(item => item.state === 'agreed'),
    noFalseCompletion: !/(已|已经)(创建|设置).*提醒/u.test(reply)
  }));
  await turn('乙', '记住，我的比赛讨论是后天十点，和甲不是一件事。', items => ({ isolated: items.every(item => item.subjectId === '乙') }));
  reset();
  await turn('甲', '昨天说好的比赛讨论改成晚上九点，八点那个时间作废。', items => ({
    corrected: items.some(item => item.state === 'agreed' && /九点|21[:：]00/u.test(item.text))
  }));
  await turn('甲', '比赛讨论取消，不用再安排了。', items => ({ cancelled: items.some(item => item.state === 'cancelled') }));
  reset();
  for (let i = 0; i < 10; i++) await registry.appendPrivateTurn(historyScope, `无关闲聊${i}，填充历史以触发实际压缩`, `回答${i}，这段没有新的安排或执行结果`);
  compactedHistory = await registry.privateHistory(historyScope);
  report.compression = {
    actualRegistryPath: true,
    digestPresent: compactedHistory.some(message => message.role === 'system' && /早前对话摘要/u.test(message.content)),
    messages: compactedHistory.length
  };
  await turn('甲', '昨天那个比赛讨论，最后怎么定的？', (items, reply) => ({
    cancelRecall: items[0]?.state === 'cancelled',
    replyAcknowledgesCancellation: /取消|不再|不用|作废/u.test(reply),
    noInternalNarration: !/接话|前置判断|sharedThreads|state=|调用.*工具/u.test(reply)
  }));
  await turn('甲', '所以提醒真的创建成功了吗？', (items, reply) => ({
    noFalseExecution: !/已经(?:成功)?(?:创建|设置|建好)|提醒(?:已经)?(?:创建|设置)成功/u.test(reply),
    statesPreserved: items[0]?.state === 'cancelled',
    uncertaintyStated: /没|未|没有|只是|约定|取消|不能确认|无法确认/u.test(reply)
  }));
  await turn('甲','今天下班路上看见一只橘猫，蹲在便利店门口不走。', (items,reply)=>({
    everydayScene:items.some(item=>/橘猫/u.test(item.text) && item.state==='discussed'),
    noTaskNarration:!/已记录|已保存|事项状态|接话/u.test(reply)
  }));
  reset();
  await turn('甲','刚才说的那只猫是在哪儿来着？', (items,reply)=>({
    sceneRecall:/便利店/u.test(reply),
    noInventedPresence:!/我(?:刚才|当时)?(?:也)?(?:看到|看见|遇到)/u.test(reply)
  }));
  report.passed = report.compression?.digestPresent && report.turns.every(turn => Object.values(turn.checks).every(Boolean));
} catch (error) {
  report.error = error.name;
  report.detail = String(error.message)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]+/gu, '[redacted]')
    .slice(0, 300);
  report.passed = false;
} finally {
  for (const dispose of disposers) dispose();
  store.close();
  archive.close();
  await rm(dir, { recursive: true, force: true });
  const out = resolve('.data/agent-link/validation/shared-memory-replay.json');
  await mkdir(resolve('.data/agent-link/validation'), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({ passed: report.passed, turns: report.turns.length, error: report.error || null, detail: report.detail || null, report: out }) + '\n'
  );
  process.exitCode = report.passed ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 100);
}
