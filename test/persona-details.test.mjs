import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaStore } from '../lib/companion/personas.js';
import { personaDetailFields } from '../lib/companion/persona-details.js';
test('details supplement base and additions, survive legacy writes and default selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-details-'));
  const store = new PersonaStore(root);
  try {
    const builtin = await store.read('dafeiyu');
    assert.equal(Object.keys(builtin.details).length, 35);
    assert.equal(personaDetailFields.length, 35);
    await store.save({ ...builtin, details: { 姓名: '肥鱼', 爱好: '收集奇怪键帽' } });
    const { details, ...legacy } = await store.read('dafeiyu');
    await store.save(legacy);
    assert.deepEqual((await store.read('dafeiyu')).details, details);
    store.append('dafeiyu', '喜欢冷笑话');
    const config = { persona: 'dafeiyu', defaultSystemPrompt: '保留自定义基础' };
    const context = { platform: 'qq', channelId: 'a', private: false, owner: false };
    const prompt = await store.systemPrompt(config, context);
    assert.ok(prompt.startsWith('保留自定义基础'));
    assert.match(prompt, /收集奇怪键帽/);
    assert.match(prompt, /喜欢冷笑话/);
    await store.select(context, 'dafeiyu');
    assert.ok((await store.systemPrompt(config, context)).startsWith(builtin.prompt));
    await assert.rejects(store.save({ ...(await store.read('dafeiyu')), details: { 爱好: 123 } }), /细节/);
    await assert.rejects(store.save({ ...(await store.read('dafeiyu')), details: { 未知字段: 'x' } }), /细节/);
    await store.save({ ...(await store.read('dafeiyu')), details: {} });
    assert.deepEqual((await store.read('dafeiyu')).details, {});
    await assert.rejects(store.save(builtin), /配置已更新/);
    await store.select(context);
    const current = await store.read('dafeiyu');
    await store.save({ ...current, prompt: '新基础', socialRules: '群聊专用', privateRules: '私聊专用' });
    const defaultConfig = { persona: 'dafeiyu', defaultSystemPrompt: builtin.prompt };
    assert.match(await store.systemPrompt(defaultConfig, context), /^新基础[\s\S]*群聊专用/);
    assert.match(await store.systemPrompt(defaultConfig, { ...context, private: true, owner: true }), /^新基础[\s\S]*私聊专用/);
    assert.match(await store.systemPrompt(config, context), /^保留自定义基础/);
    const latest = await store.read('dafeiyu');
    const results = await Promise.allSettled([store.save({ ...latest, name: '甲' }), store.save({ ...latest, name: '乙' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('electronic dafeiyu conversation rules follow saved details and every expression mode without affecting other personas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-chat-rules-'));
  const store = new PersonaStore(root);
  const context = { platform: 'qq', channelId: 'chat-rules', private: false, owner: false };
  try {
    const saved = await store.read('dafeiyu');
    await store.save({ ...saved, prompt: '旧人设：采用工作汇报表达' });
    await store.select(context, 'dafeiyu');
    for (const mode of ['活跃', '个性', '工作', '专业']) {
      store.setExpressionMode(context, mode, true);
      const prompt = await store.systemPrompt({ persona: 'dafeiyu', defaultSystemPrompt: '旧默认' }, context);
      assert.ok(prompt.indexOf('【电子大肥鱼的交流约束】') > prompt.indexOf(`【当前表达程度：${mode}】`));
      for (const phrase of ['禁止工作汇报式说话', '下一句立即', '允许玩在一起', '愿意加入', '停止', '不得谎称自己是现实中的人'])
        assert.ok(prompt.includes(phrase), phrase);
    }
    await store.select(context, 'assistant');
    const other = await store.systemPrompt({ persona: 'dafeiyu', defaultSystemPrompt: '旧默认' }, context);
    assert.doesNotMatch(other, /【电子大肥鱼的交流约束】/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
