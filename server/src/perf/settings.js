/**
 * perf/settings.js — 서버 성능 측정 설정(`perf-monitor.json`, v2.498, 사용자 요청 "설정에 서버 성능
 * 측정 메뉴 만들고, hang 현상이 발생할 때 로그를 찍어 나중에 튜닝할 때 쓰게 하자").
 * 다른 설정 스토어와 같이 원자적 쓰기 + preserveCorrupt + 모듈 캐시.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'perf-monitor.json');

export const LIMITS = Object.freeze({
  slowRequestMs: { min: 200, max: 120_000 },   // 이 이상 걸린 요청을 '느린 요청' 으로 기록
  hangLagMs: { min: 100, max: 30_000 },        // 이벤트 루프 창 max 가 이 이상이면 hang 이벤트
  clientStuckMs: { min: 10_000, max: 600_000 },// 화면이 이 이상 '불러오는 중' 이면 브라우저가 보고
  keep: { min: 50, max: 5_000 },               // 느린 요청·hang 링 보관 건수
  retentionDays: { min: 1, max: 90 },          // hang 로그 파일 보존일
});

export const DEFAULTS = Object.freeze({
  enabled: true,
  slowRequestMs: 3_000,
  hangLagMs: 1_000,
  clientStuckMs: 60_000,
  keepSlow: 500,
  keepHangs: 500,
  retentionDays: 14,
});

const clamp = (v, lim, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, Math.round(n))) : dflt;
};
/**
 * 값이 '지정됐는지' 판정. **빈 문자열은 미지정으로 버린다** — Number('') === 0 은 유한값이라
 * clamp 를 타고 **최소값으로 승격**된다. 그러면 관리자가 숫자 칸을 비운 채 저장하는 순간
 * 보존일이 1일이 되고, 같은 요청의 정리에서 hang 기록이 즉시 지워진다(적대적 리뷰 지적).
 * 루트 CLAUDE.md 의 '빈 값·0 은 하한으로 승격하지 않고 미지정으로 버린다'(스토리지 주기 배포 계약)와 같은 규칙.
 */
const given = (v) => v != null && String(v).trim() !== '';

let cache = null;

export function loadPerfSettings() {
  if (cache) return cache;
  const out = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (given(p.slowRequestMs)) out.slowRequestMs = clamp(p.slowRequestMs, LIMITS.slowRequestMs, DEFAULTS.slowRequestMs);
      if (given(p.hangLagMs)) out.hangLagMs = clamp(p.hangLagMs, LIMITS.hangLagMs, DEFAULTS.hangLagMs);
      if (given(p.clientStuckMs)) out.clientStuckMs = clamp(p.clientStuckMs, LIMITS.clientStuckMs, DEFAULTS.clientStuckMs);
      if (given(p.keepSlow)) out.keepSlow = clamp(p.keepSlow, LIMITS.keep, DEFAULTS.keepSlow);
      if (given(p.keepHangs)) out.keepHangs = clamp(p.keepHangs, LIMITS.keep, DEFAULTS.keepHangs);
      if (given(p.retentionDays)) out.retentionDays = clamp(p.retentionDays, LIMITS.retentionDays, DEFAULTS.retentionDays);
    }
  } catch (e) {
    preserveCorrupt(FILE);
    console.warn(`[perf] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`);
  }
  cache = out;
  return cache;
}

export function savePerfSettings(body = {}) {
  const next = { ...loadPerfSettings() };
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (given(body.slowRequestMs)) next.slowRequestMs = clamp(body.slowRequestMs, LIMITS.slowRequestMs, next.slowRequestMs);
  if (given(body.hangLagMs)) next.hangLagMs = clamp(body.hangLagMs, LIMITS.hangLagMs, next.hangLagMs);
  if (given(body.clientStuckMs)) next.clientStuckMs = clamp(body.clientStuckMs, LIMITS.clientStuckMs, next.clientStuckMs);
  if (given(body.keepSlow)) next.keepSlow = clamp(body.keepSlow, LIMITS.keep, next.keepSlow);
  if (given(body.keepHangs)) next.keepHangs = clamp(body.keepHangs, LIMITS.keep, next.keepHangs);
  if (given(body.retentionDays)) next.retentionDays = clamp(body.retentionDays, LIMITS.retentionDays, next.retentionDays);
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function _resetPerfSettingsCache() { cache = null; }
