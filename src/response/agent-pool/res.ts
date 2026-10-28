import { commandBubble } from '../bubble';
import { useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { getCredentialPool } from '@src/credentials/pool';
import { fetchPoolBalances } from '@src/model-pool/balance';
import { poolPageView } from './format';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: 'private.message.create' });
  const [route] = useRoute();

  if (!eventContext.match.selects || !route.matched) return;
  const event = eventContext.current;
  const [message] = useMessage();

  if (!event.IsMaster) {
    await message.send({ format: commandBubble('模型池状态仅限机器人主人查看。', '模型池', { platform: event.Platform }) });

    return;
  }

  const requested = Number.parseInt(String(route.rawArgs[0] ?? '1'), 10);
  let pool;

  try {
    pool = getCredentialPool(getDSHConfig());
  } catch {
    await message.send({ format: commandBubble('模型池配置无效，请检查 modelPool。', '模型池', { platform: event.Platform }) });

    return;
  }

  if (!pool) {
    await message.send({
      format: commandBubble('未配置 modelPool，当前使用单 Key。\n配置多 Key 后可在这里查看轮转状态和补货提示。', '模型池', {
        platform: event.Platform,
        actions: [
          { label: '当前模型', command: '/当前模型' },
          { label: '密钥配置', command: '/密钥配置' }
        ]
      })
    });

    return;
  }

  const balances = await fetchPoolBalances(pool.config);
  const view = poolPageView(pool.status, Number.isFinite(requested) ? requested : 1, Date.now(), balances, pool.config.balanceAlertYuan);
  const actions = [];

  if (view.page > 1) actions.push({ label: '上一页', command: `/模型池 ${view.page - 1}`, short: '上页' });
  if (view.page < view.pages) actions.push({ label: '下一页', command: `/模型池 ${view.page + 1}`, short: '下页' });
  actions.push({ label: '刷新', command: '/模型池', short: '刷新' }, { label: '当前模型', command: '/当前模型' }, { label: '模型列表', command: '/模型列表' });

  await message.send({ format: commandBubble(view.text, '模型池', { platform: event.Platform, actions }) });
};
