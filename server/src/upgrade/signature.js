/**
 * upgrade/signature.js — 업그레이드 번들 배포자 서명 검증의 **런타임 판정 하나**(검토 S-10, v2.730).
 *
 * 모든 설치 경로가 이 `decideSignature` 하나를 탄다 — 원격 다운로드(GitHub·사내 미러·중앙 /dl) · 중앙 → 엣지 push
 * (`/api/upgrade/bundle`) · 중앙 → 수집기 push(`/api/collector/upgrade`) · 감시 폴더 · 오프라인 확인 도구(verifyCli.js).
 * 형식·서명 코어는 `signatureCore.js`(순수 — CI 서명 스크립트와 공용)다.
 *
 * ── 신뢰 키(고정) ─────────────────────────────────────────────────────────────────────────────────────
 *  ① 저장소 파일 `server/src/upgrade/release-signing-keys.json` — 번들과 함께 배포된다. **키 교체는 이 파일로** 한다:
 *     새 키를 이 파일에 추가한 릴리스를 **옛 키로** 서명해 내보내면, 그 릴리스를 설치한 현장은 다음부터 새 키를 믿는다.
 *  ② 호스트 파일 `CONFIG_DIR/release-signing-keys.conf`(선택 — 호스트 관리자가 직접 둔다). 키 추가·회수.
 *     ⚠ 확장자가 `.json`/`.env` 가 아닌 이유: 백업 복원(backup/service.js ALLOW_EXT)·엣지 설정 push 가 그 확장자만 쓴다 —
 *     웹 화면 경로로 이 파일을 넣어 신뢰 키를 늘릴 수 없게 한다. 그룹·기타 쓰기 권한이 있으면 읽지 않는다(검증 중단).
 *  회수(revoked)는 어느 출처든 이긴다 — 호스트 파일이 저장소 키를 회수할 수 있고, 저장소가 회수한 키를 되살릴 수 없다.
 *
 * ── 정책 ──────────────────────────────────────────────────────────────────────────────────────────────
 *  기본 `require`(서명 필수): 확인할 수 없으면(신뢰 키 없음·manifest 없음·모르는 키) **설치하지 않고** 사유를 남긴다.
 *  호스트 비상 탈출구는 env `UPGRADE_SIGNATURE_POLICY=warn` 뿐이다(portal.env — 웹 화면에서 바꾸는 경로를 두지 않는다).
 *  warn 이어도 **확인했더니 틀린 것**(서명 불일치·회수 키·버전/파일/크기/sha 불일치·형식 오류)은 거부한다 —
 *  탈출구는 '서명이 없는 소스' 를 위한 것이다. warn 으로 진행하면 콘솔·상태·화면에 경고를 남긴다.
 *  모르는 값은 require 로 본다(조용한 약화 금지). SHA 검사·아카이브 경로 검증·크기 상한은 이것과 별개로 그대로다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  parseKeysDoc, mergeTrust, verifyEnvelopeText, matchArtifact, sha256Hex, strictBase64,
  CANNOT_VERIFY, MANIFEST_MAX_BYTES, manifestNameFor,
} from './signatureCore.js';

export const REPO_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-signing-keys.json');
export const HOST_KEYS_NAME = 'release-signing-keys.conf';
export const hostKeysFile = (configDir = config.configDir) => path.join(configDir, HOST_KEYS_NAME);
/** push 요청 헤더 — manifest 봉투(JSON)의 base64. */
export const MANIFEST_HEADER = 'x-bundle-manifest';
/** 헤더 값 상한(base64 글자) — node 기본 헤더 총량 16KB 안. 넘으면 보내지 않는다(수신측이 '없음' 으로 판정). */
export const MANIFEST_HEADER_MAX = 12288;
const KEYS_FILE_MAX = 262144;
const DOC = 'docs/RELEASE-SIGNING.md';

/** 정책 — env 만 본다. 빈 값·require 는 require, warn 은 warn, 그 밖은 require + invalid 표시. */
export function signaturePolicy(env = process.env) {
  const given = env.UPGRADE_SIGNATURE_POLICY;
  const raw = String(env.UPGRADE_SIGNATURE_POLICY || 'require').trim().toLowerCase();
  if (raw === 'warn') return { policy: 'warn', source: 'env' };
  if (raw === 'require' || raw === 'required') return { policy: 'require', source: given ? 'env' : 'default' };
  return { policy: 'require', source: 'env', invalid: raw.slice(0, 40) };
}

function readKeysFile(file, label, { checkPerms = false } = {}) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw Object.assign(new Error(`${label}이(가) 파일이 아닙니다`), { code: 'ENOTFILE' });
  if (st.size > KEYS_FILE_MAX) throw Object.assign(new Error(`${label}이(가) 너무 큽니다(${st.size}바이트)`), { code: 'ETOOBIG' });
  if (checkPerms && process.platform !== 'win32' && (st.mode & 0o022) !== 0) {
    throw Object.assign(new Error(`${label}의 권한이 너무 넓습니다(그룹·기타 쓰기 가능 — chmod 600 또는 640)`), { code: 'EPERMS' });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 신뢰 키를 읽는다. 파일이 작아 매번 읽는다(검증은 드물다). 호스트 파일이 **있는데** 못 읽으면 회수 목록을 알 수 없으므로
 * `fatal` 을 세워 검증을 진행하지 않는다(fail-closed). 저장소 파일을 못 읽어도 fatal.
 */
export function loadTrust({ repoFile = REPO_KEYS_FILE, hostFile = hostKeysFile() } = {}) {
  const sources = {
    repo: { file: 'server/src/upgrade/release-signing-keys.json', ok: false, count: 0, error: null },
    host: { file: path.basename(hostFile), present: false, ok: true, count: 0, revoked: 0, error: null },
  };
  const parsed = [];
  let fatal = null;
  try {
    const p = parseKeysDoc(readKeysFile(repoFile, '저장소 신뢰 키 파일'), 'repo');
    parsed.push(p);
    sources.repo.ok = true; sources.repo.count = p.keys.length;
  } catch (e) {
    sources.repo.error = String(e?.code || e?.message || e).slice(0, 120);
    fatal = `저장소 신뢰 키 파일을 읽지 못했습니다(${sources.repo.error})`;
  }
  let present = false;
  try { present = fs.existsSync(hostFile); } catch { present = false; }
  if (present) {
    sources.host.present = true;
    try {
      const p = parseKeysDoc(readKeysFile(hostFile, `호스트 신뢰 키 파일(${HOST_KEYS_NAME})`, { checkPerms: true }), 'host');
      parsed.push(p);
      sources.host.count = p.keys.length; sources.host.revoked = p.revokedIds.size;
    } catch (e) {
      sources.host.ok = false;
      sources.host.error = String(e?.message || e?.code || e).slice(0, 200);
      fatal = fatal || `호스트 신뢰 키 파일을 읽지 못했습니다 — 회수 목록을 알 수 없어 검증을 진행하지 않습니다(${sources.host.error})`;
    }
  }
  const t = mergeTrust(parsed);
  return { ...t, sources, fatal };
}

let _last = null;
let _counts = { verified: 0, warned: 0, rejected: 0 };
export function recordVerification(d) {
  _last = { at: d.at, where: d.where, ok: d.ok, verified: d.verified, warned: !!d.warned, code: d.code || null,
    reason: d.reason ? String(d.reason).slice(0, 400) : '', keyId: d.keyId || null, version: d.version || null, name: d.name || null, policy: d.policy };
  if (d.verified) _counts.verified += 1; else if (d.ok) _counts.warned += 1; else _counts.rejected += 1;
}
export function _resetSignatureStatusForTest() { _last = null; _counts = { verified: 0, warned: 0, rejected: 0 }; }

function guidance(code) {
  if (code === 'no-trusted-keys') return ` 이 설치본에 신뢰 공개키가 없습니다 — 공개키가 들어간 릴리스로 업그레이드하거나 호스트 파일 ${HOST_KEYS_NAME} 에 키를 두세요(${DOC}).`;
  if (code === 'manifest-missing' || code === 'manifest-unavailable') return ` 번들과 같은 폴더(또는 원격 소스)에 ${manifestNameFor('<버전>')} 가 있어야 합니다(${DOC}).`;
  if (code === 'unknown-key') return ` 이 설치본이 모르는 키입니다 — 키 교체 릴리스를 먼저 설치했는지 확인하세요(${DOC}).`;
  if (code === 'trust-unreadable') return ` 신뢰 키 파일을 확인하세요(${DOC}).`;
  return '';
}

/**
 * 설치 전 서명 판정 — 모든 경로가 이 함수 하나를 쓴다.
 * @param {object} o
 * @param {string|Buffer|null} o.manifestText 봉투 글(없으면 null)
 * @param {Buffer} [o.bytes] 산출물 바이트(sha256·size 를 직접 계산) — 또는 o.sha256 + o.size
 * @param {string} [o.name] 산출물 파일 이름(원격·감시 폴더). push 는 이름이 없어 kind+sha 로 찾는다.
 * @param {string|null} [o.kind='bundle'] null 이면 종류를 따지지 않는다(오프라인 확인 도구 — 이름으로 찾는다)
 * @param {string} [o.expectVersion] 요청·설치하려는 버전 — manifest 버전과 같아야 한다
 * @param {string} o.where 'remote'|'push-edge'|'push-collector'|'watch'|'package'|'offline'|'bundle-source'
 * @param {string} [o.unavailableReason] manifest 를 가져오다 실패한 사유(없음과 구분)
 * @param {object} [o.trust] 테스트·CLI 가 주입하는 신뢰 집합(loadTrust 결과)
 * @param {'require'|'warn'} [o.policy]
 * @param {boolean} [o.preflight] 번들을 받기 전 사전 확인 — 서명·버전·이름만(주어진 sha·크기는 대조), 바이트 대조는 받은 뒤에
 * @param {string} [o.malformedReason] manifest 를 받다 형식 오류로 판정한 사유(상한 초과 등 — 정책과 무관하게 거부)
 * @returns {{ok:boolean, verified:boolean, warned?:boolean, code?:string, reason?:string, keyId?:string, version?:string, policy:string, where:string, at:number}}
 */
export function decideSignature(o = {}) {
  const pol = o.policy ? { policy: o.policy } : signaturePolicy();
  const trust = o.trust || loadTrust();
  const sha = o.sha256 ? String(o.sha256).toLowerCase() : (o.bytes ? sha256Hex(o.bytes) : '');
  const size = Number.isFinite(o.size) ? o.size : (o.bytes ? o.bytes.length : undefined);
  let r;
  const noKeys = { ok: false, code: 'no-trusted-keys', reason: '신뢰 공개키가 0개입니다' };
  if (trust.fatal) r = { ok: false, code: 'trust-unreadable', reason: trust.fatal };
  else if (o.malformedReason) r = { ok: false, code: 'manifest-malformed', reason: String(o.malformedReason) };
  else if (o.manifestText == null || o.manifestText === '') {
    if (!trust.activeCount) r = noKeys;
    else r = o.unavailableReason ? { ok: false, code: 'manifest-unavailable', reason: o.unavailableReason } : { ok: false, code: 'manifest-missing', reason: '서명 manifest 가 없습니다' };
  } else {
    // ⚠ 신뢰 키가 0개여도 봉투는 검증한다 — 회수된 키·틀린 서명은 '확인할 수 없음' 이 아니라 '틀림' 이다(warn 이어도 거부).
    //   모르는 키인데 신뢰 키가 0개면 그때만 '신뢰 키 없음' 으로 말한다.
    const v = verifyEnvelopeText(o.manifestText, trust);
    if (!v.ok) r = (v.code === 'unknown-key' && !trust.activeCount) ? { ...noKeys, keyId: v.keyId } : v;
    else {
      const m = matchArtifact(v.manifest, { name: o.name, kind: o.kind === undefined ? 'bundle' : o.kind, size, sha256: sha, expectVersion: o.expectVersion, checkHash: !o.preflight });
      r = m.ok ? { ok: true, keyId: v.keyId, version: v.manifest.version } : { ...m, keyId: v.keyId, version: v.manifest.version };
    }
  }
  const base = { policy: pol.policy, where: String(o.where || 'unknown'), at: Date.now(), name: o.name || null };
  let out;
  if (r.ok) out = { ok: true, verified: true, keyId: r.keyId, version: r.version, ...base };
  else if (CANNOT_VERIFY.has(r.code) && pol.policy === 'warn') {
    out = { ok: true, verified: false, warned: true, code: r.code, reason: `서명을 확인하지 못했지만 UPGRADE_SIGNATURE_POLICY=warn 이라 진행합니다 — ${r.reason}`, keyId: r.keyId || null, version: r.version || null, ...base };
    console.warn(`[upgrade] ⚠ 서명 미확인 설치 허용(UPGRADE_SIGNATURE_POLICY=warn, ${base.where}): ${r.reason}`);
  } else {
    out = { ok: false, verified: false, code: r.code, reason: `서명 검증 실패 — ${r.reason}.${guidance(r.code)}`, keyId: r.keyId || null, version: r.version || null, ...base };
    console.warn(`[upgrade] 서명 검증 실패(${base.where}, ${r.code}): ${r.reason}`);
  }
  recordVerification(out);
  return out;
}

/** 판정 결과를 응답·lastResult 에 싣는 짧은 형태(사유 글은 reason 이 따로 갖는다). */
export const signatureSummary = (d) => (d ? { verified: !!d.verified, warned: !!d.warned, code: d.code || null, keyId: d.keyId || null, version: d.version || null, policy: d.policy, where: d.where } : null);

/** 상태 — 업그레이드 화면이 '신뢰 키 수 · 마지막 검증 결과 · 정책' 을 보여 준다(공개키 id 만 — 비밀 없음). */
export function signatureStatus() {
  const pol = signaturePolicy();
  const t = loadTrust();
  const activeIds = [...t.byId.values()].filter((k) => !k.revoked && k.publicKey).map((k) => k.keyId);
  return {
    policy: pol.policy, policySource: pol.source, policyInvalid: pol.invalid || null,
    trustedKeys: t.activeCount, revokedKeys: t.revokedCount, keyIds: activeIds.slice(0, 8),
    ready: !t.fatal && t.activeCount > 0,
    fatal: t.fatal, errors: t.errors.slice(0, 5),
    sources: t.sources,
    last: _last, counts: { ..._counts },
  };
}

/* ───────────────────────────── manifest 파일·헤더 ───────────────────────────── */

const ARCHIVE_VER_RE = /vmware-portal-(\d{1,9}\.\d{1,9}\.\d{1,9})\.(?:tar\.gz|tgz|zip)$/;
/** 번들 파일 옆의 manifest 경로(같은 폴더 · 같은 버전). 이름이 규칙에 맞지 않으면 null. */
export function manifestPathForArchive(archivePath) {
  const m = ARCHIVE_VER_RE.exec(path.basename(String(archivePath || '')));
  return m ? path.join(path.dirname(archivePath), manifestNameFor(m[1])) : null;
}
export const archiveVersionOf = (archivePath) => ARCHIVE_VER_RE.exec(path.basename(String(archivePath || '')))?.[1] || null;

// 릴리스 산출물 이름 전부(번들·el9·cent9·windows) — update-versions.mjs·release-sign.mjs 의 이름 규칙과 같다.
const ARTIFACT_VER_RE = /^vmware-portal-(?:offline-|win-)?(\d{1,9}\.\d{1,9}\.\d{1,9})(?:\.tar\.gz|\.tgz|\.zip|(?:-[a-z0-9]{1,16})?-x64\.(?:tar\.gz|zip))$/;
/**
 * 산출물 파일 옆의 manifest 경로 — **있을 때만**(없으면 null). 에이전트 원격 배포(agent/deploy.js)가 설치 패키지와 함께
 * 원격 호스트로 올려 install.sh --package/--manifest 로 넘기는 데 쓴다(기존 설치본이 v2.730 이상이면 install.sh 가 확인을 요구한다).
 */
export function manifestPathForArtifact(p) {
  const m = ARTIFACT_VER_RE.exec(path.basename(String(p || '')));
  if (!m) return null;
  const mp = path.join(path.dirname(p), manifestNameFor(m[1]));
  try { return fs.statSync(mp).isFile() ? mp : null; } catch { return null; }
}

/** manifest 파일을 읽는다 — 없으면 null. 상한보다 크면 상한+1 바이트만 읽어 검증이 '형식 오류' 로 거부하게 한다. */
export function readManifestFile(p) {
  if (!p) return null;
  let fd;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const n = Math.min(st.size, MANIFEST_MAX_BYTES + 1);
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* */ } }
}

/** push 헤더 값으로 — 상한을 넘으면 null(보내지 않는다). */
export function encodeManifestHeader(text) {
  if (text == null || text === '') return null;
  const b = Buffer.from(String(text), 'utf8').toString('base64');
  return b.length <= MANIFEST_HEADER_MAX ? b : null;
}
/** 수신 헤더 → 봉투 글. 헤더가 없으면 null. base64 가 아니면 원문을 그대로 돌려 검증이 '형식 오류' 로 거부하게 한다. */
export function decodeManifestHeader(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().slice(0, MANIFEST_HEADER_MAX + 4);
  const buf = strictBase64(s, MANIFEST_HEADER_MAX + 4);
  return buf ? buf.toString('utf8') : s;
}
