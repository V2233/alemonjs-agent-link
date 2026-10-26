export const MAX_IMAGE_REQUEST_BYTES = 48 * 1024 * 1024;
export type ChatInput = string | ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[];
export const inputText = (input: ChatInput): string =>
  typeof input === 'string'
    ? input
    : input
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n');
export const withInputContext = (input: ChatInput, context: string): ChatInput =>
  !context ? input : typeof input === 'string' ? `${context}\n\n当前消息：\n${input}` : [{ type: 'text', text: context }, ...input];
export const modelContent = (input: ChatInput) =>
  typeof input === 'string'
    ? input
    : input.map(part => (part.type === 'text' ? part : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }));
