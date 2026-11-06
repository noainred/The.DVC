/**
 * svcmon/alertSettings.js — Monitoring **점검 실패 알림 설정**(v2.915) — `CONFIG_DIR/svcmon-alert.json`.
 * 판정·발송은 svcmon/transitions.js(메모리). 이 모듈은 설정 파일만 다룬다(원자 쓰기 + 손상 보존 — server/CLAUDE.md).
 * 기본은 꺼짐 — 업그레이드만으로 전 법인 포탈이 실패 중인 점검 수만큼 알림을 쏘지 않게.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'svcmon-alert.json');
const _listeners = new Set();
/** 저장될 때 알림(transitions.js 가 끔 → '알린 상태' 비우기). */
export function onAlertSettingsSaved(fn) { if (typeof fn === 'function') _listeners.add(fn); return () => _listeners.delete(fn); }


export const ALERT_DEFAULTS = Object.freeze({ enabled: false, failCount: 3, recover: true, warn: false, scope: 'all' });
export const ALERT_SCOPES = Object.freeze(['all', 'settings']);

const intIn = (v, lo, hi, d) => {
  const n = numOrNull(v);
  return n == null ? d : Math.min(hi, Math.max(lo, Math.round(n)));
};
const boolOr = (v, d) => (v === true || v === false ? v : d);

export function cleanAlertSettings(input = {}, prev = ALERT_DEFAULTS) {
  const x = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    enabled: boolOr(x.enabled, prev.enabled),
    failCount: intIn(x.failCount, 1, 100, prev.failCount),
    recover: boolOr(x.recover, prev.recover),
    warn: boolOr(x.warn, prev.warn),
    scope: ALERT_SCOPES.includes(x.scope) ? x.scope : prev.scope,
  };
}

let _settings = null;
export function getAlertSettings() {
  if (_settings) return { ..._settings };
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      _settings = cleanAlertSettings(raw, ALERT_DEFAULTS);
      return { ..._settings };
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); }
  _settings = { ...ALERT_DEFAULTS };
  return { ..._settings };
}
export function saveAlertSettings(input = {}) {
  const next = cleanAlertSettings(input, getAlertSettings());
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  _settings = next;
  for (const fn of _listeners) { try { fn({ ...next }); } catch { /* 듣는 쪽 오류가 저장을 막지 않는다 */ } }
  return { ...next };
}

/** 테스트·transitions 전용 — 캐시를 바꾼다(null 이면 다음 조회에서 파일을 다시 읽는다). */
export function _setAlertSettingsCache(v) { _settings = v ? { ...v } : null; }
