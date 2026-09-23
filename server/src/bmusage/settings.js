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
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

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
   * ⚠⚠ **Enterprise 라이선스 대체 수집**(v2.554 — 사용자 신고 "내가 가진건 enterprise 라이선스라서,
   * 엔터프라이즈 라이선스 대상 서버도 수집하는 기능 추가로 만들어줘").
   *
   * 텔레메트리(`SystemUsage`)는 **Datacenter 전용**이라(사용자 확인) Enterprise 서버는 CPU·메모리가
   * 영원히 `—` 였다. 이 스위치를 켜면 **표준 Redfish 센서 + iDRAC SSH(racadm)** 로 대체 수집한다.
   *
   * ⚠⚠ **`enterpriseAck` 없이는 켜지지 않는다**(사용자 지시: "시스템에 부하는 있겠지만, 사용할
   *   것이냐고 물어보고 사용하겠다고 하면 기능을 구현한다"). BMC 는 약한 프로세서라 주기마다
   *   센서 GET 4회 + SSH 세션 1개가 붙는다 — 화면이 그 부하를 먼저 말하고 관리자가 동의해야 한다.
   *   `normalizeSettings` 가 `enabled && ack` 로 못 박으므로 **그 논리곱을 지우지 말 것.**
   * ⚠ `enterpriseMode` — `auto`(기본: API 로 못 읽은 것만 SSH) · `api` · `ssh`.
   *   SSH 만 고르면 세션이 항상 열린다(부하가 가장 크다) — 회선·장비를 보며 고르게 한다.
   * ⚠ 이 경로는 **iDRAC 경로의 확장**이다 — `idracTelemetry` 를 끄면 함께 돌지 않는다
   *   (그 설정이 'iDRAC 로 수집할지' 를 정하는 축이다).
   */
  enterpriseEnabled: false,
  enterpriseAck: false,
  enterpriseAckAt: 0,
  enterpriseAckBy: '',
  enterpriseMode: 'auto',
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
  } catch (e) { if (fs.existsSync(FILE())) preserveCorrupt(FILE(), e.message); return {}; } // v2.582 ARCH-1: 손상이면 보존 후 기본값 — 법인 opt-in·Enterprise 동의 기록(누가·언제)이 든 사용자 설정이라 조용히 버리지 않는다
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
    /*
     * ⚠⚠ **동의 없이는 켜지지 않는다**(위 DEFAULTS 주석). 이 논리곱이 사용자 지시의 집행부다 —
     *   화면이 부하를 고지하고 관리자가 `enterpriseAck` 를 보내야 대체 수집이 돈다.
     *   `enterpriseAck` 자체는 기록으로 남긴다(끄고 다시 켤 때 누가·언제 동의했는지 보이게).
     */
    enterpriseAck: raw.enterpriseAck === true,
    enterpriseEnabled: raw.enterpriseEnabled === true && raw.enterpriseAck === true,
    enterpriseAckAt: Number(raw.enterpriseAckAt) > 0 ? Math.round(Number(raw.enterpriseAckAt)) : 0,
    enterpriseAckBy: String(raw.enterpriseAckBy || '').trim().slice(0, 64),
    enterpriseMode: ['auto', 'api', 'ssh'].includes(String(raw.enterpriseMode || '').trim()) ? String(raw.enterpriseMode).trim() : DEFAULTS.enterpriseMode,
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

/*
 * ⚠⚠ v2.583 감사 #36 — 저장 **패치**에서 숫자 필드의 '빈 값·0(하한 > 0 인 필드)' 은 **미지정**이다.
 *   화면 숫자칸을 비우고 나가면 `Number('') === 0` 이 PUT 되고, clampInt 가 그것을 **하한으로 승격**해
 *   원시 보존 90→7일 · 롤업 5년→30일로 줄였다 — 다음 prune 이 그 차이만큼 이력을 **지운다**(되돌릴 수 없다).
 *   storage/intervals.js v2.409 의 '빈 값·0 은 하한으로 승격하지 않고 미지정으로 버린다' 와 같은 규칙이다.
 *   정규화(normalizeSettings)의 하한 강제는 그대로 둔다 — 이 필터는 **패치 입력**에만 건다.
 */
const PATCH_NUM_MIN = Object.freeze({
  intervalMs: MIN_INTERVAL_MS, rawRetentionDays: 7, dailyRetentionDays: 30,
  alertPct: 50, alertSustainMin: 0, alertRepeatHours: 1,
});
export function dropUnspecifiedNumbers(body = {}) {
  const out = { ...(body && typeof body === 'object' ? body : {}) };
  const dropped = [];
  for (const [k, lo] of Object.entries(PATCH_NUM_MIN)) {
    if (!Object.hasOwn(out, k)) continue;
    const v = out[k];
    const blank = v == null || (typeof v === 'string' && v.trim() === '');
    const n = blank ? NaN : Number(v);
    if (blank || !Number.isFinite(n) || (lo > 0 && n === 0)) { delete out[k]; dropped.push(k); }
  }
  return { patch: out, dropped };
}

export function saveBmUsageSettings(body = {}) {
  const { patch } = dropUnspecifiedNumbers(body);
  const next = normalizeSettings({ ...loadBmUsageSettings(), ...patch });
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

/**
 * Enterprise 대체 수집이 **실제로 돌아야 하는가**(순수). 한 곳에서만 판정한다 —
 * 폴러·라우트·화면이 각자 `enabled && ack` 를 쓰면 한 곳을 고칠 때 갈라진다.
 */
export function enterpriseActive(settings = loadBmUsageSettings()) {
  const env = String(process.env.BMUSAGE_ENTERPRISE || '').trim().toLowerCase();
  if (env === 'false' || env === '0') return false;          // 현장 탈출구(장비 부하가 문제일 때)
  return !!(settings.enterpriseEnabled && settings.enterpriseAck && settings.idracTelemetry);
}

export function _resetForTest() { _cache = null; _cacheAt = 0; }
