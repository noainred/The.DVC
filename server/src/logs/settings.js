/**
 * vCenter 로그 보관 설정 — CONFIG_DIR/vcenter-logs.json. 보관 기간(retentionDays)을 여기서 지정.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'vcenter-logs.json');

const DEFAULTS = {
  enabled: true,
  pollIntervalMin: 10,     // 수집 주기(분)
  retentionDays: 365,      // 장기 보관 기간(일) — 0이면 무제한
  maxSizeMB: 1024,         // DB 용량 상한(MB) — 초과 시 오래된 것부터 삭제. 0이면 무제한
  maxPerPoll: 5000,        // 1회 폴링당 vCenter별 최대 수집 이벤트
  minSeverity: 'info',     // info|warning|error (그 이상만 저장)
  storagePath: '',         // 저장 디렉터리(빈값=CONFIG_DIR). 각 포탈(엣지/중앙)이 자기 데이터만 로컬 보관
};

let cache = null;
export function loadLogSettings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try { if (fs.existsSync(FILE)) cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* */ }
  return cache;
}

export function saveLogSettings(body = {}) {
  const cur = loadLogSettings();
  const next = {
    enabled: body.enabled != null ? !!body.enabled : cur.enabled,
    pollIntervalMin: Math.max(1, Math.min(1440, Number(body.pollIntervalMin) || cur.pollIntervalMin)),
    // Number(undefined)=NaN이고 NaN ?? x = NaN(??는 null/undefined만 잡음) → 부분 수정(예:
    // enabled만 토글) 시 보관기간/용량이 NaN→null로 영속화돼 prune·용량제한이 조용히 영구
    // 정지, DB 무한 증식. 유한 숫자일 때만 채택하고 아니면 기존값 유지.
    retentionDays: Math.max(0, Math.min(3650, Number.isFinite(Number(body.retentionDays)) ? Number(body.retentionDays) : cur.retentionDays)),
    maxSizeMB: Math.max(0, Math.min(1024 * 1024, Number.isFinite(Number(body.maxSizeMB)) ? Number(body.maxSizeMB) : cur.maxSizeMB)),
    maxPerPoll: Math.max(100, Math.min(50000, Number(body.maxPerPoll) || cur.maxPerPoll)),
    minSeverity: ['info', 'warning', 'error'].includes(body.minSeverity) ? body.minSeverity : cur.minSeverity,
    storagePath: typeof body.storagePath === 'string' ? body.storagePath.trim() : cur.storagePath,
  };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  const pathChanged = next.storagePath !== cur.storagePath;
  cache = next;
  return { ...next, _pathChanged: pathChanged };
}
