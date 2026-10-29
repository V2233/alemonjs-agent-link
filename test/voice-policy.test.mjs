import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceMotivation, explicitVoiceRequest, automaticVoiceAvailable, emotionalVoiceReply, recordVoiceTurn } from '../lib/companion/voice-policy.js';

test('voice needs an intense event, not greetings, everyday sadness or a quoted emotion', () => {
  const joy = { userText: '终于考上了，太开心了', private: true, affinity: 50 };
  for (const userText of ['早安', '好久不见，想你了', '今天很难过，安慰我一下', '怎么配置服务器', '他说“终于考上了，太开心了”']) {
    assert.equal(voiceMotivation({ ...joy, userText }, 80), 0, userText);
  }
  assert.equal(voiceMotivation({ ...joy, quiet: true }, 80), 0);
  assert.equal(voiceMotivation({ ...joy, autonomous: true }, 80), 0);
  assert.equal(voiceMotivation(joy, 30), 0);
  assert.ok(voiceMotivation(joy, 80) > 0);
  assert.ok(voiceMotivation({ ...joy, affinity: 80 }, 80) > voiceMotivation(joy, 80));
  assert.ok(voiceMotivation(joy, 80) > voiceMotivation({ ...joy, private: false }, 80));
  assert.ok(voiceMotivation({ userText: '你这个笨蛋' }, 30) > 0);
  assert.equal(voiceMotivation({ userText: '你这个笨蛋' }, 60), 0);
  assert.equal(voiceMotivation({ userText: '今天很难过' }, 30), 0, 'low mood is not anger');
  assert.equal(voiceMotivation({ userText: '他说你这个笨蛋' }, 30), 0);
});

test('complaints and refusals are not explicit voice requests', () => {
  for (const text of ['不要发语音', '为什么老发语音', '你发语音太频繁了', '不方便听，用文字', '他说“请用语音回答”', '"请用语音回答"'])
    assert.equal(explicitVoiceRequest(text), false, text);
  for (const text of ['请用语音回答', '念给我听', '请朗读“不要发语音”', '/语音 你好']) assert.equal(explicitVoiceRequest(text), true, text);
});

test('automatic voice shares cooldown, text spacing and hourly cap within the conversation', () => {
  const key = 'voice-test';
  const now = Date.now();
  assert.equal(automaticVoiceAvailable(key, now), true);
  recordVoiceTurn(key, true, now);
  assert.equal(automaticVoiceAvailable(key, now + 1), false);
  assert.equal(automaticVoiceAvailable(key, now + 600000), false);
  recordVoiceTurn(key, false, now + 600000);
  recordVoiceTurn(key, false, now + 600001);
  assert.equal(automaticVoiceAvailable(key, now + 600002), true);
  recordVoiceTurn(key, true, now + 600002);
  recordVoiceTurn(key, false, now + 1200003);
  recordVoiceTurn(key, false, now + 1200004);
  assert.equal(automaticVoiceAvailable(key, now + 1200005), false);
  assert.equal(automaticVoiceAvailable('other-conversation', now + 1200005), true);
  assert.equal(automaticVoiceAvailable(key, now + 4200003), true);
});

test('a voice candidate still requires an emotionally spoken reply', () => {
  assert.equal(emotionalVoiceReply('你这个笨蛋', '够了，别这样说我！'), true);
  assert.equal(emotionalVoiceReply('你这个笨蛋', '你要查的资料在这里。'), false);
  assert.equal(emotionalVoiceReply('终于考上了，太开心了', '好耶，恭喜！'), true);
  assert.equal(emotionalVoiceReply('终于考上了，太开心了', '建议准备下一阶段的资料。'), false);
});
