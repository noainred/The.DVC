/**
 * 일일 헬스체크 리포트 발송 스케줄러 — 매일 지정 시각(HH:MM)에 computeHealthReport 결과를
 * 알림 채널(Slack/Teams/웹훅)로 발송한다. 저장소에 wall-clock 스케줄러가 없어 새로 만든다:
 * 1분 틱에서 "설정 시각을 지났고 오늘 아직 안 보냈으면 실행" — 프로세스 재시작·시각 변경에
 * 안전(guestScanScheduler의 lastRun 패턴). lastRunTs는 설정 파일에 함께 persist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { store } from '../store.js';
import { sendText } from '../alerts.js';
import { computeHealthReport, buildDailyReportText } from './healthReport.js';
import { certStatus } from '../security/certMonitor.js';
import { localClock, dayKey, DAY_OFFSET_MIN } from "../util/dayKey.js";

const FILE = path.join(config.configDir, 'daily-report.json');
const DEFAULTS = { enabled: false, hour: 8, minute: 0, snapshotAgeDays: 3, dsWarnPct: 85, lastRunTs: 0, lastRunBy: null, lastManualTs: 0 };

let cache = null;
let timer = null;
let running = false;

/**
 * v2.603(감사 TIM2603-02): 전 채널이 실패하거나 채널이 없으면 lastRunTs 를 갱신하지 않으므로(v2.447 B6 — '그날 다시 시도하지
 * 않던' 결함의 수정) 예전에는 **1분 틱마다** 다시 보냈다 — 웹훅이 계속 실패하는 현장이면 하루 최대 1,440회 발송 시도·로그다.
 * 재시도는 유지하되(조용히 그날을 건너뛰지 않는다) 간격을 늘린다: 연속 실패 1회 뒤 15분 → 30분 → 60분(상한). 성공하면
 * 초기화한다. **수동 발송(runDailyReportNow)은 막지 않는다** — 설정을 고친 뒤 바로 확인할 길이 있어야 한다.
 * 인메모리다(재시작하면 첫 틱에 한 번 더 시도한다 — 재시작 횟수만큼이라 유계다).
 */
const FAIL_BACKOFF_BASE_MS = 15 * 60_000;
const FAIL_BACKOFF_MAX_MS = 60 * 60_000;
let failState = { streak: 0, lastFailAt: null, nextAt: null, lastReason: '' };
export function dailyReportBackoffMs(streak) {
  const n = Math.max(1, Math.floor(Number(streak) || 1));
  return Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_BASE_MS * 2 ** Math.min(10, n - 1));
}
function noteResult(r, nowTs = Date.now()) {
  if (r?.ok) { failState = { streak: 0, lastFailAt: null, nextAt: null, lastReason: '' }; return; }
  const streak = failState.streak + 1;
  failState = { streak, lastFailAt: nowTs, nextAt: nowTs + dailyReportBackoffMs(streak), lastReason: String(r?.reason || '').slice(0, 300) };
}

export function loadDailyReportSettings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = {
        enabled: !!s.enabled,
        hour: Math.min(23, Math.max(0, Number.isFinite(Number(s.hour)) ? Number(s.hour) : 8)),
        minute: Math.min(59, Math.max(0, Number(s.minute) || 0)),
        snapshotAgeDays: Math.min(365, Math.max(1, Number(s.snapshotAgeDays) || 3)),
        dsWarnPct: Math.min(99, Math.max(50, Number(s.dsWarnPct) || 85)),
        lastRunTs: Number(s.lastRunTs) || 0,
        // v2.743(TIMING-04): 오늘 몫을 처리한 발송이 예약('schedule')인지 수동('manual')인지 · 마지막 수동 발송 시각(예약 기준과 별개).
        lastRunBy: s.lastRunBy === 'manual' || s.lastRunBy === 'schedule' ? s.lastRunBy : null,
        lastManualTs: Number(s.lastManualTs) || 0,
      };
    }
  } catch (e) {
    // v2.595(감사 FS-4): 손상을 조용히 기본값으로 넘기면 다음 저장이 원본을 덮는다 — 원본을 보존하고 알린다.
    preserveCorrupt(FILE, e?.message);
    console.warn(`[daily-report] 설정 파일을 읽지 못해 기본값으로 시작합니다(원본 보존): ${e?.message}`);
  }
  return cache;
}

function persist() {
  atomicWriteFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export function saveDailyReportSettings(body = {}) {
  const cur = loadDailyReportSettings();
  cache = {
    enabled: body.enabled != null ? !!body.enabled : cur.enabled,
    // v2.586 — 화면은 blur 마다 칸의 원문을 보낸다. 빈 칸('')을 0·기본값으로 읽으면 시각을 지우는 순간
    //   발송이 00:00 으로 옮겨졌다. 빈 값·숫자 아님은 '미지정' = 현재 값 유지.
    hour: Math.min(23, Math.max(0, Math.trunc(numOrNull(body.hour) ?? cur.hour))),
    minute: Math.min(59, Math.max(0, Math.trunc(numOrNull(body.minute) ?? cur.minute))),
    snapshotAgeDays: Math.min(365, Math.max(1, numOrNull(body.snapshotAgeDays) ?? cur.snapshotAgeDays)),
    dsWarnPct: Math.min(99, Math.max(50, numOrNull(body.dsWarnPct) ?? cur.dsWarnPct)),
    lastRunTs: cur.lastRunTs,
    lastRunBy: cur.lastRunBy ?? null,
    lastManualTs: cur.lastManualTs || 0,
  };
  persist();
  return cache;
}

/**
 * 발송 1회. 재진입 가드는 예약·수동이 공유한다.
 * v2.743(감사 TIMING-04 — 재현): `manual`(화면의 '지금 발송(테스트)')이면 예약 기준 `lastRunTs` 를 **정한 시각 전에는** 바꾸지 않는다.
 *   예전에는 수동 성공도 같은 lastRunTs 를 세워, 정한 시각 전에 테스트하면 dailyReportDue 가 '오늘 이미 발송' 으로 보고 **그날 정기
 *   리포트를 건너뛰었다**(재현: 07:00 테스트 → 08:00 예약 생략). 수동 성공 시각은 `lastManualTs` 에 따로 남긴다.
 *   · 정한 시각이 이미 지났는데 오늘 몫이 아직 안 나간 상태(예약이 실패해 재시도 대기 중 등)에서 수동 발송이 성공하면, 그것이 오늘
 *     리포트다 — 그때는 예약 기준도 세운다(`lastRunBy:'manual'`). 세우지 않으면 고친 직후 같은 리포트가 1분 뒤 한 번 더 나간다.
 *     판정은 dailyReportDue 하나다(완료 시각 기준 — 정한 시각 직전에 시작해 직후에 끝난 발송이 예약과 겹쳐 두 번 나가지 않게).
 */
export async function runDailyReportNow({ manual = false } = {}) {
  if (running) return { ok: false, reason: '이미 발송이 진행 중입니다.' };
  running = true;
  try {
    const s = loadDailyReportSettings();
    const report = computeHealthReport(store.get(), { snapshotAgeDays: s.snapshotAgeDays, dsWarnPct: s.dsWarnPct, certs: certStatus() });
    const text = buildDailyReportText(report);
    const results = await sendText(text, '일일 헬스체크 리포트');
    // v2.447(감사 B6): 예전에는 성공 여부와 무관하게 lastRunTs 를 갱신해, 웹훅이 전부 실패해도
    // tick() 이 '오늘 이미 발송' 으로 보고 **그날 다시 시도하지 않았다**(운영자는 리포트를 못 받고
    // 로그에는 '발송 완료' 만 남았다). 이제 한 채널이라도 2xx 일 때만 갱신해 다음 틱에 재시도한다.
    // 채널이 하나도 없으면 성공이 아니라 '설정 없음' 으로 정직하게 알린다(테스트 발송이 아무 데도
    // 안 갔는데 성공으로 보이던 문제).
    if (!results.length) {
      return { ok: false, reason: '알림 채널이 설정되지 않았습니다 — 설정 › 알림 에서 Slack/Teams/이메일을 먼저 등록하세요.', results, issues: report.summary.issues };
    }
    const anyOk = anySendOk(results);
    let countedAsScheduled = false;
    if (anyOk) {
      const at = Date.now();
      if (!manual) { cache.lastRunTs = at; cache.lastRunBy = 'schedule'; countedAsScheduled = true; }
      else {
        cache.lastManualTs = at;
        if (dailyReportDue(cache, at)) { cache.lastRunTs = at; cache.lastRunBy = 'manual'; countedAsScheduled = true; }
      }
      persist();
      failState = { streak: 0, lastFailAt: null, nextAt: null, lastReason: '' };
    }
    return { ok: anyOk, results, issues: report.summary.issues, ...(manual ? { manual: true, countedAsScheduled } : {}), ...(anyOk ? {} : { reason: '모든 알림 채널 전송에 실패했습니다 — 다음 주기에 재시도합니다.' }) };
  } finally {
    running = false;
  }
}

/**
 * 한 채널이라도 보냈는가(v2.743 리드 통합 — 기존 결함). sendText 결과는 웹훅 'slack:200' · 메일 'email:ok'/'email:err …'/'email:skip' 이다.
 * 예전 판정은 /:(2\d\d)/ 하나라 **메일만 쓰는 현장**에서 발송이 성공해도 실패로 읽어 lastRunTs 를 세우지 않았고,
 * 다음 틱(최대 하루 내내)마다 같은 보고서를 다시 보냈다. 판정은 alerts.js 테스트 발송(:786)과 같은 규칙이다.
 */
export function anySendOk(results) {
  return Array.isArray(results) && results.some((r) => /:(2\d\d|ok)\b/.test(String(r)));
}

// v2.582 BUG-5: 발송 시각·'오늘 이미 발송' 판정은 **서버 프로세스 TZ 가 아니라 포탈 날짜 오프셋**(기본 UTC+9)
// 기준이다. 예전엔 `getHours()`·`toDateString()` 이라 TZ 가 UTC 인 호스트(패키지 unit 은 TZ 를 지정하지
// 않는다)에서는 '08시' 로 설정한 보고가 **17시(KST)** 에 나갔다. 화면은 이 오프셋을 `dailyReportStatus().tzOffsetMin` 으로 받아 적는다.
export function dailyReportDue(s, nowTs = Date.now()) {
  const c = localClock(nowTs);
  const due = c.hour > s.hour || (c.hour === s.hour && c.minute >= s.minute);
  if (!due) return false;
  if (s.lastRunTs && dayKey(s.lastRunTs) === c.day) return false; // 오늘(오프셋 기준) 이미 발송
  return true;
}

/** 테스트에서 틱을 직접 돌리게 export 한다. nowTs·run 은 테스트 주입용. */
export async function dailyReportTick(nowTs = Date.now(), run = runDailyReportNow) {
  const s = loadDailyReportSettings();
  if (!s.enabled) return { skipped: 'disabled' };
  if (!dailyReportDue(s, nowTs)) return { skipped: 'not-due' };
  if (failState.nextAt != null && nowTs < failState.nextAt) return { skipped: 'backoff', nextAt: failState.nextAt };
  // v2.604(감사 RECENT2604-03 — 재현): run() 이 던지면(보고서 계산·스냅샷 예외) noteResult 를 건너뛰어 백오프가 걸리지 않고
  //   매 분 다시 시도했다(v2.603 TIM2603-02 가 만든 백오프의 구멍). 예외도 실패 한 번으로 센다.
  let r;
  try { r = await run(); } catch (e) { r = { ok: false, reason: `발송 중 예외: ${e?.message || e}` }; }
  if (r?.reason === '이미 발송이 진행 중입니다.') return { skipped: 'running' };   // 수동 발송과 겹침 — 실패로 세지 않는다
  noteResult(r, nowTs);
  if (r?.ok) console.log('[daily-report] 일일 헬스체크 리포트 발송 완료');
  // ⚠ 문장 형식은 로그 분석 카탈로그(loganalysis/catalog.js 'daily-report-fail')의 정규식·probe 와 짝이다 — 바꾸면 함께 바꿀 것.
  else console.warn(`[daily-report] 발송 실패 — ${r?.reason || '알 수 없는 오류'} · 연속 실패 ${failState.streak}회 (${Math.round(dailyReportBackoffMs(failState.streak) / 60_000)}분 뒤 다시 시도)`);
  return { ran: true, ok: !!r?.ok };
}
const tick = () => dailyReportTick();

export function dailyReportStatus() {
  const s = loadDailyReportSettings();
  // v2.603(TIM2603-02): 연속 실패·다음 자동 시도 시각을 함께 준다(재시도 간격을 늘린 사실을 숨기지 않는다).
  return { ...s, running, schedulerOn: !!timer, tzOffsetMin: DAY_OFFSET_MIN,
    failStreak: failState.streak, lastFailAt: failState.lastFailAt, nextRetryAt: failState.nextAt, lastFailReason: failState.lastReason };
}

export function startDailyReport() {
  timer = setInterval(() => tick().catch((e) => console.warn('[daily-report] 실패:', e.message)), 60_000);
  timer.unref?.();
  console.log('[daily-report] 스케줄러 시작 (1분 틱)');
}

/** 테스트 전용. */
export function _resetDailyReportForTest() { cache = null; running = false; failState = { streak: 0, lastFailAt: null, nextAt: null, lastReason: '' }; }
