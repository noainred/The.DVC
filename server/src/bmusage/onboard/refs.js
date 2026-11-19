/**
 * bmusage/onboard/refs.js — SSH 키 저장소 ↔ OS 계정 등록부(bm-storage.json) 연결(7b단계 · 설계 PROFILES §18).
 *
 *  · 사용처 수(쓰는 서버 · 계정) — 등록부를 못 읽으면 **모름(null)** 이고 삭제를 막는다(0 으로 지어내 지우지 않는다).
 *  · 회전: 새 키 등록(현장이 authorized_keys 에 배포 — 포탈은 서버에 키를 넣지 않는다) → 참조 교체(등록부 먼저 · 계정 다음 · 옛 키 퇴역)
 *    → 바뀐 서버 목록을 돌려준다(화면이 '전 서버 재시험' 을 권한다 — 자동 재시험 · 자동 재시도 없음).
 *  · 접속 자격 해석 `resolveOsAuth` — 폴러 · 연결 시험이 같은 하나를 쓴다(판정 코어 하나).
 *    순서: 서버 keyRef → 공통 계정(credRef)의 기본 키 → 공통 계정 비밀번호 → 서버 비밀번호. 키 참조가 있는데 키가 없으면 **비밀번호로 몰래 넘어가지 않고** 오류다.
 *    v3.24(서버 접속 — 설계 docs/design/server-access §4.6): 서버에 자기 자격이 **없고** 계층 지정 승인이 살아 있으면(registry.inheritActive)
 *    법인 › OS 종류 → 법인 순으로 가장 가까운 지정의 공통 계정을 쓴다(effectiveAccountOf 하나). 그 계정에도 법인 사용 중지 · 계정 단위 정지 · 허용 기능 · OS 계열을 본다.
 */
import { sshKdfRoundsIssue } from '../../util/sshKeyKdf.js';   // 21회차 L-6
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { listBmServersRaw, registryLoadError, bmServerRefCounts, replaceBmServerKeyRefs, inheritActive, hasOwnCred } from '../../bmstor/registry.js';
import { loadRegistry as loadIdracRegistry, registryLoadError as idracLoadError } from '../../idrac/registry.js';
import * as KS from './keyStore.js';
import { stopMatch, assignFor, accountStopFor, assignRefs } from '../../sshaccess/state.js';   // v3.9.0: 긴급 조치 ‘이 법인 키 사용 중지’(상태 파일 — 못 읽으면 키 접속을 멈춘다) · v3.24: 계층 지정 · 계정 단위 정지
import { addrKey } from './bindRule.js';
import { parsePrivateKey } from './keyParse.js';
import { sshHostKeyFingerprint } from '../../proxy/sshExec.js';
import { keyPlacementIssue, lostFeatures, featureLabels, keyShape, keyWriteIssue, accountCorpOk } from './placement.js';

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
// 79회차 반증(재현): 저장소를 못 읽은 동안(빈 캐시) 회전 · 삭제가 '키를 찾을 수 없습니다'(404)로 답했다 — 본인 OTP 를 쓰고 틀린 조치를 안내했다. 못 읽음을 먼저 본다.
const storeUnreadable = (what) => (KS.keyStoreLoadError() ? { ok: false, code: 'registry-unreadable', status: 503, reason: KS.keyStoreUnreadableReason(undefined, what) } : null);
export function deleteKeyIfUnused(id) {
  const u0 = storeUnreadable('지우지 않았습니다'); if (u0) return u0;
  const k = KS.keyById(id);
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  const u = refUsage().key(k.id);
  if (u.servers == null) return { ok: false, code: 'usage-unknown', status: 503, reason: 'OS 계정 등록부를 읽지 못해 이 키를 쓰는 서버 수를 모릅니다 — 삭제하지 않았습니다.' };
  if (u.servers > 0 || u.accounts > 0) return { ok: false, code: 'in-use', status: 409, reason: `이 키를 쓰는 서버 ${u.servers}대 · 공통 계정 ${u.accounts}개가 있어 지울 수 없습니다 — 회전으로 참조를 옮긴 뒤 지우세요.` };
  return KS._removeKey(k.id);
}

export function deleteAccountIfUnused(id) {
  const u0 = storeUnreadable('지우지 않았습니다'); if (u0) return u0;
  const a = KS.accountById(id);
  if (!a) return { ok: false, code: 'not-found', status: 404, reason: '공통 계정을 찾을 수 없습니다.' };
  const u = refUsage().account(a.id);
  if (u.servers == null) return { ok: false, code: 'usage-unknown', status: 503, reason: '등록부를 읽지 못해 이 계정을 쓰는 서버 수를 모릅니다 — 삭제하지 않았습니다.' };
  // v3.24: 계층 지정이 가리키는 계정은 지우지 않는다(지우면 물려받는 서버 전부가 account-missing 으로 끊긴다). 상태 파일을 못 읽으면 모름 — 지우지 않는다.
  if (a.kind === 'os') {
    const ar = assignRefs(a.id);
    if (ar == null) return { ok: false, code: 'usage-unknown', status: 503, reason: '서버 접속 상태 파일을 읽지 못해 이 계정을 가리키는 계층 지정을 모릅니다 — 삭제하지 않았습니다.' };
    if (ar.length) return { ok: false, code: 'in-use', status: 409, reason: `계층 지정 ${ar.length}곳(법인 · OS 종류)이 이 계정을 가리켜 지울 수 없습니다 — 그 지정을 먼저 바꾸세요.` };
  }
  if (u.servers > 0) return { ok: false, code: 'in-use', status: 409, reason: a.kind === 'idrac' ? `iDRAC ${u.servers}대에 이 계정 비밀번호 사본이 있어 지울 수 없습니다 — 그 항목의 계정을 바꾼 뒤 지우세요.` : `이 계정을 쓰는 서버 ${u.servers}대가 있어 지울 수 없습니다.` };
  return KS._removeAccount(a.id);
}

/**
 * 키 회전(참조 교체). 둘 다 있어야 하고 새 키는 활성이어야 한다. 순서: 서버 참조 → 계정 기본 키 → 옛 키 퇴역
 * (중간에 멈춰도 가리키는 키는 늘 존재한다 — 옛 키는 마지막에야 퇴역).
 * @returns {{ok:true, servers:string[], accounts:number, warnings?:{code:'key-feature', features:string[], text:string}[]} | {ok:false, ...}}
 */
export function rotateKey(fromId, toId, { now = Date.now() } = {}) {
  const u0 = storeUnreadable('회전하지 않았습니다'); if (u0) return u0;
  const from = KS.keyById(fromId); const to = KS.keyById(toId);
  if (!from || !to) return { ok: false, code: 'not-found', status: 404, reason: '옛 키 또는 새 키를 찾을 수 없습니다.' };
  if (from.id === to.id) return { ok: false, code: 'same-key', reason: '같은 키로는 회전할 수 없습니다.' };
  if (to.status !== 'active') return { ok: false, code: 'retired', reason: '새 키가 퇴역 상태입니다.' };
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
  // 4회차 점검 D1(메인 결정): 옛 키로 되던 수집 기능이 새 키의 ‘쓸 수 있는 기능’ 에 없으면 **경고**(기능 제한은 의도일 수 있다 — 회전은 막지 않는다).
  //   연결 시험(conn-test)은 허용 기능을 보지 않아 화면이 권하는 ‘전 서버 재시험’ 이 통과한다 — 그 차이를 결과가 말한다. 판정은 placement.lostFeatures(= keyPlacementIssue).
  const lost = (r1.ids.length || r2.changed) ? lostFeatures(from, to) : [];
  const warnings = lost.length ? [{ code: 'key-feature', features: lost, text: `새 키의 ‘쓸 수 있는 기능’ 에 ${featureLabels(lost)} 이(가) 없어 그 수집은 회전 뒤 이 키로 접속하지 않습니다(연결 시험은 이 제한을 보지 않아 통과합니다) — 의도한 제한이 아니면 설정 › 보안 › 서버 접속(SSH · Windows) › 키 폴더에서 새 키의 기능을 넓히세요.` }] : [];
  return { ok: true, servers: r1.ids, accounts: r2.changed || 0, ...(warnings.length ? { warnings } : {}) };
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

/**
 * 6회차 점검 A2: 공통 계정 저장(법인 · 기본 키 · 종류)이 **그 계정을 쓰는 서버(credRef)** 를 끊는가 — 쓰기 전 판정(라우트가 본인 OTP 앞에서 · 저장 직전에 한 번 더).
 *   예전에는 키 폴더 = 새 계정 법인이면 저장됐고(B-4), 그 계정을 쓰는 옛 법인 서버는 다음 주기부터 key-folder 로 접속하지 않았다
 *   (비밀번호만 쓰는 계정이면 옛 법인 서버가 다른 법인 계정 비밀번호로 접속했다 — 온보딩 분석은 cred-other-corp 로 거부하는 조합).
 *   서버마다(서버 키가 있거나 비밀번호 고정이면 계정 키를 쓰지 않는다 — resolveOsAuth 순서):
 *     ① 효력 키 폴더 — placement.keyWriteIssue(= keyPlacementIssue) 로 저장 전 · 뒤를 보고 **새로 어긋나는** 서버만 센다(이미 어긋나 있던 서버는 이 쓰기가 만든 문제가 아니다).
 *     ② 계정 법인 ↔ 서버 법인 — placement.accountCorpOk(온보딩 분석 cred-other-corp 와 같은 함수) · 같은 규칙으로 새로 어긋나는 서버만.
 *     ③ 종류 — OS 계정을 iDRAC 계정으로 바꾸면 쓰는 서버 전부가 account-kind 로 접속하지 않는다.
 *   등록부를 못 읽으면 모름 — 503(저장하지 않는다). 거부 문구에는 서버 · 키 이름을 싣지 않고 대수만.
 * @param {object|null} before  저장 전 계정 원본(새 계정이면 null — 쓰는 서버가 없다)
 * @param {{kind:string, corp:string, keyRef:string}} after  저장 뒤 모양(keyStore.saveAccount dryRun 의 next)
 * @returns {null | {ok:false, code:string, status:number, reason:string, servers?:object}}
 */
/**
 * v3.24 반증 F7: 옛 7b 계정 화면(POST /tools/bm-usage/accounts)으로 **계층 지정에 쓰이는 계정**의 비밀번호를 바꾸면 ‘한 대 먼저 확인’ 없이 판이 바뀌고
 *   계정 단위 정지도 풀린다(판에 걸린 정지) — 그런 계정의 새 비밀번호는 새 화면(설정 › 보안 › 서버 접속 › 공통 계정 — saveAccountChecked)에서만 받는다.
 *   상태 파일을 못 읽으면 모름 = 거절. 비밀번호를 바꾸지 않는 저장(이름 · 키 등)은 예전 그대로.
 */
export function legacyAccountWriteIssue(before, input = {}) {
  if (!before) return null;
  const pw = typeof input.password === 'string' && input.password !== '' && input.password !== '********';
  if (!pw) return null;
  const refs = assignRefs(before.id);
  if (refs === null) return { ok: false, code: 'usage-unknown', status: 503, reason: '서버 접속 상태 파일을 읽지 못해 이 계정이 계층 지정에 쓰이는지 모릅니다 — 비밀번호를 바꾸지 않았습니다.' };
  if (refs.length) return { ok: false, code: 'use-server-access', status: 409, reason: '이 공통 계정은 계층 지정(법인 › OS 종류)에 쓰이고 있습니다 — 새 비밀번호는 설정 › 보안 › 서버 접속 › 공통 계정에서 저장하세요(그 계정을 쓰는 서버 한 대로 먼저 확인합니다).' };
  return null;
}

export function accountUseIssue(before, after = {}) {
  if (!before || !before.id) return null;
  // v3.24: 계층 지정이 이 계정을 가리키면 — 종류 · OS 계열 · 법인을 바꿔 지정이 어긋나게 하지 않는다(물려받는 서버가 한꺼번에 끊기거나 다른 OS 로 비밀번호가 간다).
  if (before.kind === 'os') {
    const ar = assignRefs(before.id);
    if (ar == null) return { ok: false, code: 'usage-unknown', status: 503, reason: '서버 접속 상태 파일을 읽지 못해 이 계정을 가리키는 계층 지정을 모릅니다 — 저장하지 않았습니다.' };
    const fam = after.os === 'windows' ? 'windows' : 'linux';
    const bad = ar.filter((x) => after.kind !== 'os' || ((x.level === 'linux' || x.level === 'windows') && x.level !== fam)
      || (x.level === 'all' && KS.accountFamily(before) !== fam) || !accountCorpOk(after.corp, x.corp));
    if (bad.length) return { ok: false, code: 'assign-conflict', status: 409, reason: `계층 지정 ${bad.length}곳이 이 계정을 가리키는데 이 저장으로 종류 · OS · 법인이 어긋납니다 — 그 지정을 먼저 바꾸세요.` };
  }
  let servers;
  try { if (registryLoadError()) throw new Error('unread'); servers = listBmServersRaw(); }
  catch { return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 이 계정을 쓰는 서버를 모릅니다 — 저장하지 않았습니다.' }; }
  const using = servers.filter((s) => t(s.credRef) === before.id);
  if (!using.length) return null;
  const keyOf = (acc) => (acc && acc.kind === 'os' && t(acc.keyRef) ? keyShape(KS.keyById(acc.keyRef)) : null);
  const kBefore = keyOf(before); const kAfter = keyOf(after);
  const n = { kind: 0, keyFolder: 0, otherCorp: 0 };
  for (const s of using) {
    if (before.kind === 'os' && after.kind !== 'os') { n.kind += 1; continue; }
    const server = { vcenterId: t(s.vcenterId), name: t(s.name) };
    if (!accountCorpOk(after.corp, server.vcenterId) && accountCorpOk(before.corp, server.vcenterId)) n.otherCorp += 1;
    if (t(s.keyRef) || s.osAuth === 'password') continue;   // 계정 키를 쓰지 않는 서버
    if (keyWriteIssue(kAfter, server).folder && !keyWriteIssue(kBefore, server).folder) n.keyFolder += 1;
  }
  const parts = [];
  if (n.kind) parts.push(`${n.kind}대가 OS 계정이 아니게 되어 접속하지 못합니다`);
  if (n.keyFolder) parts.push(`${n.keyFolder}대가 바꾼 기본 키의 폴더(법인 · 서버) 밖이 됩니다`);
  if (n.otherCorp) parts.push(`${n.otherCorp}대가 다른 법인의 계정을 쓰게 됩니다`);
  if (!parts.length) return null;
  const code = n.kind ? 'account-kind' : (n.keyFolder ? 'key-folder' : 'cred-other-corp');
  return { ok: false, code, status: 409, reason: `이 계정을 쓰는 서버 중 ${parts.join(' · ')} — 저장하지 않았습니다. 그 서버들의 계정을 먼저 바꾸거나(서버 등록 · SSH 공용 접속) 같은 법인의 새 계정을 만드세요.`, servers: n };
}

/** 접속 자격 해석 오류 문구(화면 · 수집 오류 · 연결 시험 공용). */
export const AUTH_ERROR = Object.freeze({
  'key-missing': 'SSH 키 참조가 가리키는 키가 키 저장소에 없습니다(삭제됨) — 서버 설정에서 키를 다시 고르세요.',
  'key-unreadable': 'SSH 키를 열지 못했습니다(봉인 해제 실패 — 자격증명 저장 방식이 바뀌었을 수 있음) — 키를 다시 등록하세요.',
  'key-retired': '회전으로 퇴역한 SSH 키를 가리킵니다 — 퇴역 키로는 접속하지 않습니다. 서버 설정에서 새 키를 고르세요.',
  'key-parse': 'SSH 키를 풀지 못했습니다(passphrase 불일치 또는 형식) — 키를 다시 등록하세요.',
  'account-missing': '공통 계정 참조가 가리키는 계정이 없습니다(삭제됨) — 서버 설정에서 계정을 다시 고르세요.',
  'account-kind': '공통 계정 참조가 OS 계정이 아닙니다.',
  'store-unreadable': 'SSH 키 저장소(ssh-keys.json)를 읽지 못해 키로 접속하지 않았습니다.',
  // v3.9.0 SSH 공용 접속(설계 docs/design/ssh-access §8 · §9)
  'account-tampered': '공통 계정(계정명 · 법인 · 기본 키 · 비밀번호)이 포탈 밖에서 바뀌었습니다 — 이 계정으로는 접속하지 않습니다. 설정 › 보안 › 서버 접속(SSH · Windows) › 키 보안을 확인하세요.',
  'key-tampered': 'SSH 키 원문의 지문이 등록 때와 다릅니다(바꿔치기 의심) — 이 키로는 접속하지 않습니다. 설정 › 보안 › 서버 접속(SSH · Windows) › 키 보안을 확인하고 키를 새로 등록하세요.',
  'key-folder': 'SSH 키가 다른 법인 · 다른 서버의 폴더에 있어 이 서버에는 쓰지 않습니다 — 설정 › 보안 › 서버 접속(SSH · Windows)에서 이 서버의 폴더에 있는 키를 고르세요.',
  'key-feature': '이 SSH 키는 이 기능에 허용되지 않았습니다 — 설정 › 보안 › 서버 접속(SSH · Windows) › 키 폴더에서 키의 ‘쓸 수 있는 기능’ 을 확인하세요.',
  'corp-stopped': '이 법인의 SSH 키 사용이 중지됐습니다(긴급 조치) — 설정 › 보안 › 서버 접속(SSH · Windows)에서 재개하기 전에는 키로 접속하지 않습니다.',
  'state-unreadable': 'SSH 공용 접속 상태 파일(ssh-access-state.json)을 읽지 못해 키로 접속하지 않았습니다 — 사용 중지 기록을 모르는 채 키를 쓰지 않습니다.',
  // v3.24 서버 접속(설계 docs/design/server-access) — 공통 계정 · 계층 지정
  'account-state-unreadable': '서버 접속 상태 파일(ssh-access-state.json)을 읽지 못해 공통 계정으로 접속하지 않았습니다 — 계층 지정 · 정지 기록을 모르는 채 저장된 비밀번호를 보내지 않습니다.',
  'account-stopped': '이 공통 계정은 로그인 거부로 정지됐습니다(계정 잠금 방지 — 이 계정을 쓰는 서버 전부) — 설정 › 보안 › 서버 접속에서 비밀번호를 고치거나 ‘한 대로 다시 확인’ 을 하세요.',
  'account-corp-stopped': '이 법인의 저장 계정 · 키 사용이 중지됐습니다(긴급 조치) — 설정 › 보안 › 서버 접속에서 재개하기 전에는 공통 계정으로 접속하지 않습니다.',
  'account-feature': '이 공통 계정은 이 기능에 허용되지 않았습니다 — 설정 › 보안 › 서버 접속에서 계정의 ‘쓸 수 있는 기능’ 을 확인하세요.',
  'account-os': '공통 계정의 OS(Linux · Windows)가 서버의 OS 와 다릅니다 — 다른 OS 의 비밀번호를 보내지 않습니다. 서버의 OS 종류나 계정을 확인하세요.',
  'account-other-corp': '다른 법인의 공통 계정입니다 — 계층 지정으로는 다른 법인 계정을 물려받지 않습니다.',
});

/**
 * v3.24 — 서버의 **효력 공통 계정**이 어디서 오는가(판정 하나 — resolveOsAuth · 서버 접속 화면 · 법인 사용 중지가 같은 함수).
 *  · own — 서버에 자기 자격(공통 계정 credRef · 키 keyRef · 비밀번호)이 있다(‘따로 정함’ — 계층 지정을 보지 않는다). accountId 는 credRef(있으면).
 *  · os / corp — 승인된 서버가 법인 › OS 종류(os) 또는 법인(corp) 지정을 물려받는다. OS 미지정 서버는 OS 종류 단계를 건너뛴다.
 *    법인 단계 계정은 OS 계열이 같은 서버에만 닿는다(예전 계정 · 미지정 서버는 Linux 로 본다 — Windows 계정을 Linux 서버로 보내지 않게).
 *  · none — 없음. pending = 지정은 있는데 승인이 없거나 승인 뒤 주소 · 포트 · OS 가 바뀜(물려받지 않는다). mismatch = 법인 단계 계정의 OS 계열이 다르다.
 *  · 상태 파일을 못 읽으면 unreadable(승인된 서버만 — 호출부가 접속을 멈춘다).
 * @returns {{source:'own'|'os'|'corp'|'none', accountId?:string, level?:string, auth?:string, pending?:boolean, mismatch?:boolean, unreadable?:boolean}}
 */
export function effectiveAccountOf(server = {}) {
  if (t(server.credRef)) return { source: 'own', accountId: t(server.credRef) };
  if (hasOwnCred(server)) return { source: 'own' };
  const corp = t(server.vcenterId);
  if (!corp || t(server.agent)) return { source: 'none' };
  const active = inheritActive(server);
  const fam = server.os === 'windows' ? 'windows' : 'linux';
  let hit = null;
  if (server.os === 'linux' || server.os === 'windows') {
    const x = assignFor(corp, server.os);
    if (x?.unreadable) return active ? { source: 'none', unreadable: true } : { source: 'none' };
    if (x) hit = { ...x, level: server.os };
  }
  let mismatch = false;
  if (!hit) {
    const x = assignFor(corp, 'all');
    if (x?.unreadable) return active ? { source: 'none', unreadable: true } : { source: 'none' };
    if (x) {
      const a = KS.accountById(x.account);
      if (a && a.kind === 'os' && KS.accountFamily(a) !== fam) mismatch = true;
      else hit = { ...x, level: 'all' };
    }
  }
  if (!hit) return { source: 'none', ...(mismatch ? { mismatch: true } : {}) };
  if (!active) return { source: 'none', pending: true, level: hit.level, accountId: hit.account };
  return { source: hit.level === 'all' ? 'corp' : 'os', level: hit.level, accountId: hit.account, auth: hit.auth || '' };
}
/*
 * 키 배치 판정(keyPlacementIssue · ALWAYS_ALLOWED_FEATURES)은 순수 모듈 placement.js 로 옮겼다(4회차 점검 D1 — 온보딩 분석이 같은 함수를 직접 부른다).
 *   여기서 그대로 다시 내보낸다 — 기존 호출부(REFS.keyPlacementIssue · sshaccess)는 바뀌지 않는다. 판정은 여전히 하나다.
 */
export { ALWAYS_ALLOWED_FEATURES, keyPlacementIssue } from './placement.js';
import { ALWAYS_ALLOWED_FEATURES as ALWAYS_ALLOWED_FEATURES_LOCAL } from './placement.js';
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
export function resolveOsAuth(server = {}, { feature = '', ignoreAccountStop = false } = {}) {
  // ignoreAccountStop — ‘한 대로 다시 확인’(sshaccess/service.verifyAccount) 하나만: 계정 단위 정지를 푸는 확인 한 번은 정지를 넘어야 한다(사람이 누름 · 한 번 · 자동 재시도 없음).
  const keyRef = t(server.keyRef);
  let credRef = t(server.credRef);
  // v3.24: 자기 자격이 없는 승인된 서버 — 계층 지정의 공통 계정(effectiveAccountOf 하나).
  let inherited = null;
  if (!keyRef && !credRef && !hasOwnCred(server) && inheritActive(server)) {
    const ea = effectiveAccountOf(server);
    if (ea.unreadable) return { ok: false, code: 'account-state-unreadable', error: AUTH_ERROR['account-state-unreadable'] };
    if (ea.source === 'os' || ea.source === 'corp') { credRef = ea.accountId; inherited = ea; }
  }
  const needStore = !!(keyRef || credRef);
  if (needStore && KS.keyStoreLoadError()) return { ok: false, code: 'store-unreadable', error: AUTH_ERROR['store-unreadable'] };
  let acc = null;
  if (credRef) {
    acc = KS.accountById(credRef);
    if (!acc) return { ok: false, code: 'account-missing', error: AUTH_ERROR['account-missing'] };
    if (acc.kind !== 'os') return { ok: false, code: 'account-kind', error: AUTH_ERROR['account-kind'] };
    if (KS.isAccountTampered(acc.id)) return { ok: false, code: 'account-tampered', error: AUTH_ERROR['account-tampered'] };
    // v3.24: 서버 OS 를 정해 둔 경우 계정 OS 계열이 같아야 한다(예전 서버 · 계정은 칸이 비어 이 판정 밖 — 지금 쓰는 서버를 멈추지 않는다).
    if ((server.os === 'linux' || server.os === 'windows') && KS.accountFamily(acc) !== server.os) return { ok: false, code: 'account-os', error: AUTH_ERROR['account-os'] };
    // 계층 지정은 다른 법인 계정을 물려받지 않는다(지정 쓰기도 막는다 — 여기는 그 뒤 계정 법인을 바꾼 경우).
    if (inherited && !accountCorpOk(acc.corp, server.vcenterId)) return { ok: false, code: 'account-other-corp', error: AUTH_ERROR['account-other-corp'] };
    if (Array.isArray(acc.features) && !ALWAYS_ALLOWED_FEATURES_LOCAL.includes(feature) && !acc.features.includes(t(feature))) return { ok: false, code: 'account-feature', error: AUTH_ERROR['account-feature'] };
  }
  // 7b 반증 F19: 공통 계정을 쓰면 접속 계정명도 **공통 계정 쪽**(서버 칸은 '개별' 일 때만) — 서버 칸 기본값 root 로 공통 비밀번호를 보내지 않게.
  //   v3.24: Windows AD 계정은 도메인을 붙인 로그인 이름(keyStore.loginNameOf 하나).
  const username = (acc ? KS.loginNameOf(acc) : '') || t(server.username) || 'root';
  // osAuth 'password' = 비밀번호 고정(공통 계정에 기본 키가 있어도 — CSV os_key ‘password’). v3.24: 물려받은 지정의 auth 'password' 도 같다.
  const pwPinned = server.osAuth === 'password' || inherited?.auth === 'password';
  const useKey = pwPinned ? '' : (keyRef || (acc && acc.keyRef) || '');
  const accMeta = acc ? { accountId: acc.id, accountName: acc.name, source: inherited ? inherited.source : 'own' } : (inherited ? {} : { source: 'own' });
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
    return { ok: true, username, password: '', privateKey: pk, passphrase: m.passphrase && typeof pk === 'string' ? m.passphrase : '', authKind: 'key', keyFingerprint: m.fingerprint, keyName: m.name, keyId: m.id, ...accMeta };
  }
  if (acc && acc.password) {
    // v3.24: 공통 계정 비밀번호에도 법인 사용 중지(긴급 조치)와 계정 단위 정지(로그인 거부 한 번 — 그 비밀번호 판 동안)를 건다.
    //   상태 파일을 못 읽으면 정지 기록을 모른다 — 저장된 공통 비밀번호를 보내지 않는다(fail-closed · 키와 같은 규칙).
    const si = stopIssue([server.vcenterId, acc.corp], server, username);
    if (si === 'state-unreadable') return { ok: false, code: 'account-state-unreadable', error: AUTH_ERROR['account-state-unreadable'], ...accMeta };
    if (si) return { ok: false, code: 'account-corp-stopped', error: AUTH_ERROR['account-corp-stopped'], ...accMeta };
    const version = KS.accountSecretVersion(acc);
    const st = ignoreAccountStop ? null : accountStopFor(acc.id, version);
    if (st?.unreadable) return { ok: false, code: 'account-state-unreadable', error: AUTH_ERROR['account-state-unreadable'], ...accMeta };
    if (st) return { ok: false, code: 'account-stopped', error: AUTH_ERROR['account-stopped'], ...accMeta, stoppedAt: st.at, stoppedOn: st.server };
    return { ok: true, username, password: acc.password, authKind: 'password', ...accMeta, secretVersion: version };
  }
  if (inherited) return { ok: true, username, password: '', authKind: 'none', ...accMeta };
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
  if (sshKdfRoundsIssue(m.privateKey)) return null;   // 21회차 L-6: KDF 반복 상한
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
    // 예전 항목(서버 비밀번호) — 그대로. v3.24: 자기 자격이 없는 승인된 서버(계층 지정을 물려받음)는 해석한다.
    if (!t(s.keyRef) && !t(s.credRef) && (hasOwnCred(s) || !inheritActive(s))) return s;
    const a = resolveOsAuth(s, { feature });
    // v3.24: 공통 계정 출처(계정 id · 이름 · 비밀번호 판)를 싣는다 — 수집 결과를 본 곳이 계정 사용 기록 · 계정 단위 정지에 쓴다(sshaccess/outcome.js). 비밀은 아니다.
    const accOut = a.accountId ? { credAccountId: a.accountId, credAccountName: a.accountName || '', credSource: a.source || '', ...(a.secretVersion != null ? { credVersion: a.secretVersion } : {}) } : (a.source ? { credSource: a.source } : {});
    if (!a.ok) return { ...s, password: '', authError: a.error, authErrorCode: a.code, ...accOut, ...(a.keyFingerprint ? { keyFingerprint: a.keyFingerprint } : {}) };
    return { ...s, username: a.username, password: a.password, ...accOut, ...(a.privateKey ? { privateKey: a.privateKey, passphrase: a.passphrase, keyFingerprint: a.keyFingerprint, keyName: a.keyName } : {}) };
  });
}

/** 서버 목록 화면용 — 인증 방식 표시(비밀 없음). */
export function authLabelOf(server = {}) {
  if (t(server.keyRef)) { const k = KS.keyById(server.keyRef); return { kind: 'key', name: k ? k.name : '', fingerprint: k ? k.fingerprint : '', missing: !k }; }
  if (t(server.credRef)) { const a = KS.accountById(server.credRef); return { kind: 'account', name: a ? a.name : '', missing: !a, keyName: a && a.keyRef ? (KS.keyById(a.keyRef)?.name || '') : '' }; }
  return { kind: server.password || server.hasPassword ? 'password' : 'none' };
}
