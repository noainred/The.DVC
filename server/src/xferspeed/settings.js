/**
 * xferspeed/settings.js — 법인 간 전송 속도 측정 설정(v2.735). 파일: `CONFIG_DIR/xfer-speed-settings.json`
 *
 * 사용자 요청(2026-10-13): "main 서버와 edge 포탈간에 30분에 1번씩 10MB 파일을 전송해서 법인간 전송 속도를 테스트해서
 * 기록 … DB 로 저장해서 히스토리 보는 기능을 특수기능에".
 *
 * ⚠⚠ **기본 꺼짐(opt-in)** — 켜면 회선을 실제로 쓴다. 엣지 28곳 × 10MiB × 2방향 × 48회/일 = 메인 기준 하루 약 26.3GiB(26,880MiB),
 *   엣지 한 곳은 하루 약 960MiB 다(화면 `trafficOf` 가 이 산수를 그대로 보여 준다 — 숫자를 화면에 박지 않는다).
 *   좁은 회선의 법인은 `excluded` 로 뺀다. 켜는 것은 관리자의 판단이다(통신 점검 v2.552 와 같은 규약).
 * ⚠ 빈 숫자 칸은 '미지정' 이다 — `Number('') === 0` 이 하한으로 올라가 주기가 10분이 되는 사고(v2.596 CLAMP 계열)를
 *   막으려고 저장 전에 버린다(`clampSetting` 도 빈 값을 기본값으로 둔다).
 * ⚠ 이 설정은 **중앙 전용**이다 — 엣지로 배포하지 않는다(측정은 중앙이 주도한다). 그래서 settingsLoadError 등록부
 *   (중앙→엣지 배포 설정의 손상 판정)에 넣지 않았다. 손상 파일은 보존하고 기본값(꺼짐)으로 읽는다 — 꺼짐은 안전한 쪽이다.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { clampSetting } from '../util/clampSetting.js';
import { demoOn } from '../mock/demo/flags.js';
import { corruptOnlyReason } from '../util/registryCore.js';
import { checkSchedule, checkSchedules, SCHEDULE_MAX } from './schedule.js';

const FILE = () => path.join(config.configDir, 'xfer-speed-settings.json');

export const DEFAULTS = Object.freeze({
  enabled: false,
  // 간격 실행 — 켜져 있으면 '마지막 실행 시작 + intervalMs' 마다 잰다. 꺼도 예약 실행(schedules)은 돈다.
  intervalOn: true,
  intervalMs: 30 * 60_000,
  sizeMB: 10,
  // 1 이 가장 정확하다 — 메인 회선을 둘 이상의 측정이 나눠 쓰면 서로의 값을 깎는다.
  concurrency: 1,
  // 한 방향 시한. 고RTT(폴란드·미국 동부 800ms↑) 좁은 회선에서 10MB 가 수십 초 걸릴 수 있다.
  timeoutMs: 120_000,
  // '평소(7일 중앙값)의 이 % 미만이면 느려짐' — 절대 임계를 정하지 않는다(법인마다 회선이 다르다).
  slowPct: 70,
  sampleRetentionDays: 180,
  dailyRetentionDays: 365 * 5,
  excluded: [],
  // 예약 실행(1회·매일·매주·매월 — `schedule.js`). 비어 있으면 간격 실행만.
  schedules: [],
});

export const RANGES = Object.freeze({
  // 상한 7일 — 그보다 긴 주기는 예약 실행(매주·매월)으로 정한다.
  intervalMs: { min: 10 * 60_000, max: 7 * 24 * 3_600_000 },
  sizeMB: { min: 1, max: 50 },
  concurrency: { min: 1, max: 4 },
  timeoutMs: { min: 15_000, max: 600_000 },
  slowPct: { min: 10, max: 95 },
  sampleRetentionDays: { min: 30, max: 730 },
  dailyRetentionDays: { min: 90, max: 3650 },
});

const EXCLUDED_MAX = 500;
const NAME_MAX = 64;

/** 제외 목록 — 글자만, 64자, 대소문자 무시 중복 제거(저장 표기는 처음 본 것). */
export function normalizeExcluded(list) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(list) ? list.slice(0, EXCLUDED_MAX * 2) : []) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, NAME_MAX);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= EXCLUDED_MAX) break;
  }
  return out;
}

export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const c = (k) => clampSetting(r[k], { ...RANGES[k], def: DEFAULTS[k] });
  return {
    enabled: r.enabled === true,
    intervalOn: r.intervalOn !== false,
    intervalMs: c('intervalMs'),
    sizeMB: c('sizeMB'),
    concurrency: c('concurrency'),
    timeoutMs: c('timeoutMs'),
    slowPct: c('slowPct'),
    sampleRetentionDays: c('sampleRetentionDays'),
    dailyRetentionDays: c('dailyRetentionDays'),
    excluded: normalizeExcluded(r.excluded),
    schedules: normalizeStoredSchedules(r.schedules),
  };
}

/**
 * 저장된 일정 읽기 — 저장 경로(checkSchedules)를 지난 값이라 대부분 그대로다. 손으로 고친 파일의 잘못된 일정은
 * 실행하지 않는다(버린다) — 실행 시각을 추측하지 않는다. id 가 없으면 위치로 붙인다(같은 파일이면 같은 id).
 */
export function normalizeStoredSchedules(list) {
  const out = []; const used = new Set();
  (Array.isArray(list) ? list : []).slice(0, SCHEDULE_MAX).forEach((raw, i) => {
    const c = checkSchedule(raw);
    if (!c.ok) return;
    const sch = c.sched;
    if (!sch.id || used.has(sch.id)) sch.id = `s-n${i}`;
    used.add(sch.id);
    out.push(sch);
  });
  return out;
}

let _loadError = null;
/** 마지막 로드의 손상 사유(없으면 null) — 화면이 '설정 파일을 못 읽어 기본값(꺼짐)으로 동작' 을 말한다. */
export function xferSettingsLoadError() { loadXferSpeedSettings(); return _loadError; }

export function loadXferSpeedSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    _loadError = null;
    return normalizeSettings(j);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      // 손상은 보존한다 — 다음 저장이 온전했던 원본을 덮어쓰지 않게(v2.190 규약). 기본값은 꺼짐이라 안전한 쪽이다.
      _loadError = { at: Date.now(), reason: String(e?.message || e).slice(0, 200) };
      try { preserveCorrupt(FILE()); } catch { /* 보존 실패는 best effort */ }
    } else {
      // 손상본을 옆으로 치운 뒤(재시작 포함)에는 '파일 없음' 이 된다 — 그때도 '못 읽었다' 를 계속 말한다(v2.612 규약).
      // 관리자가 한 번 저장하면(파일이 생기면) 풀린다.
      const why = corruptOnlyReason(FILE());
      _loadError = why ? { at: Date.now(), reason: why.replace('등록부 파일', '설정 파일') } : null;
    }
    return normalizeSettings({});
  }
}

/* 주기 변경을 무장된 타이머에 즉시 반영(v2.409 규약 — 없으면 24시간 주기에서 최대 하루 뒤에야 먹는다). */
const _listeners = new Set();
export function onXferSpeedSettingsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

const NUMERIC_KEYS = Object.keys(RANGES);
/**
 * 저장 — 보낸 칸만 바꾼다. 숫자 칸이 비었으면(빈 문자열·null·숫자 아님) 이전 값을 유지한다.
 * @returns {object} 저장된 설정
 */
export function saveXferSpeedSettings(body = {}) {
  const cur = loadXferSpeedSettings();
  const b = { ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) };
  for (const k of NUMERIC_KEYS) if (k in b && numOrNull(b[k]) == null) delete b[k];
  if ('enabled' in b && typeof b.enabled !== 'boolean') delete b.enabled;
  if ('excluded' in b && !Array.isArray(b.excluded)) delete b.excluded;
  if ('intervalOn' in b && typeof b.intervalOn !== 'boolean') delete b.intervalOn;
  if ('schedules' in b) {
    // 잘못된 일정은 고치지 않고 거절한다(조용히 버리면 사용자가 만든 일정이 사라진다) — 라우트가 400 + 사유로 돌려준다.
    const chk = checkSchedules(b.schedules, { prev: cur.schedules, now: Date.now(), newId: () => `s-${crypto.randomBytes(3).toString('hex')}` });
    if (!chk.ok) {
      const f = chk.errors[0] || {};
      const e = new Error(`${f.index >= 0 ? `예약 ${f.index + 1}: ` : ''}${f.reason || '일정이 올바르지 않습니다'}`);
      e.code = 'bad-schedule'; e.errors = chk.errors; throw e;
    }
    b.schedules = chk.schedules;
  }
  const next = normalizeSettings({ ...cur, ...b });
  atomicWriteFileSync(FILE(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  _loadError = null;
  for (const fn of _listeners) { try { fn(next); } catch { /* 리스너 오류가 저장을 되돌리지 않게 */ } }
  return next;
}

/** 주기 측정이 켜졌는가 — env 가 강제하고, 데모(mock)면 켜진 것처럼 본다(설정 파일은 그대로). */
export function xferSpeedEnabled(s = loadXferSpeedSettings()) {
  const env = String(process.env.XFER_SPEED_ENABLED || '').toLowerCase();
  if (env === 'true') return true;
  if (env === 'false') return false;
  return demoOn(s.enabled);
}

/** 이 이름이 제외 목록에 있는가(대소문자 무시). */
export function isExcluded(s, ...names) {
  const set = new Set((s?.excluded || []).map((x) => String(x).toLowerCase()));
  return names.some((n) => n != null && set.has(String(n).trim().toLowerCase()));
}
