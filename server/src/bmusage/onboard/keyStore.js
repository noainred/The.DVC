/**
 * bmusage/onboard/keyStore.js — SSH 키 저장소 + 법인 공통 계정(7b단계 · 설계 PROFILES §18 'SSH 키 저장소' · §19 자격증명).
 *
 * 파일 `CONFIG_DIR/ssh-keys.json`(0600 · 원자적 쓰기 · 로드 손상 preserveCorrupt · secretVault 봉인 — `security/secretVault.js SECRET_FILES` 등록):
 *   { keys: [ { id, name, algo, sshType, bits, fingerprint, publicKey, privateKey(봉인), passphrase(봉인), createdBy, createdAt, rotateAt, status, retiredAt } ],
 *     accounts: [ { id, name, kind:'os'|'idrac', corp(vCenter id · ''=전 법인), username, keyRef(os), password(봉인), createdBy, createdAt, updatedAt } ] }
 *
 * 불변조건(server/CLAUDE.md '7b SSH 키 저장소'):
 *  · 화면 · API · 내보내기 · 백업 · 엣지 설정 push 에는 **지문 · 공개키만**(publicKeyView/publicAccountView) — 원본은 `keyMaterial()` 하나로만 나간다(접속 직전).
 *    백업 · 엣지 push 번들은 `backup/service.js putCollected` 가 `redactKeyStoreText` 로 개인키 · passphrase · 비밀번호를 지운다.
 *  · 정책 잠금(S-07)이면 봉인이 던지는 `SECRETS_POLICY_UNAVAILABLE` 를 그대로 돌려준다(평문으로 쓰지 않는다 · 메모리도 바꾸지 않는다).
 *  · 파일을 못 읽으면(손상 · 손상 보존본만) **쓰기를 거절**한다(registry-unreadable) — 빈 저장소로 새로 쓰면 보존본의 키 참조가 영영 끊긴다.
 *  · 쓰기는 전부 동기(load → 사본 수정 → 봉인 · 원자적 쓰기 → 성공한 뒤에만 캐시 교체) — 같은 프로세스에서 읽기-수정-쓰기가 끼어들 틈이 없다.
 *  · 키 판정은 `keyParse.js parsePrivateKey` 하나 — 종류 · 지문을 사람이 적은 값으로 받지 않는다.
 * 사용처 수(쓰는 서버 · 계정)와 회전은 등록부를 함께 보는 `refs.js` 가 한다(이 파일은 등록부를 import 하지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeLoadError, filterObjectElements } from '../../util/registryCore.js';
import { openSecretsDeep, sealSecretsDeep, decryptFailureCount, loadSecretsPolicy } from '../../security/secretVault.js';
import { parsePrivateKey, PASSPHRASE_MAX } from './keyParse.js';
import { sshHostKeyFingerprint } from '../../proxy/sshExec.js';

import { KEY_FILE_NAME } from './keyBundle.js';
export { KEY_FILE_NAME };
const FILE = path.join(config.configDir, 'ssh-keys.json');   // = KEY_FILE_NAME(문서 생성기가 글자 그대로 찾는다)
export const MAX_KEYS = 200;
export const MAX_ACCOUNTS = 500;
/** 이름 규칙 — CSV os_key · os_cred · idrac_cred 칸이 이 이름으로 가리킨다(셸 · CSV 에 안전한 글자만). */
export const NAME_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]{0,63}$/;
/** CSV 에서 다른 뜻으로 쓰는 낱말 — 키 · 계정 이름으로 쓰지 않는다. */
export const RESERVED_NAMES = Object.freeze(['password', 'none', 'individual', '개별', '비밀번호', 'auto']);
const USERNAME_BAD = /[\s'"`;|&<>$\\]/;
/**
 * v3.9.0(SSH 공용 접속 — 설계 docs/design/ssh-access §9): 키 **폴더**(법인 › 공통 / 서버별 › 서버)와 **허용 기능**.
 *  · `folderCorp`(vCenter id — 법인) · `folderServer`(OS 등록부 서버 이름) — 빈 값 = 미분류(예전 키 — 어느 서버든 쓸 수 있다, 키 점검이 경고).
 *    폴더가 있는 키는 그 법인 서버에만(서버별이면 그 서버에만) 쓰인다 — 판정은 `refs.resolveOsAuth` 하나.
 *  · `features` — 이 키로 접속해도 되는 기능 id 목록. `null` = 모든 기능(예전 키 — 키 점검이 경고). 빈 배열 = 어느 기능도 못 쓴다.
 */
export const KEY_FEATURES = Object.freeze(['bm-usage', 'bm-storage', 'disk-audit']);
const FOLDER_RE = /^[^\u0000-\u001f\u007f/\\]{1,128}$/;   // 경로 조각이 아니다(id · 이름 — 슬래시 · 제어문자만 막는다)
export function normFeatures(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map((x) => t(x, 32)).filter((x) => KEY_FEATURES.includes(x)))];
}
/** 새 로그인 키는 암호화 정책에서만 받는다(키 보안 — 평문 정책이면 디스크에 개인키 평문이 남는다). 정책을 못 읽으면 받지 않는다. */
export function keyVaultIssue() {
  let pol = null;
  try { pol = loadSecretsPolicy(); } catch { pol = null; }
  const mode = pol?.mode || '';
  if (mode === 'encrypted') return null;
  // S-07 정책 잠금(못 읽음)은 7b 와 같은 code 로 — ‘평문이라 거절’ 과 ‘정책을 몰라 거절’ 은 조치가 다르다.
  if (!pol || pol.locked || mode === 'unavailable') return { ok: false, code: 'SECRETS_POLICY_UNAVAILABLE', status: 503,
    reason: '자격증명 저장 방식(secrets-policy.json)을 읽지 못해 새 키를 저장하지 않았습니다 — 설정 › 보안 › 자격증명 저장 방식을 확인하세요.' };
  return { ok: false, code: 'keys-need-encryption', status: 409,
    reason: '로그인 키는 자격증명 저장 방식이 ‘암호화’ 일 때만 받습니다 — 설정 › 보안 › 자격증명 저장 방식에서 암호화로 바꾼 뒤 다시 등록하세요(평문 방식에서는 개인키가 디스크에 그대로 남습니다).' };
}

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const lc = (v) => t(v).toLowerCase();

let cache = null;
const loadErr = makeLoadError();
// 7b 반증 F5 · 감사 L-5: 봉인을 못 푼 값(비밀키 교체 · SECRETS_KEY 불일치)은 openSecretsDeep 이 '' 로 준다 — 그 상태로 commit 하면
//   봉인본이 '' 로 덮인다. 이 파일은 백업 · 엣지 push 에 개인키를 싣지 않으므로 봉인본이 **유일한 사본**이다 → 복호 실패가 하나라도 있으면 쓰기를 거절한다.
let undecryptable = 0;
export function keyStoreLoadError() { load(); return loadErr.get(); }

function normKey(k) {
  const id = t(k.id, 32);
  if (!id) return null;
  return {
    id, name: t(k.name, 64), algo: t(k.algo, 16), sshType: t(k.sshType, 40),
    bits: Number.isInteger(k.bits) ? k.bits : null,
    fingerprint: t(k.fingerprint, 80), publicKey: t(k.publicKey, 4096),
    privateKey: typeof k.privateKey === 'string' ? k.privateKey : '',
    passphrase: typeof k.passphrase === 'string' ? k.passphrase : '',
    createdBy: t(k.createdBy, 64), createdAt: Number(k.createdAt) > 0 ? Number(k.createdAt) : 0,
    rotateAt: Number(k.rotateAt) > 0 ? Number(k.rotateAt) : null,
    // v3.10.0: 'pending' = 두 사람 승인을 기다리는 키 — 저장은 됐지만 접속에 쓰지 않는다(keyMaterial 이 거절 · 승인 = activateKey).
    status: k.status === 'retired' ? 'retired' : k.status === 'pending' ? 'pending' : 'active',
    retiredAt: Number(k.retiredAt) > 0 ? Number(k.retiredAt) : null,
    folderCorp: FOLDER_RE.test(t(k.folderCorp, 128)) ? t(k.folderCorp, 128) : '',
    folderServer: FOLDER_RE.test(t(k.folderCorp, 128)) && FOLDER_RE.test(t(k.folderServer, 128)) ? t(k.folderServer, 128) : '',
    features: normFeatures(k.features),
  };
}
function normAccount(a) {
  const id = t(a.id, 32);
  if (!id) return null;
  return {
    id, name: t(a.name, 64), kind: a.kind === 'idrac' ? 'idrac' : 'os', corp: t(a.corp, 128),
    username: t(a.username, 128), keyRef: a.kind === 'idrac' ? '' : t(a.keyRef, 32),
    password: typeof a.password === 'string' ? a.password : '',
    createdBy: t(a.createdBy, 64), createdAt: Number(a.createdAt) > 0 ? Number(a.createdAt) : 0,
    updatedAt: Number(a.updatedAt) > 0 ? Number(a.updatedAt) : 0,
    // iDRAC 공통 계정은 적용 때 비밀번호가 iDRAC 항목에 **복사**된다 — 그 항목 id 를 남겨 사용처로 센다(7b 반증 F15).
    copies: a.kind === 'idrac' && Array.isArray(a.copies) ? [...new Set(a.copies.map((x) => t(x, 128)).filter(Boolean))].slice(0, 5000) : [],
  };
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const failBefore = decryptFailureCount();
      const opened = openSecretsDeep({ keys: Array.isArray(j?.keys) ? j.keys : [], accounts: Array.isArray(j?.accounts) ? j.accounts : [] });
      undecryptable = Math.max(0, decryptFailureCount() - failBefore);
      cache = {
        keys: filterObjectElements(opened.keys).list.map(normKey).filter(Boolean),
        accounts: filterObjectElements(opened.accounts).list.map(normAccount).filter(Boolean),
      };
    }
  } catch (e) { preserveCorrupt(FILE, e?.message); loadErr.set(e); cache = null; }
  if (!cache) { loadErr.checkCorruptOnly(FILE); cache = { keys: [], accounts: [] }; }
  return cache;
}

/** 테스트 전용 — 메모리 캐시를 비워 다음 호출이 파일을 다시 읽게 한다. */
export function _resetKeyStoreForTest() { cache = null; loadErr.clear(); undecryptable = 0; _tampered.clear(); _tamperedAcc.clear(); }
/** 봉인을 못 푼 값 수(0 이면 정상) — 화면 · 라우트가 '쓰기 거절' 사유를 말한다. */
export function keyStoreUndecryptable() { load(); return undecryptable; }

const unreadable = () => {
  load();   // ⚠ 로드를 먼저 — 첫 호출이 쓰기면 오류 상태가 아직 없다(손상 파일을 빈 저장소로 덮어쓰던 결함 · ⑦ 이 잡았다)
  const e = loadErr.get();
  if (e) return { ok: false, code: 'registry-unreadable', status: 503, reason: `SSH 키 저장소(${KEY_FILE_NAME})를 읽지 못해 바꾸지 않았습니다 — 손상 보존본(${KEY_FILE_NAME}.corrupt.*)을 확인해 되돌린 뒤 다시 시도하세요.` };
  if (undecryptable) return { ok: false, code: 'secrets-undecryptable', status: 503, reason: `봉인을 풀지 못한 비밀 ${undecryptable}개가 있어(자격증명 비밀키 불일치 의심) 키 저장소를 바꾸지 않았습니다 — 봉인본을 지우지 않기 위해서입니다(이 파일은 백업에 개인키가 없습니다). 원래 비밀키로 되돌린 뒤 다시 시도하세요.` };
  return null;
};

/**
 * 사본을 바꿔 봉인 · 원자적으로 쓴 뒤에만 캐시를 바꾼다. 봉인 실패(정책 잠금)는 code 그대로.
 * v3.9.0(반증 D8): 쓰기 전에 디스크가 포탈이 마지막으로 쓴 내용과 같은지 본다 — 다르면 쓰지 않는다(포탈 밖 변경의 흔적을 정상 쓰기가 사건 없이 지우지 않게).
 *   사람이 확인한 뒤 ‘키 저장소 다시 읽기’(설정 소유자 + OTP)로 디스크를 새 기준으로 삼으면 다시 쓸 수 있다.
 */
function commit(next) {
  const dd = diskDrift();
  const outside = !dd.ok ? -1 : dd.changed.length + dd.added.length + dd.removed.length + dd.accountsChanged.length;
  if (outside) {
    return { ok: false, code: 'store-changed-outside', status: 409,
      reason: outside < 0
        ? `SSH 키 저장소 파일을 다시 읽지 못해(${String(dd.reason || '').slice(0, 60)}) 포탈 밖 변경 여부를 모릅니다 — 바꾸지 않았습니다.`
        : `SSH 키 저장소 파일이 포탈 밖에서 바뀌어(${outside}곳) 바꾸지 않았습니다 — 설정 › 보안 › SSH 공용 접속 › 키 보안에서 확인한 뒤 ‘키 저장소 다시 읽기’ 를 누르세요.` };
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ keys: next.keys, accounts: next.accounts }), null, 2), { mode: 0o600 });
  } catch (e) {
    if (e?.code === 'SECRETS_POLICY_UNAVAILABLE') return { ok: false, code: 'SECRETS_POLICY_UNAVAILABLE', status: 503, reason: e.message };
    return { ok: false, code: 'write-failed', status: 500, reason: `SSH 키 저장소를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}).` };
  }
  cache = next;
  loadErr.clear();
  return { ok: true };
}
const draft = () => { const d = load(); return { keys: d.keys.map((k) => ({ ...k })), accounts: d.accounts.map((a) => ({ ...a })) }; };

/* ── 보이는 모양(비밀 없음) ───────────────────────────────────────────── */

/** 키 → 공개 모양. 개인키 · passphrase 는 싣지 않는다(있는지만). */
export function publicKeyView(k, { usage = null, now = Date.now() } = {}) {
  const u = usage && typeof usage === 'object' ? usage : null;
  return {
    id: k.id, name: k.name, algo: k.algo, sshType: k.sshType, bits: k.bits, fingerprint: k.fingerprint, publicKey: k.publicKey,
    hasPassphrase: !!k.passphrase, hasPrivateKey: !!k.privateKey,
    createdBy: k.createdBy, createdAt: k.createdAt || null, rotateAt: k.rotateAt, status: k.status, retiredAt: k.retiredAt,
    rotateDue: !!(k.rotateAt && k.rotateAt <= now && k.status === 'active'),
    recommended: k.algo === 'ed25519',
    folderCorp: k.folderCorp || '', folderServer: k.folderServer || '', features: Array.isArray(k.features) ? [...k.features] : null,
    // 사용처 수 — 모르면 null('—'). 0 으로 지어내지 않는다(등록부를 못 읽었으면 삭제도 막힌다).
    servers: u ? u.servers : null, accountsUsing: u ? u.accounts : null,
  };
}
export function publicAccountView(a, { usage = null } = {}) {
  return {
    id: a.id, name: a.name, kind: a.kind, corp: a.corp, username: a.username, keyRef: a.keyRef,
    hasPassword: !!a.password, createdBy: a.createdBy, createdAt: a.createdAt || null, updatedAt: a.updatedAt || null,
    servers: usage && typeof usage === 'object' ? usage.servers : null,
    ...(a.kind === 'idrac' ? { copyMode: true } : {}),   // iDRAC 은 복사 방식 — 비밀번호를 바꾸면 사본(쓰는 서버)마다 다시 적용해야 한다
  };
}

/** iDRAC 공통 계정 사본 기록(적용이 비밀번호를 복사한 iDRAC 항목 id). 한 번 쓰기. */
export function noteAccountCopies(accountId, ids = [], { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const a = d.accounts.find((x) => x.id === t(accountId, 32));
  if (!a || a.kind !== 'idrac') return { ok: false, code: 'not-found', status: 404, reason: '공통 계정을 찾을 수 없습니다.' };
  const before = a.copies.length;
  a.copies = [...new Set([...a.copies, ...ids.map((x) => t(x, 128)).filter(Boolean)])].slice(0, 5000);
  if (a.copies.length === before) return { ok: true, changed: 0 };
  a.updatedAt = now;
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, changed: a.copies.length - before };
}

/* ── 조회 ─────────────────────────────────────────────────────────────── */

/** 원본(비밀 포함) 키 목록의 **얕은 사본** — refs.js(사용처) · 테스트만. 응답에 싣지 말 것. */
export function listKeysRaw() { return load().keys.map((k) => ({ ...k })); }
export function listAccountsRaw() { return load().accounts.map((a) => ({ ...a })); }
export function keyById(id) { const k = load().keys.find((x) => x.id === t(id, 32)); return k ? { ...k } : null; }
export function keyByName(name) { const n = lc(name); const k = n ? load().keys.find((x) => lc(x.name) === n) : null; return k ? { ...k } : null; }
export function accountById(id) { const a = load().accounts.find((x) => x.id === t(id, 32)); return a ? { ...a } : null; }
/** kind · 이름으로 계정(대소문자 무시). */
export function accountByName(kind, name) {
  const n = lc(name); const kd = kind === 'idrac' ? 'idrac' : 'os';
  const a = n ? load().accounts.find((x) => x.kind === kd && lc(x.name) === n) : null;
  return a ? { ...a } : null;
}

/* ── 키 점검용(v3.9.0 — sshaccess/check.js) ─────────────────────────────── */

/** 파일에 **평문으로** 남아 있는 개인키 · passphrase 의 키 id(봉인 표지가 없는 값). 파일을 못 읽으면 null(모름). 원문은 돌려주지 않는다. */
export function plainStoredKeyIds() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (Array.isArray(j?.keys) ? j.keys : []).filter((k) => k && typeof k === 'object'
      && ((typeof k.privateKey === 'string' && k.privateKey !== '' && !k.privateKey.startsWith('enc$1$'))
        || (typeof k.passphrase === 'string' && k.passphrase !== '' && !k.passphrase.startsWith('enc$1$')))).map((k) => t(k.id, 32));
  } catch { return null; }
}
/** 저장소 파일 권한(그룹 · 남이 읽을 수 있으면 true). 파일이 없으면 false, 못 보면 null. */
export function keyStoreLoosePerm() {
  try { if (!fs.existsSync(FILE)) return false; return (fs.statSync(FILE).mode & 0o077) !== 0; } catch { return null; }
}
/**
 * 무결성 표지 — 그 키를 접속에 쓰지 않는다(`key-tampered`). 세우는 곳: ① 첫 사용 때 원문 지문 ≠ 저장 지문(refs.integrityOk)
 * ② 주기 점검이 디스크 파일과 메모리를 대조해 포탈 밖에서 바뀐 키(`diskDrift`). 메모리 표지다 — 재시작하면 ① 이 첫 사용 전에 다시 본다.
 * 푸는 곳: 설정 소유자 + OTP 의 ‘키 저장소 다시 읽기’(`reloadKeyStoreFromDisk` — 디스크 내용을 새 기준으로 받아들인다).
 */
const _tampered = new Set();
export function markKeyIntegrity(id, ok) { if (ok) _tampered.delete(t(id, 32)); else _tampered.add(t(id, 32)); }
export function tamperedKeyIds() { return [..._tampered]; }
/** 포탈 밖에서 바뀐 공통 계정(계정명 · 법인 · 기본 키 · 비밀번호) — 그 계정으로는 접속하지 않는다(반증 D4). */
const _tamperedAcc = new Set();
export function tamperedAccountIds() { return [..._tamperedAcc]; }
export function isAccountTampered(id) { return _tamperedAcc.has(t(id, 32)); }
/** 공개키 칸이 지문과 맞는가(화면 ‘공개키 복사’ 가 authorized_keys 배포에 쓰인다 — 공개키만 바꾸면 남의 키를 배포하게 된다 · 반증 D4). */
function publicKeyMatches(k) {
  const b64 = String(k.publicKey || '').trim().split(/\s+/)[1] || '';
  if (!b64) return false;
  try { return sshHostKeyFingerprint(Buffer.from(b64, 'base64')) === k.fingerprint; } catch { return false; }
}

/**
 * 디스크 파일 ↔ 메모리 대조(주기 점검 · 화면) — 포탈이 마지막으로 쓴(또는 읽은) 내용과 디스크가 다른 키.
 * 봉인 문자열이 아니라 **푼 값**으로 비교한다(정책 전환으로 다시 봉인돼도 바뀐 것이 아니다). 바뀐 키는 접속에 쓰지 않게 표지한다.
 * ⚠ 원문과 지문을 함께 바꾸면 첫 사용 대조(refs)는 통과하지만 여기서 ‘바뀜’ 으로 잡힌다(포탈이 쓴 내용과 다르다). 다만 재시작 뒤에는
 *   그 디스크 내용이 새 기준이 된다(메모리가 비어 있다) — 화면 · 문서가 이 한계를 밝힌다.
 * @returns {{ok:boolean, changed:string[], added:{id:string,name:string,fingerprint:string}[], removed:string[], reason?:string}}
 */
export function diskDrift() {
  const out = { ok: true, changed: [], added: [], removed: [], accountsChanged: [] };
  if (keyStoreLoadError()) return { ...out, ok: false, reason: 'store-unreadable' };
  let disk;
  try {
    if (!fs.existsSync(FILE)) disk = { keys: [], accounts: [] };
    else { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); disk = openSecretsDeep({ keys: Array.isArray(j?.keys) ? j.keys : [], accounts: Array.isArray(j?.accounts) ? j.accounts : [] }); }
  } catch (e) { return { ...out, ok: false, reason: `read-failed:${String(e?.code || e?.message || e).slice(0, 40)}` }; }
  const d = load();
  const mem = d.keys;
  const diskKeys = filterObjectElements(disk.keys).list.map(normKey).filter(Boolean);
  const byId = new Map(diskKeys.map((k) => [k.id, k]));
  // 공개키 · 이름도 본다(반증 D4 — 공개키만 바꾸면 ‘공개키 복사’ 가 남의 키를 내줬다).
  const sig = (k) => JSON.stringify([k.privateKey, k.passphrase, k.fingerprint, k.publicKey, k.name, k.status, k.folderCorp, k.folderServer, k.features]);
  for (const k of mem) {
    const dk = byId.get(k.id);
    if (!dk) { out.removed.push(k.id); continue; }
    if (sig(dk) !== sig(k) || !publicKeyMatches(k)) { out.changed.push(k.id); _tampered.add(k.id); }
  }
  const memIds = new Set(mem.map((k) => k.id));
  for (const dk of diskKeys) if (!memIds.has(dk.id)) out.added.push({ id: dk.id, name: dk.name, fingerprint: dk.fingerprint });
  // 공통 계정 — 계정명 · 법인 · 기본 키 · 비밀번호가 포탈이 쓴 것과 다르면 그 계정으로 접속하지 않는다.
  const diskAccs = filterObjectElements(disk.accounts).list.map(normAccount).filter(Boolean);
  const accById = new Map(diskAccs.map((a) => [a.id, a]));
  const asig = (a) => JSON.stringify([a.name, a.kind, a.corp, a.username, a.keyRef, a.password]);
  for (const a of d.accounts) {
    const da = accById.get(a.id);
    if (!da || asig(da) !== asig(a)) { out.accountsChanged.push(a.id); _tamperedAcc.add(a.id); }
  }
  const memAcc = new Set(d.accounts.map((a) => a.id));
  for (const da of diskAccs) if (!memAcc.has(da.id)) out.accountsChanged.push(da.id);
  return out;
}
/** 설정 소유자 + OTP — 디스크 파일을 새 기준으로 다시 읽는다(포탈 밖에서 바뀐 것을 사람이 확인한 뒤). 바꿔치기 표지도 푼다. */
export function reloadKeyStoreFromDisk() {
  cache = null; loadErr.clear(); undecryptable = 0; _tampered.clear(); _tamperedAcc.clear();
  load();
  const e = loadErr.get();
  return e ? { ok: false, code: 'registry-unreadable', status: 503, reason: `SSH 키 저장소를 읽지 못했습니다 — ${String(e.reason || '').slice(0, 120)}` } : { ok: true, keys: load().keys.length };
}

/**
 * 접속 직전에만 쓰는 키 원문. 없거나 못 열었으면(봉인 해제 실패 = '') error code.
 * @returns {{ok:true, privateKey:string, passphrase:string, fingerprint:string, name:string} | {ok:false, code:'key-missing'|'key-unreadable'}}
 */
export function keyMaterial(id) {
  const k = load().keys.find((x) => x.id === t(id, 32));
  if (!k) return { ok: false, code: 'key-missing' };
  if (k.status === 'retired') return { ok: false, code: 'key-retired' };   // 감사 L-11: 퇴역 키로는 접속하지 않는다
  if (k.status !== 'active') return { ok: false, code: 'key-pending' };    // v3.10.0: 승인 대기 키(활성만 쓴다 — 모르는 상태도 거절)
  if (_tampered.has(k.id)) return { ok: false, code: 'key-tampered' };      // v3.9.0: 저장된 원문의 지문이 등록 때와 다르다(바꿔치기 의심)
  if (!k.privateKey) return { ok: false, code: 'key-unreadable' };
  return { ok: true, privateKey: k.privateKey, passphrase: k.passphrase || '', fingerprint: k.fingerprint, name: k.name, id: k.id,
    folderCorp: k.folderCorp || '', folderServer: k.folderServer || '', features: Array.isArray(k.features) ? [...k.features] : null };
}

/* ── 이름 판정(키 · 계정 공용) ─────────────────────────────────────────── */
function nameIssue(name) {
  if (!name) return '이름을 입력하세요.';
  if (!NAME_RE.test(name)) return '이름은 영문 · 숫자 · 한글로 시작하고 영문 · 숫자 · 한글 · . _ - 만 쓸 수 있습니다(최대 64자).';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `‘${name}’ 은 CSV 에서 다른 뜻으로 쓰는 낱말이라 이름으로 쓸 수 없습니다.`;
  return null;
}
const dateMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : NaN;
  const s = t(v, 32);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const ms = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(ms) ? ms : NaN; }
  return NaN;
};

/* ── 키 쓰기 ─────────────────────────────────────────────────────────── */

/**
 * 키 등록. 원문을 직접 판정해 종류 · 비트 · 지문 · 공개키를 만든다.
 * @returns {{ok:true, key:object} | {ok:false, code:string, reason:string, status?:number}}
 */
export function addKey(body = {}, { by = '', now = Date.now(), pending = false } = {}) {
  const u = unreadable(); if (u) return u;
  const vi = keyVaultIssue(); if (vi) return vi;
  const name = t(body.name, 80);
  const ni = nameIssue(name); if (ni) return { ok: false, code: 'bad-name', reason: ni };
  const pass = typeof body.passphrase === 'string' ? body.passphrase : '';
  if (pass.length > PASSPHRASE_MAX) return { ok: false, code: 'bad-passphrase', reason: 'passphrase 가 너무 깁니다.' };
  const rotateAt = dateMs(body.rotateAt);
  if (Number.isNaN(rotateAt)) return { ok: false, code: 'bad-date', reason: '회전 예정일은 YYYY-MM-DD 꼴입니다.' };
  const p = parsePrivateKey(typeof body.privateKey === 'string' ? body.privateKey : '', pass);
  if (!p.ok) return { ok: false, code: p.code, reason: p.reason };
  const d = draft();
  if (d.keys.length >= MAX_KEYS) return { ok: false, code: 'too-many', reason: `키는 ${MAX_KEYS}개까지입니다 — 쓰지 않는 키를 지우세요.` };
  if (d.keys.some((k) => lc(k.name) === name.toLowerCase())) return { ok: false, code: 'dup-name', reason: `같은 이름의 키가 있습니다(‘${name}’).` };
  const same = d.keys.find((k) => k.fingerprint === p.fingerprint);
  if (same) return { ok: false, code: 'dup-key', reason: `같은 키가 이미 ‘${same.name}’ 으로 등록돼 있습니다(지문 ${p.fingerprint}).` };
  const fo = folderOf(body); if (!fo.ok) return fo;
  const key = {
    id: `k_${crypto.randomBytes(6).toString('hex')}`, name, algo: p.algo, sshType: p.sshType, bits: p.bits,
    fingerprint: p.fingerprint, publicKey: p.publicKey, privateKey: body.privateKey, passphrase: pass,
    createdBy: t(by, 64), createdAt: now, rotateAt, status: pending ? 'pending' : 'active', retiredAt: null,
    folderCorp: fo.corp, folderServer: fo.server, features: body.features === undefined ? null : normFeatures(body.features),
  };
  d.keys.push(key);
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, key: publicKeyView(key, { now }) };
}

/** 폴더 입력 판정 — { folderCorp, folderServer }. 서버별 폴더는 법인이 있어야 한다. */
function folderOf(body = {}) {
  const corp = t(body.folderCorp, 128); const server = t(body.folderServer, 128);
  if (corp && !FOLDER_RE.test(corp)) return { ok: false, code: 'bad-folder', reason: '폴더(법인)가 올바르지 않습니다.' };
  if (server && !corp) return { ok: false, code: 'bad-folder', reason: '서버별 폴더는 법인을 먼저 골라야 합니다.' };
  if (server && !FOLDER_RE.test(server)) return { ok: false, code: 'bad-folder', reason: '폴더(서버)가 올바르지 않습니다.' };
  return { ok: true, corp, server };
}

/**
 * 키의 폴더 · 허용 기능 변경(v3.9.0). 원문은 바꾸지 않는다. 쓰는 서버가 새 폴더 밖이 되는지는 호출부(sshaccess)가 등록부와 함께 본다.
 * @param {{folderCorp?:string, folderServer?:string, features?:string[]|null}} body  undefined = 그대로
 */
export function updateKeyPlacement(id, body = {}, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const k = d.keys.find((x) => x.id === t(id, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  if (body.folderCorp !== undefined || body.folderServer !== undefined) {
    const fo = folderOf({ folderCorp: body.folderCorp ?? k.folderCorp, folderServer: body.folderServer ?? (body.folderCorp !== undefined ? '' : k.folderServer) });
    if (!fo.ok) return fo;
    k.folderCorp = fo.corp; k.folderServer = fo.server;
  }
  if (body.features !== undefined) k.features = body.features === null ? null : normFeatures(body.features);
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, key: publicKeyView(k, { now }) };
}

/** 이름 · 회전 예정일 수정(원문은 바꾸지 않는다 — 다른 키는 새로 등록 후 회전). */
export function updateKeyMeta(id, body = {}, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const k = d.keys.find((x) => x.id === t(id, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  if (body.name !== undefined) {
    const name = t(body.name, 80);
    const ni = nameIssue(name); if (ni) return { ok: false, code: 'bad-name', reason: ni };
    if (d.keys.some((x) => x.id !== k.id && lc(x.name) === name.toLowerCase())) return { ok: false, code: 'dup-name', reason: `같은 이름의 키가 있습니다(‘${name}’).` };
    k.name = name;
  }
  if (body.rotateAt !== undefined) {
    const r = dateMs(body.rotateAt);
    if (Number.isNaN(r)) return { ok: false, code: 'bad-date', reason: '회전 예정일은 YYYY-MM-DD 꼴입니다.' };
    k.rotateAt = r;
  }
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, key: publicKeyView(k, { now }) };
}

/** passphrase 입력(비밀 입력) — 그 passphrase 로 저장된 키가 실제로 풀려야 저장한다. */
export function setKeyPassphrase(id, passphrase, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const k = d.keys.find((x) => x.id === t(id, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  if (!k.privateKey) return { ok: false, code: 'key-unreadable', reason: '저장된 개인키를 열지 못했습니다(봉인 해제 실패) — 키를 새로 등록하세요.' };
  const pass = typeof passphrase === 'string' ? passphrase : '';
  const p = parsePrivateKey(k.privateKey, pass);
  if (!p.ok) return { ok: false, code: p.code, reason: p.reason };
  if (p.fingerprint !== k.fingerprint) return { ok: false, code: 'fingerprint-changed', reason: '키 지문이 등록 때와 다릅니다 — 키를 새로 등록하세요.' };
  k.passphrase = pass;
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, key: publicKeyView(k, { now }) };
}

/** 회전 표지만(참조 교체는 refs.js 가 등록부와 함께) — 옛 키를 retired 로. */
/** 승인 대기 키를 쓸 수 있게 한다(두 사람 승인 뒤 — sshaccess/twoPerson.js). 지문이 요청 때와 같을 때만. */
export function activateKey(id, { fingerprint = '' } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const k = d.keys.find((x) => x.id === t(id, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다(요청 뒤 지워졌습니다).' };
  if (k.status !== 'pending') return { ok: false, code: 'not-pending', status: 409, reason: '승인 대기 상태의 키가 아닙니다.' };
  if (t(fingerprint, 80) !== k.fingerprint) return { ok: false, code: 'fingerprint-changed', status: 409, reason: '요청 때의 키와 지문이 다릅니다 — 승인하지 않았습니다.' };
  k.status = 'active';
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, key: publicKeyView(k) };
}

export function markKeyRetired(id, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const k = d.keys.find((x) => x.id === t(id, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  k.status = 'retired'; k.retiredAt = now;
  for (const a of d.accounts) if (a.keyRef === k.id) a.keyRef = '';   // 호출부(refs)가 먼저 바꿔 둔다 — 남은 것은 안전하게 끊는다
  const c = commit(d); if (!c.ok) return c;
  return { ok: true };
}

/** 계정의 기본 키 참조 교체(회전 — refs.js 가 등록부와 같은 순서로 부른다). 바꾼 계정 수. */
export function replaceAccountKeyRefs(fromId, toId, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  let n = 0;
  for (const a of d.accounts) if (a.kind === 'os' && a.keyRef === fromId) { a.keyRef = toId; a.updatedAt = now; n += 1; }
  if (!n) return { ok: true, changed: 0 };
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, changed: n };
}

/** 키 삭제 — 호출부가 사용처 0 을 확인한 뒤(refs.deleteKeyIfUnused). 직접 부르지 말 것. */
export function _removeKey(id) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const before = d.keys.length;
  d.keys = d.keys.filter((x) => x.id !== t(id, 32));
  if (d.keys.length === before) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  const c = commit(d); if (!c.ok) return c;
  return { ok: true };
}

/* ── 공통 계정 쓰기 ───────────────────────────────────────────────────── */

/**
 * 공통 계정 저장(id 있으면 수정). OS 계정은 기본 키(keyRef) 또는 비밀번호 · iDRAC 계정은 비밀번호(읽기 전용 역할 권장).
 *  · 비밀번호 빈 값 · '********' 는 기존 유지(편집 UX — secretCarry 규약과 같은 신호). 접속처가 없는 계정이라 '주소 이동' 은 없다 —
 *    대신 **법인 · 종류 · 계정명**이 바뀌면 저장 비밀 · 기본 키 참조를 승계하지 않는다(다른 법인 · 다른 계정으로 같은 비밀이 가지 않게).
 */
export function saveAccount(body = {}, { by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const id = t(body.id, 32);
  const existing = id ? d.accounts.find((a) => a.id === id) : null;
  if (id && !existing) return { ok: false, code: 'not-found', status: 404, reason: '공통 계정을 찾을 수 없습니다.' };
  const name = t(body.name ?? existing?.name, 80);
  const ni = nameIssue(name); if (ni) return { ok: false, code: 'bad-name', reason: ni };
  const kind = (body.kind ?? existing?.kind) === 'idrac' ? 'idrac' : 'os';
  const username = t(body.username ?? existing?.username, 128);
  if (!username) return { ok: false, code: 'bad-username', reason: '계정명을 입력하세요.' };
  if (USERNAME_BAD.test(username)) return { ok: false, code: 'bad-username', reason: '계정명에 쓸 수 없는 글자가 있습니다.' };
  const corp = t(body.corp ?? existing?.corp, 128);
  if (d.accounts.some((a) => a.id !== id && a.kind === kind && lc(a.name) === name.toLowerCase())) return { ok: false, code: 'dup-name', reason: `같은 이름의 ${kind === 'idrac' ? 'iDRAC' : 'OS'} 공통 계정이 있습니다(‘${name}’).` };
  const moved = !!existing && (existing.kind !== kind || lc(existing.corp) !== lc(corp) || lc(existing.username) !== lc(username));
  const dropped = [];
  // 기본 키 참조도 비밀 참조다 — 법인 · 종류 · 계정명이 바뀌면 요청이 다시 고르지 않는 한 잇지 않는다.
  let keyRef = kind === 'os' ? t(body.keyRef !== undefined ? body.keyRef : (moved ? '' : existing?.keyRef), 32) : '';
  if (moved && body.keyRef === undefined && existing?.keyRef) dropped.push('keyRef');
  if (keyRef && !d.keys.some((k) => k.id === keyRef && k.status === 'active')) return { ok: false, code: 'key-missing', reason: '기본 키가 키 저장소에 없거나 회전으로 퇴역했습니다.' };
  // v3.9.0(점검 B-4): 기본 키의 폴더 — 서버별 폴더 키는 공통 계정의 기본 키가 될 수 없고, 폴더 법인이 계정 법인과 달라도 안 된다(쓰면 수집이 key-folder 로 끊긴다).
  if (keyRef) {
    const kk = d.keys.find((k) => k.id === keyRef);
    if (kk.folderServer) return { ok: false, code: 'key-folder', reason: '서버별 폴더의 키는 법인 공통 계정의 기본 키가 될 수 없습니다 — 공통 폴더의 키를 고르세요.' };
    if (kk.folderCorp && kk.folderCorp !== corp) return { ok: false, code: 'key-folder', reason: '다른 법인 폴더의 키입니다 — 이 계정의 법인 공통 폴더에 있는 키를 고르세요.' };
  }
  if (!existing && d.accounts.length >= MAX_ACCOUNTS) return { ok: false, code: 'too-many', reason: `공통 계정은 ${MAX_ACCOUNTS}개까지입니다.` };
  const provided = body.password !== undefined && body.password !== null && body.password !== '' && body.password !== '********';
  if (provided && String(body.password).length > 1024) return { ok: false, code: 'bad-password', reason: '비밀번호가 너무 깁니다.' };
  let password = provided ? String(body.password) : (existing && !moved ? existing.password : '');
  if (existing && moved && !provided && existing.password) dropped.push('password');
  if (body.clearPassword === true) password = '';
  if (kind === 'idrac' && !password) return { ok: false, code: 'need-password', reason: 'iDRAC 공통 계정에는 비밀번호가 필요합니다(읽기 전용 역할 계정 권장).' };
  if (kind === 'os' && !keyRef && !password) return { ok: false, code: 'need-secret', reason: 'OS 공통 계정에는 기본 키 또는 비밀번호가 필요합니다(키 인증 권장).' };
  const acc = existing || { id: `a_${crypto.randomBytes(6).toString('hex')}`, createdBy: t(by, 64), createdAt: now, copies: [] };
  const copiesStale = existing && kind === 'idrac' && (password !== existing.password || lc(username) !== lc(existing.username)) ? (existing.copies || []).length : 0;
  Object.assign(acc, { name, kind, corp, username, keyRef, password, updatedAt: now });
  if (kind !== 'idrac') acc.copies = [];
  if (!existing) d.accounts.push(acc);
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, account: publicAccountView(acc), ...(dropped.length ? { droppedSecrets: dropped } : {}), ...(copiesStale ? { copiesStale } : {}) };
}

/** 계정 삭제 — 호출부가 사용처 0 을 확인한 뒤(refs.deleteAccountIfUnused). */
export function _removeAccount(id) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const before = d.accounts.length;
  d.accounts = d.accounts.filter((x) => x.id !== t(id, 32));
  if (d.accounts.length === before) return { ok: false, code: 'not-found', status: 404, reason: '공통 계정을 찾을 수 없습니다.' };
  const c = commit(d); if (!c.ok) return c;
  return { ok: true };
}

export { REDACTED_SECRET, redactKeyStoreText, mergeRedactedKeyStore } from './keyBundle.js'; // 번들 가림 · 복원 병합(가벼운 순수 모듈 — backup/service.js 가 import)
