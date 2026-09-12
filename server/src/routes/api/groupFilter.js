/**
 * groupFilter.js — 도구 화면의 '클러스터 · 폴더' 하위 범위 필터(v2.491).
 *
 * 왜 별도 모듈인가: 판정이 순수 함수라 회귀 테스트로 고정할 수 있고(`test/groupFilter2491.test.js`),
 * 같은 규칙을 여러 라우트(/tools/waste · /tools/waste/off-since · /tools/groups)가 공유해야 한다.
 *
 * 설계 규약(추정 금지):
 *  - 선택 목록은 **스냅샷에 실제로 있는 값만** 돌려준다. 값이 없으면 빈 배열이다(임의 생성·추측 금지).
 *    폴더(`vm.folder`)는 SOAP 수집 경로에서만 채워지므로(`vcenter/soapClient.js`), REST 수집만 쓰는
 *    vCenter 는 폴더 목록이 비는 것이 **정상**이다 — 화면은 그 사실을 그대로 알린다.
 *  - 대조는 **완전일치**(부분일치·대소문자 무시 없음) — 콤보 박스가 실재 값을 그대로 보내기 때문이다.
 *  - 클러스터 이름은 vCenter 간 중복될 수 있다(예: 'Cluster-01'). 그래서 화면은 vCenter 를 고른
 *    뒤에만 이 필터를 쓰게 하고, 서버는 scope(vcenterId) 교집합이 **먼저** 적용된 슬라이스에만 이
 *    필터를 얹는다(scope 가 요청 필터보다 먼저 — server/CLAUDE.md 불변조건).
 */

const str = (v) => String(v == null ? '' : v).trim().slice(0, 300);

/** 요청 쿼리 → { cluster, folder }. 빈 값은 '미선택'(필터 없음). */
export function normGroupQuery(q = {}) {
  return { cluster: str(q.cluster), folder: str(q.folder) };
}

/** 그룹 필터가 실제로 걸렸는지. */
export const hasGroup = (g) => !!(g && (g.cluster || g.folder));

/** VM 한 건이 선택된 클러스터·폴더에 속하는지(둘 다 지정되면 AND). */
export function vmGroupMatch(vm, g) {
  if (!hasGroup(g)) return true;
  if (g.cluster && str(vm?.cluster) !== g.cluster) return false;
  if (g.folder && str(vm?.folder) !== g.folder) return false;
  return true;
}

/** VM 목록에 그룹 필터 적용. 미선택이면 원본을 그대로 돌려준다(불필요한 복사 없음). */
export function filterVmsByGroup(vms, g) {
  if (!hasGroup(g)) return vms || [];
  return (vms || []).filter((v) => vmGroupMatch(v, g));
}

/**
 * 콤보 박스 선택 목록 — { clusters:[{name,hosts,vms}], folders:[{name,vms}] }.
 *
 * VM 수는 템플릿을 제외한 실 VM 기준이다(낭비 리소스 등 도구가 다루는 모집단과 같게 맞춤).
 * 호스트가 있고 VM 이 0 인 클러스터도 목록에 남긴다 — 실재하는 클러스터이고, 고르면 '해당 없음' 을
 * 보는 것이 정상 동작이다.
 */
export function inventoryGroups(slice) {
  const cl = new Map();
  const fd = new Map();
  const bump = (map, name, field) => {
    const k = str(name);
    if (!k) return;
    let e = map.get(k);
    if (!e) { e = { name: k, hosts: 0, vms: 0 }; map.set(k, e); }
    e[field] += 1;
  };
  for (const h of slice?.hosts || []) bump(cl, h.cluster, 'hosts');
  for (const v of slice?.vms || []) {
    if (v.template) continue;
    bump(cl, v.cluster, 'vms');
    bump(fd, v.folder, 'vms');
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  return {
    clusters: [...cl.values()].sort(byName),
    folders: [...fd.values()].map(({ name, vms }) => ({ name, vms })).sort(byName),
  };
}
