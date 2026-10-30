import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { extractSubtitleStrips } from '../lib/bili/subtitle-visual.js';
import { biliEvidence } from '../lib/bili/evidence.js';
import { createBiliClient } from '../lib/bili/client.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describeVideoFrames } from '../lib/media/providers.js';
import { getMediaConfig } from '../lib/media/config.js';

const mp4 = Buffer.from([0, 0, 0, 12, ...Buffer.from('ftypisom')]);
const signal = () => new AbortController().signal;
const png = color =>
  sharp({ create: { width: 32, height: 8, channels: 3, background: color } })
    .png()
    .toBuffer();

test('subtitle bands retain twelve actual target positions in three ordered bounded boards', async () => {
  let root;
  const seeks = [];
  const frames = await extractSubtitleStrips(mp4, 12, signal(), async (command, args, options) => {
    assert.equal(command, 'ffmpeg');
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.match(args[args.indexOf('-vf') + 1], /^crop=iw:ih\*0.25:0:ih\*0.75,scale=1280:256/);
    assert.equal(options.timeout, 10000);
    assert.equal(options.killSignal, 'SIGKILL');
    root = dirname(args[args.indexOf('-i') + 1]);
    seeks.push(Number(args[args.indexOf('-ss') + 1]));
    await writeFile(args.at(-1), await png(['red', 'green', 'blue'][Math.floor((seeks.length - 1) / 4)]));
  });
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.flatMap(frame => frame.positions),
    seeks
  );
  assert.deepEqual(
    seeks,
    Array.from({ length: 12 }, (_, index) => index + 0.5)
  );
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.region, 'bottom_band');
    const { data, info } = await sharp(frame.data).raw().toBuffer({ resolveWithObject: true });
    assert.ok(info.width <= 1280 && info.height <= 1030);
    const rgb = [...data.subarray(0, 3)];
    assert.equal(rgb.indexOf(Math.max(...rgb)), index);
  }
  await assert.rejects(access(root));
  const evidence = biliEvidence(
    { status: 'not_available', text: '' },
    { status: 'unavailable', items: [] },
    {
      status: 'available',
      description: '采样文字',
      region: 'bottom_band',
      timestamps: seeks
    }
  );
  assert.equal(evidence.visualObserved, true);
  assert.equal(evidence.visualRegion, 'bottom_band');
  assert.equal(evidence.audioObserved, false);
  assert.match(evidence.limitation, /不能拼成全片台词/);
  assert.equal(
    biliEvidence({ status: 'empty', text: '' }, { status: 'empty', items: [] }, { status: 'available', description: 'x', timestamps: seeks }).visualObserved,
    false
  );
});

test('subtitle extraction cancels and removes partial output without returning partial evidence', async () => {
  let root;
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(
    extractSubtitleStrips(mp4, 12, controller.signal, async (_command, args) => {
      calls++;
      root = dirname(args[args.indexOf('-i') + 1]);
      if (calls === 2) {
        controller.abort();
        throw new Error('interrupted');
      }
      await writeFile(args.at(-1), await png('red'));
    }),
    { name: 'AbortError' }
  );
  assert.equal(calls, 2);
  await assert.rejects(access(root));
  await assert.rejects(extractSubtitleStrips(Buffer.from('not-video'), 12, signal()), /MP4/);
});

test('a decoder returning no image cannot contribute a phantom subtitle observation', async () => {
  let calls = 0;
  const frames = await extractSubtitleStrips(mp4, 12, signal(), async (_command, args) => {
    calls++;
    if (calls === 12) return;
    await writeFile(args.at(-1), await png('red'));
  });
  assert.equal(calls, 12);
  assert.equal(frames.flatMap(frame => frame.positions).length, 11);
  assert.equal(frames.at(-1).positions.includes(11.5), false);
  const empty = await extractSubtitleStrips(mp4, 12, signal(), async () => {});
  assert.deepEqual(empty, []);
});

test('vision transport labels chronological cropped rows and never presents them as full frames', async () => {
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  let body;
  let truncated = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '0.5秒可见“测试”，其他行看不清。' }, finish_reason: truncated ? 'length' : 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const media = { ...getMediaConfig({}), vision: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', apiKey: '' } };
    const image = { seconds: 0.5, positions: [0.5, 1.5, 2.5, 3.5], region: 'bottom_band', data: await png('red') };
    const result = await describeVideoFrames([image], media, signal());
    assert.match(result, /看不清/);
    assert.equal(body.max_tokens, 1200);
    assert.match(body.messages[0].content, /不能把字幕拼成完整台词/);
    assert.match(body.messages[1].content[0].text, /底部25%.*从上到下.*0.5、1.5、2.5、3.5/);
    assert.equal(body.messages[1].content.filter(part => part.type === 'image_url').length, 1);
    truncated = true;
    await assert.rejects(describeVideoFrames([image], media, signal()), /被服务截断/);
    await assert.rejects(describeVideoFrames([{ ...image, positions: [Infinity] }], media, signal()), /无效/);
    await assert.rejects(describeVideoFrames([{ ...image, positions: [1, 2, 3, 4, 5] }], media, signal()), /无效/);
  } finally {
    globalThis.__config = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('watch focus selects one extraction path and preserves crop scope in evidence', async () => {
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { vision: { baseUrl: 'https://test.example', apiKey: 'test', model: 'test' } } } } };
  const ok = data => Response.json({ code: 0, data });
  let downloads = 0;
  const fetcher = async url => {
    if (url.endsWith('/nav'))
      return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
    if (url.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, duration: 12 });
    if (url.includes('/playurl')) return ok({ durl: [{ url: 'https://v.bilivideo.com/test.mp4' }] });
    return ok({});
  };
  try {
    const client = createBiliClient(
      { cookie: '', timeoutMs: 5000, visualRead: true },
      fetcher,
      async () => {
        downloads++;
        return mp4;
      },
      {
        extract: async () => {
          throw new Error('must not extract full frames');
        },
        extractSubtitles: async () => [{ seconds: 0.5, positions: [0.5, 1.5, 2.5, 3.5], region: 'bottom_band', data: await png('red') }],
        describe: async frames => {
          assert.equal(frames[0].region, 'bottom_band');
          return '底部可见文字';
        }
      }
    );
    const result = await client.watch('BV1234567890', signal(), 'subtitles');
    assert.equal(downloads, 1);
    assert.equal(result.visual.region, 'bottom_band');
    assert.deepEqual(result.evidence.sampledTimestamps, [0.5, 1.5, 2.5, 3.5]);
    assert.equal(result.evidence.visualObserved, true);
    await assert.rejects(client.watch('BV1234567890', signal(), 'invalid'), /方式无效/);
    assert.equal(downloads, 1);
  } finally {
    globalThis.__config = previous;
  }
});

test('real ffmpeg crops only bottom bands and composites the chronological colors', { skip: !process.env.AGENT_LINK_TEST_FFMPEG }, async () => {
  const run = promisify(execFile);
  const executable = process.env.AGENT_LINK_TEST_FFMPEG;
  const root = await mkdtemp(join(tmpdir(), 'agent-link-subtitle-native-'));
  try {
    const path = join(root, 'fixture.mp4');
    await run(
      executable,
      [
        '-nostdin',
        '-loglevel',
        'error',
        ...['red', 'green', 'blue'].flatMap(color => [
          '-f',
          'lavfi',
          '-i',
          `color=white:s=1280x720:r=2:d=4,drawbox=x=0:y=ih*0.75:w=iw:h=ih*0.25:color=${color}:t=fill`
        ]),
        '-filter_complex',
        '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
        '-map',
        '[out]',
        '-c:v',
        'mpeg4',
        '-y',
        path
      ],
      { timeout: 10000 }
    );
    const frames = await extractSubtitleStrips(await readFile(path), 12, signal(), (_command, args, options) => run(executable, args, options));
    assert.equal(frames.length, 3);
    assert.deepEqual(
      frames.flatMap(frame => frame.positions),
      Array.from({ length: 12 }, (_, index) => index + 0.5)
    );
    for (const [index, frame] of frames.entries()) {
      const { data, info } = await sharp(frame.data).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 1280);
      assert.equal(info.height, frame.positions.length * 182 - 2);
      for (let row = 0; row < frame.positions.length; row++) {
        const offset = ((row * 182 + 90) * info.width + 640) * info.channels;
        const rgb = [...data.subarray(offset, offset + 3)];
        assert.equal(rgb.indexOf(Math.max(...rgb)), index);
        assert.ok(Math.min(...rgb) < 50, 'white upper scene must not be present');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
