import { mediaCapabilitiesModule } from '../lib/modules/media-capabilities.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { sampleVideoAttachment } from '../lib/media/video-input.js';
import { prepareNativeMedia, hasUnconfiguredMedia } from '../lib/media/providers.js';
import { getMediaConfig } from '../lib/media/config.js';
import { inspectLinks } from '../lib/media/links.js';
import { webModule } from '../lib/modules/web.js';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const signal = () => AbortSignal.timeout(10000);

test('video probe is local and bounded, samples three actual timestamps, removes temporary input', async () => {
  let input;
  const sampled = await sampleVideoAttachment(
    mp4,
    signal(),
    async (command, args, options) => {
      assert.equal(command, 'ffprobe');
      assert.ok(args.includes('file,pipe'));
      assert.equal(args[args.indexOf('-enable_drefs') + 1], '0');
      assert.equal(args[args.indexOf('-use_absolute_path') + 1], '0');
      assert.equal(options.timeout, 5000);
      input = args.at(-1);
      await access(input);
      return { stdout: JSON.stringify({ format: { duration: '20' }, streams: [{ codec_type: 'video' }] }) };
    },
    async (_data, duration, _signal, _run, times) => {
      assert.equal(duration, 20);
      assert.deepEqual(times, [3, 10, 17]);
      return times.map(seconds => ({ seconds, data: Buffer.from('frame') }));
    }
  );
  assert.equal(sampled.frames.length, 3);
  await assert.rejects(access(input));
  await assert.rejects(sampleVideoAttachment(Buffer.from('not-video'), signal()), /MP4/);
  await assert.rejects(
    sampleVideoAttachment(mp4, signal(), async () => {
      throw Object.assign(new Error('host path private'), { code: 'ENOENT' });
    }),
    /FFmpeg/
  );
  await assert.rejects(
    sampleVideoAttachment(mp4, signal(), async () => ({ stdout: '{"format":{"duration":"9999"},"streams":[{"codec_type":"video"}]}' })),
    /10 分钟/
  );
});

test('video attachment enters native image input with timestamp and evidence limits', async () => {
  const media = getMediaConfig({});
  assert.equal(hasUnconfiguredMedia([{ Type: 'video' }], media), false);
  assert.equal(hasUnconfiguredMedia([{ Type: 'file', FileName: 'clip.mp4' }], media), false);
  assert.equal(hasUnconfiguredMedia([{ Type: 'file', FileName: 'notes.txt' }], media), true);
  const result = await prepareNativeMedia(
    [{ Type: 'video', Url: 'https://cdn.example/clip.mp4' }],
    '看下视频',
    media,
    signal(),
    async () => mp4,
    async () => ({ duration: 20, frames: [{ seconds: 3, data: Buffer.from('fixture-frame') }] })
  );
  assert.equal(result.filter(x => x.type === 'image').length, 1);
  assert.match(
    result
      .filter(x => x.type === 'text')
      .map(x => x.text)
      .join('\n'),
    /未读取音轨/
  );
  await assert.rejects(prepareNativeMedia([{ Type: 'video' }], '', media, signal()), /平台未提供/);
});

test('link recognition is bounded, deduplicated, does not mistake lookalike hosts or fetch content', () => {
  const result = inspectLinks(
    '看 https://b23.tv/abc。https://example.org/a.mp4?x=1 https://bilibili.com.evil.test/a https://b23.tv/abc https://u:p@example.org/private'
  );
  assert.deepEqual(
    result.links.map(x => x.kind),
    ['bilibili', 'video', 'webpage']
  );
  assert.equal(result.links.length, 3);
  assert.equal(inspectLinks('http://example.org').links[0].readable, false);
  assert.equal(inspectLinks(Array.from({ length: 20 }, (_, i) => `https://example.org/${i}`).join(' ')).links.length, 10);
  assert.match(result.evidence, /未访问/);
  assert.equal(inspectLinks('[说明](https://example.org/wiki/Name_(type))').links[0].url, 'https://example.org/wiki/Name_(type)');
});

test('public URL tool checks web permission again before any network request', async () => {
  const tools = [];
  webModule().setup({ tool: tool => tools.push(tool) });
  const tool = tools.find(x => x.name === 'read_public_url');
  const context = { autonomous: false, capabilities: { web: false }, signal: signal() };
  assert.equal(tool.available(context), false);
  await assert.rejects(tool.execute({ url: 'https://example.org' }, context), /未开放/);
  assert.equal(tool.available({ ...context, autonomous: true, capabilities: { web: true } }), false);
});


test('media capability discovery reserves video generation without exposing provider secrets', async () => {
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: {
    vision: { baseUrl: 'https://private-provider.example/v1', apiKey: 'fixture-secret-do-not-expose', model: 'fixture' }
  } } } };
  try {
    const tools = [];
    mediaCapabilitiesModule().setup({ tool: tool => tools.push(tool) });
    const result = await tools[0].execute({}, { owner: false, autonomous: false });
    assert.equal(result.asr, 'platform_transcript_only');
    assert.equal(result.vision, 'configured');
    assert.equal(result.videoGeneration.enabled, false);
    assert.equal(result.videoGeneration.status, 'reserved');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private-provider/);
    globalThis.__config.value['alemonjs-agent-link'].media = {};
    const withoutVision = await tools[0].execute({}, { owner: false, autonomous: false });
    assert.equal(withoutVision.visionSource, 'main_model_unverified');
    assert.ok(['decoder_missing', 'decoder_present_vision_model_unverified'].includes(withoutVision.videoUnderstanding));

  } finally { globalThis.__config = previous; }
});
