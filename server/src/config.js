import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Central configuration for the portal backend.
 *
 * DATA_SOURCE controls where infrastructure data comes from:
 *   - "mock"  : always use generated demo data (default, runs anywhere)
 *   - "live"  : only query the real vCenters listed in config/vcenters.json
 *   - "auto"  : try live; for any vCenter that fails, fall back to mock
 */
export const config = {
  port: Number(process.env.PORT) || 4000,
  dataSource: (process.env.DATA_SOURCE || 'mock').toLowerCase(),
  // How often (ms) the collector refreshes the aggregated snapshot.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30_000,
  // Allow self-signed vCenter certificates (common in private DCs).
  rejectUnauthorized: process.env.VC_TLS_REJECT_UNAUTHORIZED === 'true',
  // Directory of the built web client to serve in production (optional).
  webDist: path.resolve(ROOT, '..', 'web', 'dist'),
  auth: {
    enabled: process.env.AUTH_ENABLED !== 'false',
    // Signing secret for session tokens. Set AUTH_SECRET in production so
    // tokens survive restarts; otherwise a random per-process secret is used.
    secret: process.env.AUTH_SECRET || '',
    // Token lifetime, e.g. "8h", "30m", "7d", or seconds.
    tokenTtl: process.env.AUTH_TOKEN_TTL || '8h',
    // Default seed admin password when no users.json exists (demo convenience).
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
  },
};

/**
 * Load the list of vCenters to monitor.
 * Falls back to vcenters.example.json so the portal works out of the box.
 */
export function loadVcenterConfig() {
  const candidates = [
    path.resolve(ROOT, 'config', 'vcenters.json'),
    path.resolve(ROOT, 'config', 'vcenters.example.json'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.vcenters)) {
          return { file, vcenters: parsed.vcenters };
        }
      } catch (err) {
        console.error(`[config] Failed to parse ${file}: ${err.message}`);
      }
    }
  }
  return { file: null, vcenters: [] };
}
