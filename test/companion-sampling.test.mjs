import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { completeSample, sampleCompanion, sampleMessages } from '../scripts/sample-companion.mjs';
import { summarizeComparison } from '../scripts/compare-companion.mjs';
const corpus = JSON.parse(await readFile(new URL('../benchmarks/companion-scenarios.json', import.meta.url), 'utf8'));
const endpoint = { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'secret-test-key' };

test('sampling sends scene evidence and conversation without leaking reviewer targets into model input', () => {
  const scenario = corpus.cases.find(item => item.id === 'private_thread');
  const messages = sampleMessages(scenario, '人物设定');
  assert.match(messages[0].content, /ambient/);
  assert.match(messages[0].content, /无业务工具/);
  assert.ok(!JSON.stringify(messages).includes(scenario.reviewFocus));
  assert.equal(messages.at(-1).content, scenario.conversation.at(-1).text);
});

test('API adapter has explicit sampling limits, forbids redirects and never executes returned tools', async () => {
  let body;
  const common = { endpoint, messages: sampleMessages(corpus.cases[0], '人物'), signal: new AbortController().signal };
  const sampled = await completeSample({
    ...common,
    fetcher: async (url, init) => {
      assert.equal(url.href, 'https://model.example/v1/chat/completions');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer secret-test-key');
      body = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: '在呢' }, finish_reason: 'length' }], usage: { total_tokens: 123 } });
    }
  });
  assert.equal(body.max_tokens, 256);
  assert.equal(body.temperature, 0.6);
  assert.equal(body.tools, undefined);
  assert.equal(sampled.truncated, true);
  assert.equal(sampled.usage.total_tokens, 123);
  await assert.rejects(
    completeSample({ ...common, fetcher: async () => Response.json({ choices: [{ message: { content: '运行工具', tool_calls: [{}] } }] }) }),
    /invalid_content/
  );
  await assert.rejects(completeSample({ ...common, endpoint: { ...endpoint, baseUrl: 'http://model.example' } }), /invalid_endpoint/);
});

test('actual samples remain unscored, silence stays distinct from missing data, and failures stop further requests', async () => {
  let calls = 0;
  const result = await sampleCompanion({
    corpus,
    persona: '测试人格',
    model: 'test-model',
    endpointLabel: 'test',
    limit: 3,
    complete: async () => {
      calls++;
      if (calls === 1) return { text: '[沉默]', truncated: false };
      if (calls === 2) return { text: '回答', truncated: true, usage: { total_tokens: 4 } };
      throw new Error('provider error containing secret-test-key');
    }
  });
  assert.equal(result.responses[0].kind, 'silence');
  assert.equal(result.responses[0].response, '');
  assert.equal(result.responses[1].truncated, true);
  assert.equal(result.responses[2].kind, null);
  assert.equal(result.responses[2].sampleFailure.category, 'request_failed');
  assert.equal(result.responses[3].kind, null);
  assert.equal(calls, 3);
  assert.equal(result.sampling.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
  const summary = summarizeComparison(corpus, result);
  assert.equal(summary.status, 'pending');
  assert.equal(summary.reviewed, 0);
  assert.equal(summary.scores.naturalness, null);
  assert.deepEqual(summary.generation, { sampled: 2, truncated: 1, failed: 1 });
});

test('cancelled sampling leaves untouched cases pending and dry-run does not read local credentials or create output', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await sampleCompanion({
    corpus,
    persona: '人物',
    model: 'test',
    endpointLabel: 'test',
    signal: controller.signal,
    complete: async () => assert.fail('cancelled')
  });
  assert.equal(result.sampling.completed, 0);
  assert.equal(result.sampling.status, 'cancelled');
  const root = await mkdtemp(join(tmpdir(), 'companion-dry-run-'));
  try {
    const output = join(root, 'unused.json');
    const { stdout } = await promisify(execFile)(process.execPath, [
      'scripts/sample-companion.mjs',
      '--dry-run',
      '--config',
      join(root, 'missing.yaml'),
      '--out',
      output
    ]);
    assert.equal(JSON.parse(stdout).network, false);
    await assert.rejects(stat(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI refuses an existing output before any model request and does not echo credentials', async () => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'companion-existing-'));
  try {
    const output = join(root, 'existing.json');
    const config = join(root, 'config.yaml');
    await writeFile(output, 'keep existing');
    await writeFile(config, 'alemonjs-agent-link:\n  apiKey: secret-test-key\n  baseUrl: https://model.example/v1\n  model: test-model\n');
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/sample-companion.mjs', '--out', output, '--config', config]), error => {
      assert.match(error.stderr, /已存在/);
      assert.ok(!error.stderr.includes('secret-test-key'));
      assert.equal(error.stdout, '');
      return true;
    });
    assert.equal(await readFile(output, 'utf8'), 'keep existing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('thinking mode is explicit in requests and metadata without storing reasoning text', async () => {
  let request;
  const response = await completeSample({
    endpoint,
    messages: [{ role: 'user', content: '在吗' }],
    thinking: 'disabled',
    signal: new AbortController().signal,
    fetcher: async (_url, init) => {
      request = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: '在', reasoning_content: 'not-to-be-persisted' }, finish_reason: 'stop' }] });
    }
  });
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(response.hadReasoning, true);
  assert.ok(!JSON.stringify(response).includes('not-to-be-persisted'));
  const result = await sampleCompanion({
    corpus,
    persona: '人物',
    model: 'test',
    endpointLabel: 'test',
    thinking: 'disabled',
    limit: 1,
    complete: async () => response
  });
  assert.equal(JSON.parse(result.settings).thinkingRequested, 'disabled');
  assert.equal(result.responses[0].hadReasoning, true);
  await assert.rejects(completeSample({ endpoint, thinking: 'invalid', signal: new AbortController().signal }), /thinking/);
});

test('holdout corpus has independent identities and dry-run selects it without reading credentials', async () => {
  const holdout = JSON.parse(await readFile(new URL('../benchmarks/companion-holdout-scenarios.json', import.meta.url), 'utf8'));
  assert.ok(holdout.cases.every(item => !corpus.cases.some(existing => existing.id === item.id)));
  const { stdout } = await promisify(execFile)(process.execPath, [
    'scripts/sample-companion.mjs',
    '--dry-run',
    '--corpus',
    'benchmarks/companion-holdout-scenarios.json',
    '--limit',
    '6',
    '--thinking',
    'disabled',
    '--config',
    '/nonexistent/config'
  ]);
  assert.equal(JSON.parse(stdout).cases.length, 6);
  assert.equal(JSON.parse(stdout).thinkingRequested, 'disabled');
});

test('holdout samples can be summarized with their own corpus and cannot be mixed with the default corpus', async () => {
  const { writeFile } = await import('node:fs/promises');
  const holdout = JSON.parse(await readFile(new URL('../benchmarks/companion-holdout-scenarios.json', import.meta.url), 'utf8'));
  const result = await sampleCompanion({
    corpus: holdout,
    persona: '人物',
    model: 'test',
    endpointLabel: 'test',
    limit: 1,
    complete: async () => ({ text: '样本' })
  });
  const root = await mkdtemp(join(tmpdir(), 'holdout-summary-'));
  try {
    const path = join(root, 'sample.json');
    await writeFile(path, JSON.stringify(result));
    const { stdout } = await promisify(execFile)(process.execPath, [
      'scripts/compare-companion.mjs',
      '--corpus',
      'benchmarks/companion-holdout-scenarios.json',
      path
    ]);
    const report = JSON.parse(stdout).report[0];
    assert.equal(report.expected, 6);
    assert.equal(report.generation.sampled, 1);
    assert.equal(report.reviewed, 0);
    assert.throws(() => summarizeComparison(corpus, result), /版本不同/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('continuous sampling feeds actual earlier replies forward and preserves failed-turn evidence', async () => {
  const continuous = {
    cases: [
      {
        id: 'sequence',
        scope: 'private',
        conversation: [{ role: 'user', text: '项目启动不了' }],
        followUps: ['修好了', '别再追问了', '继续聊'],
        evidence: '无工具回执'
      }
    ]
  };
  const inputs = [];
  const result = await sampleCompanion({
    corpus: continuous,
    persona: '肥鱼',
    model: 'fixture',
    endpointLabel: 'fixture',
    complete: async ({ messages }) => {
      inputs.push(messages);
      if (inputs.length === 1) return { text: '报错是什么？', truncated: false };
      if (inputs.length === 2) return { text: '原来是路径问题。', truncated: true };
      if (inputs.length === 3) return { text: '[沉默]', truncated: false };
      throw new Error('private provider body');
    }
  });
  assert.equal(inputs[1].at(-2).content, '报错是什么？');
  assert.equal(inputs[2].at(-2).content, '原来是路径问题。');
  assert.ok(!inputs[3].some(row => row.content === '[沉默]'));
  assert.equal(result.responses[0].turns.length, 3);
  assert.equal(result.responses[0].turns[1].truncated, true);
  assert.equal(result.responses[0].sampleFailure.category, 'request_failed');
  assert.ok(!JSON.stringify(result).includes('private provider body'));
  assert.equal(result.sampling.status, 'failed');
});
