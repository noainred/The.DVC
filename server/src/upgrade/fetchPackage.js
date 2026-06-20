/**
 * Download upgrade/install packages from a remote (GitHub raw by default, or a
 * LAN mirror for air-gapped sites) into config.packages.dir, with SHA-256
 * verification from the remote versions.json. The agent-deploy installer
 * resolver also searches this directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const trim = (u) => String(u || '').replace(/\/+$/, '');

export async function fetchRemoteVersions(baseUrl = config.packages.baseUrl) {
  const res = await fetch(`${trim(baseUrl)}/versions.json`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`versions.json HTTP ${res.status}`);
  return res.json();
}

export function listLocalPackages(dir = config.packages.dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(tar\.gz|zip)$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, sizeBytes: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

const KIND = {
  installer: { file: 'installer', sha: 'installer_sha256' }, // Rocky9 offline installer
  bundle: { file: 'tar_gz', sha: 'sha256' },                 // app upgrade bundle
  windows: { file: 'windows', sha: 'windows_sha256' },       // Windows zip
};

/** Download one package kind (default: latest installer). Verifies SHA-256. */
export async function downloadPackage({ kind = 'installer', version, baseUrl = config.packages.baseUrl, dir = config.packages.dir } = {}) {
  const k = KIND[kind];
  if (!k) return { ok: false, reason: `알 수 없는 종류: ${kind}` };
  const versions = await fetchRemoteVersions(baseUrl);
  const v = version ? (versions.versions || []).find((x) => x.version === version)
    : (versions.versions || []).find((x) => x.version === versions.latest) || (versions.versions || [])[0];
  if (!v) return { ok: false, reason: '원격 버전 정보를 찾을 수 없습니다.' };
  const fname = v[k.file];
  const sha = v[k.sha];
  if (!fname) return { ok: false, reason: `버전 ${v.version}에 ${kind} 파일이 없습니다.` };

  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(`${trim(baseUrl)}/${fname}`, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) return { ok: false, reason: `다운로드 실패 HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha && got !== sha) return { ok: false, reason: '체크섬 불일치 — 파일 손상/변조 가능' };

  const dest = path.join(dir, fname);
  fs.writeFileSync(dest, buf);
  return { ok: true, kind, version: v.version, file: fname, path: dest, sizeBytes: buf.length, sha256: got, verified: Boolean(sha) };
}
