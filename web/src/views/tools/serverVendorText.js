/**
 * serverVendorText.js — 서버 분석 목록의 BMC 벤더 판정·문구(순수 모듈).
 *
 * v2.621(감사 WEB-04): 서버 목록 '유형' 칸·CSV 가 `type` 만 보고 OME 가 아니면 전부 'iDRAC' 이라 적었다 —
 *   iLO 계정으로 등록된 HPE 서버도 'iDRAC' 이었다. 벤더는 서버가 행마다 싣는 `vendor` 로 판정한다.
 *   · 중앙 등록부 행: 'hpe' | 'dell'(등록부 규약 — vendor 없음 = Dell iDRAC). 필드가 없어도 Dell 로 본다.
 *   · 원격(엣지) 행: 엣지(2.621+)가 보낸 'hpe' | 'dell'. **필드가 없으면 구버전 엣지**다 — '벤더 미상' 이고
 *     Dell 로 단정하지 않는다(구버전 엣지의 HPE 서버를 iDRAC 이라 말하게 된다).
 * 판정은 이 모듈 하나가 갖는다 — 배지·CSV·필터·상세 제목이 각자 판정하면 갈라진다.
 */

/** 행 → 'ome' | 'dell' | 'hpe' | 'unknown'. */
export function serverVendorOf(s) {
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.type === 'ome') return 'ome';
  const v = typeof s.vendor === 'string' ? s.vendor.trim().toLowerCase() : '';
  if (v === 'hpe') return 'hpe';
  if (v === 'dell') return 'dell';
  // 원격 행에 벤더가 없으면 구버전 엣지 — 미상. 중앙 등록부 행은 등록부 규약대로 Dell.
  return s.remote ? 'unknown' : 'dell';
}

const BADGE = {
  ome: { label: 'OME', cls: 'blue', title: 'Dell OpenManage Enterprise 관리 콘솔 등록' },
  dell: { label: 'iDRAC', cls: 'gray', title: 'Dell iDRAC' },
  hpe: { label: 'HPE iLO', cls: 'teal', title: 'HPE iLO — iLO 계정으로 등록된 서버' },
  unknown: {
    label: '벤더 미상', cls: 'gray',
    title: '엣지가 벤더를 보고하지 않았습니다(2.621 이전 엣지). Dell 로 단정하지 않습니다 — 모델 열이나 상세의 제조사로 확인하세요. 엣지를 올리면 다음 수집부터 표시됩니다.',
  },
};

/** 목록 '유형' 칸 배지 {label, cls, title}. */
export function serverVendorBadge(s) { return BADGE[serverVendorOf(s)]; }

/** CSV 'type' 열(BMC 종류)과 'vendor' 열. 미상은 'unknown' — 빈칸은 '값이 없다' 와 구분되지 않는다. */
export function serverCsvType(s) {
  return { ome: 'OME', dell: 'iDRAC', hpe: 'iLO', unknown: 'BMC' }[serverVendorOf(s)];
}
export function serverCsvVendor(s) {
  return { ome: 'Dell', dell: 'Dell', hpe: 'HPE', unknown: 'unknown' }[serverVendorOf(s)];
}

/** 상세 모달 제목에 쓸 BMC 이름 — 'iDRAC' | 'HPE iLO' | 'BMC'(미상). */
export function bmcLabel(s) {
  return { ome: 'OME', dell: 'iDRAC', hpe: 'HPE iLO', unknown: 'BMC' }[serverVendorOf(s)];
}

/** 벤더 필터 선택지. 개수가 0 인 종류는 빼고, 종류가 하나뿐이면 빈 배열(필터가 뜻이 없다). */
const FILTER_ORDER = [['dell', 'Dell iDRAC'], ['hpe', 'HPE iLO'], ['unknown', '벤더 미상'], ['ome', 'OME']];
export function vendorCounts(list) {
  const c = { dell: 0, hpe: 0, unknown: 0, ome: 0 };
  for (const s of Array.isArray(list) ? list : []) c[serverVendorOf(s)] += 1;
  return c;
}
export function vendorFilterOptions(list) {
  const c = vendorCounts(list);
  const opts = FILTER_ORDER.filter(([k]) => c[k] > 0).map(([k, label]) => ({ key: k, label: `${label} ${c[k]}` }));
  return opts.length > 1 ? opts : [];
}
/** 필터 키 '' = 전체. */
export function matchesVendor(s, key) { return !key || serverVendorOf(s) === key; }

/**
 * v2.621(감사 WEB-05): 미지원 서버 표의 '인증' 칸. 로그인을 시도하지 않은 장비(noCreds — 그 벤더 계정이 없다)를
 *   초록 '통과' 로 칠하지 않는다. 판정 순서: noCreds → authFailed → 통과.
 */
export function unsupportedAuthBadge(r) {
  if (r && r.noCreds === true) {
    return { label: '시도 안 함(계정 없음)', cls: 'gray', title: '이 대역에 그 벤더의 계정이 없어 로그인을 시도하지 않았습니다 — 통과한 것이 아닙니다' };
  }
  if (r && r.authFailed) {
    return { label: '거부', cls: 'gray', title: '스캔 대역 계정(Dell 용)이 이 장비에서 거부됨 — 정상(다른 벤더 계정이 다름)' };
  }
  return { label: '통과', cls: 'green', title: '스캔 대역 계정으로 로그인에 성공했습니다' };
}
