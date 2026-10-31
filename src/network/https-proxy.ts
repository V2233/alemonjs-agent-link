import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

export const validateHttpsProxy = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error('HTTPS_PROXY 必须是 HTTP/HTTPS 代理地址或空字符串');
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('HTTPS_PROXY 地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('HTTPS_PROXY 仅支持无账号密码、无路径的 HTTP/HTTPS 代理地址');

  return url.href;
};

let owned: EnvHttpProxyAgent | undefined;
let previous: Dispatcher | undefined;
let signature: string | undefined;

/** Native fetch shares Undici's dispatcher; leave pinned attachment downloads intact. */
export const configureHttpsProxy = (config: { HTTPS_PROXY?: string }, env = process.env): void => {
  const proxy = validateHttpsProxy(config.HTTPS_PROXY ?? env.HTTPS_PROXY);
  const noProxy = ['localhost', '127.0.0.1', '[::1]', env.NO_PROXY || env.no_proxy || ''].filter(Boolean).join(',');
  const nextSignature = proxy ? JSON.stringify([proxy, noProxy]) : undefined;

  if (signature === nextSignature) return;
  if (!proxy) {
    disposeHttpsProxy();

    return;
  }
  const next = new EnvHttpProxyAgent({ httpsProxy: proxy, httpProxy: '', noProxy });
  const old = owned;

  if (!owned) previous = getGlobalDispatcher();
  setGlobalDispatcher(next);
  owned = next;
  signature = nextSignature;
  void old?.close().catch(() => undefined);
};

export const disposeHttpsProxy = (): void => {
  if (owned && previous && getGlobalDispatcher() === owned) setGlobalDispatcher(previous);
  const old = owned;

  owned = undefined;
  previous = undefined;
  signature = undefined;
  void old?.close().catch(() => undefined);
};
