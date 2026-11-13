/**
 * bmstor/corp.js — 베어메탈 서버의 **법인(DataCenter) 출처**(순수, v2.915 — 설계 docs/design/bm-san-compare §4.4).
 *
 * 베어메탈 서버에는 v2.914 까지 법인 축이 없었다(엣지 이름뿐 — v2.612 '베어메탈 서버는 법인 축이 없다'). 순서:
 *  1. 서버 등록 폼의 ‘법인’(datacenterId) — 사람이 고른 값.
 *  2. 비어 있고 엣지(agent)가 있으면 **그 엣지의 법인**: 수집 서버(원격) 레코드의 귀속 vCenter → DataCenter(법인 · vCenter · 엣지 1:1:1).
 *     수집 서버의 자유 문자열 `datacenter`(이름)는 id 가 아니라 쓰지 않는다 — 이름 대조로 억지 매칭하지 않는다.
 *  3. 둘 다 없으면 '' — 화면은 '(법인 미지정)' 으로 따로 센다(숨기지 않는다).
 */
export const NONE_DC = '__none__';   // SAN 스위치 화면과 같은 센티널 — 쉼표 목록은 '' 를 표현할 수 없다.

/**
 * @param {object} server 등록부 행(datacenterId · agent)
 * @param {{ findCollector?: (nameOrId:string)=>({vcenterId?:string}|null), datacenterOfVcenter?: (vcenterId:string)=>string }} deps
 *   findCollector 는 `collector/registry.js findCollectorByName`(이름 · id 대소문자 무시 — 조회 코어 하나, EDGE2613-08) 을 넣는다. 여기서는 vcenterId 만 읽는다.
 * @returns {{ datacenterId:string, datacenterSource:'server'|'edge'|'' }}
 */
export function datacenterOfBmServer(server, { findCollector = () => null, datacenterOfVcenter = () => '' } = {}) {
  const own = String(server?.datacenterId || '').trim();
  if (own) return { datacenterId: own, datacenterSource: 'server' };
  const agent = String(server?.agent || '').trim();
  if (agent) {
    let col = null;
    try { col = findCollector(agent) || null; } catch { col = null; }
    const vc = String(col?.vcenterId || '').trim();
    if (vc) {
      let dc = '';
      try { dc = String(datacenterOfVcenter(vc) || '').trim(); } catch { dc = ''; }
      if (dc) return { datacenterId: dc, datacenterSource: 'edge' };
    }
  }
  return { datacenterId: '', datacenterSource: '' };
}

/** 쿼리 `datacenterId=a,b,__none__` → Set 또는 null(전체). 센티널은 '' 로. */
export function parseDcQuery(q) {
  const list = String(q || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === NONE_DC ? '' : x));
  return list.length ? new Set(list) : null;
}

/** 법인 입력 검증(저장 · CSV 공용) — 빈 값 허용 · 64자 · 제어 문자 금지. 통과 null, 실패 사유. */
export function datacenterInputIssue(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 64) return '법인 id 가 너무 깁니다(64자 이하).';
  if ([...s].some((c) => c.charCodeAt(0) < 32)) return '법인 id 에 사용할 수 없는 문자가 있습니다.';
  return null;
}
