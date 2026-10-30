import type { DSHBridgeConfig } from '../dsh/config';
import { normalizeHobbies } from '../companion/hobbies';
import { browseWindow } from './browse-schedule';
import type { ProactiveScope } from './control';
import type { ProactiveStore } from './store';

/** Global hobby controls may stop reading; a private override may always opt out. */
export const readingSettings = (config: DSHBridgeConfig, store: ProactiveStore, scope: ProactiveScope) => {
  const raw = config.modules?.settings?.bili || {};
  const managed = config.modules?.settings?.hobbies?.autonomous !== undefined;
  const hobbies = normalizeHobbies(config.modules?.settings?.hobbies);
  const enabled = managed ? hobbies.enabled && hobbies.autonomous && !config.modules?.disabled?.includes('hobbies') : raw.dailyBrowse === true;
  const scoped = store.dailyBrowseSettings(scope, enabled, browseWindow(raw.dailyBrowseWindow));

  return { ...scoped, managed, enabled: (!managed || enabled) && scoped.enabled };
};
