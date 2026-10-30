import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatArchive } from '../lib/history/store.js';
import { isMissedReplyFeedback, missedReplyContext } from '../lib/social/missed-reply.js';

test('complaints include speaking up for another person but exclude quotations', () => {
  for (const text of ['肥鱼，你干嘛不理人家', '你怎么不回我', '漏掉了重要的消息']) assert.equal(isMissedReplyFeedback(text), true);
  for (const text of ['他说“你怎么不理我”', '比如你不理我', '这个命令怎么用']) assert.equal(isMissedReplyFeedback(text), false);
});
test('repair finds older unlinked commands without confusing another reply, person or group', () => {
  const root = mkdtempSync(join(tmpdir(), 'missed-reply-'));
  const archive = new ChatArchive(join(root, 'archive.sqlite'));
  const scope = { platform: 'qq', botId: 'bot', channelId: 'group' };
  const now = Date.now();
  const append = (id, text, extra = {}, target = scope) =>
    archive.append(target, { id, text, speakerId: 'original-user', speaker: '太炎真星', role: 'user', timestamp: now - 45 * 60000, ...extra });
  try {
    append('old', '/过期命令', { timestamp: now - 3 * 3600000 });
    append('state', '/状态');
    append('start', '/踏入仙途');
    append('answered', '/已经回答');
    append('receipt', '已回复', { role: 'assistant', sourceMessageId: 'answered', speakerId: 'bot', timestamp: now - 40 * 60000 });
    archive.recordReplyState(scope, 'answered', 'partial');
    archive.recordReplyState(scope, 'answered', 'delivered');
    append('secret', '/私密命令', {}, { ...scope, channelId: 'another' });
    for (let i = 0; i < 45; i++) append(`chat-${i}`, '普通闲聊', { speakerId: 'other-user', timestamp: now - 10 * 60000 });
    const result = missedReplyContext(archive, scope, '肥鱼，你干嘛不理人家', now);
    assert.match(result, /太炎真星/);
    assert.match(result, /"messageId":"state"/);
    assert.match(result, /"messageId":"start"/);
    assert.doesNotMatch(result, /已经回答|过期命令|私密命令|普通闲聊/);
    assert.match(result, /旧命令不得重新执行/);
    assert.equal(missedReplyContext(archive, scope, '你好', now), '');
  } finally {
    archive.close();
    rmSync(root, { recursive: true, force: true });
  }
});
