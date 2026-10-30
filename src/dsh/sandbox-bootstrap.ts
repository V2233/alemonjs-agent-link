import { runQuiet } from './python-bootstrap';
import { inspectBubblewrapInstaller } from './sandbox-environment';
export { findExecutable, inspectBubblewrapInstaller } from './sandbox-environment';

// Only select an installed package manager. Never prompt for a password or
// change kernel policy; the Bridge still proves that isolation actually works.
export const installBubblewrap = async (timeout: number, signal?: AbortSignal, runner = runQuiet, inspect = inspectBubblewrapInstaller): Promise<void> => {
  const deadline = Date.now() + timeout;

  signal?.throwIfAborted();
  const plan = await inspect();

  if (!plan) {
    throw new Error('Bubblewrap setup: 未找到受支持的 apt-get 或 dnf，请由管理员安装 bubblewrap。');
  }
  if (!plan.root && !plan.sudo) {
    throw new Error(`Bubblewrap setup: 当前账号没有 root 权限且未安装 sudo，请联系管理员执行：${plan.manual}。`);
  }
  const run = async (args: string[]) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw new Error('Bubblewrap setup: 安装超时，请检查软件源和网络后重试。');
    }
    await runner(plan.root ? plan.executable : plan.sudo, plan.root ? args : ['-n', plan.executable, ...args], remaining, signal, undefined, {
      DEBIAN_FRONTEND: 'noninteractive'
    });
  };

  try {
    await run(['install', '-y', 'bubblewrap']);
  } catch {
    signal?.throwIfAborted();
    // Fresh Debian/Ubuntu images may not have any package indexes yet.
    if (plan.name === 'apt-get') {
      try {
        await run(['update']);
        await run(['install', '-y', 'bubblewrap']);

        return;
      } catch {
        signal?.throwIfAborted();
      }
    }
    throw new Error(`Bubblewrap setup: 自动安装失败，请检查网络和软件源；无免密 sudo 权限时由管理员执行：${plan.manual}。`);
  }
};
