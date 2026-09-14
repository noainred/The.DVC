/**
 * vmseries/scope.js — 수집 대상 해석(순수, v2.510).
 *
 * 설정(settings.scope / settings.targets)과 스냅샷을 받아 "이번 주기에 어느 VM·호스트를 조회할지"
 * 를 정한다. 매 주기 스냅샷에서 다시 풀기 때문에 선택한 폴더·클러스터에 VM 이 새로 생기면
 * 자동으로 대상이 된다(id 목록을 굳혀 두면 신규 VM 이 영원히 빠진다).
 *
 * 규칙(설정 화면 문구와 일치해야 한다 — web/src/views/vmSeriesText.js):
 *  - scope='all'      : 등록된 모든 vCenter 의 전원 ON VM 전부 + 연결된 호스트 전부.
 *  - scope='selected' : targets 에 적힌 vCenter 만. vCenter 항목이 { all:true } 면 그 vCenter 전부,
 *                       아니면 clusters ∪ folders ∪ hosts ∪ vms 의 합집합.
 *      · 클러스터 선택 = 그 클러스터의 호스트 + 그 위의 VM.
 *      · 호스트 선택   = 그 호스트 + 그 위의 VM(호스트만 보고 싶어 고르는 경우는 드물다 — 화면에 명시).
 *      · 폴더 선택     = 그 폴더와 하위 폴더의 VM(경로 접두 일치, 'a/b' 는 'a/bc' 와 다르다).
 *      · VM 선택       = 그 VM.
 *  - 전원 꺼진 VM·템플릿은 제외(실시간 표본이 없다). 연결 끊긴 호스트도 제외.
 *
 * moref 는 `id.slice(vcenterId.length + 1)` 로 자른다 — vc.id 에 콜론이 있을 수 있어 split 금지
 * (toolsCapacity.js morefOf 와 같은 규약).
 */

/** 폴더 경로 정규화 — 앞뒤 슬래시·'vm' 루트 제거. 스냅샷 vm.folder 와 같은 형태로 맞춘다. */
export function normFolder(p) {
  const parts = String(p || '').split('/').map((s) => s.trim()).filter((s) => s && s !== 'vm');
  return parts.join('/');
}

/** 폴더 f 가 선택 폴더 sel 자신이거나 그 하위인가. */
export function folderMatches(f, sel) {
  const a = normFolder(f); const b = normFolder(sel);
  if (!b) return true;              // 빈 선택 = 루트 = 전부
  return a === b || a.startsWith(`${b}/`);
}

const morefOf = (id, vcId) => String(id || '').slice(String(vcId || '').length + 1);

/**
 * 한 vCenter 의 대상.
 * @returns {{ vms:[{id,ref,name,vcpu,memMB,host,cluster,folder}], hosts:[{id,ref,name,cluster}], mode:'all'|'selected'|'none' }}
 */
export function resolveTargets(snap, settings, vcenterId) {
  const vcId = String(vcenterId || '');
  const out = { vms: [], hosts: [], mode: 'none' };
  if (!snap || !vcId) return out;
  const allVms = (snap.vms || []).filter((v) => v.vcenterId === vcId && v.powerState === 'POWERED_ON' && !v.template);
  const allHosts = (snap.hosts || []).filter((h) => h.vcenterId === vcId && h.connectionState !== 'DISCONNECTED');
  const pickVm = (v) => ({ id: v.id, ref: morefOf(v.id, vcId), name: v.name, vcpu: Number(v.cpuCount) || 0, memMB: Number(v.memMB) || 0, host: v.host || '', cluster: v.cluster || '', folder: v.folder || '' });
  const pickHost = (h) => ({ id: h.id, ref: morefOf(h.id, vcId), name: h.name, cluster: h.cluster || '' });

  const scope = settings?.scope === 'selected' ? 'selected' : 'all';
  if (scope === 'all') {
    return { vms: allVms.map(pickVm), hosts: allHosts.map(pickHost), mode: 'all' };
  }
  const t = settings?.targets?.[vcId];
  if (!t) return out;                                   // 이 vCenter 는 선택되지 않음
  if (t.all === true) return { vms: allVms.map(pickVm), hosts: allHosts.map(pickHost), mode: 'all' };

  const clusters = new Set((t.clusters || []).map(String));
  const folders = (t.folders || []).map(normFolder);
  const hostIds = new Set((t.hosts || []).map(String));
  const vmIds = new Set((t.vms || []).map(String));

  const hosts = allHosts.filter((h) => clusters.has(h.cluster) || hostIds.has(h.id));
  const hostNames = new Set(hosts.map((h) => h.name));
  const vms = allVms.filter((v) => vmIds.has(v.id)
    || clusters.has(v.cluster)
    || hostNames.has(v.host)
    || folders.some((f) => f && folderMatches(v.folder, f)));
  return { vms: vms.map(pickVm), hosts: hosts.map(pickHost), mode: 'selected' };
}

/** 이 vCenter 를 이번 주기에 볼 것인가(scope 와 targets 만 본다 — mock/site 판정은 폴러가). */
export function vcenterSelected(settings, vcenterId) {
  if (!settings?.enabled) return false;
  if (settings.scope !== 'selected') return true;
  return !!settings.targets?.[String(vcenterId)];
}

/** 설정 화면용 요약 — vCenter 별 대상 수(예상 크기 표시의 분모). */
export function summarizeScope(snap, settings) {
  const ids = [...new Set((snap?.vcenters || []).map((v) => v.id))];
  return ids.map((id) => {
    const r = resolveTargets(snap, settings, id);
    return { vcenterId: id, mode: r.mode, vms: r.vms.length, hosts: r.hosts.length };
  });
}
