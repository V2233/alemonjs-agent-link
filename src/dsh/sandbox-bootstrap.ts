import { runQuiet } from './python-bootstrap';

// Never prompt for a password or change kernel policy. Package installation is
// best effort; the Bridge still performs the authoritative isolation probe.
export const installBubblewrap = async (timeout: number, signal?: AbortSignal, runner = runQuiet): Promise<void> => {
  const deadline = Date.now() + timeout;

  for (const [command, args] of [
    ['apt-get', ['install', '-y', 'bubblewrap']],
    ['dnf', ['install', '-y', 'bubblewrap']],
    ['apk', ['add', '--no-interactive', 'bubblewrap']]
  ] as [string, string[]][]) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      break;
    }
    try {
      const root = process.getuid?.() === 0;

      await runner(root ? command : 'sudo', root ? args : ['-n', command, ...args], remaining, signal, undefined, { DEBIAN_FRONTEND: 'noninteractive' });

      return;
    } catch {
      signal?.throwIfAborted();
    }
  }
  throw new Error('bubblewrap automatic installation unavailable; install bubblewrap with administrator privileges');
};
