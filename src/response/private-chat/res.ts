import { Format, useEvent, useMessage } from 'alemonjs';
import { getDSHConfig, toUserMessage } from '@src/dsh/client';
import { runDSHChat } from '@src/response/dsh/chat';
import { isPrivateChatText } from '@src/response/dsh/util';

export default async (): Promise<void> => {
  const [context, next] = useEvent({ selects: 'private.message.create' });

  if (!context.match.selects) {
    return;
  }
  const event = context.current;

  if (!isPrivateChatText(event.MessageText)) {
    await Promise.resolve(next());

    return;
  }
  let config;

  try {
    config = getDSHConfig();
  } catch (error) {
    const [message] = useMessage();

    await message.send({ format: Format.create().addMarkdownOriginal(toUserMessage(error)) });

    return;
  }
  if (!config.privateAutoReply) {
    await Promise.resolve(next());

    return;
  }
  await runDSHChat(event, event.MessageText.trim());
};
