import { getBudgetScope, withBudgetScope } from '../billing/budget';
import { getPersonalCredential, checkedPersonalCredential, updatePersonalKey, type PersonalCredential } from './personal';
import { getGroupCredential, checkedGroupCredential, updateGroupKey } from './group';

const ownScope = () => {
  const scope = getBudgetScope();

  return scope?.userId && !scope.autonomous && !scope.sharedOnly ? { ...scope, channelId: `private:${JSON.stringify([scope.platform, scope.userId])}` } : null;
};

export const getBoundCredential = async (): Promise<PersonalCredential | null> => {
  const scope = getBudgetScope();

  if (scope?.channelId.startsWith('private:')) return getPersonalCredential();
  const shared = await getGroupCredential();
  const own = ownScope();

  return shared || (own ? withBudgetScope(own, getPersonalCredential) : null);
};
export const checkedBoundCredential = async (signal?: AbortSignal, sharedOnly = false): Promise<PersonalCredential | null> => {
  const scope = getBudgetScope();

  if (scope?.channelId.startsWith('private:')) return checkedPersonalCredential(signal);
  const shared = await checkedGroupCredential(signal);
  const own = sharedOnly ? null : ownScope();

  return shared || (own ? withBudgetScope(own, () => checkedPersonalCredential(signal)) : null);
};
export const disableBoundCredential = (credential: PersonalCredential, reason: 'balance' | 'auth' = 'balance'): Promise<boolean> =>
  credential.scope.channelId.startsWith('private:')
    ? updatePersonalKey(credential.scope, 'disable', credential.revision, reason)
    : updateGroupKey(credential.scope, credential.revision, reason);
