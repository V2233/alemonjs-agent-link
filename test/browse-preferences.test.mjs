import test from 'node:test';
import assert from 'node:assert/strict';
import { browsePreferences, excludedBrowseTopic, rankBrowseCandidates } from '../lib/bili/preferences.js';

test('reading preferences are bounded and deduplicated', () => {
  assert.deepEqual(browsePreferences({}), { topics: [], exclude: [] });
  assert.deepEqual(browsePreferences({ dailyBrowseTopics: [' 游戏 ', '游戏'], dailyBrowseExclude: ['恐怖'] }), { topics: ['游戏'], exclude: ['恐怖'] });
  for (const value of ['游戏', [1], [''], ['a\nb'], ['a'.repeat(41)], Array(11).fill('游戏')]) {
    assert.throws(() => browsePreferences({ dailyBrowseTopics: value }));
    assert.throws(() => browsePreferences({ dailyBrowseExclude: value }));
  }
});

test('topic exclusion uses normalized literal matches in title and description', () => {
  assert.equal(excludedBrowseTopic({ title: 'ＡＰＥＸ 实况', description: '' }, ['apex']), true);
  assert.equal(excludedBrowseTopic({ title: '游戏故事', description: '含恐怖内容' }, ['恐怖']), true);
  assert.equal(excludedBrowseTopic({ title: '鲸鱼生态', description: '海洋研究' }, ['恐怖']), false);
  assert.equal(excludedBrowseTopic({ title: '普通视频', description: '' }, ['.*']), false);
});

test('candidate ranking favors title matches, keeps ties stable and explains each match', () => {
  const items = [
    { id: 'unrelated', title: '日常', description: '今天的生活' },
    { id: 'description', title: '一段记录', description: '讨论海洋生态' },
    { id: 'title', title: '海洋生态研究', description: '海洋生态资料' },
    { id: 'tie', title: '海洋生态观察', description: '' }
  ];
  const snapshot = structuredClone(items);
  const ranked = rankBrowseCandidates(items, ['海洋生态']);
  assert.deepEqual(
    ranked.map(item => item.id),
    ['title', 'tie', 'description', 'unrelated']
  );
  assert.deepEqual(ranked[0].matchedTopics, ['海洋生态']);
  assert.deepEqual(ranked.at(-1).matchedTopics, []);
  assert.deepEqual(items, snapshot);
  assert.deepEqual(
    rankBrowseCandidates(items, []).map(item => item.id),
    items.map(item => item.id)
  );
});

test('equivalent normalized topics do not inflate relevance', () => {
  const items = [
    { id: 'two', title: 'APEX 和海洋生态', description: '' },
    { id: 'one', title: 'ＡＰＥＸ', description: '' }
  ];
  const ranked = rankBrowseCandidates(items, ['apex', 'ＡＰＥＸ', '海洋生态']);
  assert.deepEqual(
    ranked.map(item => item.id),
    ['two', 'one']
  );
  assert.equal(ranked[1].matchedTopics.length, 1);
});

test('feedback requires an explicit topic and configuration exclusions retain priority', async () => {
  const { parseBrowseFeedback, mergeBrowseFeedback } = await import('../lib/bili/preferences.js');
  assert.deepEqual(parseBrowseFeedback('以后多看 独立游戏'), { topic: '独立游戏', preference: 'like' });
  assert.deepEqual(parseBrowseFeedback('以后别看恐怖。'), { topic: '恐怖', preference: 'avoid' });
  assert.deepEqual(parseBrowseFeedback('恢复推荐恐怖'), { topic: '恐怖', preference: 'clear' });
  for (const text of ['哈哈', '不喜欢', '他说以后别看恐怖', '以后多看什么', '以后多看这个视频', '以后多看游戏吗', '以后多看“游戏”'])
    assert.equal(parseBrowseFeedback(text), undefined);
  assert.deepEqual(
    mergeBrowseFeedback({ topics: ['游戏'], exclude: ['恐怖'] }, [
      { topic: '恐怖', preference: 'like' },
      { topic: '海洋', preference: 'like' },
      { topic: '游戏', preference: 'avoid' }
    ]),
    { topics: ['海洋'], exclude: ['恐怖', '游戏'] }
  );
});
