import { getConfig } from 'alemonjs';
import { getAdminStore } from './admin-panel';
import { parseAds } from '../ads/config';
export const readAdsSettings = async () => {
  const snapshot = await getAdminStore().read();

  return { revision: snapshot.revision, ...parseAds(JSON.parse(snapshot.source)['alemonjs-agent-link']?.ads) };
};
export const saveAdsSettings = async (input: unknown) => {
  const body = input as { revision: string; enabled: boolean; items: unknown };

  if (!body || typeof body.revision !== 'string' || Object.keys(body).some(key => !['revision', 'enabled', 'items'].includes(key)))
    throw new Error('广告设置无效');
  const ads = parseAds({ enabled: body.enabled, items: body.items });
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new Error('配置已变化');
  const source = JSON.parse(snapshot.source);

  source['alemonjs-agent-link'].ads = ads;
  await store.save(JSON.stringify(source), body.revision);
  getConfig().reload();

  return readAdsSettings();
};
