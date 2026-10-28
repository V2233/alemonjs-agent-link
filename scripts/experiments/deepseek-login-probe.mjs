/** Non-interactive DSH authorization probe. Never sends SMS or exchanges credentials. */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const origin = 'https://platform.deepseek.com';
export async function probe({ request = fetch } = {}) {
  const server = createServer((_req, res) => res.writeHead(410, { 'cache-control': 'no-store' }).end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const verifier = randomBytes(32).toString('base64url');
  const headers = {
    'content-type': 'application/json',
    'x-client-platform': 'web',
    'x-client-version': '0.0.4',
    'x-client-locale': 'zh_CN',
    'x-client-bundle-id': '',
    'x-client-timezone-offset': '28800'
  };
  const send = async (method, body) => {
    const response = await request(`${origin}/auth-api/v0/dsh/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { http: response.status };
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) throw new Error('response-limit');
        chunks.push(part.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString());
      return { http: response.status, value };
    } finally {
      await reader.cancel();
    }
  };
  try {
    const result = await send('auth_init', {
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(32).toString('base64url'),
      redirect_uri: `http://127.0.0.1:${server.address().port}/oauth/callback`,
      locale: 'zh_CN',
      login_source: 'web'
    });
    const data = result.value?.data;
    const payload = data?.biz_data;
    const report = { stage: 'auth_init', http: result.http, code: result.value?.code, bizCode: data?.biz_code, initialized: false };
    if (result.value?.code === 0 && data?.biz_code === 0 && typeof payload?.authorize_id === 'string') {
      try {
        const url = new URL(payload.authorize_url);
        report.initialized =
          url.origin === origin &&
          url.pathname === '/dsh/authorize' &&
          !url.username &&
          !url.password &&
          !url.hash &&
          Number.isFinite(payload.expires_in) &&
          payload.expires_in > 0;
      } finally {
        const cancelled = await send('auth_cancel', { authorize_id: payload.authorize_id, code_verifier: verifier });
        report.cancelled = cancelled.value?.code === 0 && cancelled.value?.data?.biz_code === 0;
      }
    }
    return report;
  } catch {
    return { stage: 'auth_init-or-cancel', initialized: false, error: 'network-or-protocol' };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await probe(), null, 2));
}
