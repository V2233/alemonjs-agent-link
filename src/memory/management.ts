import type { DSHBridgeConfig } from '../dsh/client';
import { SessionRegistry } from '../state/registry';
import { getChatArchive } from '../history/store';
import { getMemoryStore, memoryTextKey, type MemoryScope } from './store';

export const synchronizeExplicitMemory = async (config: DSHBridgeConfig, scope: MemoryScope, userId: string): Promise<void> => {
  if (!scope.channelId.startsWith('private:')) {
    return;
  }
  const notes = await new SessionRegistry(config).privateMemories(scope.channelId);

  getMemoryStore(config).syncExplicit(scope, userId, notes);
};

export const forgetMemory = async (config: DSHBridgeConfig, scope: MemoryScope, userId: string, id?: string): Promise<'ok' | 'missing'> => {
  const registry = new SessionRegistry(config);
  const store = getMemoryStore(config);

  await synchronizeExplicitMemory(config, scope, userId);
  const checkpoint = getChatArchive(config).latestSeq(scope);

  if (!id) {
    if (scope.channelId.startsWith('private:')) {
      await registry.changePrivateMemory(scope.channelId, 'clear');
    }
    store.clear(scope, checkpoint);

    return 'ok';
  }
  const item = store.get(scope, id);

  if (item?.origin === 'explicit') {
    const notes = await registry.privateMemories(scope.channelId);

    for (const note of notes.filter(entry => memoryTextKey(entry.text) === memoryTextKey(item.text))) {
      const removed = await registry.changePrivateMemory(scope.channelId, 'remove', note.id);

      if (removed.status !== 'ok') {
        throw new Error('明确资料删除未完成。');
      }
    }
  }

  return store.forget(scope, id, checkpoint) ? 'ok' : 'missing';
};
