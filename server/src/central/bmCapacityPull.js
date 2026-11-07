/**
 * central/bmCapacityPull.js — 8a단계 **용량 소진 예측 서버 상세의 엣지 대행**(GET /api/collector/bm-usage/capacity?key=) 당김 · 정제.
 *
 *   · 같은 url · 같은 토큰(pullFromEdge — 새 포트 · 새 인증 없음) · GET 재시도 1 · 보관 없음(볼 때 당긴다 — 중앙은 엣지 이력을 복제 적재하지 않는다).
 *   · ⚠⚠ 6단계 반증 F2: pullFromEdge 의 기본 본문 판정은 봉투(`{ok, node}`)라 이 응답(node 없음)에 **bodyOk 를 명시**한다 —
 *     회귀 bmCapacity8aRoute.test.js(실제 collector 라우터 ↔ 실제 이 함수 성공 왕복).
 *   · 정제: 자원 행은 봉투와 같은 화이트리스트(sanitizeCapacityEnvelope — 키는 요청한 그 서버만) · 계열은 자원 32 × 일 120 · 날짜 꼴 · 수만 · 맞춤선 수만.
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 8a단계 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 */
import { pullFromEdge } from './edgePull.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { stage8aMinEdgeVersion } from './featureMinEdgeVersion.js';
import { sanitizeCapacityEnvelope } from './bmMaintCapSanitize.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const N = numOrNull;
const TIMEOUT_MS = reqTimeoutMs(process.env.BMUSAGE_PULL_TIMEOUT_MS, 20_000, { min: 5_000 });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SER_KEY_RE = /^(?:fs|inode):[^\u0000-\u001f\u007f]{1,256}$|^mem$/;

/** 응답 모양(순수) — 상세 본문(ok · key · rows 배열). 봉투 모양({ok, node})이 아니다. */
export const capacityBodyOk = (b) => isObj(b) && b.ok === true && typeof b.key === 'string' && Array.isArray(b.rows);

/** 상세 본문 정제(순수) — key 는 요청한 서버 키만 받는다. */
export function sanitizeCapacityDetail(b, key, now = Date.now()) {
  if (!capacityBodyOk(b)) return null;
  const rows = sanitizeCapacityEnvelope({ rows: b.rows, at: now }, { targetKeys: new Set([key]), now }).rows;
  const series = {};
  if (isObj(b.series)) {
    for (const [k, list] of Object.entries(b.series).slice(0, 65)) {
      if (!SER_KEY_RE.test(k) || !Array.isArray(list)) continue;
      series[capStr(k, 270)] = list.slice(0, 120).filter((d) => isObj(d) && DAY_RE.test(String(d.day))).map((d) => ({ day: String(d.day), v: N(d.v), ex: d.ex === true }));
    }
  }
  const fits = {};
  if (isObj(b.fits)) for (const [k, f] of Object.entries(b.fits).slice(0, 65)) if (SER_KEY_RE.test(k) && isObj(f) && DAY_RE.test(String(f.fromDay))) fits[capStr(k, 270)] = { slope: N(f.slope), intercept: N(f.intercept), fromDay: String(f.fromDay) };
  return { ok: true, key, rows, series, fits, excludedDays: (Array.isArray(b.excludedDays) ? b.excludedDays : []).filter((d) => DAY_RE.test(String(d))).slice(0, 90), today: DAY_RE.test(String(b.today)) ? String(b.today) : null };
}

/** 엣지 한 서버의 상세를 당긴다. @returns {{ok:boolean, body?:object, kind?:string, reason?:string}} */
export async function pullEdgeCapacity(agent, key, { fetchImpl } = {}) {
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/capacity?key=${encodeURIComponent(key)}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: stage8aMinEdgeVersion(), what: '용량 예측을 읽을', label: '엣지 용량 예측 응답',
    bodyOk: capacityBodyOk, missing401: true, ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason };
  const body = sanitizeCapacityDetail(r.body, key);
  return body ? { ok: true, body } : { ok: false, kind: 'bad-body', reason: '응답 형식이 다릅니다.' };
}
