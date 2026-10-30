import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatArchive, getChatArchive } from '../lib/history/store.js';
import { archiveIncoming, archiveReply } from '../lib/history/capture.js';
import { MessageReferences } from '../lib/social/references.js';
const scope = { platform: 'test', channelId: 'group' };
const event = { Platform: 'test', ChannelId: 'group', BotId: 'fish', UserId: 'alice', UserName: 'Alice', MessageId: 'question', MessageText: '你怎么看？' };

test('old database migrates without losing history and repeated reopening is safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-migration-'));
  let archive;
  try {
    const path = join(root, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(
      `CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,group_hash TEXT NOT NULL,message_id TEXT NOT NULL,speaker_id TEXT NOT NULL,speaker TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,timestamp INTEGER NOT NULL,truncated INTEGER NOT NULL,UNIQUE(scope,role,message_id));`
    );
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256')
      .update(JSON.stringify([scope.platform, scope.channelId]))
      .digest('hex');
    old
      .prepare('INSERT INTO messages(scope,group_hash,message_id,speaker_id,speaker,role,text,timestamp,truncated) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(key, 'group', 'legacy', 'alice', 'Alice', 'user', '旧记录', Date.now(), 0);
    old.close();
    archive = new ChatArchive(path);
    assert.equal(archive.search(scope).items[0].text, '旧记录');
    assert.equal(archive.search(scope).items[0].platformIdKnown, false);
    archive.close();
    archive = new ChatArchive(path);
    assert.equal(archive.search(scope).items.length, 1);
  } finally {
    archive?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('receipts and reference aliases preserve direct reply vs batch source, including media and missing receipt IDs', async () => {
  const scope = { platform: 'test', botId: 'fish', channelId: 'group' };
  const root = await mkdtemp(join(tmpdir(), 'history-receipt-'));
  const config = { dshHomeRoot: join(root, 'homes'), retentionDays: 30, modules: { disabled: ['memory'] } };
  const archive = getChatArchive(config);
  try {
    archiveIncoming(config, { ...event, OccurredAt: 1000, MessageMentions: [{ UserId: 'bob', UserName: 'Bob' }] });
    archiveReply(config, event, '回答 Bob', { id: 'answer', referenceId: 'answer-alias' }, 'bobs-message');
    archiveReply(config, event, '回答 Bob', { id: 'answer', referenceId: 'answer-alias' }, 'bobs-message');
    archiveReply(config, event, '语音回答', { fileId: 'file', messageId: 'audio' }, 'question');
    archiveReply(config, event, '平台未返回 ID', null, 'question');
    const answer = archive.search(scope, { messageId: 'answer-alias' }).items[0];
    assert.equal(answer.messageId, 'answer');
    assert.equal(answer.replyToId, 'bobs-message');
    assert.equal(answer.sourceMessageId, 'question');
    assert.equal(answer.speakerId, 'fish');
    assert.equal(answer.platformIdKnown, true);
    assert.equal(archive.search(scope, { messageId: 'answer' }).items.length, 1);
    assert.equal(archive.findMessage(scope, 'audio').platformIdKnown, true);
    assert.equal(archive.search(scope, { keyword: '未返回' }).items[0].platformIdKnown, false);
    const question = archive.findMessage(scope, 'question');
    assert.equal(question.context.mentions[0].id, 'bob');
    assert.equal(question.context.time.occurredAt, '1970-01-01T00:00:01.000Z');
    const seq = archive.search(scope, { messageId: 'question' }).items[0].seq;
    assert.ok(archive.context(scope, seq).related.some(row => row.messageId === 'audio'));
    assert.equal(archive.findMessage({ ...scope, channelId: 'other' }, 'answer-alias'), undefined);
    archive.invalidate(scope, 'answer-alias');
    assert.equal(archive.findMessage(scope, 'answer'), undefined);
  } finally {
    archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh reference cache recovers persisted replies but respects disabled history, scope and deletion', async () => {
  const scope = { platform: 'test', botId: 'fish', channelId: 'group' };
  const root = await mkdtemp(join(tmpdir(), 'history-reference-'));
  const original = globalThis.__config;
  const settings = {
    apiKey: 'test',
    model: 'test',
    runtimeMode: 'chat-only',
    stateBackend: 'local',
    dshHomeRoot: join(root, 'homes'),
    workspaceRoot: join(root, 'work'),
    modules: { disabled: ['memory'] }
  };
  globalThis.__config = { value: { 'alemonjs-agent-link': settings } };
  const archive = getChatArchive(settings);
  try {
    archiveReply(settings, event, '真实历史回答', { id: 'answer', referenceId: 'alias' }, 'question');
    const prepared = await new MessageReferences().prepare({ ...event, MessageId: 'next', ReplyId: 'alias' });
    assert.equal(JSON.parse(prepared.context).quote.text, '真实历史回答');
    assert.equal(prepared.quotedBot, true);
    const other = await new MessageReferences().prepare({ ...event, ChannelId: 'other', MessageId: 'next', ReplyId: 'alias' });
    assert.equal(JSON.parse(other.context).quote, undefined);
    settings.modules.disabled.push('chat-history');
    assert.equal(JSON.parse((await new MessageReferences().prepare({ ...event, MessageId: 'disabled', ReplyId: 'alias' })).context).quote, undefined);
    settings.modules.disabled.pop();
    archive.invalidate(scope, 'answer');
    assert.equal(JSON.parse((await new MessageReferences().prepare({ ...event, MessageId: 'deleted', ReplyId: 'alias' })).context).quote, undefined);
  } finally {
    archive.close();
    globalThis.__config = original;
    await rm(root, { recursive: true, force: true });
  }
});
