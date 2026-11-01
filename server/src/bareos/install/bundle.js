/**
 * bareos/install/bundle.js — 중앙의 Bareos 완전 설치 번들 보관소(v2.844). 폴더: <패키지 폴더>/bareos-bundle/ (CONFIG_DIR 아님 — 설정 백업에 수백 MB 를 싣지 않는다).
 *
 * 받기: <번들 주소>/bareos-bundle.json(포인터) → manifest(서명) → 내용 목록 → 본체(스트림으로 디스크에 · 해시 동시 계산) → verifyBundle 통과 시에만 자리에 놓는다.
 *   번들 주소 = env BAREOS_BUNDLE_BASE_URL, 없으면 업그레이드 패키지 주소에서 유도(…/releases/download/downloads → …/bareos-bundle · 그 밖은 <주소>/bareos-bundle).
 *   에어갭 현장: 같은 세 파일(tar.gz · .json · .manifest.json)을 이 폴더에 손으로 넣고 '다시 읽기' — 검증은 같다.
 * 규칙: 서명·해시가 맞는 번들만 목록에 '사용 가능' 으로 나온다(맞지 않으면 사유와 함께 '사용 불가') · 받기는 동시에 하나 · 크기 상한(TAR_MAX_BYTES).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPackageBaseUrl, getPackageDir } from '../../upgrade/packageSettings.js';
import { resilientFetch } from '../../util/resilientFetch.js';
import { upgradeAgent } from '../../upgrade/upgradeAgent.js';
import { loadTrust } from '../../upgrade/signature.js';
import {
  BUNDLE_TAG, POINTER_NAME, POINTER_MAX_BYTES, CONTENTS_MAX_BYTES, MANIFEST_MAX, tarName, contentsName, manifestName, TAR_RE,
  pointerIssue, verifyBundle, cmpVersionDesc,
} from './bundleDoc.js';

export const bundleDir = () => path.join(getPackageDir(), 'bareos-bundle');

/** 번들 주소(끝 / 없음). */
export function bundleBaseUrl(env = process.env, pkgBase = getPackageBaseUrl()) {
  const own = String(env.BAREOS_BUNDLE_BASE_URL || '').trim().replace(/\/+$/, '');
  if (own) return own;
  const b = String(pkgBase || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  return /\/releases\/download\/[^/]+$/.test(b) ? b.replace(/\/releases\/download\/[^/]+$/, `/releases/download/${BUNDLE_TAG}`) : `${b}/${BUNDLE_TAG}`;
}

let _trust = null;
let _trustAt = 0;
function trust() { if (!_trust || Date.now() - _trustAt > 60_000) { _trust = loadTrust(); _trustAt = Date.now(); } return _trust; }
let _trustForTest = null;
export function _setTrustForTest(t) { _trustForTest = t; }
const T = () => _trustForTest || trust();

function sha256FileSync(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  let size = 0;
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; size += n; h.update(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  return { sha256: h.digest('hex'), size };
}

/** 검증 결과 기억(파일 크기·수정 시각이 같으면 다시 해시하지 않는다 — 수백 MB). */
const _verified = new Map();

/** 폴더의 한 판을 검증한다(동기 해시 — 받기 직후와 '다시 읽기' 에서만 부른다). */
export function verifyLocal(version, dir = bundleDir()) {
  const tarP = path.join(dir, tarName(version));
  const conP = path.join(dir, contentsName(version));
  const manP = path.join(dir, manifestName(version));
  let st;
  try { st = fs.statSync(tarP); } catch { return { ok: false, code: 'missing', reason: '본체 파일이 없습니다' }; }
  const key = `${version}:${st.size}:${st.mtimeMs}`;
  const hit = _verified.get(version);
  if (hit && hit.key === key) return hit.result;
  let result;
  try {
    const manifestText = fs.readFileSync(manP, 'utf8');
    const contentsBuf = fs.readFileSync(conP);
    if (contentsBuf.length > CONTENTS_MAX_BYTES) throw new Error('내용 목록이 상한보다 큽니다');
    const tar = sha256FileSync(tarP);
    const pointer = { format: 'portal-bareos-bundle-pointer', v: 1, version, tarball: { name: tarName(version), ...tar }, contents: { name: contentsName(version), size: contentsBuf.length, sha256: crypto.createHash('sha256').update(contentsBuf).digest('hex') }, manifest: manifestName(version) };
    const v = verifyBundle({ pointer, manifestText, contentsBuf, contentsSha256: pointer.contents.sha256, tar }, T());
    result = v.ok ? { ok: true, version, sha256: tar.sha256, size: tar.size, contents: v.contents, keyId: v.keyId, tarPath: tarP } : { ok: false, code: v.code, reason: v.reason };
  } catch (e) {
    result = { ok: false, code: e?.code === 'ENOENT' ? 'missing' : 'read', reason: e?.code === 'ENOENT' ? '서명 manifest 또는 내용 목록 파일이 없습니다' : `읽지 못했습니다(${e?.code || '오류'})` };
  }
  _verified.set(version, { key, result });
  return result;
}

/** 폴더의 번들 목록(새 판 먼저). verify=false 면 기억한 결과만(없으면 '확인 전'). */
export function listBundles({ verify = false, dir = bundleDir() } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const versions = names.map((n) => TAR_RE.exec(n)?.[1]).filter(Boolean).sort(cmpVersionDesc).slice(0, 10);
  return versions.map((v) => {
    const r = verify ? verifyLocal(v, dir) : (_verified.get(v)?.result || null);
    let size = null; try { size = fs.statSync(path.join(dir, tarName(v))).size; } catch { /* */ }
    return r ? { version: v, size, ok: r.ok, reason: r.ok ? '' : r.reason, contents: r.ok ? r.contents : null, sha256: r.ok ? r.sha256 : null }
      : { version: v, size, ok: null, reason: '확인 전', contents: null, sha256: null };
  });
}

/** 설치에 쓸 번들(검증된 것 중 가장 새 판 · 또는 지정 판). */
export function pickBundle(version = '', dir = bundleDir()) {
  const list = listBundles({ verify: true, dir });
  const ok = list.filter((b) => b.ok);
  const b = version ? ok.find((x) => x.version === version) : ok[0];
  if (!b) return null;
  const r = verifyLocal(b.version, dir);
  return r.ok ? r : null;
}

export function deleteBundle(version, dir = bundleDir()) {
  if (!TAR_RE.test(tarName(version))) return false;
  let any = false;
  for (const n of [tarName(version), contentsName(version), manifestName(version)]) {
    try { fs.unlinkSync(path.join(dir, n)); any = true; } catch { /* 없음 */ }
  }
  _verified.delete(version);
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
    const have = verifyLocal(v, dir);
    if (have.ok && have.sha256 === pointer.tarball.sha256) return fin({ ok: true, version: v, already: true });
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
    _verified.delete(v);
    const r = verifyLocal(v, dir);
    return fin(r.ok ? { ok: true, version: v } : { ok: false, reason: r.reason });
  } catch (e) {
    return fin({ ok: false, reason: `번들 받기 실패 — ${String(e?.code || e?.message || e).slice(0, 160)}` });
  } finally {
    if (part) { try { fs.unlinkSync(part); } catch { /* */ } }
  }
}
