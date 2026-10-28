import { tokenizeMemory } from '../memory/retrieval';
import { normalizeQaText } from './detection';

export type SearchableQa = {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
  tags: string[];
  origin: 'builtin' | 'learned' | 'explicit';
  confidence: number;
  hits: number;
  updatedAt: number;
};

export type QaRankOptions = { threshold?: number; now?: number };

/**
 * 问答库排序。与长期记忆不同，问答匹配更看重“问题本身是否问的是同一件事”：
 * 问题是短句，若只看词频，任何带“为什么”的句子都会互相命中。
 * 因此先要求问题覆盖率、关键词或精确包含，再用来源可信度、命中次数与时间排序。
 */
export const rankQa = <T extends SearchableQa>(items: T[], query: string, options: QaRankOptions = {}): (T & { score: number })[] => {
  const normalizedQuery = normalizeQaText(query);
  const queryTokens = new Set(tokenizeMemory(query));

  if (!normalizedQuery || !queryTokens.size) {
    return [];
  }
  const now = options.now ?? Date.now();
  const threshold = options.threshold ?? 3.5;
  const ranked: (T & { score: number })[] = [];

  for (const item of items) {
    const normalizedQuestion = normalizeQaText(item.question);
    const documentTokens = new Set(tokenizeMemory(`${item.question} ${item.keywords.join(' ')} ${item.tags.join(' ')}`));
    let overlap = 0;

    for (const token of queryTokens) {
      if (documentTokens.has(token)) {
        overlap++;
      }
    }
    const coverage = overlap / queryTokens.size;
    const exact =
      normalizedQuery.length >= 4 &&
      normalizedQuestion.length >= 4 &&
      (normalizedQuery.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedQuery));
    const keyword = item.keywords.some(value => {
      const normalized = normalizeQaText(value);

      return normalized.length >= 2 && (normalizedQuery.includes(normalized) || normalized.includes(normalizedQuery));
    });

    if (!exact && !keyword && (overlap < 3 || coverage < 0.7)) {
      continue;
    }
    const trust = item.origin === 'explicit' ? 1.2 : item.origin === 'builtin' ? 1 : 0.6;
    const trustScore = Math.max(0, Math.min(1, item.confidence)) * trust;
    const popularity = Math.min(1, item.hits / 20) * 0.4;
    const recency = 0.5 * Math.pow(0.5, Math.max(0, now - item.updatedAt) / (180 * 86400000));
    const score = coverage * 6 + (exact ? 4 : 0) + (keyword ? 2 : 0) + trustScore + popularity + recency;

    if (score < threshold) {
      continue;
    }
    ranked.push({ ...item, score });
  }

  return ranked.sort((a, b) => b.score - a.score || b.confidence - a.confidence || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
};
