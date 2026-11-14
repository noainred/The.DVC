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
import { listBmServersRaw, registryLoadError as bmRegistryLoadError, setBmServerKeyRef, restoreBmServerKeyRef } from '../bmstor/registry.js';
import { loadSecretsPolicy } from '../security/secretVault.js';
import * as ST from './state.js';
import * as INS from './installed.js';
import * as INB from './inbox.js';
import { noteKeyUse, keyUsageView, flushKeyUsage, lastUseByFingerprint, keyUsageLoadFailed } from './usage.js';
import { buildKeyCheck, checkKeyDrift } from './check.js';
import { READ_COMMAND, parseReadOutput } from './authorizedKeys.js';

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
  const pubServers = servers.filter((s) => !s.addrOnly).map((s) => ({ ...publicServer(s, { accById, keyById }), inboxPath: t(s.vcenterId) ? INB.inboxPathOf(s.vcenterId, s.name || s.host) : '' }));
  // 키 점검 ‘서버’ 칸 — 키를 쓰는데 폴더 · 기능 규칙 때문에 주기 수집이 막힌 서버, 법인이 없어 폴더 키를 못 쓰는 서버(엣지 위임 서버는 그 엣지가 본다).
  const keyed = pubServers.filter((s) => s.keyId && !s.agent);
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
    accounts: accRaw.filter((a) => a.kind === 'os').map((a) => KS.publicAccountView(a, { usage: usage.account(a.id) })),
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
  let rec;
  try {
    const out = await withSsh({ host: String(s.host), port: Number(s.port) || 22, username: auth.username, password: auth.password || '', privateKey: auth.privateKey, passphrase: auth.passphrase, readyTimeout: 15_000 },
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
  const servers = corpServers.map((s) => ({ id: s.id, addr: addrKey(s.host, s.port, usernameOf(s, t(s.credRef) ? accById.get(t(s.credRef)) : null)) }));
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
