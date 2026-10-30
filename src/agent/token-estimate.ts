import type { AgentTool } from './types';

/** Admission heuristic, not a tokenizer or a billed-usage measurement. */
export const estimateModelRequestTokens = (messages: { content: unknown }[], tools: AgentTool[], outputTokens = 2048): number => {
  let images = 0;
  const text = JSON.stringify(
    {
      messages,
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
    },
    (key, value) => {
      if (key === 'image_url' && value && typeof value === 'object') {
        images++;

        return '[image]';
      }

      return value;
    }
  );

  return Math.ceil(Buffer.byteLength(text) / 3) + images * 6000 + outputTokens;
};
