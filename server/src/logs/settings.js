/**
 * vCenter 로그 보관 설정 — CONFIG_DIR/vcenter-logs.json. 보관 기간(retentionDays)을 여기서 지정.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

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

/**
 * v2.603(감사 TIM2603-01 — 재현): 로드 경로에도 저장과 **같은 범위**를 적용한다. 예전에는 파일 값을 그대로 펼쳐서, 손으로
 * 고친 파일·복원한 백업의 `pollIntervalMin` 0·''·'abc'·음수·거대값이 `logs/poller.js schedule()` 의 setInterval 로 가
 * **1ms 루프**가 됐다(Node 는 0·NaN·음수·2^31 초과를 1ms 로 본다 — 재현: 0 → 0ms, 'abc' → NaN, -5 → -300000,
 * 40000 → 2400000000). v2.602 loginMonitor(TIM2602-04)와 같은 규칙: 숫자 아님·빈 값은 기본값, 범위 밖은 자른다.
 * 보존일·용량은 0 이 '무제한' 이라는 뜻이므로 0 은 그대로 두고, 음수는 0 이 아니라 **기본값**이다(오설정을 '무제한' 으로
 * 넓히지 않는다).
 */
function normalizeLoaded(p) {
  const num = (v, d, lo, hi, { zeroOk = false } = {}) => {
    const n = numOrNull(v);
    if (n == null || n < 0 || (n === 0 && !zeroOk)) return d;
    return Math.max(lo, Math.min(hi, n));
  };
  return {
    enabled: p.enabled != null ? !!p.enabled : DEFAULTS.enabled,
    pollIntervalMin: num(p.pollIntervalMin, DEFAULTS.pollIntervalMin, 1, 1440),
    retentionDays: num(p.retentionDays, DEFAULTS.retentionDays, 0, 3650, { zeroOk: true }),
    maxSizeMB: num(p.maxSizeMB, DEFAULTS.maxSizeMB, 0, 1024 * 1024, { zeroOk: true }),
    maxPerPoll: num(p.maxPerPoll, DEFAULTS.maxPerPoll, 100, 50000),
    minSeverity: ['info', 'warning', 'error'].includes(p.minSeverity) ? p.minSeverity : DEFAULTS.minSeverity,
    storagePath: typeof p.storagePath === 'string' ? p.storagePath.trim() : DEFAULTS.storagePath,
  };
}

let cache = null;
export function loadLogSettings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아님');   // 형식 불일치도 손상
      cache = normalizeLoaded(p);
    }
  } catch (e) { cache = { ...DEFAULTS }; preserveCorrupt(FILE, e.message); /* */ }
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
    // v2.586 — 빈 칸('')·null 도 '미지정' 이다. `Number('') === 0` 이고 0 은 **무제한**이라, 칸을 비우고
    //   저장하면 prune·용량 상한이 화면의 '저장됨' 과 함께 조용히 멈췄다. 명시적 0 만 무제한이다.
    retentionDays: Math.max(0, Math.min(3650, numOrNull(body.retentionDays) ?? cur.retentionDays)),
    maxSizeMB: Math.max(0, Math.min(1024 * 1024, numOrNull(body.maxSizeMB) ?? cur.maxSizeMB)),
    maxPerPoll: Math.max(100, Math.min(50000, Number(body.maxPerPoll) || cur.maxPerPoll)),
    minSeverity: ['info', 'warning', 'error'].includes(body.minSeverity) ? body.minSeverity : cur.minSeverity,
    storagePath: typeof body.storagePath === 'string' ? body.storagePath.trim() : cur.storagePath,
  };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  const pathChanged = next.storagePath !== cur.storagePath;
  cache = next;
  return { ...next, _pathChanged: pathChanged };
}

/** 테스트 전용 — 로드 캐시를 비워 다음 load 가 파일을 다시 읽게 한다. */
export function _resetLogSettingsForTest() { cache = null; }
