/**
 * storage/growthSettings.js — 스토리지 사용량 보존 설정(v2.531).
 *
 * 사용자 요청: **"스토리지 사용량 저장을 사용자가 설정에서 지정할 수 있게 해주고 기본값을 5년으로"**.
 *
 * 값은 둘이다(사용자 선택 "일 단위 롤업 5년 + 원시 90일"):
 *  · `rawKeepDays`   — 원시(폴링마다 1점) 보존. 짧게. 최근 구간을 세밀히 볼 때만 쓰인다.
 *  · `dailyKeepDays` — 일 단위 롤업 보존. **이것이 '스토리지 사용량 저장 기간'** 이고 기본 5년이다.
 *
 * ⚠ **화면에 숫자를 하드코딩하지 말 것**(CLAUDE.md 규약) — 이 모듈이 `SPEC`(기본/하한/상한/설명)을
 *   내려주고 설정 폼이 그것으로 그린다. 기본값을 바꾸려면 여기 한 곳만 고친다.
 * ⚠ **빈 값·0 을 하한으로 승격하지 않는다** — '미입력' 과 '최소값 지정' 은 다른 뜻이다
 *   (`intervals.js` 와 같은 규약. 미입력이 최소 보존으로 둔갑하면 이력이 조용히 날아간다).
 * ⚠ 저장 즉시 `db.setKeepDays()` 로 반영하고 **강제 prune 은 호출부가 결정**한다 — 보존을 줄이는
 *   저장은 되돌릴 수 없는 삭제라 사용자가 누른 뒤에 도는 것이 맞고, 화면이 그 사실을 먼저 말한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { setKeepDays, RAW_KEEP_DAYS_DEF, DAILY_KEEP_DAYS_DEF } from './db.js';

const FILE = () => path.join(config.configDir, 'storage-growth-settings.json');

/** 설정 항목 단일 소스 — UI 가 이 표를 받아 폼을 그린다. */
export const GROWTH_SPEC = Object.freeze([
  {
    key: 'dailyKeepDays', def: DAILY_KEEP_DAYS_DEF, min: 30, max: 3650,
    label: '사용량 저장 기간(일 단위 요약)',
    hint: '증가량 분석의 원천입니다. 하루 1행이라 5년을 담아도 장비당 1,825행으로 작습니다. 이 값보다 오래된 날은 지워지고 되돌릴 수 없습니다.',
    presets: [{ days: 365, label: '1년' }, { days: 730, label: '2년' }, { days: 1095, label: '3년' }, { days: 1825, label: '5년(기본)' }, { days: 3650, label: '10년' }],
  },
  {
    key: 'rawKeepDays', def: RAW_KEEP_DAYS_DEF, min: 7, max: 1825,
    label: '원시 표본 보존 기간',
    hint: '수집 주기마다 남기는 점입니다. 최근 구간을 세밀히 보는 용도라 짧게 둡니다 — 길게 두면 파일이 빠르게 커집니다(증가량 분석에는 쓰이지 않습니다).',
    presets: [{ days: 30, label: '30일' }, { days: 90, label: '90일(기본)' }, { days: 180, label: '180일' }, { days: 400, label: '400일' }],
  },
]);
const SPEC_BY_KEY = new Map(GROWTH_SPEC.map((s) => [s.key, s]));

/**
 * 입력 정규화(순수). 아는 키만 남기고 하한/상한으로 clamp 한다.
 * @returns {{values:object, issues:string[]}} issues 는 사람이 읽는 경고(저장은 진행한다)
 */
export function normalizeGrowthSettings(input = {}) {
  const values = {};
  const issues = [];
  for (const [k, raw] of Object.entries(input || {})) {
    const spec = SPEC_BY_KEY.get(k);
    if (!spec) continue;                       // 모르는 키는 조용히 버린다(스키마 밖 값 유입 방지)
    if (raw === '' || raw == null) continue;   // '미입력' — 하한으로 승격하지 않는다
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) { issues.push(`${spec.label}: 숫자가 아니어서 무시했습니다(${raw}).`); continue; }
    const c = Math.max(spec.min, Math.min(spec.max, n));
    if (c !== n) issues.push(`${spec.label}: ${n}일은 허용 범위(${spec.min}~${spec.max}일)를 벗어나 ${c}일로 조정했습니다.`);
    values[k] = c;
  }
  return { values, issues };
}

let _cache = null;

/** 저장된 설정 + 기본값을 합친 실효값. `source` 로 '어디서 온 값인지' 를 함께 준다. */
export function loadGrowthSettings() {
  if (!_cache) {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {}; }
    catch (e) {
      // ENOENT 는 '아직 저장한 적 없음' 이라 정상이다. 그 밖(손상)은 원본을 보존하고 기본으로 간다.
      if (e?.code !== 'ENOENT') { try { preserveCorrupt(FILE()); } catch { /* best effort */ } }
      saved = {};
    }
    _cache = normalizeGrowthSettings(saved).values;
  }
  // v2.590 P9: 저장값이 없으면 **env 가 기본값보다 먼저**다(`storage/db.js` 머리말의 약속 '설정 → env → 기본').
  // v2.589 까지는 여기서 기본값 숫자를 채워 `applyGrowthSettings` 가 db 에 주입했으므로 db 의 env 폴백이
  // 도달 불가였다 — env 로 원시 400일을 잡은 현장이 설정을 한 번도 저장하지 않았으면 90일 넘는 원시 이력이
  // 다음 prune 에서 지워졌고, 화면은 '기본값' 이라 말했다.
  const envVals = normalizeGrowthSettings({
    rawKeepDays: process.env.STORAGE_HISTORY_KEEP_DAYS, dailyKeepDays: process.env.STORAGE_DAILY_KEEP_DAYS,
  }).values;
  const out = {};
  for (const s of GROWTH_SPEC) {
    const src = _cache[s.key] != null ? 'saved' : envVals[s.key] != null ? 'env' : 'default';
    out[s.key] = src === 'saved' ? _cache[s.key] : src === 'env' ? envVals[s.key] : s.def;
    out[`${s.key}Source`] = src;
  }
  return out;
}

/** 저장 → 즉시 DB 에 반영. prune 은 여기서 돌리지 않는다(호출부 결정 — 위 머리말 참조). */
export function saveGrowthSettings(input) {
  const { values, issues } = normalizeGrowthSettings(input);
  _cache = { ..._cache, ...values };
  atomicWriteFileSync(FILE(), JSON.stringify(_cache, null, 2), { mode: 0o600 });
  applyGrowthSettings();
  return { values: loadGrowthSettings(), issues };
}

/** 기동 시·저장 시 DB 모듈에 보존 일수를 주입한다. */
export function applyGrowthSettings() {
  const v = loadGrowthSettings();
  setKeepDays({ rawKeepDays: v.rawKeepDays, dailyKeepDays: v.dailyKeepDays });
  return v;
}

export function _resetForTest() { _cache = null; }
