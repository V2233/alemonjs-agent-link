import { Format, useEvent, useMessage } from 'alemonjs';
import { getDSHConfig } from '../../dsh/client';
import { getModuleRuntime } from '../../agent/modules';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: 'private.message.create' });

  if (!context.match.selects || !context.current.IsMaster) {
    return;
  }
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
  await message.send({ format: Format.create().addText(text) });
};
