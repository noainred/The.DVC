/**
 * Shared UI settings persisted server-side (CONFIG_DIR/ui.json) so layout
 * tweaks like the dashboard map height are the same for everyone, not just the
 * browser that changed them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js'; // v2.478(감사 B5/S12): 원자적 쓰기 + 손상 시 preserveCorrupt — 크래시 1회로 설정이 소실되고 다음 저장이 빈 값으로 덮어쓰는 사고 방지

const FILE = path.join(config.configDir, 'ui.json');
// mapSpread: 같은/비슷한 좌표의 법인 마커를 겹치지 않게 흩뜨리는 반경(px). 0이면 분산 안 함(겹침).
const DEFAULTS = { mapHeight: 420, mapLambda: -127, mapOffsetY: 0, mapSpread: 10 };

export function loadUiSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) {
    preserveCorrupt(FILE, e.message); // 파일 없음이면 no-op
    return { ...DEFAULTS };
  }
}

export function saveUiSettings(partial = {}) {
  const next = loadUiSettings();
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
