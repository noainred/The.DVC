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
import { makeSettingsLoadError } from '../util/settingsLoadError.js';   // 26회차 F1
import { numOrNull } from '../util/numOrNull.js';

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
/*
 * 전체 점검 26회차 F1(재현): 손상되면 표지 없이 기본값(보관 90개)으로 넘어가 다음 회전이 CSV 이력을 지웠다(365 → 90: 300개 중 210개 삭제 ·
 *   재시작 뒤에도 — 원본은 보존본으로 옮겨져 없다). 이제 로드 오류를 세우고 그동안은 **설정 상한(파일 3650개 · 총량 무제한)으로만** 정리(csvlog.pruneOld —
 *   27회차 반증 D-4: 전부 보류하면 시간 회전에서 디스크가 끝없이 찬다) · 저장 409 · 확정은 보관 개수를 상한으로 쓴다(이력을 지우지 않게).
 *   해제는 서비스 점검 '기본값으로 확정' 또는 보존본 복구. ⚠ 로그 위치(dirPath)는 기본(CONFIG_DIR)으로 돌아간 채다(남긴 것).
 */
export const LOG_LIMITS = Object.freeze({ keepFilesMax: 3650, maxTotalMBMax: 2_000_000 });
const _loadErr = makeSettingsLoadError(() => FILE(), { label: '성능점검 로그(CSV) 보관 설정 — 손상 중 CSV 기록 멈춤 · 확정하면 보관 개수 최대 · 총량 무제한(이력을 지우지 않음) · 기록 위치는 기본 위치로', confirm: () => { const v = { ...DEFAULTS, keepFiles: LOG_LIMITS.keepFilesMax, maxTotalMB: 0 };   /* 28회차 N-1(재현): 총량 상한도 무제한(0) — 기본 50GB 로 확정하면 직후 정리가 이력을 지웠다 */ atomicWriteFileSync(FILE(), JSON.stringify(v, null, 2)); cache = v; _loadErr.ok(); } });
/** 로그 설정 파일을 못 읽었으면 { at, reason }, 아니면 null. */
export function logSettingsLoadError() { getLogSettings(); return _loadErr.get(); }

export function getLogSettings() {
  if (cache) return { ...cache };
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    const j = JSON.parse(raw);
    // 28회차 N-2(재현): 객체가 아닌 JSON(null · 배열 · 수)도 손상이다 — 예전에는 조용히 기본값(보관 90개)이 되어 26회차 F1 의 손실이 그대로 남았다
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    cache = normalize(j);
    _loadErr.ok();
  } catch (e) {
    if (e.code === 'ENOENT') _loadErr.missing();
    else if (e.code) _loadErr.readError(e);   // EACCES · EISDIR — 원본을 옮기지 않는다(20회차 반증 F4 규약)
    else { _loadErr.corrupt(e); preserveCorrupt(FILE(), e?.message); }
    cache = { ...DEFAULTS };
  }
  return { ...cache };
}

/** 숫자 설정 키 — 빈 값은 '미지정'(이전 값 유지)이다(v2.605 LEFT2605-02). */
const NUMERIC_KEYS = ['keepFiles', 'maxFileMB', 'maxTotalMB'];

/**
 * v2.605(감사 LEFT2605-02 — 재현): 숫자 칸을 비우고 저장하면 웹이 `Number('')=0` 을 보내 보관 파일 수 90 → **1**(회전 시
 * 옛 로그 89개 삭제 대상)·전체 상한 20000 → **0(무제한)** 이 됐고, API 로 '' 를 보내면 상한이 하한 100 으로 떨어졌다.
 * 빈 값·숫자 아님은 패치에서 빼 이전 값을 유지한다(v2.596 규약). 숫자 문자열은 숫자로 바꾼다 — `'0'` 이 `=== 0` 판정을
 * 비껴가 무제한 대신 하한 100 이 되지 않게. 명시적 0 만 maxTotalMB 의 '무제한' 이다.
 */
export function cleanLogPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (NUMERIC_KEYS.includes(k)) {
      const n = numOrNull(v);
      if (n == null) continue;
      out[k] = n;
    } else out[k] = v;
  }
  return out;
}

export function setLogSettings(patch) {
  if (logSettingsLoadError()) {   // 26회차 F1: 손상 중 부분 저장은 기본값(짧은 보관)을 굳혀 다음 회전이 이력을 지운다
    const e = new Error('로그 보관 설정 파일을 읽지 못한 상태라 저장하지 않았습니다 — 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리고 재시작하세요.'); e.code = 'settings-unreadable'; e.status = 409; throw e;
  }
  const next = normalize({ ...getLogSettings(), ...cleanLogPatch(patch) });
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
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  cache = next;   // 쓰기 성공 뒤에만
  _loadErr.ok();
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
    keepFiles: Number.isFinite(keep) ? Math.min(LOG_LIMITS.keepFilesMax, Math.max(1, Math.round(keep))) : DEFAULTS.keepFiles,
    maxFileMB: clamp(o.maxFileMB, 8, 8192, DEFAULTS.maxFileMB),
    maxTotalMB: o.maxTotalMB === 0 ? 0 : clamp(o.maxTotalMB, 100, LOG_LIMITS.maxTotalMBMax, DEFAULTS.maxTotalMB),
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

export function _resetLogSettingsCache() { cache = null; _loadErr.ok(); }
