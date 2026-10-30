import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Local process check only: never receives a URL, cookie, or model credential. */
export const checkFfmpeg = async (run = execute): Promise<boolean> => {
  try {
    const result = await run('ffmpeg', ['-version'], { timeout: 3000, maxBuffer: 16 * 1024, killSignal: 'SIGKILL' });

    return /^ffmpeg version\s/imu.test(String(result.stdout));
  } catch {
    return false;
  }
};

/** Share concurrent checks, cache for a minute, and allow diagnostics to refresh. */
export const createFfmpegAvailability = (check = checkFfmpeg, now = Date.now) => {
  let cached: { at: number; available: boolean } | undefined;
  let pending: Promise<boolean> | undefined;

  return (fresh = false): Promise<boolean> => {
    const time = now();

    if (pending !== undefined) return pending;
    if (!fresh && cached && time >= cached.at && time - cached.at < 60000) return Promise.resolve(cached.available);
    pending = Promise.resolve()
      .then(() => check())
      .catch(() => false)
      .then(available => {
        cached = { at: now(), available };

        return available;
      })
      .finally(() => {
        pending = undefined;
      });

    return pending;
  };
};

export const ffmpegAvailable = createFfmpegAvailability();
