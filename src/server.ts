import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);

const app = await buildApp({ config, db });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
