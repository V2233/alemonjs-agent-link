import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { extractStoryboardFrames, storyboardUrl } from '../lib/bili/storyboard.js';
import { createBiliClient } from '../lib/bili/client.js';
import { getMediaConfig } from '../lib/media/config.js';
import { biliEvidence } from '../lib/bili/evidence.js';
import { readingDiary } from '../lib/bili/diary.js';

let previous;
beforeEach(() => {
  previous = globalThis.__config;
  globalThis.__config = {
    value: { 'alemonjs-agent-link': { media: { vision: { baseUrl: 'https://vision.example/v1', apiKey: 'fixture', model: 'fixture' } } } }
  };
});
afterEach(() => {
  globalThis.__config = previous;
});
const signal = () => new AbortController().signal;
const spec = () => ({
  img_x_len: 2,
  img_y_len: 2,
  img_x_size: 8,
  img_y_size: 8,
  image: [0, 1, 2].map(i => `https://bimp.hdslb.com/${i}.png`),
  index: Array.from({ length: 12 }, (_, i) => i * 2)
});
const sheet = async (number = 0) =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } })
    .composite(
      await Promise.all(
        Array.from({ length: 4 }, async (_, tile) => ({
          left: (tile % 2) * 8,
          top: Math.floor(tile / 2) * 8,
          input: await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: (number * 4 + tile) * 17, g: (number * 4 + tile) * 11, b: (number * 4 + tile) * 7 } }
          })
            .png()
            .toBuffer()
        }))
      )
    )
    .png()
    .toBuffer();

test('storyboard crops exact indexed tiles across sheets in chronological order without ffmpeg or cookies', async () => {
  const downloads = [];
  const frames = await extractStoryboardFrames(spec(), 24, getMediaConfig(), signal(), async (url, settings, _signal, headers) => {
    downloads.push(url);
    assert.ok(settings.maxBytes <= 4 * 1024 * 1024);
    assert.deepEqual(settings.allowedHosts, ['bimp.hdslb.com']);
    assert.equal(headers.Cookie, undefined);
    return sheet(Number(new URL(url).pathname.slice(1, 2)));
  });
  assert.deepEqual(
    frames.map(frame => frame.seconds),
    [2, 4, 6, 8, 10, 14, 16, 18, 20]
  );
  assert.equal(downloads.length, 3);
  for (const [n, frame] of frames.entries()) {
    const index = [1, 2, 3, 4, 5, 7, 8, 9, 10][n];
    const { data, info } = await sharp(frame.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 8);
    assert.equal(info.height, 8);
    assert.deepEqual([...data.subarray(0, 3)], [index * 17, index * 11, index * 7]);
    assert.equal(frame.source, 'storyboard');
  }
});

test('one sheet is fetched once, index times may be milliseconds, and duplicate times do not multiply frames', async () => {
  let downloads = 0;
  const snapshot = { ...spec(), image: spec().image.slice(0, 1), index: [0, 0, 10000, 20000] };
  const frames = await extractStoryboardFrames(snapshot, 20, getMediaConfig(), signal(), async () => {
    downloads++;
    return sheet();
  });
  assert.deepEqual(
    frames.map(frame => frame.seconds),
    [0, 10, 20]
  );
  assert.equal(downloads, 1);
  // Long videos already expressed in seconds must not be scaled down.
  const long = await extractStoryboardFrames({ ...snapshot, index: [0, 7000, 14000, 21000] }, 22000, getMediaConfig(), signal(), () => sheet());
  assert.ok(long.at(-1).seconds >= 14000);
});

test('empty JSON index uses bounded big-endian pvdata; never guesses timestamps', async () => {
  const bytes = Buffer.alloc(8);
  [0, 5, 10, 15].forEach((time, n) => bytes.writeUInt16BE(time, n * 2));
  const frames = await extractStoryboardFrames(
    { ...spec(), image: spec().image.slice(0, 1), index: [], pvdata: '//bimp.hdslb.com/times.bin' },
    20,
    getMediaConfig(),
    signal(),
    async (url, settings) => {
      if (url.endsWith('.bin')) {
        assert.ok(settings.maxBytes <= 40000);
        return bytes;
      }
      return sheet();
    }
  );
  assert.deepEqual(
    frames.map(frame => frame.seconds),
    [0, 5, 10, 15]
  );
  await assert.rejects(() =>
    extractStoryboardFrames({ ...spec(), index: [] }, 20, getMediaConfig(), signal(), () => {
      throw new Error('must not download');
    })
  );
});

test('invalid URLs, grid sizes and timestamp ranges are rejected before image downloads', async () => {
  for (const url of [
    'https://hdslb.com.evil.test/x',
    'http://bimp.hdslb.com/x',
    'https://user:pw@bimp.hdslb.com/x',
    'https://127.0.0.1/x',
    'https://bimp.hdslb.com:444/x'
  ])
    assert.throws(() => storyboardUrl(url));
  assert.equal(storyboardUrl('//bimp.hdslb.com/a').protocol, 'https:');
  for (const change of [
    { img_x_len: 0 },
    { img_y_size: 99999 },
    { index: [0, -1] },
    { index: [10, 0] },
    { index: [0, '5'] },
    { index: [0, 25000] },
    { image: [] },
    { index: Array(20001).fill(0) }
  ]) {
    await assert.rejects(() =>
      extractStoryboardFrames({ ...spec(), ...change }, 24, getMediaConfig(), signal(), () => {
        assert.fail('invalid metadata must not cause a download');
      })
    );
  }
});

test('mismatched images, SVG, oversized data and cancellation never return observed frames', async () => {
  for (const bytes of [
    Buffer.from('<svg/>'),
    Buffer.alloc(4 * 1024 * 1024 + 1),
    await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
  ]) {
    await assert.rejects(() => extractStoryboardFrames(spec(), 24, getMediaConfig(), signal(), async () => bytes));
  }
  const controller = new AbortController();
  await assert.rejects(
    () =>
      extractStoryboardFrames(spec(), 24, getMediaConfig(), controller.signal, async () => {
        controller.abort();
        return sheet();
      }),
    { name: 'AbortError' }
  );
});

for (const failure of ['playback', 'download', 'decode', 'missing-decoder']) {
  test(`watch falls back after ${failure} failure and preserves approximate preview provenance`, async () => {
    let descriptions = 0,
      downloads = 0,
      playbacks = 0,
      decodes = 0;
    const ok = data => Response.json({ code: 0, data });
    const nav = { wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } };
    const fetcher = async url => {
      if (url.endsWith('/nav')) return ok(nav);
      if (url.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, title: '多P视频', duration: 120, pages: [{ duration: 24 }] });
      if (url.includes('/playurl')) {
        playbacks++;
        return ok(failure === 'playback' ? { dash: {} } : { durl: [{ url: 'https://v.bilivideo.com/a.mp4' }] });
      }
      if (url.includes('/videoshot?')) {
        assert.match(url, /cid=2/);
        return ok(spec());
      }
      if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [] } });
      if (url.includes('/reply/')) return ok({ replies: [] });
      throw new Error('unexpected API');
    };
    const client = createBiliClient(
      { visualRead: true, timeoutMs: 5000, cookie: 'SESSDATA=fixture' },
      fetcher,
      async url => {
        if (url.endsWith('.mp4')) {
          if (failure === 'download') throw new Error('download failed');
          return Buffer.from('fixture');
        }
        downloads++;
        return sheet(Number(new URL(url).pathname.slice(1, 2)));
      },
      {
        canDecode: async () => failure !== 'missing-decoder',
        extract: async (_bytes, duration) => {
          decodes++;
          assert.equal(duration, 24);
          throw new Error('no ffmpeg');
        },
        describe: async frames => {
          descriptions++;
          assert.equal(frames.length, 3);
          return '预览中可见色块。';
        }
      }
    );
    const result = await client.watch('BV1234567890', signal());
    assert.equal(descriptions, 1);
    assert.equal(downloads, 3);
    if (failure === 'missing-decoder') {
      assert.equal(playbacks, 0);
      assert.equal(decodes, 0);
    }
    assert.equal(result.visual.status, 'available');
    assert.equal(result.visual.source, 'storyboard');
    assert.equal(result.evidence.visualSource, 'storyboard');
    assert.deepEqual(result.evidence.sampledTimestamps, [2, 4, 6, 8, 10, 14, 16, 18, 20]);
    assert.match(result.evidence.limitation, /低清预览/);
    assert.match(result.evidence.limitation, /第1分P/);
    assert.equal(result.evidence.audioObserved, false);
    const evidence = readingDiary(
      [
        {
          id: 'source',
          origin: 'event',
          kind: 'event',
          status: 'active',
          createdAt: Date.now(),
          tags: ['B站'],
          text: JSON.stringify({
            contentBasis: result.evidence.basis,
            visualStatus: result.visual.status,
            visualSource: result.evidence.visualSource,
            visualRegion: result.evidence.visualRegion,
            sampledTimestamps: result.evidence.sampledTimestamps
          })
        }
      ],
      24
    )[0].sourceEvidence[0];
    assert.equal(evidence.visualSource, 'storyboard');
  });
}

test('unavailable preview metadata does not certify observation', () => {
  const evidence = biliEvidence(
    { status: 'empty', text: '' },
    { status: 'unavailable', items: [] },
    { status: 'unavailable', source: 'storyboard', timestamps: [], description: '' }
  );
  assert.equal(evidence.visualObserved, false);
  assert.equal(evidence.visualSource, undefined);
});

test('nine-point previews bound all sheet downloads together rather than multiplying the byte budget', async () => {
  let downloads = 0;
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const padded = Buffer.concat([image, Buffer.alloc(4 * 1024 * 1024 - image.length)]);
  const snapshot = {
    img_x_len: 1,
    img_y_len: 1,
    img_x_size: 8,
    img_y_size: 8,
    index: Array.from({ length: 9 }, (_, index) => index * 10),
    image: Array.from({ length: 9 }, (_, index) => `https://bimp.hdslb.com/${index}.png`)
  };
  await assert.rejects(
    extractStoryboardFrames(snapshot, 90, { ...getMediaConfig(), maxBytes: 4 * 1024 * 1024 }, signal(), async () => {
      downloads++;
      return padded;
    }),
    /总下载超限/
  );
  assert.equal(downloads, 8);
});

for (const scenario of ['vision-failure', 'subtitle-failure', 'cancelled']) {
  test(`${scenario} does not start a storyboard retry`, async () => {
    const controller = new AbortController();
    let previews = 0,
      descriptions = 0;
    const ok = data => Response.json({ code: 0, data });
    const image = await sheet();
    const fetcher = async url => {
      if (url.endsWith('/nav'))
        return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
      if (url.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, duration: 20 });
      if (url.includes('/playurl')) return ok({ durl: [{ url: 'https://v.bilivideo.com/a.mp4' }] });
      if (url.includes('/videoshot')) {
        previews++;
        return ok(spec());
      }
      if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [] } });
      if (url.includes('/reply/')) return ok({ replies: [] });
      throw new Error('unexpected request');
    };
    const extract = async () => {
      if (scenario === 'cancelled') {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      if (scenario === 'subtitle-failure') throw new Error('decode failed');
      return [{ seconds: 1, data: image }];
    };
    const client = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: true }, fetcher, async () => Buffer.from('fixture'), {
      extract,
      extractSubtitles: extract,
      describe: async () => {
        descriptions++;
        throw new Error('vision failed');
      }
    });
    const run = () => client.watch('BV1234567890', controller.signal, scenario === 'subtitle-failure' ? 'subtitles' : 'frames');
    if (scenario === 'cancelled') await assert.rejects(run, { name: 'AbortError' });
    else {
      const result = await run();
      assert.equal(result.evidence.visualObserved, false);
      assert.equal(result.visual.status, 'unavailable');
    }
    assert.equal(previews, 0);
    assert.equal(descriptions, scenario === 'vision-failure' ? 1 : 0);
  });
}

test('vision prompt separates approximate preview descriptions from hard-subtitle transcription', async () => {
  const { describeVideoFrames } = await import('../lib/media/providers.js');
  const data = await sheet();
  for (const source of ['storyboard', 'video', 'bottom_band']) {
    const frame = { seconds: 25, data, ...(source === 'storyboard' ? { source } : source === 'bottom_band' ? { region: source, positions: [25] } : {}) };
    const result = await describeVideoFrames([frame], getMediaConfig(), signal(), async (_settings, _path, body) => {
      const request = JSON.parse(body);
      const system = request.messages[0].content;
      assert.match(system, /没有听到音频/);
      if (source === 'storyboard') {
        assert.match(system, /约X秒/);
        assert.match(system, /不能据此说点击了、弹出了、保存了/);
        assert.match(system, /画面文字/);
        assert.ok(!system.includes('字幕带逐行'));
        assert.match(request.messages[1].content[0].text, /索引约 25/);
      } else if (source === 'bottom_band') {
        assert.match(system, /字幕带逐行/);
        assert.ok(!system.includes('故事板'));
        assert.equal(request.max_tokens, 1200);
      } else {
        assert.ok(!system.includes('故事板'));
        assert.match(system, /静态界面不能证明/);
      }
      return Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '约25秒：可见设置窗口。' } }] }));
    });
    assert.equal(result, '约25秒：可见设置窗口。');
  }
});
