import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { budgetEnabled, budgetStatus, manageBudget, budgetAdjustments } from '../../billing/budget';
import { getDSHConfig, toUserMessage } from '../../dsh/client';
import { getConversationId } from '../dsh/util';
import { parseBudgetCommand, budgetHelp } from '../../billing/commands';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!eventContext.match.selects) return;
  const event = eventContext.current;
  const [message] = useMessage();
  const [route] = useRoute();
  const config = getDSHConfig();
  let text = '每日额度保护未开启。';

  if (budgetEnabled(config)) {
    try {
      const command = parseBudgetCommand(route.rawArgs.map(String), event);

      if (command.action === 'help') {
        await message.send({ format: Format.create().addText(budgetHelp) });

        return;
      }
      let notice = '';

      if (command.action === 'add' || command.action === 'set') {
        const adjusted = await manageBudget(
          config,
          command.scope,
          {
            isMaster: Boolean(event.IsMaster),
            platform: event.Platform || '',
            userId: event.UserId || '',
            channelId: getConversationId(event),
            messageId: event.MessageId || ''
          },
          command.action,
          command.amount
        );

        notice = `调整结果（${adjusted.day}）：今日总额度 ${(adjusted.before / 1_000_000).toFixed(2)} → ${(adjusted.after / 1_000_000).toFixed(2)} 元。重复投递不会再次加额。\n`;
      }
      if (command.action === 'history') {
        const rows = await budgetAdjustments(command.scope, Boolean(event.IsMaster));

        await message.send({
          format: Format.create().addText(
            rows.length
              ? rows
                  .map(
                    row =>
                      `${new Date(row.at * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 主人 ${row.actor}：${row.operation === 'add' ? '增加' : '设置'} ${(row.amount / 1_000_000).toFixed(2)} 元，总额 ${(row.before / 1_000_000).toFixed(2)} → ${(row.after / 1_000_000).toFixed(2)} 元`
                  )
                  .join('\n')
              : '今天没有手动额度调整记录。'
          )
        });

        return;
      }
      const value = await budgetStatus(config, command.scope);
      const target = command.scope.channelId === getConversationId(event) ? (event.IsPrivate ? '本人私聊' : '本群共享') : command.scope.channelId;

      text = [
        notice,
        `目标：${target}\n今日总额度：${value.limit.toFixed(2)} 元`,
        `已计入：${value.used.toFixed(4)} 元；剩余：${value.remaining.toFixed(4)} 元`,
        `其中预留／待核实：${value.reserved.toFixed(4)} 元`,
        `模型请求：${value.requests} 次；计入输入／输出：${value.promptTokens} / ${value.completionTokens} token`,
        `缓存命中：${value.cacheHitTokens} token`,
        `统计日期：${value.day}，北京时间零点恢复每日 ${value.defaultLimit.toFixed(2)} 元。按高峰价计算内部预算，图片请求输入仅按文字估算，不是服务商实际账单。`,
        event.IsPrivate && event.IsMaster ? `全局今日已计入：${value.globalUsed.toFixed(4)} 元。` : ''
      ]
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      text = toUserMessage(error);
    }
  }
  await message.send({ format: Format.create().addText(text) });
};
