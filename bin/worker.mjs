import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { start, getModuleAdapterState, getPlatformAdapterState } from 'alemonjs';

let closing = false;
process.once('disconnect', () => {
  if (!closing) {
    closing = true;
    process.kill(process.pid, 'SIGTERM');
  }
});
start({
  input: relative(process.cwd(), fileURLToPath(new URL('../lib/index.js', import.meta.url))),
  platform: fileURLToPath(import.meta.resolve('@alemonjs/qq-bot')),
  autoPort: true
});
let previous = '';
const timer = setInterval(async () => {
  try {
    let engine = {};
    try {
      engine = JSON.parse(await readFile(process.env.AGENT_LINK_STATUS_PATH, 'utf8'));
    } catch {
      /* Module still booting. */
    }
    const state = {
      type: 'agent-link.state',
      module: getModuleAdapterState().phase,
      platform: getPlatformAdapterState().phase,
      phase: engine.phase,
      chatReady: engine.chatReady === true
    };
    const serialized = JSON.stringify(state);
    if (serialized !== previous && process.connected) {
      previous = serialized;
      process.send(state);
    }
  } catch {
    /* Parent may be shutting down. */
  }
}, 250);
timer.unref();
