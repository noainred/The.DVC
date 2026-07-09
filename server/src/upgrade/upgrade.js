/**
 * Auto-upgrade — apply a newer release bundle from a watched folder, a pushed
 * bundle, or a remote source, then re-exec the process to load the new code.
 *
 * Faithful Node port of the reference design. Shared by portal & edge agents.
 * Safety: opt-in, archive validation (package + version), newer-only,
 * path-traversal prevention, backup of existing code (rollback), built-ins only.
 *
 * Bundle layout: an archive named  vmware-portal-<X.Y.Z>.tar.gz|.tgz|.zip
 * whose members live under a top-level "<packageName>/" directory (default
 * "vmware-portal"). The release version is read from the package's package.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseTarGz, parseZip, MAX_BUNDLE_BYTES, MAX_MEMBERS } from './archive.js';
import { upgradeAgent } from './upgradeAgent.js';
import { resilientFetch } from '../util/resilientFetch.js';

const ARCHIVE_RE = /vmware-portal-(\d+)\.(\d+)\.(\d+)\.(?:tar\.gz|tgz|zip)$/;

/* -------------------------------- versions -------------------------------- */

/** '1.2.3' or 'v1.2.3' -> [1,2,3]; null on failure. */
export function parseVersion(s) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export const vstr = (t) => (Array.isArray(t) ? t.join('.') : String(t));

/** Lexicographic compare of [maj,min,patch] tuples. */
export function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  }
  return 0;
}

function archiveVersion(filename) {
  const m = ARCHIVE_RE.exec(path.basename(filename));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Newest matching archive in watchDir strictly newer than currentVersion, or null. */
export function findNewerArchive(watchDir, currentVersion) {
  const cur = parseVersion(currentVersion) || [0, 0, 0];
  let best = null;
  let names;
  try {
    names = fs.readdirSync(watchDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const v = archiveVersion(name);
    if (v && cmpVersion(v, cur) > 0 && (best === null || cmpVersion(v, best.version) > 0)) {
      best = { path: path.join(watchDir, name), version: v };
    }
  }
  return best;
}

/* ----------------------------- member handling ---------------------------- */

/** Safely map an archive member name to a path relative to "<pkg>/" (or null). */
export function acceptMember(name, pkgName) {
  const parts = name.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  const idx = parts.indexOf(pkgName);
  if (idx === -1) return null;
  const rel = parts.slice(idx + 1);
  if (rel.length === 0 || rel.some((p) => p === '..')) return null; // traversal guard
  return rel.join('/');
}

function collectMembers(entries, pkgName) {
  const out = new Map();
  let total = 0;
  for (const e of entries) {
    const rel = acceptMember(e.name, pkgName);
    if (!rel) continue;
    if (out.size >= MAX_MEMBERS || total + e.data.length > MAX_BUNDLE_BYTES) {
      throw new Error('archive too large (or too many members)');
    }
    out.set(rel, e.data);
    total += e.data.length;
  }
  return out;
}

/** Read "<pkg>/<...>" files from an archive file into Map<relPath, Buffer>. */
export function readPackageMembers(archivePath, pkgName) {
  const buf = fs.readFileSync(archivePath);
  const entries = archivePath.endsWith('.zip') ? parseZip(buf) : parseTarGz(buf);
  return collectMembers(entries, pkgName);
}

/** Read a pushed tar.gz bundle (bytes) into members (edge side). */
export function readBundleBytes(data, pkgName) {
  return collectMembers(parseTarGz(Buffer.isBuffer(data) ? data : Buffer.from(data)), pkgName);
}

/** Determine the bundle's version from its package.json (validation). */
export function membersVersion(members) {
  const pkg = members.get('package.json');
  if (pkg) {
    try {
      const v = parseVersion(JSON.parse(pkg.toString('utf8')).version);
      if (v) return v;
    } catch { /* fall through */ }
  }
  const vf = members.get('VERSION');
  return vf ? parseVersion(vf.toString('utf8')) : null;
}

/* ------------------------------- apply / swap ----------------------------- */

/**
 * Replace installDir with the bundle members atomically: stage to a temp dir,
 * move the current install aside as a backup, then swap in the new one.
 * Returns the backup path ("" if there was nothing to back up). Rolls back on
 * failure where possible.
 */
export function applyPackage(members, installDir) {
  const target = path.resolve(installDir);
  const ts = Date.now();
  const staging = `${target}.new.${ts}`;
  const backup = `${target}.bak.${ts}`;

  fs.rmSync(staging, { recursive: true, force: true });
  for (const [rel, data] of members) {
    const dst = path.join(staging, rel);
    if (!path.resolve(dst).startsWith(path.resolve(staging) + path.sep)) {
      throw new Error(`unsafe member path: ${rel}`); // defense in depth
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
  }

  const hadOld = fs.existsSync(target);
  if (hadOld) fs.renameSync(target, backup);     // current -> backup (same fs, atomic)
  // Carry user data/config over so an upgrade never wipes registered vCenters,
  // users, or saved upgrade settings (these live inside the app dir).
  if (hadOld) preserveUserConfig(backup, staging);
  try {
    fs.renameSync(staging, target);              // new -> place
  } catch (err) {
    if (hadOld) fs.renameSync(backup, target);   // rollback
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  pruneOldBackups(target);
  return hadOld ? backup : '';
}

/**
 * 오래된 업그레이드 부산물 정리 — 백업(<install>.bak.<ts>)은 최근 2개만 남기고, 실패로 남은
 * 스테이징(<install>.new.<ts>)은 모두 지운다. 백업 하나가 node_modules 포함 앱 전체 사본이라
 * 릴리스마다 수백 MB씩 쌓여 방치 시 디스크 고갈로 다음 업그레이드/DB 쓰기까지 실패한다.
 */
function pruneOldBackups(target, keep = 2) {
  try {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const bakPrefix = `${base}.bak.`;
    const newPrefix = `${base}.new.`;
    const baks = fs.readdirSync(dir)
      .filter((n) => n.startsWith(bakPrefix) && /^\d+$/.test(n.slice(bakPrefix.length)))
      .sort((a, b) => Number(b.slice(bakPrefix.length)) - Number(a.slice(bakPrefix.length)));
    for (const n of baks.slice(keep)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    // 이 함수는 스왑 성공 직후(동기) 호출되므로 남아있는 .new.*는 전부 과거 실패의 잔재다.
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith(newPrefix) && /^\d+$/.test(n.slice(newPrefix.length))) {
        fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      }
    }
  } catch { /* best effort — 정리 실패가 업그레이드를 막으면 안 됨 */ }
}

// 업그레이드에서 반드시 보존해야 하는 사용자 데이터가 들어있는 디렉터리(번들에 포함되지 않음).
// 기본 CONFIG_DIR = <app>/server/config 이 installDir 내부라, 앱 루트를 통째로 스왑하면 이 안의
// 파일이 전부 새 번들(빈 상태)로 대체된다. 개별 파일 나열은 auth.json/backup.json/packages.json/
// 캡처·보안 설정과 시계열 SQLite(idrac-power/host-temp/ipam.db)를 누락시키므로 '디렉터리 통째' 이관.
const PRESERVE_DIRS = ['server/config'];
// (하위호환) 디렉터리 밖에 있을 수 있는 개별 파일도 추가 보존.
const PRESERVE_PATHS = [
  'server/config/vcenters.json',
  'server/config/users.json',
  'server/config/upgrade.json',
];

/** Copy preserved config from the old install (backup) into the new one (staging). */
function preserveUserConfig(fromDir, toDir) {
  // 1) config 디렉터리 전체 이관(재귀). 새 번들이 시드한 기본 파일은 old에 없으면 그대로 유지된다.
  for (const rel of PRESERVE_DIRS) {
    try {
      const src = path.join(fromDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(toDir, rel);
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(src, dst, { recursive: true, force: true });
    } catch { /* best effort — never block the upgrade on this */ }
  }
  // 2) 명시 경로 개별 보존(중복이어도 안전 — 위 디렉터리 밖 배치 대비).
  for (const rel of PRESERVE_PATHS) {
    try {
      const src = path.join(fromDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(toDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch { /* best effort — never block the upgrade on this */ }
  }
}

/* ----------------------------- high-level apply --------------------------- */

/** Apply an archive file if it is newer than currentVersion. */
export function upgradeFromArchive(archivePath, installDir, currentVersion, pkgName) {
  let members;
  try {
    members = readPackageMembers(archivePath, pkgName);
  } catch (err) {
    return { ok: false, reason: `failed to read archive: ${err.message}` };
  }
  const res = applyIfNewer(members, installDir, currentVersion);
  // 적용된 아카이브 경로를 노출 — manager.pushToEdges가 이 경로로 엣지에 같은 번들을 푸시한다.
  // (이전엔 res.appliedArchive가 항상 undefined라, watchDir 없는 remoteBase-only 중앙은 엣지
  //  업그레이드 푸시가 조용히 no-op이 되어 버전이 갈라졌다.)
  if (res.ok) res.appliedArchive = archivePath;
  return res;
}

/** Apply pushed bundle bytes (edge side). allowSame re-installs an equal version. */
export function upgradeFromBundleBytes(data, installDir, currentVersion, pkgName, { allowSame = false } = {}) {
  let members;
  try {
    members = readBundleBytes(data, pkgName);
  } catch (err) {
    return { ok: false, reason: `failed to read bundle: ${err.message}` };
  }
  return applyIfNewer(members, installDir, currentVersion, { allowSame });
}

function applyIfNewer(members, installDir, currentVersion, { allowSame = false } = {}) {
  const newV = membersVersion(members);
  if (!newV) return { ok: false, reason: 'no valid vmware-portal package/version in archive' };
  const cur = parseVersion(currentVersion) || [0, 0, 0];
  const c = cmpVersion(newV, cur);
  if (c < 0 || (c === 0 && !allowSame)) {
    return { ok: false, reason: `not newer (${vstr(newV)} <= ${vstr(cur)})`, version: vstr(newV) };
  }
  try {
    const backup = applyPackage(members, installDir);
    return { ok: true, version: vstr(newV), from: vstr(cur), backup };
  } catch (err) {
    return { ok: false, reason: `swap failed: ${err.message}` };
  }
}

/* --------------------------------- restart -------------------------------- */

/**
 * Re-exec the running process so the freshly installed code is loaded.
 * Under systemd (INVOCATION_ID set) we simply exit and let the supervisor
 * restart the unit (Restart=always); otherwise we spawn a detached copy with
 * the same argv and exit (works under nohup). Does not return.
 */
export function restartProcess() {
  if (process.env.INVOCATION_ID || process.env.NOTIFY_SOCKET) {
    setTimeout(() => process.exit(0), 100); // systemd will restart the unit
    return;
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: 'inherit',
  });
  child.unref();
  setTimeout(() => process.exit(0), 100);
}

/* ----------------------------- remote source ------------------------------ */
// Check an internet/mirror/private source for newer releases via versions.json
// (produced by a make_release step). Public URLs need no token; private GitHub
// raw URLs are rewritten to the contents API and authenticated with a PAT.

const RAW_GH_RE = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/;
const WWW_GH_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(.+)$/;

/** Rewrite a public raw GitHub dir URL to the contents API (works for private). */
export function toGithubApi(base) {
  const m = RAW_GH_RE.exec(base) || WWW_GH_RE.exec(base);
  if (!m) return base;
  const [, owner, repo, rest] = m;
  const i = rest.lastIndexOf('/');
  if (i <= 0) return base;
  const ref = rest.slice(0, i);
  const dir = rest.slice(i + 1);
  if (!ref || !dir) return base;
  return `https://api.github.com/repos/${owner}/${repo}/contents/${dir}?ref=${ref}`;
}

function resolveBase(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return token ? toGithubApi(base) : base;
}

function joinUrl(base, name) {
  if (base.includes('?')) {
    const [head, query] = base.split('?');
    return `${head.replace(/\/+$/, '')}/${name}?${query}`;
  }
  return `${base.replace(/\/+$/, '')}/${name}`;
}

function authHeaders(url, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    if (url.includes('api.github.com')) headers.Accept = 'application/vnd.github.raw';
  }
  return headers;
}

/** Fetch base/versions.json -> [data, error]. */
export async function fetchRemoteVersions(base, { token, timeout = 10_000 } = {}) {
  const url = joinUrl(base, 'versions.json');
  try {
    const res = await resilientFetch(url, { dispatcher: upgradeAgent, headers: authHeaders(url, token), timeoutMs: timeout, retries: 2 });
    if (!res.ok) return [null, `versions.json HTTP ${res.status}`];
    return [await res.json(), null];
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const offline = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|UND_ERR/i
      .test(`${err?.message} ${code} ${err?.cause?.message || ''}`);
    const base = `원격 소스(versions.json) 접속 실패: ${err.message}`;
    return [null, offline
      ? `${base} — 폐쇄망(오프라인) 서버는 인터넷 업그레이드가 불가합니다. '감시 폴더'에 업그레이드 번들을 넣어 적용하세요.`
      : base];
  }
}

/** Check remote for a newer version (no download). */
export async function checkRemote(baseUrl, currentVersion, { token, timeout = 10_000 } = {}) {
  const base = resolveBase(baseUrl, token);
  const [data, err] = await fetchRemoteVersions(base, { token, timeout });
  const cur = parseVersion(currentVersion) || [0, 0, 0];
  const out = { ok: !err, current: vstr(cur), available: false, checkedAt: Date.now(), source: joinUrl(base, 'versions.json') };
  if (err) { out.error = err; return out; }

  const latest = String(data.latest || '');
  const lt = parseVersion(latest);
  out.latest = latest;
  out.available = Boolean(lt && cmpVersion(lt, cur) > 0);
  for (const v of data.versions || []) {
    if (String(v.version) === latest) {
      out.tarGz = v.tar_gz;
      out.sizeBytes = v.size_bytes;
      out.sha256 = v.sha256 || v.tar_gz_sha256 || '';
      if (v.tar_gz) out.downloadUrl = joinUrl(base, v.tar_gz);
      break;
    }
  }
  return out;
}

/** Download a remote archive into destDir (validates name, caps size, auth). */
export async function downloadArchive(url, destDir, { token, timeout = 120_000, maxBytes = MAX_BUNDLE_BYTES, sha256 } = {}) {
  const name = path.basename(String(url || '').split('?')[0]);
  if (!ARCHIVE_RE.test(name)) return { ok: false, reason: `disallowed archive name: ${name || '(none)'}` };
  try {
    const res = await resilientFetch(url, { dispatcher: upgradeAgent, headers: authHeaders(url, token), timeoutMs: timeout, retries: 2, retryBackoffMs: 2000 });
    if (!res.ok) return { ok: false, reason: `download HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, reason: `download too large (>${maxBytes} bytes)` };
    // 무결성 검증: versions.json의 sha256과 대조(TLS 미검증 미러/변조 번들 차단).
    // 보안(H2): sha256이 없으면 기본적으로 '검증 불가'로 설치를 거부한다(공식 릴리스는 항상 sha256 제공).
    // 서명 없는 사내 미러 등 부득이한 경우만 UPGRADE_ALLOW_UNVERIFIED=true로 우회(비권장).
    if (!sha256) {
      if (process.env.UPGRADE_ALLOW_UNVERIFIED === 'true') {
        console.warn('[upgrade] ⚠ sha256 없이 설치(UPGRADE_ALLOW_UNVERIFIED=true) — 무결성 미검증 번들. 신뢰 미러에서만 사용하세요.');
      } else {
        return { ok: false, reason: 'sha256이 없어 번들 무결성을 검증할 수 없습니다 — 설치를 거부합니다(신뢰 미러라면 UPGRADE_ALLOW_UNVERIFIED=true로 우회 가능).' };
      }
    } else {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got.toLowerCase() !== String(sha256).toLowerCase()) {
        return { ok: false, reason: `sha256 불일치 — 번들 무결성 검증 실패(기대 ${String(sha256).slice(0, 12)}…, 실제 ${got.slice(0, 12)}…)` };
      }
    }
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    fs.writeFileSync(dest, buf);
    return { ok: true, path: dest, size: buf.length };
  } catch (err) {
    return { ok: false, reason: `download failed: ${err.message}` };
  }
}

/** Check remote, download the newest, and install it (restart left to caller). */
export async function upgradeFromRemote(baseUrl, installDir, currentVersion, destDir, { token, timeout = 120_000, pkgName } = {}) {
  const info = await checkRemote(baseUrl, currentVersion, { token, timeout: Math.min(timeout, 15_000) });
  if (!info.ok) return { ok: false, reason: info.error || 'version check failed', check: info };
  if (!info.available) return { ok: false, reason: `already up to date (${info.latest})`, check: info, upToDate: true };
  if (!info.downloadUrl) return { ok: false, reason: 'no download URL found', check: info };

  const dl = await downloadArchive(info.downloadUrl, destDir, { token, timeout, sha256: info.sha256 });
  if (!dl.ok) return { ok: false, reason: dl.reason, check: info };

  const res = upgradeFromArchive(dl.path, installDir, currentVersion, pkgName);
  res.check = info;
  res.downloaded = dl.size;
  return res;
}

/* ------------------------------- edge push -------------------------------- */

/** Push a bundle (tar.gz bytes) to a registered edge's upgrade endpoint.
 *  대용량 번들+고RTT를 고려해 타임아웃을 넉넉히 둔다. 재시도는 적용하지 않는다(적용=재시작이라 경합 오탐 위험). */
export async function pushBundleToEdge(edge, archivePath, { timeout = Number(process.env.EDGE_PUSH_TIMEOUT_MS) || 600_000 } = {}) {
  const data = fs.readFileSync(archivePath);
  // restart=true 필수 — 없으면 엣지는 설치 디렉터리만 교체하고 구버전 프로세스가 계속 돈다.
  // (currentVersion()이 디스크의 package.json을 읽어 '새 버전'으로 보고하므로 재푸시도 거부됨.)
  const url = `${String(edge.url).replace(/\/+$/, '')}/api/upgrade/bundle?restart=true`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        ...(edge.token ? { Authorization: `Bearer ${edge.token}` } : {}),
      },
      body: data,
      // 보안(H1): 전역 미검증 TLS 디스패처(vCenter 자체서명용) 대신 검증 디스패처 사용 —
      // 엣지 토큰+번들이 미검증 TLS로 나가 MITM에 노출되던 것 차단(http 엣지엔 무영향).
      // https 자체서명 엣지면 UPGRADE_TLS_INSECURE=true로 완화(upgradeAgent가 반영).
      dispatcher: upgradeAgent,
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => ({}));
    return { edge: edge.url, ok: res.ok, status: res.status, ...body };
  } catch (err) {
    return { edge: edge.url, ok: false, reason: err.message };
  }
}
