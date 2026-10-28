/**
 * “为什么/为何”类疑问的入口判断。判断保持宽松：只要出现问因词就查一次问答库，
 * 由检索分数决定有没有可用答案；不把“为什么”写死成某几个固定句式。
 */
const whyQuestionPattern = /(为什么|为啥|为何|何故|怎么会|怎么回事|什么原因|啥原因|\bwhy\b|\bhow come\b|what(?:'s| is) the reason)/iu;

export const isWhyQuestion = (text: string): boolean => {
  const value = String(text ?? '').trim();

  return value.length >= 2 && value.length <= 2000 && whyQuestionPattern.test(value);
};

/** 问答去重、精确包含和关键词判断共用的归一化方式。 */
export const normalizeQaText = (text: string): string =>
  String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
