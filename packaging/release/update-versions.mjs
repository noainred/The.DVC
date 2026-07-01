/**
 * versions.json 갱신기 — CI(GitHub Actions)에서 빌드된 산출물의 크기·SHA256을 계산해
 * versions.json에 새 버전 항목을 prepend하고 latest를 갱신한다.
 *
 *   node packaging/release/update-versions.mjs <version> <distDir> <existingPath|-> <outPath>
 *
 * 기대 파일명(<version> 치환):
 *   vmware-portal-<v>.tar.gz                       (업그레이드 번들)
 *   vmware-portal-offline-<v>-el9-x64.tar.gz       (el9 설치 패키지)
 *   vmware-portal-offline-<v>-cent9-x64.tar.gz     (cent9 설치 패키지)
 *   vmware-portal-win-<v>-x64.zip                  (Windows 수집기)
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const [, , version, distDir, existingPath, outPath] = process.argv;
if (!version || !distDir || !outPath) {
  console.error('사용법: node update-versions.mjs <version> <distDir> <existingPath|-> <outPath>');
  process.exit(1);
}

const names = {
  tar_gz: `vmware-portal-${version}.tar.gz`,
  installer: `vmware-portal-offline-${version}-el9-x64.tar.gz`,
  installer_cent9: `vmware-portal-offline-${version}-cent9-x64.tar.gz`,
  windows: `vmware-portal-win-${version}-x64.zip`,
};

function stat(name) {
  const p = path.join(distDir, name);
  const buf = fs.readFileSync(p);
  return { size: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') };
}

const tg = stat(names.tar_gz);
const el9 = stat(names.installer);
const c9 = stat(names.installer_cent9);
const win = stat(names.windows);

const entry = {
  version,
  tar_gz: names.tar_gz, size_bytes: tg.size, sha256: tg.sha,
  installer: names.installer, installer_size_bytes: el9.size, installer_sha256: el9.sha,
  installer_cent9: names.installer_cent9, installer_cent9_size_bytes: c9.size, installer_cent9_sha256: c9.sha,
  windows: names.windows, windows_size_bytes: win.size, windows_sha256: win.sha,
};

let doc = { latest: version, versions: [] };
if (existingPath && existingPath !== '-' && fs.existsSync(existingPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    if (parsed && Array.isArray(parsed.versions)) doc = parsed;
  } catch { /* 손상 시 새로 시작 */ }
}
doc.versions = (doc.versions || []).filter((v) => v && v.version !== version);
doc.versions.unshift(entry);
doc.latest = version;

// 롤링 릴리스는 자산 1000개 상한이 있으므로 최근 N개 버전만 유지(그 이상은 자산도 prune됨).
// 자동 업그레이드는 latest만 있으면 되므로 오래된 항목은 안전하게 정리한다.
const KEEP = Math.max(1, Number(process.env.VERSIONS_KEEP) || 15);
if (doc.versions.length > KEEP) doc.versions = doc.versions.slice(0, KEEP);

fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`versions.json 갱신: latest=${version}, 항목 ${doc.versions.length}개(최대 ${KEEP}) → ${outPath}`);
