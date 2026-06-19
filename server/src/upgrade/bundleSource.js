/**
 * Resolve the bytes of the upgrade bundle the central portal should push to its
 * collector agents. Tries, in order: a bundle in the watch folder, then the
 * configured remote source (versions.json). Returns { bytes, version, source }
 * or null. Kept free of any manager import to avoid cycles.
 */

import fs from 'node:fs';
import { findNewerArchive, checkRemote, vstr } from './upgrade.js';

export async function resolveBundleBytes(settings) {
  const s = settings || {};

  // 1) newest bundle in the watch folder
  if (s.watchDir) {
    const found = findNewerArchive(s.watchDir, '0.0.0');
    if (found?.path && fs.existsSync(found.path)) {
      return { bytes: fs.readFileSync(found.path), version: vstr(found.version), source: 'watch' };
    }
  }

  // 2) download the latest from the remote source
  if (s.remoteBase) {
    const info = await checkRemote(s.remoteBase, '0.0.0', { token: s.token, timeout: 15_000 });
    if (info.ok && info.downloadUrl) {
      const res = await fetch(info.downloadUrl, {
        headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) {
        return { bytes: Buffer.from(await res.arrayBuffer()), version: info.latest, source: 'remote' };
      }
    }
  }

  return null;
}
