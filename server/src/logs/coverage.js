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
// v2.772(Z4-S3): 지연 판정 — 가용성과 같은 코어(measureEndOf) · 못 읽은 값 판정 · 수집 주기(허용치)
import { measureEndOf, TAIL_TOLERANCE_MS } from '../availability/analyze.js';
import { numOrNull } from '../util/numOrNull.js';
import { loadLogSettings } from './settings.js';
import { FUTURE_CLOCK_TOLERANCE_MS } from './clockTolerance.js';   // v2.783(점검 Q3 L-B1): 미래 행 경계 — 폴러와 같은 값(import 0 모듈 — 폴러를 정적으로 끌어오지 않는다)

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

/*
 * ─── v2.772(Z4-S3): '수집은 하지만 뒤처진 vCenter' 판정 한 벌 ──────────────────────────────────────────────────────────────
 * v2.765 부터 로그 폴러는 밀린 vCenter 를 주기마다 예산만큼 따라잡는다(실서버 OC2 9일 · OC2Sandbox 3일 22시간 뒤처짐). 위의 notCollected
 * 는 '지금 수집하지 않는다'(엣지 위임·비활성·점검중)만 알아, 수집 중이지만 며칠 뒤처진 vCenter 를 소비처(미보호 VM · 로그인 실패 ·
 * 로그 이슈 · VM 이력)가 '0건/정상' 에 섞었다(bughunt4 Z4-1·Z4-2). 판정은 VM 가용성(v2.731 A2-01)과 **같은 코어**다:
 *  · 완결 시각 = availability/analyze.js measureEndOf — 로그 폴러의 okAt(logCollectOkAt — 따라잡기 중이면 마지막으로 읽은 이벤트 시각)과
 *    마지막 저장 시각(db.lastTs) 중 늦은 것, okAt 이 없으면 lastTs. 지금과의 차이가 허용치를 넘으면 lagging.
 *  · 허용치 = eventTailToleranceOf(로그 설정) — 수집 주기 × 3 과 1시간 중 큰 것(routes/api/vmAvailability.js tailToleranceOf 와 같은 식 —
 *    테스트가 두 함수를 같은 입력으로 대조한다).
 *  · 둘 다 없으면(받은 적 없음) lagging 이 아니다 — '모른다' 이고 소비처가 이미 따로 말한다(no-events 등). 0 으로 세지 않는다.
 *  · 대상은 등록부의 **직접 수집 대상**뿐(notCollected 와 겹치지 않는다 — 원인이 다르다). mock 은 빈 목록(notCollected 와 같은 규칙).
 *  · 범위 계정 응답은 allowed 로 거른다(notCollectedList 와 같은 규칙 — 범위 밖 vCenter id 를 싣지 않는다).
 * ⚠ 이 모듈은 logs/poller.js 를 정적으로 import 하지 않는다(소비처 import 그래프에 폴러·store·soapClient 가 딸려 오지 않게) — okAt 조회
 *   함수는 deps.okAtOf 로 받고, 주지 않았을 때만 그 자리에서 동적 import 한다(운영에서는 이미 로드된 모듈이다).
 */

/** 지연 허용치(ms) — 로그 수집 주기 × 3 과 1시간 중 큰 것(순수). 주기를 못 읽으면 기본 10분으로 본다. */
export function eventTailToleranceOf(settings) {
  const min = numOrNull(settings?.pollIntervalMin);
  const pollMs = (min != null && min > 0 ? min : 10) * 60_000;
  return Math.max(TAIL_TOLERANCE_MS, pollMs * 3);
}

/**
 * 등록부의 직접 수집 대상 vCenter id 목록. mock 은 [](notCollected 와 같은 규칙). 등록부를 못 읽으면 null(모른다 — 빈 목록이 아니다).
 * @param {{ registry?: object[]|null }} [opts]
 */
export function eventCollectedIds({ registry = null } = {}) {
  if (eventCoverageIsMock()) return [];
  let list = registry;
  if (!Array.isArray(list)) {
    try { list = loadVcenterConfig().vcenters; } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const vc of list) {
    if (!vc || typeof vc !== 'object' || vc.id == null || vc.id === '') continue;
    if (directCollectSkipReason(vc)) continue;
    out.push(String(vc.id));
  }
  return out;
}

/**
 * vCenter 하나의 지연 판정(순수). lagging 이 아니면 null.
 * @param {string} vcenterId
 * @param {{ now:number, tolMs?:number, okAtOf?:(id:string)=>number|null, lastTsOf?:(id:string)=>number|null }} o
 * @returns {{vcenterId:string, okAt:number, lagMs:number, source:'collect'|'last-event'}|null}
 *   okAt — 이벤트가 온전한 마지막 시각(완결 시각) · source — 그 근거(collect = 폴러 기록 · last-event = 마지막 저장 시각만)
 */
export function eventLagOf(vcenterId, { now, tolMs = TAIL_TOLERANCE_MS, okAtOf = null, lastTsOf = null } = {}) {
  const id = String(vcenterId ?? '');
  if (!id || !Number.isFinite(now)) return null;
  const okAt = numOrNull(typeof okAtOf === 'function' ? okAtOf(id) : null);
  const lastTs = numOrNull(typeof lastTsOf === 'function' ? lastTsOf(id) : null);
  const m = measureEndOf({ okAt, lastTs }, now, tolMs);
  if (!m.cut) return null;
  return { vcenterId: id, okAt: m.end, lagMs: now - m.end, source: m.source };
}

/**
 * 여러 vCenter 의 지연 목록(순수) — vCenter id 순. notCollected(맵)에 든 vCenter 는 뺀다(따로 말한다).
 * @param {{ ids:Iterable<string>, now:number, tolMs?:number, okAtOf?:Function, lastTsOf?:Function,
 *           allowed?:Set<string>|null, only?:Set<string>|string[]|null, notCollected?:Map<string,string>|null, names?:Map<string,string>|null }} o
 */
export function eventLagList({ ids, now, tolMs = TAIL_TOLERANCE_MS, okAtOf = null, lastTsOf = null, allowed = null, only = null, notCollected = null, names = null } = {}) {
  const onlySet = only == null ? null : (only instanceof Set ? only : new Set([...only].map(String)));
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = String(raw ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (allowed && !allowed.has(id)) continue;
    if (onlySet && !onlySet.has(id)) continue;
    if (notCollected instanceof Map && notCollected.has(id)) continue;
    const lag = eventLagOf(id, { now, tolMs, okAtOf, lastTsOf });
    if (!lag) continue;
    const name = names instanceof Map ? names.get(id) : null;
    out.push({ ...lag, ...(name && name !== id ? { name: String(name) } : {}) });
  }
  out.sort((a, b) => (a.vcenterId < b.vcenterId ? -1 : a.vcenterId > b.vcenterId ? 1 : 0));
  return out;
}

let _okAtOfPromise = null;
/** 로그 폴러의 okAt 조회 함수 — 처음 부를 때 동적 import(정적 import 그래프에 폴러를 넣지 않는다). */
export function loadEventOkAtOf() {
  if (!_okAtOfPromise) {
    _okAtOfPromise = import('./poller.js').then((m) => m.logCollectOkAt).catch((e) => { _okAtOfPromise = null; throw e; });
  }
  return _okAtOfPromise;
}

/**
 * 소비처 한 화면의 지연 목록 — 등록부의 직접 수집 대상 중 only·allowed 에 든 것. 판정 실패(등록부·폴러를 못 읽음)는 null('모른다' —
 * 빈 목록이 아니다). deps: { registry?, okAtOf?, tolMs?, lastTsOf? }(테스트·호출부 주입 — 주지 않으면 등록부·폴러·로그 설정·db.lastTs).
 */
export async function eventLagForView({ db = null, now = Date.now(), only = null, allowed = null, notCollected = null, names = null, deps = {} } = {}) {
  try {
    const ids = eventCollectedIds({ registry: Array.isArray(deps?.registry) ? deps.registry : null });
    if (ids == null) return null;
    const onlySet = only == null ? null : (only instanceof Set ? only : new Set([...only].map(String)));
    const cand = ids.filter((id) => (!onlySet || onlySet.has(id)) && (!allowed || allowed.has(id)) && !(notCollected instanceof Map && notCollected.has(id)));
    if (!cand.length) return [];
    const okAtOf = typeof deps?.okAtOf === 'function' ? deps.okAtOf : await loadEventOkAtOf();
    const tolMs = Number.isFinite(deps?.tolMs) && deps.tolMs >= 0 ? deps.tolMs : eventTailToleranceOf(loadLogSettings());
    // v2.783(점검 Q3 L-B1): 지금 + 여유 이하의 마지막 저장 — 미래 행 1건(2099 등 — prune 은 ts < ? 라 남는다)이 measureEndOf 의 max(okAt, lastTs) 를
    //   미래로 밀어 okAt 이 있어도 지연을 숨겼다(가용성 꼬리 컷·로그인 실패·리포트의 '수집 지연' 경고가 영구히 꺼짐). 폴러 시작점·콘솔 지연과 같은 경계.
    const maxTs = (Number(now) || Date.now()) + FUTURE_CLOCK_TOLERANCE_MS;
    const lastTsOf = typeof deps?.lastTsOf === 'function' ? deps.lastTsOf
      : (id) => (db && typeof db.lastTs === 'function' ? db.lastTs(id, { maxTs }) : null);
    return eventLagList({ ids: cand, now, tolMs, okAtOf, lastTsOf, names });
  } catch { return null; }
}

/** 지연 길이 문구(서버 패턴 문장용) — '3일 22시간' · '5시간' · '40분'. 값이 없으면 ''. 백틱·별표 금지. */
export function eventLagText(ms) {
  const n = numOrNull(ms);
  if (n == null || n < 0) return '';
  const min = Math.floor(n / 60_000);
  if (min < 60) return `${Math.max(1, min)}분`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}시간`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}일 ${h % 24}시간` : `${d}일`;
}
