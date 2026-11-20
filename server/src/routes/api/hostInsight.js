// Hypervisor(ESXi 호스트) 탭 '분석' 보기(v3.22.0 · 설계 docs/design/host-insight · 집계 vcenter/hostInsight.js).
//
//   · GET /hosts/insight   법인(vCenter)마다 한 줄 + 클러스터마다 한 줄(독립 호스트는 법인마다 한 줄) + 법인마다 상위 N.
//                          화면이 바로가기에서 고른 법인의 줄을 더한다(선택을 바꿀 때 서버 왕복이 없다) — 그래서 vcenterId · vcenterIds 는 **받지 않는다**
//                          (법인별 줄을 다 준다 · /vms/insight 와 같은 꼴). 범위(scope)가 먼저 · region 쿼리는 그 안에서 리전만 남긴다.
//                          판정은 새로 하지 않는다 — 법인 · 클러스터 줄은 /hosts/corp 의 hostCorpOf, 하드웨어 · 재부팅은 /hosts/checks 의 hostChecksOf · rebootsOf 그대로.
//                          권한: /hosts 와 같은 inv.hosts · 묶음은 accessOf(클러스터 구성 → HA · DRS · N+1 / 구성 점검 → 재부팅 / 관리자 판본 → iDRAC) — 없는 묶음은 키를 싣지 않는다.
//                          상시 폴링 경로: memoJson + 범위 키 + 권한 판본(accessOf 결과 — 역할 문자열이 아니라 판정 결과) · 호스트 사이 시간 기준 양보.
//                          재부팅 판정이 로그 DB 를 읽으므로 /hosts/checks 와 같은 60초 캐시.
// ⚠ /hosts/:id 보다 먼저 등록한다('insight' 가 호스트 id 로 잡히지 않게 — routes/api.js 순서).
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store, usageReadable, hostCapacityKnown } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { accessOf, makeIdracFor, BOOT_DAYS } from './hostExport.js';
import { rebootsOf } from './hostChecks.js';
import { hostChecksOf } from '../../vcenter/hostChecks.js';
import { hostInsightOf } from '../../vcenter/hostInsight.js';
import { listRegistry } from '../../idrac/registry.js';
import { allRemoteServers } from '../../collector/remoteInventory.js';
import { createYielder } from '../../util/timeSlice.js';

const invHosts = requirePerm('inv.hosts');

export function registerHostInsight(api) {
  api.get('/hosts/insight', invHosts, (req, res) => {
    const access = accessOf(req);
    const accessKey = `${access.cluster ? 'c' : '-'}${access.hygiene ? 'h' : '-'}${access.hw ? 'a' : '-'}`;
    return memoJson(req, res, 'host-insight', async (snap) => {
      const now = Date.now();
      const allowed = scopedVcenterIds(req.user, snap);
      // v3.22.1: 정해진 4리전으로 거르지 않는다 — 범위 바는 등록 데이터에만 있는 리전('Unknown' 등)도 고르게 하므로(platformText.scopeRegionOptions)
      //   그 글자를 버리면 전 법인 합이 나왔다. /hosts · /vms/insight 처럼 location.region 과 그대로 비교한다.
      const region = typeof req.query.region === 'string' && req.query.region ? req.query.region : null;
      const vcenters = (snap.vcenters || [])
        .filter((v) => v && (!allowed || allowed.has(v.id)))
        .filter((v) => !region || v.location?.region === region);
      const regionIds = region ? new Set(vcenters.map((v) => v.id)) : null;
      const hosts = (snap.hosts || []).filter((h) => h && (!allowed || allowed.has(h.vcenterId)) && (!regionIds || regionIds.has(h.vcenterId)));
      const vms = (snap.vms || []).filter((v) => v && (!allowed || allowed.has(v.vcenterId)) && (!regionIds || regionIds.has(v.vcenterId)));
      // 하드웨어 · 재부팅 — /hosts/checks 와 같은 함수 · 같은 권한(Veeam 은 이 화면에 없어 부르지 않는다)
      let checks = null;
      if (access.hw || access.hygiene) {
        const vcIds = [...new Set(hosts.map((h) => h.vcenterId))];
        let reboots = null;
        if (access.hygiene) { try { reboots = await rebootsOf(snap, hosts, vcIds, now); } catch { reboots = new Map(); } }
        let idracFor = null;
        if (access.hw) { try { idracFor = makeIdracFor({ registry: listRegistry(), remote: allRemoteServers() }); } catch { idracFor = null; } }
        checks = hostChecksOf(hosts, { access: { hw: access.hw, hygiene: access.hygiene }, idracFor, reboots, now });
      }
      const r = await hostInsightOf({
        vcenters, hosts, vms, readable: usageReadable, capKnown: hostCapacityKnown, access, checks,
        unlisted: !region, bootDays: access.hygiene ? BOOT_DAYS : null, yielder: createYielder(15), now,
      });
      return { ok: true, generatedAt: snap.generatedAt ?? null, initial: snap.initial === true, region, ...r };
    }, { ttlMs: 60_000, extraKey: `${scopeKey(req.user, store.get())}|${accessKey}` });
  });
}
