/**
 * bmusage/onboard/refs.js — SSH 키 저장소 ↔ OS 계정 등록부(bm-storage.json) 연결(7b단계 · 설계 PROFILES §18).
 *
 *  · 사용처 수(쓰는 서버 · 계정) — 등록부를 못 읽으면 **모름(null)** 이고 삭제를 막는다(0 으로 지어내 지우지 않는다).
 *  · 회전: 새 키 등록(현장이 authorized_keys 에 배포 — 포탈은 서버에 키를 넣지 않는다) → 참조 교체(등록부 먼저 · 계정 다음 · 옛 키 퇴역)
 *    → 바뀐 서버 목록을 돌려준다(화면이 '전 서버 재시험' 을 권한다 — 자동 재시험 · 자동 재시도 없음).
 *  · 접속 자격 해석 `resolveOsAuth` — 폴러 · 연결 시험이 같은 하나를 쓴다(판정 코어 하나).
 *    순서: 서버 keyRef → 공통 계정(credRef)의 기본 키 → 공통 계정 비밀번호 → 서버 비밀번호. 키 참조가 있는데 키가 없으면 **비밀번호로 몰래 넘어가지 않고** 오류다.
 */
import { listBmServersRaw, registryLoadError, bmServerRefCounts, replaceBmServerKeyRefs } from '../../bmstor/registry.js';
import * as KS from './keyStore.js';

const t = (v) => String(v ?? '').trim();

/** 키 · 계정별 사용처 수. 등록부를 못 읽으면 null(모름). */
export function refUsage() {
  let regOk = true;
  let counts = { byKey: new Map(), byAcc: new Map() };
  try { if (registryLoadError()) regOk = false; else counts = bmServerRefCounts(); } catch { regOk = false; }
  const accKey = new Map();
  for (const a of KS.listAccountsRaw()) if (a.keyRef) accKey.set(a.keyRef, (accKey.get(a.keyRef) || 0) + 1);
  return {
    known: regOk,
    key: (id) => ({ servers: regOk ? (counts.byKey.get(id) || 0) : null, accounts: accKey.get(id) || 0 }),
    account: (id) => ({ servers: regOk ? (counts.byAcc.get(id) || 0) : null }),
  };
}

export function listKeysView({ now = Date.now() } = {}) {
  const u = refUsage();
  return { keys: KS.listKeysRaw().map((k) => KS.publicKeyView(k, { usage: u.key(k.id), now })), usageKnown: u.known };
}
/** @param {(corp:string)=>boolean} [visible] 범위 계정이 볼 수 있는 법인인가(전 법인 공용 '' 은 늘 보인다) */
export function listAccountsView({ visible = null } = {}) {
  const u = refUsage();
  const list = KS.listAccountsRaw().filter((a) => !a.corp || typeof visible !== 'function' || visible(a.corp));
  return { accounts: list.map((a) => KS.publicAccountView(a, { usage: u.account(a.id) })), usageKnown: u.known };
}

/** 키 삭제 — 쓰는 서버 · 계정이 0 일 때만. 사용처를 모르면 거절. */
export function deleteKeyIfUnused(id) {
  const k = KS.keyById(id);
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  const u = refUsage().key(k.id);
  if (u.servers == null) return { ok: false, code: 'usage-unknown', status: 503, reason: 'OS 계정 등록부를 읽지 못해 이 키를 쓰는 서버 수를 모릅니다 — 삭제하지 않았습니다.' };
  if (u.servers > 0 || u.accounts > 0) return { ok: false, code: 'in-use', status: 409, reason: `이 키를 쓰는 서버 ${u.servers}대 · 공통 계정 ${u.accounts}개가 있어 지울 수 없습니다 — 회전으로 참조를 옮긴 뒤 지우세요.` };
  return KS._removeKey(k.id);
}

export function deleteAccountIfUnused(id) {
  const a = KS.accountById(id);
  if (!a) return { ok: false, code: 'not-found', status: 404, reason: '공통 계정을 찾을 수 없습니다.' };
  const u = refUsage().account(a.id);
  if (u.servers == null) return { ok: false, code: 'usage-unknown', status: 503, reason: 'OS 계정 등록부를 읽지 못해 이 계정을 쓰는 서버 수를 모릅니다 — 삭제하지 않았습니다.' };
  if (u.servers > 0) return { ok: false, code: 'in-use', status: 409, reason: `이 계정을 쓰는 서버 ${u.servers}대가 있어 지울 수 없습니다.` };
  return KS._removeAccount(a.id);
}

/**
 * 키 회전(참조 교체). 둘 다 있어야 하고 새 키는 활성이어야 한다. 순서: 서버 참조 → 계정 기본 키 → 옛 키 퇴역
 * (중간에 멈춰도 가리키는 키는 늘 존재한다 — 옛 키는 마지막에야 퇴역).
 * @returns {{ok:true, servers:string[], accounts:number} | {ok:false, ...}}
 */
export function rotateKey(fromId, toId, { now = Date.now() } = {}) {
  const from = KS.keyById(fromId); const to = KS.keyById(toId);
  if (!from || !to) return { ok: false, code: 'not-found', status: 404, reason: '옛 키 또는 새 키를 찾을 수 없습니다.' };
  if (from.id === to.id) return { ok: false, code: 'same-key', reason: '같은 키로는 회전할 수 없습니다.' };
  if (to.status !== 'active') return { ok: false, code: 'retired', reason: '새 키가 퇴역 상태입니다.' };
  const unread = KS.keyStoreLoadError();
  if (unread) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못해 회전하지 않았습니다.' };
  const r1 = replaceBmServerKeyRefs(from.id, to.id);
  if (!r1.ok) return { ...r1, status: 503 };
  const r2 = KS.replaceAccountKeyRefs(from.id, to.id, { now });
  if (!r2.ok) return { ...r2, partial: { servers: r1.ids } };
  const r3 = KS.markKeyRetired(from.id, { now });
  if (!r3.ok) return { ...r3, partial: { servers: r1.ids, accounts: r2.changed } };
  return { ok: true, servers: r1.ids, accounts: r2.changed || 0 };
}

/** 접속 자격 해석 오류 문구(화면 · 수집 오류 · 연결 시험 공용). */
export const AUTH_ERROR = Object.freeze({
  'key-missing': 'SSH 키 참조가 가리키는 키가 키 저장소에 없습니다(삭제됨) — 서버 설정에서 키를 다시 고르세요.',
  'key-unreadable': 'SSH 키를 열지 못했습니다(봉인 해제 실패 — 자격증명 저장 방식이 바뀌었을 수 있음) — 키를 다시 등록하세요.',
  'account-missing': '공통 계정 참조가 가리키는 계정이 없습니다(삭제됨) — 서버 설정에서 계정을 다시 고르세요.',
  'account-kind': '공통 계정 참조가 OS 계정이 아닙니다.',
  'store-unreadable': 'SSH 키 저장소(ssh-keys.json)를 읽지 못해 키로 접속하지 않았습니다.',
});

/**
 * OS 등록 항목 → 접속 자격(폴러 · 연결 시험 공용). 원본(비밀 포함)을 받아 원본을 돌려준다 — **응답에 싣지 말 것**.
 * @returns {{ok:true, username:string, password:string, privateKey?:string, passphrase?:string, authKind:'key'|'password'|'none', keyFingerprint?:string, keyName?:string}
 *          | {ok:false, code:string, error:string}}
 */
export function resolveOsAuth(server = {}) {
  const keyRef = t(server.keyRef);
  const credRef = t(server.credRef);
  const needStore = !!(keyRef || credRef);
  if (needStore && KS.keyStoreLoadError()) return { ok: false, code: 'store-unreadable', error: AUTH_ERROR['store-unreadable'] };
  let acc = null;
  if (credRef) {
    acc = KS.accountById(credRef);
    if (!acc) return { ok: false, code: 'account-missing', error: AUTH_ERROR['account-missing'] };
    if (acc.kind !== 'os') return { ok: false, code: 'account-kind', error: AUTH_ERROR['account-kind'] };
  }
  const username = t(server.username) || (acc ? acc.username : '') || 'root';
  // osAuth 'password' = 비밀번호 고정(공통 계정에 기본 키가 있어도 — CSV os_key ‘password’).
  const useKey = server.osAuth === 'password' ? '' : (keyRef || (acc && acc.keyRef) || '');
  if (useKey) {
    const m = KS.keyMaterial(useKey);
    if (!m.ok) return { ok: false, code: m.code, error: AUTH_ERROR[m.code] || AUTH_ERROR['key-missing'] };
    // 키 인증일 때 비밀번호는 보내지 않는다(인증 방식을 하나로 — 키가 거부되면 비밀번호로 몰래 넘어가지 않는다).
    return { ok: true, username, password: '', privateKey: m.privateKey, passphrase: m.passphrase, authKind: 'key', keyFingerprint: m.fingerprint, keyName: m.name };
  }
  if (acc && acc.password) return { ok: true, username, password: acc.password, authKind: 'password' };
  const pw = typeof server.password === 'string' ? server.password : '';
  return { ok: true, username, password: pw, authKind: pw ? 'password' : 'none' };
}

/**
 * 폴러용 — OS 등록부 원본에 해석한 자격을 덧씌운다(원본 객체는 바꾸지 않는다). 해석 실패 항목은 authError 를 달아
 * 수집이 접속하지 않고 그 사유로 실패하게 한다(빈 비밀번호로 시도해 인증 실패 · 계정 잠금을 부르지 않게).
 */
export function withResolvedAuth(list = []) {
  return (Array.isArray(list) ? list : []).map((s) => {
    if (!s || typeof s !== 'object') return s;
    if (!t(s.keyRef) && !t(s.credRef)) return s;   // 예전 항목(비밀번호) — 그대로
    const a = resolveOsAuth(s);
    if (!a.ok) return { ...s, password: '', authError: a.error, authErrorCode: a.code };
    return { ...s, username: a.username, password: a.password, ...(a.privateKey ? { privateKey: a.privateKey, passphrase: a.passphrase, keyFingerprint: a.keyFingerprint } : {}) };
  });
}

/** 서버 목록 화면용 — 인증 방식 표시(비밀 없음). */
export function authLabelOf(server = {}) {
  if (t(server.keyRef)) { const k = KS.keyById(server.keyRef); return { kind: 'key', name: k ? k.name : '', fingerprint: k ? k.fingerprint : '', missing: !k }; }
  if (t(server.credRef)) { const a = KS.accountById(server.credRef); return { kind: 'account', name: a ? a.name : '', missing: !a, keyName: a && a.keyRef ? (KS.keyById(a.keyRef)?.name || '') : '' }; }
  return { kind: server.password || server.hasPassword ? 'password' : 'none' };
}
