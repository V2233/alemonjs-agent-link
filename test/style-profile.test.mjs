import test from 'node:test';
import assert from 'node:assert/strict';
import { groupStyleHint, styleHint } from '../lib/social/style-profile.js';

test('group style hint summarizes short, punctuation-light tone without copying text', () => {
  const messages = [
    '笑死我了',
    '笑死',
    '真绷不住',
    '这也太离谱',
    '确实啊',
    '救命 好家伙',
    '？',
    '？？？',
    '6',
    'emmm 不好说',
    '哈哈哈草'
  ].map(text => ({ text }));
  const hint = groupStyleHint(messages);

  assert.match(hint, /中位/);
  assert.match(hint, /偏短句/);
  assert.match(hint, /不带句末标点/);
  assert.match(hint, /笑死|绷不住|离谱/);
  assert.doesNotMatch(hint, /笑死我了/);
});

test('style hint ignores commands, links, attachments and small samples', () => {
  assert.equal(groupStyleHint([{ text: '/帮助' }]), '');
  assert.equal(
    groupStyleHint([
      { text: '/帮助' },
      { text: 'https://example.com' },
      { text: '[附件:image]' },
      { text: '你好' }
    ]),
    ''
  );
});

test('bot messages do not define the group tone', () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({ text: `机器人长回复${index}`, speaker: '__bot__' }));
  assert.equal(groupStyleHint(messages), '');
});

test('private style hint uses a smaller sample and labels the scope', () => {
  const messages = ['好累啊', '今天不想动', '笑死', '真的假的', ' emmm 再说吧 '].map(text => ({ text }));
  const hint = styleHint(messages, 'private');

  assert.match(hint, /私聊/);
  assert.match(hint, /最近 5 条/);
  assert.equal(styleHint(messages.slice(0, 4), 'private'), '');
});
