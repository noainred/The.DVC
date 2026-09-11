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
import crypto from 'node:crypto';
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
// v2.478(감사 S17): sha256 이 없으면 엣지 업그레이드가 항상 fail-closed 라 현장이 UPGRADE_ALLOW_UNVERIFIED 로
// 우회하게 되고, 그 env 는 전역이라 GitHub 공식 경로의 검증까지 함께 꺼진다. 번들마다 sha256 을 실어
// 검증이 통과하게 한다. 해시는 스트리밍(이벤트 루프 비블로킹)이며 path+size+mtime 키로 캐시, 동시 요청은 1회만.
const shaCache = new Map(); // path -> { size, mtimeMs, sha256 }
const shaInflight = new Map(); // path -> Promise<string>
async function sha256Of(p) {
  const st = fs.statSync(p);
  const c = shaCache.get(p);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha256;
  if (shaInflight.has(p)) return shaInflight.get(p);
  const job = new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  }).then((sha) => { shaCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, sha256: sha }); return sha; })
    .finally(() => shaInflight.delete(p));
  shaInflight.set(p, job);
  return job;
}

async function buildVersions() {
  const byVer = new Map(); // ver -> { version, tar_gz, size_bytes, sha256 }
  for (const d of sourceDirs()) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) {
      const m = BUNDLE_RE.exec(f);
      if (!m) continue;
      if (byVer.has(m[1])) continue;
      try { byVer.set(m[1], { version: m[1], tar_gz: f, size_bytes: fs.statSync(path.join(d, f)).size, _path: path.join(d, f) }); } catch { /* */ }
    }
  }
  const versions = [...byVer.values()].sort((a, b) => cmp(b.version, a.version));
  await Promise.all(versions.map(async (v) => { try { v.sha256 = await sha256Of(v._path); } catch { /* 해시 실패 시 sha256 없이(엣지는 fail-closed) */ } delete v._path; }));
  return { latest: versions[0]?.version || '', versions };
}

dlSourceRouter.get('/versions.json', async (_req, res) => {
  try { res.json(await buildVersions()); } catch (e) { res.status(500).json({ error: e.message }); }
});

dlSourceRouter.get('/:file', (req, res) => {
  const p = findFile(req.params.file);
  if (!p) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.download(p, path.basename(p));
});
