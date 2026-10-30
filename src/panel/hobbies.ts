import { getDSHConfig } from '../dsh/runtime-config';
import { getProactiveStore } from '../proactive/store';
import { interruptAllProactive } from '../proactive/control';
import { normalizeHobbies } from '../companion/hobbies';
import { getConfig } from 'alemonjs';
import { AdminInputError } from './admin-error';
import { getAdminStore } from './admin-panel';

const project = (snapshot: { source: string; revision: string }) => ({
  revision: snapshot.revision,
  activities: getProactiveStore(getDSHConfig()).hobbyActivityStatus(),
  values: normalizeHobbies(JSON.parse(snapshot.source)['alemonjs-agent-link']?.modules?.settings?.hobbies)
});

export const readHobbies = async () => project(await getAdminStore().read());
export const saveHobbies = async (input: unknown) => {
  const body = input as { revision?: string; values?: unknown };

  if (!body || typeof body.revision !== 'string' || !body.revision || !body.values) throw new AdminInputError('无效的爱好设置');
  const values = normalizeHobbies(body.values);
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new AdminInputError('配置已变化，请重新读取后再保存');
  const source = JSON.parse(snapshot.source);
  const app = source['alemonjs-agent-link'];

  app.modules ||= {};
  app.modules.settings ||= {};
  app.modules.settings.hobbies = values;
  const saved = await store.save(JSON.stringify(source), body.revision);

  getConfig().reload();
  interruptAllProactive();

  return project(saved);
};
