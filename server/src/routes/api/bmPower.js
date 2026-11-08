/**
 * routes/api/bmPower.js — 리눅스 성능 8b단계 **전력 · 온도 집계** API(설계 PROFILES §20 ㉒ · 아트보드 Power).
 *
 *   GET /tools/bm-usage/power[?rack=<법인>|<랙>]   — 함대(법인 · 랙 · 미매핑) kW 지금/24h 평균/피크 · kWh · 월 누적 · 랙 상한 여유 · PowerCap 걸림 · 흡기 상위 · 팬 경고
 *                                                     (?rack 를 주면 그 랙의 서버 목록 — U 순)
 * 원천은 bmusage/powerAgg.js 머리말(전력 대시보드와 같은 allMeasuredPower · 시간 롤업 · 서버 분석 온도 원천 · 파트 장애 팬). 쓰기 경로 없음(랙 배치 · 기준값은 알림 규칙 설정 PUT —
 *   설정 소유자 등급).
 * 권한 · 범위: tools + 조회 범위 — **범위로 서버 기록을 먼저 거른 뒤** 합한다(범위 밖 서버가 합계 · 랙 · 피크에 섞이지 않게 · 귀속 없음은 범위 계정에 숨김) ·
 *   랙 배치도 보이는 법인 것만 · 비관리자에게는 서버 이름 중 주소(등록부 · IPv4)를 가린다 · 응답 캐시 memoJson 열쇠 = 범위 서명 + 관리자 판본 + 함대 계산 세대.
 * 요청 경로 비용: 함대 원천 모으기(서버마다 시간 롤업 조회)는 60초 공유(powerAgg.sharedPowerFleet — 진행 중이면 같은 프라미스) · 서버 사이 시간 기준 양보.
 * 다음 점검 ③: 엣지 위임 서버의 PowerCap 은 그 엣지 봉투의 powerCaps(중앙 정제본 — central/bmPowerCapSanitize.js)를 대상의 edgeCap 으로 넘겨 쓴다(보기 · 걸림 판정 모두).
 *   봉투에 표지가 없는 엣지(old-version)일 때만 응답에 capMinEdgeVersion(안내 문구용 — 게이트 아님)을 싣는다. 원천 묶음은 bmusage/powerSources.js(알림 판정과 하나).
 */
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { isAdminReq, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { strOf } from '../../util/coercionTrap.js';
import { memoJson, scopeKey } from './shared.js';
import { bmAddressHosts, perfAddressMatcher } from './bmUsage.js';
import { edgeCapIndex } from '../../central/bmPowerCapSanitize.js';

const toolsPerm = requirePerm('tools');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

export function depsOf(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    rules: async () => (await import('../../bmusage/perfRules.js')).loadPerfRules(),
    agg: async () => import('../../bmusage/powerAgg.js'),
    // 원천 묶음은 도메인 하나(bmusage/powerSources.js — 알림 판정도 같은 함수 · 화면은 엣지 사본까지).
    sources: async () => (await import('../../bmusage/powerSources.js')).powerSources({ now: Date.now() }),
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).powerCapMinEdgeVersion(),
    // 반증 n2 F4: 판정 노드 문맥(이 노드 이름 · 엣지 여부 · 중앙이면 법인 담당 엣지) — 알림 판정(powerAlerts)과 같은 함수.
    judgeCtx: async (edgeHas) => (await import('../../bmusage/powerJudge.js')).judgeContext({ edgeHas }),
    now: () => Date.now(),
    ...deps,
  };
}

/** 이 노드 + 엣지 보관분 대상(범위로 거르기 전 — 함대 계산은 범위와 무관하게 한 번 · 응답이 거른다). */
async function allTargets(D) {
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const out = (tg.targets || []).map((x) => ({ key: x.key, name: x.name, vcenterId: x.vcenterId || '', serviceTag: x.serviceTag || '', idrac: x.idrac ? { regId: x.idrac.regId } : null, paths: x.paths || [], node: config.agent?.name || '', via: 'local' }));
  const seen = new Set(out.map((x) => `${x.vcenterId}|${x.key}`));
  const edgeKeys = new Map();   // (법인|키) → 그 서버를 대상으로 가진 엣지(이 노드 대상과 겹쳐도 — 판정 노드 함수의 edgeHas · S1)
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) {
    const capOf = edgeCapIndex(rec?.snap);   // 다음 점검 ③ — 봉투 서버별 PowerCap(표지 없음 = old-version)
    for (const x of rec?.snap?.targets || []) {
      const id = `${t(x.vcenterId)}|${t(x.key)}`;
      if (t(x.key) && !edgeKeys.has(id)) edgeKeys.set(id, t(rec.agent));
      if (!t(x.key) || seen.has(id)) continue;
      seen.add(id);
      out.push({ key: t(x.key), name: t(x.name), vcenterId: t(x.vcenterId), serviceTag: t(x.serviceTag), idrac: null, paths: Array.isArray(x.paths) ? x.paths : [], node: rec.agent, via: 'edge', edgeCap: capOf(t(x.key)) });
    }
  }
  return { list: out, tg, edgeKeys };
}

/** GET /tools/bm-usage/power */
export async function bmPowerView(req, snap, deps = {}) {
  const D = depsOf(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const A = await D.agg();
  const rules = await D.rules().catch(() => ({}));
  const now = D.now();
  const { list, tg, edgeKeys } = await allTargets(D);
  // 세대 서명 — 엣지 상한(상태 · 값 · 시각)도 넣는다(봉투를 새로 당겨 상한이 바뀌면 60초 공유 계산을 다시 한다).
  let h = 2166136261; for (const x of list) { const s = `${x.vcenterId}|${x.key}|${x.via}|${x.edgeCap ? `${x.edgeCap.state}:${x.edgeCap.limitWatts ?? ''}:${x.edgeCap.at ?? ''}` : ''}`; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } }
  const genKey = `${Math.floor(now / 60_000)}|${list.length}|${h}`;
  const t0 = Date.now();
  const servers = await A.sharedPowerFleet(genKey, async () => A.gatherPower({ targets: list, deps: await D.sources(), now }), { now });
  const gatherMs = Date.now() - t0;
  // 반증 n2 F4: 서버마다 알림 판정 노드(판정 노드 함수 하나 — 알림 판정 입력과 같다). 판정 노드가 없으면 화면이 ‘알림 판정 없음 + 사유’.
  const J = await import('../../bmusage/powerJudge.js');
  const jctx = await D.judgeCtx((vc, key) => edgeKeys.get(`${vc}|${key}`) || '').catch(() => ({ self: config.agent?.name || '', isEdge: !!config.agent?.centralUrl }));
  const judged = servers.map((x) => ({ ...x, judge: J.judgeOf(x, jctx) }));
  // 범위 먼저(합하기 전) — 귀속 없음은 범위 계정에 숨김
  const vis = judged.filter((s) => !allowed || (s.vcenterId && allowed.has(s.vcenterId)));
  const racks = (rules.power?.racks || []).filter((r) => !allowed || allowed.has(r.vcenterId));
  const { racks: _all, ...pcfg } = rules.power || {};   // 랙 배치 원본(전 법인)은 응답에 싣지 않는다 — 보이는 법인 것만 racks 로
  const ag = A.aggregatePower(vis, { racks, cfg: pcfg });
  // 랙 판정 노드 — 배치 서버 전부가 같은 판정 노드일 때만(목록에 없는 배치 서버가 있으면 없음 — F1 과 같은 규칙).
  const byRack = new Map();
  for (const x of ag.all) { if (!x.rack) continue; const k = `${x.vcenterId}|${x.rack}`; if (!byRack.has(k)) byRack.set(k, []); byRack.get(k).push(x.judge); }
  const rackRows = ag.racks.map((r) => {
    if (r.unmapped) return r;
    const j = J.rackJudgeOf(byRack.get(`${r.vcenterId}|${r.rack}`) || [], r.notTarget || 0);
    return { ...r, judgeNode: j.node, judgeReason: j.reason };
  });
  // 판정 노드 없는 서버 · 랙 수(보이는 것만 — 사유별)
  const noJudge = { servers: 0, racks: 0, byReason: {} };
  for (const x of vis) if (x.judge && x.judge.node == null) { noJudge.servers += 1; noJudge.byReason[x.judge.reason] = (noJudge.byReason[x.judge.reason] || 0) + 1; }
  for (const r of rackRows) if (!r.unmapped && r.capKw != null && r.judgeNode == null) noJudge.racks += 1;
  let match = null;
  if (!isAdmin) ({ match } = await perfAddressMatcher(D, tg));
  const maskName = (nm) => (isAdmin ? nm : (match && match(nm) ? maskedIdToken(nm) : String(nm).replace(IPV4_RE, (ip) => maskedIdToken(ip))));
  const maskKey = (k) => (isAdmin ? k : (match && match(k) ? maskedIdToken(k) : k));
  const mask = (s) => ({ ...s, key: maskKey(s.key), name: maskName(s.name || s.key) });
  const rq = t(req.query?.rack);
  let rackServers = null;
  if (rq) {
    const i = rq.indexOf('|');
    const vc = i >= 0 ? rq.slice(0, i) : ''; const rk = i >= 0 ? rq.slice(i + 1) : '';
    // 반증 n2 F1: 목록에 없는 배치 서버는 수만(이름 · 키를 싣지 않는다).
    if (!allowed || allowed.has(vc)) rackServers = { vcenterId: vc, rack: rk, rows: ag.serversOf(vc, rk).map(mask), notTarget: rackRows.find((r) => r.vcenterId === vc && r.rack === rk)?.notTarget || 0 };
    else rackServers = { vcenterId: vc, rack: rk, rows: [] };
  }
  // 엣지 버전 안내는 보이는 서버 중 old-version 이 있을 때만(시한 · 못 읽음에 버전 요구를 붙여 이유를 단정하지 않는다 — 8b 반증 F8 규약).
  const oldEdge = vis.filter((s) => s.capState === 'old-version').length;
  const capMin = oldEdge ? await D.minEdgeVersion().catch(() => null) : null;
  return {
    ok: true, now, fleet: { ...ag.fleet, noJudge }, corps: ag.corps, racks: rackRows, bins: ag.bins, hot: ag.hot.map(mask), capHit: ag.capHit.map(mask), cfg: ag.cfg,
    ...(oldEdge ? { capOldEdge: oldEdge, ...(capMin ? { capMinEdgeVersion: capMin } : {}) } : {}),
    rackServers, racksConfigured: racks.length, gatherMs, ...(isAdmin ? {} : { addressHidden: true }),
    sources: { power: 'allMeasuredPower', temps: 'analysisServersWithRemote', fans: 'partfault', tempSeries: false },
  };
}

export function registerBmPower(api, deps = {}) {
  const key = async (req) => {
    let e = 0; try { for (const r of (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage()) e = Math.max(e, Number(r?.snapAt) || 0); } catch { e = 0; }
    let ra = 0; try { ra = Number((await import('../../bmusage/perfRules.js')).loadPerfRules().at) || 0; } catch { ra = 0; }
    return `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'u'}|m${Math.floor(Date.now() / 60_000)}|e${e}|r${ra}`;
  };
  api.get('/tools/bm-usage/power', toolsPerm, async (req, res) => memoJson(req, res, 'bm-power', (snap) => bmPowerView(req, snap, deps), { ttlMs: 30_000, extraKey: await key(req) }));
}
