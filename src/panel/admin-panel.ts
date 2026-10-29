// Administration service lifecycle. HTTP hosting belongs to the AlemonJS framework.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfig, logger } from 'alemonjs';
import { ConfigStore } from './config-store';

let store: ConfigStore | undefined;
let token = '';

export const initializeAdminPanel = async (): Promise<void> => {
  const path = getConfig().path;

  if (!path) throw new Error('未找到当前配置文件');
  const directory = join(dirname(path), '.agent-link-admin');

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nextToken = randomBytes(32).toString('hex');
  const tokenFile = join(directory, 'token');

  await writeFile(tokenFile, nextToken, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  store = new ConfigStore(path);
  token = nextToken;
  logger.info({ tokenFile }, '管理接口已注册到框架；令牌保存在配置目录');
};
export const disposeAdminPanel = () => {
  token = '';
  store = undefined;
};
export const authorizeAdmin = (header: string): boolean => {
  const credential = Buffer.from(header.replace(/^Bearer /, ''));

  return Boolean(token) && credential.length === token.length && timingSafeEqual(credential, Buffer.from(token));
};
export const getAdminStore = () => {
  if (!store) throw new Error('管理服务未就绪');

  return store;
};
