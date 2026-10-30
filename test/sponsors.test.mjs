import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSponsors } from '../lib/sponsors/config.js';
const item = { id: 'demo', title: '赞助者', content: '', enabled: true };
test('sponsors are opt-in and keep display order', () => {
  assert.deepEqual(parseSponsors(), { enabled: false, items: [] });
  assert.deepEqual(
    parseSponsors({ enabled: true, items: [item, { ...item, id: 'second' }] }).items.map(x => x.id),
    ['demo', 'second']
  );
});
test('sponsor config rejects duplicate identities, invalid fields and unsafe URLs even while disabled', () => {
  assert.throws(() => parseSponsors({ items: [item, item] }));
  for (const patch of [
    { title: '' },
    { enabled: 'true' },
    { content: 'x'.repeat(1501) },
    { url: 42 },
    { url: 'http://example.com' },
    { url: 'https://u:p@example.com' }
  ])
    assert.throws(() => parseSponsors({ items: [{ ...item, ...patch }] }));
});
