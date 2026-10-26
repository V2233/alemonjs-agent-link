import { runCLI } from './bin/startup.mjs';
process.exitCode = await runCLI(process.argv.slice(2));
