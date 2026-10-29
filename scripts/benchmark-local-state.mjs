// Usage: node scripts/benchmark-local-state.mjs [absolute path to baseline module]
// Uses temporary snapshots only; never opens application data.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getLocalStore } from '../lib/state/local-store.js';

const baseline = process.argv[2] ? (await import(pathToFileURL(resolve(process.argv[2])).href)).getLocalStore : null;
const root = await mkdtemp(join(tmpdir(), 'agent-link-storage-benchmark-'));
const entries = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key-${i}`, { value: 'x'.repeat(200) }]));
const snapshot = JSON.stringify({ version: 1, entries });
const iterations = 50;
const results = { current: { noop: [], write: [] }, baseline: { noop: [], write: [] } };
for (let round = 0; round < 5; round++) {
  const variants = [['current', getLocalStore], ...(baseline ? [['baseline', baseline]] : [])];
  if (round % 2) variants.reverse();
  for (const [name, open] of variants) {
    const path = join(root, `${name}-${round}.json`);
    await writeFile(path, snapshot);
    const store = await open(path);
    for (const kind of ['noop', 'write']) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        if (kind === 'noop') await store.set('key-0', 'duplicate', 'NX');
        else await store.set('key-0', String(i));
      }
      results[name][kind].push(Number((performance.now() - start).toFixed(2)));
    }
  }
}
console.log(JSON.stringify({ keys: 1000, iterations, snapshotBytes: Buffer.byteLength(snapshot), results, temporaryDirectory: root }, null, 2));
// Stores hold ownership locks until process exit. Remove the printed directory afterwards.
