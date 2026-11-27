import { lstatSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { ConfigError, readConfig } from './policy/config.ts';
import { identity } from './os/process.ts';
import { ownerSocket } from './os/local.ts';
import { Store } from './db/store.ts';
import { Tasks } from './core/tasks.ts';
import { Scheduler } from './core/scheduler.ts';
import { http } from './http.ts';

try {
  const state = process.argv[2];
  const socket = ownerSocket(state);
  const stale = lstatSync(socket, { throwIfNoEntry: false });
  if (stale && !stale.isSocket()) throw new ConfigError('owner.sock is occupied by a file. Move it before starting Zgent.');
  if (stale) unlinkSync(socket);
  const config = readConfig(state);
  const owner = identity(process.pid);
  if (!owner) throw new Error('Could not record the daemon process identity.');
  const store = new Store(config, owner.birth);
  const tasks = new Tasks(store, config);
  const scheduler = new Scheduler(tasks);
  const app = http(tasks, scheduler, () => void shutdown());
  let startup: Promise<void> | undefined;
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    app.server.close();
    app.server.closeAllConnections();
    app.ownerServer.close();
    app.ownerServer.closeAllConnections();
    try {
      await scheduler.stopAll();
      await startup;
      await app.close();
      store.db.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  const listening = Promise.all([once(app.server, 'listening'), once(app.ownerServer, 'listening')]);
  app.server.listen(config.port, '127.0.0.1');
  app.ownerServer.listen(socket);
  void listening.then(() => {
    console.log('Console ' + config.origin + '/console');
    startup = scheduler.begin().catch(() => {
      scheduler.phase = 'degraded';
      console.error('Startup checks or task reconciliation failed.');
    });
  }, () => {
    console.error('Could not open owner.sock or the configured loopback port.');
    process.exitCode = 1;
    void shutdown();
  });
} catch (error) {
  const safe = error instanceof ConfigError ? error.message :
    'Unable to start zgent. Verify the private local configuration, registered Git projects and build.';
  console.error(safe);
  process.exitCode = 1;
}
