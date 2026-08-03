/**
 * 구성 변경 이력 — vcenter-logs.db(EventManager 장기 보관)에서 '변경성' 이벤트만 골라
 * 타임라인으로 제공한다. SQLite LIKE로는 타입 대안(alternation) 필터가 안 되므로,
 * SQL로 기간·vCenter·검색어를 선필터한 뒤 JS 정규식으로 변경 타입을 분류한다.
 * 순수 함수(filterChangeEvents)로 분리해 테스트 가능.
 */

// 변경성 이벤트 타입 — vim.event.* 클래스명 기준. 로그인/알람발화/성능류는 제외.
export const CHANGE_TYPE_RE = /(Reconfigured|Created|Removed|Renamed|Migrated|Relocated|Deployed|Cloned|Registered|Unregistered|PoweredOn|PoweredOff|Suspended|Reset|Annotation|CustomField|Permission|Role|Snapshot|EnteredMaintenance|ExitMaintenance|HostAdded|HostRemoved|Dvs|Portgroup|Datastore(?!.*Usage)|ResourcePool|Folder|License)/;

const CATEGORY = [
  [/Snapshot/, '스냅샷'],
  [/Reconfigured|Annotation|CustomField/, '설정 변경'],
  [/PoweredOn|PoweredOff|Suspended|Reset/, '전원'],
  [/Migrated|Relocated/, '마이그레이션'],
  [/Created|Deployed|Cloned|Registered/, '생성/등록'],
  [/Removed|Unregistered/, '삭제/해제'],
  [/Renamed/, '이름 변경'],
  [/Permission|Role/, '권한'],
  [/EnteredMaintenance|ExitMaintenance|HostAdded|HostRemoved/, '호스트 운영'],
  [/Dvs|Portgroup/, '네트워크'],
  [/Datastore/, '스토리지'],
  [/License/, '라이선스'],
];

export function classifyChange(type) {
  for (const [re, label] of CATEGORY) if (re.test(type)) return label;
  return '기타';
}

/**
 * rows(logs db 조회 결과: {vcenterId,ts,severity,type,user,entity,message}) → 변경 이벤트만.
 * opts: { category(한글 분류 필터), user(부분일치), entity(부분일치) }
 */
export function filterChangeEvents(rows, opts = {}) {
  const cat = opts.category || '';
  const user = (opts.user || '').toLowerCase();
  const entity = (opts.entity || '').toLowerCase();
  const out = [];
  for (const r of rows) {
    if (!CHANGE_TYPE_RE.test(r.type || '')) continue;
    const c = classifyChange(r.type || '');
    if (cat && c !== cat) continue;
    if (user && !(r.user || '').toLowerCase().includes(user)) continue;
    if (entity && !(r.entity || '').toLowerCase().includes(entity)) continue;
    out.push({ ...r, category: c });
  }
  return out;
}

export const CHANGE_CATEGORIES = [...new Set(CATEGORY.map(([, l]) => l)), '기타'];
