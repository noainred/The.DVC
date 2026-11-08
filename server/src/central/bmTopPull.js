/**
 * central/bmTopPull.js — 리눅스 성능 8b단계 **프로세스 Top-N 의 엣지 대행**(GET /api/collector/bm-usage/top?key=&ts= · /bm-usage/top/band?key=&from=&to=) 당김 · 정제.
 *
 *   · 같은 url · 같은 토큰(pullFromEdge — 새 포트 · 새 인증 없음) · GET 재시도 1 · 보관 없음(볼 때 당긴다 — 프로세스 표는 법인 밖에 쌓지 않는다).
 *   · ⚠⚠ 6단계 반증 F2: pullFromEdge 의 기본 본문 판정은 봉투(`{ok, node}`)라 이 응답(node 없음)에 **bodyOk 를 명시**한다 — 회귀 bmTop8bRoute.test.js(실제 collector 라우터 ↔ 실제 이 함수 성공 왕복).
 *   · 정제(edge.md ‘엣지가 보낸 것은 정제한다’): 아는 필드만 · 객체만 · 상한(종류 3 × 5행 · 띠 점 2,000 · comm 6) · 문자열 수치는 수로(numOrNull — 못 읽으면 null) ·
 *     **comm · 사용자는 엣지 문자열이다** — 길이를 먼저 자르고 제어 · 양방향 · 폭 없는 문자 제거(cleanComm · cleanUser — 선형) · 상태는 한 글자 ·
 *     프로파일 단서(hint)는 엣지 값을 쓰지 않고 중앙이 다시 붙인다(procHint) · 엣지 시각은 수신 시각으로 자른다(clampEdgeTs).
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 8b단계 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 */
import { pullFromEdge } from './edgePull.js';
import { numOrNull } from '../util/numOrNull.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { stage8bMinEdgeVersion } from './featureMinEdgeVersion.js';
import { cleanComm, cleanUser, procHint, TOP_KEEP } from '../bmusage/parse/linuxTop.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const N = numOrNull;
const TIMEOUT_MS = reqTimeoutMs(process.env.BMUSAGE_PULL_TIMEOUT_MS, 20_000, { min: 5_000 });
const KINDS = ['cpu', 'mem', 'io'];
const SRC = new Set(['top', 'proc']);
const RES = new Set(['5m', '1h']);
const STATE_RE = /^[A-Za-z]$/;
const bool = (v) => v === true;

/** 응답 모양(순수) — 점 본문(ok · key · rows 객체) · 띠 본문(ok · key · points 배열). 봉투 모양({ok, node})이 아니다. */
export const topPointBodyOk = (b) => isObj(b) && b.ok === true && typeof b.key === 'string' && isObj(b.rows);
export const topBandBodyOk = (b) => isObj(b) && b.ok === true && typeof b.key === 'string' && Array.isArray(b.points);

/** 프로세스 행 하나(순수) — 같은 함수가 중앙 로컬 응답에도 쓰이지 않는다(로컬은 topStore 가 정제한 값). */
export function sanitizeProcRow(r, now = Date.now()) {
  if (!isObj(r)) return null;
  const pid = N(r.pid);
  if (pid == null || !Number.isInteger(pid) || pid < 0 || pid > 4_194_304) return null;
  const comm = cleanComm(typeof r.comm === 'string' ? r.comm : '') || null;
  const user = cleanUser(typeof r.user === 'string' ? r.user : null);
  return {
    rank: Math.max(1, Math.min(TOP_KEEP, Math.round(N(r.rank) ?? 1))), pid, start: N(r.start), startAt: clampEdgeTs(N(r.startAt), now),
    user, comm, val: N(r.val), rss: N(r.rss), state: typeof r.state === 'string' && STATE_RE.test(r.state) ? r.state : null,
    cpuS: N(r.cpuS), rd: N(r.rd), wr: N(r.wr), ioPerm: bool(r.ioPerm), hint: procHint({ comm, user }),
    ...(r.cont === true || r.cont === false ? { cont: r.cont } : {}), ...(r.pidReused === true ? { pidReused: true } : {}),
  };
}
/** 점 본문 정제(순수) — key 는 요청한 서버 키만. */
export function sanitizeTopPoint(b, key, now = Date.now()) {
  if (!topPointBodyOk(b)) return null;
  const rows = {};
  for (const k of KINDS) rows[k] = (Array.isArray(b.rows[k]) ? b.rows[k] : []).slice(0, TOP_KEEP).map((r) => sanitizeProcRow(r, now)).filter(Boolean);
  const s = isObj(b.sample) ? b.sample : null;
  const sample = s ? {
    ts: clampEdgeTs(N(s.ts), now), baseTs: clampEdgeTs(N(s.baseTs), now), same: bool(s.same), src: SRC.has(s.src) ? s.src : null,
    nproc: N(s.nproc), nrun: N(s.nrun), nd: N(s.nd), cpuTotal: N(s.cpuTotal), dtS: N(s.dtS), upS: N(s.upS), cands: N(s.cands), ioPerm: N(s.ioPerm), ioUnknown: N(s.ioUnknown), boot: N(s.boot),
  } : null;
  return { ok: true, key, sample, rows, prevTs: clampEdgeTs(N(b.prevTs), now), nextTs: clampEdgeTs(N(b.nextTs), now), ...(b.reason === 'no-sample' ? { reason: 'no-sample' } : {}) };
}
/** 띠 본문 정제(순수). */
export function sanitizeTopBand(b, key, now = Date.now()) {
  if (!topBandBodyOk(b)) return null;
  const comms = (Array.isArray(b.comms) ? b.comms : []).slice(0, 6).map((c) => cleanComm(typeof c === 'string' ? c : '')).filter(Boolean);
  const keep = new Set(comms);
  const points = b.points.slice(0, 2_000).filter(isObj).map((p) => {
    const by = {};
    if (isObj(p.by)) for (const [c0, v] of Object.entries(p.by).slice(0, 8)) { const c = cleanComm(c0); if (c && keep.has(c) && N(v) != null) by[c] = N(v); }
    return { t: clampEdgeTs(N(p.t), now), total: N(p.total), by, other: N(p.other) };
  }).filter((p) => p.t != null);
  return { ok: true, key, res: RES.has(b.res) ? b.res : '5m', from: N(b.from), to: N(b.to), comms, points, approx: N(b.approx) ?? 0, ...(b.clipped === true ? { clipped: true } : {}) };
}

async function pull(agent, path, bodyOk, label) {
  return pullFromEdge(agent, path, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: stage8bMinEdgeVersion(), what: '프로세스 Top-N 을 읽을', label, bodyOk, missing401: true,
  });
}
/** 엣지 한 서버의 ‘이 시점 프로세스’. @returns {{ok:boolean, body?:object, kind?:string, reason?:string}} */
export async function pullEdgeTop(agent, key, { ts } = {}) {
  const q = `/api/collector/bm-usage/top?key=${encodeURIComponent(key)}&ts=${encodeURIComponent(String(Math.round(Number(ts) || 0)))}`;
  const r = await pull(agent, q, topPointBodyOk, '엣지 프로세스 응답');
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason };
  const body = sanitizeTopPoint(r.body, key);
  return body ? { ok: true, body } : { ok: false, kind: 'bad-body', reason: '응답 형식이 다릅니다.' };
}
/** 엣지 한 서버의 시간 × 프로세스 띠. */
export async function pullEdgeTopBand(agent, key, { from, to } = {}) {
  const q = `/api/collector/bm-usage/top/band?key=${encodeURIComponent(key)}&from=${encodeURIComponent(String(Math.round(Number(from) || 0)))}&to=${encodeURIComponent(String(Math.round(Number(to) || 0)))}`;
  const r = await pull(agent, q, topBandBodyOk, '엣지 프로세스 띠 응답');
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason };
  const body = sanitizeTopBand(r.body, key);
  return body ? { ok: true, body } : { ok: false, kind: 'bad-body', reason: '응답 형식이 다릅니다.' };
}
