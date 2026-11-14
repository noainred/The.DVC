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
 *  · 서버 키 고르기 = 폴더 규칙(`refs.keyPlacementIssue`) → 등록부 `setBmServerKeyRef`(같은 주소 · 키만) → 연결 확인 → 실패면 **이전 설정으로 되돌린다**.
 */
import { store } from '../store.js';
import { config } from '../config.js';
import * as KS from '../bmusage/onboard/keyStore.js';
import * as REFS from '../bmusage/onboard/refs.js';
import { listBmServersRaw, registryLoadError as bmRegistryLoadError, setBmServerKeyRef, restoreBmServerKeyRef } from '../bmstor/registry.js';
import { loadSecretsPolicy } from '../security/secretVault.js';
import * as ST from './state.js';
import * as INB from './inbox.js';
import { noteKeyUse, keyUsageView, flushKeyUsage } from './usage.js';
import { buildKeyCheck, verifyKeyIntegrity } from './check.js';
import { READ_COMMAND, parseReadOutput } from './authorizedKeys.js';

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const lc = (v) => t(v).toLowerCase();

/** 기능 목록(화면 · 키의 ‘쓸 수 있는 기능’). id 는 keyStore.KEY_FEATURES 와 같다(테스트가 대조). */
export const FEATURE_CATALOG = Object.freeze([
  Object.freeze({ id: 'bm-usage', label: '베어메탈 사용률', tool: 'bm-usage', note: 'CPU · 메모리 · 디스크 · 네트워크 · HBA 수집(집중 모니터링 · 저활용 포함)' }),
  Object.freeze({ id: 'bm-storage', label: '베어메탈 스토리지', tool: 'bm-storage', note: '마운트 용량(df) 수집' }),
  Object.freeze({ id: 'disk-audit', label: '디스크 오류 이력 점검', tool: 'disk-audit', note: '로그 · SMART · RAID 기록에서 매체 오류 흔적 찾기(읽기 전용)' }),
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

function publicServer(s, { accById, keyById, now }) {
  const effKey = effectiveKeyId(s, accById);
  const key = effKey ? keyById.get(effKey) : null;
  const acc = t(s.credRef) ? accById.get(t(s.credRef)) : null;
  const inst = ST.installedOf(s.id);
  const placement = key ? REFS.keyPlacementIssue(key, s, 'conn-test') : null;
  return {
    id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, vcenterId: t(s.vcenterId), agent: t(s.agent), enabled: s.enabled !== false,
    username: acc ? acc.username : (t(s.username) || 'root'), accountName: acc ? acc.name : '', accountMissing: !!t(s.credRef) && !acc,
    keyMode: t(s.keyRef) ? 'pinned' : (effKey ? 'corp-default' : (s.osAuth === 'password' || s.password || (acc && acc.password) ? 'password' : 'none')),
    keyId: effKey || '', keyName: key ? key.name : '', keyFingerprint: key ? key.fingerprint : '', keyMissing: !!effKey && !key,
    keyStatus: key ? key.status : '', placementIssue: placement || '',
    hasPassword: !!s.password, passwordPinned: s.osAuth === 'password',
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
  const kuse = keyUsageView({ limit: 1 });
  const lastUseByFp = new Map();
  for (const r of kuse.rows) { const p = lastUseByFp.get(r.fingerprint); if (!p || r.lastAt > p.lastAt) lastUseByFp.set(r.fingerprint, { lastAt: r.lastAt, server: r.server, feature: r.feature, ok: r.lastOk }); }
  let edgeRows = [];
  try { edgeRows = (await import('../bmusage/onboard/edgeDeploy.js')).allEdgeRows().map((r) => ({ agent: r.agent, name: t(r.name, 128), corp: t(r.corp, 128), osHost: t(r.osHost, 256), osCred: t(r.osCred, 64), osKey: t(r.osKey, 64), osUser: t(r.osUser, 128) })); } catch { edgeRows = []; }
  let policyMode = '';
  try { policyMode = loadSecretsPolicy()?.mode || ''; } catch { policyMode = ''; }
  const inbox = await INB.scanInbox({ corps, servers: servers.map((s) => ({ id: s.id, name: s.name || s.host, vcenterId: t(s.vcenterId) })) });
  const corpName = (id) => corps.find((c) => c.id === id)?.name || id || '전 법인';
  return {
    at: now,
    isEdge: !!config.agent?.centralUrl,
    policyMode,
    storeUnreadable: !!storeErr, registryUnreadable: !!regErr, stateUnreadable: !!ST.stateLoadError(),
    corps: corps.map((c) => ({ ...c, inboxPath: INB.inboxPathOf(c.id), stop: ST.stopFor(c.id) })),
    accounts: accRaw.filter((a) => a.kind === 'os').map((a) => KS.publicAccountView(a, { usage: usage.account(a.id) })),
    keys: keysRaw.map((k) => ({ ...KS.publicKeyView(k, { usage: usage.key(k.id), now }), lastUse: lastUseByFp.get(k.fingerprint) || null,
      inboxPath: k.folderCorp ? INB.inboxPathOf(k.folderCorp, k.folderServer) : '' })),
    usageKnown: usage.known,
    servers: servers.filter((s) => !s.addrOnly).map((s) => ({ ...publicServer(s, { accById, keyById, now }), inboxPath: t(s.vcenterId) ? INB.inboxPathOf(s.vcenterId, s.name || s.host) : '' })),
    edgeRows,
    features: FEATURE_CATALOG,
    inbox: { dir: inbox.dir, exists: inbox.exists, items: inbox.items, unknownFolders: inbox.unknownFolders, truncated: inbox.truncated },
    check: buildKeyCheck({ now, policyMode, inbox, integrity: _lastIntegrity, corpName }),
    stops: ST.listStops(),
    events: ST.listEvents({ limit: 50 }),
    tampered: KS.tamperedKeyIds(),
  };
}

let _lastIntegrity = null;

/* ── 서버의 키 고르기(시안 ⑥ SshPick) ─────────────────────────────────── */

/**
 * @param {{serverId:string, keyId:string, expectHost?:string, by:string}} o  keyId 빈 값 = 법인 기본 키(공통 계정)를 따름
 * @returns {Promise<object>} { ok, test, reverted?, previous? } — 실패면 code · reason · status
 */
export async function chooseServerKey({ serverId, keyId, expectHost = null, by = '' } = {}) {
  if (KS.keyStoreLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'SSH 키 저장소를 읽지 못해 바꾸지 않았습니다.' };
  if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 바꾸지 않았습니다.' };
  const s = listBmServersRaw().find((x) => x.id === t(serverId, 64));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (t(s.agent)) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 키는 그 엣지 포탈의 SSH 공용 접속에서 고릅니다(키는 법인 밖으로 나가지 않습니다).' };
  const kid = t(keyId, 32);
  if (kid) {
    const k = KS.keyById(kid);
    if (!k) return { ok: false, code: 'key-missing', status: 404, reason: '키를 찾을 수 없습니다.' };
    if (k.status !== 'active') return { ok: false, code: 'key-retired', reason: '퇴역한 키는 고를 수 없습니다.' };
    const pi = REFS.keyPlacementIssue(k, s, 'conn-test');
    if (pi) return { ok: false, code: pi, status: 409, reason: REFS.AUTH_ERROR[pi] };
  } else if (!t(s.credRef)) {
    return { ok: false, code: 'no-account', status: 409, reason: '이 서버는 법인 공통 계정을 쓰지 않아 ‘법인 기본 키를 따름’ 을 고를 수 없습니다 — 키를 이름으로 고르세요.' };
  }
  const w = setBmServerKeyRef(s.id, kid, { expectHost });
  if (!w.ok) return w;
  const after = listBmServersRaw().find((x) => x.id === s.id);
  const test = await testServer(after, { by });
  if (test.ok) return { ok: true, test, previous: w.previous };
  const back = restoreBmServerKeyRef(s.id, w.previous);
  return { ok: false, code: 'test-failed', status: 409, reason: `고른 키로 접속하지 못해 이전 설정으로 되돌렸습니다 — ${test.reason || test.kind}`, test, reverted: !!back.ok,
    ...(back.ok ? {} : { revertError: back.reason }) };
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
  const inst = ST.installedOf(s.id);
  const instFps = inst && !inst.error && inst.host === s.host ? new Set(inst.keys.map((k) => k.fingerprint)) : null;
  const effKey = effectiveKeyId(s, accById);
  const keys = KS.listKeysRaw().map((k) => {
    const issue = k.status !== 'active' ? 'key-retired' : (REFS.keyPlacementIssue(k, s, 'conn-test') || '');
    return { id: k.id, name: k.name, algo: k.algo, bits: k.bits, fingerprint: k.fingerprint, status: k.status,
      folder: !k.folderCorp ? 'none' : (k.folderServer ? 'server' : 'common'), folderCorp: k.folderCorp, folderServer: k.folderServer,
      features: Array.isArray(k.features) ? [...k.features] : null, selectable: !issue, issue, current: k.id === effKey,
      installed: instFps ? instFps.has(k.fingerprint) : null };
  }).filter((k) => k.selectable || k.current || (k.folderCorp && k.folderCorp === t(s.vcenterId)));
  const order = { server: 0, common: 1, none: 2 };
  keys.sort((a, b) => (order[a.folder] - order[b.folder]) || a.name.localeCompare(b.name));
  return {
    ok: true,
    server: { id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, vcenterId: t(s.vcenterId), keyMode: t(s.keyRef) ? 'pinned' : (effKey ? 'corp-default' : 'other') },
    corpDefault: acc && acc.kind === 'os' ? { accountName: acc.name, username: acc.username, keyId: acc.keyRef || '', keyName: acc.keyRef ? (KS.keyById(acc.keyRef)?.name || '') : '' } : null,
    keys,
    installed: inst ? { at: inst.at, by: inst.by, file: inst.file, error: inst.error || '', stale: inst.host !== s.host,
      keys: inst.keys.map((k) => { const m = KS.listKeysRaw().find((x) => x.fingerprint === k.fingerprint); return { ...k, keyId: m ? m.id : '', keyName: m ? m.name : '' }; }) } : null,
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
  const saved = ST.noteInstalled(s.id, { ...rec, by: t(by, 64) });
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
  if (folderCorp !== undefined || folderServer !== undefined) { const fi = folderTargetIssue(nextCorp, nextServer); if (fi) return { ok: false, code: 'bad-folder', reason: fi }; }
  const probe = { folderCorp: nextCorp, folderServer: nextServer, features: null };
  const conflicts = [];
  if (folderCorp !== undefined || folderServer !== undefined) {
    if (bmRegistryLoadError()) return { ok: false, code: 'usage-unknown', status: 503, reason: 'OS 계정 등록부를 읽지 못해 이 키를 쓰는 서버를 모릅니다 — 폴더를 바꾸지 않았습니다.' };
    const accById = new Map(KS.listAccountsRaw().map((a) => [a.id, a]));
    for (const s of listBmServersRaw()) {
      if (effectiveKeyId(s, accById) !== k.id) continue;
      if (REFS.keyPlacementIssue(probe, s, 'conn-test')) conflicts.push({ kind: 'server', name: s.name || s.host, corp: t(s.vcenterId) });
    }
    for (const a of accById.values()) {
      if (a.kind !== 'os' || a.keyRef !== k.id) continue;
      if (nextServer) conflicts.push({ kind: 'account', name: a.name, corp: a.corp, why: 'server-folder' });
      else if (nextCorp && a.corp !== nextCorp) conflicts.push({ kind: 'account', name: a.name, corp: a.corp, why: 'other-corp' });
    }
  }
  if (conflicts.length) return { ok: false, code: 'folder-conflict', status: 409, reason: `이 키를 쓰는 곳 ${conflicts.length}개가 새 폴더 밖이 됩니다 — 그 서버 · 공통 계정의 키를 먼저 바꾸세요(서버별 폴더 키는 공통 계정의 기본 키가 될 수 없습니다).`, conflicts: conflicts.slice(0, 50) };
  return KS.updateKeyPlacement(k.id, {
    ...(folderCorp !== undefined ? { folderCorp: nextCorp } : {}), ...(folderServer !== undefined || folderCorp !== undefined ? { folderServer: nextServer } : {}),
    ...(features !== undefined ? { features } : {}),
  });
}

/* ── 받는 곳(inbox) ───────────────────────────────────────────────────── */

export async function approveInbox({ relPath, fingerprint, name, passphrase = '', features, by = '' } = {}) {
  const slugs = INB.slugsOf(relPath);
  if (!slugs) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다.' };
  const corps = await corpList();
  const corp = corps.find((c) => INB.folderSlug(c.id) === slugs.corpSlug);
  if (!corp) return { ok: false, code: 'unknown-folder', status: 409, reason: '폴더 이름이 지금 있는 법인과 맞지 않습니다.' };
  let server = '';
  if (slugs.serverSlug) {
    if (bmRegistryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못했습니다.' };
    const s = listBmServersRaw().find((x) => t(x.vcenterId) === corp.id && INB.folderSlug(x.name || x.host) === slugs.serverSlug);
    if (!s) return { ok: false, code: 'unknown-folder', status: 409, reason: '폴더 이름이 그 법인의 서버와 맞지 않습니다.' };
    server = s.name || s.host;
  }
  const rd = INB.readForApproval(relPath, fingerprint, passphrase);
  if (!rd.ok) return rd;
  const r = KS.addKey({ name, privateKey: rd.pem, passphrase, folderCorp: corp.id, folderServer: server, features: features === undefined ? [] : features }, { by });
  if (!r.ok) return r;
  const rm = INB.removeInboxFile(relPath);
  ST.addEvent({ kind: 'inbox-approved', corp: corp.id, target: r.key.name, by, detail: `${r.key.fingerprint}${rm.ok ? '' : ' · 평문 파일 삭제 실패'}` });
  return { ok: true, key: r.key, plaintextRemoved: !!rm.ok, ...(rm.ok ? {} : { plaintextLeft: true, removeError: rm.reason }) };
}

export function discardInbox({ relPath, by = '' } = {}) {
  const slugs = INB.slugsOf(relPath);
  if (!slugs) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다.' };
  const r = INB.removeInboxFile(relPath);
  if (r.ok) ST.addEvent({ kind: 'inbox-discarded', target: t(relPath, 120), by });
  return r;
}

/* ── 사용 기록 ────────────────────────────────────────────────────────── */
export function usageView({ fingerprint = '', limit = 200 } = {}) { return keyUsageView({ fingerprint, limit }); }

/* ── 주기 점검(기동 뒤 · 10분마다) ────────────────────────────────────── */
let _timer = null;
let _seenInbox = null;
let _running = false;
export const SCAN_EVERY_MS = 10 * 60_000;

/** 한 번 — 무결성 확인 · 받는 곳의 새 파일 · 지워진 서버의 읽은 결과 정리 · 사용 기록 쓰기. 사건만 남긴다(알림 메일은 2단계). */
export async function runSshAccessScan({ now = Date.now() } = {}) {
  if (_running) return { skipped: true };
  _running = true;
  try {
    const before = new Set(KS.tamperedKeyIds());
    _lastIntegrity = { ...(await verifyKeyIntegrity()), at: now };
    for (const id of _lastIntegrity.mismatch) if (!before.has(id)) { const k = KS.keyById(id); ST.addEvent({ kind: 'key-tampered', corp: k?.folderCorp || '', target: k?.name || id, detail: k?.fingerprint || '' }); }
    const corps = await corpList();
    const servers = bmRegistryLoadError() ? [] : listBmServersRaw();
    const ib = await INB.scanInbox({ corps, servers: servers.map((s) => ({ id: s.id, name: s.name || s.host, vcenterId: t(s.vcenterId) })) });
    if (!_seenInbox) _seenInbox = new Set(ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'inbox-new').map((e) => e.detail));
    for (const it of ib.items) {
      if (it.code !== 'ready' && !it.needPassphrase) continue;
      const sig = `${it.relPath}|${it.fingerprint || it.size}`;
      if (_seenInbox.has(sig)) continue;
      _seenInbox.add(sig);
      ST.addEvent({ kind: 'inbox-new', corp: it.corp, target: it.relPath, detail: sig });
    }
    if (!bmRegistryLoadError()) ST.pruneInstalled(new Set(servers.map((s) => s.id)));
    flushKeyUsage({ now });
    return { ok: true, integrity: _lastIntegrity, inbox: ib.items.length };
  } finally { _running = false; }
}

/** 기동 시 한 번 등록(index.js). 첫 실행은 FIRST_DELAY 뒤(기동 직후 부하를 피한다). */
export function startSshAccessScheduler({ firstDelayMs = 90_000 } = {}) {
  if (_timer) return;
  const run = () => { runSshAccessScan().catch((e) => console.warn(`[ssh-access] 주기 점검 실패: ${String(e?.message || e).slice(0, 160)}`)); };
  const first = setTimeout(() => { run(); _timer = setInterval(run, SCAN_EVERY_MS); _timer.unref?.(); }, firstDelayMs);
  first.unref?.();
  _timer = first;
}
export function _resetSshAccessServiceForTest() { if (_timer) { clearTimeout(_timer); clearInterval(_timer); } _timer = null; _seenInbox = null; _lastIntegrity = null; _running = false; }
