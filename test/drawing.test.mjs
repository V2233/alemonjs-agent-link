import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingSvg, renderDrawing, drawingTool } from '../lib/media/drawing.js';

const drawing = {
  width: 256,
  height: 256,
  background: '#e8f6ff',
  elements: [
    { type: 'ellipse', x: 128, y: 140, rx: 85, ry: 55, fill: '#4098da' },
    { type: 'path', d: 'M50 140 L12 110 L12 170 Z', fill: '#4098da' },
    { type: 'circle', x: 173, y: 126, radius: 8, fill: '#ffffff' },
    { type: 'circle', x: 175, y: 126, radius: 4, fill: '#18304d' },
    { type: 'text', x: 76, y: 230, fontSize: 24, text: '大肥鱼', fill: '#18304d' }
  ]
};
test('drawing renders actual PNG with requested dimensions', async () => {
  const png = await renderDrawing(drawing, new AbortController().signal);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.ok(png.length > 1000);
});
test('scene cannot inject executable SVG, references or excessive geometry', async () => {
  const svg = drawingSvg({ elements: [{ type: 'text', text: '<script>alert(1)</script>' }] });
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  for (const args of [
    { width: 99999, elements: drawing.elements },
    { elements: [{ type: 'image', href: 'file:///etc/passwd' }] },
    { elements: [{ type: 'path', d: 'url(https://evil.invalid)' }] },
    { elements: [{ type: 'rect', fill: 'url(https://evil.invalid)' }] },
    { elements: Array.from({ length: 257 }, () => ({ type: 'circle' })) },
    { elements: [{ type: 'circle', x: Infinity }] }
  ])
    assert.throws(() => drawingSvg(args));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderDrawing(drawing, controller.signal));
});
test('tool queues real image output, reports failure honestly and excludes autonomous turns', async () => {
  let delivered;
  const tool = drawingTool(async png => {
    delivered = png;
  });
  assert.equal(tool.available({ autonomous: true }), false);
  const result = await tool.execute(drawing, { signal: new AbortController().signal });
  assert.equal(result.created, true);
  assert.equal(result.delivery, 'queued-for-this-reply');
  assert.ok(Buffer.isBuffer(delivered));
  await assert.rejects(
    drawingTool(async () => {
      throw new Error('delivery queue unavailable');
    }).execute(drawing, { signal: new AbortController().signal }),
    /queue unavailable/
  );
});

test('renderer isolates worker flags from ESM/dev-server parent arguments', async () => {
  const moduleUrl = new URL('../lib/media/drawing.js', import.meta.url).href;
  const code = `import {renderDrawing} from ${JSON.stringify(moduleUrl)}; const png=await renderDrawing({width:64,height:64,elements:[{type:'circle',x:32,y:32,radius:20}]},new AbortController().signal); console.log(png.readUInt32BE(16));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 20000 });
  assert.equal(stdout.trim(), '64');
});
