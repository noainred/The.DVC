/**
 * svcmon/alertSettings.js — Monitoring **점검 실패 알림 설정**(v2.915) — `CONFIG_DIR/svcmon-alert.json`.
 * 판정·발송은 svcmon/transitions.js(메모리). 이 모듈은 설정 파일만 다룬다(원자 쓰기 + 손상 보존 — server/CLAUDE.md).
 * 기본은 꺼짐 — 업그레이드만으로 전 법인 포탈이 실패 중인 점검 수만큼 알림을 쏘지 않게.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { fileMissing } from '../util/fileMissing.js';   // 134회차: '정말 없는가'(ENOENT 만 — existsSync 는 stat 실패도 false)
import { numOrNull } from '../util/numOrNull.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';   // 26회차 F1 형제

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
/*
 * 전체 점검 26회차 F1 형제(코드 읽기): 손상되면 표지 없이 기본값(enabled:false)으로 넘어가 점검 실패 알림이 **조용히** 꺼졌다.
 *   이제 로드 오류를 세워 서비스 점검 목록에 올린다 — 해제는 화면에서 다시 저장(전체 폼 저장이라 기본값이 섞이지 않는다) · '기본값으로 확정'(알림 꺼짐) · 보존본 복구.
 */
const _loadErr = makeSettingsLoadError(() => FILE(), { label: '성능점검 실패 알림 설정 — 손상 중에는 알림이 꺼져 있습니다(확정하면 기본값: 꺼짐)', confirm: () => { saveAlertSettings({ ...ALERT_DEFAULTS }); } });
/** 알림 설정 파일을 못 읽었으면 { at, reason }, 아니면 null. */
export function alertSettingsLoadError() { getAlertSettings(); return _loadErr.get(); }
export function getAlertSettings() {
  if (_settings) return { ..._settings };
  try {
    if (!fileMissing(FILE())) {   // 134회차: 없음은 ENOENT 뿐 — stat 실패(폴더 수준 EACCES · EIO · ESTALE)는 아래 읽기가 읽기 오류로 가른다
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      _settings = cleanAlertSettings(raw, ALERT_DEFAULTS);
      _loadErr.ok();
      return { ..._settings };
    }
    _loadErr.missing();
  } catch (e) {
    if (e?.code === 'ENOENT') _loadErr.missing();   // 134회차: stat 뒤에 없어졌다 — 없음
    else if (e?.code) _loadErr.readError(e);   // EACCES · EISDIR — 원본을 옮기지 않는다(20회차 반증 F4 규약)
    else { _loadErr.corrupt(e); preserveCorrupt(FILE(), e?.message); }
  }
  _settings = { ...ALERT_DEFAULTS };
  return { ..._settings };
}
export function saveAlertSettings(input = {}) {
  const next = cleanAlertSettings(input, getAlertSettings());
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  _settings = next;
  _loadErr.ok();
  for (const fn of _listeners) { try { fn({ ...next }); } catch { /* 듣는 쪽 오류가 저장을 막지 않는다 */ } }
  return { ...next };
}

/** 테스트·transitions 전용 — 캐시를 바꾼다(null 이면 다음 조회에서 파일을 다시 읽는다). */
export function _setAlertSettingsCache(v) { _settings = v ? { ...v } : null; if (!v) _loadErr.ok(); }
