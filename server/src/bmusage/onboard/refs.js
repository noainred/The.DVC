/**
 * bmusage/onboard/refs.js — SSH 키 저장소 ↔ OS 계정 등록부(bm-storage.json) 연결(7b단계 · 설계 PROFILES §18).
 *
 *  · 사용처 수(쓰는 서버 · 계정) — 등록부를 못 읽으면 **모름(null)** 이고 삭제를 막는다(0 으로 지어내 지우지 않는다).
 *  · 회전: 새 키 등록(현장이 authorized_keys 에 배포 — 포탈은 서버에 키를 넣지 않는다) → 참조 교체(등록부 먼저 · 계정 다음 · 옛 키 퇴역)
 *    → 바뀐 서버 목록을 돌려준다(화면이 '전 서버 재시험' 을 권한다 — 자동 재시험 · 자동 재시도 없음).
 *  · 접속 자격 해석 `resolveOsAuth` — 폴러 · 연결 시험이 같은 하나를 쓴다(판정 코어 하나).
 *    순서: 서버 keyRef → 공통 계정(credRef)의 기본 키 → 공통 계정 비밀번호 → 서버 비밀번호. 키 참조가 있는데 키가 없으면 **비밀번호로 몰래 넘어가지 않고** 오류다.
 */
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { listBmServersRaw, registryLoadError, bmServerRefCounts, replaceBmServerKeyRefs } from '../../bmstor/registry.js';
import { loadRegistry as loadIdracRegistry, registryLoadError as idracLoadError } from '../../idrac/registry.js';
import * as KS from './keyStore.js';
import { stopMatch } from '../../sshaccess/state.js';   // v3.9.0: 긴급 조치 ‘이 법인 키 사용 중지’(상태 파일 — 못 읽으면 키 접속을 멈춘다)
import { addrKey } from './bindRule.js';
import { parsePrivateKey } from './keyParse.js';
import { sshHostKeyFingerprint } from '../../proxy/sshExec.js';

const t = (v) => String(v ?? '').trim();

/** 키 · 계정별 사용처 수. 등록부를 못 읽으면 null(모름). */
export function refUsage() {
  let regOk = true;
  let counts = { byKey: new Map(), byAcc: new Map() };
  try { if (registryLoadError()) regOk = false; else counts = bmServerRefCounts(); } catch { regOk = false; }
  const accKey = new Map();
  const accs = KS.listAccountsRaw();
  for (const a of accs) if (a.keyRef) accKey.set(a.keyRef, (accKey.get(a.keyRef) || 0) + 1);
  // iDRAC 공통 계정 = 복사 방식 — 사본을 둔 iDRAC 항목(지금도 있는 id)을 센다. iDRAC 등록부를 못 읽으면 모름(null) — 7b 반증 F15.
  let idrIds = null;
  try { if (!idracLoadError()) idrIds = new Set(loadIdracRegistry().map((x) => String(x.id))); } catch { idrIds = null; }
  const byId = new Map(accs.map((a) => [a.id, a]));
  return {
    known: regOk,
    key: (id) => ({ servers: regOk ? (counts.byKey.get(id) || 0) : null, accounts: accKey.get(id) || 0 }),
    account: (id) => {
      const a = byId.get(id);
      if (a && a.kind === 'idrac') return { servers: idrIds ? (a.copies || []).filter((x) => idrIds.has(x)).length : null };
      return { servers: regOk ? (counts.byAcc.get(id) || 0) : null };
    },
  };
}

/**
 * @param {{scoped?:boolean}} o  scoped — 범위 계정(감사 L-7): 키는 법인 축이 없어 전 함대 목록이 된다 → 이름 · 사용처 · 등록자를 주지 않는다
 *   (범위 계정은 저장 비밀을 주소에 묶을 수 없다 — 설정 소유자 등급 전용이라 목록이 필요 없다).
 */
export function listKeysView({ now = Date.now(), scoped = false } = {}) {
  if (scoped) return { keys: [], usageKnown: null, hidden: 'scoped' };
  const u = refUsage();
  return { keys: KS.listKeysRaw().map((k) => KS.publicKeyView(k, { usage: u.key(k.id), now })), usageKnown: u.known };
}
/**
 * @param {(corp:string)=>boolean} [visible] 범위 계정이 볼 수 있는 법인인가
 * @param {boolean} [scoped] 범위 계정 — 자기 조회 범위 법인 소속 계정만(전 법인 공용 '' 은 빼고) · 사용처 수는 주지 않는다(법인을 가로지른다 — L-7)
 */
export function listAccountsView({ visible = null, scoped = false } = {}) {
  const u = refUsage();
  const list = KS.listAccountsRaw().filter((a) => (scoped ? !!a.corp && typeof visible === 'function' && visible(a.corp) : (!a.corp || typeof visible !== 'function' || visible(a.corp))));
  return { accounts: list.map((a) => KS.publicAccountView(a, { usage: scoped ? null : u.account(a.id) })), usageKnown: scoped ? null : u.known };
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
  if (u.servers == null) return { ok: false, code: 'usage-unknown', status: 503, reason: '등록부를 읽지 못해 이 계정을 쓰는 서버 수를 모릅니다 — 삭제하지 않았습니다.' };
  if (u.servers > 0) return { ok: false, code: 'in-use', status: 409, reason: a.kind === 'idrac' ? `iDRAC ${u.servers}대에 이 계정 비밀번호 사본이 있어 지울 수 없습니다 — 그 항목의 계정을 바꾼 뒤 지우세요.` : `이 계정을 쓰는 서버 ${u.servers}대가 있어 지울 수 없습니다.` };
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
  if (to.status !== 'active') return { ok: false, code: to.status === 'pending' ? 'key-pending' : 'retired', reason: to.status === 'pending' ? '새 키가 두 사람 승인을 기다리는 중입니다 — 승인된 뒤 교체하세요.' : '새 키가 퇴역 상태입니다.' };
  const unread = KS.keyStoreLoadError();
  if (unread) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못해 회전하지 않았습니다.' };
  // v3.9.0(점검 B-4): 새 키의 폴더가 옛 키를 쓰는 서버 · 공통 계정을 덮는지 — 아니면 회전 뒤 수집이 key-folder 로 끊긴다. 쓰기 전에 거절한다.
  const conflicts = placementConflicts(to, { serversUsing: (s) => t(s.keyRef) === from.id, accountsUsing: (a) => a.keyRef === from.id });
  if (conflicts === null) return { ok: false, code: 'usage-unknown', status: 503, reason: 'OS 계정 등록부를 읽지 못해 회전하지 않았습니다.' };
  if (conflicts.length) return { ok: false, code: 'folder-conflict', status: 409, reason: `새 키의 폴더 밖인 곳 ${conflicts.length}개가 옛 키를 씁니다 — 새 키의 폴더를 맞춘 뒤 회전하세요.`, conflicts: conflicts.slice(0, 50) };
  const r1 = replaceBmServerKeyRefs(from.id, to.id);
  if (!r1.ok) return { ...r1, status: 503 };
  const r2 = KS.replaceAccountKeyRefs(from.id, to.id, { now });
  if (!r2.ok) return { ...r2, partial: { servers: r1.ids } };
  const r3 = KS.markKeyRetired(from.id, { now });
  if (!r3.ok) return { ...r3, partial: { servers: r1.ids, accounts: r2.changed } };
  return { ok: true, servers: r1.ids, accounts: r2.changed || 0 };
}

/**
 * 키 `key`(폴더)가 지금 쓰는 곳을 덮는가 — 덮지 못하는 서버 · 공통 계정 목록. 등록부를 못 읽으면 null(모름).
 * 판정은 keyPlacementIssue 하나(기능은 보지 않는다 — 폴더만). 서버별 폴더 키는 공통 계정의 기본 키가 될 수 없다.
 */
export function placementConflicts(key, { serversUsing = () => false, accountsUsing = () => false } = {}) {
  let servers;
  try { if (registryLoadError()) return null; servers = listBmServersRaw(); } catch { return null; }
  const probe = { folderCorp: key.folderCorp || '', folderServer: key.folderServer || '', features: null };
  const out = [];
  for (const s of servers) if (serversUsing(s) && keyPlacementIssue(probe, s, 'conn-test')) out.push({ kind: 'server', name: s.name || s.host, corp: t(s.vcenterId) });
  for (const a of KS.listAccountsRaw()) {
    if (a.kind !== 'os' || !accountsUsing(a)) continue;
    if (probe.folderServer) out.push({ kind: 'account', name: a.name, corp: a.corp, why: 'server-folder' });
    else if (probe.folderCorp && a.corp !== probe.folderCorp) out.push({ kind: 'account', name: a.name, corp: a.corp, why: 'other-corp' });
  }
  return out;
}

/** 접속 자격 해석 오류 문구(화면 · 수집 오류 · 연결 시험 공용). */
export const AUTH_ERROR = Object.freeze({
  'key-missing': 'SSH 키 참조가 가리키는 키가 키 저장소에 없습니다(삭제됨) — 서버 설정에서 키를 다시 고르세요.',
  'key-unreadable': 'SSH 키를 열지 못했습니다(봉인 해제 실패 — 자격증명 저장 방식이 바뀌었을 수 있음) — 키를 다시 등록하세요.',
  'key-retired': '회전으로 퇴역한 SSH 키를 가리킵니다 — 퇴역 키로는 접속하지 않습니다. 서버 설정에서 새 키를 고르세요.',
  'key-pending': '이 SSH 키는 다른 설정 소유자의 승인을 기다리고 있습니다 — 승인되기 전에는 접속에 쓰지 않습니다(설정 › 보안 › SSH 공용 접속 › 키 보안).',
  'key-parse': 'SSH 키를 풀지 못했습니다(passphrase 불일치 또는 형식) — 키를 다시 등록하세요.',
  'account-missing': '공통 계정 참조가 가리키는 계정이 없습니다(삭제됨) — 서버 설정에서 계정을 다시 고르세요.',
  'account-kind': '공통 계정 참조가 OS 계정이 아닙니다.',
  'store-unreadable': 'SSH 키 저장소(ssh-keys.json)를 읽지 못해 키로 접속하지 않았습니다.',
  // v3.9.0 SSH 공용 접속(설계 docs/design/ssh-access §8 · §9)
  'account-tampered': '공통 계정(계정명 · 법인 · 기본 키 · 비밀번호)이 포탈 밖에서 바뀌었습니다 — 이 계정으로는 접속하지 않습니다. 설정 › 보안 › SSH 공용 접속 › 키 보안을 확인하세요.',
  'key-tampered': 'SSH 키 원문의 지문이 등록 때와 다릅니다(바꿔치기 의심) — 이 키로는 접속하지 않습니다. 설정 › 보안 › SSH 공용 접속 › 키 보안을 확인하고 키를 새로 등록하세요.',
  'key-folder': 'SSH 키가 다른 법인 · 다른 서버의 폴더에 있어 이 서버에는 쓰지 않습니다 — 설정 › 보안 › SSH 공용 접속에서 이 서버의 폴더에 있는 키를 고르세요.',
  'key-feature': '이 SSH 키는 이 기능에 허용되지 않았습니다 — 설정 › 보안 › SSH 공용 접속 › 키 폴더에서 키의 ‘쓸 수 있는 기능’ 을 확인하세요.',
  'corp-stopped': '이 법인의 SSH 키 사용이 중지됐습니다(긴급 조치) — 설정 › 보안 › SSH 공용 접속에서 재개하기 전에는 키로 접속하지 않습니다.',
  'state-unreadable': 'SSH 공용 접속 상태 파일(ssh-access-state.json)을 읽지 못해 키로 접속하지 않았습니다 — 사용 중지 기록을 모르는 채 키를 쓰지 않습니다.',
});
/** 허용 기능 목록과 무관하게 언제나 되는 쓰임 — 사람이 누르는 연결 시험(uname 한 줄). 그 밖의 호출은 기능 id 를 밝혀야 한다(빈 값 = 모르는 기능 — 목록이 있는 키는 거절). */
export const ALWAYS_ALLOWED_FEATURES = Object.freeze(['conn-test']);
/**
 * 키를 이 서버 · 이 기능에 써도 되는가(판정 하나 — 폴러 · 연결 시험 · SSH 공용 접속 화면의 키 고르기가 같은 함수).
 * @param {{folderCorp?:string, folderServer?:string, features?:string[]|null}} key
 * @param {{vcenterId?:string, name?:string}} server
 * @returns {null | 'key-folder' | 'key-feature'}
 */
export function keyPlacementIssue(key = {}, server = {}, feature = '') {
  const kc = t(key.folderCorp); const ks = t(key.folderServer);
  if (kc) {
    if (t(server.vcenterId) !== kc) return 'key-folder';
    if (ks && ks.toLowerCase() !== t(server.name).toLowerCase()) return 'key-folder';
  }
  if (Array.isArray(key.features) && !ALWAYS_ALLOWED_FEATURES.includes(feature) && !key.features.includes(feature)) return 'key-feature';
  return null;
}
/**
 * 법인 사용 중지 판정 — 서버 법인 · 공통 계정 법인 · 키 폴더 법인 중 하나라도 멈췄거나, 중지할 때 적어 둔 서버(id · 접속처)이면.
 * 법인 칸만 보면 OTP 없이 칸을 비워 빠져나갈 수 있었다(점검 A-4). 상태 파일을 못 읽으면 멈춘 것으로 본다.
 */
function stopIssue(corps, server, username) {
  const s = stopMatch({ corps: corps.map((x) => t(x)).filter(Boolean), serverId: t(server.id), addr: t(server.host) ? addrKey(server.host, server.port, username) : '', serverCorp: t(server.vcenterId) });
  if (s?.unreadable) return 'state-unreadable';
  return s ? 'corp-stopped' : null;
}

/*
 * v3.9.0(점검 A-7 · C-8 · D-1): **첫 사용 때 키 원문과 지문을 대조**한다 — 저장소의 지문 칸과 원문이 다르면(누군가 원문만 바꿈) 그 키로 접속하지 않는다.
 * 프로세스마다 원문 해시 하나에 한 번(passphrase 키는 접속용으로 이미 푼 객체를 쓴다 — bcrypt 를 두 번 돌리지 않는다).
 * 주기 점검(sshaccess/check.js)은 따로 ‘디스크 파일이 포탈이 마지막으로 쓴 내용과 다른가’ 를 본다.
 */
const _verified = new Set();
export function _resetVerifiedForTest() { _verified.clear(); }
function contentKey(m) { return crypto.createHash('sha256').update(m.privateKey).update('\0').update(m.passphrase || '').digest('hex'); }
function integrityOk(m, parsed) {
  const ck = contentKey(m);
  if (_verified.has(ck)) return true;
  let fp = '';
  if (parsed && typeof parsed === 'object' && typeof parsed.getPublicSSH === 'function') { try { fp = sshHostKeyFingerprint(parsed.getPublicSSH()) || ''; } catch { fp = ''; } }
  else { const p = parsePrivateKey(m.privateKey, m.passphrase || ''); fp = p.ok ? p.fingerprint : ''; }
  if (!fp || fp !== m.fingerprint) { KS.markKeyIntegrity(m.id, false); return false; }
  if (_verified.size > 1000) _verified.clear();
  _verified.add(ck);
  return true;
}

/**
 * OS 등록 항목 → 접속 자격(폴러 · 연결 시험 공용). 원본(비밀 포함)을 받아 원본을 돌려준다 — **응답에 싣지 말 것**.
 * @returns {{ok:true, username:string, password:string, privateKey?:string, passphrase?:string, authKind:'key'|'password'|'none', keyFingerprint?:string, keyName?:string}
 *          | {ok:false, code:string, error:string}}
 */
export function resolveOsAuth(server = {}, { feature = '' } = {}) {
  const keyRef = t(server.keyRef);
  const credRef = t(server.credRef);
  const needStore = !!(keyRef || credRef);
  if (needStore && KS.keyStoreLoadError()) return { ok: false, code: 'store-unreadable', error: AUTH_ERROR['store-unreadable'] };
  let acc = null;
  if (credRef) {
    acc = KS.accountById(credRef);
    if (!acc) return { ok: false, code: 'account-missing', error: AUTH_ERROR['account-missing'] };
    if (acc.kind !== 'os') return { ok: false, code: 'account-kind', error: AUTH_ERROR['account-kind'] };
    if (KS.isAccountTampered(acc.id)) return { ok: false, code: 'account-tampered', error: AUTH_ERROR['account-tampered'] };
  }
  // 7b 반증 F19: 공통 계정을 쓰면 접속 계정명도 **공통 계정 쪽**(서버 칸은 '개별' 일 때만) — 서버 칸 기본값 root 로 공통 비밀번호를 보내지 않게.
  const username = (acc ? acc.username : '') || t(server.username) || 'root';
  // osAuth 'password' = 비밀번호 고정(공통 계정에 기본 키가 있어도 — CSV os_key ‘password’).
  const useKey = server.osAuth === 'password' ? '' : (keyRef || (acc && acc.keyRef) || '');
  if (useKey) {
    const m = KS.keyMaterial(useKey);
    if (!m.ok) return { ok: false, code: m.code, error: AUTH_ERROR[m.code] || AUTH_ERROR['key-missing'] };
    // v3.9.0: 사용 중지 → 폴더 → 허용 기능 순(사용 중지가 가장 강하다 — 다른 사유보다 먼저 말한다).
    //   실패에도 키 지문을 싣는다 — 폴러의 인증 정지 기록(authCredOf)이 같은 자격으로 남아, 재개 뒤 이미 거부된 키로 다시 로그인하지 않게(점검 B-6).
    const si = stopIssue([server.vcenterId, acc?.corp, m.folderCorp], server, username);
    if (si) return { ok: false, code: si, error: AUTH_ERROR[si], keyFingerprint: m.fingerprint };
    const pi = keyPlacementIssue(m, server, t(feature));
    if (pi) return { ok: false, code: pi, error: AUTH_ERROR[pi], keyFingerprint: m.fingerprint };
    // 감사 M-5: passphrase 가 있는 키(OpenSSH bcrypt — 실측 16라운드 약 175ms · 동기)는 접속마다 풀면 1,000대 주기에 이벤트 루프가 수 분 막힌다
    //   → 한 번 푼 ssh2 키 객체를 메모리에 둔다(지문 + 원문 해시 열쇠 — 키를 바꾸면 열쇠가 바뀐다). 디스크의 봉인 원문은 그대로다.
    const pk = m.passphrase ? parsedKeyFor(m) : m.privateKey;
    if (!pk) return { ok: false, code: 'key-parse', error: AUTH_ERROR['key-parse'] };
    if (!integrityOk(m, m.passphrase ? pk : null)) return { ok: false, code: 'key-tampered', error: AUTH_ERROR['key-tampered'], keyFingerprint: m.fingerprint };
    // 키 인증일 때 비밀번호는 보내지 않는다(인증 방식을 하나로 — 키가 거부되면 비밀번호로 몰래 넘어가지 않는다).
    return { ok: true, username, password: '', privateKey: pk, passphrase: m.passphrase && typeof pk === 'string' ? m.passphrase : '', authKind: 'key', keyFingerprint: m.fingerprint, keyName: m.name, keyId: m.id };
  }
  if (acc && acc.password) return { ok: true, username, password: acc.password, authKind: 'password' };
  const pw = typeof server.password === 'string' ? server.password : '';
  return { ok: true, username, password: pw, authKind: pw ? 'password' : 'none' };
}

/* 감사 M-5 — 암호화 키 파싱 결과 캐시(메모리 · 상한 256). 값은 ssh2 키 객체(복호된 개인키 — resolveOsAuth 가 원문을 메모리에 두는 것과 같은 범위). */
const _parsed = new Map();
const PARSED_MAX = 256;
let _parseCount = 0;
export function _parsedKeyStats() { return { size: _parsed.size, parses: _parseCount }; }
export function _resetParsedKeysForTest() { _parsed.clear(); _parseCount = 0; }
function parsedKeyFor(m) {
  const k = `${m.fingerprint}|${crypto.createHash('sha256').update(m.privateKey).update('\0').update(m.passphrase).digest('hex')}`;
  const hit = _parsed.get(k);
  if (hit) { _parsed.delete(k); _parsed.set(k, hit); return hit; }
  let p;
  try { _parseCount += 1; p = ssh2.utils.parseKey(m.privateKey, m.passphrase); } catch { p = null; }
  if (!p || p instanceof Error) return null;
  if (Array.isArray(p)) p = p[0];
  if (_parsed.size >= PARSED_MAX) _parsed.delete(_parsed.keys().next().value);
  _parsed.set(k, p);
  return p;
}

/**
 * 인증 정지(authGuard) 판정용 자격 지문 — 해석 **뒤**의 자격으로(키 = 'key:<지문>', 비밀번호 = 해석된 비밀번호). bmusage · bmstor 폴러가 같은 하나를 쓴다(7b 반증 F2 —
 * bmstor 가 해석 전 원본으로 판정해 키 회전 · 공통 계정 비밀번호 변경 뒤에도 정지가 풀리지 않았다).
 */
export function authCredOf(s = {}) {
  return { id: s.id, name: s.name, host: s.host, username: s.username, password: s.keyFingerprint ? `key:${s.keyFingerprint}` : (typeof s.password === 'string' ? s.password : '') };
}

/**
 * 폴러용 — OS 등록부 원본에 해석한 자격을 덧씌운다(원본 객체는 바꾸지 않는다). 해석 실패 항목은 authError 를 달아
 * 수집이 접속하지 않고 그 사유로 실패하게 한다(빈 비밀번호로 시도해 인증 실패 · 계정 잠금을 부르지 않게).
 */
export function withResolvedAuth(list = [], { feature = '' } = {}) {
  return (Array.isArray(list) ? list : []).map((s) => {
    if (!s || typeof s !== 'object') return s;
    if (!t(s.keyRef) && !t(s.credRef)) return s;   // 예전 항목(비밀번호) — 그대로
    const a = resolveOsAuth(s, { feature });
    if (!a.ok) return { ...s, password: '', authError: a.error, authErrorCode: a.code, ...(a.keyFingerprint ? { keyFingerprint: a.keyFingerprint } : {}) };
    return { ...s, username: a.username, password: a.password, ...(a.privateKey ? { privateKey: a.privateKey, passphrase: a.passphrase, keyFingerprint: a.keyFingerprint, keyName: a.keyName } : {}) };
  });
}

/** 서버 목록 화면용 — 인증 방식 표시(비밀 없음). */
export function authLabelOf(server = {}) {
  if (t(server.keyRef)) { const k = KS.keyById(server.keyRef); return { kind: 'key', name: k ? k.name : '', fingerprint: k ? k.fingerprint : '', missing: !k }; }
  if (t(server.credRef)) { const a = KS.accountById(server.credRef); return { kind: 'account', name: a ? a.name : '', missing: !a, keyName: a && a.keyRef ? (KS.keyById(a.keyRef)?.name || '') : '' }; }
  return { kind: server.password || server.hasPassword ? 'password' : 'none' };
}
