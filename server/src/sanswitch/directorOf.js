/**
 * sanswitch/directorOf.js — 어레이 포트 심볼릭 이름 → 디렉터 · 컨트롤러 해석(순수 · v2.948 'SAN 스토리지 성능').
 *
 * 스위치 네임서버가 받은 포트 심볼릭 이름은 `벤더::시리얼::디렉터 포트::FC::펌웨어` 꼴이다(perfDb.storageKey 머리말 —
 * 앞 두 조각이 어레이 키). **셋째 조각**이 디렉터(PowerMax FA-1D · SAF-1d · OR-1C) · 노드(PowerStore NodeA) · SP(Unity SPA)와
 * 그 포트다. 이 모듈은 그 조각만 읽는다 — 새 장비 접속이 없다.
 *
 * 정직 규칙(설계 docs/design/san-storage-perf/README.md §3-4):
 *  · 벤더별 **아는 패턴만** 읽고, 안 맞으면 group=null(화면 '(구분 못 함)') — 평평한 이름을 억지로 나누지 않는다.
 *  · PowerMax 꼴(`FA-1D 4` · `SAF-1d 4` · `FA-7E:0`)은 현장 포맷이 perfDb 머리말에 있다. `OR-1C`(PowerMax 2500/8500 · PowerMaxOS 10)은
 *    Dell REST 예시로 확인했다. **PowerStore(`NodeA FC0`) · Unity(`SPA FC0`)는 목 서버 형식**이라 실장비는 미확인 — 그래서 Unity 는
 *    조닝 별칭(`Unity_SPA0_p8` — 현장 별칭 규칙)에서 한 번 더 찾는다(confidence 'alias').
 *  · 확신 등급(confidence): 'manual'(관리자 매핑 — directorMap.js) > 'name'(이름 규칙) > 'alias'(조닝 별칭) > 'none'.
 *  · 정규식은 길이를 먼저 자르고(200자) 앵커를 둔다(외부 입력 — 장비 출력. CLAUDE.md 정규식 규칙).
 */

export const UNPARSED_GROUP = '(구분 못 함)';
export const VENDOR_LABEL = Object.freeze({ powermax: 'PowerMax · VMAX', powerstore: 'PowerStore', unity: 'Unity', other: '그 밖' });
export const CONFIDENCE_LABEL = Object.freeze({ manual: '수동', name: '이름 규칙', alias: '조닝 별칭', none: '구분 못 함' });

const NAME_MAX = 200;
const ALIAS_MAX = 120;
// 셋째 조각 패턴 — 전부 앞 고정(^)·길이 제한.
const PMAX_RE = /^([A-Za-z]{2,3})-(\d{1,2}[A-Za-z])(?:[\s:]+([A-Za-z0-9:_-]{1,8}))?/;   // FA-1D 4 · SAF-1d 4 · FA-7E:0 · OR-1C 1
const PSTORE_RE = /^Node[\s_-]?([A-Za-z])(?![A-Za-z])[\s:]*([A-Za-z0-9_-]{0,8})/i;        // NodeA FC0 · Node-B FC1
const UNITY_RE = /^(SP[A-Z])(?![A-Za-z])[\s:]*([A-Za-z0-9 _-]{0,12})/i;                   // SPA FC0 · SPB FC Port 1
const ALIAS_SP_RE = /(?:^|[^A-Za-z])SP([AB])(?![A-Za-z])/i;                               // Unity_SPA0_p8 · unity-spb-p1

/** 심볼릭 이름의 첫 조각으로 벤더를 고른다. 모르면 'other'(추정하지 않는다). */
export function vendorOf(name) {
  const seg0 = String(name || '').slice(0, NAME_MAX).split('::')[0].trim().toUpperCase();
  if (/^(SYMMETRIX|VMAX|POWERMAX)/.test(seg0)) return 'powermax';
  if (/^POWERSTORE/.test(seg0)) return 'powerstore';
  if (/^(UNITY|VNX|DGC)/.test(seg0)) return 'unity';
  return 'other';
}

/**
 * @param {string} name 포트 심볼릭 이름(port_meta.attached_name)
 * @param {{alias?: string}} [opts] 조닝 별칭(있을 때 Unity SPA/SPB 폴백)
 * @returns {{vendor:string, group:string|null, port:string, confidence:'name'|'alias'|'none'}}
 */
export function directorOf(name, { alias = '' } = {}) {
  const raw = String(name || '').slice(0, NAME_MAX);
  const vendor = vendorOf(raw);
  const segs = raw.split('::').map((s) => s.trim());
  const third = segs.length >= 3 ? segs[2].slice(0, 60) : '';
  if (third) {
    let m;
    if (vendor === 'powermax' && (m = PMAX_RE.exec(third))) {
      return { vendor, group: `${m[1].toUpperCase()}-${m[2].toUpperCase()}`, port: m[3] || '', confidence: 'name' };
    }
    if (vendor === 'powerstore' && (m = PSTORE_RE.exec(third))) {
      return { vendor, group: `Node ${m[1].toUpperCase()}`, port: m[2] || '', confidence: 'name' };
    }
    if (vendor === 'unity' && (m = UNITY_RE.exec(third))) {
      return { vendor, group: m[1].toUpperCase(), port: (m[2] || '').trim(), confidence: 'name' };
    }
  }
  const a = String(alias || '').slice(0, ALIAS_MAX);
  const am = a ? ALIAS_SP_RE.exec(a) : null;
  if (am) return { vendor: vendor === 'other' ? 'unity' : vendor, group: `SP${am[1].toUpperCase()}`, port: '', confidence: 'alias' };
  return { vendor, group: null, port: '', confidence: 'none' };
}

/** 관리자 매핑(directorMap.js)이 있으면 그것이 이긴다 — 근거 'manual'. 없으면 자동 해석 그대로. */
export function applyDirectorOverride(parsed, override) {
  const g = override && typeof override === 'object' ? String(override.group || '').trim() : '';
  if (!g) return parsed;
  return { ...parsed, group: g, confidence: 'manual', note: String(override.note || '') };
}

/** 화면 라벨 — null 그룹은 '(구분 못 함)'. */
export const groupLabel = (g) => (g == null || g === '' ? UNPARSED_GROUP : String(g));
