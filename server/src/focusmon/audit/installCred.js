/**
 * focusmon/audit/installCred.js — 디스크 점검 프로그램 **자동 설치에 쓸 계정**(v3.17.0 · 사용자 '등록된 SSH 키 계정 사용' · 시안 ⑱ §21 · 컨펌 ① ② ③).
 *
 * 그 서버를 **맡은 노드**(중앙 직접 · 엣지)가 자기 SSH 공용 접속(7b 키 저장소 `ssh-keys.json` · 서버 등록부 `bm-storage.json`)에서 고른다 — 키는 노드 밖으로 나가지 않는다.
 *  ① 같은 주소 · 포트로 등록된 SSH 공용 접속 서버(이 노드가 직접 맡은 것 — agent '')가 **하나**면 그 서버의 접속 자격(서버 키 → 공통 계정의 기본 키).
 *     둘 이상이면 잇지 않는다('dup' — 어느 것인지 모른다). 그 서버의 자격이 비밀번호면 자동 설치에 쓰지 않는다('password').
 *  ② 없으면 그 법인의 OS 공통 계정 가운데 키가 ‘설치’ 기능을 켠 것 — 하나면 그것 · 둘 이상이면 화면에서 고른다('ambig' + choices).
 *     중앙: 대상의 법인(DataCenter) → 그 법인의 vCenter 들(datacenters.json 할당)과 계정 법인(vCenter id)을 맞춘다.
 *     엣지: 엣지 포탈에 등록한 계정 가운데 법인이 정해진 것(엣지는 그 법인의 노드다 — 중앙의 DataCenter id 를 모른다). 전 법인 공용('' 법인) 계정은 쓰지 않는다.
 *  · **‘설치’ 기능(`disk-audit-install`)을 직접 켠 키만**(컨펌 ②) — 기능 목록이 없는 예전 키는 다른 기능에는 그대로 쓰여도 root 설치에는 쓰지 않는다.
 *  · 사용 중지 · 키 폴더 · 바뀐 키 감시는 `refs.resolveOsAuth` 하나를 그대로 지난다(판정을 복제하지 않는다).
 *  · 비밀(개인키 · passphrase)은 `withAuth` 일 때만 돌려준다 — 화면 · 응답 · 엣지 보고에는 상태 · 계정 이름 · 키 이름만.
 */
import { listBmServersRaw, registryLoadError as bmLoadError } from '../../bmstor/registry.js';
import * as KS from '../../bmusage/onboard/keyStore.js';
import { resolveOsAuth } from '../../bmusage/onboard/refs.js';

export const INSTALL_FEATURE = 'disk-audit-install';
/** v3.18.0 접속 자동 준비(수집 계정 · 공개키) — 같은 찾는 순서 · 같은 '직접 켠 키만' 규칙, 기능만 다르다. */
export const PREP_FEATURE = 'focus-mon-prep';
export const CRED_FEATURES = Object.freeze([INSTALL_FEATURE, PREP_FEATURE]);
/** 상태(화면 문구 키 — 웹 `focusMonAuditInstallText.js CRED_TEXT` 와 같다 · 시험 대조). */
export const CRED_STATES = Object.freeze(['ok', 'feature', 'noentry', 'ambig', 'dup', 'password', 'stopped', 'folder', 'key-missing', 'unreadable', 'error']);
const t = (v) => String(v ?? '').trim();
const explicit = (key, feature = INSTALL_FEATURE) => !!key && Array.isArray(key.features) && key.features.includes(feature);
const CODE_STATE = { 'corp-stopped': 'stopped', 'state-unreadable': 'unreadable', 'store-unreadable': 'unreadable', 'key-feature': 'feature', 'key-folder': 'folder', 'key-missing': 'key-missing', 'account-missing': 'key-missing' };

/** 한 자격(해석된 원본) → 상태 · 이름(비밀은 withAuth 일 때만). */
function fromAuth(a, keyId, src, withAuth, feature = INSTALL_FEATURE) {
  if (!a.ok) return { state: CODE_STATE[a.code] || 'error', code: a.code || null, src };
  if (a.authKind !== 'key') return { state: 'password', src, acct: a.username };
  const key = KS.keyById(a.keyId || keyId);
  if (!explicit(key, feature)) return { state: 'feature', src, acct: a.username, key: a.keyName || key?.name || '' };
  return { state: 'ok', src, acct: a.username, key: a.keyName || key?.name || '', keyId: a.keyId || keyId,
    ...(withAuth ? { auth: { username: a.username, privateKey: a.privateKey, passphrase: a.passphrase || '', fingerprint: a.keyFingerprint || '' } } : {}) };
}

/**
 * @param {{id:string, name:string, host:string, port?:number}} target  집중 모니터링 대상
 * @param {{edge?:boolean, corpVcs?:string[], pick?:string|null, withAuth?:boolean}} o
 *   edge — 엣지 노드 · corpVcs — 중앙: 대상 법인의 vCenter id 들 / 엣지: 그 엣지 스냅샷의 vCenter id 들 · pick — 화면에서 고른 공통 계정 id
 * @returns {{state:string, src?:'server'|'corp', acct?:string, key?:string, keyId?:string, choices?:Array<{id,name,acct,key}>, auth?:object, code?:string}}
 */
export function installCredFor(target, { edge = false, corpVcs = [], pick = null, withAuth = false, feature = INSTALL_FEATURE } = {}) {
  if (!CRED_FEATURES.includes(feature)) return { state: 'error', code: 'feature-unknown' };
  try {
    if (KS.keyStoreLoadError() || bmLoadError()) return { state: 'unreadable' };
    const host = t(target?.host); const port = Number(target?.port) || 22;
    // ① 같은 주소 · 포트의 SSH 공용 접속 서버(이 노드가 직접 맡은 것)
    const same = listBmServersRaw().filter((s) => !t(s.agent) && t(s.host) === host && (Number(s.port) || 22) === port);
    if (same.length > 1) return { state: 'dup', src: 'server' };
    if (same.length === 1) {
      const s = same[0];
      const a = resolveOsAuth(s, { feature });
      return fromAuth(a, t(s.keyRef), 'server', withAuth, feature);
    }
    // ② 법인 공통 계정(키가 있는 OS 계정 · 법인이 정해진 것)
    const vcs = new Set((corpVcs || []).map(t).filter(Boolean));
    // v3.17.0 반증 S2: 엣지도 법인을 거른다 — 엣지는 corpVcs 에 자기 스냅샷의 vCenter 들을 넘긴다(그 엣지가 맡은 법인 밖 공통 계정은 쓰지 않는다 ·
    //   못 읽었으면 빈 목록 → 'noentry' 로 닫힌다)
    const accs = KS.listAccountsRaw().filter((a) => a.kind === 'os' && t(a.corp) && t(a.keyRef) && vcs.has(t(a.corp)));
    if (!accs.length) return { state: 'noentry' };
    const withFeat = accs.filter((a) => explicit(KS.keyById(a.keyRef), feature));
    if (!withFeat.length) return { state: 'feature', src: 'corp', acct: accs[0].username, key: KS.keyById(accs[0].keyRef)?.name || '' };
    let acc = withFeat.length === 1 ? withFeat[0] : withFeat.find((a) => a.id === t(pick)) || null;
    if (!acc) return { state: 'ambig', src: 'corp', choices: withFeat.slice(0, 10).map((a) => ({ id: a.id, name: a.name, acct: a.username, key: KS.keyById(a.keyRef)?.name || '' })) };
    const a = resolveOsAuth({ id: target?.id, name: target?.name, host, port, credRef: acc.id, vcenterId: acc.corp }, { feature });
    return fromAuth(a, acc.keyRef, 'corp', withAuth, feature);
  } catch (e) {
    return { state: 'error', code: String(e?.message || e).slice(0, 80) };
  }
}

/** 화면 · 엣지 보고용(비밀 없음). */
export function credView(c) {
  if (!c) return null;
  return { state: CRED_STATES.includes(c.state) ? c.state : 'error', src: c.src || null, acct: c.acct || '', key: c.key || '', ...(Array.isArray(c.choices) ? { choices: c.choices.map((x) => ({ id: x.id, name: x.name, acct: x.acct, key: x.key })) } : {}) };
}
