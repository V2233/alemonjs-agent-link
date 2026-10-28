import { groupKeyStatus } from '../../credentials/group';
import { personalKeyStatus } from '../../credentials/personal';
import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { budgetEnabled, budgetStatus, replyGateBudgetStatus, manageBudget, budgetAdjustments } from '../../billing/budget';
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
  let text = '当前未设置每日额度。';

  if (budgetEnabled(config)) {
    try {
      const command = parseBudgetCommand(route.rawArgs.map(String), event);

      if (command.action === 'help') {
        await message.send({ format: Format.create().addText(budgetHelp) });

        return;
      }
      const isPrivate = command.scope.channelId.startsWith('private:');
      const rechargeLabel = isPrivate ? '私聊充值' : '群充值';
      const freeLabel = isPrivate ? '个人免费总额度' : '群感知总预算';
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

        notice = `调整结果（${adjusted.day}）：${command.action === 'add' ? `${rechargeLabel}额度` : freeLabel} ${(adjusted.before / 1_000_000).toFixed(2)} → ${(adjusted.after / 1_000_000).toFixed(2)} 元。\n`;
      }
      if (command.action === 'history') {
        const rows = await budgetAdjustments(command.scope, Boolean(event.IsMaster));

        await message.send({
          format: Format.create().addText(
            rows.length
              ? rows
                  .map(
                    row =>
                      `${new Date(row.at * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 主人 ${row.actor}：${row.operation === 'add' ? '增加' : '设置'} ${(row.amount / 1_000_000).toFixed(2)} 元，${row.ledger === 'paidLimit' ? `${rechargeLabel}额度` : freeLabel} ${(row.before / 1_000_000).toFixed(2)} → ${(row.after / 1_000_000).toFixed(2)} 元`
                  )
                  .join('\n')
              : '今天没有手动额度调整记录。'
          )
        });

        return;
      }
      const value = await budgetStatus(config, { ...command.scope, ...(command.scope.channelId === getConversationId(event) ? { userId: event.UserId } : {}) });
      const gate = command.scope.channelId.startsWith('private:') ? undefined : await replyGateBudgetStatus(config, command.scope);
      const personal =
        event.IsPrivate && command.scope.channelId === getConversationId(event)
          ? await personalKeyStatus({ ...command.scope, userId: event.UserId })
          : undefined;
      const groupKey = !command.scope.channelId.startsWith('private:') ? await groupKeyStatus(command.scope) : undefined;
      const target = command.scope.channelId === getConversationId(event) ? (event.IsPrivate ? '本人私聊' : '本群') : command.scope.channelId;

      text = [
        notice,
        `${target} · ${value.day}`,
        groupKey?.enabled ? '付款顺序：群 Key → 群充值 → 个人免费；后台判断最后走群感知预算。' : '',
        personal ? `当前模式：${personal.enabled ? '个人 Key 优先（不扣以下额度）' : '额度模式'}；/个人密钥 查看绑定状态。` : '',
        gate ? `群感知：免费已用 ${gate.freeUsed.toFixed(4)} / ${gate.limit.toFixed(2)} 元，剩余 ${gate.freeRemaining.toFixed(4)} 元` : '',
        `${rechargeLabel}：已用 ${value.paidUsed.toFixed(4)} / ${value.paidLimit.toFixed(2)} 元，剩余 ${value.paidRemaining.toFixed(4)} 元（优先使用，不扣免费）`,
        isPrivate || command.scope.channelId === getConversationId(event)
          ? `个人免费（跨群和私聊共享）：已用 ${value.personalUsed.toFixed(4)} / ${value.personalLimit.toFixed(2)} 元，剩余 ${value.personalRemaining.toFixed(4)} 元\n聊天本次可用：${value.available.toFixed(4)} 元`
          : '',
        '北京时间零点重置。群聊没有共享的免费聊天额度。',
        event.IsPrivate && event.IsMaster ? `全局今日已用：${value.globalUsed.toFixed(4)} 元。` : ''
      ]
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      text = toUserMessage(error);
    }
  }
  await message.send({ format: Format.create().addText(text) });
};
