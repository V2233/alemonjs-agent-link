import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../lib/response/history-capture/res.js';
import { getInteractionStore } from '../lib/companion/interaction.js';

test('real capture records feedback without requiring a bot reply and passes other plugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'interaction-framework-'));
  const config = {
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    stateBackend: 'local',
    modules: { settings: { proactive: { autoSubscribe: false } } }
  };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const store = getInteractionStore(config);
  const scope = { platform: 'qq-bot', botId: 'bot', channelId: 'group', userId: 'human' };
  try {
    for (const [text, reason] of [
      ['我困了', 'eligible'],
      ['别催我', 'declined'],
      ['我准备睡了', 'resting'],
      ['已经喝了水', 'resting'],
      ['我醒了', 'declined'],
      ['可以提醒我', 'no-current-evidence'],
      ['我们来角色扮演', 'roleplay'],
      ['我先睡了', 'roleplay'],
      ['不演了', 'no-current-evidence']
    ]) {
      const result = await app.runHandler(
        handler,
        app.events.groupMessage(
          {},
          {
            Platform: scope.platform,
            BotId: scope.botId,
            ChannelId: scope.channelId,
            UserId: scope.userId,
            MessageId: text,
            MessageText: text,
            IsBot: false,
            IsPrivate: false
          }
        ),
        'alemonjs-agent-link'
      );
      assert.equal(result.errors.length, 0);
      assert.equal(result.nextCalls.length, 1);
      assert.equal(result.messages.length, 0);
      assert.equal(store.decision(scope).reason, reason);
    }
    const result = await app.runHandler(
      handler,
      app.events.groupMessage(
        {},
        {
          Platform: scope.platform,
          BotId: scope.botId,
          ChannelId: scope.channelId,
          UserId: 'another-bot',
          MessageId: 'bot-input',
          MessageText: '我困了',
          IsBot: true
        }
      ),
      'alemonjs-agent-link'
    );
    assert.equal(result.nextCalls.length, 1);
    assert.equal(store.decision({ ...scope, userId: 'another-bot' }).reason, 'no-current-evidence');
  } finally {
    await app.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
