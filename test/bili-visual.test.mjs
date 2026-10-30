import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { extractVideoFrames, videoDownloadUrl, videoSampleTimes, videoSceneSampleTimes } from '../lib/bili/visual.js';
import { createBiliClient, biliOptions } from '../lib/bili/client.js';
import { biliEvidence } from '../lib/bili/evidence.js';
import { describeVideoFrames } from '../lib/media/providers.js';
import { getMediaConfig } from '../lib/media/config.js';

let previous;
beforeEach(() => {
  previous = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        budget: { enabled: false },
        media: {
          vision: { baseUrl: 'https://vision.example/v1', apiKey: 'test', model: 'vision-model' }
        }
      }
    }
  };
});
afterEach(() => {
  globalThis.__config = previous;
});
const signal = () => new AbortController().signal;
const mp4 = Buffer.from([0, 0, 0, 12, ...Buffer.from('ftypisom')]);
const bv = 'BV1234567890';
const nav = { data: { wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } } };
const ok = data => Response.json({ code: 0, data });
const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
const fixture =
  (playback = { durl: [{ url: 'https://v.bilivideo.com/video.mp4' }] }) =>
  async url => {
    if (url.endsWith('/nav')) return Response.json(nav);
    if (url.includes('/wbi/view')) return ok({ bvid: bv, aid: 1, cid: 2, title: '视频', duration: 20 });
    if (url.includes('/playurl')) return ok(playback);
    if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [] } });
    if (url.includes('/reply/')) return ok({ replies: [] });
    throw new Error('unexpected request');
  };

test('visual reading is opt-in and accepts only validated CDN URLs and bounded sample positions', () => {
  assert.equal(biliOptions({}).visualRead, false);
  assert.throws(() => biliOptions({ visualRead: 'yes' }));
  assert.deepEqual(videoSampleTimes(20), [3, 10, 17]);
  for (const n of [0, -1, Infinity, NaN, 86401]) assert.throws(() => videoSampleTimes(n));
  assert.equal(videoDownloadUrl('https://v.bilivideo.com/a').hostname, 'v.bilivideo.com');
  for (const url of [
    'http://v.bilivideo.com/a',
    'https://bilivideo.com.evil.test/a',
    'https://user:pw@v.bilivideo.com/a',
    'https://127.0.0.1/a',
    'file:///tmp/x'
  ])
    assert.throws(() => videoDownloadUrl(url));
});

test('local extraction uses argument arrays, bounded decoding and removes temporary files on success and failure', async () => {
  let directory;
  const frames = await extractVideoFrames(mp4, 20, signal(), async (command, args, options) => {
    assert.equal(command, 'ffmpeg');
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-f') + 1], 'mov');
    assert.equal(options.timeout, args.at(-1) === '-' ? 5000 : 10000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.shell, undefined);
    const input = args[args.indexOf('-i') + 1];
    directory = dirname(input);
    assert.ok(!input.startsWith('https:'));
    if (args.at(-1) === '-') return { stderr: '' };
    await writeFile(args.at(-1), await png());
  });
  assert.deepEqual(
    frames.map(frame => frame.seconds),
    [3, 10, 17]
  );
  assert.equal((await sharp(frames[0].data).metadata()).format, 'png');
  await assert.rejects(access(directory));
  await assert.rejects(
    extractVideoFrames(mp4, 20, signal(), async (_command, args) => {
      directory = dirname(args[args.indexOf('-i') + 1]);
      throw new Error('decoder failed');
    }),
    /decoder failed/
  );
  await assert.rejects(access(directory));
  await assert.rejects(extractVideoFrames(Buffer.from('#EXTM3U'), 20, signal()), /MP4/);
});

test('scene selection spreads cuts over thirds and preserves fallback positions for static sections', () => {
  assert.deepEqual(videoSceneSampleTimes(30, 'pts_time:2 pts_time:3 pts_time:4 pts_time:15 pts_time:27'), [4.1, 15.1, 27.1]);
  assert.deepEqual(videoSceneSampleTimes(30, 'pts_time:2 pts_time:3 pts_time:4'), [4.1, 15, 25.5]);
  assert.deepEqual(videoSceneSampleTimes(30, 'pts_time:0 pts_time:30 pts_time:999 pts_time:NaN'), [4.5, 15, 25.5]);
  assert.deepEqual(videoSceneSampleTimes(30, ''), videoSampleTimes(30));
  assert.deepEqual(videoSceneSampleTimes(30, 'pts_time:9.999 pts_time:9.999 pts_time:29.9999'), [9.999, 15, 29.9999]);
});

test('scene probing changes actual seek positions without increasing the three image budget', async () => {
  const seeks = [];
  let probes = 0;
  const frames = await extractVideoFrames(mp4, 30, signal(), async (_command, args, options) => {
    if (args.at(-1) === '-') {
      probes++;
      assert.equal(options.maxBuffer, 128 * 1024);
      assert.match(args[args.indexOf('-vf') + 1], /fps=2.*scale=160.*scene/);
      return { stderr: 'pts_time:2 pts_time:15 pts_time:27' };
    }
    seeks.push(Number(args[args.indexOf('-ss') + 1]));
    await writeFile(args.at(-1), await png());
  });
  assert.equal(probes, 1);
  assert.deepEqual(seeks, [2.1, 15.1, 27.1]);
  assert.deepEqual(
    frames.map(frame => frame.seconds),
    seeks
  );
});

test('failed scene probe falls back but cancellation never starts frame decoding', async () => {
  const seeks = [];
  await extractVideoFrames(mp4, 20, signal(), async (_command, args) => {
    if (args.at(-1) === '-') throw new Error('probe timed out');
    seeks.push(Number(args[args.indexOf('-ss') + 1]));
    await writeFile(args.at(-1), await png());
  });
  assert.deepEqual(seeks, [3, 10, 17]);
  const controller = new AbortController();
  let directory;
  let calls = 0;
  await assert.rejects(
    extractVideoFrames(mp4, 20, controller.signal, async (_command, args) => {
      calls++;
      directory = dirname(args[args.indexOf('-i') + 1]);
      controller.abort();
      throw new Error('interrupted');
    }),
    { name: 'AbortError' }
  );
  assert.equal(calls, 1);
  await assert.rejects(access(directory));
});

test('watch combines actual extracted frames and vision output without sending cookies to CDN', async () => {
  const image = await png();
  const client = createBiliClient(
    { cookie: 'SESSDATA=secret', timeoutMs: 5000, visualRead: true },
    fixture(),
    async (url, settings, _signal, headers) => {
      assert.equal(url, 'https://v.bilivideo.com/video.mp4');
      assert.deepEqual(settings.allowedHosts, ['v.bilivideo.com']);
      assert.ok(settings.maxBytes <= 32 * 1024 * 1024);
      assert.equal(headers.Cookie, undefined);
      assert.equal(headers.Referer, 'https://www.bilibili.com/');
      return mp4;
    },
    {
      extract: async bytes => {
        assert.deepEqual(bytes, mp4);
        return [
          { seconds: 3, data: image },
          { seconds: 17, data: image }
        ];
      },
      describe: async frames => {
        assert.equal(frames.length, 2);
        return '3秒有红色方块，17秒有蓝色圆形。';
      }
    }
  );
  const result = await client.watch(bv, signal());
  assert.equal(result.visual.status, 'available');
  assert.equal(result.evidence.basis, 'sampled_frames');
  assert.equal(result.evidence.visualObserved, true);
  assert.equal(result.evidence.audioObserved, false);
  assert.deepEqual(result.evidence.sampledTimestamps, [3, 17]);
  assert.match(result.evidence.limitation, /不能推断帧间过程/);
  assert.ok(!JSON.stringify(result).includes(image.toString('base64')));
});

test('failed decoding, missing vision, disallowed sources and partial streams never claim observation', async () => {
  let downloaded = 0;
  const download = async () => {
    downloaded++;
    return mp4;
  };
  const services = {
    extract: async () => {
      throw new Error('ENOENT ffmpeg');
    },
    describe: async () => {
      throw new Error('must not run');
    }
  };
  const options = { cookie: '', timeoutMs: 5000, visualRead: true };
  const failed = await createBiliClient(options, fixture(), download, services).watch(bv, signal());
  assert.equal(failed.visual.failedAt, 'decode');
  assert.equal(failed.evidence.visualObserved, false);
  const attempts = downloaded;
  for (const playback of [{ durl: [{ url: 'https://evil.test/a' }] }, { durl: [{ url: 'https://v.bilivideo.com/a' }, { url: 'https://v.bilivideo.com/b' }] }]) {
    const result = await createBiliClient(options, fixture(playback), download, services).watch(bv, signal());
    assert.equal(result.visual.status, 'unavailable');
    assert.equal(result.evidence.visualObserved, false);
  }
  assert.equal(downloaded, attempts);
  globalThis.__config.value['alemonjs-agent-link'].media = {};
  const unconfigured = await createBiliClient(options, fixture(), download, services).watch(bv, signal());
  assert.equal(unconfigured.visual.status, 'unconfigured');
  assert.equal(downloaded, attempts);
  const disabled = await createBiliClient({ ...options, visualRead: false }, fixture(), download, services).watch(bv, signal());
  assert.equal(disabled.visual.status, 'disabled');
});

test('cancellation while decoding propagates and empty vision never upgrades evidence', async () => {
  const controller = new AbortController();
  const client = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: true }, fixture(), async () => mp4, {
    extract: async () => {
      controller.abort(new Error('cancel video'));
      controller.signal.throwIfAborted();
    },
    describe: async () => 'unexpected'
  });
  await assert.rejects(client.watch(bv, controller.signal), /cancel video/);
  const empty = biliEvidence({ status: 'empty', text: '' }, { status: 'available', items: [] }, { status: 'available', timestamps: [1], description: '' });
  assert.equal(empty.visualObserved, false);
  assert.deepEqual(empty.sampledTimestamps, []);
});

test('vision provider receives frames with positions and returns bounded text via a local HTTP service', async () => {
  let body;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '3秒处可见红色方块。' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    // Inject a local transport fixture; production vision configuration still requires HTTPS.
    const config = { ...getMediaConfig({}), vision: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-vision', apiKey: '' } };
    const text = await describeVideoFrames([{ seconds: 3, data: await png() }], config, signal());
    assert.equal(text, '3秒处可见红色方块。');
    assert.equal(body.model, 'test-vision');
    assert.match(body.messages[0].content, /没有听到音频/);
    assert.match(body.messages[1].content[0].text, /3 秒/);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('real ffmpeg decodes a generated MP4 into three distinct sampled frames', { skip: !process.env.AGENT_LINK_TEST_FFMPEG }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const run = promisify(execFile);
  const executable = process.env.AGENT_LINK_TEST_FFMPEG;
  const root = await mkdtemp(join(tmpdir(), 'agent-link-video-native-'));
  try {
    const path = join(root, 'fixture.mp4');
    const generate = colors =>
      run(
        executable,
        [
          '-nostdin',
          '-loglevel',
          'error',
          ...colors.flatMap(([color, duration]) => ['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=10:d=${duration}`]),
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
    // Red, green and blue thirds make wrong seek positions visible in the result pixels.
    await generate([
      ['red', 1],
      ['green', 1],
      ['blue', 1]
    ]);
    const frames = await extractVideoFrames(await readFile(path), 3, signal(), (_command, args, options) => run(executable, args, options));
    assert.deepEqual(
      frames.map(frame => frame.seconds),
      // Red/green have similar luma: the coarse scene filter misses that cut,
      // so the middle third keeps its fallback. The blue cut is detected.
      [0.45, 1.5, 2.1]
    );
    for (const [index, frame] of frames.entries()) {
      const { data, info } = await sharp(frame.data).raw().toBuffer({ resolveWithObject: true });
      assert.ok(info.width <= 640 && info.height <= 640);
      const rgb = [...data.subarray(0, 3)];
      assert.equal(rgb.indexOf(Math.max(...rgb)), index);
    }
    // Fixed 15/50/85% positions miss the white scene entirely (6–7 seconds).
    // The scene-selected middle frame must actually contain white pixels.
    await generate([
      ['red', 6],
      ['white', 1],
      ['blue', 3]
    ]);
    const changed = await extractVideoFrames(await readFile(path), 10, signal(), (_command, args, options) => run(executable, args, options));
    assert.deepEqual(
      changed.map(frame => frame.seconds),
      [1.5, 6.1, 7.1]
    );
    const white = await sharp(changed[1].data).raw().toBuffer();
    assert.ok([...white.subarray(0, 3)].every(channel => channel > 230));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
