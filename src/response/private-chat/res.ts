import { useEvent } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { runDSHChat } from '@src/response/dsh/chat';
import { isPrivateChatText } from '@src/response/dsh/util';

export default async (): Promise<void> => {
  const [context, next] = useEvent({ selects: 'private.message.create' });

  if (!context.match.selects) {
    return;
  }
  const event = context.current;

  if (!isPrivateChatText(event.MessageText) || !getDSHConfig().privateAutoReply) {
    await Promise.resolve(next());

    return;
  }
  await runDSHChat(event, event.MessageText.trim());
};
