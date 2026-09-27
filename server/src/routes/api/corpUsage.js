/**
 * routes/api/corpUsage.js — 특수기능 '법인별 서버 사용량' API(v2.625).
 *
 * 한 페이지: 법인별(전체/다빈치/IRS) 서버 CPU·메모리 사용량 — 전체 · 물리(베어메탈) · 가상화(ESXi).
 * 판정·합산은 `corpusage/build.js`(순수)가 하고, 여기는 입력만 모은다.
 *
 * ── 입력(장비·vCenter 왕복 0) ───────────────────────────────────────────────
 *  · 분류: `insights/fleetInventory.js getFleetInventory()` — 서버 분석 › 구분과 **같은 집합**(판정 복제 금지)
 *  · 사용률: 베어메탈 사용률 DB 의 최신값(`usage_latest`) + 엣지 보관분(중앙이 당겨 둔 인메모리 — `bmUsageEdgePull`)
 *  · 가상화 대체값·용량: 인벤토리 스냅샷의 ESXi 호스트(`cpuUsagePct`·`memUsagePct`·`cpuCores`·`memTotalMB`)
 *  · 물리 용량: iDRAC 인벤토리 캐시(`cpu.cores`·`memory.totalGiB`) → 엣지 원격 인벤토리
 *
 * ── 권한: `tools` + **vCenter scope**(베어메탈 사용률과 같다) ─────────────────
 *  법인 축이 있으므로 범위 계정에는 그 법인 것만 준다. 법인 귀속이 없는 물리 서버는 범위 계정에 주지 않는다.
 *  ⚠ 서버 목록(이름·주소)은 응답에 싣지 않는다 — 법인 단위 합계만. 서버별 값은 '베어메탈 사용률' 화면이 소유한다.
 * ⚠ **폴링 금지**(화면은 마운트 1회 + 새로고침) — 입력은 가볍지만 분류(getFleetInventory)가 전 서버를 훑는다.
 */
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { buildCorpUsage } from '../../corpusage/build.js';
import { loadBmUsageSettings, bmUsageEnabled } from '../../bmusage/settings.js';
import { latestUsage } from '../../bmusage/db.js';
import { numOrNull } from '../../util/numOrNull.js';

const toolsPerm = requirePerm('tools');
const t = (v) => String(v ?? '').trim();

/** 최신값 행 합치기 — 같은 key 는 **ts 가 더 큰 쪽**(중앙 DB 와 엣지 보관분이 겹칠 수 있다). 순수. */
export function mergeLatestRows(...lists) {
  const out = new Map();
  for (const list of lists) {
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r !== 'object') continue;
      const k = t(r.key);
      if (!k) continue;
      const prev = out.get(k);
      if (!prev || (numOrNull(r.ts) ?? -1) > (numOrNull(prev.ts) ?? -1)) out.set(k, r);
    }
  }
  return out;
}

/**
 * v2.629(A6-03): 엣지 보관분 행을 `에이전트소문자|key소문자` 로도 색인한다 — 서비스태그 없는 엣지 서버는 중앙 키와 엣지 키가
 *   달라 key 하나로는 찾을 수 없고, 에이전트 축이 없으면 다른 엣지의 같은 fleetId 행이 섞인다. 같은 칸은 ts 가 큰 쪽. 순수.
 */
export function rowsByAgentKeyOf(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const a = t(r._agent).toLowerCase(); const k = t(r.key).toLowerCase();
    if (!a || !k) continue;
    const id = `${a}|${k}`;
    const prev = out.get(id);
    if (!prev || (numOrNull(r.ts) ?? -1) > (numOrNull(prev.ts) ?? -1)) out.set(id, r);
  }
  return out;
}

/**
 * 물리 서버 용량 찾기 — iDRAC 인벤토리 캐시 → 등록부 서비스태그 → 엣지 원격 인벤토리 순.
 * 못 찾으면 null(합계에서 빼고 '용량 모름' 으로 센다 — 지어내지 않는다).
 */
export function makeCapOf({ getInventory, registry = [], remoteServers = [] }) {
  const regByTag = new Map(registry.filter((r) => t(r?.serviceTag)).map((r) => [t(r.serviceTag).toLowerCase(), r]));
  const remByTag = new Map(remoteServers.filter((s) => t(s?.serviceTag)).map((s) => [t(s.serviceTag).toLowerCase(), s]));
  const fromInv = (inv) => {
    if (!inv || typeof inv !== 'object') return null;
    const cores = numOrNull(inv.cpu?.cores);
    const mem = numOrNull(inv.memory?.totalGiB);
    return (cores || mem) ? { cores, memGB: mem } : null;
  };
  return (b) => {
    const tag = t(b?.serviceTag).toLowerCase();
    let inv = null;
    try { inv = fromInv(getInventory(t(b?.serverId))); } catch { inv = null; }
    if (inv) return inv;
    const reg = tag ? regByTag.get(tag) : null;
    if (reg) { try { inv = fromInv(getInventory(t(reg.id))); } catch { inv = null; } }
    if (inv) return inv;
    const rem = tag ? remByTag.get(tag) : null;
    return rem ? fromInv(rem.inv) : null;
  };
}

export function registerCorpUsage(api) {
  api.get('/tools/corp-usage', toolsPerm, async (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    await memoJson(req, res, 'corp-usage', async (snap) => {
      const [{ getFleetInventory }, { loadRegistry }, { getInventory }, { allRemoteServers }, edge] = await Promise.all([
        import('../../insights/fleetInventory.js'), import('../../idrac/registry.js'), import('../../idrac/invCache.js'),
        import('../../collector/remoteInventory.js'), import('../../central/bmUsageEdgePull.js'),
      ]);
      const sourceErrors = [];
      const fleet = await getFleetInventory(snap).catch((e) => { sourceErrors.push(`분류: ${String(e?.message || e).slice(0, 200)}`); return { bareMetal: [], virtualizationHosts: [] }; });
      // v2.626: 법인이 빈 물리 서버는 개요와 같은 귀속 규칙으로 채운다(수집 대상 판정과 같은 함수 — 둘이 갈라지지 않게).
      const { attributeBareMetalFromSnap } = await import('../../idrac/corpAttribution.js');
      const attr = attributeBareMetalFromSnap(fleet.bareMetal || [], snap);
      if (attr.error) sourceErrors.push(`법인 귀속: ${attr.error}`);
      const central = await latestUsage().catch((e) => { sourceErrors.push(`사용률 DB: ${String(e?.message || e).slice(0, 200)}`); return []; });
      // 엣지 보관분 — 중앙이 '가져오기' 로 당겨 둔 것만 있다(상시 push 없음, v2.554). 오래됐어도 행의 ts 로 신선도를 판정한다.
      const edges = (() => { try { return edge.listEdgeBmUsage(); } catch { return []; } })();
      // v2.628(R2628-02): 엣지 행은 그 엣지의 수집 주기로 신선도를 본다(중앙 주기와 다를 수 있다).
      const freshOf = (ms) => Math.max(30 * 60_000, 3 * (numOrNull(ms) || 300_000));
      const edgeRows = edges.flatMap((e) => {
        const f = freshOf(e?.snap?.settings?.intervalMs);
        return (e?.snap?.rows || []).filter((r) => r && typeof r === 'object').map((r) => ({ ...r, _freshMs: f, _agent: t(e?.agent) }));
      });
      // v2.628(EDGE2628-01): 엣지 봉투는 대상 수 상한으로 잘릴 수 있다 — 잘린 서버는 이 화면에서 '못 읽음' 이 된다. 개수를 밝힌다.
      const edgeTruncated = edges.reduce((a, e) => a + (numOrNull(e?.snap?.truncated) || 0), 0);
      const rowsByKey = mergeLatestRows(central, edgeRows);
      const registry = (() => { try { return loadRegistry(); } catch { return []; } })();
      const remoteServers = (() => { try { return allRemoteServers(); } catch { return []; } })();
      const hostByKey = new Map((snap?.hosts || []).map((h) => [`${t(h.vcenterId)}|${t(h.name).toLowerCase()}`, h]));
      const s = loadBmUsageSettings();
      // 신선도: 수집 주기의 3배, 최소 30분 — 한두 주기 빠진 것은 '지금 값' 으로 본다(주기 숫자를 박지 않는다).
      const freshMs = freshOf(s.intervalMs);
      // v2.628(R2628-01 = C2628-04 — 재현): 점검중·수집 실패 이월·위임 push 낡음 vCenter 의 호스트 값은 지금 값이 아니다.
      const { unreadVcenterReasons } = await import('../../metrics/sampler.js');
      const unreadVcenters = (() => { try { return unreadVcenterReasons(snap); } catch { return new Map(); } })();
      const out = buildCorpUsage({
        vcenters: snap?.vcenters || [], bareMetal: attr.bareMetal, virtHosts: fleet.virtualizationHosts || [],
        rowsByKey, rowsByAgentKey: rowsByAgentKeyOf(edgeRows), hostByKey, capOf: makeCapOf({ getInventory, registry, remoteServers }),
        allowed, now: Date.now(), freshMs, unreadVcenters,
      });
      // 법인마다 '수집을 켰는가' — 값이 없는 이유를 화면이 말하려면 필요하다(켠 법인 목록 자체는 범위 밖을 주지 않는다).
      // v2.628(R2628-07): 엣지가 수집하는 법인은 **그 엣지의 설정**이 정한다 — 중앙 설정만 보고 '안 켰다' 고 말하지 않는다.
      const edgeOn = new Set();
      for (const e of edges) {
        const es = e?.snap?.settings;
        if (e?.snap?.enabled === true && es) for (const id of es.corps || []) edgeOn.add(t(id));
      }
      for (const c of out.corps) { c.collectOnEdge = edgeOn.has(c.vcenterId); c.collectOn = !!(s.corps || {})[c.vcenterId] || c.collectOnEdge; }
      return {
        ok: true, at: Date.now(), ...out,
        // 귀속 규칙으로 채운 물리 서버 수(법인 축 — 범위 계정에는 개수만 준다. 서버 목록은 싣지 않는다).
        attributed: { filled: allowed ? null : attr.filled, conflicts: allowed ? null : (attr.conflicts || 0) },
        settings: { enabled: bmUsageEnabled(), includeVirtualization: !!s.includeVirtualization, idracTelemetry: !!s.idracTelemetry, intervalMs: numOrNull(s.intervalMs) },
        // 엣지 보관분 요약 — 엣지는 법인 축으로 나눌 수 없어 범위 계정에는 개수만(v2.525 규약).
        edgeSnaps: allowed ? { count: edges.filter((e) => e?.snap).length }
          : { count: edges.filter((e) => e?.snap).length, list: edges.filter((e) => e?.snap).map((e) => ({ agent: t(e.agent), snapAt: numOrNull(e.snapAt), rows: (e.snap.rows || []).length })).slice(0, 64) },
        edgeTruncated,
        unreadVcenters: allowed ? [...unreadVcenters.entries()].filter(([id]) => allowed.has(id)).length : unreadVcenters.size,
        sourceErrors,
        scoped: !!allowed,
      };
    }, { ttlMs: 12_000, extraKey: scopeKey(req.user, store.get()) });
  });
}
