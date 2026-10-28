import test from 'node:test';
import assert from 'node:assert/strict';
import { polishNetSavvy } from '../lib/dsh/reply-format.js';
import { StreamOutput } from '../lib/dsh/output.js';

test('net-savvy eraser removes assistant padding without touching code', () => {
  assert.equal(polishNetSavvy('我这边看了一下，没问题'), '我看了一下，没问题');
  assert.equal(polishNetSavvy('作为AI，我不能这样做'), '我不能这样做');
  assert.equal(polishNetSavvy('好的主人，已经处理好了'), '已经处理好了');
  assert.equal(polishNetSavvy('我帮你看看这个报错'), '我看看这个报错');
  assert.equal(polishNetSavvy('希望对你有帮助。'), '希望对你有帮助。');
  assert.equal(polishNetSavvy('```ts\nconst x = "我这边";\n```'), '```ts\nconst x = "我这边";\n```');
});

test('streamed replies are polished before send', async () => {
  const parts = [];
  const output = new StreamOutput(async text => parts.push(text), 100, 1000, () => {}, 5, 0);

  output.append('我这边看了一下，功能正常。');
  assert.equal(await output.close(), true);
  assert.deepEqual(parts, ['我看了一下，功能正常。']);
});
