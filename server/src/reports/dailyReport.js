/**
 * 일일 헬스체크 리포트 발송 스케줄러 — 매일 지정 시각(HH:MM)에 computeHealthReport 결과를
 * 알림 채널(Slack/Teams/웹훅)로 발송한다. 저장소에 wall-clock 스케줄러가 없어 새로 만든다:
 * 1분 틱에서 "설정 시각을 지났고 오늘 아직 안 보냈으면 실행" — 프로세스 재시작·시각 변경에
 * 안전(guestScanScheduler의 lastRun 패턴). lastRunTs는 설정 파일에 함께 persist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { store } from '../store.js';
import { sendText } from '../alerts.js';
import { computeHealthReport, buildDailyReportText } from './healthReport.js';
import { certStatus } from '../security/certMonitor.js';

const FILE = path.join(config.configDir, 'daily-report.json');
const DEFAULTS = { enabled: false, hour: 8, minute: 0, snapshotAgeDays: 3, dsWarnPct: 85, lastRunTs: 0 };

let cache = null;
let timer = null;
let running = false;

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
      };
    }
  } catch { /* defaults */ }
  return cache;
}

function persist() {
  atomicWriteFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export function saveDailyReportSettings(body = {}) {
  const cur = loadDailyReportSettings();
  cache = {
    enabled: body.enabled != null ? !!body.enabled : cur.enabled,
    hour: body.hour != null ? Math.min(23, Math.max(0, Number(body.hour) || 0)) : cur.hour,
    minute: body.minute != null ? Math.min(59, Math.max(0, Number(body.minute) || 0)) : cur.minute,
    snapshotAgeDays: body.snapshotAgeDays != null ? Math.min(365, Math.max(1, Number(body.snapshotAgeDays) || 3)) : cur.snapshotAgeDays,
    dsWarnPct: body.dsWarnPct != null ? Math.min(99, Math.max(50, Number(body.dsWarnPct) || 85)) : cur.dsWarnPct,
    lastRunTs: cur.lastRunTs,
  };
  persist();
  return cache;
}

/** 즉시 발송(관리자 테스트/수동 실행). 재진입 가드 공유. */
export async function runDailyReportNow() {
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
    const anyOk = results.some((r) => /:(2\d\d)/.test(r));
    if (anyOk) { cache.lastRunTs = Date.now(); persist(); }
    return { ok: anyOk, results, issues: report.summary.issues, ...(anyOk ? {} : { reason: '모든 알림 채널 전송에 실패했습니다 — 다음 주기에 재시도합니다.' }) };
  } finally {
    running = false;
  }
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

async function tick() {
  const s = loadDailyReportSettings();
  if (!s.enabled) return;
  const now = new Date();
  const due = now.getHours() > s.hour || (now.getHours() === s.hour && now.getMinutes() >= s.minute);
  if (!due) return;
  if (s.lastRunTs && sameDay(s.lastRunTs, now.getTime())) return; // 오늘 이미 발송
  const r = await runDailyReportNow();
  if (r?.ok) console.log('[daily-report] 일일 헬스체크 리포트 발송 완료');
  else console.warn(`[daily-report] 발송 실패 — ${r?.reason || '알 수 없는 오류'} (다음 틱에 재시도)`);
}

export function dailyReportStatus() {
  const s = loadDailyReportSettings();
  return { ...s, running, schedulerOn: !!timer };
}

export function startDailyReport() {
  timer = setInterval(() => tick().catch((e) => console.warn('[daily-report] 실패:', e.message)), 60_000);
  timer.unref?.();
  console.log('[daily-report] 스케줄러 시작 (1분 틱)');
}
