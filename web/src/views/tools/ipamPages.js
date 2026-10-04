/**
 * ipamPages.js — IP관리 서브메뉴의 페이지 정의(순수, v2.636).
 *
 * 사용자 요청(2026-09-28): "IP scan 을 위한 입력/수정이 입력량이 많고 복잡해서 별도의 화면으로 · KPI 아래에 IP관리의
 * sub menu · IPMS 설정·추천 기능 30선·대용량 CSV·스캔 상태를 각각의 페이지로 · 편집하다가 없어지는 일이 없도록" +
 * "sub menu 에 scan 상태, 로그". 선택: 기존 보기 버튼까지 전부 서브메뉴로.
 *
 * ── 왜 페이지인가(편집 유실의 원인 — 코드로 확인) ─────────────────────────────────────────────
 * 예전에는 IPMS 설정·IP 스캔·스캔 상태가 대장 화면 **안의 모달**이었고, 대장 화면은 `if (loading) return <Loading />` 였다.
 * 대장을 다시 읽는 순간(범위 칩 클릭·관리상태 저장 후 재조회) 화면 전체가 로딩 표시로 바뀌며 모달이 **언마운트**되어
 * 입력하던 대역·포트가 사라졌다. 이제 각 설정은 대장 로딩과 무관한 페이지이고, 입력은 편집 초안(ipamDraft.js)에 남는다.
 *
 * `needsLedger` 는 대장(/tools/ipam) 데이터가 있어야 그릴 수 있는 페이지다 — 나머지는 대장을 읽는 중에도 그린다.
 * `admin` 은 서버가 관리자에게만 여는 페이지다(메뉴에서 숨기지만 서버가 집행한다 — 화면은 안내일 뿐).
 * `csv` 는 v2.643 CSV 권한(`api.js canCsv()` — 관리자 이상 + data.csv) 전용 페이지다. 이 모듈은 순수라 api.js 를 import 하지
 *   않는다 — 호출부가 `{ csvOk: canCsv() }` 를 넘긴다(생략하면 예전처럼 보인다 — 서버가 집행한다).
 */
export const IPAM_PAGES = Object.freeze([
  { k: 'list', label: '대장 목록', icon: '📋', group: 'ledger', needsLedger: true, title: 'vCenter·스캔·수동 등록 IP 전체 목록' },
  { k: 'sheet', label: '서브넷 대장', icon: '📊', group: 'ledger', title: '/24 서브넷 단위 엑셀형 대장' },
  { k: 'insights', label: '추천 기능 30선', icon: '🧠', group: 'ledger', title: '유명 IPAM 솔루션 대표 기능 30선을 수집 데이터로 계산' },
  { k: 'netmap', label: '네트워크 맵', icon: '🗺️', group: 'ledger', title: '대역 선택 → OS별·시간대별 사용/미사용 네트워크 맵' },
  { k: 'policies', label: '대역 정책', icon: '🧩', group: 'range', needsLedger: true, title: '대역 단위 관리상태(예약·DHCP풀·폐기 등) 기본값' },
  // v2.691: 예전 '대역·스캔'(vCenter 별 대역)은 이 페이지로 합쳐졌다 — 옛 주소 #/ipam/ranges 는 IPAM_PAGE_ALIASES 가 옮긴다.
  { k: 'scan', label: '스캔 대역·설정', icon: '🛰️', group: 'scan', admin: true, title: '에이전트별 스캔 대역(iDRAC·VM 대역 가져오기)·포트·주기' },
  { k: 'status', label: '스캔 상태', icon: '📡', group: 'scan', admin: true, title: '진행 중 스캔 + 완료된 스캔 이력' },
  { k: 'log', label: '스캔 로그', icon: '🧾', group: 'scan', admin: true, title: '스캔 시작·종료·실패·건너뜀·엣지 보고·설정 변경 기록' },
  { k: 'ipms', label: 'IPMS 설정', icon: '⚙', group: 'setup', admin: true, title: '무시 대역 · vCenter 스캔 대역 · 공인/사설 분류' },
  { k: 'csv', label: 'CSV 가져오기·내보내기', icon: '⇅', group: 'setup', csv: true, title: '대장 내보내기 · IP 관리상태·메모 CSV · 스캔 대역 CSV' },
]);
export const IPAM_GROUPS = Object.freeze([['ledger', 'IP 대장'], ['range', '대역'], ['scan', '스캔'], ['setup', '설정·데이터']]);
/** v2.691: 없어진 페이지의 옛 주소 → 새 페이지(북마크·공유 링크·다른 화면의 바로가기를 살린다). */
export const IPAM_PAGE_ALIASES = Object.freeze({ ranges: 'scan' });
export const IPAM_PAGE_KEYS = Object.freeze(IPAM_PAGES.map((p) => p.k));
/** 주소로 받아들이는 키(옛 주소 포함) — 받은 뒤 IPAM_PAGE_ALIASES 로 옮긴다. */
export const IPAM_HASH_KEYS = Object.freeze([...IPAM_PAGE_KEYS, ...Object.keys(IPAM_PAGE_ALIASES)]);
const BY_KEY = new Map(IPAM_PAGES.map((p) => [p.k, p]));

/** 페이지 정의(없으면 null). */
export function ipamPage(k) { return BY_KEY.get(k) || null; }

/**
 * 관리자 페이지 접근 판정. access: 'yes'(관리자 설정을 읽었다) | 'no'(403 — 관리자 아님) | 'unknown'(아직 모름·네트워크 오류).
 * '모름' 을 '없음' 으로 읽지 않는다 — 메뉴는 보여 주고 각 페이지가 서버 응답으로 말한다(권한은 서버가 집행한다).
 */
export function pageShown(k, access, { csvOk = true } = {}) {
  const p = BY_KEY.get(k);
  if (!p) return false;
  if (p.csv && !csvOk) return false;
  return !p.admin || access !== 'no';
}

/** 메뉴에 보일 페이지를 그룹별로. */
export function menuGroups(access, opts = {}) {
  return IPAM_GROUPS.map(([g, label]) => ({ g, label, pages: IPAM_PAGES.filter((p) => p.group === g && pageShown(p.k, access, opts)) }))
    .filter((x) => x.pages.length);
}

/** 관리자 페이지를 관리자가 아닌 계정이 주소로 열었을 때의 안내(없으면 null). */
export function pageDeniedNote(k, access) {
  const p = BY_KEY.get(k);
  if (!p || !p.admin || access !== 'no') return null;
  return `‘${p.label}’ 은 관리자만 쓸 수 있는 페이지입니다 — 서버가 관리자 계정에만 이 설정을 엽니다. 필요하면 관리자에게 요청하세요.`;
}
