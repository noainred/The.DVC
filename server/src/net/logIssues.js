/**
 * 로그 자체 분석 — 장기 보관된 vCenter 로그에서 장애/이슈 패턴을 휴리스틱으로 찾아낸다.
 * 최근 기간의 오류/경고를 유형·대상별로 집계하고, 반복/집중/연결끊김/인증실패 등을 표면화.
 */

import { getLogsDb } from '../logs/db.js';
import { eventNotCollectedMap, notCollectedList, EVENT_NOT_COLLECTED_TEXT, eventLagForView, eventLagText } from '../logs/coverage.js';

const DAY = 86_400_000;
const ROWS = 5000;
/**
 * v2.742(감사 DB-02 — 재현): 오류·경고 **개수의 상한**. 예전에는 기간(화면 최대 90일 · API 는 무제한) 전체를 정확 COUNT 2~4회 + 한 문장 조회
 *   2회로 양보 없이 셌다 — severity 는 인덱스 밖이라 기간 안 행을 전부 읽는다. 이제 개수는 이만큼까지만 세고(넘으면 capped 로 밝힌다 —
 *   화면은 'N건 이상'), 조회·개수 모두 logs DB 의 시간 조각 + 양보(queryAsync·countCappedAsync)로 읽는다.
 */
export const ISSUE_COUNT_CAP = 100_000;
/** 분석 기간 상한(일) — 화면은 1·7·30·90 만 보내지만 API 는 아무 값이나 받는다(사용자 입력 일수는 함수 안에서도 자른다 — v2.680 C-01). */
export const ISSUE_DAYS_MAX = 366;
const clampDays = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(ISSUE_DAYS_MAX, n) : 7; };

/**
 * @param {{vcenterId?:string, days?:number}} opts
 * @param {{db?:object, notCollected?:Map<string,string>, now?:number, yieldMs?:number, countCap?:number, lagging?:Array|null, lag?:object}} [deps] 테스트·호출부 주입
 *   (기본: logs DB · logs/coverage.js 판정 · 지금 · 15ms · ISSUE_COUNT_CAP · v2.772 지연 판정 eventLagForView — lag 는 그 deps)
 *
 * v2.733(점검 3회차 C1-01): 이 포탈이 지금 이벤트를 직접 수집하지 않는 vCenter(엣지 위임·비활성·점검중 — v2.732 B4-01)를
 *   '특이 패턴 없음' 에 섞지 않는다.
 *   · 그 vCenter 를 골랐으면 분석하지 않고 `sev:'unknown'` 하나를 낸다 — 남은 옛 이벤트(수집을 멈추기 전)로 지금 상태를 판정하지 않는다.
 *     수치는 null(0 이 아니다).
 *   · 전체 보기는 그 vCenter 의 이벤트를 분석에서 빼고 `notCollected`(id·사유) + `excluded`(기간 안 뺀 오류·경고 수)로 밝힌다.
 */
export async function analyzeLogsForIssues({ vcenterId = '', days: daysIn = 7 } = {}, deps = {}) {
  const db = deps.db || await getLogsDb();
  const nc = deps.notCollected instanceof Map ? deps.notCollected : eventNotCollectedMap();
  const days = clampDays(daysIn);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const since = now - days * DAY;
  const vcId = String(vcenterId || '');
  if (vcId && nc.has(vcId)) {
    const why = nc.get(vcId);
    return {
      window: { days, since },
      summary: { errors: null, warnings: null, peakPerHour: null, avgPerHour: null },
      topTypes: [], topEntities: [],
      patterns: [{ sev: 'unknown', code: 'not-collected', title: '이 포탈이 지금 이 vCenter 의 이벤트를 수집하지 않습니다',
        detail: `${EVENT_NOT_COLLECTED_TEXT[why] || why} — 남은 옛 이벤트로는 판정하지 않습니다(‘특이 패턴 없음’ 이 아닙니다).` }],
      notCollected: notCollectedList(nc, { only: [vcId] }),
      generatedAt: Date.now(),
    };
  }
  // v2.772(Z4-2): 수집은 하지만 뒤처진 vCenter(따라잡는 중 포함) — 완결 시각 뒤의 오류는 아직 이 DB 에 없다. 고른 vCenter 가 있으면 그 하나만
  //   (범위 계정은 라우트가 vCenter 하나를 강제한다 — 범위 밖 id 가 실리지 않는다). deps.lagging(기억 판이 미리 구해 키에 넣은 값)이 있으면 그것.
  //   판정을 못 하면 null('모른다').
  const lagging = Array.isArray(deps.lagging) || deps.lagging === null ? deps.lagging
    : await eventLagForView({ db, now, only: vcId ? [vcId] : null, notCollected: nc, deps: deps.lag || {} });
  const base = { vcenterId: vcId, since };
  // 전체 보기: 지금 수집하지 않는 vCenter 의 행은 분석에서 뺀다 — SQL 에서 바로 뺀다(excludeVcenterIds · v2.742 DB-02). 포함 목록을 만들지 않는다
  //   (삭제된 vCenter 의 옛 이벤트도 예전처럼 분석에 남는다). 뺀 vCenter 의 기간 안 오류·경고 수는 따로 세어 밝힌다(excluded).
  //   ⚠ v2.733 은 그 vCenter 만 정확 COUNT 로 세어 합계에서 빼고, 뺀 만큼 목록을 더 읽어(상한 25,000) 걸렀다 — 이제 최신 ROWS 건이 정확히 남는다.
  const exclIds = vcId ? [] : [...nc.keys()];
  const excl = exclIds.length ? { excludeVcenterIds: exclIds } : {};
  const cap = Number.isFinite(deps.countCap) && deps.countCap >= 1 ? Math.trunc(deps.countCap) : ISSUE_COUNT_CAP;
  const opt = { now, ...(Number.isFinite(deps.yieldMs) && deps.yieldMs > 0 ? { yieldMs: deps.yieldMs } : {}) };
  const rowsOf = (f) => (typeof db.queryAsync === 'function' ? db.queryAsync(f, ROWS, opt) : db.query(f, ROWS, 0));
  const countOf = async (f) => {
    if (typeof db.countCappedAsync === 'function') return db.countCappedAsync(f, cap, opt);
    if (typeof db.countCapped === 'function') return db.countCapped(f, cap);
    return { total: db.count(f), capped: false };   // 옛 구현(테스트 목) — 상한 없는 판
  };
  // 경고는 개수만 쓴다(목록은 오류만 분석한다) — v2.733 까지 경고 목록도 읽고 버렸다(기간을 한 번 더 훑었다).
  const errors = await rowsOf({ ...base, ...excl, severity: 'error' });
  const cErr = await countOf({ ...base, ...excl, severity: 'error' });
  const cWarn = await countOf({ ...base, ...excl, severity: 'warning' });
  const xErr = exclIds.length ? await countOf({ since, vcenterIds: exclIds, severity: 'error' }) : null;
  const xWarn = exclIds.length ? await countOf({ since, vcenterIds: exclIds, severity: 'warning' }) : null;
  const totalErr = cErr.total; const totalWarn = cWarn.total;
  const n = (c) => `${c.total}${c.capped ? '건 이상' : '건'}`;   // 상한에 닿은 개수를 정확한 값처럼 말하지 않는다

  const byType = new Map(); const byEntity = new Map();
  const bump = (map, k) => { if (!k) return; map.set(k, (map.get(k) || 0) + 1); };
  for (const e of errors) { bump(byType, e.type); bump(byEntity, e.entity); }

  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ key: k, count: c }));
  const topTypes = top(byType, 8);
  const topEntities = top(byEntity, 8);

  // 시간대별(시간 버킷) 오류 추세 — 스파이크 감지용.
  const hourly = new Map();
  for (const e of errors) { const h = Math.floor(e.ts / 3_600_000); hourly.set(h, (hourly.get(h) || 0) + 1); }
  const counts = [...hourly.values()];
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const peak = counts.length ? Math.max(...counts) : 0;

  // 패턴 진단
  const patterns = [];
  const reType = (re) => errors.filter((e) => re.test(`${e.type} ${e.message}`)).length;
  const connLost = reType(/ConnectionLost|Disconnect|NotResponding|lost connection|down/i);
  const authFail = reType(/Login.*fail|Authentication|Permission|AccessDenied|cannot.*login/i);
  const dsFull = reType(/Datastore.*full|space|capacity|usage/i);
  if (connLost >= 3) patterns.push({ sev: 'error', title: `연결 끊김/무응답 ${connLost}회`, detail: '호스트/서비스 연결 단절이 반복됩니다 — 네트워크·하드웨어·과부하 점검.' });
  if (authFail >= 3) patterns.push({ sev: 'warning', title: `인증 실패 ${authFail}회`, detail: '로그인/권한 오류 반복 — 자격증명 만료·브루트포스·계정 잠금 점검.' });
  if (dsFull >= 1) patterns.push({ sev: 'warning', title: `스토리지 용량 관련 ${dsFull}건`, detail: '데이터스토어 용량 이벤트 — 포화 임박 가능.' });
  if (topTypes[0] && topTypes[0].count >= 10) patterns.push({ sev: 'warning', title: `동일 오류 반복: ${topTypes[0].key} ${topTypes[0].count}회`, detail: '같은 유형 오류가 다수 발생 — 근본 원인 점검 필요.' });
  if (topEntities[0] && topEntities[0].count >= 10) patterns.push({ sev: 'warning', title: `오류 집중 대상: ${topEntities[0].key} ${topEntities[0].count}건`, detail: '특정 호스트/VM에 오류가 몰립니다 — 해당 자원 집중 점검.' });
  if (peak >= 20 && peak >= avg * 4) patterns.push({ sev: 'warning', title: `오류 스파이크 감지(최대 ${peak}건/시간)`, detail: `시간당 평균 ${avg.toFixed(1)}건 대비 급증 — 장애 시점 가능.` });
  const ncList = exclIds.length ? notCollectedList(nc) : [];
  const exclNote = ncList.length ? ` (이 포탈이 지금 이벤트를 수집하지 않는 vCenter ${ncList.length}곳은 분석에서 뺐습니다)` : '';
  const lagList = Array.isArray(lagging) ? lagging : [];
  // v2.772(Z4-2): 뒤처진 vCenter 가 있으면 '특이 패턴 없음' 은 받아 둔 이벤트에 한한 말이다 — 제목에 밝힌다.
  if (!patterns.length) patterns.push({ sev: 'ok', title: lagList.length ? '받아 둔 이벤트에는 특이 패턴 없음' : '특이 패턴 없음', detail: `최근 ${days}일 오류 ${n(cErr)} · 경고 ${n(cWarn)}, 반복/집중/스파이크 없음.${exclNote}` });
  if (lagList.length) {
    const one = vcId ? lagList.find((x) => x.vcenterId === vcId) : null;
    const worst = lagList.reduce((a, x) => (Number(x.lagMs) > Number(a?.lagMs ?? -1) ? x : a), null);
    patterns.unshift(one
      ? { sev: 'unknown', code: 'collect-lag', title: `이 vCenter 의 이벤트 수집이 ${eventLagText(one.lagMs)} 뒤처져 있습니다`,
        detail: `수집이 끝난 시각 뒤의 이벤트는 아직 받지 못했습니다(따라잡는 중일 수 있음) — 이 기간 결과는 일부입니다. 그 사이의 오류·경고는 위 개수에 없습니다.` }
      : { sev: 'unknown', code: 'collect-lag', title: `이벤트 수집이 뒤처진 vCenter ${lagList.length}곳 — 이 기간 결과는 일부입니다`,
        detail: `${lagList.slice(0, 5).map((x) => `${x.name || x.vcenterId}(${eventLagText(x.lagMs)})`).join(', ')}${lagList.length > 5 ? ` 외 ${lagList.length - 5}곳` : ''} — 수집이 끝난 시각 뒤의 오류·경고는 아직 받지 못했습니다(가장 긴 지연 ${eventLagText(worst?.lagMs)}).` });
  }

  return {
    window: { days, since },
    // v2.742(DB-02): errorsCapped·warningsCapped — 상한(countCap)에 닿아 '적어도 이만큼' 인 개수. 화면은 'N 이상' 으로 쓴다.
    summary: { errors: totalErr, warnings: totalWarn, peakPerHour: peak, avgPerHour: Number(avg.toFixed(1)),
      errorsCapped: cErr.capped === true, warningsCapped: cWarn.capped === true, countCap: cap },
    topTypes, topEntities, patterns,
    notCollected: ncList,
    lagging,   // v2.772(Z4-2): 수집이 뒤처진 vCenter [{vcenterId, okAt, lagMs, source}] — null 은 판정 못 함
    ...(ncList.length ? { excluded: { errors: xErr.total, warnings: xWarn.total,
      ...(xErr.capped ? { errorsCapped: true } : {}), ...(xWarn.capped ? { warningsCapped: true } : {}) } } : {}),
    generatedAt: Date.now(),
  };
}

/*
 * v2.742(감사 DB-02): 같은 조건의 분석은 짧게 기억한다 — 탭을 다시 열거나 vCenter·기간을 오가며 같은 조건을 다시 부를 때 기간 전체를
 *   또 훑지 않게. 키 = (vCenter · 기간 · 마지막으로 들어간 행 · 지금 수집하지 않는 vCenter 판정). 새 이벤트가 적재되면 키가 바뀌어 다시
 *   계산한다(마지막 rowid — 늦게 수집된 옛 시각 이벤트도 바뀐다). 기억 시간은 1분(지운 행·창 경계 이동은 그 안에서 늦게 반영된다).
 *   진행 중인 같은 조건은 합류한다(동시에 둘이 같은 기간을 훑지 않게). 실패는 기억하지 않는다. ⚠ 돌려받은 객체를 고치지 말 것 — 다른
 *   요청과 공유한다(라우트는 범위 필터를 사본에 건다).
 */
export const LOG_ISSUES_MEMO_TTL_MS = 60_000;
const MEMO_MAX = 32;
const _memo = new Map();   // key -> { at, v } | { p }
/** 테스트용 — 기억을 비운다. */
export function _resetLogIssuesMemo() { _memo.clear(); }
export async function analyzeLogsForIssuesMemo({ vcenterId = '', days = 7 } = {}, deps = {}) {
  const db = deps.db || await getLogsDb();
  const nc = deps.notCollected instanceof Map ? deps.notCollected : eventNotCollectedMap();
  const mark = typeof db.lastRowid === 'function' ? db.lastRowid() : null;
  // v2.772(Z4-2): 지연 vCenter 집합도 키에 넣는다 — 조용한 vCenter 가 따라잡기를 마치면(새 행 없이 okAt 만 전진) lastRowid 가 그대로라
  //   1분 동안 '뒤처짐' 을 계속 말할 수 있었다. 지연 길이는 매번 바뀌므로 id 만 넣는다(값은 기억한 결과의 것 — 최대 1분 낡음).
  const vcKey = String(vcenterId || '');
  const lagging = Array.isArray(deps.lagging) || deps.lagging === null ? deps.lagging
    : await eventLagForView({ db, now: Date.now(), only: vcKey ? [vcKey] : null, notCollected: nc, deps: deps.lag || {} });
  const key = JSON.stringify([vcKey, clampDays(days), mark, [...nc.entries()].sort(), lagging == null ? null : lagging.map((x) => x.vcenterId)]);
  const now = Date.now();
  const hit = _memo.get(key);
  if (hit && hit.p) return hit.p;
  if (hit && now - hit.at < LOG_ISSUES_MEMO_TTL_MS) return hit.v;
  const p = analyzeLogsForIssues({ vcenterId, days }, { ...deps, db, notCollected: nc, lagging });
  _memo.set(key, { p });
  try {
    const v = await p;
    _memo.set(key, { at: Date.now(), v });
    for (const [k, e] of _memo) { if (_memo.size <= MEMO_MAX) break; if (!e.p) _memo.delete(k); }   // 오래된 것부터(삽입 순) — 진행 중은 두고
    return v;
  } catch (e) { _memo.delete(key); throw e; }
}
