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
    cache.lastRunTs = Date.now();
    persist();
    return { ok: results.length === 0 || results.some((r) => /:(2\d\d)/.test(r)), results, issues: report.summary.issues };
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
  await runDailyReportNow();
  console.log('[daily-report] 일일 헬스체크 리포트 발송 완료');
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
