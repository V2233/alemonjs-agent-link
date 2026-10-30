import { appendDiagnostic } from '../../runtime/diagnostics.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DSHBridgeConfig } from './client';

export const runQuiet = (command: string, args: string[], timeout: number, signal?: AbortSignal, diagnosticPath?: string): Promise<void> =>
  new Promise((resolveRun, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' }
    });
    let errors = '';

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', data => {
      errors = errors.length + String(data).length > 8000 ? '[Python 失败信息过长，已省略]' : errors + data;
    });
    const abort = () => {
      child.kill('SIGKILL');
    };

    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      if (diagnosticPath) {
        appendDiagnostic(diagnosticPath, 'Python 准备超时。\n' + errors);
      }
    }, timeout);

    child.once('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(signal.reason);

        return;
      }
      if (timedOut) {
        reject(new Error('Python preparation timed out'));

        return;
      }
      if (code === 0) {
        resolveRun();
      } else {
        if (diagnosticPath) {
          appendDiagnostic(diagnosticPath, 'Python 准备失败。\n' + errors);
        }
        reject(new Error('Python preparation failed'));
      }
    });
  });

const probe = [
  '-c',
  'from deepseek_harness import DeepSeekHarness; from deepseek_harness_runtime import bundled_runtime_path; assert callable(getattr(DeepSeekHarness, "resume_session", None)), "DSH SDK requires native session resume support"; bundled_runtime_path()'
];

export const preparePython = async (
  config: DSHBridgeConfig,
  requirements: string,
  installing: () => void,
  runner = runQuiet,
  signal?: AbortSignal
): Promise<void> => {
  const deadline = Date.now() + (config.preparationTimeoutMs ?? 120000);
  const run = async (command: string, args: string[], timeout: number): Promise<void> => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw new Error('Python preparation timed out');
    }
    await runner(command, args, Math.min(remaining, timeout), signal, join(dirname(config.dshHomeRoot), 'startup.log'));
    signal?.throwIfAborted();
  };

  try {
    await run(config.pythonExecutable, probe, Math.min(config.startupTimeoutMs, 5000));

    return;
  } catch {
    signal?.throwIfAborted();
    /* Probe before any network work. */
  }
  const managedRoot = join(dirname(config.dshHomeRoot), 'venv');
  const managedPython = join(managedRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

  if (resolve(config.pythonExecutable) !== resolve(managedPython)) {
    throw new Error('Configured Python environment is unavailable; automatic installation only manages the plugin venv');
  }
  signal?.throwIfAborted();
  installing();
  await mkdir(dirname(managedRoot), { recursive: true });
  // No system Python installation, sudo, or shell commands. If none is usable,
  // auto mode stays usable through the Node-only chat backend.
  let created = false;

  for (const command of ['python3', 'python']) {
    try {
      await run(command, ['-m', 'venv', managedRoot], config.startupTimeoutMs);
      created = true;
      break;
    } catch {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new Error('Python preparation timed out');
      }
      /* Try the next local interpreter. */
    }
  }
  if (!created) {
    throw new Error('No usable Python with venv');
  }
  const sources = [...new Set(config.pythonPackageSources)];
  let failures: Record<string, number> = {};
  const lastSource = join(dirname(managedRoot), 'python-source.json');

  try {
    const saved = JSON.parse(await readFile(lastSource, 'utf8'));

    failures = saved.failures && typeof saved.failures === 'object' ? saved.failures : {};
    if (sources.includes(saved.source)) {
      sources.splice(sources.indexOf(saved.source), 1);
      sources.unshift(saved.source);
    }
  } catch {
    /* No successful source recorded yet. */
  }
  sources.sort((left, right) => Number(Date.now() - (failures[left] ?? 0) < 300000) - Number(Date.now() - (failures[right] ?? 0) < 300000));
  const saveSource = async (source?: string): Promise<void> => {
    const temp = `${lastSource}.${process.pid}.tmp`;

    await writeFile(temp, JSON.stringify({ source, failures: Object.fromEntries(sources.filter(url => failures[url]).map(url => [url, failures[url]])) }), {
      mode: 0o600
    });
    await rename(temp, lastSource);
  };

  for (const source of sources) {
    try {
      await run(
        config.pythonExecutable,
        [
          '-m',
          'pip',
          '--isolated',
          'install',
          '--no-input',
          '--disable-pip-version-check',
          '--only-binary=:all:',
          '--timeout',
          '10',
          '--retries',
          '1',
          '--index-url',
          source,
          '--requirement',
          requirements
        ],
        config.startupTimeoutMs
      );
      await run(config.pythonExecutable, probe, Math.min(config.startupTimeoutMs, 5000));
    } catch {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new Error('Python preparation timed out');
      }
      failures[source] = Date.now();
      await saveSource();
      continue;
    }
    Reflect.deleteProperty(failures, source);
    await saveSource(source);

    return;
  }
  throw new Error('Python package sources unavailable; retry startup when connected');
};
