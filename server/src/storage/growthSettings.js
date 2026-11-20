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

import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';   // 23회차 S-3
import { makeJsonFileReader, READ_RETRY_MS } from '../util/jsonFileRead.js';   // 103회차 F8: 읽기 오류 ≠ 손상
import { setKeepDays, setPruneHold, RAW_KEEP_DAYS_DEF, DAILY_KEEP_DAYS_DEF, NODE_LOAD_RAW_KEEP_DAYS_DEF, NODE_LOAD_HOURLY_KEEP_DAYS_DEF,
  NODE_CLIENT_RAW_KEEP_DAYS_DEF, NODE_CLIENT_HOURLY_KEEP_DAYS_DEF, NODE_CLIENT_DAILY_KEEP_DAYS_DEF } from './db.js';

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
  {
    // v2.926 — 노드 부하(네트워크·디스크·CPU) 원시. 노드 × 수집 주기라 용량 원시보다 크다 — 일 롤업(위 '사용량 저장 기간')은 따로 남는다.
    key: 'nodeLoadRawKeepDays', def: NODE_LOAD_RAW_KEEP_DAYS_DEF, min: 1, max: 400,
    label: '노드 부하 원시 보존 기간',
    // v2.932: 기본 30일 → 7일(표본 주기가 1시간 → 5분이면 행이 12배). 저장값이 있으면 그대로다(저장값 우선 — 아래 loadGrowthSettings).
    hint: '아이실론 노드별 네트워크·디스크·CPU·IOPS 를 표본 주기마다 남기는 점입니다(노드 수 × 주기 — 5분 표본이면 1시간 수집의 12배). 원시보다 오래된 구간은 시간 요약·일 요약으로 봅니다.',
    presets: [{ days: 2, label: '2일' }, { days: 7, label: '7일(기본)' }, { days: 30, label: '30일' }, { days: 90, label: '90일' }],
  },
  {
    // v2.932(2차) — 노드 시간 요약(노드 × 24/일). 원시가 끝난 뒤 7일·30일 보기의 세밀한 원천.
    key: 'nodeLoadHourlyKeepDays', def: NODE_LOAD_HOURLY_KEEP_DAYS_DEF, min: 7, max: 1825,
    label: '노드 부하 시간 요약 보존 기간',
    hint: '노드별 1시간 평균·최대입니다(노드 수 × 24행/일). 원시 보존이 끝난 구간을 1시간 단위로 볼 수 있는 기간이고, 그보다 오래된 구간은 일 단위 요약만 남습니다.',
    presets: [{ days: 30, label: '30일' }, { days: 90, label: '90일(기본)' }, { days: 365, label: '1년' }],
  },
  {
    // v2.932(2차 ③) — 노드별 클라이언트·프로토콜 원시(표본마다 노드 × 상위 N 행). 가장 많이 쌓이는 표라 짧다.
    key: 'nodeClientRawKeepDays', def: NODE_CLIENT_RAW_KEEP_DAYS_DEF, min: 1, max: 30,
    label: '노드 클라이언트 원시 보존 기간',
    hint: '노드마다 ‘지금 작업 중인 클라이언트 상위 N’ 을 표본 주기마다 남기는 행입니다(노드 수 × N × 주기 — 가장 많이 쌓입니다). 노드 드로어의 ‘지금’ 열이 이 표를 읽습니다.',
    presets: [{ days: 1, label: '1일' }, { days: 2, label: '2일(기본)' }, { days: 7, label: '7일' }],
  },
  {
    key: 'nodeClientHourlyKeepDays', def: NODE_CLIENT_HOURLY_KEEP_DAYS_DEF, min: 7, max: 365,
    label: '노드 클라이언트 시간 요약 보존 기간',
    hint: '클라이언트 × 노드 × 프로토콜의 1시간 평균입니다. 노드 드로어의 24시간·7일 창과 ‘클라이언트 분포(쏠림·재배치 후보)’ 가 이 표를 읽습니다.',
    presets: [{ days: 14, label: '14일' }, { days: 30, label: '30일(기본)' }, { days: 90, label: '90일' }],
  },
  {
    key: 'nodeClientDailyKeepDays', def: NODE_CLIENT_DAILY_KEEP_DAYS_DEF, min: 30, max: 1825,
    label: '노드 클라이언트 일 요약 보존 기간',
    hint: '클라이언트 × 노드 × 프로토콜의 하루 평균입니다(30일보다 긴 창). 재배치 전후를 달 단위로 비교할 때 씁니다.',
    presets: [{ days: 180, label: '180일' }, { days: 365, label: '1년(기본)' }, { days: 730, label: '2년' }],
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
/*
 * 전체 점검 23회차 S-3(재현): 손상 → 기본값 → 다음 정리가 긴 보존 이력을 지웠다. 이제 못 읽은 동안(손상 · 재시작 뒤 보존본만)은
 *   ① 칸마다 **설정 상한(max)** 으로만 정리(27회차 D-4 — 23회차의 전면 보류는 디스크가 끝없이 찼다) ② 저장은 409(부분 저장이 나머지 칸을
 *   기본값으로 굳히지 않게) ③ 서비스 점검 목록에 올라 '확정'(보존 칸 최대값 저장 — 27회차 D-3) 또는 보존본 복구로만 풀린다.
 */
// 27회차 반증 D-1 · D-3: 쓰기 라우트가 설정 소유자 등급이라 확정도 소유자(ownerOnly) · 확정은 **보존 칸을 최대값으로** 쓴다
//   (기본값으로 확정하면 그 직후 정리가 기본 보존으로 돌아 보류가 막으려던 이력을 지웠다 — 관리자가 나중에 줄인다).
const maxRetention = () => Object.fromEntries(GROWTH_SPEC.map((s) => [s.key, s.max]));
const _loadErr = makeSettingsLoadError(() => FILE(), { label: '스토리지 증가량 보존 기간 — 못 읽는 동안 · 확정 시 보존은 최대값(이력을 지우지 않음)', confirm: () => { const v = maxRetention(); atomicWriteFileSync(FILE(), JSON.stringify(v, null, 2), { mode: 0o600 }); _cache = normalizeGrowthSettings(v).values; _loadErr.ok(); applyGrowthSettings(); }, ownerOnly: true });
/** 보존 설정을 못 읽었으면 { at, reason }, 아니면 null. */
export function growthSettingsLoadError() { loadGrowthSettings(); return _loadErr.get(); }

/** 저장된 설정 + 기본값을 합친 실효값. `source` 로 '어디서 온 값인지' 를 함께 준다. */
/*
 * 103회차 F8(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**도 손상으로 보고 원본(관리자가 늘려 둔 보존 기간)을 `.corrupt.*` 로 옮겼다 — 정리는 상한(max)으로
 *   돌아 이력은 지켰지만, 재시작하면 '손상 보존본만 있음' 이 되어 확정(전 칸 최대값)이나 수동 복구로만 풀렸다(권한만 고치면 되는 일이었다).
 *   읽기 단계는 공용 읽기(util/jsonFileRead.js — 30초 간격 재읽기): 읽기 오류는 원본을 두고 · 캐시하지 않고 · 표지(readError — 확정 불가)를 세우고 ·
 *   정리는 그대로 상한으로 · 저장은 409. 다시 읽히면 그 값으로 DB 보존 일수를 되돌린다(applyGrowthSettings).
 */
const _reader = makeJsonFileReader(FILE, { parse: (t) => t, preserve: false, tag: 'storage-growth' });
export function loadGrowthSettings() {
  let base = _cache;
  if (!base) {
    let saved = {};
    const wasReadErr = !!_loadErr.get()?.readError;
    const rr = _reader.read();
    let readErr = false;
    if (rr.kind === 'read-error') { readErr = true; _loadErr.readError(rr.error, { retryMs: READ_RETRY_MS }); }
    else try {
      if (rr.kind === 'missing') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      saved = JSON.parse(rr.value);
      // 27회차 D-5: 객체가 아닌 JSON(null · 배열 · 수)도 손상이다(v2.601 규약 — 형제 SAN · CVP · 스캔 설정과 같게)
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) { const e = new Error('객체가 아닌 JSON 값'); throw e; }
      _loadErr.ok();
    }
    catch (e) {
      // ENOENT 는 '아직 저장한 적 없음' 이라 정상이다(손상 보존본만 남았으면 여전히 못 읽은 것 — missing). 그 밖(손상)은 원본을 보존한다.
      if (e?.code === 'ENOENT') _loadErr.missing();
      else { _loadErr.corrupt(e); try { preserveCorrupt(FILE()); } catch { /* best effort */ } }
      saved = {};
    }
    base = normalizeGrowthSettings(saved).values;
    if (!readErr) {
      _cache = base;   // 읽기 오류면 캐시하지 않는다(간격마다 다시 읽는다)
      if (wasReadErr) { try { applyGrowthSettings(); } catch { /* 다음 저장 · 재시작이 다시 넣는다 */ } }   // 다시 읽혔다 — 상한 정리를 그 값으로 되돌린다
    }
  }
  // v2.590 P9: 저장값이 없으면 **env 가 기본값보다 먼저**다(`storage/db.js` 머리말의 약속 '설정 → env → 기본').
  // v2.589 까지는 여기서 기본값 숫자를 채워 `applyGrowthSettings` 가 db 에 주입했으므로 db 의 env 폴백이
  // 도달 불가였다 — env 로 원시 400일을 잡은 현장이 설정을 한 번도 저장하지 않았으면 90일 넘는 원시 이력이
  // 다음 prune 에서 지워졌고, 화면은 '기본값' 이라 말했다.
  const envVals = normalizeGrowthSettings({
    rawKeepDays: process.env.STORAGE_HISTORY_KEEP_DAYS, dailyKeepDays: process.env.STORAGE_DAILY_KEEP_DAYS,
    nodeLoadRawKeepDays: process.env.STORAGE_NODELOAD_KEEP_DAYS,
    // v2.932 — 새 칸 4개의 env 폴백(db.js 와 같은 이름)
    nodeLoadHourlyKeepDays: process.env.STORAGE_NODELOAD_HOURLY_KEEP_DAYS, nodeClientRawKeepDays: process.env.STORAGE_NODECLIENT_KEEP_DAYS,
    nodeClientHourlyKeepDays: process.env.STORAGE_NODECLIENT_HOURLY_KEEP_DAYS, nodeClientDailyKeepDays: process.env.STORAGE_NODECLIENT_DAILY_KEEP_DAYS,
  }).values;
  const out = {};
  for (const s of GROWTH_SPEC) {
    const src = base[s.key] != null ? 'saved' : envVals[s.key] != null ? 'env' : 'default';
    out[s.key] = src === 'saved' ? base[s.key] : src === 'env' ? envVals[s.key] : s.def;
    out[`${s.key}Source`] = src;
  }
  return out;
}

/** 저장 → 즉시 DB 에 반영. prune 은 여기서 돌리지 않는다(호출부 결정 — 위 머리말 참조). */
export function saveGrowthSettings(input) {
  if (growthSettingsLoadError()?.readError) {   // 103회차 F8: 읽기 오류는 손상과 조치가 다르다(원본은 그대로)
    const e = new Error(`저장된 보존 기간 설정 파일을 읽지 못했습니다(읽기 오류) — 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽고, 읽히면 저장이 다시 열립니다). 그동안 정리는 칸마다 상한 보존 기간으로만 합니다.`);
    e.code = 'settings-unreadable'; e.readError = true; throw e;
  }
  if (growthSettingsLoadError()) {   // 23회차 S-3
    const e = new Error('저장된 보존 기간 설정 파일을 읽지 못했습니다 — 지금 저장하면 적지 않은 칸이 기본값(더 짧은 보존)으로 굳습니다. 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리고 재시작하세요.');
    e.code = 'settings-unreadable'; throw e;
  }
  const { values, issues } = normalizeGrowthSettings(input);
  // v2.733(점검 3회차 C4-04): 캐시·DB 반영은 **디스크 쓰기 성공 뒤에만** — 예전에는 먼저 바꿔, 저장 실패 뒤에도 실패한 값이 출처 'saved' 로
  //   보였다(재시작하면 옛 값). 저장 전에 한 번 읽어 둔다(_cache 가 비어 있으면 다른 저장값을 빠뜨린 채 덮어쓰지 않게).
  loadGrowthSettings();
  const next = { ...(_cache || {}), ...values };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cache = next;
  applyGrowthSettings();
  return { values: loadGrowthSettings(), issues };
}

/** 기동 시·저장 시 DB 모듈에 보존 일수를 주입한다. */
export function applyGrowthSettings() {
  const v = loadGrowthSettings();
  // 23회차 S-3 → 27회차 D-4: 못 읽은 동안은 보류(무한 증가)가 아니라 **칸마다 설정 상한(max)** 으로 정리한다 — 관리자가 둘 수 있었던
  //   어떤 값보다 오래된 행만 지운다(이력을 잃지 않고 디스크는 묶인다).
  setPruneHold(null);
  if (_loadErr.get()) {
    const m = maxRetention();
    setKeepDays({ rawKeepDays: m.rawKeepDays, dailyKeepDays: m.dailyKeepDays, nodeLoadRawKeepDays: m.nodeLoadRawKeepDays,
      nodeLoadHourlyKeepDays: m.nodeLoadHourlyKeepDays, nodeClientRawKeepDays: m.nodeClientRawKeepDays,
      nodeClientHourlyKeepDays: m.nodeClientHourlyKeepDays, nodeClientDailyKeepDays: m.nodeClientDailyKeepDays });
    return v;
  }
  setKeepDays({ rawKeepDays: v.rawKeepDays, dailyKeepDays: v.dailyKeepDays, nodeLoadRawKeepDays: v.nodeLoadRawKeepDays,
    nodeLoadHourlyKeepDays: v.nodeLoadHourlyKeepDays, nodeClientRawKeepDays: v.nodeClientRawKeepDays,
    nodeClientHourlyKeepDays: v.nodeClientHourlyKeepDays, nodeClientDailyKeepDays: v.nodeClientDailyKeepDays });
  return v;
}

export function _resetForTest() { _cache = null; _loadErr.ok(); _reader.reset(); }
