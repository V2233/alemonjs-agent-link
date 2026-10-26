import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFragments, speechControl } from '../lib/social/message-fragments.js';
const msg = (id, text = '内容') => ({ id, text, userId: 'alice', userKey: 'alice', platform: 'qq-bot' });
test('speech controls require standalone phrases and do not interpret quoted phrases', () => {
  assert.equal(speechControl('肥鱼，等我说完！'), 'hold');
  assert.equal(speechControl('可以回了'), 'release');
  for (const text of ['他说“等我说完”', '不要等我说完', '等我说完是什么意思', '你还没说完吗']) assert.equal(speechControl(text), undefined);
});
test('fragment storage expires, stays bounded, preserves attachments and separates speakers', () => {
  const store = new MessageFragments();
  store.save([msg('1')], 0);
  assert.deepEqual(store.take(msg('2'), 45000), []);
  store.save([{ ...msg('3'), media: [{ Type: 'Image', Url: 'https://example.test/a' }] }], 0, true);
  assert.equal(store.holding({ ...msg('x'), userId: 'bob' }, 100), false);
  assert.equal(store.take(msg('4'), 100)[0].media[0].Type, 'Image');
  store.save(
    Array.from({ length: 30 }, (_, i) => msg(String(i), 'x'.repeat(400))),
    0,
    true
  );
  assert.equal(store.take(msg('x'), 100).length, 15);
  store.save([msg('last')], 0, true);
  assert.equal(store.holding(msg('x'), 120000), false);
});
