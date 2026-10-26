import { createHash } from 'node:crypto';

export type ProactiveScope = { platform: string; botId: string; userId: string };
export const proactiveChannel = (scope: ProactiveScope): string => `private:${JSON.stringify([scope.platform, scope.userId])}`;
export const proactiveScopeId = (scope: ProactiveScope): string =>
  createHash('sha256')
    .update(JSON.stringify([scope.platform, scope.botId, scope.userId]))
    .digest('hex');
const state = globalThis as typeof globalThis & { __agentLinkProactiveJobs__?: Map<string, AbortController> };
const jobs = (state.__agentLinkProactiveJobs__ ??= new Map<string, AbortController>());
const key = (root: string, scope: ProactiveScope): string => JSON.stringify([root, proactiveScopeId(scope)]);

export const interruptProactive = (root: string, scope: ProactiveScope): void => jobs.get(key(root, scope))?.abort();
export const interruptAllProactive = (): void => {
  for (const job of jobs.values()) {
    job.abort();
  }
};
export const beginProactive = (root: string, scope: ProactiveScope): { signal: AbortSignal; stop: () => void; release: () => void } | undefined => {
  const id = key(root, scope);

  if (jobs.has(id) || jobs.size >= 2) {
    return;
  }
  const controller = new AbortController();

  jobs.set(id, controller);

  return {
    signal: controller.signal,
    stop: () => controller.abort(),
    release: () => {
      if (jobs.get(id) === controller) {
        jobs.delete(id);
      }
    }
  };
};
