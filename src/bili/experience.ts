import type { MemoryItem } from '../memory/store';

/** Recover only our structured reading evidence, never BV mentions in arbitrary memories. */
export const recentBiliIds = (items: MemoryItem[], now = Date.now()): Set<string> => {
  const ids = new Set<string>();

  for (const item of items) {
    if (item.status !== 'active' || item.origin !== 'event' || item.kind !== 'event' || !item.tags.includes('B站') || item.createdAt < now - 7 * 86400000)
      continue;
    const tagged = item.tags.find(tag => /^BV[0-9A-Za-z]{10}$/u.test(tag));

    if (tagged) {
      ids.add(tagged);
      continue;
    }
    if (!item.text.startsWith('我读取了 B 站视频资料：')) continue;
    try {
      const details = JSON.parse(item.text.slice(item.text.indexOf('{'), item.text.lastIndexOf('}') + 1));

      if (typeof details.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/u.test(details.bvid)) ids.add(details.bvid);
    } catch {
      // Legacy or incomplete evidence must not hide unrelated search results.
    }
  }

  return ids;
};
