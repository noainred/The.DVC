/**
 * routes/api/bmTop.js — 리눅스 성능 8b단계 **프로세스 Top-N** API(설계 PROFILES §20 ⑳ · 아트보드 TopProc).
 *
 *   GET /tools/bm-usage/perf/:key/top?ts=           — ‘이 시점 프로세스’(가까운 표본 · CPU · 메모리 · I/O 상위 5 · 지속 · PID 재사용 · 앞뒤 표본)
 *   GET /tools/bm-usage/perf/:key/top/band?from=&to= — 시간 × 프로세스 띠(창 ≤ 26시간 = 5분 표본 · 넘으면 comm 별 시간 집계)
 * 이 노드 서버는 이 노드 파일(topStore) · 엣지 서버는 엣지 대행(central/bmTopPull.js — bodyOk 명시 · 정제).
 *
 * 권한 · 범위(형제 라우트와 같다 — security-api.md): tools + vCenter scope — 해석은 resolvePerfTarget 하나(범위 밖 · 귀속 없음 · 없는 키 404 · 비관리자는 주소인 key 를
 *   가림 토큰으로도 찾는다) · 쓰기 경로 없음(읽기 전용 — kill 등 조작 없음) · 응답 캐시 memoJson 열쇠 = 범위 서명 + 관리자 판본 여부 + 이 노드 적재 세대 + 엣지 보관분 세대.
 * ⚠⚠ 누가 무엇을 보나 — 관리자 판본 판정은 `isAdminReq`(= auth/demoGuest.js isAdminDetailUser) 하나:
 *   · 관리자: 프로세스 **사용자 이름 원문**.
 *   · 그 밖(operator · viewer · 데모): 사용자 이름은 가림 토큰(같은 값은 같은 토큰 — 반복은 보인다). comm 은 그대로 두되 주소 꼴(등록부 · IPv4)은 가림.
 *   근거: OS 계정 이름은 7a 로그 분석의 계정과 같은 등급(공격 표면 정보 — 어떤 계정이 서버에 있고 무엇을 돌리는가)이라 같은 판정으로 관리자에게만 원문을 준다.
 *   comm 은 이 기능의 본문(무엇이 CPU 를 먹었나)이라 가리면 기능이 없어진다 — 대신 인자 · 환경은 수집 단계에서 아예 읽지 않는다(16차 보안 설계).
 */
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { isAdminReq, maskedIdToken, scrubberFor } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { loadBmUsageSettings } from '../../bmusage/settings.js';
import { memoJson } from './shared.js';
import { strOf } from '../../util/coercionTrap.js';
import { resolvePerfTarget, bmAddressHosts, perfAddressMatcher, noStoreFail, perfKey } from './bmUsage.js';
import { procHint } from '../../bmusage/parse/linuxTop.js';

const toolsPerm = requirePerm('tools');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const NOT_FOUND = Object.freeze({ __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' });
const KINDS = ['cpu', 'mem', 'io'];

export function depsOf(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    topAt: async (o) => (await import('../../bmusage/topStore.js')).topAt(o),
    topBand: async (o) => (await import('../../bmusage/topStore.js')).topBand(o),
    pullTop: async (agent, key, o) => (await import('../../central/bmTopPull.js')).pullEdgeTop(agent, key, o),
    pullBand: async (agent, key, o) => (await import('../../central/bmTopPull.js')).pullEdgeTopBand(agent, key, o),
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).stage8bMinEdgeVersion(),
    intervalMs: () => Number(loadBmUsageSettings().intervalMs) || 300_000,
    ...deps,
  };
}

/**
 * 비관리자 판본(순수) — 사용자 이름 = 가림 토큰 · comm 의 주소 꼴 = 가림.
 *   ⚠ 8b 반증 F7: 프로파일 단서(hint)도 **가린 사용자로 다시 계산**한다 — ‘gpdb’ 는 계정 gpadmin 에서 나온 단서라, 원래 단서를 두면 그 행의 가림 토큰 = gpadmin 이
 *   알려지고(같은 값 = 같은 토큰) 같은 응답 · 다른 서버의 같은 토큰도 풀린다. 사용자와 무관한 단서(airflow · kswapd · sshd · kernel)는 comm 만으로 같은 값이 나온다.
 */
export function maskTopRows(rows, scrub = (s) => s) {
  const tok = (v) => (v ? maskedIdToken(String(v)) : v);
  const clean = (s) => (typeof s === 'string' ? scrub(s).replace(IPV4_RE, (ip) => maskedIdToken(ip)) : s);
  const out = {};
  for (const k of KINDS) out[k] = (rows?.[k] || []).map((r) => { const comm = clean(r.comm); return { ...r, user: tok(r.user), comm, hint: procHint({ comm, user: null }) }; });
  return out;
}
export function maskBand(body, scrub = (s) => s) {
  const clean = (s) => (typeof s === 'string' ? scrub(s).replace(IPV4_RE, (ip) => maskedIdToken(ip)) : s);
  const map = new Map((body?.comms || []).map((c) => [c, clean(c)]));
  return { ...body, comms: (body?.comms || []).map((c) => map.get(c)), points: (body?.points || []).map((p) => ({ ...p, by: Object.fromEntries(Object.entries(p.by || {}).map(([c, v]) => [map.get(c) ?? clean(c), v])) })) };
}

/** 8b 반증 F8: 최소 엣지 버전 안내는 **구버전 엣지(old-version)** 일 때만 — 시한 · 연결 실패 · 대상 아님(disabled)에 버전 요구를 붙여 이유를 단정하지 않는다. */
async function edgeVersionNote(r, D) {
  if (r?.kind !== 'old-version') return {};
  const v = await D.minEdgeVersion().catch(() => null);
  return v ? { minEdgeVersion: v } : {};
}

async function resolve(req, D) {
  const allowed = scopedVcenterIds(req.user, store.get());
  const key = t(req.params?.key);
  const f = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key });
  return { f, key };
}
async function scrubOf(req, D) {
  if (isAdminReq(req)) return null;
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const { hosts } = await perfAddressMatcher(D, tg);
  return scrubberFor(hosts);
}

/** GET /tools/bm-usage/perf/:key/top */
export async function bmTopPoint(req, _snap, deps = {}) {
  const D = depsOf(deps);
  const { f, key } = await resolve(req, D);
  if (!f || f.denied) return NOT_FOUND;
  const ts = Number(req.query?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return { __status: 400, ok: false, reason: 'ts(표본 시각 ms)가 필요합니다.' };
  let body;
  if (f.via === 'edge') {
    const r = await D.pullTop(f.agent, f.realKey, { ts });
    if (!r.ok) return { ok: false, key, via: 'edge', agent: f.agent, kind: r.kind || 'error', reason: r.reason || '엣지에서 프로세스 표를 읽지 못했습니다.', ...(await edgeVersionNote(r, D)) };
    body = { ...r.body, via: 'edge', agent: f.agent };
  } else {
    const r = await D.topAt({ agent: f.agent, key: f.realKey, ts, toleranceMs: D.intervalMs() * 1.5 });
    body = { ...r, via: 'local', agent: f.agent };
  }
  const scrub = await scrubOf(req, D);
  return { ...body, key, ...(scrub ? { rows: maskTopRows(body.rows, scrub), userHidden: true } : {}) };
}

/** GET /tools/bm-usage/perf/:key/top/band */
export async function bmTopBandView(req, _snap, deps = {}) {
  const D = depsOf(deps);
  const { f, key } = await resolve(req, D);
  if (!f || f.denied) return NOT_FOUND;
  const from = Number(req.query?.from); const to = Number(req.query?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { __status: 400, ok: false, reason: 'from < to(ms)가 필요합니다.' };
  let body;
  if (f.via === 'edge') {
    const r = await D.pullBand(f.agent, f.realKey, { from, to });
    if (!r.ok) return { ok: false, key, via: 'edge', agent: f.agent, kind: r.kind || 'error', reason: r.reason || '엣지에서 프로세스 띠를 읽지 못했습니다.', ...(await edgeVersionNote(r, D)) };
    body = { ...r.body, via: 'edge', agent: f.agent };
  } else {
    const r = await D.topBand({ agent: f.agent, key: f.realKey, from, to });
    if (!r.ok) return { __status: 400, ...r };
    body = { ...r, via: 'local', agent: f.agent };
  }
  const scrub = await scrubOf(req, D);
  return { ...(scrub ? maskBand(body, scrub) : body), key };
}

export function registerBmTop(api, deps = {}) {
  api.get('/tools/bm-usage/perf/:key/top', toolsPerm, async (req, res) => memoJson(req, res, 'bm-top', async (snap) => noStoreFail(await bmTopPoint(req, snap, deps)), { extraKey: `${await perfKey(req)}|n${config.agent?.name || ''}` }));
  api.get('/tools/bm-usage/perf/:key/top/band', toolsPerm, async (req, res) => memoJson(req, res, 'bm-top-band', async (snap) => noStoreFail(await bmTopBandView(req, snap, deps)), { extraKey: `${await perfKey(req)}|n${config.agent?.name || ''}` }));
}
