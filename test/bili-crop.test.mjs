import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { visualCropRequest, cropPixels } from '../lib/bili/crop.js';
import { extractVideoFrames } from '../lib/bili/visual.js';
import { extractStoryboardFrames } from '../lib/bili/storyboard.js';
import { createBiliClient } from '../lib/bili/client.js';
import { getMediaConfig } from '../lib/media/config.js';
import { describeVideoFrames } from '../lib/media/providers.js';
import { biliEvidence } from '../lib/bili/evidence.js';
import { readingDiary } from '../lib/bili/diary.js';
import { biliModule } from '../lib/modules/bili.js';

const signal = () => new AbortController().signal;
const crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
const mp4 = Buffer.from([0, 0, 0, 12, ...Buffer.from('ftypisom')]);
const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
const ok = data => Response.json({ code: 0, data });
const fixture = async url => {
  if (url.endsWith('/nav'))
    return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
  if (url.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, title: 'fixture', duration: 20 });
  if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [] } });
  if (url.includes('/reply/')) return ok({ replies: [] });
  if (url.includes('/playurl')) return ok({ durl: [{ url: 'https://v.bilivideo.com/a.mp4' }] });
  throw new Error('unexpected request');
};

test('crop bounds reject unknown fields, nonfinite values, tiny or out-of-frame regions', () => {
  assert.equal(visualCropRequest(undefined), undefined);
  assert.deepEqual(visualCropRequest(crop), crop);
  assert.deepEqual(cropPixels(7, 3, { x: 0.9, y: 0.9, width: 0.1, height: 0.1 }), { left: 6, top: 2, width: 1, height: 1 });
  for (const bad of [
    null,
    [],
    'crop',
    {},
    { ...crop, path: 'x' },
    { ...crop, x: NaN },
    { ...crop, y: Infinity },
    { ...crop, width: '0.5' },
    { ...crop, height: 0.001 },
    { ...crop, x: -1 },
    { ...crop, x: 0.8 },
    { ...crop, y: 1 }
  ])
    assert.throws(() => visualCropRequest(bad));
});

test('video crops before scaling, requires explicit points and removes temporary input', async () => {
  let root,
    calls = 0;
  const frames = await extractVideoFrames(
    mp4,
    20,
    signal(),
    async (_command, args) => {
      calls++;
      root = dirname(args.at(-1));
      assert.equal(args[args.indexOf('-ss') + 1], '2');
      assert.equal(args[args.indexOf('-vf') + 1], 'crop=iw*0.5:ih*1:iw*0.5:ih*0,scale=640:640:force_original_aspect_ratio=decrease');
      await writeFile(args.at(-1), await png());
    },
    [2],
    crop
  );
  assert.equal(calls, 1);
  assert.equal(frames[0].region, 'crop');
  assert.deepEqual(frames[0].crop, crop);
  await assert.rejects(access(root));
  await assert.rejects(
    extractVideoFrames(mp4, 20, signal(), () => assert.fail('invalid crop must not decode'), undefined, crop),
    /指定采样/
  );
});

test('preview crop retains actual indexed time and approximate source while removing the other half', async () => {
  const red = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const image = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'blue' } })
    .composite([{ input: red, left: 0, top: 0 }])
    .png()
    .toBuffer();
  const snapshot = { img_x_len: 1, img_y_len: 1, img_x_size: 16, img_y_size: 8, image: ['https://bimp.hdslb.com/a.png'], index: [0] };
  const frames = await extractStoryboardFrames(snapshot, 20, getMediaConfig({}), signal(), async () => image, [2], crop);
  assert.equal(frames[0].seconds, 0);
  assert.equal(frames[0].source, 'storyboard');
  assert.equal(frames[0].region, 'crop');
  assert.deepEqual(frames[0].crop, crop);
  const { data, info } = await sharp(frames[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 8);
  assert.equal(info.height, 8);
  for (let index = 0; index < data.length; index += 3) assert.deepEqual([...data.subarray(index, index + 3)], [0, 0, 255]);
});

test('normal watch forwards crop and higher-quality request; invalid requests and disabled reads cannot enable decoding', async () => {
  const previous = globalThis.__config;
  globalThis.__config = {
    value: { 'alemonjs-agent-link': { media: { vision: { baseUrl: 'https://fixture.example/v1', apiKey: 'fixture', model: 'fixture' } } } }
  };
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    return fixture(url);
  };
  try {
    const client = createBiliClient({ visualRead: true, cookie: '', timeoutMs: 5000 }, fetcher, async () => mp4, {
      extract: async (_data, duration, _signal, _execute, at, region) => {
        assert.equal(duration, 20);
        assert.deepEqual(at, [2]);
        assert.deepEqual(region, crop);
        return [{ seconds: 2, data: await png(), region: 'crop', crop: region }];
      },
      describe: async frames => {
        assert.deepEqual(frames[0].crop, crop);
        return '局部蓝色。';
      }
    });
    const result = await client.watch('BV1234567890', signal(), 'frames', [2], undefined, crop);
    assert.equal(new URL(requests.find(url => url.includes('/playurl'))).searchParams.get('qn'), '64');
    assert.equal(result.visual.region, 'crop');
    assert.deepEqual(result.evidence.visualCrop, crop);
    assert.deepEqual(result.evidence.sampledTimestamps, [2]);
    assert.match(result.evidence.limitation, /框外/);
    const before = requests.length;
    await assert.rejects(client.watch('BV1234567890', signal(), 'frames', undefined, undefined, crop), /visualAt/);
    await assert.rejects(client.watch('BV1234567890', signal(), 'subtitles', [2], undefined, crop), /frames/);
    assert.equal(requests.length, before);
    const disabled = createBiliClient({ visualRead: false, cookie: '', timeoutMs: 5000 }, fixture, () => assert.fail('disabled must not download'));
    assert.equal((await disabled.watch('BV1234567890', signal(), 'frames', [2], undefined, crop)).visual.status, 'disabled');
  } finally {
    globalThis.__config = previous;
  }
});

test('vision request and later reading evidence retain crop scope and reject missing provenance', async () => {
  const frame = { seconds: 2, data: await png(), region: 'crop', crop };
  const description = await describeVideoFrames([frame], { vision: { model: 'fixture' } }, signal(), async (_provider, _path, bytes) => {
    const body = JSON.parse(bytes);
    assert.equal(body.max_tokens, 600);
    assert.match(body.messages[0].content, /不含框外内容/);
    assert.match(body.messages[1].content[0].text, /相对裁剪框/);
    return Buffer.from(JSON.stringify({ choices: [{ message: { content: '局部蓝色。' } }] }));
  });
  const visual = { status: 'available', region: 'crop', crop, timestamps: [2], description };
  const evidence = biliEvidence({ status: 'empty', text: '' }, { status: 'available', items: [] }, visual);
  assert.equal(evidence.visualObserved, true);
  assert.equal(evidence.visualRegion, 'crop');
  assert.deepEqual(evidence.visualCrop, crop);
  const diary = readingDiary(
    [
      {
        id: 'source',
        origin: 'event',
        kind: 'event',
        status: 'active',
        createdAt: Date.now(),
        tags: ['B站'],
        text: JSON.stringify({
          contentBasis: evidence.basis,
          visualStatus: visual.status,
          visualRegion: evidence.visualRegion,
          visualCrop: evidence.visualCrop,
          sampledTimestamps: evidence.sampledTimestamps
        })
      }
    ],
    24
  );
  assert.equal(diary[0].sourceEvidence[0].visualScope, 'crop');
  assert.deepEqual(diary[0].sourceEvidence[0].visualCrop, crop);
  assert.equal(biliEvidence({ status: 'empty', text: '' }, { status: 'available', items: [] }, { ...visual, crop: undefined }).visualObserved, false);
  await assert.rejects(
    describeVideoFrames([frame, { ...frame, region: undefined, crop: undefined }], { vision: { model: 'fixture' } }, signal(), () =>
      assert.fail('mixed observation scope')
    )
  );
});

test('bili tool exposes bounded crop parameters without changing read permissions or accepting subtitle crops', async () => {
  const tools = [],
    previous = globalThis.fetch;
  globalThis.fetch = fixture;
  biliModule().setup({ settings: { visualRead: false }, tool: tool => tools.push(tool), on() {} });
  try {
    const tool = tools.find(item => item.name === 'bili_watch');
    assert.equal(tool.parameters.properties.visualCrop.additionalProperties, false);
    assert.equal(tool.parameters.properties.visualCrop.properties.width.minimum, 0.01);
    const context = { userText: '', signal: signal(), private: true, owner: false };
    assert.equal((await tool.execute({ link: 'BV1234567890', visualAt: [2], visualCrop: crop }, context)).visual.status, 'disabled');
    assert.equal((await tool.execute({ link: 'BV1234567890', visualFocus: 'subtitles', visualAt: [2], visualCrop: crop }, context)).ok, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test('real source-resolution ffmpeg crop contains only the requested half of a 720p frame', { skip: !process.env.AGENT_LINK_TEST_FFMPEG }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-crop-native-')),
    run = promisify(execFile),
    executable = process.env.AGENT_LINK_TEST_FFMPEG;
  try {
    const path = join(root, 'source.mp4');
    await run(
      executable,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=1280x720:r=5:d=2,drawbox=x=640:y=0:w=640:h=720:color=blue:t=fill',
        '-c:v',
        'mpeg4',
        '-threads',
        '1',
        '-y',
        path
      ],
      { timeout: 10000 }
    );
    const frames = await extractVideoFrames(await readFile(path), 2, signal(), (_command, args, options) => run(executable, args, options), [0.5], crop);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].region, 'crop');
    const { data, info } = await sharp(frames[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.ok(info.height <= 640 && info.width <= 640);
    for (let index = 0; index < data.length; index += 3) assert.ok(data[index] < 10 && data[index + 2] > 240);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
