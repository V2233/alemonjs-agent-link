import { useEvent, useMessage, useRoute } from 'alemonjs';
import { getSponsors } from '../../sponsors/config';
import { sectionBubble } from '../bubble';

export default async (): Promise<void> => {
  const sponsors = getSponsors();

  if (!sponsors.enabled) return;
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!context.match.selects) return;
  const [route] = useRoute();
  const [message] = useMessage();
  const items = sponsors.items.filter(item => item.enabled);
  const pages = Math.ceil(items.length / 5) || 1;
  const page = Math.max(1, Math.min(pages, Math.floor(Number(route.rawArgs[0])) || 1));
  const actions = [
    ...(page > 1 ? [{ label: '上一页', command: `/赞助列表 ${page - 1}` }] : []),
    ...(page < pages ? [{ label: '下一页', command: `/赞助列表 ${page + 1}` }] : []),
    { label: '查看额度', command: '/额度' }
  ];

  await message.send({
    format: sectionBubble(
      '赞助列表',
      `感谢支持 · 第${page}/${pages}页`,
      [
        ...items.slice((page - 1) * 5, page * 5).map(item => ({
          title: item.title,
          text: [item.content, item.url].filter(Boolean).join('\n'),
          actions: []
        })),
        { title: '导航', text: items.length ? '' : '暂无展示的赞助条目', actions }
      ],
      { platform: context.current.Platform, layout: 'inline' }
    )
  });
};
