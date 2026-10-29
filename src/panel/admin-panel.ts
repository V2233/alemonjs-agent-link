// Administration service lifecycle. HTTP hosting belongs to the AlemonJS framework.
import { access } from 'node:fs/promises';
import { getConfig } from 'alemonjs';
import { ProductSettingsFile } from './product-settings-file';

let store: ProductSettingsFile | undefined;

export const initializeAdminPanel = async (): Promise<void> => {
  const path = getConfig().path;

  if (!path) throw new Error('未找到当前配置文件');
  await access(path);
  store = new ProductSettingsFile(path);
};
export const disposeAdminPanel = () => {
  store = undefined;
};
export const getAdminStore = () => {
  if (!store) throw new Error('管理服务未就绪');

  return store;
};
