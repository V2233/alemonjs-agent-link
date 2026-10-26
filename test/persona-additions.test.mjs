import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaStore } from '../lib/companion/personas.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';

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
    assert.equal(await store.systemPrompt(config, context), config.defaultSystemPrompt);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
