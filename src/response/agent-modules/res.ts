import { commandBubble } from '../bubble';
import { useEvent, useMessage } from 'alemonjs';
import { getDSHConfig } from '../../dsh/client';
import { getModuleRuntime } from '../../agent/modules';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: 'private.message.create' });

  if (!context.match.selects || !context.current.IsMaster) {
    return;
  }
  const event = context.current;
  const [message] = useMessage();
  let text: string;

  try {
    const runtime = await getModuleRuntime(getDSHConfig());

    await runtime.refresh();
    const status = runtime.status();

    text = [
      'AgentLink 模块',
      ...status.map(
        item =>
          `${item.id}：${item.state === 'ready' ? `已加载 ${item.version}` : item.state === 'disabled' ? '已停用' : '加载失败'}${item.error ? `（${item.error}）` : ''}`
      )
    ].join('\n');
  } catch {
    text = '模块配置或目录不可用，请检查服务端配置和文件权限。';
  }
  await message.send({
    format: commandBubble(text, '功能状态', {
      platform: event.Platform,
      actions: [
        { label: '刷新状态', command: '/模块状态' },
        { label: '服务状态', command: '/状态' },
        { label: '帮助', command: '/帮助' }
      ]
    })
  });
};
