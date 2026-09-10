/**
 * guestdisk/settings.js — 게스트 디스크 회수 리포트 설정 (`guest-disk.json`, v2.459).
 *
 * 비밀 값이 없는 설정이라 봉인 대상은 아니지만, 손상 시 조용히 빈 값으로 넘기면 다음 저장이
 * 관리자 설정을 지우므로 다른 스토어와 같이 원자적 쓰기 + preserveCorrupt 를 지킨다.
 *
 * 기본은 **꺼짐(opt-in)** 이다 — 5,850 VM 규모에서 게스트 디스크 벌크 조회는 부하가 있으므로,
 * 업그레이드만으로 주기 수집이 켜지면 안 된다. 관리자가 설정에서 켜야 폴러가 돈다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'guest-disk.json');

export const DEFAULTS = Object.freeze({
  enabled: false,          // 주기 수집(폴러) 켜기 — 기본 꺼짐(opt-in)
  intervalHours: 12,       // 수집 주기(시간). 게스트 파티션은 천천히 변하므로 자주 볼 필요가 없다.
  changeThresholdGB: 1,    // 파티션 used 가 이만큼 바뀔 때만 추이 행을 남긴다(diff-저장).
  retentionDays: 180,      // part_series/vm_series 보존 기간(prune).
  minReclaimGB: 0,         // 기본 0 = 전체 표시(회수 여유가 작아도 보이게). 필요 시 올려서 좁힌다.
});

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

let cache = null;

export function load() {
  if (cache) return cache;
  const out = structuredClone(DEFAULTS);
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (p.intervalHours != null) out.intervalHours = clampNum(p.intervalHours, 1, 168, DEFAULTS.intervalHours);
      if (p.changeThresholdGB != null) out.changeThresholdGB = clampNum(p.changeThresholdGB, 0.1, 100, DEFAULTS.changeThresholdGB);
      if (p.retentionDays != null) out.retentionDays = clampNum(p.retentionDays, 7, 3650, DEFAULTS.retentionDays);
      if (p.minReclaimGB != null) out.minReclaimGB = clampNum(p.minReclaimGB, 0, 10000, DEFAULTS.minReclaimGB);
    }
  } catch (e) {
    preserveCorrupt(FILE);
    console.warn(`[guestdisk] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`);
  }
  cache = out;
  return cache;
}

export function save(body = {}) {
  const next = structuredClone(load());
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.intervalHours != null) next.intervalHours = clampNum(body.intervalHours, 1, 168, next.intervalHours);
  if (body.changeThresholdGB != null) next.changeThresholdGB = clampNum(body.changeThresholdGB, 0.1, 100, next.changeThresholdGB);
  if (body.retentionDays != null) next.retentionDays = clampNum(body.retentionDays, 7, 3650, next.retentionDays);
  if (body.minReclaimGB != null) next.minReclaimGB = clampNum(body.minReclaimGB, 0, 10000, next.minReclaimGB);
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function invalidate() { cache = null; }
export const _FILE = FILE;
