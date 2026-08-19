// routes/admin 공용 — admin.js(구 2,410줄) 분할(v2.285.0)로 이동. 본문은 원본 그대로.
// adminOnly·requireSettingsOwner 미들웨어와 다중 도메인 헬퍼만 여기 둔다.
import fs from 'node:fs';
import { config } from '../../config.js';
import { requireRole } from '../../auth/auth.js';
import { loadSessionSecurity } from '../../security/securitySettings.js';
import { store } from '../../store.js';
import { loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { loadCollectors } from '../../collector/registry.js';
import { allRemoteServers, dedupRemoteServers } from '../../collector/remoteInventory.js';
import { matchDatacenterId } from '../../collector/datacenterMatch.js';
import { serverInScope } from '../../insights/analysisScope.js';
import { listDatacenters, getDatacenterAssign, ensureDatacenter } from '../../datacenter/store.js';


export const adminOnly = requireRole('admin');

// '설정 소유 계정(settingsOwners)' 서버측 강제 — 지금까지 소유자 경계는 UI(App.jsx)에서만
// 걸려, 소유자가 아닌 admin이 엔드포인트를 직접 호출하면 소유자 목록을 갈아치우고 소유 계층을
// 탈취할 수 있었다(감사 지적: 클라이언트 전용 접근제어). adminOnly 뒤에 붙여 유효 소유자
// (설정된 소유자 + 중앙 배포 admin)만 통과시킨다. 인증 비활성 시엔 통과(단일 사용자 모드).
export function requireSettingsOwner(req, res, next) {
  if (!config.auth.enabled) return next();
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  const u = req.user || {};
  if (owners.includes(u.username) || owners.includes(u.name)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '설정 소유 계정만 변경할 수 있습니다.' });
}

// 자격증명 디버그 표시용 마스킹 — 평문 비밀번호는 절대 응답에 넣지 않고 길이만 노출한다.
// (계정명/passwordless 여부는 디버그에 유용하므로 유지)
export const maskPw = (p) => (p === '' || p == null) ? '(빈 비번/passwordless)' : `•••• (${String(p).length}자)`;

// 서버 분석 공용 필터 술어. 쿼리로 3가지 축을 지원한다:
//   ?vcenterId=<id>      — 그 vCenter의 가상화 장비만 (vcenterId 일치). __unmapped__=vCenter 미지정.
//   ?datacenterId=<id>   — 그 법인(DataCenter)의 모든 장비 (dcOf 일치). __unmapped__=법인 미지정.
//   ?baremetal=1         — vCenter에 속하지 않는 물리(베어메탈) 장비만.
// dcOf: 스캔 등록분은 datacenterId 직접, 그 외는 vCenter→DataCenter 할당으로 해석.
export function analysisFilter(req) {
  const scope = {
    vcenterId: String(req?.query?.vcenterId || '').trim(),
    datacenterId: String(req?.query?.datacenterId || '').trim(),
    baremetal: String(req?.query?.baremetal || '') === '1',
  };
  const assign = getDatacenterAssign();
  return (s) => serverInScope(s, scope, assign);
}

// 서비스태그(정규화) → vCenter id 맵(스냅샷 호스트 기준). Dell 서비스태그 == ESXi 하드웨어
// 일련번호이므로, 물리 iDRAC 서버를 그 서버가 실제로 돌리는 ESXi 호스트의 vCenter에 매핑한다.
export function hostVcByTag() {
  const m = new Map();
  for (const h of (store.get().hosts || [])) {
    const t = String(h.serviceTag || '').trim().toLowerCase();
    if (t && h.vcenterId && !m.has(t)) m.set(t, h.vcenterId);
  }
  return m;
}

// 서비스태그(정규화) → ESXi 호스트명(vCenter 스냅샷). iDRAC 인벤토리에 hostName 이 없거나
// 아직 갱신 전(30분 주기·구버전 엣지)인 서버도 vCenter 쪽 이름으로 즉시 표시하기 위한 폴백.
export function hostNameByTag() {
  const m = new Map();
  for (const h of (store.get().hosts || [])) {
    const t = String(h.serviceTag || '').trim().toLowerCase();
    if (t && h.name && !m.has(t)) m.set(t, h.name);
  }
  return m;
}
// 서비스태그(정규화) → vCenter 호스트 물리 NIC(config.network.pnic 수집분). NIC 속도/모델
// 화면의 'vCenter 수집' 별도 컬럼용 — iDRAC 인벤토리와 독립된 교차 검증 소스. 엣지 위임
// vCenter도 인벤토리 push에 호스트 객체 전체가 실리므로 중앙에서 동일하게 조회된다.
export function hostNicsByTag() {
  const m = new Map();
  for (const h of (store.get().hosts || [])) {
    const t = String(h.serviceTag || '').trim().toLowerCase();
    if (t && Array.isArray(h.nics) && h.nics.length && !m.has(t)) m.set(t, h.nics);
  }
  return m;
}

// 서버에 mappedVcenterId(서비스태그로 찾은 vCenter)를 부여. 스캔 등록분은 vcenterId가 비어도
// 서비스태그가 ESXi 호스트와 일치하면 그 vCenter의 '가상화 장비'로 분류된다.
export function withMappedVc(s, tagMap) {
  const tag = String(s.serviceTag || s.inv?.system?.serviceTag || '').trim().toLowerCase();
  return { ...s, mappedVcenterId: (tag && tagMap.get(tag)) || '' };
}

// 서버 분석 공용 — iDRAC 서버 목록(OME 제외) + mappedVcenterId 부여 후 필터. 중앙 로컬 레지스트리만
// (온도 시계열처럼 중앙 직접 수집분에만 의미 있는 뷰용).
// (구) 중앙 로컬 등록 서버만 — 모든 분석 탭이 analysisServersWithRemote(원격 포함)로 이전해 미사용.

// 수집기(에이전트) → DataCenter id 매핑. collector.datacenter 라벨/이름/ id를 등록된
// DataCenter(id 또는 name, 대소문자 무시)에 맞춘다. '에이전트로 검색하면 그 법인에 속하게'의 근거.
export function collectorToDatacenterMap() {
  const dcs = listDatacenters();
  const map = new Map();
  for (const c of loadCollectors()) {
    map.set(String(c.id), matchDatacenterId([c.datacenter, c.id, c.name], dcs));
  }
  return map;
}

// 원격 서버 + DataCenter 해석: 엣지가 datacenterId를 태깅하지 못한 경우(스캔 시점/버전 차이)에도
// 그 서버를 보고한 수집기(에이전트)의 소속 DataCenter로 자동 귀속시킨다.
export function remoteServersResolved() {
  const m = collectorToDatacenterMap();
  const resolved = allRemoteServers().map((s) => ({ ...s, datacenterId: s.datacenterId || m.get(String(s.collectorId)) || '' }));
  // 같은 엣지를 둘 이상의 수집서버(대소문자만 다른 'nj'·'NJ' 등)가 pull하면 동일 물리 서버가
  // 중복 유입돼 목록·집계가 2배가 된다 → 물리 식별키로 dedup.
  return dedupRemoteServers(resolved);
}

// 서버 분석 공용(원격 포함) — 중앙 로컬 + 위임 법인의 원격 인벤토리를 병합(id 중복은 중앙 우선).
// 위임 스캔으로 엣지에만 등록된 서버가 서버 분석에 나타나게 한다. 온도도 엣지 export의
// 최신 센서(s.sensors)로 포함된다(법인별 온도 탭).
export function analysisServersWithRemote(req) {
  const pred = analysisFilter(req);
  const tagMap = hostVcByTag();
  const local = loadIdracRegistry().filter((s) => s.type !== 'ome').map((s) => withMappedVc(s, tagMap)).filter(pred);
  const seen = new Set(local.map((s) => String(s.id)));
  const remote = remoteServersResolved().map((s) => withMappedVc(s, tagMap)).filter((s) => !seen.has(String(s.id)) && pred(s));
  return local.concat(remote);
}

// 인벤토리 조회: 원격 서버는 엣지가 실어 보낸 콤팩트 인벤토리(s.inv)를, 중앙 서버는 캐시를 쓴다.
export function invForServer(s) {
  return (s && s.remote) ? (s.inv || null) : getIdracInventory(s.id);
}

// 수집 서버의 데이터센터(라벨/ id)를 DataCenter로 자동 등록 — '스캔 대역 추가' 등 DataCenter
// 목록에 바로 뜨게 한다(수집 서버만 있고 법인 미등록이면 스캔 대상에 안 보이던 문제 해결).
export function ensureCollectorDatacenter(c) {
  if (!c) return;
  const label = String(c.datacenter || '').trim();
  const id = (label || c.id || '').toString();
  if (id) ensureDatacenter({ id, name: label || c.name || c.id });
}

export function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

