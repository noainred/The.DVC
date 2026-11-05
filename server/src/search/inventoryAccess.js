/**
 * search/inventoryAccess.js — 통합 장비 검색의 종류별 접근 판정 · 응답 행 가림(v2.909).
 *
 * 한 함수(`accessPlan`)가 칩 · 개수 · 행을 모두 정한다 — 화면이 다시 판정하지 않는다(docs/design/inventory-search/README.md §4.2).
 *
 * 규칙(server/CLAUDE.md 불변조건과의 대응):
 *  - 기능 권한은 서버가 진실의 원천 — 종류마다 그 화면의 권한(`inv.*` · `dashboard` · `tools`)과 도구 접근(`userToolAllowed`)을 본다.
 *    권한 · 도구가 없는 종류는 **칩도 행도 내려보내지 않는다**('메뉴는 보이는데 API 는 403' 을 만들지 않는다).
 *  - 범위(scope)는 요청 필터보다 먼저 — vCenter 귀속 종류는 `scopedVcenterIds` 교집합. **귀속 없는 데이터는 범위 계정에 노출하지 않는다**:
 *    전체 범위 전용 종류(스토리지 · SAN · 네트워크 스위치 · PDU)는 범위 계정에 'locked'(칩 잠금 + 사유, 존재 · 개수 비노출 — 컨펌 ②),
 *    귀속이 비어 있는 행(미귀속 서버 · GPU · 수동 IP)과 스캔 발견 IP 는 범위 계정에서 뺀다(IP 대장 원장과 같은 정책).
 *  - 관리 주소 가림은 `isAdminDetailUser` 하나(auth/addressMask.js 와 같은 판정 — `role === 'admin'` 직접 비교 금지).
 *    가리는 종류는 주소를 비우고 **주소로 찾아지지도 않게** 한다(가린 값으로 걸리면 가림이 무의미).
 *  - 베어메탈 서버 · 물리 GPU 서버 종류의 목적 화면(서버 분석 · 그 GPU 탭)은 관리자 전용 API 라 관리자 판본에게만 연다.
 */
import { scopedVcenterIds } from '../auth/scope.js';
import { userHasPermission, userToolAllowed } from '../auth/permissions.js';
import { isAdminDetailUser } from '../auth/demoGuest.js';
import { KINDS, KIND_KEYS } from './inventoryQuery.js';

/** 종류 → { perm, tool?, scope:'vc'|'full', addr?:주소 가림 대상, admin?:관리자 판본만 }. 키는 web App.jsx 탭 perm · 도구 키와 글자 그대로 같다. */
export const KIND_RULES = Object.freeze({
  vm: { perm: 'inv.vms', scope: 'vc' },
  host: { perm: 'inv.hosts', scope: 'vc' },
  datastore: { perm: 'inv.datastores', scope: 'vc' },
  vcenter: { perm: 'dashboard', scope: 'vc' },
  server: { perm: 'tools', tool: 'serveranalysis', scope: 'vc', addr: true, admin: true },
  gpu: { perm: 'tools', tool: 'serveranalysis', scope: 'vc', addr: true, admin: true }, // 물리 GPU 서버는 서버 분석 › GPU(관리자 전용 API)에만 보인다
  storage: { perm: 'tools', tool: 'storage-mon', scope: 'full', addr: true },
  sanswitch: { perm: 'tools', tool: 'san-switch', scope: 'full', addr: true },
  netswitch: { perm: 'tools', tool: 'cvp', scope: 'full', addr: true },
  pdu: { perm: 'tools', tool: 'pdu', scope: 'full', addr: true },
  ip: { perm: 'tools', tool: 'ipam', scope: 'vc' },
});

export const LOCK_REASON_FULL_SCOPE = '전체 범위(vCenter 제한 없는) 계정만 찾습니다.';

/**
 * 사용자 → 판정 묶음. 판정이 던지면 그 종류는 닫힌다(거부 기본값).
 * @returns {{ allowed:Set<string>|null, admin:boolean, kinds:Record<string,'ok'|'locked'>, visible:(row)=>boolean, addrSearchable:(row)=>boolean }}
 */
export function accessPlan(user, snap) {
  let allowed = null;
  try { allowed = scopedVcenterIds(user, snap); } catch { allowed = new Set(); } // 범위를 못 정하면 가장 좁게
  const admin = isAdminDetailUser(user);
  const kinds = {};
  for (const k of KIND_KEYS) {
    const rule = KIND_RULES[k];
    try {
      if (rule.admin && !admin) continue;
      if (!userHasPermission(user, rule.perm)) continue;
      if (rule.tool && !userToolAllowed(user, rule.tool)) continue;
      kinds[k] = rule.scope === 'full' && allowed ? 'locked' : 'ok';
    } catch { /* 닫힘 */ }
  }
  const visible = (row) => {
    if (!row || kinds[row.kind] !== 'ok') return false;
    if (!allowed) return true;
    if (KIND_RULES[row.kind].scope !== 'vc') return false;
    if (row.kind === 'ip' && row.ownerType === 'scanned') return false; // 스캔 발견은 귀속 판정 불가 — 원장과 같은 정책
    return !!row.vcenterId && allowed.has(row.vcenterId);
  };
  const addrSearchable = (row) => admin || !KIND_RULES[row?.kind]?.addr;
  return { allowed, admin, kinds, visible, addrSearchable };
}

const LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));

/** 응답 행 — 검색 키(`_*`)를 떼고, 가림 대상이면 주소 · 주소가 든 이름 · id 를 비운다. */
export function publicRow(row, plan) {
  const hide = !plan.admin && !!KIND_RULES[row.kind]?.addr;
  const addrs = hide ? [row.addr, ...row.ips].filter(Boolean).map((x) => x.toLowerCase()) : [];
  const leaks = (v) => hide && typeof v === 'string' && v !== '' && addrs.some((a) => v.toLowerCase().includes(a));
  const out = {
    kind: row.kind,
    id: leaks(row.id) ? '' : row.id,
    name: leaks(row.name) ? `${LABEL[row.kind] || '장비'} (이름 가림)` : row.name,
    alt: leaks(row.alt) ? '' : row.alt,
    ips: hide ? [] : row.ips,
    addr: hide ? '' : row.addr,
    serials: row.serials.slice(0, 4),
    model: row.model, sub: row.sub, status: row.status, statusText: row.statusText,
    vcenterId: row.vcenterId, corp: row.corp, agent: row.agent,
  };
  if (row.host) out.host = row.host;
  if (row.ownerType) out.ownerType = row.ownerType;
  if (hide && row.addr) out.addrHidden = true;
  return out;
}
