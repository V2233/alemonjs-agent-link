import { budgetRedis, type BudgetScope } from '../billing/budget';
import { decryptStoredKey, encryptionKey, type RecordValue } from './personal';

/** 展示余额不改变钥匙启停状态，也不回显服务商原始错误。 */
export const storedKeyBalance = async (storageKey: string, scope: BudgetScope, record?: RecordValue): Promise<string> => {
  try {
    const value = record ?? JSON.parse((await (await budgetRedis()).get(storageKey)) || 'null');

    if (!value) return '未绑定';
    if (value.auth === 'account') return '扫码账户暂不支持金额查询';
    const credential = decryptStoredKey(storageKey, value, scope, await encryptionKey());
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${credential.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      await response.body?.cancel();

      return '查询失败，请稍后刷新';
    }
    const data = await response.json();
    const rows = data?.balance_infos;

    if (!Array.isArray(rows) || !rows.length || rows.length > 10) return '暂未取得余额';
    const amounts: string[] = [];

    for (const row of rows) {
      if (!['CNY', 'USD'].includes(row?.currency) || typeof row.total_balance !== 'string' || !/^-?\d{1,16}(?:\.\d{1,12})?$/u.test(row.total_balance))
        return '暂未取得余额';
      amounts.push(`${row.total_balance} ${row.currency === 'CNY' ? '元' : '美元'}`);
    }

    return amounts.join(' / ');
  } catch {
    return '查询失败，请稍后刷新';
  }
};
