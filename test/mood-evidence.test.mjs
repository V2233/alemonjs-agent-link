import test from 'node:test';
import assert from 'node:assert/strict';
import { keywordMoodDelta, parseMoodJudgment } from '../lib/companion/mood.js';

test('ambiguous teasing, corrections, silence requests and personal distress do not incur keyword penalties', () => {
  for (const text of ['肥鱼你这个笨蛋', '闭嘴', '你说错了', '我很难过', '我好几天没来了', '别回了']) {
    assert.equal(keywordMoodDelta(text), 0, text);
  }
  assert.equal(keywordMoodDelta('你这个废物'), -6);
});

test('model emotional changes require original evidence and negative changes require direct insult classification', () => {
  const judgment = changes => JSON.stringify({delta:-3,confidence:0.95,evidence:'你说错了',impact:'neutral',...changes});
  assert.deepEqual(parseMoodJudgment(judgment(), '你说错了'), {reason:'not-direct-insult'});
  assert.deepEqual(parseMoodJudgment(judgment({impact:'direct_insult',evidence:'废物'}), '你说错了'), {reason:'missing-evidence'});
  assert.deepEqual(parseMoodJudgment(judgment({impact:'direct_insult',evidence:'你这个废物'}), '你这个废物'), {delta:-3});
  assert.deepEqual(parseMoodJudgment(judgment({delta:2,evidence:'谢谢你',impact:'positive'}), '谢谢你'), {delta:2});
  assert.deepEqual(parseMoodJudgment(judgment({confidence:0.5}), '你说错了'), {reason:'low-confidence'});
});
