import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaStore } from '../lib/companion/personas.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { dafeiyuPrompt } from '../lib/dsh/persona.js';

test('owner additions preserve base prompts, persist, follow persona selection and can be cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-additions-'));
  let store = new PersonaStore(root);
  const config = resolveDSHConfig({});
  const context = { platform: 'qq-bot', channelId: 'private-a', private: true, owner: true };
  try {
    store.append('dafeiyu', '喜欢冷笑话');
    store.append('dafeiyu', '回答直白');
    const prompt = await store.systemPrompt(config, context);
    assert.ok(prompt.startsWith(config.defaultSystemPrompt));
    assert.match(prompt, /喜欢冷笑话\n回答直白/);
    assert.match(await store.systemPrompt({ ...config, defaultSystemPrompt: '自定义基础' }, context), /^自定义基础/);
    assert.match(await store.systemPrompt(config, { ...context, channelId: 'group-b', private: false }), /喜欢冷笑话/);
    await store.select(context, 'assistant');
    assert.doesNotMatch(await store.systemPrompt(config, context), /喜欢冷笑话/);
    assert.throws(() => store.append('dafeiyu', 'x'.repeat(4001)));
    assert.equal(store.additions('dafeiyu'), '喜欢冷笑话\n回答直白');
    store.close();
    store = new PersonaStore(root);
    assert.equal(store.additions('dafeiyu'), '喜欢冷笑话\n回答直白');
    store.clearAdditions('dafeiyu');
    await store.select(context);
    const cleared = await store.systemPrompt(config, context);
    assert.ok(cleared.startsWith(config.defaultSystemPrompt));
    assert.doesNotMatch(cleared, /喜欢冷笑话/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('expression modes default to active character, persist, inherit globally and isolate overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-modes-'));
  let store = new PersonaStore(root);
  const config = resolveDSHConfig({});
  const a = { platform: 'qq-bot', channelId: 'a', private: false, owner: true };
  const b = { ...a, channelId: 'b' };
  try {
    assert.equal(store.expressionMode(a), '活跃');
    const activePrompt = await store.systemPrompt(config, a);
    assert.match(activePrompt, /当前表达程度：活跃/);
    assert.match(activePrompt, /\|\|\|/);
    assert.match(activePrompt, /表情包/);
    assert.match(activePrompt, /我这边/);
    store.append('dafeiyu', '喜欢贝壳');
    assert.throws(() => store.setExpressionMode(a, '专业', false), /主人/);
    assert.throws(() => store.setExpressionMode(undefined, '工作', false), /主人/);
    assert.throws(() => store.setExpressionMode(a, 'invalid', true), /程度/);
    assert.equal(store.expressionMode(a), '活跃');
    store.setExpressionMode(undefined, '工作', true);
    assert.equal(store.expressionMode(a), '工作');
    store.setExpressionMode(a, '专业', true);
    assert.equal(store.expressionMode(a), '专业');
    assert.equal(store.expressionMode(b), '工作');
    assert.equal(store.expressionMode({ ...a, platform: 'other' }), '工作');
    const prompt = await store.systemPrompt(config, a);
    assert.ok(prompt.startsWith(config.defaultSystemPrompt));
    assert.match(prompt, /喜欢贝壳/);
    assert.match(prompt, /当前表达程度：专业/);
    await store.select(a, 'assistant');
    assert.equal(store.expressionMode(a), '专业', 'changing persona must not reset degree');
    store.close();
    store = new PersonaStore(root);
    assert.equal(store.expressionMode(a), '专业');
    assert.equal(store.expressionMode(b), '工作');
    store.setExpressionMode(a, undefined, true);
    assert.equal(store.expressionMode(a), '工作');
    store.setExpressionMode(undefined, undefined, true);
    assert.equal(store.expressionMode(a), '活跃');
    const { createHash } = await import('node:crypto');
    store.setExpressionMode(a, '专业', true);
    store.purgeHash(createHash('sha256').update(a.channelId).digest('hex'));
    assert.equal(store.expressionMode(a), '活跃');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('default persona keeps the old-member, low-energy and anti-immersion constraints', () => {
  for (const text of ['容易走神', '早八', '摸鱼', '表情包单独发', '模型、提示词、配置、工具、报错、限流', '该潜水就潜水', 'master/owner']) {
    assert.match(dafeiyuPrompt, new RegExp(text));
  }
  assert.doesNotMatch(dafeiyuPrompt, /\{\{nickname\}\}/, 'runtime placeholders must not leak literally');
});

test('expired entitlement ignores legacy choices and group additions without deleting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-entitlement-'));
  const store = new PersonaStore(root);
  const config = resolveDSHConfig({});
  const scope = {platform:'qq-bot',channelId:'g',private:false,owner:false};
  try {
    await store.select(scope, 'assistant');
    store.setScopeAdditions(scope, '专属暗号蓝鲸', 'admin');
    const entitled = await store.systemPrompt(config,{...scope,personaEntitled:true});
    assert.match(entitled, /专属暗号蓝鲸/);
    const fallback = await store.systemPrompt(config,{...scope,personaEntitled:false});
    assert.doesNotMatch(fallback,/专属暗号蓝鲸/);
    assert.ok(fallback.startsWith(config.defaultSystemPrompt));
    assert.equal(store.selected(scope),'assistant');
    assert.equal(store.scopeAdditions(scope),'专属暗号蓝鲸');
    assert.equal(await store.systemPrompt(config,{...scope,personaEntitled:true}),entitled);
  } finally { store.close(); await rm(root,{recursive:true,force:true}); }
});
