import { getBudgetScope } from '../billing/budget';
import { getPersonalCredential, checkedPersonalCredential, updatePersonalKey, type PersonalCredential } from './personal';
import { getGroupCredential, checkedGroupCredential, updateGroupKey } from './group';

export const getBoundCredential = (): Promise<PersonalCredential | null> =>
  getBudgetScope()?.channelId.startsWith('private:') ? getPersonalCredential() : getGroupCredential();
export const checkedBoundCredential = (signal?: AbortSignal): Promise<PersonalCredential | null> =>
  getBudgetScope()?.channelId.startsWith('private:') ? checkedPersonalCredential(signal) : checkedGroupCredential(signal);
export const disableBoundCredential = (credential: PersonalCredential): Promise<boolean> =>
  credential.scope.channelId.startsWith('private:')
    ? updatePersonalKey(credential.scope, 'disable', credential.revision)
    : updateGroupKey(credential.scope, credential.revision);
