/**
 * sshaccess/service.js — **SSH 공용 접속** 본체(v3.9.0 · 설계 docs/design/ssh-access · 시안 Ssh · SshKeys · SshPick · SshUse · SshSec).
 *
 * 새 저장소를 만들지 않는다 — 7b SSH 키 저장소(`bmusage/onboard/keyStore.js` · ssh-keys.json: 키 + 법인 공통 계정)와 OS 계정 등록부
 * (`bmstor/registry.js` · bm-storage.json: 서버마다 keyRef · credRef)가 원본이고, 이 모듈은 그 위에 ‘법인 › 공통 / 서버별’ 폴더 · 서버별 키 고르기 ·
 * 서버에 들어 있는 키 읽기 · 키 점검 · 받는 곳(inbox) · 법인 사용 중지 · 사용 기록을 얹는다.
 *
 * 불변조건(sshaccess/CLAUDE.md — 요약):
 *  · 라우트(`routes/api/sshAccess.js`)는 이 모듈만 부른다 — 접속 자격 원본(`resolveOsAuth` · `keyMaterial` · `listKeysRaw`)을 라우트가 만지지 않는다(7b 소스 스윕 ⑩ 과 같은 규칙).
 *  · 응답에는 지문 · 공개키 · 이름 · 사용처만. 개인키 · passphrase · 비밀번호 · 1회 비밀번호는 응답 · 감사 · 상태 파일 어디에도 싣지 않는다.
 *  · 접속 주소는 **저장값**(요청 host 를 받지 않는다 — v2.480). 한 번 · 짧은 시한 · 자동 재시도 없음(계정 잠금).
 *  · 서버 키 고르기 = 폴더 규칙(`refs.keyPlacementIssue`) → 등록부 `setBmServerKeyRef`(같은 접속처 · 키만) → 연결 확인 → 실패면 **이전 설정으로 되돌린다**
 *    (그 사이 접속처가 바뀌었으면 되돌리지 않는다 — 옛 키를 새 주소에 묶지 않게).
 */
import crypto from 'node:crypto';
import { store } from '../store.js';
import { config } from '../config.js';
import * as KS from '../bmusage/onboard/keyStore.js';
import * as REFS from '../bmusage/onboard/refs.js';
import { addrKey } from '../bmusage/onboard/bindRule.js';
import { RSA_MIN_BITS } from '../bmusage/onboard/keyParse.js';
import { listBmServersRaw, registryLoadError as bmRegistryLoadError, setBmServerKeyRef, restoreBmServerKeyRef, clearBmServerPassword } from '../bmstor/registry.js';
import { loadSecretsPolicy } from '../security/secretVault.js';
import * as ST from './state.js';
import * as INS from './installed.js';
import * as INB from './inbox.js';
import { noteKeyUse, keyUsageView, flushKeyUsage, lastUseByFingerprint, keyUsageLoadFailed } from './usage.js';
import { buildKeyCheck, checkKeyDrift } from './check.js';
import { READ_COMMAND, parseReadOutput } from './authorizedKeys.js';
import * as AP from '../approval/store.js';
import * as TP from '../approval/twoPerson.js';
import * as KL from './keyLogin.js';
import { twoPersonOn, serverRestrictOn, otherOwners, listedOtherOwners } from './guards.js';
import { startKeyNotify } from './notify.js';

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const lc = (v) => t(v).toLowerCase();
export const SCAN_EVERY_MS = 10 * 60_000;
const COLLECT = ['bm-usage', 'bm-storage'];

/** 기능 목록(화면 · 키의 ‘쓸 수 있는 기능’). id 는 keyStore.KEY_FEATURES 와 같다(테스트가 대조). ready:false = 아직 이 접속으로 붙는 곳이 없다(화면이 그렇게 말한다). */
export const FEATURE_CATALOG = Object.freeze([
  Object.freeze({ id: 'bm-usage', label: '베어메탈 사용률', tool: 'bm-usage', ready: true, note: 'CPU · 메모리 · 디스크 · 네트워크 · HBA 수집(집중 모니터링 · 저활용 포함)' }),
  Object.freeze({ id: 'bm-storage', label: '베어메탈 스토리지', tool: 'bm-storage', ready: true, note: '마운트 용량(df) 수집' }),
  Object.freeze({ id: 'disk-audit', label: '디스크 오류 이력 점검', tool: 'disk-audit', ready: false, note: '로그 · SMART · RAID 기록에서 매체 오류 흔적 찾기(읽기 전용) — 다음 단계에서 붙습니다' }),
]);

/** 이 노드가 아는 법인(vCenter) — id · 이름 · DataCenter 이름. */
export async function corpList() {
  const snap = store.get();
  let dcName = new Map(); let dcOf = () => '';
  try {
    const DC = await import('../datacenter/store.js');
    dcName = new Map((DC.listDatacenters() || []).map((d) => [String(d.id), String(d.name || d.id)]));
    dcOf = (id) => { try { return DC.datacenterOfVcenter(id) || ''; } catch { return ''; } };
  } catch { /* 법인 이름 없이 */ }
  return (snap?.vcenters || []).filter((v) => v && v.id).map((v) => ({ id: String(v.id), name: String(v.name || v.id), dc: dcName.get(String(dcOf(v.id))) || '' }));
}

/** 서버의 효력 키 id(서버 keyRef → 공통 계정 기본 키, 비밀번호 고정이면 없음). */
function effectiveKeyId(s, accById) {
  if (s.osAuth === 'password') return '';
  if (t(s.keyRef)) return t(s.keyRef);
  const a = t(s.credRef) ? accById.get(t(s.credRef)) : null;
  return a && a.kind === 'os' ? t(a.keyRef) : '';
}
/** 접속 계정 — resolveOsAuth 와 같은 규칙(공통 계정이 있으면 그 계정, 없으면 서버 칸 · root). */
const usernameOf = (s, acc) => (acc ? acc.username : (t(s.username) || 'root'));
/** 등록부 setBmServerKeyRef 의 expectAddr 와 같은 글자(서버 칸 username 기준 — 등록부가 그렇게 비교한다). */
const regAddrOf = (s) => addrKey(s.host, s.port, s.username);

function publicServer(s, { accById, keyById }) {
  const effKey = effectiveKeyId(s, accById);
  const key = effKey ? keyById.get(effKey) : null;
  const acc = t(s.credRef) ? accById.get(t(s.credRef)) : null;
  const inst = INS.installedOf(s.id);
  const placement = key ? REFS.keyPlacementIssue(key, s, 'conn-test') : null;
  return {
    id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, vcenterId: t(s.vcenterId), agent: t(s.agent), enabled: s.enabled !== false,
    username: usernameOf(s, acc), accountName: acc ? acc.name : '', accountMissing: !!t(s.credRef) && !acc,
    keyMode: t(s.keyRef) ? 'pinned' : (effKey ? 'corp-default' : (s.osAuth === 'password' || s.password || (acc && acc.password) ? 'password' : 'none')),
    keyId: effKey || '', keyName: key ? key.name : '', keyFingerprint: key ? key.fingerprint : '', keyMissing: !!effKey && !key,
    keyStatus: key ? key.status : '', keyFeatures: key ? (Array.isArray(key.features) ? [...key.features] : null) : null, placementIssue: placement || '',
    hasPassword: !!s.password, passwordPinned: s.osAuth === 'password',
    // 화면이 키 고르기 때 그대로 돌려보낸다(낡은 화면에서 고른 키를 바뀐 접속처에 묶지 않게 — 점검 A-8).
    addr: regAddrOf(s),
    installed: inst ? { at: inst.at, by: inst.by, present: !inst.error, error: inst.error || '', count: inst.keys.length,
      hasKey: !!(key && inst.keys.some((k) => k.fingerprint === key.fingerprint)),
      keyHasOptions: key && inst.keys.some((k) => k.fingerprint === key.fingerprint) ? inst.keys.filter((k) => k.fingerprint === key.fingerprint).every((k) => k.hasOptions === true) : null,
      stale: inst.host !== s.host || inst.port !== (Number(s.port) || 22) } : null,
  };
}

/** 화면 한 번에 필요한 것(비밀 없음). 등록부 · 저장소를 못 읽으면 그 칸에 unreadable 표지(빈 목록을 지어내지 않는다). */
export async function buildView({ now = Date.now() } = {}) {
  const corps = await corpList();
  const storeErr = KS.keyStoreLoadError();
  const regErr = bmRegistryLoadError();
  const keysRaw = storeErr ? [] : KS.listKeysRaw();
  const accRaw = storeErr ? [] : KS.listAccountsRaw();
  const keyById = new Map(keysRaw.map((k) => [k.id, k]));
  const accById = new Map(accRaw.map((a) => [a.id, a]));
  const servers = regErr ? [] : listBmServersRaw();
  const usage = REFS.refUsage();
  const lastUse = lastUseByFingerprint();
  let edgeRows = [];
  try { edgeRows = (await import('../bmusage/onboard/edgeDeploy.js')).allEdgeRows().map((r) => ({ agent: r.agent, name: t(r.name, 128), corp: t(r.corp, 128), osHost: t(r.osHost, 256), osCred: t(r.osCred, 64), osKey: t(r.osKey, 64), osUser: t(r.osUser, 128) })); } catch { edgeRows = []; }
  let policyMode = '';
  try { policyMode = loadSecretsPolicy()?.mode || ''; } catch { policyMode = ''; }
  const inbox = await INB.scanInbox({ corps, servers: servers.map((s) => ({ id: s.id, name: s.name || s.host, vcenterId: t(s.vcenterId) })) });
  const corpName = (id) => corps.find((c) => c.id === id)?.name || id || '전 법인';
  const pubServers = servers.filter((s) => !s.addrOnly).map((s) => ({ ...publicServer(s, { accById, keyById }), inboxPath: t(s.vcenterId) ? INB.inboxPathOf(s.vcenterId, s.name || s.host) : '' }));
  // 키 점검 ‘서버’ 칸 — 키를 쓰는데 폴더 · 기능 규칙 때문에 주기 수집이 막힌 서버, 법인이 없어 폴더 키를 못 쓰는 서버(엣지 위임 서버는 그 엣지가 본다).
  const keyed = pubServers.filter((s) => s.keyId && !s.agent);
  const serverSummary = regErr ? null : {
    blocked: keyed.filter((s) => s.placementIssue || (Array.isArray(s.keyFeatures) && !COLLECT.some((f) => s.keyFeatures.includes(f)))).map((s) => s.name),
    noCorp: keyed.filter((s) => !s.vcenterId).map((s) => s.name),
    // 서버에서 읽은 줄 가운데 이 서버가 쓰는 키의 줄에 제한(from= · 포워딩 금지)이 없는 서버 — 읽은 적 있는 서버만 센다(모르는 것을 ‘없음’ 으로 세지 않는다).
    unrestricted: keyed.filter((s) => s.installed && s.installed.hasKey && s.installed.keyHasOptions === false).map((s) => s.name),
  };
  const drift = storeErr ? null : checkKeyDrift({ now });
  return {
    at: now,
    isEdge: !!config.agent?.centralUrl,
    policyMode,
    scanEveryMinutes: Math.round(SCAN_EVERY_MS / 60_000), rsaMinBits: RSA_MIN_BITS,
    storeUnreadable: !!storeErr, registryUnreadable: !!regErr, stateUnreadable: !!ST.stateLoadError(),
    usageLoadFailed: keyUsageLoadFailed(), installedLoadFailed: INS.installedLoadFailed(),
    corps: corps.map((c) => ({ ...c, inboxPath: INB.inboxPathOf(c.id), stop: ST.stopFor(c.id) })),
    accounts: accRaw.filter((a) => a.kind === 'os').map((a) => KS.publicAccountView(a, { usage: usage.account(a.id) })),
    keys: keysRaw.map((k) => ({ ...KS.publicKeyView(k, { usage: usage.key(k.id), now }), lastUse: lastUse.get(k.fingerprint) || null,
      inboxPath: k.folderCorp ? INB.inboxPathOf(k.folderCorp, k.folderServer) : '' })),
    usageKnown: usage.known,
    servers: pubServers,
    edgeRows,
    features: FEATURE_CATALOG,
    inbox: { dir: inbox.dir, exists: inbox.exists, items: inbox.items, unknownFolders: inbox.unknownFolders, unknownTotal: inbox.unknownTotal, truncated: inbox.truncated, rootIsLink: inbox.rootIsLink },
    check: buildKeyCheck({ now, policyMode, inbox, drift, servers: serverSummary, corpName,
      guards: ST.getGuards(), pendingApprovals: AP.listRequests({ kinds: SSH_KINDS, includeDone: false }, { now }).length }),
    stops: ST.listStops(),
    events: ST.listEvents({ limit: 50 }),
    tampered: KS.tamperedKeyIds(),
    // v3.10.0 — 보호 장치 · 두 사람 승인
    guards: { ...ST.getGuards(), twoPersonActive: twoPersonOn() },
    approvalsUnreadable: !!AP.approvalsLoadError(),
    approvals: AP.listForView({ kinds: SSH_KINDS, doneLimit: 60 }, { now }).map((r) => ({ ...r, label: TP.kindLabel(r.kind) })),
    // 칸마다 마지막 키 작업(1시간 안) — 화면을 다시 열어도 진행 · 결과를 이어 본다(점검 E-2).
    jobs: KL.lastJobs(),
  };
}

/* ── 서버의 키 고르기(시안 ⑥ SshPick) ─────────────────────────────────── */

/**
 * @param {{serverId:string, keyId:string, expectAddr?:string, by:string}} o  keyId 빈 값 = 법인 기본 키(공통 계정)를 따름 · expectAddr = 화면이 본 접속처(publicServer.addr)
 * @returns {Promise<object>} { ok, test, previous? } — 실패면 code · reason · status · reverted · revertError
 */
export async function chooseServerKey({ serverId, keyId, expectAddr = null, by = '' } = {}) {
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못해 바꾸지 않았습니다.' };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 바꾸지 않았습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 키는 그 엣지 포탈의 SSH 공용 접속에서 고릅니다(키는 법인 밖으로 나가지 않습니다).' };
  // 화면이 본 접속처를 반드시 돌려받는다(빼고 부르면 확인을 건너뛰던 구멍 — 반증 D11).
  if (typeof expectAddr !== 'string' || !expectAddr) return { ok: false, code: 'need-addr', status: 400, reason: '화면에서 본 서버 접속처가 없습니다 — 화면을 다시 읽은 뒤 고르세요.' };
  const kid = t(keyId, 32);
  if (kid) {
    const k = KS.keyById(kid);
    if (!k) return { ok: false, code: 'key-missing', status: 404, reason: '키를 찾을 수 없습니다.' };
    if (k.status === 'pending') return { ok: false, code: 'key-pending', status: 409, reason: REFS.AUTH_ERROR['key-pending'] };
    if (k.status !== 'active') return { ok: false, code: 'key-retired', reason: '퇴역한 키는 고를 수 없습니다.' };
    if (KS.tamperedKeyIds().includes(k.id)) return { ok: false, code: 'key-tampered', status: 409, reason: REFS.AUTH_ERROR['key-tampered'] };
    const pi = REFS.keyPlacementIssue(k, s, 'conn-test');
    if (pi) return { ok: false, code: pi, status: 409, reason: REFS.AUTH_ERROR[pi] };
  } else if (!t(s.credRef)) {
    return { ok: false, code: 'no-account', status: 409, reason: '이 서버는 법인 공통 계정을 쓰지 않아 ‘법인 기본 키를 따름’ 을 고를 수 없습니다 — 키를 이름으로 고르세요.' };
  }
  const w = setBmServerKeyRef(s.id, kid, { expectAddr });
  if (!w.ok) return w;
  const after = listBmServersRaw().find((x) => x.id === s.id);
  const test = after ? await testServer(after, { by }) : { ok: false, kind: 'gone', reason: '서버가 그 사이 지워졌습니다.' };
  if (test.ok) return { ok: true, test, previous: w.previous };
  const back = restoreBmServerKeyRef(s.id, w.previous);
  // 되돌렸다고 말하지 않는다 — 못 되돌렸으면 그대로 밝힌다(점검 E-M5).
  return back.ok
    ? { ok: false, code: 'test-failed', status: 409, reason: `고른 키로 접속하지 못해 이전 설정으로 되돌렸습니다 — ${test.reason || test.kind}`, test, reverted: true }
    : { ok: false, code: 'test-failed', status: 409, reason: `고른 키로 접속하지 못했고 이전 설정으로 되돌리지도 못했습니다 — ${test.reason || test.kind}`, test, reverted: false, revertError: back.reason };
}

/** 저장된 항목으로 한 번 연결 시험(7b connTest 와 같은 본체) + 키 사용 기록. */
async function testServer(s, { by = '' } = {}) {
  const { testSavedOs } = await import('../bmusage/onboard/connTest.js');
  const r = await testSavedOs(s);
  const a = REFS.resolveOsAuth(s, { feature: 'conn-test' });
  if (a.ok && a.keyFingerprint) noteKeyUse({ fingerprint: a.keyFingerprint, keyName: a.keyName, server: s.name || s.host, corp: s.vcenterId, feature: 'conn-test', ok: !!r.ok, code: r.ok ? 'ok' : r.kind, trigger: 'manual', by });
  return r;
}

/**
 * 키 고르기 창의 후보 — 판정은 서버 하나(`refs.keyPlacementIssue` — 화면이 따로 판정하지 않는다).
 * 각 키: 고를 수 있는가(issue 없음 · 활성) · 폴더 종류(공통 / 서버별 / 미분류) · 이 서버에 들어 있는가(마지막으로 읽은 authorized_keys 기준 — 모르면 null).
 */
export function serverKeyCandidates(serverId) {
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못했습니다.' };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  const accById = new Map(KS.listAccountsRaw().map((a) => [a.id, a]));
  const acc = t(s.credRef) ? accById.get(t(s.credRef)) : null;
  const inst = INS.installedOf(s.id);
  const instFps = inst && !inst.error && inst.host === s.host ? new Set(inst.keys.map((k) => k.fingerprint)) : null;
  const effKey = effectiveKeyId(s, accById);
  const keysRaw = KS.listKeysRaw();
  const byFp = new Map(keysRaw.map((k) => [k.fingerprint, k]));
  const tampered = new Set(KS.tamperedKeyIds());
  const keys = keysRaw.map((k) => {
    const issue = k.status === 'pending' ? 'key-pending' : k.status !== 'active' ? 'key-retired' : (tampered.has(k.id) ? 'key-tampered' : (REFS.keyPlacementIssue(k, s, 'conn-test') || ''));
    return { id: k.id, name: k.name, algo: k.algo, bits: k.bits, fingerprint: k.fingerprint, status: k.status,
      folder: !k.folderCorp ? 'none' : (k.folderServer ? 'server' : 'common'), folderCorp: k.folderCorp, folderServer: k.folderServer,
      features: Array.isArray(k.features) ? [...k.features] : null, selectable: !issue, issue, current: k.id === effKey,
      installed: instFps ? instFps.has(k.fingerprint) : null };
  }).filter((k) => k.selectable || k.current || (k.folderCorp && k.folderCorp === t(s.vcenterId)));
  const order = { server: 0, common: 1, none: 2 };
  keys.sort((a, b) => (order[a.folder] - order[b.folder]) || a.name.localeCompare(b.name));
  return {
    ok: true,
    server: { id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, vcenterId: t(s.vcenterId), addr: regAddrOf(s), keyMode: t(s.keyRef) ? 'pinned' : (effKey ? 'corp-default' : 'other') },
    corpDefault: acc && acc.kind === 'os' ? { accountName: acc.name, username: acc.username, keyId: acc.keyRef || '', keyName: acc.keyRef ? (KS.keyById(acc.keyRef)?.name || '') : '' } : null,
    keys,
    installed: inst ? { at: inst.at, by: inst.by, file: inst.file, error: inst.error || '', stale: inst.host !== s.host,
      keys: inst.keys.map((k) => { const m = byFp.get(k.fingerprint); return { ...k, keyId: m ? m.id : '', keyName: m ? m.name : '' }; }) } : null,
  };
}

/* ── 서버에 들어 있는 키 읽기 ─────────────────────────────────────────── */

/**
 * 서버 계정의 authorized_keys 를 읽어 지문을 저장소의 키와 맞춘다. 접속은 저장된 자격(키 · 공통 계정 · 서버 비밀번호) 또는 이번 한 번만 쓰는 비밀번호.
 * 1회 비밀번호는 어디에도 저장하지 않는다.
 */
export async function readInstalledKeys({ serverId, oncePassword = '', by = '' } = {}) {
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 그 엣지 포탈에서 읽습니다.' };
  const once = typeof oncePassword === 'string' ? oncePassword : '';
  if (once.length > 1024) return { ok: false, code: 'bad-password', reason: '비밀번호가 너무 깁니다.' };
  let auth;
  if (once) {
    const r0 = REFS.resolveOsAuth({ ...s, keyRef: '', osAuth: 'password' }, { feature: 'conn-test' });
    auth = { username: r0.ok ? r0.username : (t(s.username) || 'root'), password: once, authKind: 'password-once' };
  } else {
    const r0 = REFS.resolveOsAuth(s, { feature: 'conn-test' });
    if (!r0.ok) return { ok: false, code: r0.code, status: 409, reason: r0.error };
    if (r0.authKind === 'none') return { ok: false, code: 'no-secret', status: 409, reason: '저장된 인증 수단이 없습니다 — 이번 한 번만 쓸 비밀번호를 넣으세요(저장하지 않습니다).' };
    auth = r0;
  }
  const { withSsh } = await import('../proxy/sshExec.js');
  const { isAuthFailureText, isPeerRejectText } = await import('../util/authGuard.js');
  let rec;
  try {
    const out = await withSsh({ host: String(s.host), port: Number(s.port) || 22, username: auth.username, password: auth.password || '', privateKey: auth.privateKey, passphrase: auth.passphrase, readyTimeout: 15_000,
      passwordOnly: true },   // 비밀번호는 password 방식으로 한 번만(점검 E-3 — 문구 ‘다시 시도하지 않습니다’ 와 맞춘다)
      async ({ exec }) => exec(READ_COMMAND, 15_000));
    const p = parseReadOutput(out?.stdout || '');
    if (!p.ok) rec = { host: s.host, port: Number(s.port) || 22, username: auth.username, file: '~/.ssh/authorized_keys', keys: [], error: p.reason };
    else rec = { host: s.host, port: Number(s.port) || 22, username: auth.username, file: '~/.ssh/authorized_keys', keys: p.keys, truncated: p.truncated, error: p.present ? '' : '파일이 없습니다(키가 하나도 없음).', bad: p.bad };
  } catch (e) {
    const msg = String(e?.message || e);
    const kind = isPeerRejectText(msg) ? 'hostkey' : isAuthFailureText(msg) ? 'auth-rejected' : 'connect';
    const reason = kind === 'hostkey' ? '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.'
      : kind === 'auth-rejected' ? '인증이 거부됐습니다(다시 시도하지 않습니다 — 계정 잠금 방지).' : `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 100)})`;
    if (auth.keyFingerprint) noteKeyUse({ fingerprint: auth.keyFingerprint, keyName: auth.keyName, server: s.name || s.host, corp: s.vcenterId, feature: 'conn-test', ok: false, code: kind, trigger: 'manual', by });
    return { ok: false, code: kind, status: 502, reason };
  }
  if (auth.keyFingerprint) noteKeyUse({ fingerprint: auth.keyFingerprint, keyName: auth.keyName, server: s.name || s.host, corp: s.vcenterId, feature: 'conn-test', ok: true, code: 'ok', trigger: 'manual', by });
  const saved = INS.noteInstalled(s.id, { ...rec, by: t(by, 64) });
  const byFp = new Map(KS.listKeysRaw().map((k) => [k.fingerprint, k]));
  return {
    ok: true, saved: !!saved.ok, file: rec.file, username: rec.username, error: rec.error || '', truncated: rec.truncated || 0, bad: rec.bad || 0, via: auth.authKind,
    keys: rec.keys.map((k) => { const m = byFp.get(k.fingerprint); return { ...k, keyId: m ? m.id : '', keyName: m ? m.name : '', keyStatus: m ? m.status : '' }; }),
  };
}

/* ── 키 폴더 · 허용 기능 ──────────────────────────────────────────────── */

/** 폴더(법인 · 서버)가 이 노드에 있는 것인가 — 법인은 vCenter id, 서버는 그 법인 소속 OS 등록 서버 이름. */
function folderTargetIssue(folderCorp, folderServer) {
  const c = t(folderCorp, 128); const sv = t(folderServer, 128);
  if (!c) return sv ? '서버별 폴더는 법인을 먼저 골라야 합니다.' : null;
  if (!(store.get()?.vcenters || []).some((v) => v && String(v.id) === c)) return '그런 법인(vCenter)이 없습니다.';
  if (!sv) return null;
  if (bmRegistryLoadError()) return 'OS 계정 등록부를 읽지 못해 서버 폴더를 확인하지 못했습니다.';
  if (!listBmServersRaw().some((x) => t(x.vcenterId) === c && lc(x.name || x.host) === lc(sv))) return '그 법인에 그런 이름의 서버가 없습니다(OS 등록부 기준).';
  return null;
}

/** 키 등록(폴더 · 허용 기능과 함께). 원문 판정 · 암호화 정책 · 봉인은 keyStore.addKey 그대로. */
export async function addKeyInFolder(body = {}, { by = '' } = {}) {
  const fi = folderTargetIssue(body.folderCorp, body.folderServer);
  if (fi) return { ok: false, code: 'bad-folder', reason: fi };
  return addKeyWithApproval({ name: body.name, privateKey: body.privateKey, passphrase: body.passphrase, rotateAt: body.rotateAt,
    folderCorp: t(body.folderCorp, 128), folderServer: t(body.folderServer, 128), features: body.features === undefined ? [] : body.features }, { by, how: '등록' });
}

/** 저장 항목 연결 시험(한 번). */
export async function testSavedServer({ serverId, by = '' } = {}) {
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 그 엣지 포탈에서 시험합니다.' };
  return testServer(s, { by });
}

/**
 * 폴더를 바꾸기 전에 지금 쓰는 곳이 새 폴더 밖이 되지 않는지 본다(밖이 되면 409 + 목록 — 수집이 조용히 끊기지 않게).
 * @param {{keyId:string, folderCorp?:string, folderServer?:string, features?:string[]|null}} o
 */
export function setKeyPlacement({ keyId, folderCorp, folderServer, features } = {}) {
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못했습니다.' };
  const k = KS.keyById(t(keyId, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  const nextCorp = folderCorp !== undefined ? t(folderCorp, 128) : k.folderCorp;
  const nextServer = folderServer !== undefined ? t(folderServer, 128) : (folderCorp !== undefined ? '' : k.folderServer);
  const accById = new Map(KS.listAccountsRaw().map((a) => [a.id, a]));
  if (folderCorp !== undefined || folderServer !== undefined) {
    const fi = folderTargetIssue(nextCorp, nextServer); if (fi) return { ok: false, code: 'bad-folder', reason: fi };
    // 충돌 판정은 refs.placementConflicts 하나(키 회전과 같은 함수 — 판정을 두 벌 두지 않는다).
    const conflicts = REFS.placementConflicts({ folderCorp: nextCorp, folderServer: nextServer }, { serversUsing: (s) => effectiveKeyId(s, accById) === k.id, accountsUsing: (a) => a.keyRef === k.id });
    if (conflicts === null) return { ok: false, code: 'usage-unknown', status: 503, reason: 'OS 계정 등록부를 읽지 못해 이 키를 쓰는 서버를 모릅니다 — 폴더를 바꾸지 않았습니다.' };
    if (conflicts.length) return { ok: false, code: 'folder-conflict', status: 409, reason: `이 키를 쓰는 곳 ${conflicts.length}개가 새 폴더 밖이 됩니다 — 그 서버 · 공통 계정의 키를 먼저 바꾸세요(서버별 폴더 키는 공통 계정의 기본 키가 될 수 없습니다).`, conflicts: conflicts.slice(0, 50) };
  }
  // 기능을 바꾸면 그 키를 쓰는 서버 수를 함께 돌려준다(화면이 ‘그 서버들의 그 기능 수집이 멈춘다’ 고 말한다 — 점검 E-M2).
  const affectedServers = features !== undefined && !bmRegistryLoadError() ? listBmServersRaw().filter((s) => effectiveKeyId(s, accById) === k.id).length : null;
  const r = KS.updateKeyPlacement(k.id, {
    ...(folderCorp !== undefined ? { folderCorp: nextCorp } : {}), ...(folderServer !== undefined || folderCorp !== undefined ? { folderServer: nextServer } : {}),
    ...(features !== undefined ? { features } : {}),
  });
  return r.ok && affectedServers != null ? { ...r, affectedServers } : r;
}

/** 키를 새로 받을 수 있는가(저장 방식) — 라우트가 OTP 를 쓰기 전에 본다(점검 B-5). null = 받을 수 있음. */
export function keyVaultIssue() { return KS.keyVaultIssue(); }

/* ── 받는 곳(inbox) ───────────────────────────────────────────────────── */

/**
 * 폴더 이름 → 법인 · 서버. **정확히 하나**일 때만(두 법인 · 두 서버가 같은 폴더 이름이면 모호로 거절 — 점검 C-13 · A-5).
 * 폴더는 파일이 놓인 자리에서 정한다(요청 본문이 아니다).
 */
async function folderOwner(slugs) {
  const corps = (await corpList()).filter((c) => INB.folderSlug(c.id) === slugs.corpSlug);
  if (corps.length !== 1) return corps.length
    ? { ok: false, code: 'ambiguous-folder', status: 409, reason: '두 법인이 같은 폴더 이름을 씁니다 — 승인하지 않았습니다.' }
    : { ok: false, code: 'unknown-folder', status: 409, reason: '폴더 이름이 지금 있는 법인과 맞지 않습니다.' };
  const corp = corps[0];
  if (!slugs.serverSlug) return { ok: true, corp, server: '' };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const srv = listBmServersRaw().filter((x) => t(x.vcenterId) === corp.id && INB.serverSlug(x.name || x.host) === slugs.serverSlug);
  if (srv.length !== 1) return srv.length
    ? { ok: false, code: 'ambiguous-folder', status: 409, reason: '그 법인의 두 서버가 같은 폴더 이름을 씁니다 — 승인하지 않았습니다.' }
    : { ok: false, code: 'unknown-folder', status: 409, reason: '폴더 이름이 그 법인의 서버와 맞지 않습니다.' };
  return { ok: true, corp, server: srv[0].name || srv[0].host };
}

/** 승인 — 다시 읽어 **사람이 본 파일(sha) · 지문과 같을 때만** 저장소에 넣고 평문 파일을 지운다(지울 때도 같은 파일인지 다시 본다). */
export async function approveInbox({ relPath, fingerprint = '', sha = '', name, passphrase = '', features, by = '' } = {}) {
  const slugs = INB.slugsOf(relPath);
  if (!slugs) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다.' };
  const owner = await folderOwner(slugs);
  if (!owner.ok) return owner;
  const rd = INB.readForApproval(relPath, { expectSha: t(sha, 80), expectFingerprint: t(fingerprint, 80), passphrase });
  if (!rd.ok) return rd;
  const r = await addKeyWithApproval({ name, privateKey: rd.pem, passphrase, folderCorp: owner.corp.id, folderServer: owner.server, features: features === undefined ? [] : features }, { by, how: '받는 곳 승인' });
  if (!r.ok) return r;
  // 평문 파일은 봉인 저장에 들어간 즉시 지운다(두 사람 승인을 기다리는 동안 디스크에 평문을 두지 않는다 — 돌려보내지면 키도 함께 지워진다).
  const rm = INB.removeInboxFile(relPath, { expectSha: rd.sha });
  ST.addEvent({ kind: 'inbox-approved', corp: owner.corp.id, target: r.key.name, by, detail: `${r.key.fingerprint}${r.pending ? ' · 두 번째 승인 대기' : ''}${rm.ok ? '' : ' · 평문 파일 삭제 실패'}` });
  return { ...r, plaintextRemoved: !!rm.ok, ...(rm.ok ? {} : { plaintextLeft: true, removeError: rm.reason }) };
}

/** 지우기 — 사람이 본 파일(sha)과 같을 때만(그 사이 바뀐 파일을 보지 않고 지우지 않게 — 점검 C-6). */
export function discardInbox({ relPath, sha = '', by = '' } = {}) {
  const slugs = INB.slugsOf(relPath);
  if (!slugs) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다.' };
  const r = INB.removeInboxFile(relPath, { expectSha: t(sha, 80) });
  if (r.ok) ST.addEvent({ kind: 'inbox-discarded', target: t(relPath, 120), by });
  return r;
}

/* ── 법인 사용 중지 ───────────────────────────────────────────────────── */

/**
 * 사용 중지 — 지금 그 법인 서버의 id · 접속처를 함께 적는다(서버의 법인 칸을 비워 빠져나가지 못하게 — 점검 A-4 · B-1).
 * 등록부를 못 읽으면 법인만으로 건다(멈추는 쪽은 막지 않는다 — 응답이 그 사실을 밝힌다).
 */
export function stopCorp(corp, { by = '', reason = '' } = {}) {
  const c = t(corp, 128);
  const accById = new Map(KS.keyStoreLoadError() ? [] : KS.listAccountsRaw().map((a) => [a.id, a]));
  const regErr = bmRegistryLoadError();
  const corpServers = regErr ? [] : listBmServersRaw().filter((s) => t(s.vcenterId) === c);
  const servers = corpServers.map((s) => ({ id: s.id, addr: addrKey(s.host, s.port, usernameOf(s, t(s.credRef) ? accById.get(t(s.credRef)) : null)) }));
  const r = ST.setCorpStop(c, { by, reason, servers });
  // 엣지가 수집하는 서버는 그 엣지의 키로 접속한다 — 이 노드의 중지는 거기에 닿지 않는다(사실대로 따로 센다).
  const edgeServers = corpServers.filter((s) => t(s.agent)).length;
  return r.ok ? { ...r, servers: servers.length - edgeServers, edgeServers, ...(regErr ? { registryUnreadable: true } : {}) } : r;
}
/** 재개는 ‘다시 여는’ 방향 — 두 사람 승인(켜져 있을 때). 멈추기(stopCorp)는 본인 OTP 만으로 바로. */
export async function resumeCorp(corp, { by = '' } = {}) {
  const c = t(corp, 128);
  if (!ST.stopFor(c) || ST.stopFor(c).unreadable) return ST.clearCorpStop(c, { by });   // 중지 상태가 아니거나 상태 모름 — 저장소가 사유를 말한다
  // 요청을 **그때의 중지**(걸린 시각)에 묶는다 — 그 뒤 새 사건으로 다시 건 중지를 옛 재개 요청이 풀지 못하게(점검 A6 · C-6).
  return submitSsh({ kind: 'ssh-corp-resume', title: `법인 키 사용 재개 — ${c}`, target: c, corp: c, payload: { corp: c, stopAt: Number(ST.stopFor(c).at) || 0 }, by }, () => ST.clearCorpStop(c, { by }));
}

/* ── 손상 · 포탈 밖 변경 뒤 다시 읽기(설정 소유자 + OTP) ───────────────── */
export function reloadState({ by = '' } = {}) { return ST.reloadSshAccessState({ by }); }
/** 키 저장소 파일을 새 기준으로 — 바꿔치기 표지를 풀고 첫 사용 대조를 다시 하게 한다. */
export async function reloadKeyStore({ by = '' } = {}) {
  // 요청을 **그때의 디스크 내용**(sha256)에 묶는다 — 승인 직전에 파일을 또 바꿔 넣지 못하게(점검 A5).
  const sha = KS.diskFileSha();
  if (sha === null) return { ok: false, code: 'read-failed', status: 503, reason: '키 저장소 파일을 읽지 못했습니다.' };
  return submitSsh({ kind: 'ssh-keystore-reload', title: '키 저장소 다시 읽기 — 포탈 밖 변경 받아들이기', target: 'ssh-keys.json', payload: { sha }, by }, () => reloadKeyStoreNow({ by }));
}
function reloadKeyStoreNow({ by = '', expectSha } = {}) {
  const r = KS.reloadKeyStoreFromDisk({ expectSha });
  REFS._resetVerifiedForTest();
  _seenDrift = null;
  if (r.ok) ST.addEvent({ kind: 'keystore-reloaded', by, detail: `키 ${r.keys}개` });
  return r;
}

/* ── 두 사람 승인(v3.10.0 — approval/store · approval/twoPerson) ─────────────── */

/** 이 화면이 다루는 요청 종류. */
export const SSH_KINDS = Object.freeze(['ssh-key-activate', 'ssh-key-rotate', 'ssh-key-delete', 'ssh-corp-resume', 'ssh-keystore-reload', 'ssh-guard-change']);
TP.registerKind('ssh-key-activate', { label: '키 등록',
  run: (p) => KS.activateKey(p.keyId, { fingerprint: p.fingerprint }),
  // 돌려보냄 · 취소 · 시한 만료 · 실행 실패 — 승인 대기 키를 지운다(쓰이지 않은 키가 저장소에 남지 않게).
  // 사용처가 있으면 지우지 않는다(점검 C-5 — 예전에는 대기 키를 묶은 서버가 key-missing 으로 남았다. 지금은 묶기 자체를 막지만 그 전 자료가 있을 수 있다).
  discard: (p) => { const k = KS.keyById(p.keyId); if (k && k.status === 'pending') REFS.deleteKeyIfUnused(p.keyId); } });
TP.registerKind('ssh-key-rotate', { label: '키 교체(회전)', run: (p) => REFS.rotateKey(p.from, p.to) });
TP.registerKind('ssh-key-delete', { label: '키 삭제', run: (p) => REFS.deleteKeyIfUnused(p.keyId) });
TP.registerKind('ssh-corp-resume', { label: '법인 키 사용 재개',
  run: (p, { by }) => {
    const cur = ST.stopFor(p.corp);
    if (cur && !cur.unreadable && Number(cur.at) !== Number(p.stopAt)) return { ok: false, code: 'stop-changed', status: 409, reason: '요청 뒤 그 법인에 사용 중지가 다시 걸렸습니다 — 새 중지를 확인하고 새로 요청하세요(옛 요청으로 풀지 않습니다).' };
    return ST.clearCorpStop(p.corp, { by });
  } });
TP.registerKind('ssh-keystore-reload', { label: '키 저장소 다시 읽기(포탈 밖 변경 받아들이기)', run: (p, { by }) => reloadKeyStoreNow({ by, expectSha: typeof p.sha === 'string' ? p.sha : '' }) });
TP.registerKind('ssh-guard-change', { label: '보호 장치 끄기', run: (p, { by }) => ST.setGuards(p.patch, { by }) });

/**
 * 두 사람 승인이 켜져 있는데 승인할 사람이 없으면 요청을 만들지 않는다(점검 C-7 — 아무도 승인하지 못하는 요청이 24시간 남고,
 * 받는 곳 승인은 평문 파일까지 지워 키 원문을 잃었다). 부작용(대기 키 저장 · 평문 삭제) **전에** 부른다.
 */
function noApproverIssue(by) {
  if (!twoPersonOn() || otherOwners(by).length) return null;
  const listed = listedOtherOwners(by);
  const who = listed.length ? `(목록의 ${listed.slice(0, 3).join(' · ')}${listed.length > 3 ? ` 외 ${listed.length - 3}` : ''} — 지금 승인할 수 없는 계정입니다: 관리자 역할 · 전체 범위 · 로그인 수단이 필요)` : '';
  return { ok: false, code: 'no-approver', status: 409,
    reason: `두 사람 승인이 켜져 있지만 승인할 수 있는 다른 설정 소유자가 없습니다${who} — 요청을 만들지 않았습니다. ${listed.length ? '그 계정을 고치거나 설정 소유자 목록에서 뺀 뒤 ' : ''}보호 장치에서 두 사람 승인을 끄면 본인 OTP 만으로 할 수 있습니다.` };
}

/** 요청을 만들거나(두 사람 승인 켬) 바로 실행한다(끔). 요청이 만들어지면 사건을 남긴다. */
async function submitSsh(req, runNow) {
  const na = noApproverIssue(req.by); if (na) return na;
  const r = await TP.submit({ ...req, required: twoPersonOn() }, runNow);
  if (r && r.ok && r.pending) {
    ST.addEvent({ kind: 'approval-requested', corp: req.corp || '', target: req.title, by: req.by });
    return { ...r, approvers: otherOwners(req.by).length };
  }
  return r;
}

/** 키를 저장소에 넣는다 — 두 사람 승인이 켜져 있으면 ‘승인 대기’ 로 넣고 요청을 만든다(승인 전에는 접속에 쓰이지 않는다 — keyMaterial 이 거절). */
async function addKeyWithApproval(input, { by = '', how = '등록' } = {}) {
  const na = noApproverIssue(by); if (na) return na;   // 대기 키를 저장하기 전에(받는 곳이면 평문 파일을 지우기 전에)
  const need = twoPersonOn();
  const r = KS.addKey(input, { by, pending: need });
  if (!r.ok || !need) return r;
  const q = await submitSsh({ kind: 'ssh-key-activate', title: `키 ${how} — ${r.key.name}`, target: r.key.id, corp: r.key.folderCorp || '',
    // 승인하는 사람이 보는 것 = 요청 지문에 묶이는 것: 이름 · 폴더 · 허용 기능 · 지문(승인 대기 키는 그 뒤로 바꿀 수 없다 — keyStore).
    payload: { keyId: r.key.id, fingerprint: r.key.fingerprint, name: r.key.name, algo: r.key.algo || '', folderCorp: r.key.folderCorp || '', folderServer: r.key.folderServer || '',
      features: Array.isArray(r.key.features) ? r.key.features : null }, by }, () => ({ ok: true }));
  if (!q.ok) { KS._removeKey(r.key.id); return q; }   // 요청을 못 만들었으면 승인 대기 키를 남기지 않는다
  return { ok: true, key: r.key, pending: true, request: q.request, approvers: q.approvers };
}

/** 키 교체(회전 — 옛 키를 쓰는 서버 · 공통 계정을 새 키로 옮기고 옛 키를 퇴역). */
export async function rotateKeyReq({ from, to, by = '' } = {}) {
  const a = KS.keyById(t(from, 32)); const b = KS.keyById(t(to, 32));
  if (!a || !b) return { ok: false, code: 'not-found', status: 404, reason: '옛 키 또는 새 키를 찾을 수 없습니다.' };
  if (b.status !== 'active') return { ok: false, code: b.status === 'pending' ? 'key-pending' : 'key-retired', status: 409, reason: b.status === 'pending' ? REFS.AUTH_ERROR['key-pending'] : '새 키가 퇴역 상태입니다.' };
  return submitSsh({ kind: 'ssh-key-rotate', title: `키 교체 — ${a.name} → ${b.name}`, target: `${a.id}>${b.id}`, corp: a.folderCorp || '', payload: { from: a.id, to: b.id, fromName: a.name, toName: b.name }, by },
    () => REFS.rotateKey(a.id, b.id));
}
/** 키 삭제(쓰는 곳이 없을 때만 — 판정은 refs.deleteKeyIfUnused). 승인 대기 키는 요청자 · 승인자의 ‘돌려보내기’ 로 지운다. */
export async function deleteKeyReq({ keyId, by = '' } = {}) {
  const k = KS.keyById(t(keyId, 32));
  if (!k) return { ok: false, code: 'not-found', status: 404, reason: '키를 찾을 수 없습니다.' };
  if (k.status === 'pending') {
    // 요청이 살아 있으면 그 요청을 돌려보내 지운다. 요청이 없는 승인 대기 키(요청 뒷정리가 실패해 남은 것)는 한 번도 쓰인 적이 없으므로 바로 지운다.
    // 승인 기록을 못 읽으면 ‘요청 없음’ 이 아니라 모름 — 지우지 않는다(웹 점검 W3).
    if (AP.approvalsLoadError()) return { ok: false, code: 'approvals-unreadable', status: 503, reason: '승인 기록 파일을 읽지 못해 승인 대기 키를 지우지 않았습니다.' };
    const open = AP.listRequests({ kinds: ['ssh-key-activate'], includeDone: false }).some((r) => r.target === k.id);
    if (open) return { ok: false, code: 'key-pending', status: 409, reason: '승인 대기 중인 키입니다 — 키 보안 › 승인 대기에서 돌려보내면 지워집니다.' };
    return REFS.deleteKeyIfUnused(k.id);   // 사용처가 있으면 지우지 않는다(점검 C-5)
  }
  return submitSsh({ kind: 'ssh-key-delete', title: `키 삭제 — ${k.name}`, target: k.id, corp: k.folderCorp || '', payload: { keyId: k.id, name: k.name, fingerprint: k.fingerprint }, by },
    () => REFS.deleteKeyIfUnused(k.id));
}

/**
 * 보호 장치 바꾸기. **켜는 것**은 바로(본인 OTP). **끄는 것**은 두 사람 승인 — 단, 승인해 줄 다른 설정 소유자가 한 명도 없으면 바로(잠김 방지 · 사건에 적는다).
 */
export async function changeGuards(patch = {}, { by = '' } = {}) {
  const cur = ST.getGuards();
  if (cur.unreadable) return { ok: false, code: 'state-unreadable', status: 503, reason: '상태 파일을 읽지 못해 보호 장치를 바꾸지 않았습니다.' };
  const want = {}; const off = {}; const on = {};
  for (const k of ST.GUARD_KEYS) if (typeof patch[k] === 'boolean' && patch[k] !== cur[k]) { want[k] = patch[k]; (patch[k] ? on : off)[k] = patch[k]; }
  if (!Object.keys(want).length) return { ok: true, guards: cur, changed: 0 };
  let out = { ok: true, guards: cur, changed: 0 };
  if (Object.keys(on).length) { out = ST.setGuards(on, { by }); if (!out.ok) return out; }
  if (!Object.keys(off).length) return out;
  // 켜는 것은 이미 적용됐다 — 끄는 쪽이 실패해도 응답이 그 사실을 밝힌다(점검 E-7 — 실패로만 말하면 화면이 켠 것까지 안 된 줄 안다).
  const partial = (r) => (r && !r.ok && Object.keys(on).length ? { ...r, partial: { applied: Object.keys(on) }, guards: ST.getGuards() } : r);
  const tpOn = twoPersonOn();
  if (tpOn && otherOwners(by).length > 0) {
    const names = Object.keys(off).map((k) => (k === 'twoPerson' ? '두 사람 승인' : '서버 쪽 제한')).join(' · ');
    return partial(await submitSsh({ kind: 'ssh-guard-change', title: `보호 장치 끄기 — ${names}`, target: Object.keys(off).sort().join(','), payload: { patch: off }, by }, () => ST.setGuards(off, { by })));
  }
  // 승인자 0명 지름길은 **목록에도 다른 소유자가 없을 때만**(점검 A1 — 다른 소유자를 강등 · 범위 지정해 ‘승인 불가’ 로 만든 뒤 바로 끄는 길을 막는다).
  if (tpOn && listedOtherOwners(by).length > 0) return partial(noApproverIssue(by));
  const r = ST.setGuards(off, { by });
  if (r.ok && tpOn) ST.addEvent({ kind: 'guard-changed', by, detail: '승인할 다른 설정 소유자가 없어 본인 OTP 만으로 껐습니다' });
  return partial(r);
}

/**
 * 승인 · 돌려보내기 사전 검사 — **OTP 를 쓰기 전에**(라우트가 reauth 앞에 둔다 · 점검 A10). 판정은 store 가 다시 한다(여기는 빨리 거절만).
 * @returns {null | {ok:false, code, status, reason}}
 */
export function approvalPrecheck(id, { approve, by = '', digest = '' } = {}) {
  if (AP.approvalsLoadError()) return { ok: false, code: 'approvals-unreadable', status: 503, reason: '승인 기록 파일을 읽지 못해 승인 · 돌려보내기를 받지 않습니다.' };
  const cur = AP.getRequest(t(id, 20));
  if (!cur || !SSH_KINDS.includes(cur.kind)) return { ok: false, code: 'not-found', status: 404, reason: '요청을 찾을 수 없습니다.' };
  if (cur.status !== 'pending') return { ok: false, code: 'not-pending', status: 409, reason: '이미 처리된 요청입니다.' };
  if (cur.expiresAt <= Date.now()) return { ok: false, code: 'expired', status: 409, reason: '요청의 시한(24시간)이 지났습니다 — 다시 요청하세요.' };
  if (approve) {
    if (AP.identityKey(by) === AP.identityKey(cur.requestedBy)) return { ok: false, code: 'self-approve', status: 403, reason: '요청한 사람은 승인할 수 없습니다 — 다른 설정 소유자가 승인해야 합니다.' };
    if (t(digest, 64) !== cur.digest) return { ok: false, code: 'digest-mismatch', status: 409, reason: '화면에서 본 요청 내용과 다릅니다 — 다시 읽은 뒤 승인하세요.' };
  }
  return null;
}
/** 키 작업 시작 사전 검사 — 같은 칸 작업이 진행 중이면 OTP 를 쓰기 전에 409. */
export function keyJobPrecheck(kind) {
  const busy = KL.busyJob(kind);
  return busy ? { ok: false, code: 'busy', status: 409, jobId: busy, reason: kind === 'key-revoke' ? '다른 키 거두기 작업이 진행 중입니다 — 끝난 뒤 다시 하세요.' : '다른 키 로그인 설정 작업이 진행 중입니다 — 끝나거나 멈춘 뒤 다시 하세요.' } : null;
}

/** 승인 · 돌려보내기(요청한 사람은 승인할 수 없다 — store 가 강제). */
export async function decideApproval(id, { approve, by = '', digest = '', note = '' } = {}) {
  if (AP.approvalsLoadError()) return { ok: false, code: 'approvals-unreadable', status: 503, reason: '승인 기록 파일을 읽지 못해 승인 · 돌려보내기를 받지 않습니다.' };   // 점검 C-11 — 404 가 아니다
  const cur = AP.getRequest(t(id, 20));
  if (!cur || !SSH_KINDS.includes(cur.kind)) return { ok: false, code: 'not-found', status: 404, reason: '요청을 찾을 수 없습니다.' };
  const r = approve ? await TP.approve(cur.id, { by, digest, note }) : TP.reject(cur.id, { by, note });
  if (r.request && (r.ok || r.request.status !== 'pending')) {
    ST.addEvent({ kind: 'approval-decided', corp: cur.corp, target: cur.title, by,
      detail: approve ? (r.ok ? `승인 · 실행됨(요청 ${cur.requestedBy})${r.recordFailed ? ' · 결과 기록 실패' : ''}` : `승인했지만 실행 실패 — ${t(r.reason, 160)}`) : (r.request.status === 'cancelled' ? '요청자가 취소' : `돌려보냄(요청 ${cur.requestedBy})`) });
  }
  return r;
}

/* ── 키 로그인 설정 · 키 거두기(v3.10.0 — keyLogin.js) ──────────────────────── */

/** 등록부 쓰기 두 가지는 이 파일에서만 부른다(소스 스윕 — keyLogin.js 는 넘겨받은 함수만 쓴다). */
// 묶기 직전에 키가 아직 활성인지 다시 본다 — 작업 도중 회전 · 삭제로 퇴역한 키에 서버를 묶지 않게(점검 C 의심 S-1).
const bindKey = (server, keyId) => {
  const k = KS.keyById(keyId);
  if (!k || k.status !== 'active') return { ok: false, reason: '그 사이 키가 퇴역 · 삭제됐습니다' };
  return setBmServerKeyRef(server.id, keyId, { expectAddr: regAddrOf(server) });
};
// 키 접속이 확인된 뒤에만 불린다(keyLogin.installOne) — 공통 계정의 기본 키를 따르는 서버면 viaAccountKey(등록부는 계정 키를 모른다).
const clearPassword = (server) => clearBmServerPassword(server.id, { expectAddr: regAddrOf(server), viaAccountKey: !t(server.keyRef) && !!t(server.credRef) });

/** 요청의 서버 목록({id, addr}) → 등록부 원본. 화면이 본 접속처와 다르면 그 서버는 ‘moved’ 로 뺀다. */
function pickServers(list) {
  const all = new Map(listBmServersRaw().map((s) => [s.id, s]));
  const ok = []; const skipped = [];
  const seen = new Set();
  for (const it of (Array.isArray(list) ? list : []).slice(0, KL.MAX_JOB_SERVERS + 1)) {
    const id = t(it?.id, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const s = all.get(id);
    if (!s) { skipped.push({ id, name: id, ok: false, code: 'not-found', reason: '서버를 찾을 수 없습니다.' }); continue; }
    if (typeof it.addr !== 'string' || it.addr !== regAddrOf(s)) { skipped.push({ id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'moved', reason: '서버 주소 · 포트 · 계정이 화면에서 본 것과 다릅니다 — 화면을 다시 읽으세요.' }); continue; }
    ok.push(s);
  }
  return { ok, skipped };
}
const oncePw = (v) => (typeof v === 'string' && v.length <= 1024 ? v : '');
/** 작업이 그 서버에 닿은 때의 등록부 원본 — 시작 뒤 지워졌거나 접속처가 바뀌었으면 null(한 시간 전 자격으로 붙지 않게 — 점검 C 의심 S-1). */
function freshServer(s0) {
  if (bmRegistryLoadError()) return null;
  const s = listBmServersRaw().find((x) => x.id === s0.id);
  return s && regAddrOf(s) === regAddrOf(s0) ? s : null;
}
const movedResult = (s0) => ({ id: s0.id, name: s0.name || s0.host, corp: t(s0.vcenterId), ok: false, code: 'moved', reason: '작업이 시작된 뒤 서버가 지워졌거나 주소 · 포트 · 계정이 바뀌어 하지 않았습니다.' });
/** 키 원본을 다시 읽는다(작업 도중 퇴역 · 삭제 · 바꿔치기 — 그 뒤 서버에는 하지 않는다). */
function freshKey(id) { const k = KS.listKeysRaw().find((x) => x.id === id); return k || null; }
async function mockRefusal() {
  try { const { isMockMode } = await import('../mock/demo/flags.js'); if (isMockMode()) return { ok: false, code: 'demo', status: 409, reason: '데모(mock) 모드에서는 서버에 접속하지 않습니다.' }; } catch { /* 판정 모듈이 없으면 실제 모드 */ }
  return null;
}
const countBy = (results, pick) => { const m = {}; for (const r of results) { const k = pick(r); m[k] = (m[k] || 0) + 1; } return m; };
const failNames = (results) => results.filter((r) => !r.ok && r.code !== 'cancelled').slice(0, 5).map((r) => `${t(r.name, 40)}(${t(r.code, 24)})`).join(', ');

/**
 * 키 로그인 설정을 시작한다(작업 — 1대씩 차례로). 서버 쪽 제한은 보호 장치 설정을 따른다(요청이 고르지 않는다).
 * @param {{servers:{id:string,addr:string}[], keyId:string, oncePassword?:string, removePassword?:boolean, replaceKeyId?:string, by?:string}} o
 */
export async function startKeyLogin({ servers, keyId, oncePassword = '', removePassword = false, replaceKeyId = '', by = '' } = {}) {
  const demo = await mockRefusal(); if (demo) return demo;
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못했습니다.' };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const key = freshKey(t(keyId, 32));
  if (!key) return { ok: false, code: 'key-missing', status: 404, reason: '키를 찾을 수 없습니다.' };
  if (key.status !== 'active') return { ok: false, code: key.status === 'pending' ? 'key-pending' : 'key-retired', status: 409, reason: key.status === 'pending' ? REFS.AUTH_ERROR['key-pending'] : '퇴역한 키는 넣지 않습니다.' };
  // 공개키 칸이 지문과 맞을 때만 — 복원 · 손으로 고친 파일로 남의 공개키가 들어가 있으면 그 줄을 서버에 넣게 된다(점검 A3).
  if (KS.tamperedKeyIds().includes(key.id) || !KS.publicKeyMatches(key)) return { ok: false, code: 'key-tampered', status: 409, reason: REFS.AUTH_ERROR['key-tampered'] };
  let replaceKey = null;
  if (t(replaceKeyId, 32)) {
    replaceKey = freshKey(t(replaceKeyId, 32));
    if (!replaceKey) return { ok: false, code: 'key-missing', status: 404, reason: '지울 옛 키를 찾을 수 없습니다.' };
    if (replaceKey.id === key.id) return { ok: false, code: 'same-key', reason: '넣을 키와 지울 키가 같습니다.' };
    if (!KS.publicKeyMatches(replaceKey)) return { ok: false, code: 'key-tampered', status: 409, reason: '지울 옛 키의 저장된 공개키가 지문과 맞지 않습니다 — 서버에서 지문으로 직접 찾아 지우세요.' };
  }
  const { ok: list, skipped } = pickServers(servers);
  if (!list.length) return { ok: false, code: 'empty', status: 400, reason: skipped[0]?.reason || '대상 서버가 없습니다.', skipped };
  const restrict = serverRestrictOn();
  const pw = oncePw(oncePassword);
  const r = KL.startJob({ kind: 'key-login', servers: list, by, meta: { keyId: key.id, keyName: key.name, restrict, removePassword: !!removePassword, replaceKeyName: replaceKey?.name || '', skipped },
    run: async (s0) => {
      const s = freshServer(s0);
      if (!s) return movedResult(s0);
      const k = freshKey(key.id);
      if (!k || k.status !== 'active' || !KS.publicKeyMatches(k)) return { id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'key-changed', reason: '작업 도중 키가 퇴역 · 삭제됐거나 저장된 내용이 바뀌어 이 서버에는 하지 않았습니다.' };
      const rk = replaceKey ? freshKey(replaceKey.id) : null;
      const res = await KL.installOne(s, k, { oncePassword: pw, restrict, removePassword: !!removePassword, replaceKey: rk && KS.publicKeyMatches(rk) ? rk : null, by, bind: bindKey, clearPassword });
      ST.addEvent({ kind: 'key-login-set', corp: t(s.vcenterId), target: `${s.name || s.host} · ${key.name}`, by, detail: res.ok ? `키 접속 확인${res.restricted ? ' · 출발지 제한' : ''}${res.passwordRemoved ? ' · 저장 비밀번호 삭제' : ''}` : `실패(${res.code})` });
      return res;
    },
    onDone: (v) => {
      const c = countBy(v.results, (x) => (x.ok ? 'ok' : x.code === 'cancelled' ? 'cancelled' : 'fail'));
      ST.addEvent({ kind: 'key-job-done', target: `키 로그인 설정 · ${key.name}`, by,
        detail: `${v.total}대 — 확인 ${c.ok || 0} · 실패 ${c.fail || 0}${c.cancelled ? ` · 멈춤 ${c.cancelled}` : ''}${c.fail ? ` — ${failNames(v.results)}` : ''}${v.cancelledBy ? ` · 멈춘 사람 ${v.cancelledBy}` : ''}` });
    } });
  return r.ok ? { ...r, total: list.length, skipped } : r;
}

/**
 * 서버에서 키 거두기 — 그 키의 포탈 줄을 지운다(긴급 조치 — 멈추는 방향이라 본인 OTP 만).
 * 대상: `servers`({id, addr} 목록) 또는 `corp`(그 법인의 중앙 수집 서버 전부 — 상한 KL.MAX_REVOKE_SERVERS, 넘는 서버는 ‘over-limit’ 으로 밝힌다).
 * 같은 키를 넣는 작업이 돌고 있으면 그 작업을 멈춘다(keyLogin.startJob). 닿지 못한 서버는 결과에 사유와 함께 남는다.
 */
export async function startKeyRevoke({ keyId, corp = '', servers = null, oncePassword = '', by = '' } = {}) {
  const demo = await mockRefusal(); if (demo) return demo;
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못했습니다.' };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const key = freshKey(t(keyId, 32));
  if (!key) return { ok: false, code: 'key-missing', status: 404, reason: '키를 찾을 수 없습니다.' };
  if (!KS.publicKeyMatches(key)) return { ok: false, code: 'key-tampered', status: 409, reason: '저장된 공개키가 지문과 맞지 않아 거두지 않았습니다(남의 줄을 지울 수 있다) — 서버에서 지문으로 직접 찾아 지우세요.' };
  let list; let skipped = [];
  if (Array.isArray(servers)) ({ ok: list, skipped } = pickServers(servers));
  else {
    const c = t(corp, 128);
    if (!c) return { ok: false, code: 'bad-corp', reason: '법인을 고르세요.' };
    const inCorp = listBmServersRaw().filter((s) => t(s.vcenterId) === c && !s.addrOnly);
    const central = inCorp.filter((s) => !t(s.agent));
    list = central.slice(0, KL.MAX_REVOKE_SERVERS);
    skipped = inCorp.filter((s) => t(s.agent)).map((s) => ({ id: s.id, name: s.name || s.host, corp: c, ok: false, code: 'edge-delegated', reason: '엣지가 수집하는 서버 — 그 엣지 포탈에서 거둡니다.' }));
    // 상한을 넘는 서버는 잘린 사실을 밝힌다(점검 C-1 · E-10 — 예전에는 조용히 100대에서 잘랐다).
    for (const s of central.slice(KL.MAX_REVOKE_SERVERS)) skipped.push({ id: s.id, name: s.name || s.host, corp: c, ok: false, code: 'over-limit', reason: `한 번에 ${KL.MAX_REVOKE_SERVERS}대까지라 이번 작업에서 빠졌습니다 — 서버를 골라 따로 거두세요.` });
  }
  if (!list.length) return { ok: false, code: 'empty', status: 400, reason: skipped[0]?.reason || '대상 서버가 없습니다.', skipped };
  const pw = oncePw(oncePassword);
  const r = KL.startJob({ kind: 'key-revoke', servers: list, by, meta: { keyId: key.id, keyName: key.name, corp: t(corp, 128), skipped },
    run: async (s0) => {
      const s = freshServer(s0);
      if (!s) return movedResult(s0);
      const res = await KL.revokeOne(s, key, { oncePassword: pw, by });
      if (res.ok && res.removed > 0) ST.addEvent({ kind: 'key-lines-removed', corp: t(s.vcenterId), target: `${s.name || s.host} · ${key.name}`, by, detail: `${res.removed}줄` });
      return res;
    },
    // 작업 끝에 요약 사건 하나(중요 사건 · 메일 한 통) — 실패한 서버 이름을 함께(점검 E-2 · C-4).
    onDone: (v) => {
      const c = countBy(v.results, (x) => (x.ok ? (x.removed > 0 ? 'removed' : 'none') : x.code === 'cancelled' ? 'cancelled' : 'fail'));
      ST.addEvent({ kind: 'key-revoke-done', corp: t(corp, 128), target: `${key.name}`, by,
        detail: `${v.total}대 — 지움 ${c.removed || 0} · 줄 없음 ${c.none || 0} · 실패 ${c.fail || 0}${c.cancelled ? ` · 멈춤 ${c.cancelled}` : ''}${skipped.length ? ` · 빠짐 ${skipped.length}` : ''}${c.fail ? ` — ${failNames(v.results)}` : ''}` });
    } });
  return r.ok ? { ...r, total: list.length, skipped } : r;
}
export function keyJob(id) { return KL.jobView(id); }
/** 키 작업 멈추기(지금 서버는 끝까지 — 되돌림을 끊지 않는다). 줄이는 방향이라 소유자 등급만(OTP 없음). */
export function cancelKeyJob(id, { by = '' } = {}) {
  const r = KL.cancelJob(id, { by, why: `${t(by, 40)} 이(가) 멈춤` });
  if (r.ok) ST.addEvent({ kind: 'key-job-cancel', target: t(id, 20), by });
  return r;
}

/* ── 사용 기록 ────────────────────────────────────────────────────────── */
export function usageView({ fingerprint = '', limit = 200 } = {}) { return keyUsageView({ fingerprint, limit }); }

/* ── 주기 점검(기동 뒤 · 10분마다) ────────────────────────────────────── */
let _timer = null;
let _seenInbox = null;
/**
 * 받는 곳 파일의 ‘본 표지’ — 12자 해시(사건 detail 300자 안에 20개가 들어간다). 예전 판은 경로|sha 원문을 줄로 붙여 300자에서 잘렸고,
 * 한 번에 5개쯤 넘게 들어오면 재시작 뒤 나머지를 다시 알렸다(점검 D 의심 S-2). 옛 사건의 원문 표지도 같은 해시로 읽는다(업그레이드 날 다시 알리지 않게).
 */
const inboxSigKey = (sig) => crypto.createHash('sha256').update(String(sig)).digest('hex').slice(0, 12);
const INBOX_SIGS_PER_EVENT = 20;
let _seenDrift = null;
let _running = false;

/** 한 번 — 키 저장소 파일 대조 · 받는 곳의 새 파일 · 지워진 서버의 읽은 결과 정리 · 사용 기록 쓰기. 사건은 모아 한 번만 쓴다(점검 D-2 · C-7). */
export async function runSshAccessScan({ now = Date.now() } = {}) {
  if (_running) return { skipped: true };
  _running = true;
  try {
    const events = [];
    // 승인 요청 만료 확정은 **맨 먼저** — 뒤 단계(대조 · 받는 곳)가 던져도 이 회차가 만료를 확정하고 대기 키를 정리한다(점검 C 의심 S-3).
    for (const r of TP.expireSweep({ now })) events.push({ kind: 'approval-decided', corp: r.corp, target: r.title, detail: r.interrupted ? '승인 뒤 실행 결과가 적히지 않음 — 실행됐는지 확인 필요' : '시한(24시간)이 지나 사라짐' });
    let drift = { changed: [], added: [], accountsChanged: [] }; let ib = { items: [] }; let regErr = null; let servers = [];
    const seenDrift = []; const seenInbox = [];
    try {
    drift = checkKeyDrift({ now });
    if (!_seenDrift) _seenDrift = new Set();
    // ‘본 표지’ 는 사건을 실제로 쓴 뒤에만 세운다(쓰기에 실패하면 다음 점검에서 다시 낸다 — 반증 D10).
    for (const id of drift.changed || []) {
      if (_seenDrift.has(`c:${id}`)) continue;
      seenDrift.push(`c:${id}`);
      const k = KS.keyById(id);
      events.push({ kind: 'key-changed-outside', corp: k?.folderCorp || '', target: k?.name || id, detail: k?.fingerprint || '' });
    }
    for (const a of drift.added || []) {
      if (_seenDrift.has(`a:${a.id}`)) continue;
      seenDrift.push(`a:${a.id}`);
      events.push({ kind: 'key-added-outside', target: a.name || a.id, detail: a.fingerprint || '' });
    }
    for (const id of drift.accountsChanged || []) {
      if (_seenDrift.has(`u:${id}`)) continue;
      seenDrift.push(`u:${id}`);
      const a = KS.accountById(id);
      events.push({ kind: 'account-changed-outside', corp: a?.corp || '', target: a?.name || id });
    }
    const corps = await corpList();
    regErr = bmRegistryLoadError();
    servers = regErr ? [] : listBmServersRaw();
    ib = await INB.scanInbox({ corps, servers: servers.map((s) => ({ id: s.id, name: s.name || s.host, vcenterId: t(s.vcenterId) })) });
    if (!_seenInbox) _seenInbox = new Set(ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'inbox-new' || e.kind === 'inbox-seen').flatMap((e) => String(e.detail || '').split(/\s+/)).filter(Boolean).map((x) => (x.includes('|') ? inboxSigKey(x) : x)));
    const fresh = [];
    for (const it of ib.items) {
      if (it.code !== 'ready' && !it.needPassphrase) continue;
      const sig = inboxSigKey(`${it.relPath}|${it.sha || it.size}`);
      if (_seenInbox.has(sig)) continue;
      seenInbox.push(sig);
      fresh.push({ it, sig });
    }
    // 새 파일은 사건 하나로(파일마다 상태 파일을 다시 쓰지 않는다 — 점검 D-2). detail = 본 표지(재시작 뒤 다시 세지 않게).
    if (fresh.length) events.push({ kind: 'inbox-new', corp: fresh.length === 1 ? fresh[0].it.corp : '',
      target: `${fresh.length}개 — ${fresh.slice(0, 3).map((x) => x.it.relPath).join(' · ')}`, detail: fresh.slice(0, INBOX_SIGS_PER_EVENT).map((x) => x.sig).join(' ') });
    // 20개가 넘으면 나머지 표지는 알림 없는 사건(inbox-seen)에 싣는다 — 메일은 위 한 줄(몇 개인지)로 충분하다.
    for (let i = INBOX_SIGS_PER_EVENT; i < fresh.length; i += INBOX_SIGS_PER_EVENT) events.push({ kind: 'inbox-seen', detail: fresh.slice(i, i + INBOX_SIGS_PER_EVENT).map((x) => x.sig).join(' ') });
    } catch (e) { console.warn(`[ssh-access] 점검 일부 실패(만료 확정은 했습니다): ${String(e?.message || e).slice(0, 160)}`); regErr = regErr || 'scan-failed'; }
    const wrote = events.length ? ST.addEvents(events, { now }).ok : true;
    if (wrote) { for (const x of seenDrift) _seenDrift.add(x); for (const x of seenInbox) _seenInbox.add(x); }
    if (!regErr) INS.pruneInstalled(new Set(servers.map((s) => s.id)));
    flushKeyUsage({ now });
    return { ok: true, drift, inbox: ib.items.length, events: events.length };
  } finally { _running = false; }
}
/** 라우트용 — 점검을 시작만 하고 기다리지 않는다(요청을 오래 붙잡지 않게 — 점검 D-1). */
export function startSshAccessScanNow() {
  if (_running) return { ok: false, code: 'busy', status: 409, reason: '점검이 이미 진행 중입니다.' };
  runSshAccessScan().catch((e) => console.warn(`[ssh-access] 점검 실패: ${String(e?.message || e).slice(0, 160)}`));
  return { ok: true, started: true };
}

/** 기동 시 한 번 등록(index.js). 첫 실행은 firstDelayMs 뒤(기동 직후 부하를 피한다 — 키 원문 대조는 첫 사용 때 refs 가 따로 한다). */
export function startSshAccessScheduler({ firstDelayMs = 90_000 } = {}) {
  if (_timer) return;
  startKeyNotify();   // 키 보안 사건 메일(모아서 한 통 — notify.js)
  const run = () => { runSshAccessScan().catch((e) => console.warn(`[ssh-access] 주기 점검 실패: ${String(e?.message || e).slice(0, 160)}`)); };
  const first = setTimeout(() => { run(); _timer = setInterval(run, SCAN_EVERY_MS); _timer.unref?.(); }, firstDelayMs);
  first.unref?.();
  _timer = first;
}
export function _resetSshAccessServiceForTest() { if (_timer) { clearTimeout(_timer); clearInterval(_timer); } _timer = null; _seenInbox = null; _seenDrift = null; _running = false; }
