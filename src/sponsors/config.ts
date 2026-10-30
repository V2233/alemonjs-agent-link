import { getAppConfigValue } from 'alemonjs';
export type Sponsor = { id: string; title: string; content: string; url?: string; enabled: boolean };
export const parseSponsors = (value: unknown = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('赞助列表配置无效');
  const raw = value as { enabled?: boolean; items?: Sponsor[] };

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('赞助列表开关无效');
  if (raw.items !== undefined && (!Array.isArray(raw.items) || raw.items.length > 100)) throw new Error('赞助列表最多100项');
  const ids = new Set<string>();
  const items = (raw.items || []).map(item => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(item.id) ||
      ids.has(item.id) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 80 ||
      typeof item.content !== 'string' ||
      item.content.length > 1500 ||
      typeof item.enabled !== 'boolean'
    )
      throw new Error('赞助列表字段无效');
    if (item.url !== undefined && typeof item.url !== 'string') throw new Error('赞助链接无效');
    if (item.url) {
      const url = new URL(item.url);

      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('赞助链接需要HTTPS');
    }
    ids.add(item.id);

    return { id: item.id, title: item.title.trim(), content: item.content, url: item.url, enabled: item.enabled };
  });

  return { enabled: raw.enabled === true, items };
};
export const getSponsors = () => parseSponsors((getAppConfigValue() as { sponsors?: unknown }).sponsors);
