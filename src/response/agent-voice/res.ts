import { useEvent, useMessage, useRoute, useMedia } from 'alemonjs';
import { noticeBubble } from '../bubble';
import { runDSHChat } from '@src/response/dsh/chat';
import { submitGroupChat } from '../../social/respond';
import { groupVoicePolicy } from '../../social/group-settings';
import { getDSHConfig } from '@src/dsh/client';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();

  if (!context.match.selects || !route.matched || context.current.IsBot) {
    return;
  }
  const text = route.rawArgs.join(' ').trim();

  if (!text && !context.current.MessageMedia?.length && !context.current.ReplyId && !context.current.MessageContent?.replyReferenceId) {
    const [message] = useMessage();

    await message.send({
      format: noticeBubble('用法：/语音 你的问题（不可用时回退文字）', {
        platform: context.current.Platform,
        title: '语音',
        actions: [{ label: '语音用法', command: '/帮助 媒体' }]
      })
    });

    return;
  }
  if (context.current.IsPrivate) {
    await runDSHChat(context.current, text, { voice: true });
  } else {
    const [message] = useMessage();
    const [media] = useMedia();
    const voice = groupVoicePolicy(getDSHConfig(), context.current.ChannelId || '', context.current.Platform || '');

    if (!voice.allowed) {
      await message.send({
        format: noticeBubble('本群已关闭语音，这次用文字回答。', {
          platform: context.current.Platform,
          title: '语音',
          actions: [{ label: '语音设置', command: '/群设置 语音 查看' }]
        })
      });
    }
    try {
      await submitGroupChat(context.current, text, { message, media }, voice.allowed);
    } catch {
      await message.send({
        format: noticeBubble('群聊消息暂时无法处理，请稍后重试。', {
          platform: context.current.Platform,
          title: '暂时不可用',
          actions: [
            { label: '服务状态', command: '/状态' },
            { label: '帮助', command: '/帮助 媒体' }
          ]
        })
      });
    }
  }
};
