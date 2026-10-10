/**
 * 로그 자체 분석 — 장기 보관된 vCenter 로그에서 장애/이슈 패턴을 휴리스틱으로 찾아낸다.
 * 최근 기간의 오류/경고를 유형·대상별로 집계하고, 반복/집중/연결끊김/인증실패 등을 표면화.
 */

import { getLogsDb } from '../logs/db.js';
import { eventNotCollectedMap, notCollectedList, EVENT_NOT_COLLECTED_TEXT } from '../logs/coverage.js';

const DAY = 86_400_000;
const ROWS = 5000;
const ROWS_SCAN_MAX = 25_000;   // v2.733: 제외 vCenter 행을 거른 뒤에도 최신 ROWS 건을 채우려고 더 읽는 상한

/**
 * @param {{vcenterId?:string, days?:number}} opts
 * @param {{db?:object, notCollected?:Map<string,string>}} [deps] 테스트·호출부 주입(기본: logs DB · logs/coverage.js 판정)
 *
 * v2.733(점검 3회차 C1-01): 이 포탈이 지금 이벤트를 직접 수집하지 않는 vCenter(엣지 위임·비활성·점검중 — v2.732 B4-01)를
 *   '특이 패턴 없음' 에 섞지 않는다.
 *   · 그 vCenter 를 골랐으면 분석하지 않고 `sev:'unknown'` 하나를 낸다 — 남은 옛 이벤트(수집을 멈추기 전)로 지금 상태를 판정하지 않는다.
 *     수치는 null(0 이 아니다).
 *   · 전체 보기는 그 vCenter 의 이벤트를 분석에서 빼고 `notCollected`(id·사유) + `excluded`(기간 안 뺀 오류·경고 수)로 밝힌다.
 */
export async function analyzeLogsForIssues({ vcenterId = '', days = 7 } = {}, deps = {}) {
  const db = deps.db || await getLogsDb();
  const nc = deps.notCollected instanceof Map ? deps.notCollected : eventNotCollectedMap();
  const since = Date.now() - Math.max(1, days) * DAY;
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
  const base = { vcenterId: vcId, since };
  // 전체 보기: 지금 수집하지 않는 vCenter 의 행은 분석에서 뺀다. 개수는 그 vCenter 들만 센 값을 빼서 정확히 맞추고(포함 목록을 만들지 않는다 —
  //   삭제된 vCenter 의 옛 이벤트도 예전처럼 분석에 남는다), 목록은 뺀 행만큼 더 읽어 최신 ROWS 건을 채운다(상한 ROWS_SCAN_MAX).
  const exclIds = vcId ? [] : [...nc.keys()];
  const excl = exclIds.length ? new Set(exclIds) : null;
  const exclErr = excl ? db.count({ since, vcenterIds: exclIds, severity: 'error' }) : 0;
  const exclWarn = excl ? db.count({ since, vcenterIds: exclIds, severity: 'warning' }) : 0;
  const keep = (rows) => (excl ? rows.filter((r) => !excl.has(String(r.vcenterId))).slice(0, ROWS) : rows);
  const errors = keep(db.query({ ...base, severity: 'error' }, Math.min(ROWS_SCAN_MAX, ROWS + exclErr), 0));
  const warnings = keep(db.query({ ...base, severity: 'warning' }, Math.min(ROWS_SCAN_MAX, ROWS + exclWarn), 0));
  const totalErr = db.count({ ...base, severity: 'error' }) - exclErr;
  const totalWarn = db.count({ ...base, severity: 'warning' }) - exclWarn;

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
  const ncList = excl ? notCollectedList(nc) : [];
  const exclNote = ncList.length ? ` (이 포탈이 지금 이벤트를 수집하지 않는 vCenter ${ncList.length}곳은 분석에서 뺐습니다)` : '';
  if (!patterns.length) patterns.push({ sev: 'ok', title: '특이 패턴 없음', detail: `최근 ${days}일 오류 ${totalErr} · 경고 ${totalWarn}건, 반복/집중/스파이크 없음.${exclNote}` });

  return {
    window: { days, since },
    summary: { errors: totalErr, warnings: totalWarn, peakPerHour: peak, avgPerHour: Number(avg.toFixed(1)) },
    topTypes, topEntities, patterns,
    notCollected: ncList,
    ...(ncList.length ? { excluded: { errors: exclErr, warnings: exclWarn } } : {}),
    generatedAt: Date.now(),
  };
}
