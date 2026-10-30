import { getConfig } from 'alemonjs';
import { getAdminStore } from './admin-panel';
import { parseSponsors } from '../sponsors/config';
export const readSponsorsSettings = async () => {
  const snapshot = await getAdminStore().read();

  return { revision: snapshot.revision, ...parseSponsors(JSON.parse(snapshot.source)['alemonjs-agent-link']?.sponsors) };
};
export const saveSponsorsSettings = async (input: unknown) => {
  const body = input as { revision: string; enabled: boolean; items: unknown };

  if (!body || typeof body.revision !== 'string' || Object.keys(body).some(key => !['revision', 'enabled', 'items'].includes(key)))
    throw new Error('赞助列表设置无效');
  const sponsors = parseSponsors({ enabled: body.enabled, items: body.items });
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new Error('配置已变化');
  const source = JSON.parse(snapshot.source);

  source['alemonjs-agent-link'].sponsors = sponsors;
  await store.save(JSON.stringify(source), body.revision);
  getConfig().reload();

  return readSponsorsSettings();
};
