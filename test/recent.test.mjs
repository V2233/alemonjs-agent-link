import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRecentMedia, rememberRecentMedia, takeRecentImage } from '../lib/media/recent.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const signal = () => new AbortController().signal;
const event = (overrides = {}) => ({
  Platform: 'onebot',
  ChannelId: '200',
  UserId: '300',
  MessageId: '1',
  IsPrivate: false,
  IsBot: false,
  MessageMedia: [{ Type: 'image', Url: 'https://cdn.test/a.png' }],
  ...overrides
});

test('recent media resolves a group image and prefers the caller own upload', async () => {
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: {} } } };
  clearRecentMedia();
  try {
    rememberRecentMedia(event({ MessageId: 'a', UserId: '1', MessageMedia: [{ Type: 'image', Url: 'https://cdn.test/a.png' }] }));
    rememberRecentMedia(event({ MessageId: 'b', UserId: '2', MessageMedia: [{ Type: 'image', Url: 'https://cdn.test/b.png' }] }));
    let requested;
    const download = async url => {
      requested = url;

      return png;
    };
    assert.deepEqual(await takeRecentImage('onebot', '200', signal(), '1', download), png);
    assert.equal(requested, 'https://cdn.test/a.png');
    await takeRecentImage('onebot', '200', signal(), undefined, download);
    assert.equal(requested, 'https://cdn.test/b.png');
    clearRecentMedia();
    assert.equal(await takeRecentImage('onebot', '200', signal(), '1', download), undefined);
  } finally {
    globalThis.__config = previous;
  }
});

test('recent media uses the normalized private conversation key and ignores bot messages', async () => {
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: {} } } };
  clearRecentMedia();
  try {
    rememberRecentMedia(event({ IsPrivate: true, UserId: '300', MessageId: 'p', MessageMedia: [{ Type: 'sticker', Url: 'https://cdn.test/p.png' }] }));
    const key = `private:${JSON.stringify(['onebot', '300'])}`;
    const download = async () => png;
    assert.deepEqual(await takeRecentImage('onebot', key, signal(), '300', download), png);
    clearRecentMedia();
    rememberRecentMedia(event({ IsBot: true, MessageId: 'bot' }));
    assert.equal(await takeRecentImage('onebot', '200', signal(), '300', download), undefined);
  } finally {
    globalThis.__config = previous;
  }
});
