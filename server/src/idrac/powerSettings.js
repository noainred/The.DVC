/**
 * 전력 집계 표시 설정 — CONFIG_DIR/power-settings.json.
 * excludeUnmapped: vCenter에 귀속되지 않는(미매핑) 측정 전력을 총합/보고/목록에서 제외한다.
 *   원격 수집기가 보고하지만 중앙이 폴링하지 않는 데이터센터의 호스트처럼, 어느 vCenter에도
 *   매핑되지 않아 '(미매핑)'으로 잡히는 장비를 영구적으로 빼고 싶을 때 사용(수집기가 매 주기
 *   다시 보내도 표시에서 제외됨).
 */

import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 96회차 ⓑ: 읽기 오류 ≠ 손상(공용 판정 — 손상만 preserveCorrupt)
import { keepMappedMeasured } from './attribution.js';

const FILE = path.join(config.configDir, 'power-settings.json');
// includeVcenterPower: vCenter PerformanceManager(power.power.average)로 수집한 ESXi 호스트
//   전력을 측정 소스로 합산할지(기본 on). iDRAC/OME/원격으로 이미 잡힌 서버와는 중복 제거.
const DEFAULTS = { excludeUnmapped: false, includeVcenterPower: true };

let cache = null;
/*
 * 96회차 ⓑ(93회차 남긴 것 — 결정 G2 의 형제): 예전 catch 하나는 **읽기 오류**도 손상으로 보고 원본을 `.corrupt` 로 옮긴 뒤 기본값을 재시작까지 캐시했다
 *   (미매핑 제외가 꺼지고 다음 저장이 새 파일). 이제 손상만 옮기고(공용 판정 — 형식 판정은 예전처럼 JSON.parse 만), 읽기 오류면 원본을 두고 캐시하지 않으며
 *   (30초마다 다시 읽음) 저장은 거절한다(powerSettingsWriteRefusal — 라우트 409).
 */
const _reader = makeJsonFileReader(() => FILE, { tag: 'power-settings', parse: (t) => JSON.parse(t) });
let _readError = false;
export function loadPowerSettings() {
  if (cache) return cache;
  const r = _reader.read();
  if (r.kind === 'read-error') { _readError = true; return { ...DEFAULTS }; }   // 자리 표시 — 캐시하지 않는다
  _readError = false;
  const v = r.kind === 'ok' && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
  cache = { ...DEFAULTS, ...v };
  return cache;
}
/** 96회차 ⓑ: 읽기 오류 중의 저장 거절 본문(409) 또는 null. */
export function powerSettingsWriteRefusal() {
  loadPowerSettings();
  if (!_readError) return null;
  return { ok: false, status: 409, code: 'settings-unreadable', readError: true, reason: `전력 집계 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다).` };
}
/** 테스트 전용. */
export function _resetPowerSettingsForTest() { cache = null; _readError = false; _reader.reset(); }

export function savePowerSettings(body = {}) {
  const no = powerSettingsWriteRefusal();
  if (no) throw Object.assign(new Error(no.reason), { status: 409, code: no.code });   // 96회차 ⓑ: 마지막 방어선(라우트가 먼저 409)
  const cur = loadPowerSettings();
  const next = {
    excludeUnmapped: body.excludeUnmapped !== undefined ? Boolean(body.excludeUnmapped) : cur.excludeUnmapped,
    includeVcenterPower: body.includeVcenterPower !== undefined ? Boolean(body.includeVcenterPower) : (cur.includeVcenterPower !== false),
  };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

/**
 * 설정(excludeUnmapped)에 따라 측정 전력 목록에서 미매핑(귀속 vCenter 없음) 항목을 제거한다.
 * 설정이 꺼져 있으면 원본을 그대로 반환. snap.hosts/vcenters로 귀속을 판정한다.
 * @param measured allMeasuredPower() 결과
 * @param snap     store 스냅샷(hosts, vcenters)
 */
export function filterMeasuredByMapping(measured, snap) {
  const s = loadPowerSettings();
  if (!s.excludeUnmapped || !Array.isArray(measured)) return measured;
  // 로직은 attribution.keepMappedMeasured 하나로 공유한다(범위 제한 계정 강제 필터와 동일 규칙).
  return keepMappedMeasured(measured, snap);
}
