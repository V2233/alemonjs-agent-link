import { commandBubble, sectionBubble } from '../bubble';
import { useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '../../dsh/runtime-config';
import { proactiveOptions, proactiveEnabled, localDay, entitledProactiveOptions } from '../../proactive/options';
import { personalKeyEntitled } from '../../credentials/personal';
import { getProactiveStore } from '../../proactive/store';
import { ProactiveWorker } from '../../proactive/worker';
import { assertMessageDelivered } from '../../dsh/output';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['private.message.create'] });
  const [route] = useRoute();

  if (!context.match.selects || !route.matched) {
    return;
  }
  const event = context.current;
  const [message] = useMessage();
  let limit = 900;
  const reply = async (text: string, actions: { label: string; command: string }[] = []): Promise<void> => {
    const chars = Array.from(text);
    const chunks: string[] = [];

    for (let i = 0; i < chars.length; i += limit) chunks.push(chars.slice(i, i + limit).join(''));
    for (const [index, chunk] of chunks.entries()) {
      assertMessageDelivered(
        await message.send({
          format: commandBubble(chunk, '主动搭话', {
            platform: event.Platform,
            actions: index === chunks.length - 1 ? actions : []
          })
        })
      );
    }
  };

  if (!event.IsMaster || event.IsBot) {
    await reply('请主人在自己的私聊管理主动搭话。');

    return;
  }
  if (!event.Platform || !event.BotId || !event.UserId) {
    await reply('缺少明确的平台、机器人或私聊身份。');

    return;
  }
  try {
    const config = getDSHConfig();

    limit = Math.min(900, config.maxMessageLength);
    let options = proactiveOptions(config);
    let elevated = false;

    try {
      if (await personalKeyEntitled({ platform: event.Platform, userId: event.UserId })) {
        options = entitledProactiveOptions(options);
        elevated = Boolean(options.flexible);
      }
    } catch {
      // 权益查询失败时按普通参数展示与订阅，不影响原有能力。
    }
    const store = getProactiveStore(config);
    const scope = { platform: event.Platform, botId: event.BotId, userId: event.UserId };
    const args = route.rawArgs.join(' ').trim();
    const time = (value: number): string => new Date(value).toLocaleString('zh-CN', { timeZone: options.timezone, hour12: false });

    if (args === '开启') {
      if (!proactiveEnabled(config)) {
        await reply('主动搭话模块或总设置已停用，请在配置中启用后再开启订阅。');

        return;
      }
      store.subscribe(scope, true, options);
      await reply('主动搭话已开启，遵守免打扰与次数限制。', [
        { label: '查看状态', command: '/主动搭话 状态' },
        { label: '关闭', command: '/主动搭话 关闭' }
      ]);
    } else if (args === '关闭') {
      store.subscribe(scope, false, options);
      await reply('主动搭话已关闭，待发送消息已取消。', [
        { label: '查看状态', command: '/主动搭话 状态' },
        { label: '重新开启', command: '/主动搭话 开启' }
      ]);
    } else if (args === '恢复' || /^暂停\s+\d{1,5}$/u.test(args)) {
      if (!store.get(scope)) {
        await reply('尚未订阅，请先使用 /主动搭话 开启。');

        return;
      }
      store.pause(scope, args === '恢复' ? 0 : Number(args.split(/\s+/u)[1]));
      await reply(args === '恢复' ? '主动搭话已恢复。' : '已暂停，待发送消息已取消。', [
        { label: '查看状态', command: '/主动搭话 状态' },
        ...(args === '恢复' ? [] : [{ label: '恢复', command: '/主动搭话 恢复' }])
      ]);
    } else if (args === '现在') {
      const worker = new ProactiveWorker(config);

      try {
        const result = await worker.run(scope, true);
        const labels: Record<string, string> = {
          confirmed: '主动搭话已送达。',
          silent: '这次保持安静，未发消息。',
          unknown: '发送结果未确认，已暂停主动搭话。请先核对平台消息，再用 /主动搭话 恢复。',
          cancelled: '搭话已取消。',
          failed: '本次未完成，未自动重试。',
          disabled: '主动搭话已停用或当前身份不再是主人。',
          'not-due': '当前未订阅、达到次数限制或已有任务。先查看 /主动搭话 状态。',
          offline: '平台尚未确认在线，未生成或发送搭话。',
          busy: '已有主动搭话任务在执行，请稍后重试。'
        };

        await reply(labels[result], [{ label: '查看状态', command: '/主动搭话 状态' }]);
      } finally {
        worker.stop();
      }
    } else if (!args || args === '状态') {
      store.recover();
      const row = store.get(scope);
      const attempts = store.attempts(scope);
      const browsing = store.dailyBrowseStatus(scope);
      const browseLabels: Record<string, string> = {
        running: '已启动，尚无结束记录',
        recorded: '已保存阅读经历',
        completed: '已结束，未确认新增阅读记录',
        failed: '未完成',
        cancelled: '已取消'
      };
      const paused = row ? (row.pausedUntil >= Number.MAX_SAFE_INTEGER ? '等待核查发送结果' : row.pausedUntil > Date.now() ? time(row.pausedUntil) : '') : '';
      const today = row?.day === localDay(Date.now(), options.timezone) ? row.count : 0;
      const sections = row
        ? [
            {
              title: '订阅',
              text: `${row.enabled ? '已开启' : '已关闭'}；模块${proactiveEnabled(config) ? '启用' : '停用'}。`,
              actions: [
                row.enabled ? { label: '关闭', command: '/主动搭话 关闭' } : { label: '开启', command: '/主动搭话 开启' },
                { label: '立即', command: '/主动搭话 现在' }
              ]
            },
            {
              title: '节奏',
              text: `今日 ${today}/${options.maxPerDay}；未回复连发 ${row.unanswered}/${options.maxUnanswered}；最早下次 ${time(row.nextAt)}。`
            },
            {
              title: '独立阅读',
              text: `${config.modules?.settings?.bili?.dailyBrowse === true ? '每日阅读已配置开启' : '每日阅读未开启'}。${browsing ? `最近尝试 ${time(browsing.at)}：${browseLabels[browsing.status] || '结果待核查'}。可询问“看看你的浏览日记”。` : '暂无尝试记录。'}`
            },
            ...(paused
              ? [
                  {
                    title: '暂停',
                    text: paused,
                    actions: row.pausedUntil < Number.MAX_SAFE_INTEGER ? [{ label: '恢复', command: '/主动搭话 恢复' }] : []
                  }
                ]
              : []),
            ...(elevated ? [{ title: '自带 Key', text: '主动搭话已拉满（空闲 20 分钟、每天最多 10 次）；免打扰仍按配置。' }] : []),
            ...(args === '状态' && attempts.length > 0
              ? [
                  {
                    title: '最近记录',
                    text: attempts
                      .slice(0, 5)
                      .map(
                        attempt =>
                          `${time(attempt.at)} ${attempt.kind === 'nudge' ? '追问' : '搭话'}：${
                            (
                              {
                                confirmed: '已送达',
                                unknown: '待核对',
                                failed: '失败',
                                cancelled: '已取消',
                                silent: '未发送',
                                sending: '发送中',
                                reserved: '待处理'
                              } as Record<string, string>
                            )[attempt.status] || attempt.status
                          }`
                      )
                      .join('\n')
                  }
                ]
              : []),
            {
              title: '更多',
              text: '需要时暂停；恢复不会补发错过的消息。',
              actions: [
                { label: '暂停 60 分钟', command: '/主动搭话 暂停 60' },
                { label: '恢复', command: '/主动搭话 恢复' }
              ]
            }
          ]
        : [
            {
              title: '订阅',
              text: '尚未订阅，不会主动发送消息。',
              actions: [
                { label: '开启', command: '/主动搭话 开启' },
                { label: '状态', command: '/主动搭话 状态' }
              ]
            }
          ];

      await message.send({ format: sectionBubble('主动搭话', '仅主人私聊。', sections, { platform: event.Platform, layout: 'inline' }) });
    } else {
      await reply('用法：/主动搭话 开启|关闭|状态|现在|暂停 分钟|恢复。', [{ label: '查看状态', command: '/主动搭话 状态' }]);
    }
  } catch {
    await reply('操作未完成，请核对状态后再试。', [{ label: '查看状态', command: '/主动搭话 状态' }]);
  }
};
