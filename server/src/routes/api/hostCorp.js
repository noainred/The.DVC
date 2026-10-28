// ESXi 호스트 화면 '법인별' 보기(v2.810 — 승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x).
//
//   · GET /hosts/corp   법인(vCenter)별 호스트 상태 · CPU 구간 · 용량/할당 · 클러스터 자세(HA·수용 제어·DRS·EVC·N+1) · 수집 상태 · RTT.
//                       /hosts 와 같은 범위·필터(applyFilters + state). 판정은 vcenter/hostCorp.js(순수) 하나.
//                       클러스터 구성·N+1 은 '클러스터 HA·DRS 점검' 도구와 같은 권한(accessOf().cluster)일 때만 싣는다.
//                       RTT 는 핑 모니터가 저장한 vCenter 대상의 마지막 값(실시간 측정 안 함 — 요청이 5초 대기를 만들지 않게).
//                       memoJson 캐시 — 범위 서명 + 권한 판본을 키에 넣는다(범위 계정에 다른 법인 값이 캐시로 새지 않게).
// ⚠ /hosts/:id 보다 먼저 등록한다('corp' 가 호스트 id 로 잡히지 않게 — routes/api.js 순서).
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store, usageReadable, hostCapacityKnown } from '../../store.js';
import { memoJson, applyFilters, scopeKey } from './shared.js';
import { accessOf } from './hostExport.js';
import { hostCorpOf } from '../../vcenter/hostCorp.js';
import { getPingDb } from '../../ping/db.js';
import { listTargets } from '../../ping/store.js';
import { REGIONS } from '../../util/regions.js';

const invHosts = requirePerm('inv.hosts');
const RTT_FRESH_MS = 30 * 60_000;   // 30분보다 오래된 핑 값은 '지금 RTT' 로 보이지 않게 at 과 함께 싣는다(화면이 흐리게)

/** 핑 모니터의 vCenter 대상(seedVcenterTargets 가 'vc_<id 소문자>' 로 만든다) 마지막 값. 실패하면 전부 null. */
async function rttReader() {
  try {
    const db = await getPingDb();
    const ids = new Set(listTargets('vcenter').filter((t) => t.enabled !== false).map((t) => t.id));
    return (vcId) => {
      const id = `vc_${String(vcId || '').trim().toLowerCase()}`;
      if (!ids.has(id)) return null;
      const r = db.latest(id);
      if (!r) return null;
      return { rttMs: r.ok && Number.isFinite(r.rtt) ? Math.round(r.rtt) : null, ok: r.ok === true, at: r.ts, fresh: Date.now() - r.ts <= RTT_FRESH_MS };
    };
  } catch { return () => null; }
}

export function registerHostCorp(api) {
  api.get('/hosts/corp', invHosts, (req, res) => {
    const access = accessOf(req);
    return memoJson(req, res, 'host-corp', async (snap) => {
      const allowed = scopedVcenterIds(req.user, snap);
      let hosts = applyFilters(snap.hosts || [], req.query, snap, ['name', 'cluster'], req.user);
      if (req.query.state) hosts = hosts.filter((h) => h.connectionState === req.query.state);
      const region = typeof req.query.region === 'string' && REGIONS.includes(req.query.region) ? req.query.region : null;
      const vcId = typeof req.query.vcenterId === 'string' ? req.query.vcenterId : null;
      // 법인 목록은 scope 가 먼저(요청 필터보다) — 범위 밖 vCenter 는 이름도 싣지 않는다.
      const vcenters = (snap.vcenters || [])
        .filter((v) => !allowed || allowed.has(v.id))
        .filter((v) => !vcId || v.id === vcId)
        .filter((v) => !region || v.location?.region === region);
      const vms = (snap.vms || []).filter((v) => !allowed || allowed.has(v.vcenterId));
      const narrowed = !!(req.query.q || req.query.state || req.query.notes);
      const rttOf = await rttReader();
      const r = hostCorpOf({ vcenters, hosts, vms, readable: usageReadable, capKnown: hostCapacityKnown, rttOf, access: { cluster: access.cluster }, dropEmpty: narrowed });
      return { ok: true, ...r, initial: snap.initial === true, generatedAt: snap.generatedAt || null };
    }, { ttlMs: 30_000, extraKey: `${scopeKey(req.user, store.get())}|${access.cluster ? 'c' : '-'}` });
  });
}
