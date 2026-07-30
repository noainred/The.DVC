/**
 * Resolve the bytes of the upgrade bundle the central portal should push to its
 * collector agents. Tries, in order: a bundle in the watch folder, then the
 * configured remote source (versions.json). Returns { bytes, version, source }
 * or null. Kept free of any manager import to avoid cycles.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { findNewerArchive, checkRemote, vstr } from './upgrade.js';
import { currentVersion } from '../config.js';
import { upgradeAgent } from './upgradeAgent.js';
import { resilientFetch } from '../util/resilientFetch.js';

const cmp3 = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };

/**
 * 원격 번들 바이트의 sha256 대조 — upgrade.js downloadArchive와 동일 정책.
 * 여기서 받은 바이트는 수집 에이전트로 그대로 푸시돼 원격에서 코드로 실행되므로(=RCE 경로),
 * 검증 없이 통과시키면 변조 미러 하나로 전 사이트가 감염된다. sha256 부재도 '검증 불가'로
 * 거부하고, 서명 없는 사내 미러만 UPGRADE_ALLOW_UNVERIFIED=true 로 우회한다(downloadArchive와
 * 같은 env·같은 의미 — 운영자가 익힌 예외 스위치를 하나로 유지).
 *
 * throw 대신 false 반환: 호출부(express 4 async 라우터 /api/admin/collectors/upgrade,
 * manager 폴러)가 rejection을 잡지 않아 throw 하면 unhandledRejection으로 프로세스가 죽는다.
 * 거부는 반환값(=번들 없음)으로, 사유는 로그로 남긴다.
 */
// 마지막 거부 사유 — resolveBundleBytes가 null을 반환하면 호출부(관리 API)는 '번들 없음'과
// '무결성 검증 실패'를 구분할 수 없다. 운영자가 원인을 즉시 알 수 있게 사유를 남긴다.
let lastReject = null;
export function lastBundleReject() { return lastReject; }

export function verifyBundleSha(bytes, sha256) {
  if (!sha256) {
    if (process.env.UPGRADE_ALLOW_UNVERIFIED === 'true') {
      console.warn('[upgrade] ⚠ sha256 없이 번들 푸시(UPGRADE_ALLOW_UNVERIFIED=true) — 무결성 미검증. 신뢰 미러에서만 사용하세요.');
      return true;
    }
    lastReject = '원격 번들에 sha256이 없어 무결성을 검증할 수 없습니다 — 푸시를 거부했습니다(신뢰 미러라면 UPGRADE_ALLOW_UNVERIFIED=true).';
    console.error(`[upgrade] ${lastReject}`);
    return false;
  }
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got.toLowerCase() !== String(sha256).toLowerCase()) {
    lastReject = `원격 번들 sha256 불일치 — 손상/변조 가능(기대 ${String(sha256).slice(0, 12)}…, 실제 ${got.slice(0, 12)}…). 푸시를 거부했습니다.`;
    console.error(`[upgrade] ${lastReject}`);
    return false;
  }
  return true;
}

export async function resolveBundleBytes(settings) {
  lastReject = null; // 새 시도 — 이전 사유는 버린다
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
      const res = await resilientFetch(info.downloadUrl, {
        dispatcher: upgradeAgent,
        headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
        timeoutMs: 180_000, retries: 2, retryBackoffMs: 2000,
      });
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        // 무결성 검증(checkRemote가 versions.json에서 읽어온 sha256과 대조). 실패면 번들 없음으로 취급.
        if (!verifyBundleSha(bytes, info.sha256)) return null;
        return { bytes, version: info.latest, source: 'remote' };
      }
    }
  }

  return null;
}
