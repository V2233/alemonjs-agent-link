export const browsePreferences = (settings: Readonly<Record<string, unknown>>): { topics: string[]; exclude: string[] } => {
  const parse = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > 10 ||
      value.some(item => typeof item !== 'string' || !item.trim() || item.length > 40 || /[\r\n]/u.test(item))
    ) {
      throw new Error('每日阅读主题与避雷词应为最多 10 个、每个 1–40 字的单行文字。');
    }

    return [...new Set(value.map(item => item.trim()))];
  };

  return { topics: parse(settings.dailyBrowseTopics), exclude: parse(settings.dailyBrowseExclude) };
};

export const excludedBrowseTopic = (item: { title: string; description: string }, excluded: string[]): boolean => {
  const text = `${item.title}\n${item.description}`.normalize('NFKC').toLocaleLowerCase('en-US');

  return excluded.some(word => text.includes(word.normalize('NFKC').toLocaleLowerCase('en-US')));
};

/** Preference matches describe metadata relevance, not video quality or verified content. */
export const rankBrowseCandidates = <T extends { title: string; description: string }>(items: T[], topics: string[]): (T & { matchedTopics: string[] })[] => {
  const normalized = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('en-US');
  const unique = [...new Map(topics.map(topic => [normalized(topic), topic])).entries()];

  return items
    .map((item, index) => {
      const title = normalized(item.title);
      const description = normalized(item.description);
      const matchedTopics: string[] = [];
      let score = 0;

      for (const [keyword, label] of unique) {
        if (title.includes(keyword)) {
          score += 2;
          matchedTopics.push(label);
        } else if (description.includes(keyword)) {
          score++;
          matchedTopics.push(label);
        }
      }

      return { item, index, score, matchedTopics };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, matchedTopics }) => ({ ...item, matchedTopics }));
};

export const parseBrowseFeedback = (text: string): { topic: string; preference: 'like' | 'avoid' | 'clear' } | undefined => {
  const match = text.trim().match(/^(以后多看|以后别看|以后不要看|恢复推荐)[：:、\s]*(.{1,40}?)[。！!]*$/u);

  if (!match || /[“”"「」<>\r\n？?]/u.test(match[2])) return undefined;
  const topic = match[2].trim();

  if (!topic || /^(?:这个|那个|这类|那类|这个视频|那个视频|它|什么|什么视频)$/u.test(topic) || /(?:吗|么|如何|怎么)$/u.test(topic)) return undefined;

  return { topic, preference: match[1] === '以后多看' ? 'like' : match[1] === '恢复推荐' ? 'clear' : 'avoid' };
};

export const mergeBrowseFeedback = (
  configured: { topics: string[]; exclude: string[] },
  feedback: { topic: string; preference: string }[]
): { topics: string[]; exclude: string[] } => {
  const unique = (values: string[]): string[] => {
    const seen = new Set<string>();

    return values.filter(value => {
      const key = value.normalize('NFKC').trim().toLowerCase();

      if (!key || seen.has(key)) return false;
      seen.add(key);

      return true;
    });
  };
  const exclude = unique([...configured.exclude, ...feedback.filter(item => item.preference === 'avoid').map(item => item.topic)]);
  const topics = unique([...configured.topics, ...feedback.filter(item => item.preference === 'like').map(item => item.topic)]);

  return { topics: topics.filter(topic => !excludedBrowseTopic({ title: topic, description: '' }, exclude)), exclude };
};

/** Rotate through explicit topics by local calendar day rather than choosing randomly each turn. */
export const dailyReadingTopic = (topics: string[], day: string, offset: number): string => {
  if (!topics.length) return '';
  const ordinal = Math.floor(Date.parse(`${day}T12:00:00Z`) / 86400000);

  return topics[(((ordinal + offset) % topics.length) + topics.length) % topics.length] || '';
};
