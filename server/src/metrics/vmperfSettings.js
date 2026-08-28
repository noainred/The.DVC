/**
 * 낭비 리소스(VM 성능) 트래킹 설정 — 보존기간 + 대상 vCenter 선택(v2.376).
 *
 * 6,000 VM 규모에서 VM 성능 시계열은 용량이 빠르게 늘어난다(실측: 행당 ~308B, 인덱스·롤업 포함).
 * 그래서 (a) 며칠 보관할지, (b) 어떤 vCenter 만 수집할지를 운영자가 고를 수 있어야 한다.
 * 설정은 metrics/settings.js 와 같은 패턴 — env 기본값 위에 CONFIG_DIR/vmperf.json 오버레이.
 *
 * 필드
 *  - enabled(bool)        : 수집 자체 on/off. 끄면 샘플러가 vm_* 행을 만들지 않는다.
 *  - retentionDays(number): 보존기간(0 = 무제한 보관 — prune 안 함).
 *  - vcenterIds(string[]) : 수집 대상 vCenter id 목록. **빈 배열 = 전체**(기존 동작과 동일).
 *  - trackTotal(bool)     : 전체 합계('' 키) 계열도 저장할지.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'vmperf.json');
const FIELDS = ['enabled', 'retentionDays', 'vcenterIds', 'trackTotal'];

// 가드레일: 보존기간은 0(무제한)~5년. UI 오입력·손상 파일이 그대로 prune 에 흘러가지 않게 한다.
const MAX_RETENTION_DAYS = 1830;

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

function coerce(field, v) {
  if (field === 'enabled') return v !== false;
  if (field === 'trackTotal') return v !== false;
  if (field === 'retentionDays') return Math.max(0, Math.min(MAX_RETENTION_DAYS, Math.floor(Number(v) || 0)));
  if (field === 'vcenterIds') {
    if (!Array.isArray(v)) return [];
    // 중복 제거 + 공백 제거 + 상한(유령 id 대량 입력 방지). 존재 검증은 라우트가 스냅샷으로 한다.
    return [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 200);
  }
  return v;
}

/** 유효 설정 = env 기본값 + 저장된 오버레이. */
export function loadVmperfSettings() {
  const eff = {
    enabled: process.env.VMPERF_ENABLED !== 'false',
    // 기본 90일 — 6,000 VM·시간당·2메트릭이면 약 7.4GB(실측 기준). 1년은 30GB 라 기본값으로 두지 않는다.
    retentionDays: Math.max(0, Math.min(MAX_RETENTION_DAYS, Number(process.env.VMPERF_RETENTION_DAYS) || 90)),
    vcenterIds: [],
    trackTotal: process.env.VMPERF_TRACK_TOTAL !== 'false',
  };
  const persisted = readFile();
  for (const f of FIELDS) if (persisted[f] !== undefined) eff[f] = coerce(f, persisted[f]);
  return eff;
}

/** 부분 업데이트 저장 후 유효 설정 반환. */
export function saveVmperfSettings(partial = {}) {
  const next = readFile();
  for (const f of FIELDS) if (partial[f] !== undefined) next[f] = coerce(f, partial[f]);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadVmperfSettings();
}

/** 이 vCenter 를 수집해야 하나 — vcenterIds 가 비어 있으면 전체 대상. */
export function vmperfTracks(vcenterId, settings = null) {
  const s = settings || loadVmperfSettings();
  if (!s.enabled) return false;
  if (!s.vcenterIds.length) return true;
  return s.vcenterIds.includes(String(vcenterId));
}

export const VMPERF_LIMITS = { maxRetentionDays: MAX_RETENTION_DAYS };
