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
import { readJsonCapped } from '../util/readCapped.js';
import { readBytesCapped } from '../util/readBytesCapped.js'; // v2.607 SEC2607-06: 크기 상한을 사후가 아니라 읽는 중에
import { recordOutbound } from '../util/outboundStats.js'; // v2.727(감사 D-06): 전역 fetch 경로라 직접 기록(collector/upgradePush.js 와 같은 형태)
import { reqTimeoutMs } from '../agent/envTimeout.js'; // v2.607 TIM2607-02: push 시한 정규화
import { readTextCapped } from '../util/readCapped.js';
// v2.730(검토 S-10·I-08): 배포자 서명 판정 하나(signature.js) · 메타데이터 상한·형식(versionsDoc.js)
import {
  decideSignature, signatureSummary, manifestPathForArchive, archiveVersionOf, readManifestFile, encodeManifestHeader, MANIFEST_HEADER,
} from './signature.js';
import { MANIFEST_MAX_BYTES, MANIFEST_NAME_RE, manifestNameFor } from './signatureCore.js';
import { VERSIONS_MAX_BYTES, validateVersionsDoc, deadlineSignal, scrubUrlSecrets } from './versionsDoc.js';

const ARCHIVE_RE = /vmware-portal-(\d+)\.(\d+)\.(\d+)\.(?:tar\.gz|tgz|zip)$/;

/* -------------------------------- versions -------------------------------- */

/** '1.2.3' or 'v1.2.3' -> [1,2,3]; null on failure. */
export function parseVersion(s) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export const vstr = (t) => (Array.isArray(t) ? t.join('.') : String(t));

/**
 * Lexicographic compare of [maj,min,patch] **tuples**.
 * v2.593(감사 DEPS-02): 예전 이름이 `cmpVersion` 이라 문자열을 받는 단일 소스 `util/cmpVersion.js` 와 이름이 같았다 —
 * 문자열을 넘기면 글자 단위로 비교해 '2.10.0' < '2.9.0' 이 된다. 자동 import·grep 이 엉뚱한 쪽을 집지 않게 이름을 나눴다.
 */
export function cmpVersionTuple(a, b) {
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
    if (v && cmpVersionTuple(v, cur) > 0 && (best === null || cmpVersionTuple(v, best.version) > 0)) {
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
  try {
    for (const [rel, data] of members) {
      const dst = path.join(staging, rel);
      if (!path.resolve(dst).startsWith(path.resolve(staging) + path.sep)) {
        throw new Error(`unsafe member path: ${rel}`); // defense in depth
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // v2.591 P4: 실행 비트만 옮긴다(archive.js parseTar 가 `exec` 로 싣는다). 예전엔 전부 0644 라 pyportal/run.sh 등이
      // 새 설치(cp -a)와 달리 실행 비트를 잃었다.
      fs.writeFileSync(dst, data, { mode: data?.exec ? 0o755 : 0o644 });
    }
  } catch (err) {
    // v2.591 P7(재현 — ENOSPC): 스테이징 쓰기가 실패하면 부분 `.new.<ts>` 가 남았다. 정리는 다음 **성공** 업그레이드
    // 에서만 돌아, 자동 적용이 폴링마다 재시도하면 디스크 부족이 스스로 악화됐다. 실패 즉시 지운다.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
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
    // v2.591 P8(재현): install.sh 는 초(`date +%s`), in-app 업그레이드는 ms 로 찍는다. 그대로 비교하면 초 단위
    // 값(1.79e9)이 ms(1.79e12) 옆에서 언제나 가장 작아 **가장 최근의 수동 재설치 백업이 먼저 지워졌다**.
    // 11자리 미만(= 2001-09-09 이후의 ms 가 아닌 값)은 초로 보고 ms 로 맞춘다.
    const bakMs = (n) => { const v = Number(n.slice(bakPrefix.length)); return v < 1e11 ? v * 1000 : v; };
    const baks = fs.readdirSync(dir)
      .filter((n) => n.startsWith(bakPrefix) && /^\d+$/.test(n.slice(bakPrefix.length)))
      .sort((a, b) => bakMs(b) - bakMs(a));
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

/**
 * Apply an archive file if it is newer than currentVersion.
 * v2.730(검토 S-10): 설치 **전에** 배포자 서명을 확인한다 — 번들 옆의 `vmware-portal-<버전>.manifest.json`(또는 호출자가
 * 넘긴 manifestText)을 `decideSignature` 하나로 판정하고, 통과하지 못하면 아카이브를 풀지도 않는다.
 * 감시 폴더·원격 다운로드 모두 이 함수로 끝난다. opts.trust 는 테스트·도구 주입용(HTTP 경로에서 받지 않는다).
 */
export function upgradeFromArchive(archivePath, installDir, currentVersion, pkgName, { manifestText, trust, where = 'watch' } = {}) {
  let buf;
  try {
    buf = fs.readFileSync(archivePath);
  } catch (err) {
    return { ok: false, reason: `failed to read archive: ${err.message}` };
  }
  const sig = decideSignature({
    manifestText: manifestText !== undefined ? manifestText : readManifestFile(manifestPathForArchive(archivePath)),
    bytes: buf, name: path.basename(archivePath), kind: 'bundle', expectVersion: archiveVersionOf(archivePath) || undefined, where, trust,
  });
  if (!sig.ok) return { ok: false, reason: sig.reason, signature: signatureSummary(sig) };
  let members;
  try {
    members = collectMembers(archivePath.endsWith('.zip') ? parseZip(buf) : parseTarGz(buf), pkgName);
  } catch (err) {
    return { ok: false, reason: `failed to read archive: ${err.message}`, signature: signatureSummary(sig) };
  }
  const res = applyIfNewer(members, installDir, currentVersion, { signedVersion: sig.verified ? sig.version : null });
  res.signature = signatureSummary(sig);
  // 적용된 아카이브 경로를 노출 — manager.pushToEdges가 이 경로로 엣지에 같은 번들을 푸시한다.
  // (이전엔 res.appliedArchive가 항상 undefined라, watchDir 없는 remoteBase-only 중앙은 엣지
  //  업그레이드 푸시가 조용히 no-op이 되어 버전이 갈라졌다.)
  if (res.ok) res.appliedArchive = archivePath;
  return res;
}

/**
 * Apply pushed bundle bytes (edge side). allowSame re-installs an equal version.
 * v2.730(검토 S-10): push 는 파일 이름이 없다 — manifest(헤더 `X-Bundle-Manifest`)의 bundle 항목을 sha256 으로 찾고,
 * 번들 안 package.json 버전이 서명된 버전과 같아야 한다. 같은 요청의 `X-Bundle-Sha256` 은 서명이 아니다(자기신고 해시).
 */
export function upgradeFromBundleBytes(data, installDir, currentVersion, pkgName, { allowSame = false, manifestText = null, trust, where = 'push' } = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sig = decideSignature({ manifestText, bytes, kind: 'bundle', where, trust });
  if (!sig.ok) return { ok: false, reason: sig.reason, signature: signatureSummary(sig) };
  let members;
  try {
    members = readBundleBytes(bytes, pkgName);
  } catch (err) {
    return { ok: false, reason: `failed to read bundle: ${err.message}`, signature: signatureSummary(sig) };
  }
  const res = applyIfNewer(members, installDir, currentVersion, { allowSame, signedVersion: sig.verified ? sig.version : null });
  res.signature = signatureSummary(sig);
  return res;
}

function applyIfNewer(members, installDir, currentVersion, { allowSame = false, signedVersion = null } = {}) {
  const newV = membersVersion(members);
  if (!newV) return { ok: false, reason: 'no valid vmware-portal package/version in archive' };
  // v2.730(S-10): 서명된 버전과 번들 안의 버전이 같아야 한다(서명 항목은 바이트를 묶지만, 그 바이트가 다른 버전을 담고 있으면
  //   이름표와 내용이 어긋난 릴리스다 — 설치하지 않는다).
  if (signedVersion && vstr(newV) !== signedVersion) {
    return { ok: false, code: 'content-version-mismatch', reason: `번들 안의 버전(${vstr(newV)})이 서명된 manifest 버전(${signedVersion})과 다릅니다 — 설치를 거부합니다`, version: vstr(newV) };
  }
  const cur = parseVersion(currentVersion) || [0, 0, 0];
  const c = cmpVersionTuple(newV, cur);
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
 *
 * v2.604(감사 TIM2604-01 — 재현): 예전에는 두 경로 모두 `process.exit(0)` 을 **직접** 불러 index.js 의 정상 종료
 * 경로(gracefulExit)를 건너뛰었다 — RMA 롱폴 해제·진행 중 응답 유예·CSV 결과 로그 finish 대기가 전부 빠졌다
 * (실측: 전송 중 /api/vms 응답이 있는 상태에서 재시작하면 '[shutdown]' 로그 없이 1초 안에 프로세스가 사라졌다).
 * 이제 index.js 가 등록한 종료 함수(`setShutdownHandler`)로 **SIGTERM 과 같은 경로**를 탄다. systemd 가 아니면
 * 새 프로세스는 그 종료가 포트를 닫은 **뒤**(process.exit 직전)에 띄운다 — 먼저 띄우면 옛 프로세스가 포트를 쥐고 있다.
 * 등록된 종료 함수가 없으면(테스트·단독 import) 예전 동작 그대로다.
 */
let _shutdown = null;
/** index.js 가 gracefulExit 를 넘긴다 — upgrade/ 가 index.js 를 import 하면 순환이 되므로 등록으로 받는다. */
export function setShutdownHandler(fn) { _shutdown = typeof fn === 'function' ? fn : null; }

export function restartProcess({ spawnFn = spawn, exitFn = (c) => process.exit(c) } = {}) {
  const systemd = !!(process.env.INVOCATION_ID || process.env.NOTIFY_SOCKET);
  const relaunch = () => {
    const child = spawnFn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit',
    });
    child?.unref?.();
  };
  if (_shutdown) {
    // systemd: 종료만 하면 Restart=always 가 다시 띄운다. 그 밖: 종료 직전에 새 프로세스를 띄운다.
    _shutdown('upgrade-restart', systemd ? {} : { beforeExit: relaunch });
    return;
  }
  if (systemd) {
    setTimeout(() => exitFn(0), 100); // systemd will restart the unit
    return;
  }
  relaunch();
  setTimeout(() => exitFn(0), 100);
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

/**
 * Fetch base/versions.json -> [data, error].
 * v2.730(검토 I-08): 예전에는 `res.json()` 으로 본문을 통째로 읽었다(재현: 8,388,651바이트를 그대로 받아 파싱).
 *   이제 ① fetch·본문 읽기를 **한 전체 시한**으로 묶고(시한이 지나면 본문 스트림·소켓을 끊는다) ② 바이트 상한을 **읽는
 *   중에** 걸고(Content-Length 가 없거나 거짓이어도 스트림 실측) ③ 항목 수·문자열·필드 타입을 검사해 **선언한 필드만**
 *   돌려준다(versionsDoc.js). 사유 문구에서 주소의 계정·비밀번호·쿼리·토큰을 지운다.
 */
export async function fetchRemoteVersions(base, { token, timeout = 10_000 } = {}) {
  const url = joinUrl(base, 'versions.json');
  const secrets = token ? [token] : [];
  const totalMs = Math.max(500, Math.min(120_000, Number(timeout) || 10_000));
  const dl = deadlineSignal(totalMs);
  try {
    const res = await resilientFetch(url, { dispatcher: upgradeAgent, headers: authHeaders(url, token), timeoutMs: totalMs, retries: 2, signal: dl.signal });
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } return [null, `versions.json HTTP ${res.status}`]; }
    const raw = await readJsonCapped(res, VERSIONS_MAX_BYTES, 'versions.json');
    const v = validateVersionsDoc(raw);
    if (!v.ok) return [null, v.reason];
    return [v.doc, null];
  } catch (err) {
    if (dl.aborted()) return [null, `versions.json 을 전체 시한(${Math.round(totalMs / 1000)}초) 안에 다 받지 못해 중단했습니다`];
    if (err instanceof SyntaxError) return [null, 'versions.json 형식 오류 — JSON 이 아닙니다(잘렸거나 손상됐습니다)'];
    const msg = scrubUrlSecrets(err?.message || err, secrets);
    if (/상한/.test(msg)) return [null, `versions.json 이 크기 상한을 넘어 받지 않았습니다 — ${msg}`];
    const code = err?.cause?.code || err?.code || '';
    const offline = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|UND_ERR/i
      .test(`${err?.message} ${code} ${err?.cause?.message || ''}`);
    const head = `원격 소스(versions.json) 접속 실패: ${msg}`;
    return [null, offline
      ? `${head} — 폐쇄망(오프라인) 서버는 인터넷 업그레이드가 불가합니다. '감시 폴더'에 업그레이드 번들을 넣어 적용하세요.`
      : head];
  } finally { dl.clear(); }
}

/** latest 항목의 manifest 파일 이름 — 항목에 적힌 이름이 규칙(같은 버전)에 맞으면 그것, 아니면 규칙 이름. */
function manifestNameOf(entry, latest) {
  const ver = String(latest || '').replace(/^v/, '');
  const given = typeof entry?.manifest === 'string' ? entry.manifest : '';
  const m = MANIFEST_NAME_RE.exec(path.basename(given));
  if (given && m && m[1] === ver) return given;
  return manifestNameFor(ver);
}

/** Check remote for a newer version (no download). */
export async function checkRemote(baseUrl, currentVersion, { token, timeout = 10_000 } = {}) {
  const base = resolveBase(baseUrl, token);
  const [data, err] = await fetchRemoteVersions(base, { token, timeout });
  const cur = parseVersion(currentVersion) || [0, 0, 0];
  // v2.730(I-08): 화면·상태에 싣는 주소는 계정·쿼리를 뗀 것(사내 미러 URL 에 user:pass@·?token= 이 들어갈 수 있다).
  const out = { ok: !err, current: vstr(cur), available: false, checkedAt: Date.now(), source: safeUrlText(joinUrl(base, 'versions.json')) };
  if (err) { out.error = scrubUrlSecrets(err, token ? [token] : []); return out; }

  const latest = String(data.latest || '');
  const lt = parseVersion(latest);
  out.latest = latest;
  out.available = Boolean(lt && cmpVersionTuple(lt, cur) > 0);
  for (const v of data.versions || []) {
    if (String(v.version) === latest) {
      out.tarGz = v.tar_gz;
      out.sizeBytes = v.size_bytes;
      out.sha256 = v.sha256 || v.tar_gz_sha256 || '';
      if (v.tar_gz) out.downloadUrl = joinUrl(base, v.tar_gz);
      // v2.730(S-10): 그 버전의 서명 manifest — 번들보다 먼저 받아 서명을 확인한다.
      if (lt) { out.manifestName = manifestNameOf(v, latest); out.manifestUrl = joinUrl(base, out.manifestName); }
      break;
    }
  }
  return out;
}

/**
 * 원격 manifest 를 받는다(상한 64KB · 전체 시한). 404 는 `missing`(소스에 서명이 없다), 그 밖의 실패는 `reason`
 * (받지 못했다 — '없음' 과 구분한다). 사유에 주소의 계정·쿼리를 싣지 않는다.
 */
export async function fetchManifestText(url, { token, timeout = 30_000 } = {}) {
  const totalMs = Math.max(500, Math.min(120_000, Number(timeout) || 30_000));
  const dl = deadlineSignal(totalMs);
  try {
    const res = await resilientFetch(url, { dispatcher: upgradeAgent, headers: authHeaders(url, token), timeoutMs: totalMs, retries: 2, signal: dl.signal });
    if (res.status === 404) { try { await res.body?.cancel?.(); } catch { /* */ } return { text: null, missing: true, reason: `원격 소스에 서명 manifest 가 없습니다(404 · ${safeUrlText(url)})` }; }
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } return { text: null, reason: `서명 manifest 를 받지 못했습니다(HTTP ${res.status})` }; }
    return { text: await readTextCapped(res, MANIFEST_MAX_BYTES + 1, 'manifest') };
  } catch (err) {
    if (dl.aborted()) return { text: null, reason: `서명 manifest 를 전체 시한(${Math.round(totalMs / 1000)}초) 안에 받지 못했습니다` };
    // 상한(64KB)을 넘는 manifest 는 '받지 못함' 이 아니라 **형식 오류**다(정책과 무관하게 거부).
    if (/상한/.test(String(err?.message || ''))) return { text: null, malformed: `manifest 가 상한(${MANIFEST_MAX_BYTES}바이트)보다 큽니다` };
    return { text: null, reason: `서명 manifest 를 받지 못했습니다: ${scrubUrlSecrets(err?.message || err, token ? [token] : [])}` };
  } finally { dl.clear(); }
}

/** 주소를 화면에 싣기 전에 자격증명·쿼리를 뗀다(사내 미러 URL 에 user:pass@ 나 ?token= 이 들어갈 수 있다). */
export function safeUrlText(url) {
  try { const u = new URL(String(url)); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { return String(url || '').split('?')[0].replace(/\/\/[^/@]*@/, '//'); }
}

/**
 * v2.651: 다운로드 실패 사유 — 예전에는 'download HTTP 404' 한 줄이라 **무엇이 없는지** 화면이 말하지 않았다(사용자 신고:
 * 사내 미러의 versions.json 은 새 버전을 가리키는데 패키지 파일이 아직 없어 404). 조치가 다른 상태를 나눠 말한다.
 * 앞머리 `download HTTP <코드>` 는 유지한다(기존 로그·화면이 그 접두로 찾는다).
 */
export function downloadFailReason(status, url) {
  const where = safeUrlText(url);
  if (status === 404) return `download HTTP 404 — 패키지 파일이 없습니다: ${where} · versions.json 은 이 버전을 가리키는데 파일이 없습니다(사내 미러라면 패키지 동기화가 아직 안 됐거나 빠졌습니다). 확인 주기마다 다시 시도합니다`;
  if (status === 401 || status === 403) return `download HTTP ${status} — 저장소가 다운로드를 거부했습니다: ${where} · 토큰(사설 레포)·미러 권한을 확인하세요`;
  return `download HTTP ${status} — ${where}`;
}

/**
 * Download a remote archive into destDir (validates name, caps size, auth).
 * v2.730(검토 S-10): sha256(versions.json — 같은 채널) 대조에 더해 **배포자 서명**을 확인한 뒤에만 디스크에 쓴다.
 *   manifest 는 `manifestText`(미리 받은 것) 또는 `manifestUrl` 에서 받는다. 통과하면 번들 옆에 manifest 도 저장한다
 *   (이후 엣지·수집기 push 가 같은 manifest 를 싣는다). 재현했던 '교체한 번들 + 그 번들의 새 sha' 는 이제 서명에서 걸린다.
 */
export async function downloadArchive(url, destDir, { token, timeout = 120_000, maxBytes = MAX_BUNDLE_BYTES, sha256, manifestText, manifestUrl, expectVersion, trust } = {}) {
  const name = path.basename(String(url || '').split('?')[0]);
  if (!ARCHIVE_RE.test(name)) return { ok: false, reason: `disallowed archive name: ${name || '(none)'}` };
  try {
    const res = await resilientFetch(url, { dispatcher: upgradeAgent, headers: authHeaders(url, token), timeoutMs: timeout, retries: 2, retryBackoffMs: 2000 });
    if (!res.ok) return { ok: false, reason: downloadFailReason(res.status, url), status: res.status };
    // v2.607 SEC2607-06: 예전엔 전량을 메모리에 받은 뒤 비교했다 — 상한을 넘는 순간 읽기를 멈춘다.
    const rd = await readBytesCapped(res, maxBytes);
    if (!rd.ok) return { ok: false, reason: `download too large (>${maxBytes} bytes)` };
    const buf = rd.buf;
    // 무결성 검증: versions.json의 sha256과 대조(TLS 미검증 미러/변조 번들 차단).
    // 보안(H2): sha256이 없으면 기본적으로 '검증 불가'로 설치를 거부한다(공식 릴리스는 항상 sha256 제공).
    // 서명 없는 사내 미러 등 부득이한 경우만 UPGRADE_ALLOW_UNVERIFIED=true로 우회(비권장).
    // ⚠ v2.730: 이 sha 는 versions.json 과 **같은 채널**에서 온다 — 전송 손상을 잡을 뿐 배포자를 인증하지 않는다(아래 서명이 그 역할).
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
    // v2.730(S-10): 배포자 서명 — 설치·저장 전에.
    let manText = manifestText;
    let unavailable;
    let malformed;
    if (manText === undefined && manifestUrl) {
      const m = await fetchManifestText(manifestUrl, { token, timeout: Math.min(Number(timeout) || 30_000, 30_000) });
      manText = m.text; unavailable = m.missing ? undefined : m.reason; malformed = m.malformed;
    }
    const sig = decideSignature({
      manifestText: manText ?? null, bytes: buf, name, kind: 'bundle', where: 'remote', trust,
      expectVersion: expectVersion || archiveVersionOf(name) || undefined, unavailableReason: unavailable, malformedReason: malformed,
    });
    if (!sig.ok) return { ok: false, reason: sig.reason, signature: signatureSummary(sig) };
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    fs.writeFileSync(dest, buf);
    const manPath = manifestPathForArchive(dest);
    if (manText && manPath) { try { fs.writeFileSync(manPath, String(manText)); } catch { /* push 가 manifest 를 못 싣게 될 뿐 — 수신측이 '없음' 으로 거부한다 */ } }
    return { ok: true, path: dest, size: buf.length, signature: signatureSummary(sig), manifestText: manText ?? null };
  } catch (err) {
    return { ok: false, reason: `download failed: ${scrubUrlSecrets(err.message, token ? [token] : [])}` };
  }
}

/** Check remote, download the newest, and install it (restart left to caller). */
export async function upgradeFromRemote(baseUrl, installDir, currentVersion, destDir, { token, timeout = 120_000, pkgName, trust } = {}) {
  const info = await checkRemote(baseUrl, currentVersion, { token, timeout: Math.min(timeout, 15_000) });
  if (!info.ok) return { ok: false, reason: info.error || 'version check failed', check: info };
  if (!info.available) return { ok: false, reason: `already up to date (${info.latest})`, check: info, upToDate: true };
  if (!info.downloadUrl) return { ok: false, reason: 'no download URL found', check: info };

  // v2.730(S-10): 서명 manifest 를 **번들보다 먼저** 받아 확인한다 — 서명을 확인할 수 없는 릴리스면 큰 번들을 받지 않는다
  //   (자동 적용이 확인 주기마다 수백 MB 를 받았다 버리는 일을 막는다). 받은 뒤 바이트로 한 번 더(크기·sha) 확인한다.
  const man = info.manifestUrl ? await fetchManifestText(info.manifestUrl, { token, timeout: Math.min(timeout, 30_000) }) : { text: null, missing: true };
  const pre = decideSignature({
    manifestText: man.text, name: path.basename(String(info.tarGz || '')), kind: 'bundle', expectVersion: info.latest, where: 'remote-preflight', trust,
    unavailableReason: man.missing ? undefined : man.reason, malformedReason: man.malformed,
    preflight: true, sha256: info.sha256 || undefined, size: Number.isSafeInteger(info.sizeBytes) ? info.sizeBytes : undefined,
  });
  if (!pre.ok) return { ok: false, reason: pre.reason, signature: signatureSummary(pre), check: info };

  const dl = await downloadArchive(info.downloadUrl, destDir, { token, timeout, sha256: info.sha256, manifestText: man.text, expectVersion: info.latest, trust });
  if (!dl.ok) return { ok: false, reason: dl.reason, signature: dl.signature, check: info };

  const res = upgradeFromArchive(dl.path, installDir, currentVersion, pkgName, { manifestText: dl.manifestText, trust, where: 'remote' });
  res.check = info;
  res.downloaded = dl.size;
  return res;
}

/* ------------------------------- edge push -------------------------------- */

/** Push a bundle (tar.gz bytes) to a registered edge's upgrade endpoint.
 *  대용량 번들+고RTT를 고려해 타임아웃을 넉넉히 둔다. 재시도는 적용하지 않는다(적용=재시작이라 경합 오탐 위험). */
/**
 * 수신측 번들 무결성 판정(v2.480, 3차 감사 코어2 S1 — server/CLAUDE.md "자체 업그레이드·엣지 푸시 양쪽 모두 검증" 규약).
 * 예전엔 엣지 /api/upgrade/bundle·수집기 /api/collector/upgrade 가 sha256 을 받지도 검증하지도 않았다. 헤더 부재는
 * UPGRADE_ALLOW_UNVERIFIED=true 일 때만 통과(자체 업그레이드와 같은 예외).
 * ⚠⚠ v2.591 정직 정정(감사 P6 — 재현 확인): 이 sha 는 **같은 요청이 스스로 신고한 해시**라 **전송 중 손상·잘림만** 잡는다.
 *   토큰을 가진 공격자나 http 중간자는 번들과 헤더를 함께 바꿀 수 있으므로(악성 번들의 sha 를 계산해 실으면 통과한다)
 *   **토큰 탈취·중간자 방어가 아니다.** 실제 방어는 토큰 + TLS(`upgradeAgent`·https 엣지)다 — 이 검사를 믿고 그 둘을
 *   약화하지 말 것. 원격 다운로드 경로(`verifyBundleSha`)는 sha 를 별도 TLS 채널(versions.json)에서 받으므로 건전하다.
 *   push 무결성을 실제로 보장하려면 수신측이 가진 키로 서명해야 한다(rma/signing.js HMAC 패턴) — 별건.
 * @returns {string|null} 거부 사유(null 이면 통과)
 */
export function bundleShaIssue(headerSha, bytes, { allowUnverified = String(process.env.UPGRADE_ALLOW_UNVERIFIED || '').toLowerCase() === 'true' } = {}) {
  const want = String(headerSha || '').trim().toLowerCase();
  if (!want) {
    if (allowUnverified) { console.warn('[upgrade] ⚠ X-Bundle-Sha256 없이 번들 수신(UPGRADE_ALLOW_UNVERIFIED=true) — 무결성 미검증'); return null; }
    return 'X-Bundle-Sha256 헤더가 없어 번들 무결성을 검증할 수 없습니다 — 설치를 거부합니다(중앙 v2.480+ 에서 push 하거나, 신뢰망이면 UPGRADE_ALLOW_UNVERIFIED=true).';
  }
  if (!/^[0-9a-f]{64}$/.test(want)) return 'X-Bundle-Sha256 형식이 올바르지 않습니다.';
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== want) return `sha256 불일치 — 번들 무결성 검증 실패(기대 ${want.slice(0, 12)}…, 실제 ${got.slice(0, 12)}…)`;
  return null;
}

/** 엣지 업그레이드 응답 상한 — 작은 JSON 이다(해제 후 크기). */
export const EDGE_UPGRADE_RESPONSE_MAX_BYTES = 256 * 1024;

export async function pushBundleToEdge(edge, archivePath, { timeout = process.env.EDGE_PUSH_TIMEOUT_MS, manifestText } = {}) {
  const data = fs.readFileSync(archivePath);
  const sha = crypto.createHash('sha256').update(data).digest('hex'); // v2.480: 수신측 검증용
  // v2.730(검토 S-10): 번들 옆의 서명 manifest 를 함께 보낸다 — 엣지는 자기가 가진 신뢰 공개키로 설치 전에 검증한다.
  //   manifest 가 없으면 헤더 없이 보낸다(구버전 엣지는 서명을 보지 않고, 새 엣지는 '서명 없음' 으로 거부해 사유를 돌려준다).
  const manHeader = encodeManifestHeader(manifestText !== undefined ? manifestText : readManifestFile(manifestPathForArchive(archivePath)));
  // restart=true 필수 — 없으면 엣지는 설치 디렉터리만 교체하고 구버전 프로세스가 계속 돈다.
  // (currentVersion()이 디스크의 package.json을 읽어 '새 버전'으로 보고하므로 재푸시도 거부됨.)
  const url = `${String(edge.url).replace(/\/+$/, '')}/api/upgrade/bundle?restart=true`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'X-Bundle-Sha256': sha,
        ...(manHeader ? { [MANIFEST_HEADER]: manHeader } : {}),
        ...(edge.token ? { Authorization: `Bearer ${edge.token}` } : {}),
      },
      body: data,
      // 보안(H1): 전역 미검증 TLS 디스패처(vCenter 자체서명용) 대신 검증 디스패처 사용 —
      // 엣지 토큰+번들이 미검증 TLS로 나가 MITM에 노출되던 것 차단(http 엣지엔 무영향).
      // https 자체서명 엣지면 UPGRADE_TLS_INSECURE=true로 완화(upgradeAgent가 반영).
      dispatcher: upgradeAgent,
      // v2.583(감사 확정 — upgradePush 의 형제): 리다이렉트를 따라가지 않는다(토큰·번들을 제3 출처로 다시 보내지 않게).
      redirect: 'manual',
      // v2.607 TIM2607-02: 'Number(env) || 기본' 은 3e9 를 그대로(→ 1ms abort), 음수는 AbortSignal.timeout 이 ERR_OUT_OF_RANGE 로 던졌다.
      signal: AbortSignal.timeout(reqTimeoutMs(timeout, 600_000, { max: 7_200_000 })),
    });
    // v2.605(감사 LEFT2605-04 = SEC2605-02 — 재현): 예전 { ok: res.ok, status, ...body } 는 엣지 본문이 ok·status 를 덮었다(500 + {ok:true,status:200}
    //   → 성공으로 보고). 아는 필드만 글자로 담고 판정은 상태코드가 먼저다(collector/upgradePush.js 와 같은 형태). 본문은 상한까지만 읽는다.
    let body = {};
    try { const j = await readJsonCapped(res, EDGE_UPGRADE_RESPONSE_MAX_BYTES, '엣지 업그레이드 응답'); if (j && typeof j === 'object' && !Array.isArray(j)) body = j; } catch { body = {}; }
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const ok = res.ok && body.ok !== false;
    const reason = str(body.reason, 500) || str(body.error, 500) || (ok ? '' : `HTTP ${res.status}`);
    // v2.727(감사 D-06): 성패·시각을 outboundStats 에 남긴다(토큰·본문은 싣지 않는다 — 키는 origin + 경로, 쿼리는 버린다).
    recordOutbound(url, { status: ok ? res.status : (res.status < 400 ? 500 : res.status), bytes: data.length, method: 'POST', error: ok ? '' : reason, tag: 'upgrade-edge' });
    return { edge: edge.url, ok, status: res.status, ...(reason ? { reason } : {}), ...(str(body.version, 32) ? { version: str(body.version, 32) } : {}) };
  } catch (err) {
    recordOutbound(url, { error: String(err?.message || err), method: 'POST', tag: 'upgrade-edge' }); // v2.727(D-06)
    return { edge: edge.url, ok: false, reason: err.message };
  }
}
