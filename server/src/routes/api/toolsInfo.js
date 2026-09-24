// GuestOS/HBA/라이선스/Tools업그레이드/UI설정 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requireRole, requirePerm } from '../../auth/auth.js';
import { auditMiddleware } from '../../audit.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { loadUiSettings, saveUiSettings } from '../../ui-settings.js';
import { upgradeVmTools } from '../../vcenter/soapClient.js';
import { morefOf } from '../../vcenter/registry.js'; // v2.598 VC2598-06: 콜론 포함 vCenter id 안전한 분해
import { nsxStore } from '../../nsx/store.js';
import { licenseFamilyOf, licenseExpiryStatus } from '../../util/licenseExpiry.js';
import { collectHorizonLicenses, listHorizon } from '../../horizon/horizon.js';
import { memoJson, scopeKey, osFamily } from './shared.js';
import { aggregateGuestOs } from '../../inventory/guestOsAgg.js';
import { dayKey } from "../../util/dayKey.js";
import { visibleNsxManagers } from '../../nsx/scope.js';
import { isAdminReq, scrubHosts } from '../../auth/addressMask.js';

/** VM id → 스냅샷 VM 의 vcenterId(없으면 null). v2.598 VC2598-06 — id 를 첫 콜론에서 자르지 않는다. */
export function upgradeVcOf(snap) {
  const byId = new Map((snap?.vms || []).map((v) => [v.id, v.vcenterId]));
  return (id) => (byId.has(id) ? String(byId.get(id) ?? '') : null);
}

export function registerToolsInfo(api) {

// 평문 자격증명 점검(특수기능, v2.297) — 설정 파일·portal.env·로그·소스에서 평문으로 남은
// 계정정보를 탐지한다(값은 항상 마스킹 — secretScan.js 헤더 참조). adminOnly 인 이유:
// 결과가 '어디에 비밀이 있고 어떤 상태인가'라는 보안 태세 지도라 열람 자체가 민감하다
// (viewer/operator 에게는 도구 카드도 안 보임 — specialToolsList adminOnly 플래그와 쌍).
// ?fresh=1 이면 30초 캐시를 무시하고 재스캔(스캔 자체는 single-flight 로 중복 방지).
api.get('/tools/secret-scan', requireRole('admin'), async (req, res) => {
  try {
    const { runSecretScan } = await import('../../security/secretScan.js');
    res.json(await runSecretScan({ fresh: req.query.fresh === '1' }));
  } catch (e) { res.status(500).json({ error: `점검 실패: ${e.message}` }); }
});

// Guest OS distribution — VM counts grouped by Guest OS (종류·버전), optionally
// per vCenter. Family rollup + full-name detail; power(on/off) split.
api.get('/tools/guest-os', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-guest-os', (snap) => {
  let vms = snap.vms;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  // 전원(on/off) · 종류(vm/template) 필터
  if (req.query.power === 'on') vms = vms.filter((v) => v.powerState === 'POWERED_ON');
  else if (req.query.power === 'off') vms = vms.filter((v) => v.powerState !== 'POWERED_ON');
  if (req.query.kind === 'vm') vms = vms.filter((v) => !v.template);
  else if (req.query.kind === 'template') vms = vms.filter((v) => v.template);
  // v2.328(사용자 요구): OS별 VM 수에 더해 할당 코어(vCPU)와 vCenter별 분해를 함께 낸다.
  // 순수 집계 함수(inventory/guestOsAgg.js)로 O(N) 1회 순회 — 테스트로 산술 고정.
  const vcMeta = new Map((snap.vcenters || []).map((vc) => [vc.id, { name: vc.name, region: vc.location?.region || '' }]));
  return aggregateGuestOs(vms, osFamily, vcMeta);
}, { extraKey: scopeKey(req.user, store.get()) }));

// 특정 Guest OS(종류·버전) 또는 계열에 해당하는 VM 목록 — VM 수 클릭 시 대상 VM/CSV용.
// 쿼리: vcenterId·power(on/off)·kind(vm/template) + os(정확 일치) 또는 family(계열).
api.get('/tools/guest-os/vms', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  if (req.query.power === 'on') vms = vms.filter((v) => v.powerState === 'POWERED_ON');
  else if (req.query.power === 'off') vms = vms.filter((v) => v.powerState !== 'POWERED_ON');
  if (req.query.kind === 'vm') vms = vms.filter((v) => !v.template);
  else if (req.query.kind === 'template') vms = vms.filter((v) => v.template);
  if (req.query.os) { const os = String(req.query.os); vms = vms.filter((v) => ((v.guestOS || '미상').trim() || '미상') === os); }
  if (req.query.family) { const fam = String(req.query.family); vms = vms.filter((v) => osFamily(v.guestOS) === fam); }
  const items = vms.map((v) => ({
    name: v.name, vcenterId: v.vcenterId, cluster: v.cluster || '', host: v.host || '',
    guestOS: v.guestOS || '', powerState: v.powerState,
    cpu: v.cpuCount || 0, memGB: Math.round((v.memMB || 0) / 1024), diskGB: v.storageGB || 0,
    ip: (v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : [])).join(' '),
  })).sort((a, b) => (a.vcenterId === b.vcenterId
    ? String(a.name || '').localeCompare(String(b.name || ''))
    : String(a.vcenterId || '').localeCompare(String(b.vcenterId || ''))));
  res.json({ total: items.length, items: items.slice(0, 10000) });
});

// Host HBA adapters and their link speeds (optionally per vCenter).
api.get('/tools/hba', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const items = [];
  const speedDist = {};
  for (const h of hosts) {
    for (const hba of h.hbas || []) {
      items.push({ host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, name: hba.name, type: hba.type, model: hba.model, speedGbps: hba.speedGbps || 0, wwn: hba.wwn || '', status: hba.status || '' });
      const k = hba.speedGbps ? `${hba.speedGbps}Gb` : '미상';
      speedDist[k] = (speedDist[k] || 0) + 1;
    }
  }
  res.json({
    hostsWithHba: hosts.filter((h) => (h.hbas || []).length).length,
    adapters: items.length,
    speedDistribution: Object.entries(speedDist).map(([speed, count]) => ({ speed, count })).sort((a, b) => parseFloat(b.speed) - parseFloat(a.speed)),
    items,
  });
});

// License overview across all vCenters (optionally one). Aggregates per product.
api.get('/tools/licenses', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  let vcs = snap.vcenters || [];
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vcs = vcs.filter((v) => allowed.has(v.id));
  if (req.query.vcenterId) vcs = vcs.filter((v) => v.id === req.query.vcenterId);
  const items = [];
  for (const vc of vcs) for (const l of vc.licenses || []) items.push({ vcenterId: vc.id, vcenterName: vc.name, ...l });
  // rollup by license name
  const roll = new Map();
  for (const l of items) {
    const k = l.name || l.edition || 'unknown';
    if (!roll.has(k)) roll.set(k, { name: k, total: 0, used: 0, product: l.product, productVersion: l.productVersion, count: 0 });
    const e = roll.get(k); e.total += l.total || 0; e.used += l.used || 0; e.count++;
  }
  res.json({
    items,
    byLicense: [...roll.values()].sort((a, b) => b.used - a.used),
    totalAssigned: items.reduce((a, l) => a + (l.used || 0), 0),
  });
});

// 라이선스 만료일 확인 — vCenter LicenseManager에 등록된 모든 키(ESXi/vSphere·vCenter·vSAN·
// VCF/VVF 등 vCenter에 할당된 전 제품) + NSX Manager(/api/v1/licenses) + Horizon Connection
// Server(REST /config/v1/licenses, 10분 캐시) 취합. 만료/임박(90일)/정상/영구 + 제품군 분류.
// vCenter/NSX는 캐시 스냅샷만 사용(추가 수집 없음), Horizon만 캐시 만료 시 라이브 조회.
api.get('/tools/license-expiry', requirePerm('tools'), async (req, res) => {
  const snap = store.get();
  let vcs = snap.vcenters || [];
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vcs = vcs.filter((v) => allowed.has(v.id));
  const scoped = Boolean(req.query.vcenterId);
  if (scoped) vcs = vcs.filter((v) => v.id === req.query.vcenterId);
  const items = [];
  for (const vc of vcs) {
    for (const l of (vc.licenses || [])) {
      // eval 키('Evaluation Mode')는 total=0·만료 별도 표기 그대로 노출.
      const ts = l.expires ? (Date.parse(l.expires) || null) : null;
      const st = licenseExpiryStatus(ts);
      items.push({
        source: 'vCenter', where: vc.name || vc.id, vcenterId: vc.id,
        name: l.name || l.edition || '(이름 없음)',
        family: licenseFamilyOf(`${l.name} ${l.edition} ${l.product}`),
        edition: l.edition || '', product: l.product || '', productVersion: l.productVersion || '',
        key: l.key || '', total: l.total ?? null, used: l.used ?? null,
        expires: dayKey(ts),
        status: st.status, daysLeft: st.daysLeft,
      });
    }
  }
  // v2.603 AUTHZ-2603-01: 예전에는 `scoped` 가 ?vcenterId 유무만 봐서 **범위 제한 계정**에도 전 함대 NSX 키·Horizon
  // 라이선스·오류(호스트명)가 나갔다. 사용자 범위(allowed)도 함께 본다 — NSX 는 형제 라우트(vcTools·health/network)와
  // 같은 visibleNsxManagers 로 거르고, Horizon 은 vCenter 귀속 축이 없으므로(v2.525) 범위 계정에는 싣지 않는다.
  // 뺀 것은 omittedOutOfScope 로 밝힌다(조용한 제외 금지).
  const omittedOutOfScope = { nsxManagers: 0, nsxLicenses: 0, horizon: false };
  const collectionErrors = [];   // v2.603: NSX 라이선스 조회 실패도 여기에 싣는다(선언을 NSX 블록 앞으로)
  // NSX 매니저 직수집 라이선스 — 특정 vCenter 를 고른 조회에서는 빼고, 전체 조회에서는 사용자 범위 안 매니저만.
  if (!scoped) {
    const allMgrs = nsxStore.get()?.managers || [];
    const mgrs = visibleNsxManagers(allMgrs, snap.vcenters, allowed);
    if (allowed) {
      const seen = new Set(mgrs);
      for (const m of allMgrs) if (!seen.has(m)) { omittedOutOfScope.nsxManagers += 1; omittedOutOfScope.nsxLicenses += (m.licenses || []).length; }
    }
    for (const m of mgrs) {
      // v2.603(감사 COL-2603-05 후속): 라이선스 조회에 실패한 매니저는 빈 목록이 '라이선스 없음' 이 아니라 **확인 불가**다 —
      //   서버 수집기가 listsFailed 에 'licenses' 를 싣는다. 사유 원문(주소가 들어갈 수 있다)은 admin 에게만.
      if (Array.isArray(m.listsFailed) && m.listsFailed.includes('licenses')) {
        const why = isAdminReq(req) ? String(m.listFailReasons?.licenses || '').slice(0, 200) : '';
        collectionErrors.push(`NSX ${m.name || m.id}: 라이선스 조회 실패 — 이 매니저의 라이선스는 '없음' 이 아니라 확인 불가${why ? ` (${why})` : ''}`);
      }
      for (const l of (m.licenses || [])) {
        const st = licenseExpiryStatus(l.expiry || null, { forcedExpired: l.isExpired });
        items.push({
          source: 'NSX', where: m.name || m.id, vcenterId: m.vcenterId || '',
          name: l.description || 'NSX License', family: 'NSX',
          edition: l.capacityType || '', product: 'NSX', productVersion: m.version || '',
          key: l.key || '', total: l.quantity ?? null, used: null,
          expires: dayKey(l.expiry),
          status: st.status, daysLeft: st.daysLeft,
        });
      }
    }
  }
  // Horizon Connection Server 직수집(등록된 서버가 있을 때만) — vCenter 스코프와 무관.
  if (!scoped && allowed) omittedOutOfScope.horizon = listHorizon().length > 0;
  if (!scoped && !allowed) {
    try {
      const hz = await collectHorizonLicenses();
      for (const { server: s, lic: l } of hz.rows) {
        const st = licenseExpiryStatus(l.expiry || null, { forcedExpired: l.isExpired });
        items.push({
          source: 'Horizon', where: s.name || s.id, vcenterId: '',
          name: l.name, family: 'Horizon',
          edition: l.usageModel || '', product: 'Horizon', productVersion: '',
          key: l.key || '', total: null, used: null,
          expires: dayKey(l.expiry),
          status: st.status, daysLeft: st.daysLeft,
        });
      }
      // 비-admin 에게는 오류 원문 속 Connection Server 주소를 가린다(ENOTFOUND <host> 등 — v2.599 addressMask 규약).
      const hzHosts = isAdminReq(req) ? [] : listHorizon().map((s) => s.host).filter(Boolean);
      const scrub = (t) => (hzHosts.length ? scrubHosts(String(t ?? ''), hzHosts) : String(t ?? ''));
      for (const e of hz.errors) collectionErrors.push(`Horizon ${e.name || e.id}: ${scrub(e.reason)}`);
    } catch (e) { collectionErrors.push(`Horizon: ${isAdminReq(req) ? e.message : scrubHosts(String(e.message ?? ''), listHorizon().map((s) => s.host).filter(Boolean))}`); }
  }
  const summary = { expired: 0, expiring: 0, ok: 0, perpetual: 0 };
  for (const it of items) summary[it.status] = (summary[it.status] || 0) + 1;
  const families = [...new Set(items.map((i) => i.family))].sort();
  res.json({
    items, summary, families, total: items.length, collectionErrors,
    // 범위 계정에는 Horizon 등록 대수도 함대 정보라 싣지 않는다(null = 알려주지 않음, 0 과 다르다).
    horizonServers: allowed ? null : listHorizon().length,
    scoped: !!allowed, omittedOutOfScope,
    generatedAt: snap.generatedAt,
  });
});

// Trigger VMware Tools upgrade on one or more VMs. Body: { ids:[vmId,...] }.
// v2.590 D1: 역할 게이트 복구 — requirePerm('tools') 만으로는 viewer+tools 가 게스트 재부팅 유발 작업을 실행할 수 있었다.
api.post('/vms/upgrade-tools', requireRole('admin', 'operator'), requirePerm('tools'), auditMiddleware, async (req, res) => { // v2.478(감사 S15): 게스트 재부팅 유발 작업 감사
  let ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ ok: false, reason: '대상 VM이 없습니다.' });
  const snap = store.get();
  // 사용자 scope 강제(쓰기 경로) — id 는 `vcId:moref`. 범위 밖 vCenter 의 VM 에는 Tools 업그레이드를
  // 실행할 수 없다(범위 제한 계정이 타 사이트 VM 을 건드리는 것 차단).
  // v2.369: 쓰기 라우트이므로 조회 범위가 아니라 **쓰기 범위**(writeVcenters ∩ 조회)를 쓴다 —
  // writeVcenters 미설정이면 조회 범위와 동일해 기존 동작 불변.
  const allowed = writeScopedVcenterIds(req.user, snap);
  // v2.598 VC2598-06: vCenter 는 id 문자열(첫 콜론)이 아니라 **스냅샷 VM 의 vcenterId** 로 정한다 — vCenter id 에 콜론이
  // 있으면 첫 콜론 분해가 다른 vCenter 를 가리킨다. 스냅샷에 없는 id 는 vCenter 를 모르므로 범위 계정에서는 뺀다.
  const vcOf = upgradeVcOf(snap);
  if (allowed) {
    const dropped = ids.filter((id) => !allowed.has(vcOf(id))).length;
    ids = ids.filter((id) => allowed.has(vcOf(id)));
    if (!ids.length) return res.status(403).json({ ok: false, reason: '요청한 VM 이 모두 접근 범위 밖입니다.' });
    if (dropped) res.setHeader('X-Scope-Dropped', String(dropped));
  }
  if (snap.source === 'mock') {
    return res.json({ ok: true, mock: true, requested: ids.length, results: ids.map((id) => ({ id, ok: true })) });
  }
  // live: group by vCenter and call UpgradeTools_Task
  const byVc = new Map();
  const results = [];
  for (const id of ids) {
    const vcId = vcOf(id);
    if (vcId == null) { results.push({ id, ok: false, error: 'VM을 찾을 수 없습니다(현재 스냅샷에 없음)' }); continue; }
    if (!byVc.has(vcId)) byVc.set(vcId, []);
    byVc.get(vcId).push({ id, moref: morefOf(id, vcId) });
  }
  const cfg = loadVcenterConfig().vcenters;
  for (const [vcId, list] of byVc) {
    const vc = cfg.find((v) => v.id === vcId);
    if (!vc) { for (const x of list) results.push({ id: x.id, ok: false, error: 'vCenter 설정 없음' }); continue; }
    try {
      const r = await upgradeVmTools(vc, list.map((x) => x.moref));
      r.forEach((rr, i) => results.push({ id: list[i].id, ok: rr.ok, error: rr.error }));
    } catch (err) {
      for (const x of list) results.push({ id: x.id, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, requested: ids.length, succeeded: results.filter((r) => r.ok).length, results });
});

// Shared UI settings (e.g. dashboard map height) — same for all users.
api.get('/ui-settings', (_req, res) => res.json(loadUiSettings()));
// 전 사용자 공유 설정 쓰기 — viewer가 전역 UI 설정을 덮어쓰지 못하게 역할 제한(감사 C2 잔여).
api.put('/ui-settings', requireRole('admin', 'operator'), (req, res) => res.json(saveUiSettings(req.body || {})));
}
