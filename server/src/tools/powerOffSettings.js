/**
 * tools/powerOffSettings.js — 전원 꺼짐 점검 설정(`power-off-check.json`, v2.484, 사용자 요청 "몇 시간마다 점검하는지 설정").
 * 점검기는 스냅샷(store)만 읽어 꺼진 VM 을 표(vm-track.db power_off_seen)에 기록한다 — vCenter 왕복이 없어
 * 가볍고, 기본 켜짐(6시간). 다른 설정 스토어와 같이 원자적 쓰기 + preserveCorrupt.
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { numOrNull } from '../util/numOrNull.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

const FILE = path.join(config.configDir, 'power-off-check.json');
export const LIMITS = Object.freeze({ minHours: 1, maxHours: 168 });
export const DEFAULTS = Object.freeze({ enabled: true, intervalHours: 6 });

// v2.602(감사 LEFT2602-03): 빈 값은 '미지정' — dflt(이전 값). 예전 Number('') === 0 이 하한 1시간이 됐다.
const clampHours = (v, dflt) => { const n = numOrNull(v); return n != null ? Math.min(LIMITS.maxHours, Math.max(LIMITS.minHours, Math.round(n))) : dflt; };
let cache = null;
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'power-off-check' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function powerOffWriteRefusal() {
  loadPowerOffSettings();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `전원 꺼짐 점검 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}

export function loadPowerOffSettings() {
  if (cache) return cache;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return { ...DEFAULTS }; }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  const out = { ...DEFAULTS };
  try {
    if (rr.kind === 'ok') {
      const p = parseJsonObject(rr.value);
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (p.intervalHours != null) out.intervalHours = clampHours(p.intervalHours, DEFAULTS.intervalHours);
    }
  } catch (e) {
    preserveCorrupt(FILE);
    console.warn(`[power-off] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
  }
  cache = out;
  return cache;
}

export function savePowerOffSettings(body = {}) {
  const next = { ...loadPowerOffSettings() };
  { const no = powerOffWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다

  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.intervalHours != null) next.intervalHours = clampHours(body.intervalHours, next.intervalHours);
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function _resetPowerOffSettingsCache() { cache = null; _reader.reset(); _readErr = ''; }
