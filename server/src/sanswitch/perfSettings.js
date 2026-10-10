/**
 * sanswitch/perfSettings.js — 포트 사용량(portperfshow) 수집 설정(v2.411, 사용자 요구
 * '설정에서 주기적으로 portperfshow 를 수행해서 포트 사용량 수집').
 *
 * 파일: CONFIG_DIR/sanswitch-perf-settings.json (자격증명 없음 — vault 대상 아님).
 * 원자적 쓰기 + 손상 시 preserveCorrupt 는 동일하게 지킨다(설정이 조용히 사라지지 않게).
 *
 * 하한을 두는 이유: portperfshow 는 매 수집마다 SSH 세션을 열고 sampleSeconds 동안 화면을
 * 받아쓴다. 주기를 60초 밑으로 내리면 스위치에 상시 세션이 붙어 있는 것과 같아지고, 128포트
 * × 스위치 수만큼 매번 DB 에 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';

const FILE = path.join(config.configDir, 'sanswitch-perf-settings.json');

export const LIMITS = {
  intervalMs: { min: 60_000, max: 6 * 3600_000, def: 5 * 60_000 },
  sampleSeconds: { min: 3, max: 60, def: 8 },     // portperfshow 를 몇 초 동안 받아쓸지
  retentionDays: { min: 1, max: 3650, def: 90 },
  // v2.728(SAN 2차): 1시간 집계 표 보관 기간 — 원본(retentionDays)과 따로 둔다(사용자 선택 '원본 90일 유지 · 집계 2년').
  //   원본이 지워진 기간의 추이는 이 표로 본다. 15분 집계 표는 31일 고정이다(SANSW_PERF_ROLLUP_15M_DAYS).
  rollupRetentionDays: { min: 30, max: 3650, def: 730 },
};
const clamp = (v, l, def) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(l.max, Math.max(l.min, Math.round(n)));
};

// v2.599 LO2599-01: 숫자 칸을 비우고 저장하면(''·null·비숫자·0 이하) clamp 가 **기본값**을 줬다 — 예: 보존 3650일 →
// 90일 · 주기 1시간 → 5분(SAN 포트 사용량). v2.596 규약대로 빈 칸은 '미지정' 이고 **이전 값을 유지**한다(판정은 numOrNull — Number('')===0 함정).
function keepPrevBlankNumbers(input, prev) {
  const out = { ...(input && typeof input === 'object' ? input : {}) };
  for (const k of Object.keys(LIMITS)) {
    const n = numOrNull(out[k]);
    if (n == null || n <= 0) out[k] = prev[k];
  }
  return out;
}

let _cache = null;

/*
 * v2.632(감사 EDGE2632-02): 로드 오류 상태. 손상 → 보존 → 기본값(꺼짐 · 보존 90일)을 /api/central/sanswitch-config 가 perf 로
 *   200 배포하면 전 엣지가 포트 사용량 수집을 끄고 보존일을 90일로 줄여 **저장**했다(엣지 표본이 prune 으로 잘린다).
 *   오류면 라우트가 perf 를 싣지 않고 `perfSettingsUnreadable` 을 싣는다(엣지는 body.perf 가 없으면 적용하지 않는다 — 구버전 엣지도).
 *   저장 성공만 해제한다(관리자가 다시 저장하면 풀린다).
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'SAN 포트 사용량 설정', confirm: () => savePerfSettings({}) });
/** 설정 파일을 못 읽었으면 { at, reason }, 읽었으면 null. */
export function perfSettingsLoadError() { loadPerfSettings(); return _loadErr.get(); }

export function loadPerfSettings() {
  if (_cache) return { ..._cache };
  let raw = {};
  if (!fs.existsSync(FILE)) _loadErr.missing();
  else {
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); _loadErr.ok(); }
    catch (e) { _loadErr.corrupt(e); preserveCorrupt(FILE); raw = {}; }
  }
  // v2.601(감사 TIM2601-03 — 재현): 파일 내용이 유효한 JSON 값 null·배열·숫자면 JSON.parse 는 성공해 손상 보존을 건너뛰고
  // 정규화가 TypeError 로 던졌다(_cache 가 안 채워져 **매 호출** 던진다 → 이 로더를 getMs 로 쓰는 적응 타이머가 멈췄다).
  // 객체가 아니면 손상으로 보고 보존한 뒤 기본값으로 시작한다(bmusage/settings.js readFile 과 같은 판정).
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { _loadErr.corrupt('객체가 아닌 JSON 값'); preserveCorrupt(FILE, '객체가 아닌 JSON 값'); raw = {}; }
  _cache = normalizePerfSettings(raw);
  return { ..._cache };
}

/** 순수 정규화 — 하한/상한 clamp. 기본은 **꺼짐**(운영 스위치에 주기 접속을 임의로 만들지 않는다). */
export function normalizePerfSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}; // null 은 기본 매개변수가 막지 못한다(TIM2601-03)
  return {
    enabled: input.enabled === true,
    intervalMs: clamp(input.intervalMs, LIMITS.intervalMs, LIMITS.intervalMs.def),
    sampleSeconds: clamp(input.sampleSeconds, LIMITS.sampleSeconds, LIMITS.sampleSeconds.def),
    retentionDays: clamp(input.retentionDays, LIMITS.retentionDays, LIMITS.retentionDays.def),
    rollupRetentionDays: clamp(input.rollupRetentionDays, LIMITS.rollupRetentionDays, LIMITS.rollupRetentionDays.def),
  };
}

// v2.591 L10: 값이 바뀌면 무장된 타이머를 즉시 재무장하게 알린다(v2.409 '값 변경 시 즉시 재무장' 규약 — vmseries·curuser 와 같은 형태).
//   없으면 주기를 길게 둔 뒤 줄여도 옛 주기(최대 6시간)가 지나야 새 주기가 먹었다.
const _listeners = new Set();
export function onPerfSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
function notifyChange() { for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } } }
export function savePerfSettings(input = {}) {
  // v2.732(점검 2회차 B5-03): 캐시는 **디스크 쓰기 성공 뒤에만** 바꾼다(insights/fleetAssign.js 와 같은 규약). 예전에는 캐시를 먼저
  //   바꿔, 쓰기가 실패해 라우트가 400 을 준 뒤에도 메모리는 새 값으로 수집했고 재시작하면 옛 값으로 돌아갔다(화면과 실제가 어긋남).
  const next = normalizePerfSettings(keepPrevBlankNumbers(input, loadPerfSettings()));
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ...next }, null, 2), { mode: 0o600 });
  _cache = next;
  _loadErr.ok();
  notifyChange();
  return { ..._cache };
}

/**
 * 엣지: 중앙이 내려준 포트 사용량 설정 적용(v2.423). 중앙의 '설정 › 수집 서버 › SAN 스위치 포트 사용량'이 위임 스위치에도
 * 먹어야 한다 — 예전에는 엣지 로컬 설정(기본 꺼짐)만 봐서 중앙에서 켜도 엣지는 수집하지 않았다.
 * `SANSW_PERF_LOCAL=1` 이면 현장 설정을 지킨다(중앙 무시). 값이 같으면 파일을 다시 쓰지 않는다.
 * 반환: true = 바뀌어 적용됨.
 */
export function applyCentralPerfSettings(remote) {
  if (!remote || typeof remote !== 'object') return false;
  if (String(process.env.SANSW_PERF_LOCAL || '') === '1') return false;
  const next = normalizePerfSettings({ ...loadPerfSettings(), ...remote });
  const cur = loadPerfSettings();
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  savePerfSettings(next);
  return true;
}

export function _resetForTest() { _cache = null; _loadErr.ok(); }
