export type SubtitleSegment = { from: number | null; to: number | null; text: string };

/** Bounded transcript excerpt with source timestamps; never infer missing timing. */
export const subtitleExcerpt = (body: unknown): { text: string; segments: SubtitleSegment[]; truncated: boolean; segmentsTruncated: boolean } => {
  const rows = Array.isArray(body) ? body : [];
  const segments: SubtitleSegment[] = [];
  const texts: string[] = [];
  let segmentsTruncated = false;
  let remaining = 6000;
  let processed = 0;
  let truncated = false;

  for (const row of rows.slice(0, 2000)) {
    if (remaining <= 1) break;
    processed++;
    if (typeof row?.content !== 'string' || !row.content.trim()) continue;
    const chars = Array.from(row.content.trim());
    const limit = Math.min(300, remaining - (texts.length ? 1 : 0));
    const text = chars.slice(0, limit).join('');
    const timed =
      typeof row.from === 'number' && Number.isFinite(row.from) && row.from >= 0 && typeof row.to === 'number' && Number.isFinite(row.to) && row.to >= row.from;

    if (chars.length > limit) truncated = true;
    remaining -= Math.min(chars.length, limit) + (texts.length ? 1 : 0);
    texts.push(text);
    if (segments.length < 120) segments.push({ from: timed ? row.from : null, to: timed ? row.to : null, text });
    else segmentsTruncated = true;
  }

  return { text: texts.join(' '), segments, truncated: truncated || processed < rows.length, segmentsTruncated };
};
