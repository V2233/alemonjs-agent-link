import { useEvent, useMessage, useRoute } from 'alemonjs';
import { getAds } from '../../ads/config';
import { budgetEnabled, claimAdvertisementReward } from '../../billing/budget';
import { getDSHConfig } from '../../dsh/runtime-config';
import { assertMessageDelivered } from '../../dsh/output';
import { getConversationId } from '../dsh/util';
import { commandBubble, sectionBubble } from '../bubble';
export default async (): Promise<void> => {
  const ads = getAds();

  if (!ads.enabled) return;
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!context.match.selects) return;
  const event = context.current;
  const [route] = useRoute();
  const [message] = useMessage();
  const config = getDSHConfig();
  const send = async (text: string) =>
    assertMessageDelivered(
      await message.send({
        format: commandBubble(text, '广告', {
          platform: event.Platform,
          actions: [
            { label: '广告列表', command: '/广告列表' },
            { label: '查看额度', command: '/额度' }
          ]
        })
      })
    );

  if (!budgetEnabled(config)) {
    await send('广告奖励暂不可用。');

    return;
  }
  const items = ads.items.filter(item => item.enabled);

  if (/^\/广告详情(?:\s|$)/u.test(event.MessageText || '')) {
    const ad = items.find(item => item.id === route.rawArgs.join(' ').trim());

    if (!ad) {
      await send('广告不存在或已下架，请从广告列表选择。');

      return;
    }
    await send(`【广告】${ad.title}\n${ad.content}${ad.url ? `\n${ad.url}` : ''}\n查阅奖励：${ad.rewardYuan.toFixed(2)}元，每条广告仅限一次。`);
    // Recheck availability after delivery before any credit operation.
    const current = getAds();

    if (!current.enabled || !current.items.some(item => item.id === ad.id && item.enabled && item.rewardYuan === ad.rewardYuan)) return;
    try {
      const credited = await claimAdvertisementReward(
        config,
        { platform: event.Platform, userId: event.UserId, channelId: getConversationId({ ...event, IsPrivate: true }) },
        ad.id,
        Math.round(ad.rewardYuan * 1_000_000)
      );

      await send(credited ? `已获得${ad.rewardYuan.toFixed(2)}元私聊额度，跨天保留。` : '本条广告奖励已领取，不重复发放。');
    } catch {
      await send('奖励暂未确认，请稍后重新查看本条广告；不会重复发放。');
    }

    return;
  }
  const page = Math.max(1, Math.min(Math.ceil(items.length / 5) || 1, Math.floor(Number(route.rawArgs[0])) || 1));

  assertMessageDelivered(
    await message.send({
      format: sectionBubble(
        '广告列表',
        `查阅详情获得本人私聊额度，群聊与私聊共用领取资格，每条仅一次。第${page}页`,
        items
          .slice((page - 1) * 5, page * 5)
          .map(ad => ({
            title: `【广告】${ad.title}`,
            text: `奖励${ad.rewardYuan.toFixed(2)}元`,
            actions: [{ label: '查看详情', command: `/广告详情 ${ad.id}` }]
          }))
          .concat([
            {
              title: '翻页',
              text: items.length ? '' : '暂无上架广告',
              actions: page * 5 < items.length ? [{ label: '下一页', command: `/广告列表 ${page + 1}` }] : []
            }
          ]),
        { platform: event.Platform, layout: 'inline' }
      )
    })
  );
};
