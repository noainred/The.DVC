/**
 * logs/coverage.js — '이 포탈이 지금 vCenter 이벤트를 직접 수집하지 않는 vCenter' 판정 한 벌(v2.733 — 점검 3회차 C1-01).
 *
 * v2.732(B4-01)부터 vCenter 이벤트 로그 폴러(logs/poller.js)는 **직접 수집 대상만** 로그인한다 — 관리자가 끈(disabled) ·
 * 점검중(maintenance) · 엣지 위임(site) vCenter 의 이벤트는 이 포탈의 logs DB 에 더 쌓이지 않는다(엣지 → 중앙 이벤트 push 경로는
 * 없다 — site 로그는 엣지가 보관하고 화면은 연합 조회로 본다). 그런데 logs DB 를 읽는 리포트(로그 이슈 분석 · 구성 변경 이력 ·
 * 로그인 실패 분석 · VM 이동/생성·삭제 이력 · VM 가용성)는 그 사실을 몰라 '그 vCenter 에 이벤트가 없다' 를 '아무 일도 없었다'
 * (특이 패턴 없음 · 0건) 로 말했다(재현 — 점검 3회차 C1-01). 미보호 VM 리포트만 인라인 판정으로 'not-collected' 를 갖고 있었다.
 *
 * 규칙
 *  · 판정은 로그 폴러와 **같은 기준**이다 — 등록부(loadVcenterConfig) + vcenter/collectTarget.js directCollectSkipReason.
 *    mock(데모) 모드에서는 폴러가 스냅샷 vCenter 전부를 합성 수집하므로 **빈 맵**이다(같은 config.dataSource 판정).
 *  · 등록부에 없는 vCenter 는 판정하지 않는다(모른다) — live 스냅샷의 vCenter 는 등록부에서만 만들어진다(store.js 병합 루프).
 *  · 소비처는 그 vCenter 를 '0건/정상' 에 섞지 않고 `notCollected:[{vcenterId, why}]` 로 따로 싣는다. 옛 이벤트(수집을 멈추기 전)가
 *    남아 있어도 '지금 수집하지 않는다' 는 사실을 말한다 — 옛 이벤트로 지금 상태를 판정하지 않는다(미보호 리포트와 같은 규칙).
 *  · 범위 계정 응답에서는 허용 vCenter 만 싣는다(notCollectedList 의 allowed).
 * ⚠ vcenter/collectTarget.js 는 import 0 규약(store.js·폴러들이 함께 쓴다)이라 등록부를 읽는 이 헬퍼는 여기 둔다.
 */
import { config, loadVcenterConfig } from '../config.js';
import { directCollectSkipReason, DIRECT_SKIP_REASONS } from '../vcenter/collectTarget.js';

/** 사유 코드 — vcenter/collectTarget.js 와 같은 집합(웹 eventCoverageText.js 의 문구와 1:1). */
export const EVENT_NOT_COLLECTED_REASONS = DIRECT_SKIP_REASONS;

/** 서버가 패턴·안내 문장에 쓰는 짧은 사유(웹은 같은 키로 자기 문구를 쓴다). 백틱·별표 금지. */
export const EVENT_NOT_COLLECTED_TEXT = Object.freeze({
  site: '엣지 위임 — 그 엣지가 수집하고 이 포탈은 이벤트를 모으지 않습니다',
  disabled: '비활성 — 관리자가 끈 vCenter',
  maintenance: '점검중 — 수집 일시 중단',
});

/** 로그 폴러와 같은 mock 판정(logs/poller.js 의 `config.dataSource === 'mock'`). */
export function eventCoverageIsMock() {
  return String(config.dataSource || '').toLowerCase() === 'mock';
}

/**
 * 이 포탈이 지금 이벤트를 직접 수집하지 않는 vCenter → 사유 맵.
 * @param {{ registry?: object[]|null }} [opts] registry — 등록부 목록(주지 않으면 loadVcenterConfig 로 읽는다. 테스트·호출부 재사용용)
 * @returns {Map<string, 'site'|'disabled'|'maintenance'>}
 */
export function eventNotCollectedMap({ registry = null } = {}) {
  const out = new Map();
  if (eventCoverageIsMock()) return out;
  let list = registry;
  if (!Array.isArray(list)) {
    try { list = loadVcenterConfig().vcenters; } catch { list = []; }
  }
  for (const vc of Array.isArray(list) ? list : []) {
    if (!vc || typeof vc !== 'object' || vc.id == null || vc.id === '') continue;
    const why = directCollectSkipReason(vc);
    if (why && why !== 'invalid') out.set(String(vc.id), why);
  }
  return out;
}

/**
 * 맵 → 응답에 싣는 목록. 범위(allowed — Set|null)·대상(only — Set|배열|null)으로 거르고, names(Map id→이름)가 있으면 이름을 붙인다.
 * vCenter id 순으로 정렬한다(응답이 매번 같은 순서가 되게).
 * @returns {{vcenterId:string, why:string, name?:string}[]}
 */
export function notCollectedList(map, { allowed = null, only = null, names = null } = {}) {
  if (!(map instanceof Map) || !map.size) return [];
  const onlySet = only == null ? null : (only instanceof Set ? only : new Set([...only].map(String)));
  const out = [];
  for (const [id, why] of map) {
    if (allowed && !allowed.has(id)) continue;
    if (onlySet && !onlySet.has(id)) continue;
    const name = names instanceof Map ? names.get(id) : null;
    out.push({ vcenterId: id, why, ...(name && name !== id ? { name: String(name) } : {}) });
  }
  out.sort((a, b) => (a.vcenterId < b.vcenterId ? -1 : a.vcenterId > b.vcenterId ? 1 : 0));
  return out;
}
