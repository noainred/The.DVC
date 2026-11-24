/**
 * Shared UI settings persisted server-side (CONFIG_DIR/ui.json) so layout
 * tweaks like the dashboard map height are the same for everyone, not just the
 * browser that changed them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js'; // v2.478(감사 B5/S12): 원자적 쓰기 + 손상 시 preserveCorrupt — 크래시 1회로 설정이 소실되고 다음 저장이 빈 값으로 덮어쓰는 사고 방지
import { makeJsonFileReader } from './util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)

const FILE = path.join(config.configDir, 'ui.json');
// mapSpread: 같은/비슷한 좌표의 법인 마커를 겹치지 않게 흩뜨리는 반경(px). 0이면 분산 안 함(겹침).
const DEFAULTS = { mapHeight: 420, mapLambda: -127, mapOffsetY: 0, mapSpread: 10 };

/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'ui-settings' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function uiSettingsWriteRefusal() {
  loadUiSettings();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `화면 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}
let _last = null;   // 107회차: 마지막으로 읽은 값(읽기 오류 동안 유지)
export function loadUiSettings() {
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return { ...(_last || DEFAULTS) }; }
  _readErr = '';
  try {
    _last = { ...DEFAULTS, ...(rr.kind === 'ok' ? JSON.parse(rr.value) : {}) };
    return { ..._last };
  } catch (e) {
    preserveCorrupt(FILE, e.message); // 읽었는데 JSON 이 아닌 것만(읽기 오류는 위에서 갈랐다)
    _last = null;
    return { ...DEFAULTS };
  }
}

export function saveUiSettings(partial = {}) {
  const next = loadUiSettings();
  { const no = uiSettingsWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다

  if (partial.mapHeight != null) {
    next.mapHeight = Math.max(240, Math.min(1200, Math.round(Number(partial.mapHeight)) || 420));
  }
  // 지도 드래그 위치도 서버에 공유 저장(가로 회전 lambda·세로 이동 offsetY).
  if (partial.mapLambda != null && Number.isFinite(Number(partial.mapLambda))) {
    // lambda는 모듈러(±360 무한 회전)이므로 -180~180으로 정규화해 저장.
    let l = Number(partial.mapLambda) % 360;
    if (l > 180) l -= 360; if (l < -180) l += 360;
    next.mapLambda = Math.round(l * 10) / 10;
  }
  if (partial.mapOffsetY != null && Number.isFinite(Number(partial.mapOffsetY))) {
    next.mapOffsetY = Math.max(-1200, Math.min(1200, Math.round(Number(partial.mapOffsetY))));
  }
  // 마커 분산 반경(px) — 0~60. 0이면 겹침(분산 off).
  if (partial.mapSpread != null && Number.isFinite(Number(partial.mapSpread))) {
    next.mapSpread = Math.max(0, Math.min(60, Math.round(Number(partial.mapSpread))));
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
