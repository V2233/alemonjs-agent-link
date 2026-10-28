import test from 'node:test';
import assert from 'node:assert/strict';
import { startsWithAddressName } from '../lib/response/dsh/util.js';

const names = ['肥鱼', '大肥鱼', '小鲸鱼', 'deepseek', '帮我', '求助'];

test('sentence-leading bot names are high-confidence address', () => {
  for (const text of ['肥鱼，帮我看看', '大肥鱼 你好', '小鲸鱼！', 'deepseek 在吗', '肥鱼', '肥鱼？']) {
    assert.equal(startsWithAddressName(text, names), true, text);
  }
  assert.equal(startsWithAddressName('茶友，在吗', ['茶友']), true);
});

test('third-person, mid-sentence and generic help are not local address', () => {
  for (const text of ['他们说肥鱼是人机', '今天看到肥鱼', '肥鱼说这个不行', '帮我查一下', '求助这个报错', '/肥鱼', '']) {
    assert.equal(startsWithAddressName(text, names), false, text);
  }
});
