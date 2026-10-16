/**
 * Placement options for VM provisioning — what cluster / host / datastore /
 * folder / resource pool / storage profile the new VMs can target. Cluster,
 * host and datastore come from the live snapshot (real inventory). Folders,
 * resource pools and storage profiles are not in the aggregated snapshot, so we
 * return common suggestions (editable on the client) — in mock these are demo
 * values; in live the operator can type the exact vCenter name.
 */

import { store } from '../store.js';
import { getDataSource } from '../runtime-settings.js';
import { loadVcenterConfig } from '../config.js';
import { collectFoldersAndPools } from '../vcenter/soapClient.js';
import { noteVcAuthFailure, authStopView } from '../vcenter/authStopGate.js';
import { onDemandVcBlock } from '../vcenter/dsBrowse.js';   // v2.743: 생성(vsphere.js)과 같은 주문형 로그인 문

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

export async function getPlacement(vcenterId) {
  const snap = store.get();
  const hosts = snap.hosts.filter((h) => !vcenterId || h.vcenterId === vcenterId);
  const datastores = snap.datastores.filter((d) => !vcenterId || d.vcenterId === vcenterId);

  const clusters = uniq(hosts.map((h) => h.cluster)).sort().map((c) => ({
    name: c,
    hosts: hosts.filter((h) => h.cluster === c).length,
  }));

  // 이름 자연정렬(숫자 접미사 고려: esxi-01 < esxi-10, ds-2 < ds-10).
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const hostsOut = hosts.map((h) => ({ id: h.id, name: h.name, cluster: h.cluster || '', connectionState: h.connectionState }))
    .sort(byName);

  const datastoresOut = datastores.map((d) => ({ id: d.id, name: d.name, type: d.type, freeGB: d.freeGB, capacityGB: d.capacityGB }))
    .sort(byName);

  const mock = getDataSource() === 'mock';
  // Folders + resource pools: read live from the chosen vCenter when possible.
  let folders = null;
  let resourcePools = null;
  let foldersSource = mock ? 'demo' : 'default';
  let authStopped = null;
  let skipReason = null;   // v2.743: 비활성·점검중·엣지 위임이라 로그인하지 않았다(onDemandVcBlock 사유 코드)
  if (!mock && vcenterId) {
    const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId);
    if (vc) {
      /*
       * v2.741 AUTHZ-03 — 배치 선택 칸 조회도 vCenter **인증 실패 정지**를 따른다(v2.733 C3-01 의 주문형 조회 규약):
       *   · 주 폴러가 자격증명 거부로 멈춘 vCenter 에는 로그인하지 않는다(로그인 0) — 화면이 vCenter 를 고를 때마다
       *     자동으로 부르는 조회라 같은 서비스 계정의 실패 로그인을 쌓는다. 사유는 `foldersSource`·`authStopped` 로 싣고
       *     폴더·리소스 풀은 기본값('vm'·'Resources')으로 둔다(편집 가능 — 사람이 직접 입력할 수 있다).
       *   · 로그인 거부는 주 폴러와 **같은 기록**에 올린다(noteVcAuthFailure — 정지가 두 벌이면 한쪽을 풀어도 다른 쪽이 계속 로그인한다).
       *   · v2.743(리드 통합 — VC-03 의 형제): 비활성·점검중·엣지 위임(site) vCenter 도 건너뛴다. v2.741 은 '생성 작업 자체가 그 vCenter 에
       *     직접 로그인하므로 배치 칸만 막을 이유가 없다' 고 적었는데, v2.743 VC-03 이 생성(provision/vsphere.js·reconfig.js)도 주문형 로그인 문
       *     (vcenter/dsBrowse.js onDemandLogin)으로 막았다 — 이제 배치 칸만 로그인하면 생성은 거부되는데 조회만 접속한다. 판정은 같은 문 하나.
       *     사유는 `skipReason` 으로 싣는다(화면 칸은 기본값 그대로 — 편집 가능).
       *   · 정지 해제는 주 폴러·설정 › vCenter 연결 테스트가 한다(읽기 전용 조회 — 여기서 기록을 지우지 않는다).
       */
      const block = onDemandVcBlock(vc);
      if (block?.skipReason) {
        skipReason = block.skipReason;
        foldersSource = `skipped: ${block.skipReason}`;
      } else if (block?.authStopped) {
        authStopped = block.authStopped;
        foldersSource = `auth-stopped: ${block.reason}`;
      } else {
        try {
          const r = await collectFoldersAndPools(vc);
          folders = r.folders; resourcePools = r.resourcePools; foldersSource = 'vcenter';
        } catch (err) {
          const info = noteVcAuthFailure(vc, err);
          if (info) authStopped = authStopView(info);
          foldersSource = `error: ${err.message}`;
        }
      }
    }
  }
  if (!folders) folders = mock ? ['vm', 'Production', 'Development', 'Infra', 'Templates'] : ['vm'];
  if (!resourcePools) resourcePools = mock ? ['Resources (기본)', 'Prod', 'Dev', 'Batch'] : ['Resources'];
  const profiles = mock
    ? ['Datastore Default', 'vSAN Default Storage Policy', 'Thin Provision', 'Thick Provision (Eager)']
    : ['Datastore Default'];

  return { clusters, hosts: hostsOut, datastores: datastoresOut, folders, resourcePools, profiles, foldersSource, authStopped, ...(skipReason ? { skipReason } : {}), editable: { folders: true, resourcePools: true, profiles: true } };
}

/** Normalize an incoming placement payload (all optional, trimmed strings). */
export function cleanPlacement(p = {}) {
  const s = (v) => String(v ?? '').trim();
  return {
    cluster: s(p.cluster), host: s(p.host), datastore: s(p.datastore),
    folder: s(p.folder), resourcePool: s(p.resourcePool), storageProfile: s(p.storageProfile),
  };
}
