#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { AppError, publicError } from './errors.js';

async function main() {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--config' || (args.length === 4 && (args[2] !== '--state-root' || !args[3]))) throw new AppError('CONFIG_REQUIRED', 'Usage: webgal-mcp --config <local configuration file> [--state-root <private state directory outside projects>]');
  const config = await loadConfig(args[1]);
  const handle = serveStdio(() => createServer(config, { stateRoot: args[3] }));
  let closed = false;
  const detachSignals = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  const shutdown = () => {
    if (closed) return;
    closed = true;
    detachSignals();
    const forceExit = setTimeout(() => process.exit(process.exitCode ?? 0), 3000);
    forceExit.unref();
    void handle.close().catch(() => {});
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', detachSignals);
  process.stdin.once('close', detachSignals);
}
main().catch(error => {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 1;
});
