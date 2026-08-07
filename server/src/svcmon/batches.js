/**
 * 성능점검 대량 등록/가져오기 **이력 원장**(+ 롤백) — `CONFIG_DIR/svcmon-batches.json`.
 *
 * 왜 원장이 필요한가: 대상에 붙는 `batch` 태그만으로는 "언제·누가·무엇을 몇 개 넣었는지"를
 * 알 수 없다. 태그가 붙은 대상을 사용자가 하나씩 지우고 나면 그 배치의 흔적 자체가 사라져
 * 롤백 화면에 아무것도 뜨지 않는다. 그래서 등록 시점의 수(`targets`/`tests`)를 원장에 남기고,
 * 목록 조회 때 **현재 남아 있는 수**(`liveTargets`/`liveTests`)를 따로 붙여 보여준다
 * ('20개 등록'인데 롤백이 3개만 지운 이유가 이 두 숫자의 차이다).
 *
 * 삭제는 여기서 재구현하지 않는다 — `store.deleteTargetsByBatch()`(트랜잭션·expectedCount 검증)를
 * 그대로 호출한다. 필드 상한도 `store.LIMITS` 에서 파생한다(목록을 복사하면 어긋난다).
 *
 * 저장: `atomicWriteFileSync` + 로드 실패 시 `preserveCorrupt` 쌍(CLAUDE.md 불변조건).
 * 쓰기만 원자적이고 로드가 손상을 조용히 `[]` 로 넘기면 다음 저장이 온전했던 원본을 덮어쓴다.
 * **JSON 파싱 성공 ≠ 온전** 이므로 기대 형태(배열 또는 `{batches:[...]}`)가 아닌 파일도
 * 손상으로 취급해 백업한다(수동 편집·구버전/타 포맷·부분 rename).
 *
 * 신뢰 경계: `load()` 로 읽는 **파일은 신뢰**하고(우리가 쓴 값), `recordBatch()` 로 들어오는
 * **호출부 입력은 신뢰하지 않는다**. 롤백 흔적(`rolledBackAt`/`rolledBackBy`)은 `rollbackBatch`
 * 만 쓰는 값이므로 호출부 입력에서는 **버린다** — 받아들이면 하지도 않은 롤백을 남의 이름으로
 * 남기는 감사 위조 + 정상 배치의 롤백 영구 차단이 동시에 성립한다.
 *
 * 실패 정책(audit.js 와 같은 원칙):
 *  - `recordBatch`/`deleteBatchRecord` 는 **best-effort** — 원장 기록 실패가 등록을 막지 않는다.
 *    예외를 삼키고 콘솔 경고만 남기며, 레코드는 메모리에 남아 다음 저장에 함께 기록된다.
 *  - `rollbackBatch` 는 실제 삭제 작업이므로 실패를 **그대로 오류로 반환**한다(조용히 성공 처리 금지).
 *    대상 파일 저장이 실패하면(`saved:false`) 원장에 롤백 흔적을 **남기지 않는다** — 삭제가
 *    디스크에 없는데 '롤백 완료'가 확정되면, 재기동으로 대상이 되살아난 뒤 재롤백이 '이미
 *    롤백'으로 영구 거부돼 하나씩 손으로 지우는 수밖에 없어진다(부분 커밋).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { KINDS } from './testSchema.js';
import { LIMITS, deleteTargetsByBatch, batchCounts } from './store.js';

const FILE = () => path.join(config.configDir, 'svcmon-batches.json');

/** 원장 보관 건수 — 초과분은 **먼저 기록된 것부터** 버린다. */
export const MAX_BATCHES = 50;
/** 등록 경로 구분. 라우트가 목록을 복사하지 않게 여기서 내보낸다. */
export const SOURCES = ['import', 'generate', 'template'];

// 배치 ID 는 대상의 `batch` 태그와 **글자 단위로 같아야** 롤백이 맞는 범위를 지운다.
// store.cleanTarget 의 태그는 길이만 제한(40자)하므로 이쪽이 더 좁다 — 라우트 URL
// (`/batches/:id/rollback`)에 그대로 실리는 값이라 경로 구분자·질의 문자를 막는다.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,40}$/;

let cache = null;

const newId = () => 'b-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);

const text = (v, max, dflt = '') => (typeof v === 'string' ? v.trim().slice(0, max) : '') || dflt;
/** 개수 — 음수/문자는 0. 상한은 store.LIMITS 에서 받아 쓴다(여기서 재정의하지 않는다). */
const count = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;
};
/** 밀리초 타임스탬프 — 유효하지 않으면 0(=미설정). */
const ts = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * 필드 정규화기 **표** — 전체 레코드 생성과 부분 갱신이 같은 규칙을 쓰게 한 곳에만 둔다
 * (목록을 두 번 적으면 필드를 추가한 날 한쪽만 갱신된다). 값은 예외를 던지지 않고
 * 기본값으로 떨어진다(best-effort 경로에서 호출되므로).
 *
 * 롤백 흔적은 이 표에 **없다** — 파일 로드 경로만 채운다(위 '신뢰 경계' 참고).
 */
const NORM = {
  createdAt: (v) => ts(v) || Date.now(),
  createdBy: (v) => text(v, 120),
  // 목록 밖 출처는 'import' 로 바꾸지 않는다 — 감사 원장에 없던 출처를 'CSV' 로
  // 오라벨링하는 것이므로 '불명'('')으로 남긴다.
  source: (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    return SOURCES.includes(s) ? s : '';
  },
  // 한 번의 CSV 가져오기가 infra/service 를 섞을 수 있으므로 kind 는 **힌트**다(빈 값 허용).
  kind: (v) => (KINDS.includes(v) ? v : ''),
  path: (v) => text(v, 620),
  targets: (v) => count(v, LIMITS.maxTargets),
  tests: (v) => count(v, LIMITS.maxTotalTests),
  templateId: (v) => text(v, 40),
  note: (v) => text(v, 500),
};
const FIELD_KEYS = Object.keys(NORM);

/** 전체 레코드(모든 키를 기본값으로 채운다) — 신규 삽입·파일 로드 경로. */
function fullRecord(given, id) {
  const out = { id };
  for (const k of FIELD_KEYS) out[k] = NORM[k](given?.[k]);
  return out;
}

/**
 * 부분 패치 — **입력에 있는 키만** 정규화한다. 이 구분이 없으면 `{...기존, ...입력}` 은
 * 병합처럼 보이면서 실제로는 전 필드를 기본값으로 덮어쓴다(등록자·경로·등록 시각 소실).
 * 값이 `undefined` 인 키는 '주지 않은 것'으로 본다(`templateId: tplId` 처럼 호출부가
 * 미지정을 undefined 로 넘기는 흔한 패턴을 리셋으로 해석하지 않게).
 */
function patchOf(given) {
  const out = {};
  if (!given || typeof given !== 'object') return out;
  for (const k of FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(given, k)) continue;
    if (given[k] === undefined) continue;
    out[k] = NORM[k](given[k]);
  }
  return out;
}

/** 파일에서 읽은 레코드 1건 정규화. id 를 만들 수 없으면 null(=버린다). */
function fileRecord(raw) {
  // 파일의 id 는 우리가 쓴 값이다 — 형식이 어긋나도(수동 편집) **새로 발급하지 않는다**.
  // 새 id 를 주면 대상 태그와 연결이 끊긴 유령 행이 되고, 대상 쪽 태그는 문자 제약이
  // 더 넓어(store 는 길이만 제한) 사람이 읽는 태그도 실제로는 롤백에 쓸 수 있다.
  const id = text(raw?.id, 40);
  if (!id) return null;
  const out = fullRecord(raw, id);
  // 롤백 흔적은 있을 때만 키를 만든다(없는 키를 undefined 로 두면 저장 왕복에서 키 집합이 달라진다).
  if (ts(raw?.rolledBackAt)) {
    out.rolledBackAt = ts(raw.rolledBackAt);
    out.rolledBackBy = text(raw.rolledBackBy, 120);
  }
  return out;
}

/** 파일 내용에서 레코드 배열을 뽑는다. 기대 형태가 아니면 **null(=손상)**. */
function rowsOf(parsed) {
  // 배열/랩핑 객체 양쪽을 읽는다(파일 형식을 나중에 확장해도 기존 파일이 살아 있게).
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.batches)) return parsed.batches;
    // 빈 객체는 '내용 없음'으로 본다(잃을 데이터가 없어 백업이 소음이다).
    if (Object.keys(parsed).length === 0) return [];
  }
  return null;
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const rows = rowsOf(parsed);
    if (rows === null) {
      // JSON 파싱은 됐지만 원장이 아니다 — 조용히 [] 로 넘기면 다음 저장이 이 파일을
      // 통째로 덮어써 백업 없이 이력이 사라진다(파싱 실패 경로와 같게 보존한다).
      preserveCorrupt(FILE(), '원장 형식이 아닙니다(배열도 batches 배열도 아님)');
      cache = [];
      return cache;
    }
    // 객체가 아닌 원소(문자열·숫자·null)는 승격하지 않고 버린다 — 랜덤 id 의 빈 레코드로
    // 만들면 원장이 오염되고 상한(MAX_BATCHES)이 실제 이력을 밀어낸다.
    const list = [];
    let dropped = 0;
    for (const raw of rows) {
      const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? fileRecord(raw) : null;
      if (rec) list.push(rec);
      else dropped += 1;
    }
    if (dropped) console.warn(`[svcmon] 배치 원장에서 레코드가 아닌 항목 ${dropped}개를 버렸습니다.`);
    // 파일이 상한을 넘겨 커져 있어도 최근 것만 남긴다(수동 편집·구버전 대비).
    cache = list.slice(-MAX_BATCHES);
  } catch (e) {
    // 손상본을 조용히 [] 로 넘기면 다음 저장이 원본을 덮어써 이력이 영구 유실된다.
    if (e.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message);
    cache = [];
  }
  return cache;
}

/**
 * 저장 — 예외를 던지지 않고 성공 여부만 돌린다(호출부가 best-effort/오류 보고를 각자 선택).
 * @returns {boolean} 파일에 실제로 썼는지.
 */
function save() {
  try {
    atomicWriteFileSync(FILE(), JSON.stringify({ batches: cache || [] }, null, 2));
    return true;
  } catch (e) {
    console.warn('[svcmon] 배치 원장 저장 실패(등록/삭제 자체는 진행됨):', e?.message);
    return false;
  }
}

/** store 로드 실패가 목록 조회를 못 막게 — 수치만 비운다. */
function safeCounts() {
  try { return batchCounts(); } catch (e) {
    console.warn('[svcmon] 배치 현재 수 집계 실패:', e?.message);
    return new Map();
  }
}

/**
 * 배치 1건 기록(= '이 id 로 등록이 일어났다'). id 가 오면 그대로 쓰고(라우트가 대상에 붙인
 * 태그와 같아야 한다) 없으면 발급한다.
 *
 * 계약(같은 id 로 다시 기록하는 경우):
 *  - **입력에 있는 키만** 갱신한다(부분 병합). 주지 않은 `createdBy`/`path`/`source` 등은
 *    보존되고, `createdAt` 도 첫 등록 시각이 유지된다 — 재시도로 수량만 다시 기록해도
 *    감사 레코드가 파괴되지 않는다.
 *  - 이전 **롤백 흔적은 지운다**. 그 흔적은 '되돌리기 두 번 눌러 새 대상을 지우는 것'을
 *    막는 가드인데, 같은 id 로 등록이 다시 기록됐다면 그 대상들은 이번 등록분이므로
 *    되돌릴 수 있어야 한다(가드를 남기면 원장 행을 지우지 않는 한 영구 잠긴다).
 *  - 호출부가 넘긴 `rolledBackAt`/`rolledBackBy` 는 **무시**한다(감사 위조·롤백 봉인 차단).
 *
 * @returns {object|null} 저장된 레코드의 **사본**(저장 실패 시에도 레코드는 돌려준다).
 *   id 형식이 어긋나면 기록하지 않고 null — 새 id 를 발급하면 아무 대상도 가리키지 않는
 *   유령 행이 매 호출 쌓여 상한(MAX_BATCHES)이 실제 이력을 밀어낸다.
 */
export function recordBatch(rec = {}) {
  const given = rec && typeof rec === 'object' ? rec : {};
  const raw = typeof given.id === 'string' ? given.id.trim() : '';
  if (raw && !SAFE_ID.test(raw)) {
    console.warn('[svcmon] 배치 ID 형식이 올바르지 않아 원장에 기록하지 않습니다:', raw.slice(0, 60));
    return null;
  }
  const id = raw || newId();
  const patch = patchOf(given);
  // 저장(=파일/캐시) 경로가 실패해도 정규화된 레코드는 돌려준다.
  let out = fullRecord(given, id);
  try {
    const list = load();
    const i = list.findIndex((b) => b.id === id);
    if (i >= 0) {
      const next = { ...list[i], ...patch, id };
      delete next.rolledBackAt;
      delete next.rolledBackBy;
      list[i] = next;
    } else {
      list.push(out);
    }
    while (list.length > MAX_BATCHES) list.shift();   // 먼저 기록된 것부터
    save();
    // 캐시 내부 객체를 그대로 돌려주면 호출부의 응답 가공(`b.x = ...`)이 원장 파일까지
    // 바꾼다 — 신규/갱신 어느 경로에서도 사본을 돌린다(getBatch/listBatches 와 같은 규칙).
    const stored = list.find((b) => b.id === id);
    if (stored) out = { ...stored };
  } catch (e) {
    // 원장은 부가 정보다 — 기록 실패로 대량 등록을 실패로 만들지 않는다(audit.js 와 같은 원칙).
    console.warn('[svcmon] 배치 원장 기록 실패(등록은 계속):', e?.message);
  }
  return out;
}

/**
 * 원장 목록(**등록 시각 내림차순**). `opts.withCounts !== false` 면 현재 남아 있는 대상/점검 수를
 * `liveTargets`/`liveTests` 로 덧붙인다 — 등록 당시 수(`targets`/`tests`)와 나란히 보여야
 * 사용자가 '20개 등록'을 보고 롤백했을 때 3개만 지워진 이유를 알 수 있다.
 *
 * 삽입 순서 역순만으로는 화면의 '시각' 열과 순서가 어긋난다(수동 편집·구버전 파일·
 * createdAt 을 직접 주는 호출부). 정렬용 `order` 필드는 두지 않는다 — createdAt 이 이미
 * 진실의 원천이고, 별도 필드는 가져오기·복원 때만 어긋난다.
 */
export function listBatches(opts = {}) {
  const withCounts = opts?.withCounts !== false;
  const list = load();
  const counts = withCounts ? safeCounts() : null;
  const out = [];
  // 먼저 삽입 순서의 역순으로 담고 안정 정렬한다 → 같은 createdAt 은 최근에 기록된 것이 앞.
  for (let i = list.length - 1; i >= 0; i -= 1) out.push({ ...list[i] });
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (counts) {
    for (const b of out) {
      const c = counts.get(b.id) || { targets: 0, tests: 0 };
      b.liveTargets = c.targets;
      b.liveTests = c.tests;
    }
  }
  return out;
}

/** 원장 1건 조회(최신 사본). 없으면 null. */
export function getBatch(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const rec = load().find((b) => b.id === key);
  return rec ? { ...rec } : null;
}

/**
 * 배치 롤백 — 삭제는 `store.deleteTargetsByBatch` 가 한다(여기서 재구현하지 않는다).
 * 성공하면 원장 레코드에 `rolledBackAt`/`rolledBackBy` 를 남기고 **목록에는 유지**한다(감사 흔적).
 *
 * 원장에 없는 배치도 진행한다(대상의 `batch` 태그가 진실의 원천 — 원장 도입 전 배치·
 * 원장이 상한으로 밀려난 배치도 되돌릴 수 있어야 한다). 이때 `recorded:false` 로 알린다.
 *
 * @param {string} id 배치 ID
 * @param {{expectedCount?:number|null, user?:string}} opts
 * @returns {{removed:number, tests:number, saved?:boolean, recorded?:boolean,
 *            ledgerSaved?:boolean, error?:string}}
 *   saved=false 는 **대상 파일 저장 실패**다(이때 원장에는 흔적을 남기지 않고 error 도 함께 준다).
 *   ledgerSaved=false 는 삭제는 확정됐지만 원장 파일 쓰기가 실패한 경우다 — 재기동하면
 *   '이미 롤백' 가드가 사라지므로 운영자가 알아야 한다(요청 자체는 성공).
 */
export function rollbackBatch(id, opts = {}) {
  const { expectedCount = null, user = '' } = opts || {};
  const key = String(id || '').trim();
  if (!key) return { removed: 0, tests: 0, error: '배치 ID 가 필요합니다.' };
  try {
    const rec = load().find((b) => b.id === key) || null;
    if (rec?.rolledBackAt) {
      // 대상이 다시 등록돼 태그가 같은 경우까지 지우면 '되돌리기'가 남의 데이터를 지운다.
      return {
        removed: 0,
        tests: 0,
        error: `이미 롤백된 배치입니다(${new Date(rec.rolledBackAt).toISOString()}). 필요하면 새로 등록한 배치를 지우세요.`,
      };
    }
    const r = deleteTargetsByBatch(key, { expectedCount });
    if (r.error) return { removed: 0, tests: 0, error: r.error };
    if (r.saved === false) {
      // 삭제가 대상 파일에 남지 않았다. 여기서 원장에 '롤백 완료'를 찍으면 재기동 후
      // 대상은 되살아나는데 재롤백은 '이미 롤백'으로 영구 거부된다(거짓 감사 흔적 + 복구 불가).
      // 흔적을 남기지 않고 오류로 돌려, 원인(디스크·권한)을 고친 뒤 다시 시도하게 한다.
      return {
        removed: r.removed,
        tests: r.tests,
        saved: false,
        recorded: !!rec,
        error: '대상 삭제를 파일에 저장하지 못했습니다(디스크·권한 확인). 원장에 롤백 흔적을 남기지 않았으니 원인을 고친 뒤 다시 시도하세요.',
      };
    }
    let ledgerSaved = true;
    if (rec) {
      rec.rolledBackAt = Date.now();
      rec.rolledBackBy = text(user, 120);
      ledgerSaved = save();   // 실패해도 삭제는 이미 커밋됐다 — 되돌리지 않고 반환값으로 알린다
    }
    return { removed: r.removed, tests: r.tests, saved: true, recorded: !!rec, ledgerSaved };
  } catch (e) {
    // 롤백 실패는 삼키지 않는다 — 지웠다고 오해하면 사용자가 같은 배치를 두 번 넣는다.
    return { removed: 0, tests: 0, error: e?.message || '롤백에 실패했습니다.' };
  }
}

/** 원장에서만 지운다(등록된 대상은 그대로). @returns {boolean} 지웠는지. */
export function deleteBatchRecord(id) {
  const key = String(id || '').trim();
  if (!key) return false;
  try {
    const list = load();
    const i = list.findIndex((b) => b.id === key);
    if (i < 0) return false;
    list.splice(i, 1);
    save();
    return true;
  } catch (e) {
    console.warn('[svcmon] 배치 원장 삭제 실패:', e?.message);
    return false;
  }
}

export function _resetBatchCache() { cache = null; }
