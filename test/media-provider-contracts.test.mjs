import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMediaConfig } from '../lib/media/config.js';
import { voiceLibrary } from '../lib/media/voice-library.js';
import { renderSpeech } from '../lib/media/speech.js';
import { transcribeAudio, understandMedia, describeVisualInput } from '../lib/media/providers.js';
import { generateImage } from '../lib/media/image-generation.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const mp3 = Buffer.from('ID3test');

test('Fish binary audio contract, required settings and failures without silent voice replacement', async () => {
  const oldConfig = globalThis.__config, oldFetch = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), 'fish-contract-'));
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  try {
    const speech = { engine: 'fish', fallback: false, url: 'https://api.fish.audio', apiKey: 'test-key', voiceId: 'chosen-voice', model: 'chosen-model' };
    const config = getMediaConfig({ media: { speech } });
    for (const field of ['apiKey', 'voiceId', 'model', 'url']) assert.throws(() => getMediaConfig({ media: { speech: { ...speech, [field]: '' } } }), /Fish Audio/);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.fish.audio/v1/tts');
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      assert.equal(init.headers.model, 'chosen-model');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), { text: '你好', reference_id: 'chosen-voice', format: 'mp3' });
      return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } });
    };
    const audio = await renderSpeech('你好', config, AbortSignal.timeout(10000), { workspaceRoot: join(root, 'work') });
    assert.equal(audio.engine, 'fish');
    assert.deepEqual(audio.data, mp3);
    globalThis.fetch = async () => Response.json({ error: 'no access' }, { status: 401 });
    await assert.rejects(renderSpeech('你好', config, AbortSignal.timeout(10000), { workspaceRoot: join(root, 'work') }), /HTTP 401/);
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); };
    await assert.rejects(renderSpeech('你好', config, AbortSignal.timeout(10000), { workspaceRoot: join(root, 'work') }), /连接语音服务超时/);
    globalThis.fetch = async () => Response.json({ text: 'not audio' });
    await assert.rejects(renderSpeech('你好', config, AbortSignal.timeout(10000), { workspaceRoot: join(root, 'work') }), /fish/);
  } finally {
    globalThis.fetch = oldFetch; globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('SenseVoice multipart, SiliconFlow image fields and local vision retain real protocol boundaries', async () => {
  const oldConfig = globalThis.__config, oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  try {
    const media = getMediaConfig({ media: {
      asr: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'test', model: 'FunAudioLLM/SenseVoiceSmall', protocol: 'siliconflow' },
      imageGen: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'test', model: 'Kwai-Kolors/Kolors', protocol: 'siliconflow' },
      vision: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'local-vision' }
    } });
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
      assert.equal(init.body.get('model'), 'FunAudioLLM/SenseVoiceSmall');
      assert.equal(init.body.has('response_format'), false);
      assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), mp3);
      return Response.json({ text: '你好肥鱼' });
    };
    assert.equal(await transcribeAudio(mp3, media, AbortSignal.timeout(10000)), '你好肥鱼');
    globalThis.fetch = async (url, init) => {
      assert.deepEqual(JSON.parse(init.body), { model: 'Kwai-Kolors/Kolors', prompt: '蓝鲸', image_size: '1024x1024' });
      return Response.json({ images: [{ b64_json: png.toString('base64') }] });
    };
    assert.deepEqual(await generateImage('蓝鲸', media, AbortSignal.timeout(10000)), png);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:9999/v1/chat/completions');
      assert.equal(init.headers.Authorization, undefined);
      assert.ok(JSON.parse(init.body).messages.at(-1).content.some(x => x.type === 'image_url'));
      return Response.json({ choices: [{ message: { content: '蓝色图片' } }] });
    };
    assert.match(await understandMedia([{ Type: 'image', Url: 'https://example.org/image.png' }], '描述图片', media, AbortSignal.timeout(10000), async () => png), /蓝色图片/);
    assert.throws(() => getMediaConfig({ media: { vision: { baseUrl: 'http://10.0.0.1/v1', model: 'bad' } } }), /HTTPS/);
    for (const responseFormat of ['auto', 'url', 'b64_json']) {
      globalThis.fetch = async (_url, init) => {
        assert.equal(JSON.parse(init.body).response_format, responseFormat === 'auto' ? undefined : responseFormat);
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      };
      await generateImage('蓝鲸', { ...media, imageGen: { ...media.imageGen, protocol: 'openai', responseFormat } }, AbortSignal.timeout(10000));
    }
  } finally { globalThis.fetch = oldFetch; globalThis.__config = oldConfig; }
});

 test('disabled Fish draft can store credentials before selecting a voice, enabled cannot', () => {
  const draft = { id: 'fish-draft', name: 'Fish 待选音色', enabled: false, speech: { engine: 'fish', url: 'https://api.fish.audio', apiKey: 'test', model: 's2.1-pro-free', fallback: false } };
  assert.equal(voiceLibrary([draft])[0].speech.voiceId, undefined);
  assert.throws(() => voiceLibrary([{ ...draft, enabled: true }]), /voiceId/);
});

test('explicit visual input preserves evidence limits and refuses truncated or failed observations', async () => {
  const media = getMediaConfig({ media: { vision: { baseUrl: 'https://vision.example/v1', apiKey: 'fixture', model: 'vision' } } });
  const input = [{ type: 'text', text: '采样1秒，未听音轨' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }];
  let calls = 0;
  const send = async (_provider, _path, body) => {
    calls++;
    assert.match(body, /未听音轨/);
    return Buffer.from(JSON.stringify({ choices: [{ message: { content: '画面可见鲸鱼' }, finish_reason: 'stop' }] }));
  };
  assert.match(await describeVisualInput(input, media, AbortSignal.timeout(5000), send), /引用资料/);
  assert.equal(await describeVisualInput(input, getMediaConfig({}), AbortSignal.timeout(5000), send), input);
  assert.equal(calls, 1);
  await assert.rejects(describeVisualInput(input, media, AbortSignal.timeout(5000), async () => Buffer.from(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))), /截断/);
  await assert.rejects(describeVisualInput(input, media, AbortSignal.timeout(5000), async () => { throw new Error('fixture unavailable'); }), /fixture unavailable/);
});
