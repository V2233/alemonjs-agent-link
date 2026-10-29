import { requestedMemorySave } from './save-intent';

export const bufferUnavailableMemorySave = (privateChat: boolean, userText: string, tools: readonly { name: string }[]): boolean =>
  privateChat && requestedMemorySave(userText) && !tools.some(tool => tool.name === 'remember_private_fact');

/** An echo is not a save confirmation. Leave actual answers and tool receipts alone. */
export const resolveUnavailableMemoryEcho = (reply: string, userText: string): string => {
  const normalize = (text: string): string =>
    text
      .normalize('NFKC')
      .replace(/\s+/gu, '')
      .replace(/[。.!！]+$/u, '');
  const content = reply.trim().replace(/^(?:user|human|用户)[：:\s]*/iu, '');

  return normalize(content) === normalize(userText) ? '这次没能确认长期保存。需要明确保存时，可用 /记住 加上要保存的内容。' : reply;
};
