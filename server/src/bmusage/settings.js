/**
 * bmusage/settings.js — 베어메탈 사용률 수집 설정(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고
 * 싶어"(서버 분석 › 구분 › **Baremetal(미가상화 물리)**).
 * 선택: **iDRAC + OS SSH 둘 다(되는 것부터)** · **법인 단위로 켠다** · **5분 · 원시 90일 + 일롤업
 * 5년** · **Linux + Windows 둘 다**.
 *
 * ── 왜 법인 단위인가(사용자 선택) ────────────────────────────────────────────
 * 이 현장은 등록 서버 1,135대 · 법인 16곳이다(사용자 화면). 전량을 한 번에 켜면 주기마다
 * iDRAC·SSH 세션이 수백 개 열린다. 법인별로 켜서 회선·장비 부하를 눈으로 보며 늘리는 것이 설계다.
 *
 * ⚠ **기본 꺼짐(opt-in)** — 켜지 않은 법인은 대상 0대다(빈 화면은 '이상' 이 아니라 '안 켰다' 다).
 * ⚠ 주기·보존 **숫자를 화면 문구에 박지 말 것** — 이 모듈이 주는 값만 쓴다(CLAUDE.md 규약).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'bmusage-settings.json');

/** 사용자가 고른 기본값. 주기 5분 · 원시 90일 · 일 롤업 5년. */
export const DEFAULTS = Object.freeze({
  enabled: false,
  corps: {},                 // { [vcenterId]: true }  — 켠 법인만
  includeUnassigned: false,  // 법인 귀속이 없는 베어메탈도 수집할지(기본 제외 — 어느 법인 부하인지 모른다)
  intervalMs: 5 * 60_000,
  rawRetentionDays: 90,
  dailyRetentionDays: 365 * 5,
  osSsh: true,               // OS SSH 경로(디스크·네트워크·HBA 를 주는 유일한 경로)
  idracTelemetry: true,      // iDRAC 텔레메트리 경로(CPU·MEM·IO — 새 자격증명 0)
  /*
   * 텔레메트리 **전수 모드**(v2.551 — 사용자 요청): 리포트 목록을 열거해 NIC·FC 통계까지 읽는다.
   * 켜면 OS 계정이 없는 서버도 네트워크·HBA 값이 나온다. 왕복이 늘지만 목록 캐시(6시간) +
   * 주기당 목록 조회 예산으로 주기를 넘기지 않는다(`redfish.js` 의 예산 계산 주석 참조).
   * ⚠ 끄면 v2.550 처럼 `SystemUsage` 하나만 읽는다 — 회선이 아주 좁은 법인의 탈출구로 남긴다.
   */
  idracFullTelemetry: true,
  /*
   * 임계 초과 알림(v2.551 — 사용자 요청). ⚠ **기본 꺼짐**이다: 200대 × 5분이면 하루 5.76만 판정이라
   * 폭주 위험이 실재한다. 켜기 전에 임계·지속·재알림을 확인하게 한다.
   *  · `alertSustainMin` — 연속 초과가 이만큼 지속돼야 알린다(한 주기 스파이크 무시)
   *  · `alertRepeatHours` — 같은 서버·같은 지표의 재알림 억제
   */
  alertEnabled: false,
  alertPct: 90,
  alertSustainMin: 15,
  alertRepeatHours: 6,
});

/** 하한·상한은 서버가 강제한다(화면 입력을 믿지 않는다). */
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 3_600_000;
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 3_000;

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }        // 없거나 손상 = 기본값(재생성 가능한 설정 — preserveCorrupt 대상 아님)
}

/** 정규화(순수) — 테스트가 하한·상한을 고정한다. */
export function normalizeSettings(raw = {}) {
  const corps = {};
  const src = raw.corps && typeof raw.corps === 'object' ? raw.corps : {};
  for (const [k, v] of Object.entries(src)) {
    const id = String(k || '').trim();
    if (id && v) corps[id] = true;          // 켠 것만 남긴다(false 를 쌓아 두지 않는다)
  }
  return {
    enabled: !!raw.enabled,
    corps,
    includeUnassigned: !!raw.includeUnassigned,
    intervalMs: clampInt(raw.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULTS.intervalMs),
    // 원시 보존은 행 수를 직접 정한다 — 하한 7일(그 아래면 증가 추세를 못 본다), 상한 365일.
    idracFullTelemetry: raw.idracFullTelemetry !== false,
    alertEnabled: raw.alertEnabled === true,
    alertPct: clampInt(raw.alertPct, 50, 100, DEFAULTS.alertPct),
    alertSustainMin: clampInt(raw.alertSustainMin, 0, 240, DEFAULTS.alertSustainMin),
    alertRepeatHours: clampInt(raw.alertRepeatHours, 1, 168, DEFAULTS.alertRepeatHours),
    rawRetentionDays: clampInt(raw.rawRetentionDays, 7, 365, DEFAULTS.rawRetentionDays),
    dailyRetentionDays: clampInt(raw.dailyRetentionDays, 30, 365 * 10, DEFAULTS.dailyRetentionDays),
    osSsh: raw.osSsh === undefined ? DEFAULTS.osSsh : !!raw.osSsh,
    idracTelemetry: raw.idracTelemetry === undefined ? DEFAULTS.idracTelemetry : !!raw.idracTelemetry,
  };
}

export function loadBmUsageSettings() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;
  _cache = normalizeSettings(readFile());
  _cacheAt = now;
  return _cache;
}

export function saveBmUsageSettings(body = {}) {
  const next = normalizeSettings({ ...loadBmUsageSettings(), ...body });
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cache = next; _cacheAt = Date.now();
  return next;
}

/** env 로 강제 끄기(현장 탈출구). `BMUSAGE_ENABLED=false` 면 설정과 무관하게 꺼진다. */
export function bmUsageEnabled() {
  const env = String(process.env.BMUSAGE_ENABLED || '').trim().toLowerCase();
  if (env === 'false' || env === '0') return false;
  if (env === 'true' || env === '1') return true;
  return loadBmUsageSettings().enabled;
}

export function _resetForTest() { _cache = null; _cacheAt = 0; }
