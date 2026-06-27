/**
 * Resolve the bytes of the upgrade bundle the central portal should push to its
 * collector agents. Tries, in order: a bundle in the watch folder, then the
 * configured remote source (versions.json). Returns { bytes, version, source }
 * or null. Kept free of any manager import to avoid cycles.
 */

import fs from 'node:fs';
import { findNewerArchive, checkRemote, vstr } from './upgrade.js';
import { currentVersion } from '../config.js';
import { upgradeAgent } from './upgradeAgent.js';

const cmp3 = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };

export async function resolveBundleBytes(settings) {
  const s = settings || {};
  const cur = String(currentVersion()).split('.').map(Number);

  // 1) newest bundle in the watch folder — 단, '중앙 현재 버전 이상'만 사용.
  //    (오래된 잔여 번들(예: v1.1.12)을 수집서버에 푸시해 다운그레이드/거부되는 문제 방지)
  if (s.watchDir) {
    const found = findNewerArchive(s.watchDir, '0.0.0');
    if (found?.path && fs.existsSync(found.path) && cmp3(found.version, cur) >= 0) {
      return { bytes: fs.readFileSync(found.path), version: vstr(found.version), source: 'watch' };
    }
  }

  // 2) download the latest from the remote source
  if (s.remoteBase) {
    const info = await checkRemote(s.remoteBase, '0.0.0', { token: s.token, timeout: 15_000 });
    if (info.ok && info.downloadUrl) {
      const res = await fetch(info.downloadUrl, {
        dispatcher: upgradeAgent,
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
