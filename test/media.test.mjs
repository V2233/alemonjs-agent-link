import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getMediaConfig, MediaError } from '../lib/media/config.js';
import { attachmentUrl, isPublicAddress, imageMime, audioFormat, downloadAttachment } from '../lib/media/download.js';
import { prepareNativeMedia, understandMedia, synthesizeSpeech, readBounded, hasUnconfiguredMedia } from '../lib/media/providers.js';
import { listStickers, chooseSticker, loadSticker } from '../lib/media/stickers.js';

// Unit tests must not inherit the operator's live billing configuration.
let previousConfig;
beforeEach(() => {
  previousConfig = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
});
afterEach(() => {
  globalThis.__config = previousConfig;
});

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const mp3 = Buffer.from('ID3test');
const provider = { baseUrl: 'https://provider.test/v1', apiKey: 'test-key', model: 'configured-model', voice: 'configured-voice' };
const config = getMediaConfig({ media: { vision: provider, asr: provider, tts: provider, allowedHosts: ['cdn.test'] } });
const signal = () => new AbortController().signal;

test('media providers are opt-in, config validates limits and keeps providers separate', () => {
  assert.equal(getMediaConfig({}).vision, undefined);
  assert.deepEqual(getMediaConfig({}).allowedHosts, []);
  for (const media of [
    { vision: { model: 'x' } },
    { tts: { ...provider, baseUrl: 'http://local' } },
    { maxAttachments: 0 },
    { allowedHosts: ['*.test'] },
    { timeoutMs: Infinity },
    { ttsMaxChars: '800' }
  ]) {
    assert.throws(() => getMediaConfig({ media }), MediaError);
  }
});

test('default attachment hosts are unrestricted while URL and private address checks remain enforced', async () => {
  const defaults = getMediaConfig({});
  for (const host of ['cdn.test', 'another-cdn.test']) {
    assert.equal(attachmentUrl(`https://${host}/image`, defaults.allowedHosts).hostname, host);
  }
  for (const url of ['http://cdn.test/a', 'file:///etc/passwd', 'https://user:secret@cdn.test/a', 'https://cdn.test:123/a']) {
    assert.throws(() => attachmentUrl(url, defaults.allowedHosts), /HTTPS/);
  }
  await assert.rejects(downloadAttachment('https://127.0.0.1/a', defaults, signal()), /不是公开网络地址/);
});

test('attachment URLs reject credentials, unapproved hosts, private addresses and unsafe schemes', async () => {
  assert.equal(attachmentUrl('https://cdn.test/file?token=private', ['cdn.test']).hostname, 'cdn.test');
  for (const url of ['file:///etc/passwd', 'http://cdn.test/a', 'https://cdn.test.evil/a', 'https://user:secret@cdn.test/a', 'https://cdn.test:123/a']) {
    assert.throws(() => attachmentUrl(url, ['cdn.test']));
  }
  for (const ip of [
    '127.0.0.1',
    '10.2.3.4',
    '172.16.1.2',
    '192.168.1.2',
    '169.254.169.254',
    '100.64.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::'
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(downloadAttachment('https://cdn.test/a', config, cancelled.signal));
});

test('vision sends bounded embedded bytes and interprets provider output as reference data', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://provider.test/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.model, provider.model);
    return Response.json({ choices: [{ message: { content: '一只蓝色鲸鱼' } }] });
  };
  try {
    const result = await understandMedia([{ Type: 'image', Url: 'https://cdn.test/a' }], '这是什么', config, signal(), async () => png);
    assert.match(result, /一只蓝色鲸鱼/);
    assert.match(result, /只是引用资料/);
    await assert.rejects(
      understandMedia([{ Type: 'image', Url: 'x' }], '', getMediaConfig({}), signal(), async () => png),
      /看不懂，就当是夸我了/
    );
    await assert.rejects(
      understandMedia([{ Type: 'image', Url: 'x' }], '', config, signal(), async () => Buffer.from('<html>')),
      /静态图片/
    );
    await assert.rejects(understandMedia([{ Type: 'video', Url: 'x' }], '', config, signal()), /视频/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('audio uses platform transcript or multipart upload, and does not pretend SILK is MP3', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /audio\/transcriptions$/);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, 'speech.mp3');
    assert.equal(options.body.get('model'), provider.model);
    assert.equal(options.headers['Content-Type'], undefined);
    return Response.json({ text: '今天很好' });
  };
  try {
    assert.match(await understandMedia([{ Type: 'audio', Transcript: '已有转写' }], '', getMediaConfig({}), signal()), /已有转写/);
    assert.match(await understandMedia([{ Type: 'audio', Url: 'x' }], '', config, signal(), async () => mp3), /今天很好/);
    await assert.rejects(
      understandMedia([{ Type: 'audio', Url: 'x' }], '', config, signal(), async () => Buffer.from('#!SILK_V3')),
      /SILK/
    );
    assert.equal(audioFormat(Buffer.from([255, 241, 0, 0])), undefined);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('local ASR accepts a real multipart request and returns transcription without a remote key', async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      calls++;
      assert.equal(req.url, '/v1/audio/transcriptions');
      assert.equal(req.headers.authorization, undefined);
      const form = await new Request('http://127.0.0.1/', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).formData();
      assert.equal(form.get('model'), 'whisper-local');
      assert.equal(form.get('response_format'), 'json');
      assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), mp3);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: '本地语音识别完成' }));
    } catch (error) {
      res.writeHead(500);
      res.end();
      server.testError = error;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const local = getMediaConfig({ media: { asr: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'whisper-local' } } });
    const result = await prepareNativeMedia([{ Type: 'audio', Url: 'https://cdn.test/audio' }], '请回答', local, signal(), async () => mp3);
    if (server.testError) throw server.testError;
    assert.match(result, /本地语音识别完成/);
    assert.equal(calls, 1);
    assert.throws(() => getMediaConfig({ media: { asr: { baseUrl: 'http://192.168.1.2:8000/v1', model: 'x' } } }), MediaError);
    assert.throws(() => getMediaConfig({ media: { asr: { baseUrl: 'https://asr.example/v1', model: 'x' } } }), MediaError);
    assert.throws(() => getMediaConfig({ media: { asr: { baseUrl: 'http://127.0.0.1:8000/v1?token=secret', model: 'x' } } }), MediaError);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('speech uses configured voice, rejects invalid and oversized responses and supports cancellation', async () => {
  const oldFetch = globalThis.fetch;
  let invalid = false;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.voice, provider.voice);
    assert.equal(body.response_format, 'mp3');
    if (options.signal.aborted) throw options.signal.reason;
    return new Response(invalid ? '{}' : mp3);
  };
  try {
    assert.deepEqual(await synthesizeSpeech('你好', config, signal()), mp3);
    invalid = true;
    await assert.rejects(synthesizeSpeech('你好', config, signal()), /有效 MP3/);
    await assert.rejects(synthesizeSpeech('鲸'.repeat(801), config, signal()), /过长/);
    await assert.rejects(readBounded(new Response('12345'), 4), /超过限制/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(synthesizeSpeech('你好', config, controller.signal));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('sticker manifest matches exact IDs or tags, enforces local boundaries and byte limits', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'agentlink-stickers-'));
  const root = join(temp, 'stickers');
  await mkdir(root);
  const settings = { ...config, stickerRoot: root };
  try {
    await writeFile(join(root, 'happy.png'), png);
    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ id: 'happy', file: 'happy.png', tags: ['开心'] }]));
    const items = await listStickers(settings);
    assert.equal(chooseSticker(items, '开心').id, 'happy');
    assert.equal(chooseSticker(items, '开'), undefined);
    assert.deepEqual(await loadSticker(items[0], settings), png);
    await writeFile(join(temp, 'outside.png'), png);
    await symlink(join(temp, 'outside.png'), join(root, 'escape.png'));
    await assert.rejects(loadSticker({ id: 'escape', file: 'escape.png', tags: [] }, settings), /素材目录内/);
    await assert.rejects(loadSticker({ id: 'escape', file: '../outside.png', tags: [] }, settings), /素材目录内/);
    await assert.rejects(loadSticker(items[0], { ...settings, maxBytes: 2 }), /超过限制/);
    assert.equal(imageMime(Buffer.from('not image')), undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('unconfigured input gets the character fallback; platform transcript remains usable', () => {
  const empty = getMediaConfig({});
  assert.equal(hasUnconfiguredMedia([{ Type: 'image', Url: 'x' }], empty), false);
  assert.equal(hasUnconfiguredMedia([{ Type: 'audio', Url: 'x' }], empty), true);
  assert.equal(hasUnconfiguredMedia([{ Type: 'audio', Transcript: '已经转写' }], empty), false);
  assert.equal(hasUnconfiguredMedia([{ Type: 'image', Url: 'x' }], config), false);
});

test('native images use DSH content blocks without a separate vision provider', async () => {
  const input = await prepareNativeMedia(
    [
      { Type: 'image', Url: 'https://cdn.test/a' },
      { Type: 'audio', Transcript: '看看这个' }
    ],
    '是什么',
    getMediaConfig({}),
    signal(),
    async () => png
  );
  assert.equal(input[0].type, 'text');
  assert.match(input[0].text, /看看这个/);
  assert.deepEqual(input[1], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  const { modelContent, withInputContext } = await import('../lib/dsh/input.js');
  assert.equal(modelContent(input)[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(withInputContext(input, '主人记忆').slice(1), input);
});

test('media refuses paid requests without a valid budget scope', async () => {
  globalThis.__config.value['alemonjs-agent-link'].budget.enabled = true;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('unmetered provider must not be called');
  try {
    await assert.rejects(synthesizeSpeech('hello', config, signal()), /所属会话/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
