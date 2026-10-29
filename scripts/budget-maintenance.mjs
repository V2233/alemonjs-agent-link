// Run on the stopped/drained service host; config is read locally and never printed.
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import Redis from 'ioredis';
const [configPath, action, ...args] = process.argv.slice(2);
if (!configPath || !['pending', 'retain', 'migrate', 'settle'].includes(action)) {
  console.error('Usage: node scripts/budget-maintenance.mjs CONFIG pending | retain | migrate YYYY-MM-DD | settle RECEIPT ACTUAL_YUAN OPERATOR');
  process.exit(1);
}
let redis;
try {
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  if (!config?.db?.redis) throw new Error('missing Redis');
  redis = new Redis({ ...config.db.redis, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  await redis.ping();
  globalThis.ioRedis = redis;
  const { retainPendingBudgetRequests, pendingBudgetRequests, migrateLegacyWallets, reconcileBudgetRequest } = await import('../lib/billing/budget.js');
  const result =
    action === 'retain'
      ? await retainPendingBudgetRequests()
      : action === 'pending'
        ? await pendingBudgetRequests()
        : action === 'migrate'
          ? await migrateLegacyWallets(args[0] || '')
          : await reconcileBudgetRequest(args[0] || '', args[1] || '', args.slice(2).join(' '));
  console.log(JSON.stringify(result, null, 2));
  if (action === 'migrate' && result.report.some(row => row.result === 'pending')) process.exitCode = 2;
} catch {
  console.error('Maintenance failed. Check config, fixed migration date, receipt age and arguments; no credentials are printed.');
  process.exitCode = 1;
} finally {
  redis?.disconnect();
}
