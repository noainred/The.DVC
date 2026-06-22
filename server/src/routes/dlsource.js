/**
 * 중앙 업그레이드 소스 — 이 포탈이 곧 에이전트들의 업그레이드 원본이 된다.
 * 에이전트의 UPGRADE_REMOTE_BASE 가 이 포탈의 /dl 을 가리키면, 여기서 versions.json 과
 * 업그레이드 번들(vmware-portal-<ver>.tar.gz)을 받아 자가 업그레이드한다.
 *
 * 인증: 내부망 배포 가정 + checkRemote가 토큰을 주면 GitHub API로 URL을 바꾸므로(호환),
 * 여기서는 토큰 없이 공개 제공한다(번들은 비밀이 아님). authMiddleware 앞에 마운트.
 *
 * 소스 디렉터리: config.packages.dir(관리자 패키지 다운로드 위치) + repo download/(개발).
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageDir } from '../upgrade/packageSettings.js';

export const dlSourceRouter = Router();

const REPO_DOWNLOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'download');
const BUNDLE_RE = /^vmware-portal-(\d+\.\d+\.\d+)\.tar\.gz$/;
const SAFE_RE = /^[\w.+-]+\.(tar\.gz|zip)$/;
const cmp = (a, b) => { const A = a.split('.').map(Number); const B = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0); } return 0; };

function sourceDirs() {
  const dirs = [];
  try { const d = getPackageDir(); if (d && fs.existsSync(d)) dirs.push(d); } catch { /* */ }
  if (fs.existsSync(REPO_DOWNLOAD)) dirs.push(REPO_DOWNLOAD);
  return dirs;
}

function findFile(name) {
  if (!SAFE_RE.test(name)) return null;
  for (const d of sourceDirs()) { const p = path.join(d, name); if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; }
  return null;
}

/** 패키지 디렉터리를 스캔해 versions.json 생성(번들 기준 최신 선택). */
function buildVersions() {
  const byVer = new Map(); // ver -> { version, tar_gz, size_bytes }
  for (const d of sourceDirs()) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) {
      const m = BUNDLE_RE.exec(f);
      if (!m) continue;
      if (byVer.has(m[1])) continue;
      try { byVer.set(m[1], { version: m[1], tar_gz: f, size_bytes: fs.statSync(path.join(d, f)).size }); } catch { /* */ }
    }
  }
  const versions = [...byVer.values()].sort((a, b) => cmp(b.version, a.version));
  return { latest: versions[0]?.version || '', versions };
}

dlSourceRouter.get('/versions.json', (_req, res) => {
  res.json(buildVersions());
});

dlSourceRouter.get('/:file', (req, res) => {
  const p = findFile(req.params.file);
  if (!p) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.download(p, path.basename(p));
});
