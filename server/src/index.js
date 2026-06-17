import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import { config } from './config.js';
import { store } from './store.js';
import { api } from './routes/api.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', api);

// Serve the built web client when it exists (production single-port mode).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(`${config.webDist}/index.html`);
  });
}

store.start();

app.listen(config.port, () => {
  console.log(`\n  VMware Global Monitoring Portal — API`);
  console.log(`  ▸ listening on http://localhost:${config.port}`);
  console.log(`  ▸ data source: ${config.dataSource}`);
  console.log(`  ▸ poll interval: ${config.pollIntervalMs / 1000}s\n`);
});
