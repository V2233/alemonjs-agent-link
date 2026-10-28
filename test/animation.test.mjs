import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { getMediaConfig } from '../lib/media/config.js';
import { animationFrames } from '../lib/media/animation.js';
import { prepareNativeMedia } from '../lib/media/providers.js';

const animatedGif = async () => {
  const width = 4;
  const height = 4;
  const red = Buffer.alloc(width * height * 4);
  const blue = Buffer.alloc(width * height * 4);

  for (let index = 0; index < width * height; index++) {
    red[index * 4] = 255;
    red[index * 4 + 3] = 255;
    blue[index * 4 + 2] = 255;
    blue[index * 4 + 3] = 255;
  }

  return await sharp(Buffer.concat([red, blue]), { raw: { width, height: height * 2, channels: 4, pageHeight: height } })
    .gif()
    .toBuffer();
};

test('animated GIF is decoded into bounded JPEG frames', async () => {
  const gif = await animatedGif();
  const frames = await animationFrames(gif, 3);

  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(frame => frame.index), [0, 1]);
  for (const frame of frames) {
    assert.equal(frame.mimeType, 'image/jpeg');
    assert.ok(frame.data.length > 16);
    assert.equal(Buffer.from(frame.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  }
});

test('native media input sends multiple GIF frames instead of a single animation block', async () => {
  const gif = await animatedGif();
  const input = await prepareNativeMedia(
    [{ Type: 'animation', _onebotImage: gif.toString('base64') }],
    '看看这个动图',
    getMediaConfig({ media: { maxAttachments: 2, maxBytes: 1024 * 1024 } }),
    new AbortController().signal
  );

  assert.ok(Array.isArray(input));
  assert.equal(input[0].type, 'text');
  const images = input.filter(part => part.type === 'image');
  assert.equal(images.length, 2);
  assert.ok(images.every(part => part.mimeType === 'image/jpeg' && part.data.length > 16));
});
