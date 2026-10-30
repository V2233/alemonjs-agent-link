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
        command('/帮助', '查看使用说明与更多指令'),
        command('/提问 ', '填写问题开始聊天'),
        command('/取消', '取消自己的请求'),
        command('/新会话', '管理员开始新的群会话', true),
        command('/人格', '查看人格与切换权限'),
        command('/人设', '查看人设与编辑权限'),
        command('/心情', '查看当前心情'),
        command('/智能程度', '查看档位与调整权限'),
        command('/语音 ', '填写问题听语音回答'),
        command('/表情', '查看或发送表情'),
        command('/群记忆', '查看本群记忆'),
        command('/记忆检索 ', '按关键词查找记忆'),
        command('/聊天参考', '查看近期聊天参考'),
        command('/额度', '查看今日剩余额度'),
        command('/我的权限', '查看自己的权益与权限'),
        command('/我的钥匙', '管理员管理群钥匙', true),
        command('/群设置', '查看设置，管理员可修改'),
        command('/状态', '查看服务状态'),
        command('/隐私说明', '查看数据与删除入口')
      ]
    }
  },
  {
    scope: 'c2c',
    target_type: 'all',
    panel: {
      remark: `${MANAGED_REMARK_PREFIX} owner-c2c`,
      items: [
        command('/帮助', '查看使用说明与更多指令'),
        command('/提问 ', '填写问题开始聊天'),
        command('/取消', '取消自己的请求'),
        command('/新会话', '开始新的私聊会话'),
        command('/人格', '查看人格与切换权限'),
        command('/人设', '查看人设与编辑权限'),
        command('/心情', '查看当前心情'),
        command('/智能程度', '查看档位与调整权限'),
        command('/语音 ', '填写问题听语音回答'),
        command('/表情', '查看或发送表情'),
        command('/记忆', '查看自己的记忆'),
        command('/记住 ', '填写要保存的偏好'),
        command('/记忆检索 ', '按关键词查找记忆'),
        command('/额度', '查看今日剩余额度'),
        command('/我的权限', '查看自己的权益与权限'),
        command('/我的钥匙', '管理个人钥匙与群授权'),
        command('/状态', '查看服务状态'),
        command('/隐私说明', '查看数据与删除入口')
      ]
    }
  }
];

const width = text => [...text].reduce((total, char) => total + (char.codePointAt(0) > 127 ? 2 : 1), 0);

for (const { scope, panel } of panels) {
  if (panel.items.length > 20) throw new Error(`${scope} panel exceeds 20 items`);
  if (new Set(panel.items.map(item => item.name.trim())).size !== panel.items.length) throw new Error(`${scope} panel has duplicate commands`);
  for (const item of panel.items) {
    if (width(item.name) > 14 || width(item.desc) > 30) throw new Error(`${scope} panel item is too long: ${item.name}`);
  }
}

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
  if (process.argv.includes('--dry-run')) {
    for (const { scope, panel } of panels) console.log(`${scope}: ${panel.items.length} commands\n${panel.items.map(item => item.name.trim()).join('、')}`);

    return;
  }
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

  for (const desired of process.argv.includes('--verify-only') ? [] : panels) {
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
  for (const desired of panels) {
    const saved = (await listPanels(apiBase, headers, desired.scope)).filter(record => record.panel?.remark === desired.panel.remark);

    if (
      !saved.length ||
      saved.some(
        record =>
          JSON.stringify(record.panel.items.map(item => item.name.replace(/^\//u, '').trim())) !==
          JSON.stringify(desired.panel.items.map(item => item.name.replace(/^\//u, '').trim()))
      )
    ) {
      throw new Error(`${desired.scope} panel read-back mismatch`);
    }
    console.log(`verified ${desired.scope}: ${desired.panel.items.length} commands`);
  }
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'QQ command panel synchronization failed');
  process.exitCode = 1;
});
