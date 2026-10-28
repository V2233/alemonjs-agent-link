import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<Set<string>>();

// No global balance cache: independent requests and users must check afresh.
export const withBalanceCheckScope = <T>(run: () => T): T => (scope.getStore() ? run() : scope.run(new Set(), run));
export const balanceWasConfirmed = (id: string): boolean => scope.getStore()?.has(id) === true;
export const confirmBalance = (id: string): void => {
  scope.getStore()?.add(id);
};
