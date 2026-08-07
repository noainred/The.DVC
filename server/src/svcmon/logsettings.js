/**
 * 성능점검 로그 설정 — CSV 적재/분할/보관 정책. `CONFIG_DIR/svcmon-log.json`.
 *
 * 포탈 다른 설정과 분리된 전용 파일이다(성능점검을 독립 운영하기 위한 조건).
 * 저장은 원자적 쓰기, 로드 실패는 손상 보존 후 기본값 — 쓰기만 원자적이고 로드가 손상을
 * 조용히 넘기면 다음 저장이 원본을 덮어쓴다(CLAUDE.md 불변조건).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'svcmon-log.json');

/** 분할 단위 → 파일명 접미 규칙. 값이 늘면 csvlog.fileNameFor 도 함께 본다. */
export const ROTATE_UNITS = ['hour', 'day', 'week', 'month', 'quarter'];
export const ROTATE_LABEL = {
  hour: '시간별', day: '일별', week: '주별', month: '월별', quarter: '분기(3개월)별',
};

const DEFAULTS = {
  enabled: true,
  mode: 'all',          // 'all' | 'changes' (상태가 바뀐 시점만 기록)
  rotate: 'day',
  keepFiles: 90,        // 분할 단위 × 이 개수 = 실질 보관 기간
  // 고부하 대비(일 2GB+): 한 파일이 이 크기를 넘으면 같은 구간 안에서 -pNN 으로 쪼갠다.
  // 단일 파일이 수 GB 가 되면 엑셀·grep·전송이 모두 불가능해진다.
  maxFileMB: 512,
  // 디스크 상한 — 파일 수 정책만으로는 시간당 회전 시 용량이 폭주할 수 있다. 0=미사용.
  maxTotalMB: 51200,    // 50GB
  dirName: 'svcmon-logs',
  /**
   * 절대 경로 지정(선택) — 일 2GB 규모 로그를 시스템 디스크가 아닌 대용량 볼륨에 두려는 용도.
   * 비우면 기존과 동일하게 CONFIG_DIR/<dirName>. 저장 시 실제 쓰기 시험을 통과해야 한다.
   * 이 디렉터리에서 지워질 수 있는 것은 `results-*.csv` 뿐이다(pruneOld 의 패턴 필터) —
   * 그래도 기존 파일이 있는 공용 디렉터리보다 전용 디렉터리를 권장한다.
   */
  dirPath: '',
};

let cache = null;

export function getLogSettings() {
  if (cache) return { ...cache };
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    cache = normalize(JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message);
    cache = { ...DEFAULTS };
  }
  return { ...cache };
}

export function setLogSettings(patch) {
  const next = normalize({ ...getLogSettings(), ...(patch || {}) });
  // 절대 경로를 바꾸는 저장은 **실제 쓰기 시험**을 통과해야 한다. 검증 없이 저장하면
  // 오타 경로에서 라이터가 조용히 실패해 로그가 통째로 유실된다(라이터는 best-effort).
  if (next.dirPath) {
    let st = null;
    try {
      fs.mkdirSync(next.dirPath, { recursive: true });
      const probe = path.join(next.dirPath, `.svcmon-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      st = fs.statSync(next.dirPath);
    } catch (e) {
      throw new Error(`로그 경로에 쓸 수 없습니다: ${next.dirPath} — ${e?.message || e}`);
    }
    if (!st.isDirectory()) throw new Error(`디렉터리가 아닙니다: ${next.dirPath}`);
  }
  cache = next;
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  return { ...next };
}

const clamp = (v, low, high, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : dflt;
};

function normalize(v) {
  const o = v && typeof v === 'object' ? v : {};
  const keep = Number(o.keepFiles);
  return {
    enabled: o.enabled === undefined ? DEFAULTS.enabled : !!o.enabled,
    mode: o.mode === 'changes' ? 'changes' : 'all',
    rotate: ROTATE_UNITS.includes(o.rotate) ? o.rotate : DEFAULTS.rotate,
    keepFiles: Number.isFinite(keep) ? Math.min(3650, Math.max(1, Math.round(keep))) : DEFAULTS.keepFiles,
    maxFileMB: clamp(o.maxFileMB, 8, 8192, DEFAULTS.maxFileMB),
    maxTotalMB: o.maxTotalMB === 0 ? 0 : clamp(o.maxTotalMB, 100, 2_000_000, DEFAULTS.maxTotalMB),
    // 디렉터리는 이름만 받는다(경로 구분자 금지 — CONFIG_DIR 밖으로 나가지 못하게).
    dirName: String(o.dirName || DEFAULTS.dirName).replace(/[^A-Za-z0-9._-]/g, '') || DEFAULTS.dirName,
    // 절대 경로는 그대로 두되 정규화한다. 상대 경로는 받지 않는다 — 프로세스 cwd 에 따라
    // 위치가 흔들리고, 서비스로 돌 때와 수동 실행 때 다른 곳에 쓰게 된다.
    dirPath: (() => {
      const raw = String(o.dirPath || '').trim();
      if (!raw) return '';
      return path.isAbsolute(raw) ? path.normalize(raw) : '';
    })(),
  };
}

/** 로그 디렉터리 절대경로(없으면 생성). 절대 경로 설정이 있으면 그것을 우선한다. */
export function logDir() {
  const cfg = getLogSettings();
  const dir = cfg.dirPath || path.join(config.configDir, cfg.dirName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function _resetLogSettingsCache() { cache = null; }
