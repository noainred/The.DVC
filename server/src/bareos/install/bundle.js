/**
 * bareos/install/bundle.js — 중앙의 Bareos 완전 설치 번들 보관소(v2.844). 폴더: <패키지 폴더>/bareos-bundle/ (CONFIG_DIR 아님 — 설정 백업에 수백 MB 를 싣지 않는다).
 *
 * 받기: <번들 주소>/bareos-bundle.json(포인터) → manifest(서명) → 내용 목록 → 본체(스트림으로 디스크에 · 해시 동시 계산) → verifyBundle 통과 시에만 자리에 놓는다.
 *   번들 주소 = env BAREOS_BUNDLE_BASE_URL, 없으면 업그레이드 패키지 주소에서 유도(…/releases/download/downloads → …/bareos-bundle · 그 밖은 <주소>/bareos-bundle).
 *   에어갭 현장: 같은 세 파일(tar.gz · .json · .manifest.json)을 이 폴더에 손으로 넣고 '다시 읽기' — 검증은 같다.
 * v2.850(사용자 요청 '번들을 받는 별도의 url 을 지정 · 서버의 특정 디렉터리에 받아두면 적용'): 받는 주소와 **서버 디렉터리**를 화면에서 정한다(bundleSource.js).
 *   서버 디렉터리는 **읽기만** 한다(복사 · 삭제하지 않음) — 같은 서명 · 해시 검증을 지난 판만 설치에 쓴다. 두 폴더(받은 번들 폴더 · 서버 디렉터리)를 함께 훑고
 *   화면을 열 때 자동으로 검증한다(같은 파일이면 기억 · 막 바뀐 파일은 복사 중일 수 있어 잠시 뒤). 심링크 · 일반 파일이 아닌 것은 쓰지 않는다.
 * 규칙: 서명·해시가 맞는 번들만 목록에 '사용 가능' 으로 나온다(맞지 않으면 사유와 함께 '사용 불가') · 받기는 동시에 하나 · 크기 상한(TAR_MAX_BYTES).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPackageBaseUrl, getPackageDir } from '../../upgrade/packageSettings.js';
import { resilientFetch } from '../../util/resilientFetch.js';
import { upgradeAgent } from '../../upgrade/upgradeAgent.js';
import { loadTrust } from '../../upgrade/signature.js';
import { getBundleSource } from './bundleSource.js';
import {
  BUNDLE_TAG, POINTER_NAME, POINTER_MAX_BYTES, CONTENTS_MAX_BYTES, MANIFEST_MAX, tarName, contentsName, manifestName, TAR_RE,
  pointerIssue, verifyBundle, cmpVersionDesc,
} from './bundleDoc.js';

export const bundleDir = () => path.join(getPackageDir(), 'bareos-bundle');

/**
 * 번들 주소와 그 출처(끝 / 없음). v2.850: 화면에서 정한 주소(ui) > env BAREOS_BUNDLE_BASE_URL(env) > 업그레이드 패키지 주소에서 유도(package).
 * @returns {{ url: string, from: 'ui'|'env'|'package'|'' }}
 */
export function bundleSourceInfo(env = process.env, pkgBase = getPackageBaseUrl(), saved = getBundleSource().baseUrl) {
  if (saved) return { url: saved, from: 'ui' };
  const own = String(env.BAREOS_BUNDLE_BASE_URL || '').trim().replace(/\/+$/, '');
  if (own) return { url: own, from: 'env' };
  const b = String(pkgBase || '').trim().replace(/\/+$/, '');
  if (!b) return { url: '', from: '' };
  return { url: /\/releases\/download\/[^/]+$/.test(b) ? b.replace(/\/releases\/download\/[^/]+$/, `/releases/download/${BUNDLE_TAG}`) : `${b}/${BUNDLE_TAG}`, from: 'package' };
}
/** 번들 주소(끝 / 없음). */
export function bundleBaseUrl(env = process.env, pkgBase = getPackageBaseUrl(), saved = getBundleSource().baseUrl) { return bundleSourceInfo(env, pkgBase, saved).url; }

/** v2.850 번들을 찾는 폴더 — 받은 번들 폴더(지우기 가능) + 화면에서 정한 서버 디렉터리(읽기만). */
export function bundleDirs(importDir = getBundleSource().importDir) {
  const own = bundleDir();
  const out = [{ dir: own, where: 'bundle' }];
  if (importDir && path.resolve(importDir) !== path.resolve(own)) out.push({ dir: importDir, where: 'import' });
  return out;
}

/** 서버 디렉터리 상태(화면 안내) — 'ok' · 'missing' · 'not-dir' · 'unreadable' · ''(정하지 않음). 이름 · 내용은 싣지 않는다. */
export function importDirState(dir = getBundleSource().importDir) {
  if (!dir) return '';
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return 'not-dir';
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return 'ok';
  } catch (e) { return e?.code === 'ENOENT' ? 'missing' : 'unreadable'; }
}

let _trust = null;
let _trustAt = 0;
function trust() { if (!_trust || Date.now() - _trustAt > 60_000) { _trust = loadTrust(); _trustAt = Date.now(); } return _trust; }
let _trustForTest = null;
export function _setTrustForTest(t) { _trustForTest = t; }
const T = () => _trustForTest || trust();

/** 파일 해시 — 스트림(수백 MB 를 동기로 읽어 이벤트 루프를 막지 않는다 — 루트 규칙 '요청 경로 동기 블로킹 금지'). */
export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(p, { highWaterMark: 1 << 20 })
      .on('data', (c) => { size += c.length; h.update(c); })
      .on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

/** 검증 결과 기억(파일 크기·수정 시각이 같으면 다시 해시하지 않는다 — 수백 MB). v2.850: 열쇠는 폴더 + 판(두 폴더에 같은 판이 있을 수 있다). */
const _verified = new Map();
const _inflight = new Map();   // 같은 파일을 두 요청이 동시에 해시하지 않게
const vkey = (dir, version) => `${path.resolve(dir)}|${version}`;
/** v2.850: 막 바뀐 본체는 복사 중일 수 있다 — 이 시간 안이면 해시하지 않고 '잠시 뒤' 로 둔다. */
export const SETTLE_MS = 15_000;
let _now = () => Date.now();
export function _setNowForTest(fn) { _now = fn || (() => Date.now()); }
/** 세 파일이 일반 파일인가(심링크 · 디렉터리 · 장치 거부 — 서버 디렉터리는 사람이 고른 곳이다). */
function plainFileIssue(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e?.code === 'ENOENT' ? 'missing' : e?.code === 'EACCES' ? 'eacces' : 'read'; }
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isFile()) return 'not-file';
  return '';
}

/** 폴더의 한 판을 검증한다(해시는 스트림 — 같은 파일이면 기억한 결과). */
/** @param {{ settle?: boolean }} [o] settle: 막 바뀐 본체는 해시하지 않는다(서버 디렉터리 — 사람이 복사 중일 수 있다 · 포탈이 받은 폴더에는 쓰지 않는다) */
export async function verifyLocal(version, dir = bundleDir(), { settle = false } = {}) {
  const tarP = path.join(dir, tarName(version));
  const conP = path.join(dir, contentsName(version));
  const manP = path.join(dir, manifestName(version));
  for (const p of [tarP, conP, manP]) {
    const why = plainFileIssue(p);
    if (why === 'missing') return { ok: false, code: 'missing', reason: p === tarP ? '본체 파일이 없습니다' : '서명 manifest 또는 내용 목록 파일이 없습니다' };
    if (why === 'eacces') return { ok: false, code: 'eacces', reason: '읽을 권한이 없습니다 — 포탈 서비스 계정이 이 파일을 읽을 수 있게 권한을 주세요' };
    if (why === 'symlink') return { ok: false, code: 'symlink', reason: '심링크는 쓰지 않습니다 — 실제 파일을 두세요' };
    if (why) return { ok: false, code: why, reason: '일반 파일이 아닙니다' };
  }
  let st;
  try { st = fs.statSync(tarP); } catch { return { ok: false, code: 'missing', reason: '본체 파일이 없습니다' }; }
  const key = `${version}:${st.size}:${st.mtimeMs}`;
  const ck = vkey(dir, version);
  const hit = _verified.get(ck);
  if (hit && hit.key === key) return hit.result;
  if (settle && _now() - st.mtimeMs < SETTLE_MS) return { ok: null, code: 'settling', reason: '파일이 막 바뀌었습니다(복사 중일 수 있음) — 잠시 뒤 다시 확인합니다' };
  if (_inflight.has(`${ck}|${key}`)) return _inflight.get(`${ck}|${key}`);
  const p = verifyFiles(version, { tarP, conP, manP, key, ck }).finally(() => _inflight.delete(`${ck}|${key}`));
  _inflight.set(`${ck}|${key}`, p);
  return p;
}
async function verifyFiles(version, { tarP, conP, manP, key, ck }) {
  let result;
  try {
    const manifestText = fs.readFileSync(manP, 'utf8');
    const contentsBuf = fs.readFileSync(conP);
    if (contentsBuf.length > CONTENTS_MAX_BYTES) throw new Error('내용 목록이 상한보다 큽니다');
    const tar = await sha256File(tarP);
    const pointer = { format: 'portal-bareos-bundle-pointer', v: 1, version, tarball: { name: tarName(version), ...tar }, contents: { name: contentsName(version), size: contentsBuf.length, sha256: crypto.createHash('sha256').update(contentsBuf).digest('hex') }, manifest: manifestName(version) };
    const v = verifyBundle({ pointer, manifestText, contentsBuf, contentsSha256: pointer.contents.sha256, tar }, T());
    result = v.ok ? { ok: true, version, sha256: tar.sha256, size: tar.size, contents: v.contents, keyId: v.keyId, tarPath: tarP } : { ok: false, code: v.code, reason: v.reason };
  } catch (e) {
    result = { ok: false, code: e?.code === 'ENOENT' ? 'missing' : e?.code === 'EACCES' ? 'eacces' : 'read', reason: e?.code === 'ENOENT' ? '서명 manifest 또는 내용 목록 파일이 없습니다' : e?.code === 'EACCES' ? '읽을 권한이 없습니다 — 포탈 서비스 계정이 이 파일을 읽을 수 있게 권한을 주세요' : `읽지 못했습니다(${e?.code || '오류'})` };
  }
  _verified.set(ck, { key, result });
  return result;
}

/** 폴더의 번들 목록(새 판 먼저). verify=false 면 기억한 결과만(없으면 '확인 전'). */
export async function listBundles({ verify = false, dir = bundleDir(), settle = false } = {}) {
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const versions = names.map((n) => TAR_RE.exec(n)?.[1]).filter(Boolean).sort(cmpVersionDesc).slice(0, 10);
  const out = [];
  for (const v of versions) {
    const r = verify ? await verifyLocal(v, dir, { settle }) : (_verified.get(vkey(dir, v))?.result || null);
    let size = null; try { size = fs.statSync(path.join(dir, tarName(v))).size; } catch { /* */ }
    out.push(r ? { version: v, size, ok: r.ok, reason: r.ok ? '' : r.reason, contents: r.ok ? r.contents : null, sha256: r.ok ? r.sha256 : null }
      : { version: v, size, ok: null, reason: '확인 전', contents: null, sha256: null });
  }
  return out;
}

/**
 * v2.850 두 폴더(받은 번들 폴더 · 서버 디렉터리)의 번들 — 행마다 where('bundle' · 'import'). 새 판 먼저 · 같은 판은 받은 폴더 먼저.
 * verify=true 여도 같은 파일은 기억한 결과(해시는 새 · 바뀐 파일만).
 */
export async function listAllBundles({ verify = false, dirs = bundleDirs() } = {}) {
  const out = [];
  for (const d of dirs) for (const b of await listBundles({ verify, dir: d.dir, settle: d.where === 'import' })) out.push({ ...b, where: d.where });
  return out.sort((a, b) => cmpVersionDesc(a.version, b.version) || (a.where === 'bundle' ? -1 : 1)).slice(0, 20);
}

/**
 * 설치에 쓸 번들(검증된 것 중 가장 새 판 · 또는 지정 판). dir 을 주면 그 폴더만(시험 · 예전 호출) · 안 주면 두 폴더(v2.850).
 */
export async function pickBundle(version = '', dir = null) {
  const dirs = dir ? [{ dir, where: 'bundle' }] : bundleDirs();
  const all = [];
  for (const d of dirs) for (const b of await listBundles({ verify: true, dir: d.dir, settle: d.where === 'import' })) if (b.ok) all.push({ ...b, dir: d.dir, where: d.where });
  all.sort((a, b) => cmpVersionDesc(a.version, b.version));
  const b = version ? all.find((x) => x.version === version) : all[0];
  if (!b) return null;
  const r = await verifyLocal(b.version, b.dir, { settle: b.where === 'import' });
  return r.ok ? r : null;
}

export function deleteBundle(version, dir = bundleDir()) {
  if (!TAR_RE.test(tarName(version))) return false;
  let any = false;
  for (const n of [tarName(version), contentsName(version), manifestName(version)]) {
    try { fs.unlinkSync(path.join(dir, n)); any = true; } catch { /* 없음 */ }
  }
  _verified.delete(vkey(dir, version));   // 서버 디렉터리(사람의 파일)는 지우지 않는다 — 부르는 쪽은 받은 번들 폴더만 넘긴다
  return any;
}

/* ───────── 받기(동시에 하나) ───────── */

let _fetch = null;   // { startedAt, version, sent, total, phase, error?, doneAt? }
let _fetchImpl = null;
/** 시험 주입 — (url, opts) → Response 모양. */
export function _setFetchForTest(fn) { _fetchImpl = fn; }
const doFetch = (url, opts) => (_fetchImpl ? _fetchImpl(url, opts) : resilientFetch(url, { dispatcher: upgradeAgent, ...opts }));

export function bundleFetchStatus() { return _fetch ? { ..._fetch } : null; }

async function readSmall(res, max) {
  const chunks = []; let n = 0;
  for await (const c of res.body) { n += c.length; if (n > max) throw Object.assign(new Error(`응답이 상한(${max}바이트)보다 큽니다`), { code: 'too-big' }); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}

/**
 * 최신 번들을 받는다. 이미 같은 판이 검증돼 있으면 받지 않는다.
 * @returns {Promise<{ ok, version?, reason?, already? }>}
 */
export async function fetchLatestBundle({ baseUrl = bundleBaseUrl(), dir = bundleDir() } = {}) {
  if (_fetch && !_fetch.doneAt) return { ok: false, busy: true, reason: '번들을 받는 중입니다 — 끝난 뒤 다시 보세요.' };
  if (!baseUrl) return { ok: false, reason: '번들 주소가 없습니다(업그레이드 패키지 주소 또는 BAREOS_BUNDLE_BASE_URL).' };
  _fetch = { startedAt: Date.now(), version: '', sent: 0, total: null, phase: 'pointer' };
  const st = _fetch;
  const fin = (r) => { st.doneAt = Date.now(); st.phase = r.ok ? 'done' : 'failed'; if (!r.ok) st.error = r.reason; return r; };
  let part = '';
  try {
    const pr = await doFetch(`${baseUrl}/${POINTER_NAME}`, { timeoutMs: 30_000, retries: 2 });
    if (!pr.ok) return fin({ ok: false, reason: `번들 포인터를 받지 못했습니다(HTTP ${pr.status}) — 번들이 아직 게시되지 않았거나 주소가 다릅니다.` });
    let pointer;
    try { pointer = JSON.parse((await readSmall(pr, POINTER_MAX_BYTES)).toString('utf8')); } catch (e) { return fin({ ok: false, reason: `번들 포인터를 읽지 못했습니다(${e.code || 'JSON 아님'}).` }); }
    const pi = pointerIssue(pointer);
    if (pi) return fin({ ok: false, reason: `번들 포인터 형식 오류 — ${pi}` });
    const v = pointer.version;
    st.version = v; st.total = pointer.tarball.size;
    const have = await verifyLocal(v, dir);
    if (have.ok && have.sha256 === pointer.tarball.sha256) return fin({ ok: true, version: v, already: true });
    // v2.850: 서버 디렉터리에 같은 판이 이미 검증돼 있으면 받지 않는다(수백 MB 를 두 번 두지 않게)
    for (const d of bundleDirs()) {
      if (d.dir === dir) continue;
      const other = await verifyLocal(v, d.dir);
      if (other.ok && other.sha256 === pointer.tarball.sha256) return fin({ ok: true, version: v, already: true, where: d.where });
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    st.phase = 'manifest';
    const mr = await doFetch(`${baseUrl}/${manifestName(v)}`, { timeoutMs: 30_000, retries: 2 });
    if (!mr.ok) return fin({ ok: false, reason: `서명 manifest 를 받지 못했습니다(HTTP ${mr.status}).` });
    const manifestBuf = await readSmall(mr, MANIFEST_MAX);
    const cr = await doFetch(`${baseUrl}/${contentsName(v)}`, { timeoutMs: 30_000, retries: 2 });
    if (!cr.ok) return fin({ ok: false, reason: `내용 목록을 받지 못했습니다(HTTP ${cr.status}).` });
    const contentsBuf = await readSmall(cr, CONTENTS_MAX_BYTES);
    // 본체 전에 서명·내용 목록부터 본다(본체 해시는 아직 모름 → 포인터 값으로 대조, 받은 뒤 실제 해시로 다시)
    const pre = verifyBundle({ pointer, manifestText: manifestBuf.toString('utf8'), contentsBuf, contentsSha256: crypto.createHash('sha256').update(contentsBuf).digest('hex'), tar: { size: pointer.tarball.size, sha256: pointer.tarball.sha256 } }, T());
    if (!pre.ok) return fin({ ok: false, reason: pre.reason });
    st.phase = 'tarball';
    const tr = await doFetch(`${baseUrl}/${tarName(v)}`, { timeoutMs: 3_600_000, retries: 1 });
    if (!tr.ok) return fin({ ok: false, reason: `번들 본체를 받지 못했습니다(HTTP ${tr.status}).` });
    part = path.join(dir, `.${tarName(v)}.part`);
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(part, 'w', 0o640);
    try {
      for await (const c of tr.body) {
        st.sent += c.length;
        if (st.sent > pointer.tarball.size) throw Object.assign(new Error('포인터의 크기보다 큽니다'), { code: 'too-big' });
        h.update(c); fs.writeSync(fd, c);
      }
    } finally { fs.closeSync(fd); }
    const got = { size: st.sent, sha256: h.digest('hex') };
    const v2 = verifyBundle({ pointer, manifestText: manifestBuf.toString('utf8'), contentsBuf, contentsSha256: crypto.createHash('sha256').update(contentsBuf).digest('hex'), tar: got }, T());
    if (!v2.ok) return fin({ ok: false, reason: v2.reason });
    fs.writeFileSync(path.join(dir, manifestName(v)), manifestBuf, { mode: 0o640 });
    fs.writeFileSync(path.join(dir, contentsName(v)), contentsBuf, { mode: 0o640 });
    fs.renameSync(part, path.join(dir, tarName(v)));
    part = '';
    _verified.delete(vkey(dir, v));
    const r = await verifyLocal(v, dir);
    return fin(r.ok ? { ok: true, version: v } : { ok: false, reason: r.reason });
  } catch (e) {
    return fin({ ok: false, reason: `번들 받기 실패 — ${String(e?.code || e?.message || e).slice(0, 160)}` });
  } finally {
    if (part) { try { fs.unlinkSync(part); } catch { /* */ } }
  }
}
