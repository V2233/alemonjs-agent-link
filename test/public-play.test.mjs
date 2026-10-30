import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPageUrl, pageText, publicSearchResults, readablePublicText } from '../lib/proactive/public-web.js';
import { normalizeHobbies } from '../lib/companion/hobbies.js';

test('public exploration excludes QQ private sources and authenticated URLs', () => {
  for (const url of ['https://user.qzone.qq.com/1', 'https://qzone.com/', 'https://a:b@weibo.com/', 'http://example.com/', 'https://example.com:8443/'])
    assert.throws(() => publicPageUrl(url));
  assert.equal(publicPageUrl('https://weibo.com/123'), 'https://weibo.com/123');
});
test('interests accept arbitrary public source domains and no fixed platform selection', () => {
  const options = normalizeHobbies({ enabled: true, autonomous: true, interests: '天文和动物', publicSources: ['example.org'] });
  assert.deepEqual(options.publicSources, ['example.org']);
  assert.throws(() => normalizeHobbies({ publicSources: ['qzone.qq.com'] }));
  assert.deepEqual(normalizeHobbies({ publicSources: [] }).publicSources, []);
});
test('public text excludes scripts and bounds stored evidence', () => {
  assert.equal(pageText('<script>secret</script><style>hidden</style><p>actual &amp; text</p>'), 'actual & text');
  assert.equal(pageText('x'.repeat(20000)).length, 10000);
});

test('search exposes deduplicated actual links, excludes private results and does not treat HTML login as results', async () => {
  const item = url => `<item><title><![CDATA[星空 &amp; 行星]]></title><link>${url}</link><description>公开资料</description></item>`;
  assert.deepEqual(
    publicSearchResults('<rss>' + item('https://example.org/article') + item('https://example.org/article') + item('https://user.qzone.qq.com/1') + '</rss>'),
    [{ title: '星空 & 行星', url: 'https://example.org/article', snippet: '公开资料' }]
  );
  assert.deepEqual(publicSearchResults('<html>请先登录</html>'), []);
});

test('login, verification and empty shells cannot count as reading evidence', async () => {
  assert.equal(readablePublicText('正文不足'), false);
  assert.equal(readablePublicText('请先登录' + '导航'.repeat(100)), false);
  assert.equal(readablePublicText('Verify you are human ' + 'x'.repeat(200)), false);
  assert.equal(readablePublicText('这是一段关于行星观测的公开资料。'.repeat(30)), true);
});

test('public page identity removes tracking and fragments but preserves semantic query parameters', () => {
  assert.equal(publicPageUrl('https://example.org/read?id=1&utm_source=feed&spm=123#from'), 'https://example.org/read?id=1');
  assert.equal(publicPageUrl('https://example.org/read?from=2026&page=2'), 'https://example.org/read?from=2026&page=2');
  assert.equal(publicSearchResults('<rss><item><link>https://example.org/a?utm_source=one</link></item><item><link>https://example.org/a?utm_source=two</link></item></rss>').length, 1);
});
