/**
 * Serializes async work per key. Callers for the same key run strictly one after
 * another; different keys stay concurrent. The queue entry is dropped once its
 * own run finishes so a long-lived process does not accumulate one closure per
 * channel.
 *
 * Used where a read-modify-write decision must not interleave: two callers that
 * both observe "not done yet" would each redo the work, and for a session reset
 * that means discarding the transcript twice.
 */
export const serializeByKey = <T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> => {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;

  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => gate);

  locks.set(key, tail);

  return previous.then(work).finally(() => {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  });
};
