/** Scan the official WeChat QR inside an isolated host browser, never the authorization URL. */
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSession } from './deepseek-account-session.mjs';
let session, browser, context, cleanupPromise;
let qrDirectory, qrPath;
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    if (qrDirectory) await rm(qrDirectory, { recursive: true, force: true }).catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await session?.dispose().catch(() => {
      console.error('远端退出或取消未确认，请在平台检查授权。');
      process.exitCode = 1;
    });
  })());
try {
  session = await startSession();
  process.once('SIGINT', () => void cleanup());
  process.once('SIGTERM', () => void cleanup());
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto(session.authorizeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const qr = page.frameLocator('iframe[src^="https://open.weixin.qq.com/connect/qrconnect"]').locator('img.js_qrcode_img:visible').first();
  await qr.waitFor({ state: 'visible', timeout: 30000 });
  await qr.evaluate(async img => {
    if (!img.complete)
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
    if (!img.naturalWidth) throw new Error('QR unavailable');
  });
  await mkdir(resolve('.data/agent-link/experiments'), { recursive: true, mode: 0o700 });
  qrDirectory = await mkdtemp(resolve('.data/agent-link/experiments/qr-'));
  qrPath = resolve(qrDirectory, 'login.png');
  await writeFile(qrPath, await qr.screenshot(), { mode: 0o600 });
  console.log('官方二维码已提取：' + qrPath);
  console.log('请使用微信扫描官方登录页中的二维码，并在该浏览器完成授权确认。不要扫描授权网址生成的二维码。');
  console.log('本实验不收取手机号或验证码，不保存账户令牌；完成查询后退出。设置 DEEPSEEK_LOGIN_PROBE_MODEL 时额外进行一次最多 16 个输出 token 的模型调用。');
  console.log(JSON.stringify(await session.verify({ model: process.env.DEEPSEEK_LOGIN_PROBE_MODEL || undefined })));
} catch {
  console.error('扫码实验未完成（取消、页面不可用或授权失败），未保存凭证。');
  process.exitCode = 1;
} finally {
  await cleanup();
}
