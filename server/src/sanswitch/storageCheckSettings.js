/**
 * sanswitch/storageCheckSettings.js — SAN 스토리지 성능 점검의 임계값 설정(v2.948).
 *
 * ── 임계값을 지어내지 않는다(설계 §10 · 월간 점검 제2 규칙과 같은 정신) ──
 * 기본값은 **벤더 문서에서 찾은 값만** 넣고(출처를 함께 둔다 — 화면이 보여 준다), 못 찾은 항목은 null(비움)이다.
 * null 인 항목은 판정하지 않고 '확인 불가(기준 없음)' 로 두며 값만 보인다. 관리자가 넣으면 그때부터 판정한다.
 * 편중(디렉터 평균 0.5 Gb/s 이상 · 1.4배) 상수는 포트 사용량 탭(portUsage.js IMBALANCE_*)의 것을 그대로 쓰고 여기서 바꾸지 않는다.
 *
 * 파일: CONFIG_DIR/storage-perf-check.json — 자격증명 아님. 원자적 쓰기 + 손상 보존. 쓰기는 관리자 전용 라우트(fullRwOnly) + 감사 로그.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'storage-perf-check.json');

/**
 * 항목 정의 — k · 라벨 · 기본값(null = 비움) · 범위 · 단위 · 출처. `pair` 는 주의/이상 짝(주의 ≤ 이상 검사).
 * 출처는 docs/design/san-storage-perf/README.md §10 (2026-11-08 웹 확인 — 실장비 · 원문 재대조 권고).
 */
export const THRESHOLDS = Object.freeze([
  { k: 'asymMinSharePct', label: '팹 비대칭 — 한쪽 팹 비중 하한', def: 30, min: 1, max: 49, unit: '%', source: '제안(새 규칙 — 설정에서 조정)', group: 'switch' },
  { k: 'portSatWarnPct', label: '회선 포화 — 주의', def: 70, min: 1, max: 100, unit: '%', source: 'Brocade MAPS 기본 FPI 과가입 트리거 TX 70%(FOS 9.1.x MAPS User Guide)', group: 'switch', pair: 'portSatBadPct' },
  { k: 'portSatBadPct', label: '회선 포화 — 이상', def: 90, min: 1, max: 100, unit: '%', source: '제안 — Brocade 혼잡 가이드의 90%/hr 대역폭 경보 수준(기본값인지 미확인)', group: 'switch' },
  { k: 'dirBusyWarnPct', label: '디렉터 busy — 주의(PowerMax)', def: null, min: 1, max: 100, unit: '%', source: '비움 — 벤더 주의 단계 기준 없음', group: 'array', pair: 'dirBusyBadPct' },
  { k: 'dirBusyBadPct', label: '디렉터 busy — 이상(PowerMax)', def: 70, min: 1, max: 100, unit: '%', source: 'Unisphere for PowerMax 10.0 건강 점수 기본 critical 70', group: 'array' },
  { k: 'queueWarnPct', label: '큐 깊이 사용률 — 주의(PowerMax)', def: null, min: 1, max: 100, unit: '%', source: '비움', group: 'array', pair: 'queueBadPct' },
  { k: 'queueBadPct', label: '큐 깊이 사용률 — 이상(PowerMax)', def: 75, min: 1, max: 100, unit: '%', source: 'Unisphere for PowerMax 10.0 건강 점수 기본 critical 75', group: 'array' },
  { k: 'respWarnMs', label: '응답 시간 — 주의', def: null, min: 0.1, max: 10000, unit: 'ms', source: '비움 — 디렉터 · 노드 단위 공식 기준을 찾지 못함', group: 'array', pair: 'respBadMs' },
  { k: 'respBadMs', label: '응답 시간 — 이상', def: null, min: 0.1, max: 10000, unit: 'ms', source: '비움 — 디렉터 · 노드 단위 공식 기준을 찾지 못함', group: 'array' },
  { k: 'unityCpuWarnPct', label: 'Unity SP CPU — 주의', def: 70, min: 1, max: 100, unit: '%', source: 'Dell Unity Best Practices Guide 지속 사용률 50~70 정상 · 70~90 높음', group: 'array', pair: 'unityCpuBadPct' },
  { k: 'unityCpuBadPct', label: 'Unity SP CPU — 이상', def: 90, min: 1, max: 100, unit: '%', source: 'Dell Unity Best Practices Guide 90% 초과 과부하', group: 'array' },
  { k: 'pstoreCpuWarnPct', label: 'PowerStore 노드 CPU — 주의', def: 50, min: 1, max: 100, unit: '%', source: 'Dell KB 000192018(업그레이드 전 점검 — 50% 초과 연기 · 간접 근거)', group: 'array', pair: 'pstoreCpuBadPct' },
  { k: 'pstoreCpuBadPct', label: 'PowerStore 노드 CPU — 이상', def: 70, min: 1, max: 100, unit: '%', source: 'Dell KB 000192018(지속 70% 이상 부하 높음 — 간접 근거)', group: 'array' },
  { k: 'compareDiffPct', label: '보고 대조 — 스위치 · 어레이 차이 주의', def: 30, min: 1, max: 100, unit: '%', source: '제안(새 규칙)', group: 'array' },
  // v2.950(§12.2-7): 자기 기준선 — 지난 4주 같은 요일 · 시간 평균 대비 허용 폭(±%). 판정이 아니라 '평소와 다름' 표시의 폭(비움 = 표시 안 함).
  { k: 'baselineTolerancePct', label: '자기 기준선 — 평소와 다름 허용 폭(± · 지난 4주 같은 요일 · 시간 평균 대비)', def: 50, min: 5, max: 500, unit: '%', source: '제안(새 규칙 — 기준은 그 어레이의 자기 과거)', group: 'baseline' },
]);
const BY_KEY = new Map(THRESHOLDS.map((t) => [t.k, t]));

let _cache = null;

export function defaultThresholds() {
  const out = {};
  for (const t of THRESHOLDS) out[t.k] = t.def;
  return out;
}

export function loadCheckSettings() {
  if (_cache) return _cache;
  const file = FILE();
  let raw = null;
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { preserveCorrupt(file, String(e?.message || e)); raw = null; }
    if (raw && (typeof raw !== 'object' || Array.isArray(raw))) { preserveCorrupt(file, '객체가 아닌 JSON 값'); raw = null; }
  }
  _cache = normalizeCheckSettings(raw || {});
  return _cache;
}

/**
 * 정규화(순수 · 로드용 — 던지지 않는다). 저장된 값은 `values` 에만 있고, 없는 키는 기본값이다.
 * `userSet` 은 사용자가 바꾼 키 목록(기본값과 다른 것 — 화면 '사용자 설정' 배지).
 */
export function normalizeCheckSettings(input = {}) {
  const values = defaultThresholds();
  const src = input && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
  for (const t of THRESHOLDS) {
    if (!Object.hasOwn(src, t.k)) continue;
    const v = src[t.k];
    if (v === null) { values[t.k] = null; continue; }
    const n = numOrNull(v);
    if (n == null || n < t.min || n > t.max) continue;   // 범위 밖은 기본값으로(손상값을 판정 기준으로 쓰지 않는다)
    values[t.k] = n;
  }
  const userSet = THRESHOLDS.filter((t) => values[t.k] !== t.def).map((t) => t.k);
  return { v: 1, values, userSet, updatedAt: Number.isFinite(Number(input.updatedAt)) && Number(input.updatedAt) > 0 ? Number(input.updatedAt) : null, updatedBy: String(input.updatedBy || '').slice(0, 64) };
}

/**
 * 저장 — 형식 오류는 `{ issue }`(400). 빈 문자열 · undefined 는 '비움(null)' 이 아니라 **기본값으로 되돌림**이다 — 비우려면 null 을 보낸다
 * (v2.599 LO2599-01 '빈 칸은 미지정' 규약과 같은 방향: 빈 칸이 조용히 다른 뜻이 되지 않게 라우트 문서에 적는다).
 */
export function saveCheckSettings(input = {}, { by = '', now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { issue: '본문은 객체여야 합니다' };
  const src = input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : input;
  const values = defaultThresholds();
  for (const [k, v] of Object.entries(src)) {
    const t = BY_KEY.get(k);
    if (!t) return { issue: `모르는 항목: ${String(k).slice(0, 40)}` };
    if (v === null) { values[k] = null; continue; }
    if (v === '' || v === undefined) continue;
    const n = numOrNull(v);
    if (n == null) return { issue: `${t.label}: 숫자 또는 null 이어야 합니다` };
    if (n < t.min || n > t.max) return { issue: `${t.label}: ${t.min}~${t.max}${t.unit} 안이어야 합니다` };
    values[k] = n;
  }
  for (const t of THRESHOLDS) {
    if (!t.pair) continue;
    const w = values[t.k]; const b = values[t.pair];
    if (w != null && b != null && w > b) return { issue: `${t.label} 가 이상 기준보다 큽니다(주의 ≤ 이상)` };
  }
  const next = normalizeCheckSettings({ values, updatedAt: now, updatedBy: by });
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, values, updatedAt: now, updatedBy: String(by || '').slice(0, 64) }, null, 2));
  _cache = next;
  return { settings: next };
}

/** 화면 · 라우트가 쓰는 공개 모양 — 항목 정의 + 현재 값 + 출처. */
export function publicCheckSettings() {
  const s = loadCheckSettings();
  return {
    values: { ...s.values }, userSet: [...s.userSet], updatedAt: s.updatedAt, updatedBy: s.updatedBy,
    items: THRESHOLDS.map((t) => ({ k: t.k, label: t.label, def: t.def, min: t.min, max: t.max, unit: t.unit, source: t.source, group: t.group, pair: t.pair || null })),
  };
}

export function _resetForTest() { _cache = null; }
