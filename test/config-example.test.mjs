import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { getGroupChatPolicy } from '../lib/social/group-policy.js';
import { getModuleConfig } from '../lib/agent/modules.js';
import { getMediaConfig } from '../lib/media/config.js';
import { proactiveOptions } from '../lib/proactive/options.js';
import { memoryOptions } from '../lib/memory/consolidation.js';
import { moodOptions } from '../lib/companion/mood.js';
import { expressionOptions } from '../lib/companion/expression.js';
import { autoStickerSettings } from '../lib/media/sticker-auto.js';
import { biliOptions } from '../lib/bili/client.js';
import { diaryOptions } from '../lib/qzone/diary.js';
import { resolveOneBotConfig } from '../lib/onebot/config.js';

const source = await readFile(new URL('../alemon.config.example.yaml', import.meta.url), 'utf8');
const example = YAML.parse(source);
const app = example['alemonjs-agent-link'];

test('the example config parses and carries the sections the readers expect', () => {
  assert.equal(example['qq-bot'].app_id, '<QQ_APP_ID>');
  assert.ok(example.onebot.url.startsWith('ws://127.0.0.1'));
  assert.equal(example['alemonjs-agent-link'].budget.enabled, false, '示例默认不开启额度，避免要求 Redis');
  assert.equal(typeof example.master_id, 'string');
  assert.equal(app.transport, 'qq-bot');
  assert.equal(app.model, 'deepseek-v4-flash');
});

test('the example config passes every runtime validator', () => {
  const config = resolveDSHConfig(app, { hasRedis: true });

  assert.equal(config.transport, 'qq-bot');
  assert.equal(config.retentionDays, 30);
  getGroupChatPolicy(config.groupChat);
  getModuleConfig(config);
  proactiveOptions(config);
  memoryOptions(config);
  moodOptions(config);
  expressionOptions(config);
  autoStickerSettings(config);
  biliOptions(config.modules.settings.bili);
  diaryOptions(config.modules.settings.qzone);
  getMediaConfig(app);
  resolveOneBotConfig(example);
});

test('the example keeps secrets as placeholders', () => {
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{20,}/u, '示例里不能出现真实密钥');
  assert.match(app.apiKey, /^<.+>$/u);
  assert.match(example['qq-bot'].secret, /^<.+>$/u);
  assert.match(example.onebot.accessToken, /^<.+>$/u);
});

test('every key in the example is documented in the field reference', async () => {
  const reference = await readFile(new URL('../docs/config-reference.md', import.meta.url), 'utf8');
  const keys = [];
  const collect = (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      // apps 的值是应用名，不是配置字段。
      if (path === '' && key === 'apps') continue;
      keys.push(key);
      if (value && typeof value === 'object' && !Array.isArray(value)) collect(value, path ? `${path}.${key}` : key);
    }
  };

  collect(example, '');
  const missing = [...new Set(keys)].filter(key => !reference.includes(key));

  assert.deepEqual(missing, [], `这些字段没有写进 docs/config-reference.md：${missing.join(', ')}`);
});
