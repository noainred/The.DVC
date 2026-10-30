/**
 * bareos/groupRetention.js — 백업 그룹 '보관 개수'(v2.831 · 사용자 요청 '백업을 몇 개 저장할 것인지 지정') 판정(순수).
 *
 * Bareos 에는 '잡마다 N개만 남김' 설정이 없다(보존은 풀·클라이언트의 기간 단위). 그래서 포탈이 그룹 실행이 끝난 뒤
 * VM 마다 최근 N개의 **성공한 백업**(복원 지점)을 남기고, 그보다 오래된 실행을 카탈로그에서 지운다(`delete jobid=`).
 *
 * 되돌리면 안 되는 규칙(데이터 삭제 — 시험 bareosGroupRetention2831 이 고정):
 *  ① 체인을 끊지 않는다 — 남기는 가장 오래된 복원 지점이 Incremental·Differential 이면 그 앞의 **성공한 Full** 까지 남긴다.
 *     그런 Full 이 없으면(카탈로그에 없음·못 읽음) **아무것도 지우지 않는다**(무엇이 기준인지 모르면 지우지 않는다).
 *  ② 끝나지 않은 실행(대기·실행 중)은 지우지 않는다. 이 잡 이름의 백업(type B)만 본다 — 복원·복사·이전 행은 건드리지 않는다.
 *  ③ 성공한 복원 지점이 N개 이하면 아무것도 지우지 않는다. 지우는 것은 기준 Full **보다 앞의** 끝난 실행만이다.
 *  ④ 순서는 jobid(카탈로그가 만든 순서 — 시작 시각은 못 읽을 수 있다). 한 번에 지우는 수에 상한(PRUNE_MAX_PER_JOB).
 *  ⑤ 보관 개수가 없으면(null — v2.830 에 만든 그룹·'제한 없음') 정리하지 않는다.
 *  ⑥~⑧ 반증 검토(F1·F2·F3·F6): 복사·이전 행이 있거나 · jobid 와 시작 시각 순서가 어긋나거나 · 시작 시각을 모르면 지우지 않는다 · 기준 Full 은 바이트가 있는 것만.
 *  정리는 **그룹 실행이 끝난 뒤에만**(보관 개수를 바꾸기만 해서는 돌지 않는다 — 반증 F5 · 화면 안내와 같게).
 * 카탈로그를 지워도 볼륨의 데이터는 그 볼륨이 재활용될 때 비워진다(Bareos 풀 설정 — 화면이 밝힌다).
 */
import { isFinalStatus, statusOf } from './names.js';

export const KEEP_MIN = 1;
export const KEEP_MAX = 365;
/** 화면의 빠른 선택(시안 — 3·7·14·30). */
export const KEEP_PRESETS = Object.freeze([3, 7, 14, 30]);
export const PRUNE_MAX_PER_JOB = 200;
/** 그룹 실행 뒤 이만큼 지나도 끝나지 않은 VM 이 있으면 정리를 그대로 한다(끝나지 않은 실행은 어차피 지우지 않는다 — 실행이 사라진 잡이 정리를 영원히 막지 않게). */
export const PRUNE_WAIT_MAX_MS = 12 * 3_600_000;

const LEVELS = new Set(['F', 'I', 'D']);

/**
 * 보관 개수 입력 → null(제한 없음) 또는 정수. 틀린 값은 던진다(조용히 다른 값으로 바꾸지 않는다).
 * @param {unknown} v  null·undefined·'' = 제한 없음
 */
export function normKeep(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < KEEP_MIN || n > KEEP_MAX) throw Object.assign(new Error(`보관 개수는 ${KEEP_MIN}~${KEEP_MAX} 사이의 정수입니다(비우면 제한 없음).`), { code: 'invalid' });
  return n;
}

/**
 * 한 잡의 실행 행(director.normalizeJobRow) → 지울 jobid.
 * @param {object[]} runs  `list jobs job=<name>` 행(순서 무관)
 * @param {number|null} keep
 * @param {string} name   이 잡 이름 — 다른 이름의 행은 보지 않는다
 * @returns {{ deletable: number[], kept: number, good: number, baseJobid: number|null, baseAt: number|null, reason: string }}
 *   kept = 남는 성공 복원 지점 수(기준 Full 부터) · good = 지금 성공 복원 지점 수 · reason = 지우지 않은 까닭(비면 지움 또는 지울 것 없음)
 */
export function pruneSelection(runs, keep, name) {
  const mine = (Array.isArray(runs) ? runs : []).filter((r) => r && Number.isInteger(r.jobid) && r.jobid > 0 && (!name || r.name === name));
  const rows = mine.filter((r) => r.type === 'B').sort((a, b) => a.jobid - b.jobid);
  const isGood = (r) => { const st = statusOf(r.status); return (st === 'ok' || st === 'warning') && LEVELS.has(r.level); };
  const good = rows.filter(isGood);
  const none = (reason, extra = {}) => ({ deletable: [], kept: good.length, good: good.length, baseJobid: null, baseAt: null, reason, ...extra });
  if (keep == null) return none('보관 개수 제한 없음');
  if (!Number.isInteger(keep) || keep < KEEP_MIN) return none('보관 개수가 올바르지 않음');
  if (good.length <= keep) return none('');
  // ⑥ v2.831 반증 F3: 같은 잡 이름의 복사(C)·이전(M) 등 백업이 아닌 행이 있으면 지우지 않는다 — delete 가 사본을 B 로 올리거나(UpgradeCopies) 순서를 뒤집는다(추정)
  if (mine.some((r) => r.type !== 'B')) return none('이 잡에 복사·이전(Copy·Migration) 실행 기록이 있어 지우지 않았습니다(순서를 확신할 수 없음).');
  // ⑦ v2.831 반증 F1·F2: 복원 체인(restore.chainFromHistory)은 시작 시각 순이다 — 성공 행의 jobid 순서와 시작 시각 순서가 다르거나(Migration·VirtualFull 추정)
  //   시작 시각을 못 읽은 성공 행이 있으면 지우지 않는다(두 순서가 같을 때만 jobid 로 자른다)
  if (good.some((r) => !Number.isFinite(r.startedAt))) return none('시작 시각을 읽지 못한 백업이 있어 지우지 않았습니다.');
  for (let i = 1; i < good.length; i++) if (good[i].startedAt < good[i - 1].startedAt) return none('jobid 순서와 시작 시각 순서가 어긋나 지우지 않았습니다(Migration·VirtualFull 행 추정 — 체인을 확신할 수 없음).');
  // ⑧ v2.831 반증 F6: 기준 Full 은 바이트가 있는 것만(0 B·모름인 Full 을 기준으로 앞의 실제 체인을 지우지 않게)
  const isBase = (r) => r.level === 'F' && typeof r.bytes === 'number' && r.bytes > 0;
  let base = null;
  // 남기는 가장 오래된 복원 지점(good[length-keep]) 또는 그 앞의 가장 가까운 성공 Full
  for (let i = good.length - keep; i >= 0; i--) if (isBase(good[i])) { base = good[i]; break; }
  if (!base) return none('남기는 백업의 기준 Full 을 카탈로그에서 찾지 못해 지우지 않았습니다(체인을 끊지 않게).');
  const deletable = rows.filter((r) => r.jobid < base.jobid && isFinalStatus(r.status)).map((r) => r.jobid);
  const kept = good.filter((r) => r.jobid >= base.jobid).length;
  const out = { deletable: deletable.slice(0, PRUNE_MAX_PER_JOB), kept, good: good.length, baseJobid: base.jobid, baseAt: base.startedAt, reason: '' };
  if (deletable.length > PRUNE_MAX_PER_JOB) out.more = deletable.length - PRUNE_MAX_PER_JOB;
  return out;
}

/** 보관 개수 문구 — 서버·웹이 같은 글자(웹 bareosGroupText.keepText 와 시험이 대조). */
export function keepText(keep) {
  return keep == null ? '보관 개수 제한 없음' : `최근 ${keep}회 보관`;
}
