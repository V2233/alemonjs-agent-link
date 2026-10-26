#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const MANAGED_REMARK_PREFIX = 'AgentLink command panel:';
const configPath = new URL('../alemon.config.yaml', import.meta.url);

const command = (name, desc, only_admin = false) => ({
  name,
  desc,
  type: 'command',
  only_admin
});

const panels = [
  {
    scope: 'group',
    target_type: 'all',
    panel: {
      remark: `${MANAGED_REMARK_PREFIX} group`,
      items: [
        command('/提问 ', '向 Agent 提问'),
        command('/取消', '取消自己的请求'),
        command('/新会话', '开始新的群会话', true),
        command('/聊天参考', '查看近期聊天参考'),
        command('/工具策略', '查看本群工具策略', true),
        command('/状态', '查看服务状态'),
        command('/隐私说明', '查看数据与隐私说明'),
        command('/帮助', '查看完整使用说明')
      ]
    }
  },
  {
    scope: 'c2c',
    target_type: 'all',
    panel: {
      remark: `${MANAGED_REMARK_PREFIX} owner-c2c`,
      items: [
        command('/提问 ', '向 Agent 提问'),
        command('/状态', '查看完整服务状态'),
        command('/模型列表', '查看可用模型'),
        command('/当前模型', '查看当前配置模型'),
        command('/帮助', '查看完整管理说明')
      ]
    }
  }
];

const request = async (url, options = {}) => {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`QQ API ${options.method || 'GET'} ${new URL(url).pathname} returned HTTP ${response.status}`);
  }

  return await response.json();
};

const getCredentials = async () => {
  const config = parse(await readFile(configPath, 'utf8')) || {};
  const qq = config['qq-bot'] || config['@alemonjs/qq-bot'] || {};
  const botId = qq.default_bot || Object.keys(qq.bots || {})[0];
  const bot = botId ? { ...qq, ...qq.bots?.[botId], app_id: botId } : qq;

  if (!bot.app_id || !bot.secret) {
    throw new Error('qq-bot.app_id and qq-bot.secret must be configured in alemon.config.yaml');
  }

  return bot;
};

const listPanels = async (apiBase, headers, scope) => {
  const records = [];
  let cursor = '';

  for (;;) {
    const query = new URLSearchParams({ scope, limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const page = await request(`${apiBase}/v2/panels?${query}`, { headers });
    records.push(...(page.records || []));
    if (page.is_end || !page.next_cursor) return records;
    cursor = page.next_cursor;
  }
};

const main = async () => {
  const bot = await getCredentials();
  const tokenResult = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: String(bot.app_id), clientSecret: String(bot.secret) })
  });
  const accessToken = tokenResult.access_token;

  if (!accessToken) throw new Error('QQ access-token response did not include access_token');

  const apiBase = bot.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com';
  const headers = {
    Authorization: `QQBot ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Union-Appid': String(bot.app_id)
  };

  for (const desired of panels) {
    const existing = (await listPanels(apiBase, headers, desired.scope)).filter(
      record => record.target_type === 'all' && record.panel?.remark === desired.panel.remark
    );

    if (existing.length === 0) {
      const result = await request(`${apiBase}/v2/panels`, {
        method: 'POST',
        headers,
        body: JSON.stringify(desired)
      });
      console.log(`created ${desired.scope} command panel: ${result.panel_id}`);
      continue;
    }

    for (const record of existing) {
      const result = await request(`${apiBase}/v2/panels/${encodeURIComponent(record.panel_id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ panel: desired.panel })
      });
      console.log(`updated ${desired.scope} command panel: ${record.panel_id} (version ${result.version})`);
    }
  }
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'QQ command panel synchronization failed');
  process.exitCode = 1;
});
