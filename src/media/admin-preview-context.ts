import { AsyncLocalStorage } from 'node:async_hooks';

// Only authenticated administration services enter this scope. Provider charges
// and global AI availability still apply; a preview has no chat wallet owner.
const preview = new AsyncLocalStorage<boolean>();

export const isAdminSpeechPreview = (): boolean => preview.getStore() === true;
export const withAdminSpeechPreview = <T>(run: () => Promise<T>): Promise<T> => preview.run(true, run);
