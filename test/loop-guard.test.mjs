import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard } from '../lib/social/loop-guard.js';

test('known bots, repeating prompts and echoed answers are blocked without labeling humans', () => {
  const guard = new LoopGuard();
  assert.equal(guard.allows('bot', '你好', 1000, true), false);
  guard.delivered('one', '帮我详细介绍今天的天气', '这是今天的天气情况请注意及时带伞', 1000);
  assert.equal(guard.allows('one', '帮我详细介绍今天的天气！', 1001), false);
  assert.equal(guard.allows('other', '这是今天的天气情况，请注意及时带伞。', 1001), false);
  assert.equal(guard.allows('other', '请解释一下降雨概率', 1001), true);
  assert.equal(guard.allows('one', '请解释一下降雨概率', 121002), true);
});

test('four delivered turns per peer trip a bounded circuit even with changing text; failures do not count', () => {
  const guard = new LoopGuard();
  for (let i = 0; i < 4; i++) {
    assert.equal(guard.allows('one', `新的内容${i}`, 1000 + i), true);
    guard.delivered('one', `新的内容${i}`, `回答${i}`, 1000 + i);
  }
  assert.equal(guard.allows('one', '又一个新问题', 1010), false);
  assert.equal(guard.allows('two', '又一个新问题', 1010), true);
  assert.equal(guard.allows('one', '又一个新问题', 122000), true);
});
