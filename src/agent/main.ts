import { RealRunner } from '../engine/runner.js';
import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 8787);
const { app } = buildServer({ runner: new RealRunner() });

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => console.log(`sds-agent listening on http://127.0.0.1:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
