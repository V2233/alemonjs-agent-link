import { join } from 'node:path';
import { BiliCommentLedger } from '../bili/comment-ledger';

const stores = new Map<string, BiliCommentLedger>();

export const qzoneLedger = (root: string): BiliCommentLedger => {
  let store = stores.get(root);

  if (!store) {
    store = new BiliCommentLedger(join(root, 'qzone'));
    stores.set(root, store);
  }

  return store;
};
