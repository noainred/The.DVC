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

const toolsPerm = requirePerm('tools');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const INV_FRESH_MS = 2 * 3_600_000;

export function depsOf(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    rules: async () => (await import('../../bmusage/perfRules.js')).loadPerfRules(),
    agg: async () => import('../../bmusage/powerAgg.js'),
    sources: async () => {
      const [svc, ana, inv, ss, rt, pf, idb] = await Promise.all([import('../../idrac/service.js'), import('../../insights/analysisServers.js'), import('../../idrac/invCache.js'),
        import('../../idrac/sensorStore.js'), import('../../idrac/roomTemp.js'), import('../../partfault/db.js'), import('../../idrac/db.js')]);
      const now = Date.now();
      return {
        measured: () => svc.allMeasuredPower({ hosts: [] }),
        analysisServers: async () => ana.analysisServersWithRemote(),
        fanFaults: async () => (pf.partFaultDbExists() ? (await pf.openFaults({ scope: 'idrac' })).filter((f) => f.kind === 'fan') : null),
        powerDb: () => idb.getDb(),
        inventoryOf: (a, regId) => {
          const x = a?.remote ? (a.inv || null) : inv.getInventory(String(a?.id || regId || ''));
          if (!x) return null;
          if (!a?.remote && !(Number(x.collectedAt) && now - Number(x.collectedAt) <= INV_FRESH_MS)) return null;   // 낡은 인벤토리는 ‘지금 사실’ 이 아니다(hwFacts 와 같은 판단)
          return x;
        },
        sensorLatest: (id) => ss.getSensorSeries(id, { minutes: 0 }).latest || null,
        temps: { classify: rt.classifySensor, maxAgeOf: (latest, remote) => rt.sampleMaxAgeMs(rt.DEFAULT_MAX_AGE_MS, latest, { remote, localCycle: ss.sensorPollCycle(now) }) },
      };
    },
    now: () => Date.now(),
    ...deps,
  };
}

/** 이 노드 + 엣지 보관분 대상(범위로 거르기 전 — 함대 계산은 범위와 무관하게 한 번 · 응답이 거른다). */
async function allTargets(D) {
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const out = (tg.targets || []).map((x) => ({ key: x.key, name: x.name, vcenterId: x.vcenterId || '', serviceTag: x.serviceTag || '', idrac: x.idrac ? { regId: x.idrac.regId } : null, paths: x.paths || [], node: config.agent?.name || '', via: 'local' }));
  const seen = new Set(out.map((x) => `${x.vcenterId}|${x.key}`));
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) {
    for (const x of rec?.snap?.targets || []) {
      const id = `${t(x.vcenterId)}|${t(x.key)}`;
      if (!t(x.key) || seen.has(id)) continue;
      seen.add(id);
      out.push({ key: t(x.key), name: t(x.name), vcenterId: t(x.vcenterId), serviceTag: t(x.serviceTag), idrac: null, paths: Array.isArray(x.paths) ? x.paths : [], node: rec.agent, via: 'edge' });
    }
  }
  return { list: out, tg };
}

/** GET /tools/bm-usage/power */
export async function bmPowerView(req, snap, deps = {}) {
  const D = depsOf(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const A = await D.agg();
  const rules = await D.rules().catch(() => ({}));
  const now = D.now();
  const { list, tg } = await allTargets(D);
  let h = 2166136261; for (const x of list) { const s = `${x.vcenterId}|${x.key}|${x.via}`; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } }
  const genKey = `${Math.floor(now / 60_000)}|${list.length}|${h}`;
  const t0 = Date.now();
  const servers = await A.sharedPowerFleet(genKey, async () => A.gatherPower({ targets: list, deps: await D.sources(), now }), { now });
  const gatherMs = Date.now() - t0;
  // 범위 먼저(합하기 전) — 귀속 없음은 범위 계정에 숨김
  const vis = servers.filter((s) => !allowed || (s.vcenterId && allowed.has(s.vcenterId)));
  const racks = (rules.power?.racks || []).filter((r) => !allowed || allowed.has(r.vcenterId));
  const { racks: _all, ...pcfg } = rules.power || {};   // 랙 배치 원본(전 법인)은 응답에 싣지 않는다 — 보이는 법인 것만 racks 로
  const ag = A.aggregatePower(vis, { racks, cfg: pcfg });
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
    if (!allowed || allowed.has(vc)) rackServers = { vcenterId: vc, rack: rk, rows: ag.serversOf(vc, rk).map(mask) };
    else rackServers = { vcenterId: vc, rack: rk, rows: [] };
  }
  return {
    ok: true, now, fleet: ag.fleet, corps: ag.corps, racks: ag.racks, bins: ag.bins, hot: ag.hot.map(mask), capHit: ag.capHit.map(mask), cfg: ag.cfg,
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
