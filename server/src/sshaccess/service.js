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
import { store } from '../store.js';
import { config } from '../config.js';
import * as KS from '../bmusage/onboard/keyStore.js';
import * as REFS from '../bmusage/onboard/refs.js';
import { addrKey } from '../bmusage/onboard/bindRule.js';
import { RSA_MIN_BITS } from '../bmusage/onboard/keyParse.js';
import { listBmServersRaw, registryLoadError as bmRegistryLoadError, setBmServerKeyRef, restoreBmServerKeyRef,
  setBmServerInherit, setBmServerCredRef, restoreBmServerAccess, setBmServerOs, setBmServersOs, inheritActive, inheritKeyOf, hasOwnCred, SERVER_OS } from '../bmstor/registry.js';
import { loadSecretsPolicy } from '../security/secretVault.js';
import * as ST from './state.js';
import * as INS from './installed.js';
import * as INB from './inbox.js';
import { keyUsageView, flushKeyUsage, lastUseByFingerprint, keyUsageLoadFailed, accountUseFingerprint } from './usage.js';
import { noteCredOutcome } from './outcome.js';
import { buildKeyCheck, checkKeyDrift } from './check.js';
import { READ_COMMAND, parseReadOutput } from './authorizedKeys.js';
import { osKindOf } from '../bmusage/collectors/osSsh.js';   // v3.24: 수집이 알아낸 OS(메모리) — OS 종류 제안에만(저절로 바꾸지 않는다)

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const lc = (v) => t(v).toLowerCase();
export const SCAN_EVERY_MS = 10 * 60_000;
const COLLECT = ['bm-usage', 'bm-storage'];

/** 기능 목록(화면 · 키의 ‘쓸 수 있는 기능’). id 는 keyStore.KEY_FEATURES 와 같다(테스트가 대조). ready:false = 아직 이 접속으로 붙는 곳이 없다(화면이 그렇게 말한다). */
export const FEATURE_CATALOG = Object.freeze([
  Object.freeze({ id: 'bm-usage', label: '베어메탈 사용률', tool: 'bm-usage', ready: true, note: 'CPU · 메모리 · 디스크 · 네트워크 · HBA 수집(집중 모니터링 · 저활용 포함)' }),
  Object.freeze({ id: 'bm-storage', label: '베어메탈 스토리지', tool: 'bm-storage', ready: true, note: '마운트 용량(df) 수집' }),
  Object.freeze({ id: 'disk-audit', label: '디스크 오류 이력 점검', tool: 'disk-audit', ready: false, note: '로그 · SMART · RAID 기록에서 매체 오류 흔적 찾기(읽기 전용) — 다음 단계에서 붙습니다' }),
  // v3.17.0 — 서버 집중 모니터링 › 디스크 점검의 자동 설치(대상 서버에 root 로 한 번). 직접 켠 키만 쓴다(기능 목록이 없는 예전 키는 쓰지 않는다).
  Object.freeze({ id: 'disk-audit-install', label: '디스크 점검 프로그램 설치(root)', tool: 'focus-mon', ready: true, note: '서버 집중 모니터링 › 디스크 점검의 자동 설치 — 이 기능을 직접 켠 키만 · 비밀번호 없는 sudo 또는 root 계정이어야 합니다' }),
  // v3.18.0 — 서버 집중 모니터링 › 대상 · 키의 접속 자동 준비(수집 계정 · 공개키를 root 로 한 번). 직접 켠 키만(예전 키 제외) · '설치' 와 따로 켠다.
  Object.freeze({ id: 'focus-mon-prep', label: '집중 모니터링 접속 준비(root)', tool: 'focus-mon', ready: true, note: '서버 집중 모니터링 › 대상 · 키의 접속 자동 준비 — 수집 계정을 만들고 공개키를 넣습니다 · 이 기능을 직접 켠 키만 · 비밀번호 없는 sudo 또는 root 계정이어야 합니다' }),
  // v3.25 — 특수 기능 ‘서버 정보’(서버 접속 2단계): 기본 구성 + 디스크를 누를 때만 읽기 전용으로(sudo 없음). 기능 목록이 있는 키 · 계정은 이 기능을 켜야 쓴다.
  Object.freeze({ id: 'server-info', label: '서버 정보', tool: 'server-info', ready: true, note: 'OS · 하드웨어 · CPU · 메모리 · 디스크 · 파일시스템을 누를 때만 읽기 전용 명령으로(sudo 없음 — 권한이 필요한 칸은 ‘못 읽음 · 권한’)' }),
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

/**
 * 서버의 효력 공통 계정 — 자기 credRef 또는 (v3.24) 계층 지정을 물려받은 계정(refs.effectiveAccountOf 하나). 비밀번호 고정 표지도 함께.
 * @returns {{acc:object|null, ea:object, pwPinned:boolean}}
 */
function effAccount(s, accById) {
  const ea = REFS.effectiveAccountOf(s);
  const inh = ea.source === 'os' || ea.source === 'corp';
  const acc = ea.accountId && (ea.source === 'own' || inh) ? (accById.get(ea.accountId) || null) : null;
  return { acc, ea, pwPinned: s.osAuth === 'password' || (inh && ea.auth === 'password') };
}
/** 서버의 효력 키 id(서버 keyRef → 공통 계정(자기 · 물려받음) 기본 키, 비밀번호 고정이면 없음). */
function effectiveKeyId(s, accById) {
  if (s.osAuth === 'password') return '';
  if (t(s.keyRef)) return t(s.keyRef);
  const { acc, pwPinned } = effAccount(s, accById);
  if (pwPinned) return '';
  return acc && acc.kind === 'os' ? t(acc.keyRef) : '';
}
/** 접속 계정 — resolveOsAuth 와 같은 규칙(공통 계정이 있으면 그 계정의 로그인 이름, 없으면 서버 칸 · root). */
const usernameOf = (s, acc) => (acc ? KS.loginNameOf(acc) : (t(s.username) || 'root'));
/** 등록부 setBmServerKeyRef 의 expectAddr 와 같은 글자(서버 칸 username 기준 — 등록부가 그렇게 비교한다). */
const regAddrOf = (s) => addrKey(s.host, s.port, s.username);

function publicServer(s, { accById, keyById }) {
  const effKey = effectiveKeyId(s, accById);
  const key = effKey ? keyById.get(effKey) : null;
  const { acc, ea } = effAccount(s, accById);
  const inst = INS.installedOf(s.id);
  const placement = key ? REFS.keyPlacementIssue(key, s, 'conn-test') : null;
  return {
    id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, vcenterId: t(s.vcenterId), agent: t(s.agent), enabled: s.enabled !== false,
    username: usernameOf(s, acc), accountName: acc ? acc.name : '', accountMissing: !!ea.accountId && (ea.source === 'own' || ea.source === 'os' || ea.source === 'corp') && !acc,
    keyMode: t(s.keyRef) ? 'pinned' : (effKey ? 'corp-default' : (s.osAuth === 'password' || s.password || (acc && acc.password) ? 'password' : 'none')),
    // v3.24 계층: os(서버 OS 종류) · source(own 따로 정함 · os/corp 물려받음 · none) · inherit(승인 상태) · pending(지정은 있는데 승인 없음/주소 바뀜) · mismatch(법인 단계 계정 OS 다름)
    os: SERVER_OS.includes(s.os) ? s.os : '', source: ea.source, level: ea.level || '', pending: !!ea.pending, mismatch: !!ea.mismatch,
    inheritApproved: inheritActive(s), inheritStale: !!s.inherit && !inheritActive(s) && !t(s.agent), inheritAt: s.inherit?.at || null, inheritBy: s.inherit ? t(s.inherit.by, 64) : '',
    ownCred: hasOwnCred(s), accountId: acc ? acc.id : '', loginName: acc ? KS.loginNameOf(acc) : '',
    detectedOs: detectedOsOf(s),
    keyId: effKey || '', keyName: key ? key.name : '', keyFingerprint: key ? key.fingerprint : '', keyMissing: !!effKey && !key,
    keyStatus: key ? key.status : '', keyFeatures: key ? (Array.isArray(key.features) ? [...key.features] : null) : null, placementIssue: placement || '',
    hasPassword: !!s.password, passwordPinned: s.osAuth === 'password',
    // 화면이 키 고르기 때 그대로 돌려보낸다(낡은 화면에서 고른 키를 바뀐 접속처에 묶지 않게 — 점검 A-8).
    addr: regAddrOf(s),
    inheritKey: inheritKeyOf(s),   // v3.24 반증 F8: 승인 때 화면이 돌려보낸다(주소 · 포트 · OS · 법인 — 본 뒤 바뀌었으면 409)
    installed: inst ? { at: inst.at, by: inst.by, present: !inst.error, error: inst.error || '', count: inst.keys.length,
      hasKey: !!(key && inst.keys.some((k) => k.fingerprint === key.fingerprint)), stale: inst.host !== s.host || inst.port !== (Number(s.port) || 22) } : null,
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
  // v3.24: ‘주소만’ 등록(계정 없음)도 싣는다 — 계층 지정을 물려받을 첫 후보다(표지 addrOnly · 기존 서버 표는 화면이 거른다).
  const pubServers = servers.map((s) => ({ ...publicServer(s, { accById, keyById }), ...(s.addrOnly ? { addrOnly: true } : {}), inboxPath: t(s.vcenterId) ? INB.inboxPathOf(s.vcenterId, s.name || s.host) : '' }));
  // 키 점검 ‘서버’ 칸 — 키를 쓰는데 폴더 · 기능 규칙 때문에 주기 수집이 막힌 서버, 법인이 없어 폴더 키를 못 쓰는 서버(엣지 위임 서버는 그 엣지가 본다).
  const keyed = pubServers.filter((s) => s.keyId && !s.agent && !s.addrOnly);
  const serverSummary = regErr ? null : {
    blocked: keyed.filter((s) => s.placementIssue || (Array.isArray(s.keyFeatures) && !COLLECT.some((f) => s.keyFeatures.includes(f)))).map((s) => s.name),
    noCorp: keyed.filter((s) => !s.vcenterId).map((s) => s.name),
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
    accounts: accRaw.filter((a) => a.kind === 'os').map((a) => ({ ...KS.publicAccountView(a, { usage: usage.account(a.id), now }),
      lastUse: lastUse.get(accountUseFingerprint(a.id)) || null, stop: accountStopView(a) })),
    // v3.24 계층 지정(법인 › OS 종류) — 못 읽으면 null(모름 — 화면이 ‘상태 파일을 읽지 못함’ 으로 말한다)
    assign: ST.listAssign(),
    assignLevels: ST.ASSIGN_LEVELS,
    keys: keysRaw.map((k) => ({ ...KS.publicKeyView(k, { usage: usage.key(k.id), now }), lastUse: lastUse.get(k.fingerprint) || null,
      inboxPath: k.folderCorp ? INB.inboxPathOf(k.folderCorp, k.folderServer) : '' })),
    usageKnown: usage.known,
    servers: pubServers,
    edgeRows,
    features: FEATURE_CATALOG,
    inbox: { dir: inbox.dir, exists: inbox.exists, items: inbox.items, unknownFolders: inbox.unknownFolders, unknownTotal: inbox.unknownTotal, truncated: inbox.truncated, rootIsLink: inbox.rootIsLink },
    check: buildKeyCheck({ now, policyMode, inbox, drift, servers: serverSummary, corpName }),
    stops: ST.listStops(),
    events: ST.listEvents({ limit: 50 }),
    tampered: KS.tamperedKeyIds(),
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
  // 키 · 공통 계정 사용 기록 + 로그인 거부면 계정 단위 정지는 testSavedOs 안에서 한 번(반증 F7 — 온보딩 연결 시험도 같은 본체).
  return testSavedOs(s, { by });
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
    const issue = k.status !== 'active' ? 'key-retired' : (tampered.has(k.id) ? 'key-tampered' : (REFS.keyPlacementIssue(k, s, 'conn-test') || ''));
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
  // 저장 자격으로 읽었으면 키 · 공통 계정 사용 기록 + 로그인 거부면 계정 단위 정지(반증 F7 — outcome 하나). 1회 비밀번호(저장 안 함)는 기록하지 않는다.
  const noteStoredUse = (ok, kind) => {
    if (!auth.keyFingerprint && !auth.accountId) return;
    noteCredOutcome({ ...s, keyFingerprint: auth.keyFingerprint, keyName: auth.keyName, credAccountId: auth.accountId, credAccountName: auth.accountName, ...(auth.secretVersion != null ? { credVersion: auth.secretVersion } : {}) },
      { ok, rejected: !ok && kind === 'auth-rejected', code: kind, feature: 'conn-test', trigger: 'manual', by });
  };
  let rec;
  try {
    const out = await withSsh({ host: String(s.host), port: Number(s.port) || 22, username: auth.username, password: auth.password || '', privateKey: auth.privateKey, passphrase: auth.passphrase, readyTimeout: 15_000, singlePasswordAttempt: true },
      async ({ exec }) => exec(READ_COMMAND, 15_000));
    const p = parseReadOutput(out?.stdout || '');
    if (!p.ok) rec = { host: s.host, port: Number(s.port) || 22, username: auth.username, file: '~/.ssh/authorized_keys', keys: [], error: p.reason };
    else rec = { host: s.host, port: Number(s.port) || 22, username: auth.username, file: '~/.ssh/authorized_keys', keys: p.keys, truncated: p.truncated, error: p.present ? '' : '파일이 없습니다(키가 하나도 없음).', bad: p.bad };
  } catch (e) {
    const msg = String(e?.message || e);
    const kind = isPeerRejectText(msg) ? 'hostkey' : isAuthFailureText(msg) ? 'auth-rejected' : 'connect';
    const reason = kind === 'hostkey' ? '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.'
      : kind === 'auth-rejected' ? '인증이 거부됐습니다(다시 시도하지 않습니다 — 계정 잠금 방지).' : `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 100)})`;
    noteStoredUse(false, kind);
    return { ok: false, code: kind, status: 502, reason };
  }
  noteStoredUse(true, 'ok');
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
export function addKeyInFolder(body = {}, { by = '' } = {}) {
  const fi = folderTargetIssue(body.folderCorp, body.folderServer);
  if (fi) return { ok: false, code: 'bad-folder', reason: fi };
  return KS.addKey({ name: body.name, privateKey: body.privateKey, passphrase: body.passphrase, rotateAt: body.rotateAt,
    folderCorp: t(body.folderCorp, 128), folderServer: t(body.folderServer, 128), features: body.features === undefined ? [] : body.features }, { by });
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
  const r = KS.addKey({ name, privateKey: rd.pem, passphrase, folderCorp: owner.corp.id, folderServer: owner.server, features: features === undefined ? [] : features }, { by });
  if (!r.ok) return r;
  const rm = INB.removeInboxFile(relPath, { expectSha: rd.sha });
  ST.addEvent({ kind: 'inbox-approved', corp: owner.corp.id, target: r.key.name, by, detail: `${r.key.fingerprint}${rm.ok ? '' : ' · 평문 파일 삭제 실패'}` });
  return { ok: true, key: r.key, plaintextRemoved: !!rm.ok, ...(rm.ok ? {} : { plaintextLeft: true, removeError: rm.reason }) };
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
  const servers = corpServers.map((s) => ({ id: s.id, addr: addrKey(s.host, s.port, usernameOf(s, effAccount(s, accById).acc)) }));
  const r = ST.setCorpStop(c, { by, reason, servers });
  // 엣지가 수집하는 서버는 그 엣지의 키로 접속한다 — 이 노드의 중지는 거기에 닿지 않는다(사실대로 따로 센다).
  const edgeServers = corpServers.filter((s) => t(s.agent)).length;
  return r.ok ? { ...r, servers: servers.length - edgeServers, edgeServers, ...(regErr ? { registryUnreadable: true } : {}) } : r;
}
export function resumeCorp(corp, { by = '' } = {}) { return ST.clearCorpStop(t(corp, 128), { by }); }

/* ── 손상 · 포탈 밖 변경 뒤 다시 읽기(설정 소유자 + OTP) ───────────────── */
export function reloadState({ by = '' } = {}) { return ST.reloadSshAccessState({ by }); }
/** 키 저장소 파일을 새 기준으로 — 바꿔치기 표지를 풀고 첫 사용 대조를 다시 하게 한다. */
export function reloadKeyStore({ by = '' } = {}) {
  const r = KS.reloadKeyStoreFromDisk();
  REFS._resetVerifiedForTest();
  _seenDrift = null;
  if (r.ok) ST.addEvent({ kind: 'keystore-reloaded', by, detail: `키 ${r.keys}개` });
  return r;
}

/* ── 사용 기록 ────────────────────────────────────────────────────────── */
export function usageView({ fingerprint = '', limit = 200 } = {}) { return keyUsageView({ fingerprint, limit }); }

/* ── 주기 점검(기동 뒤 · 10분마다) ────────────────────────────────────── */
let _timer = null;
let _seenInbox = null;
let _seenDrift = null;
let _running = false;

/** 한 번 — 키 저장소 파일 대조 · 받는 곳의 새 파일 · 지워진 서버의 읽은 결과 정리 · 사용 기록 쓰기. 사건은 모아 한 번만 쓴다(점검 D-2 · C-7). */
export async function runSshAccessScan({ now = Date.now() } = {}) {
  if (_running) return { skipped: true };
  _running = true;
  try {
    const events = [];
    const drift = checkKeyDrift({ now });
    if (!_seenDrift) _seenDrift = new Set();
    // ‘본 표지’ 는 사건을 실제로 쓴 뒤에만 세운다(쓰기에 실패하면 다음 점검에서 다시 낸다 — 반증 D10).
    const seenDrift = []; const seenInbox = [];
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
    const regErr = bmRegistryLoadError();
    const servers = regErr ? [] : listBmServersRaw();
    const ib = await INB.scanInbox({ corps, servers: servers.map((s) => ({ id: s.id, name: s.name || s.host, vcenterId: t(s.vcenterId) })) });
    if (!_seenInbox) _seenInbox = new Set(ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'inbox-new').flatMap((e) => String(e.detail || '').split('\n')));
    const fresh = [];
    for (const it of ib.items) {
      if (it.code !== 'ready' && !it.needPassphrase) continue;
      const sig = `${it.relPath}|${it.sha || it.size}`;
      if (_seenInbox.has(sig)) continue;
      seenInbox.push(sig);
      fresh.push({ it, sig });
    }
    // 새 파일은 사건 하나로(파일마다 상태 파일을 다시 쓰지 않는다 — 점검 D-2). detail = 본 표지(재시작 뒤 다시 세지 않게).
    if (fresh.length) events.push({ kind: 'inbox-new', corp: fresh.length === 1 ? fresh[0].it.corp : '',
      target: `${fresh.length}개 — ${fresh.slice(0, 3).map((x) => x.it.relPath).join(' · ')}`, detail: fresh.map((x) => x.sig).join('\n') });
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
  const run = () => { runSshAccessScan().catch((e) => console.warn(`[ssh-access] 주기 점검 실패: ${String(e?.message || e).slice(0, 160)}`)); };
  const first = setTimeout(() => { run(); _timer = setInterval(run, SCAN_EVERY_MS); _timer.unref?.(); }, firstDelayMs);
  first.unref?.();
  _timer = first;
}
export function _resetSshAccessServiceForTest() { if (_timer) { clearTimeout(_timer); clearInterval(_timer); } _timer = null; _seenInbox = null; _seenDrift = null; _running = false; }

/* ── v3.24 서버 접속 — 계층 지정(법인 › OS 종류 › 서버) · 공통 계정 · 한 대 먼저 확인(설계 docs/design/server-access §4.4 · §4.6) ── */

/** 수집이 알아낸 OS(메모리 — 제안용). 모르면 ''. */
function detectedOsOf(s) { const k = osKindOf(s?.host); return k === 'linux' || k === 'windows' ? k : ''; }
/** 계정 단위 정지 — 화면용(current = 지금 비밀번호 판의 정지인가 · 아니면 비밀번호를 바꿔 이미 풀린 기록). */
function accountStopView(a) {
  const st = ST.accountStopFor(a.id);
  if (!st) return null;
  if (st.unreadable) return { unreadable: true };
  return { at: st.at, server: st.server, feature: st.feature, current: st.version === KS.accountSecretVersion(a) };
}
const LEVEL_TEXT = Object.freeze({ all: '법인', linux: 'Linux', windows: 'Windows' });
const storesIssue = (what) => {
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: `SSH 키 저장소를 읽지 못해 ${what}` };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: `OS 계정 등록부를 읽지 못해 ${what}` };
  if (ST.stateLoadError()) return { ok: false, code: 'state-unreadable', status: 503, reason: `서버 접속 상태 파일을 읽지 못해 ${what}` };
  return null;
};

/**
 * 공통 계정 하나로 저장된 서버 주소에 **한 번** 로그인해 본다(한 대 먼저 확인 · 한 대로 다시 확인). 자동 재시도 없음(계정 잠금 방지).
 * 주소는 등록부 저장값 — 요청 주소를 받지 않는다(v2.480). 자격은 resolveOsAuth 하나로(법인 사용 중지 · 바꿔치기 · 폴더 · OS 계열을 같은 판정으로 본다).
 * @param {object} s  등록부 원본 서버
 * @param {{accountId:string, auth?:''|'password', ignoreAccountStop?:boolean, candidate?:{username:string, password:string}|null}} o
 *        candidate — 아직 저장하지 않은 비밀번호로 확인(공통 계정 저장 전). 그때는 키를 쓰지 않는다.
 */
async function loginOnce(s, { accountId = '', auth = '', ignoreAccountStop = false, candidate = null } = {}) {
  let a;
  if (candidate) {
    // 법인 사용 중지는 저장 전 확인에도 본다(멈춰 둔 법인에 새 비밀번호를 보내지 않게).
    const si = ST.stopMatch({ corps: [t(s.vcenterId)].filter(Boolean), serverId: t(s.id), addr: '', serverCorp: t(s.vcenterId) });
    if (si?.unreadable) return { ok: false, kind: 'state-unreadable', reason: REFS.AUTH_ERROR['account-state-unreadable'] };
    if (si) return { ok: false, kind: 'corp-stopped', reason: REFS.AUTH_ERROR['account-corp-stopped'] };
    a = { ok: true, username: candidate.username, password: candidate.password, authKind: 'password' };
  } else {
    a = REFS.resolveOsAuth({ ...s, keyRef: '', credRef: accountId, osAuth: auth === 'password' ? 'password' : '', inherit: undefined, password: '' }, { feature: 'conn-test', ignoreAccountStop });
    if (!a.ok) return { ok: false, kind: a.code, reason: a.error };
    if (a.authKind === 'none') return { ok: false, kind: 'no-secret', reason: '이 공통 계정에는 키 · 비밀번호가 없습니다.' };
  }
  const { withSsh } = await import('../proxy/sshExec.js');
  const { isAuthFailureText, isPeerRejectText } = await import('../util/authGuard.js');
  const t0 = Date.now();
  try {
    // ‘echo ok’ — Linux 셸 · Windows cmd · PowerShell 어디서나 같은 출력(uname 은 Windows 에 없다).
    await withSsh({ host: String(s.host), port: Number(s.port) || 22, username: a.username, password: a.password || '', privateKey: a.privateKey, passphrase: a.passphrase, readyTimeout: 15_000, singlePasswordAttempt: true },   // v3.25 반증 F1: 비밀번호는 한 번만(k-i 재시도 없음 — 계정 잠금 횟수)
      async ({ exec }) => exec('echo ok', 10_000));
    return { ok: true, kind: 'ok', authKind: a.authKind, ms: Date.now() - t0, secretVersion: a.secretVersion ?? null, keyFingerprint: a.keyFingerprint || '' };
  } catch (e) {
    const msg = String(e?.message || e);
    // 실패에도 비밀번호 판 · 키 지문을 싣는다 — 로그인 거부면 호출부가 계정 단위 정지를 건다(outcome.js).
    const meta = { secretVersion: a.secretVersion ?? null, keyFingerprint: a.keyFingerprint || '' };
    if (isPeerRejectText(msg)) return { ok: false, kind: 'hostkey', reason: '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.', ...meta };
    if (isAuthFailureText(msg)) return { ok: false, kind: 'auth-rejected', reason: '로그인이 거부됐습니다(다시 시도하지 않습니다 — 계정 잠금 방지).', ...meta };
    return { ok: false, kind: 'connect', reason: `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 100)})`, ...meta };
  }
}

/** 지정 뒤 이 서버가 쓸 단계(시뮬레이션 — 화면의 ‘닿는 서버’ 와 같은 규칙: OS 단계 → 법인 단계(OS 계열이 같을 때)). */
function levelAfter(s, corp, assignAfter, accById) {
  if (t(s.vcenterId) !== corp || t(s.agent) || hasOwnCred(s)) return '';
  if ((s.os === 'linux' || s.os === 'windows') && assignAfter[s.os]) return s.os;
  const all = assignAfter.all;
  if (!all) return '';
  const a = accById.get(all.account);
  return a && KS.accountFamily(a) === (s.os === 'windows' ? 'windows' : 'linux') ? 'all' : '';
}

/**
 * 계층 지정 쓰기(설정 소유자 등급 + 본인 OTP 라우트 뒤). accountId 빈 값 = 지우기.
 *  · 계정: OS 공통 계정 · 바꿔치기 아님 · 법인이 같거나 전 법인 · OS 단계면 OS 계열이 같다.
 *  · 이 지정을 지금 물려받게 되는 승인된 서버가 있으면 **그중 한 대(verifyServerId)로 먼저 로그인**해 본다 — 실패하면 저장하지 않는다.
 * @returns {Promise<object>} { ok, affected, verified? }
 */
export async function setAssignment({ corp, level, accountId = '', auth = '', verifyServerId = '', by = '', dryRun = false } = {}) {
  const si = storesIssue('바꾸지 않았습니다'); if (si) return si;
  const c = t(corp, 128);
  if (!(await corpList()).some((x) => x.id === c)) return { ok: false, code: 'bad-corp', status: 404, reason: '그런 법인(vCenter)이 없습니다.' };
  if (!ST.ASSIGN_LEVELS.includes(level)) return { ok: false, code: 'bad-level', reason: '단계는 법인 · Linux · Windows 중 하나입니다.' };
  const aid = t(accountId, 32);
  const accById = new Map(KS.listAccountsRaw().map((a) => [a.id, a]));
  let acc = null;
  if (aid) {
    acc = accById.get(aid);
    if (!acc || acc.kind !== 'os') return { ok: false, code: 'account-missing', status: 404, reason: 'OS 공통 계정을 찾을 수 없습니다.' };
    if (KS.isAccountTampered(acc.id)) return { ok: false, code: 'account-tampered', status: 409, reason: REFS.AUTH_ERROR['account-tampered'] };
    if (acc.corp && acc.corp !== c) return { ok: false, code: 'account-other-corp', status: 409, reason: '다른 법인의 공통 계정은 이 법인에 지정할 수 없습니다(전 법인 공용 계정 또는 이 법인 계정만).' };
    if (level !== 'all' && KS.accountFamily(acc) !== level) return { ok: false, code: 'account-os', status: 409, reason: `${LEVEL_TEXT[level]} 단계에는 ${LEVEL_TEXT[level]} 계정만 지정할 수 있습니다.` };
    if (!acc.password && !acc.keyRef) return { ok: false, code: 'no-secret', status: 409, reason: '키도 비밀번호도 없는 계정입니다.' };
  }
  const now = {};
  for (const lv of ST.ASSIGN_LEVELS) { const x = ST.assignFor(c, lv); if (x && !x.unreadable) now[lv] = x; }
  const after = { ...now };
  if (acc) after[level] = { account: acc.id, auth: auth === 'password' ? 'password' : '' }; else delete after[level];
  const servers = listBmServersRaw();
  // 지금 물려받는(승인된) 서버 중 이 단계로 오가는 서버 — 바뀌는 서버
  const affected = servers.filter((s) => inheritActive(s) && (levelAfter(s, c, now, accById) === level || levelAfter(s, c, after, accById) === level));
  const willUse = affected.filter((s) => levelAfter(s, c, after, accById) === level);
  let verified = null;
  if (acc && willUse.length) {
    const target = willUse.find((s) => s.id === t(verifyServerId, 64));
    if (!target) return { ok: false, code: 'need-verify', status: 409, reason: `이 지정을 지금 물려받는 서버 ${willUse.length}대 중 한 대를 골라 먼저 로그인해 보세요(저장 전 확인).`, candidates: willUse.slice(0, 50).map((s) => ({ id: s.id, name: s.name || s.host })) };
    if (dryRun) return { ok: true, dry: true };
    const r = await loginOnce(target, { accountId: acc.id, auth });
    noteCredOutcome({ ...target, credAccountId: acc.id, credAccountName: acc.name, ...(r.secretVersion != null ? { credVersion: r.secretVersion } : {}), keyFingerprint: r.keyFingerprint || '' },
      { ok: !!r.ok, rejected: !r.ok && r.kind === 'auth-rejected', code: r.kind, feature: 'conn-test', trigger: 'manual', by });
    if (!r.ok) return { ok: false, code: 'verify-failed', status: 409, reason: `${target.name || target.host} 에서 확인하지 못해 지정을 저장하지 않았습니다 — ${r.reason || r.kind}`, verified: { server: target.name || target.host, ok: false, kind: r.kind } };
    verified = { server: target.name || target.host, ok: true, kind: r.kind };
    if (r.secretVersion) { KS.markAccountVerified(acc.id, { serverName: target.name || target.host, secretVersion: r.secretVersion }); ST.clearAccountStop(acc.id, { by, accountName: acc.name, why: '계층 지정 저장 전 확인 성공' }); }
  }
  if (dryRun) return { ok: true, dry: true };
  const w = ST.setAssign(c, level, acc ? { account: acc.id, auth } : null, { by });
  if (!w.ok) return w;
  return { ok: true, affected: affected.length, willUse: willUse.length, ...(verified ? { verified } : {}) };
}

/**
 * 물려받기 승인(서버 여러 대) — 설정 소유자 등급 + 본인 OTP 라우트 뒤. clearOwn = ‘물려받기로 되돌리기’(서버 자기 자격을 떼면서).
 *  · 화면이 본 접속처(expectAddrs[id])를 서버마다 돌려받는다(낡은 화면 — setBmServerKeyRef 와 같은 규칙).
 *  · 화면이 본 승인 키(expectKeys[id] — 주소 · 포트 · OS · 법인)도 돌려받는다(반증 F8 — 본 뒤 OS · 법인이 바뀌면 다른 단계를 승인하게 된다).
 *  · 승인으로 지금 계정을 쓰게 되는 서버가 있으면 **계정(+ 로그인 방식)마다 한 대씩 먼저 로그인**해 본다(verifyServerId 가 그 묶음에 있으면 그 서버) —
 *    하나라도 실패하면 아무것도 승인하지 않는다(반증 F6 — Linux · Windows 를 함께 고르면 둘째 계정이 확인 없이 승인됐다). 계정이 4개를 넘으면 나눠 승인하게 한다.
 */
const APPROVE_MAX_ACCOUNTS = 4;
export async function approveInherit({ ids = [], expectAddrs = {}, expectKeys = {}, clearOwn = false, verifyServerId = '', by = '', dryRun = false } = {}) {
  const si = storesIssue('승인하지 않았습니다'); if (si) return si;
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => t(x, 64)).filter(Boolean))].slice(0, 1000);
  if (!list.length) return { ok: false, code: 'no-servers', reason: '서버를 고르세요.' };
  const byId = new Map(listBmServersRaw().map((s) => [s.id, s]));
  const accById = new Map(KS.listAccountsRaw().map((a) => [a.id, a]));
  const targets = [];
  for (const id of list) {
    const s = byId.get(id);
    if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다(그 사이 지워짐).' };
    if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: `${s.name || s.host} 는 엣지가 수집하는 서버입니다 — 그 엣지 포탈에서 정합니다.` };
    const ea = typeof expectAddrs === 'object' && expectAddrs ? expectAddrs[id] : null;
    if (typeof ea !== 'string' || ea !== regAddrOf(s)) return { ok: false, code: 'moved', status: 409, reason: `${s.name || s.host} 의 주소 · 포트 · 계정이 화면과 다릅니다 — 화면을 다시 읽으세요.` };
    const ek = typeof expectKeys === 'object' && expectKeys ? expectKeys[id] : null;
    if (typeof ek !== 'string' || ek !== inheritKeyOf(s)) return { ok: false, code: 'moved', status: 409, reason: `${s.name || s.host} 의 OS 종류 · 법인이 화면과 다릅니다 — 화면을 다시 읽으세요.` };
    if (!clearOwn && hasOwnCred(s)) return { ok: false, code: 'has-own', status: 409, reason: `${s.name || s.host} 는 따로 정한 계정이 있습니다 — ‘물려받기로 되돌리기’ 로 승인하세요.` };
    // 승인 뒤 쓸 계정(시뮬레이션 — 승인 칸만 세운 사본으로 같은 판정)
    const sim = { ...s, keyRef: clearOwn ? '' : s.keyRef, credRef: clearOwn ? '' : s.credRef, osAuth: clearOwn ? '' : s.osAuth, password: clearOwn ? '' : s.password, inherit: { key: inheritKeyOf(s) } };
    const ef = REFS.effectiveAccountOf(sim);
    targets.push({ s, ef });
  }
  const using = targets.filter((x) => x.ef.source === 'os' || x.ef.source === 'corp');
  const groups = new Map();   // `${계정}|${로그인 방식}` → 그 계정을 쓰게 되는 서버들
  for (const x of using) { const k = `${x.ef.accountId}|${x.ef.auth || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  if (groups.size > APPROVE_MAX_ACCOUNTS) return { ok: false, code: 'too-many-accounts', status: 409, reason: `고른 서버들이 쓰게 될 공통 계정이 ${groups.size}개입니다 — ${APPROVE_MAX_ACCOUNTS}개 이하로 나눠 승인하세요(계정마다 한 대씩 먼저 확인합니다).` };
  if (dryRun) return { ok: true, dry: true };
  const verifiedAll = [];
  for (const xs of groups.values()) {
    const pick = xs.find((x) => x.s.id === t(verifyServerId, 64)) || xs[0];
    const acc = accById.get(pick.ef.accountId);
    if (!acc) return { ok: false, code: 'account-missing', status: 409, reason: REFS.AUTH_ERROR['account-missing'] };
    const r = await loginOnce(pick.s, { accountId: acc.id, auth: pick.ef.auth });
    noteCredOutcome({ ...pick.s, credAccountId: acc.id, credAccountName: acc.name, ...(r.secretVersion != null ? { credVersion: r.secretVersion } : {}), keyFingerprint: r.keyFingerprint || '' },
      { ok: !!r.ok, rejected: !r.ok && r.kind === 'auth-rejected', code: r.kind, feature: 'conn-test', trigger: 'manual', by });
    if (!r.ok) return { ok: false, code: 'verify-failed', status: 409, reason: `${pick.s.name || pick.s.host}(${acc.name}) 에서 확인하지 못해 아무것도 승인하지 않았습니다 — ${r.reason || r.kind}`, verified: { server: pick.s.name || pick.s.host, account: acc.name, ok: false, kind: r.kind }, verifiedAll };
    verifiedAll.push({ server: pick.s.name || pick.s.host, account: acc.name, ok: true, kind: r.kind });
  }
  const verified = verifiedAll.length ? { ...verifiedAll[0], server: verifiedAll.map((v) => v.server).join(' · ') } : null;
  const done = []; const failed = [];
  for (const { s } of targets) {
    const w = setBmServerInherit(s.id, { on: true, clearOwn: !!clearOwn, expectAddr: regAddrOf(s), expectKey: inheritKeyOf(s), by });
    if (w.ok) done.push(s.id); else failed.push({ id: s.id, name: s.name || s.host, code: w.code, reason: w.reason });
  }
  return { ok: failed.length === 0, approved: done.length, ...(failed.length ? { code: 'partial', status: 409, reason: `${failed.length}대는 승인하지 못했습니다.`, failed } : {}), ...(verified ? { verified, verifiedAll } : {}), using: using.length };
}

/** 승인 거두기(서버 하나) — 그 서버는 계층 지정을 쓰지 않는다(따로 정한 계정이 없으면 ‘미설정’). */
export function revokeInherit({ serverId, expectAddr = null, by = '' } = {}) {
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (typeof expectAddr !== 'string' || !expectAddr) return { ok: false, code: 'need-addr', status: 400, reason: '화면에서 본 서버 접속처가 없습니다 — 화면을 다시 읽으세요.' };
  const w = setBmServerInherit(s.id, { on: false, expectAddr, by });
  return w.ok ? { ok: true } : w;
}

/** ‘따로 정하기 — 다른 공통 계정’(chooseServerKey 와 같은 꼴): 같은 주소에 계정만 바꾸고 한 번 접속해 본 뒤 실패하면 되돌린다. */
export async function chooseServerAccount({ serverId, accountId, expectAddr = null, by = '' } = {}) {
  const si = storesIssue('바꾸지 않았습니다'); if (si) return si;
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 계정은 그 엣지 포탈에서 고릅니다.' };
  if (typeof expectAddr !== 'string' || !expectAddr) return { ok: false, code: 'need-addr', status: 400, reason: '화면에서 본 서버 접속처가 없습니다 — 화면을 다시 읽은 뒤 고르세요.' };
  const acc = KS.accountById(t(accountId, 32));
  if (!acc || acc.kind !== 'os') return { ok: false, code: 'account-missing', status: 404, reason: 'OS 공통 계정을 찾을 수 없습니다.' };
  if (KS.isAccountTampered(acc.id)) return { ok: false, code: 'account-tampered', status: 409, reason: REFS.AUTH_ERROR['account-tampered'] };
  if (acc.corp && t(s.vcenterId) && acc.corp !== t(s.vcenterId)) return { ok: false, code: 'account-other-corp', status: 409, reason: '다른 법인의 공통 계정입니다.' };
  if ((s.os === 'linux' || s.os === 'windows') && KS.accountFamily(acc) !== s.os) return { ok: false, code: 'account-os', status: 409, reason: REFS.AUTH_ERROR['account-os'] };
  const w = setBmServerCredRef(s.id, acc.id, { expectAddr });
  if (!w.ok) return w;
  const after = listBmServersRaw().find((x) => x.id === s.id);
  const test = after ? await testServer(after, { by }) : { ok: false, kind: 'gone', reason: '서버가 그 사이 지워졌습니다.' };
  if (test.ok) return { ok: true, test };
  const back = restoreBmServerAccess(s.id, w.previous);
  return back.ok
    ? { ok: false, code: 'test-failed', status: 409, reason: `고른 계정으로 접속하지 못해 이전 설정으로 되돌렸습니다 — ${test.reason || test.kind}`, test, reverted: true }
    : { ok: false, code: 'test-failed', status: 409, reason: `고른 계정으로 접속하지 못했고 이전 설정으로 되돌리지도 못했습니다 — ${test.reason || test.kind}`, test, reverted: false, revertError: back.reason };
}

/**
 * 서버 OS 종류(여러 대 · 한 번 쓰기). os = 'linux' | 'windows' | ''(미지정) | 'detected'(수집이 알아낸 OS — OS 종류가 비어 있는 서버만 · 저절로 바꾸지 않는다).
 * OS 가 바뀌면 그 서버의 물려받기 승인은 효력을 잃는다(registry.inheritActive — 다시 승인해야 한다 · 응답 inheritLost 가 대수를 말한다).
 */
export function setServersOs({ ids = [], os = '' } = {}) {
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
  const want = new Set((Array.isArray(ids) ? ids : []).map((x) => t(x, 64)).filter(Boolean));
  if (!want.size) return { ok: false, code: 'no-servers', reason: '서버를 고르세요.' };
  const v = t(os, 16);
  if (v && v !== 'detected' && !SERVER_OS.includes(v)) return { ok: false, code: 'bad-os', reason: 'OS 는 Linux · Windows · 미지정 중 하나입니다.' };
  const list = listBmServersRaw().filter((s) => want.has(s.id));
  const map = {}; const clear = [];
  for (const s of list) {
    if (v === 'detected') { if (!s.os) { const d = detectedOsOf(s); if (d) map[s.id] = d; } }
    else if (v) { if (s.os !== v) map[s.id] = v; }
    else if (s.os) clear.push(s.id);
  }
  const lost = list.filter((s) => inheritActive(s) && (Object.hasOwn(map, s.id) || clear.includes(s.id))).length;
  let changed = 0;
  if (Object.keys(map).length) { const w = setBmServersOs(map); if (!w.ok) return w; changed += w.changed; }
  for (const id of clear) { const w = setBmServerOs(id, ''); if (!w.ok) return { ...w, partial: { changed } }; if (w.changed) changed += 1; }
  return { ok: true, changed, skipped: list.length - changed, inheritLost: lost };
}

/**
 * 공통 계정 저장(서버 접속 화면 — 설정 소유자 등급 + 본인 OTP 뒤). 새 비밀번호를 넣고 그 계정을 쓰는 서버가 있으면
 * **그중 한 대(verifyServerId)로 저장 전에 로그인해 본다**(저장하지 않은 비밀번호로 — 실패하면 저장하지 않는다 · 다시 시도하지 않는다).
 * 판정(이름 · OS · 도메인 · 암호화 정책 · 쓰는 서버 · 계층 지정 충돌)은 keyStore.saveAccount(dryRun) · refs.accountUseIssue 그대로.
 */
export async function saveAccountChecked({ input = {}, verifyServerId = '', by = '', dryRun = false } = {}) {
  const si = storesIssue('저장하지 않았습니다'); if (si) return si;
  const dry = KS.saveAccount(input, { dryRun: true });
  if (!dry.ok) return dry;
  if (dry.next.kind !== 'os') return { ok: false, code: 'account-kind', reason: '서버 접속 화면은 OS 공통 계정만 다룹니다(iDRAC 계정은 베어메탈 사용률 › 계정에서).' };
  const before = input.id ? KS.accountById(t(input.id, 32)) : null;
  const use = REFS.accountUseIssue(before, dry.next);
  if (use) return use;
  const pw = input.password;
  const provided = typeof pw === 'string' && pw !== '' && pw !== '********';
  let verified = null;
  if (provided && before) {
    const servers = listBmServersRaw().filter((s) => !t(s.agent) && REFS.effectiveAccountOf(s).accountId === before.id && (REFS.effectiveAccountOf(s).source === 'own' || inheritActive(s)));
    if (servers.length) {
      const target = servers.find((s) => s.id === t(verifyServerId, 64));
      if (!target) return { ok: false, code: 'need-verify', status: 409, reason: `이 계정을 쓰는 서버 ${servers.length}대 중 한 대를 골라 새 비밀번호로 먼저 로그인해 보세요(저장 전 확인).`, candidates: servers.slice(0, 50).map((s) => ({ id: s.id, name: s.name || s.host })) };
      if (dryRun) return { ok: true, dry: true };
      const probe = { ...before, ...dry.next, username: t(input.username ?? before.username, 128), os: dry.next.os, logon: dry.next.logon, domain: dry.next.domain, kind: 'os' };
      const r = await loginOnce(target, { candidate: { username: KS.loginNameOf(probe), password: pw } });
      if (!r.ok) return { ok: false, code: 'verify-failed', status: 409, reason: `${target.name || target.host} 에서 새 비밀번호로 로그인하지 못해 저장하지 않았습니다 — ${r.reason || r.kind}`, verified: { server: target.name || target.host, ok: false, kind: r.kind } };
      verified = { server: target.name || target.host, ok: true };
    }
  }
  if (dryRun) return { ok: true, dry: true };
  const r = KS.saveAccount(input, { by });
  if (!r.ok) return r;
  if (verified) {
    const saved = KS.accountById(r.account.id);
    KS.markAccountVerified(r.account.id, { serverName: verified.server, secretVersion: KS.accountSecretVersion(saved) });
    ST.clearAccountStop(r.account.id, { by, accountName: r.account.name, why: '새 비밀번호 저장 전 확인 성공' });
  }
  return { ...r, ...(verified ? { verified } : {}) };
}

/** ‘한 대로 다시 확인’ — 그 계정을 쓰는 서버 한 대로 지금 저장된 자격으로 한 번 로그인. 성공하면 계정 단위 정지를 풀고 확인 기록을 남긴다. */
export async function verifyAccount({ accountId, serverId, by = '' } = {}) {
  const si = storesIssue('확인하지 않았습니다'); if (si) return si;
  const acc = KS.accountById(t(accountId, 32));
  if (!acc || acc.kind !== 'os') return { ok: false, code: 'account-missing', status: 404, reason: 'OS 공통 계정을 찾을 수 없습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다.' };
  const ea = REFS.effectiveAccountOf(s);
  const uses = ea.accountId === acc.id && (ea.source === 'own' || ea.source === 'os' || ea.source === 'corp');
  if (!uses) return { ok: false, code: 'not-using', status: 409, reason: '이 서버는 이 계정을 쓰지 않습니다 — 이 계정을 쓰는 서버로 확인하세요.' };
  const r = await loginOnce(s, { accountId: acc.id, auth: ea.auth || (s.osAuth === 'password' ? 'password' : ''), ignoreAccountStop: true });
  noteCredOutcome({ ...s, credAccountId: acc.id, credAccountName: acc.name, ...(r.secretVersion != null ? { credVersion: r.secretVersion } : {}), keyFingerprint: r.keyFingerprint || '' },
    { ok: !!r.ok, rejected: !r.ok && r.kind === 'auth-rejected', code: r.kind, feature: 'conn-test', trigger: 'manual', by });
  if (!r.ok) return { ok: false, code: 'verify-failed', status: 409, reason: r.reason || r.kind, kind: r.kind };
  if (r.secretVersion) KS.markAccountVerified(acc.id, { serverName: s.name || s.host, secretVersion: r.secretVersion });
  const c = ST.clearAccountStop(acc.id, { by, accountName: acc.name, why: `${s.name || s.host} 에서 다시 확인 성공` });
  return { ok: true, server: s.name || s.host, resumed: !c.already };
}

/** 계정 단위 정지를 사람이 푼다(비밀번호를 고치지 않고 — 서버 쪽 잠금을 푼 뒤 등). */
export function resumeAccount({ accountId, by = '' } = {}) {
  const acc = KS.accountById(t(accountId, 32));
  if (!acc) return { ok: false, code: 'account-missing', status: 404, reason: '공통 계정을 찾을 수 없습니다.' };
  return ST.clearAccountStop(acc.id, { by, accountName: acc.name, why: '사람이 풂' });
}
