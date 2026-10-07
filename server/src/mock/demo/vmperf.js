/**
 * mock/demo/vmperf.js — 데모(DATA_SOURCE=mock) VM 할당·사용 추이 백필(v2.718).
 *
 * 배경: 최적화 › 추이(그리고 vCenter 상세 '📈 추이')가 데모에서 '추이 데이터가 아직 없습니다 — 표본은 오늘부터' 였다.
 *   vCenter 별 vmperf DB 는 샘플러가 매 주기 한 점씩 쌓으므로 새로 띄운 데모 서버에는 과거가 없다.
 * 규칙(mock/demo/flags.js 머리말과 같다)
 *  · mock 모드에서만, 그 vCenter 의 첫 표본이 최근 2일 이내일 때만(= 과거 이력이 없을 때만) 한 번 채운다.
 *  · 값은 지금 샘플러가 적재한 값에서 결정적으로 만든다 — 시간대(업무 시간 높음)·요일·완만한 증가 추세.
 *    할당량은 사용량보다 천천히 바뀐다(계단). 실제로 접속하지 않는다.
 */
import { isMockMode, demoHash } from './flags.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RECENT_MS = 2 * DAY;
// v2.719(감사 R2-04): 래치는 vCenter 단위다. 예전 전역 _done 은 작업 전에 서서, 빈 첫 호출(VM 이 아직 없는 스냅샷)·
//   적재 실패·나중에 생긴 vCenter 가 재시작 전까지 백필되지 않았다. 채웠거나 이미 과거가 있는 vCenter 만 기록하고
//   나머지는 다음 샘플에 다시 본다.
const _doneVc = new Set();
const _runningVc = new Set();   // 샘플러는 기다리지 않고 부른다 — 진행 중인 vCenter 를 두 호출이 함께 채우지 않게

/** 과거 시각 t 의 계수(순수 · 결정적). 사용량은 하루·주 주기 + 증가 추세, 할당량은 느린 계단. */
export function demoVmperfFactor(metric, k, t, now) {
  const ageDays = (now - t) / DAY;
  const trend = 1 - Math.min(0.18, ageDays * 0.002);              // 과거로 갈수록 최대 18% 낮다(증가 추세)
  if (/alloc|cap/.test(metric)) return Math.max(0.6, 1 - Math.floor(ageDays / 14) * 0.012); // 2주마다 조금씩 늘어난 할당
  const hourKst = (Math.floor(t / HOUR) + 9) % 24;
  const dow = new Date(t + 9 * HOUR).getUTCDay();
  const daily = 0.82 + 0.18 * Math.sin(((hourKst - 6) / 24) * 2 * Math.PI); // 오후 높음
  const weekend = dow === 0 || dow === 6 ? 0.85 : 1;
  const jitter = 0.97 + (demoHash(`${metric}|${k}|${Math.floor(t / HOUR)}`) % 60) / 1000;
  return trend * daily * weekend * jitter;
}

/**
 * 샘플러가 이번 주기에 적재한 vCenter 별 행(Map vcId → [{metric,k,v}])으로 과거 days 일을 시간 단위로 채운다.
 * @returns {Promise<{filled:number, vcenters:number}|{skipped:string}>}
 */
export async function demoVmperfBackfill(byVc, ts = Date.now(), { days = 90 } = {}) {
  if (!isMockMode()) return { skipped: 'not-mock' };
  if (!byVc || typeof byVc[Symbol.iterator] !== 'function') return { skipped: 'no-rows' };
  const pending = [...byVc].filter(([vcId, rows]) => rows?.length && !_doneVc.has(vcId) && !_runningVc.has(vcId));
  if (!pending.length) return { skipped: 'done' };
  for (const [vcId] of pending) _runningVc.add(vcId);
  try { return await backfillPending(pending, ts, days); } finally { for (const [vcId] of pending) _runningVc.delete(vcId); }
}

async function backfillPending(pending, ts, days) {
  const { insertVmperf, vmperfMeta } = await import('../../metrics/vmperfDb.js');
  let filled = 0; let vcs = 0;
  for (const [vcId, rows] of pending) {
    let meta;
    try { meta = await vmperfMeta(vcId, rows[0].metric); } catch { continue; }   // 못 읽었으면 다음 샘플에 다시
    if (meta?.firstTs != null && meta.firstTs < ts - RECENT_MS) { _doneVc.add(vcId); continue; }   // 이미 과거가 있다 — 건드리지 않는다
    const stop = (meta?.firstTs ?? ts) - HOUR;
    vcs += 1;
    let failed = false;
    for (let t = Math.floor((ts - days * DAY) / HOUR) * HOUR; t <= stop; t += HOUR) {
      const past = rows.map((r) => ({ metric: r.metric, k: r.k, v: Math.round(r.v * demoVmperfFactor(r.metric, r.k, t, ts) * 10) / 10 }));
      try { filled += await insertVmperf(vcId, past, t); } catch (e) { console.warn(`[mock] vmperf 데모 백필 실패(${vcId || '전체'}) — 다음 샘플에 다시 시도: ${e.message}`); failed = true; break; }
      if ((t / HOUR) % 240 === 0) await new Promise((r) => setImmediate(r));   // 긴 루프 — 이벤트 루프에 양보
    }
    if (!failed) _doneVc.add(vcId);
  }
  if (vcs) console.log(`[mock] VM 할당·사용 추이 데모 백필: vCenter ${vcs}개 · ${days}일 · ${filled}행`);
  return { filled, vcenters: vcs };
}

export function _resetVmperfDemoForTest() { _doneVc.clear(); _runningVc.clear(); }
