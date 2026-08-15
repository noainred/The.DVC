// GuestOS/HBA/라이선스/Tools업그레이드/UI설정 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { loadUiSettings, saveUiSettings } from '../../ui-settings.js';
import { upgradeVmTools } from '../../vcenter/soapClient.js';
import { nsxStore } from '../../nsx/store.js';
import { licenseFamilyOf, licenseExpiryStatus } from '../../util/licenseExpiry.js';
import { collectHorizonLicenses, listHorizon } from '../../horizon/horizon.js';
import { memoJson, scopeKey, osFamily } from './shared.js';

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
api.get('/tools/guest-os', (req, res) => memoJson(req, res, 'tools-guest-os', (snap) => {
  let vms = snap.vms;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  // 전원(on/off) · 종류(vm/template) 필터
  if (req.query.power === 'on') vms = vms.filter((v) => v.powerState === 'POWERED_ON');
  else if (req.query.power === 'off') vms = vms.filter((v) => v.powerState !== 'POWERED_ON');
  if (req.query.kind === 'vm') vms = vms.filter((v) => !v.template);
  else if (req.query.kind === 'template') vms = vms.filter((v) => v.template);
  const byName = new Map();
  const byFamily = new Map();
  for (const v of vms) {
    const name = (v.guestOS || '미상').trim() || '미상';
    const on = v.powerState === 'POWERED_ON';
    const n = byName.get(name) || { os: name, family: osFamily(v.guestOS), total: 0, on: 0, off: 0 };
    n.total++; if (on) n.on++; else n.off++;
    byName.set(name, n);
    const fam = osFamily(v.guestOS);
    const f = byFamily.get(fam) || { family: fam, total: 0, on: 0 };
    f.total++; if (on) f.on++;
    byFamily.set(fam, f);
  }
  return {
    total: vms.length,
    distinctOs: byName.size,
    families: [...byFamily.values()].sort((a, b) => b.total - a.total),
    items: [...byName.values()].sort((a, b) => b.total - a.total),
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

// 특정 Guest OS(종류·버전) 또는 계열에 해당하는 VM 목록 — VM 수 클릭 시 대상 VM/CSV용.
// 쿼리: vcenterId·power(on/off)·kind(vm/template) + os(정확 일치) 또는 family(계열).
api.get('/tools/guest-os/vms', (req, res) => {
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
api.get('/tools/hba', (req, res) => {
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
api.get('/tools/licenses', (req, res) => {
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
api.get('/tools/license-expiry', async (req, res) => {
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
        expires: ts ? new Date(ts).toISOString().slice(0, 10) : '',
        status: st.status, daysLeft: st.daysLeft,
      });
    }
  }
  // NSX 매니저 직수집 라이선스 — vCenter 스코프 필터와 무관하므로 전체 조회에서만 포함.
  if (!scoped) {
    for (const m of (nsxStore.get()?.managers || [])) {
      for (const l of (m.licenses || [])) {
        const st = licenseExpiryStatus(l.expiry || null, { forcedExpired: l.isExpired });
        items.push({
          source: 'NSX', where: m.name || m.id, vcenterId: m.vcenterId || '',
          name: l.description || 'NSX License', family: 'NSX',
          edition: l.capacityType || '', product: 'NSX', productVersion: m.version || '',
          key: l.key || '', total: l.quantity ?? null, used: null,
          expires: l.expiry ? new Date(l.expiry).toISOString().slice(0, 10) : '',
          status: st.status, daysLeft: st.daysLeft,
        });
      }
    }
  }
  // Horizon Connection Server 직수집(등록된 서버가 있을 때만) — vCenter 스코프와 무관.
  const collectionErrors = [];
  if (!scoped) {
    try {
      const hz = await collectHorizonLicenses();
      for (const { server: s, lic: l } of hz.rows) {
        const st = licenseExpiryStatus(l.expiry || null, { forcedExpired: l.isExpired });
        items.push({
          source: 'Horizon', where: s.name || s.id, vcenterId: '',
          name: l.name, family: 'Horizon',
          edition: l.usageModel || '', product: 'Horizon', productVersion: '',
          key: l.key || '', total: null, used: null,
          expires: l.expiry ? new Date(l.expiry).toISOString().slice(0, 10) : '',
          status: st.status, daysLeft: st.daysLeft,
        });
      }
      for (const e of hz.errors) collectionErrors.push(`Horizon ${e.name || e.id}: ${e.reason}`);
    } catch (e) { collectionErrors.push(`Horizon: ${e.message}`); }
  }
  const summary = { expired: 0, expiring: 0, ok: 0, perpetual: 0 };
  for (const it of items) summary[it.status] = (summary[it.status] || 0) + 1;
  const families = [...new Set(items.map((i) => i.family))].sort();
  res.json({ items, summary, families, total: items.length, collectionErrors, horizonServers: listHorizon().length, generatedAt: snap.generatedAt });
});

// Trigger VMware Tools upgrade on one or more VMs. Body: { ids:[vmId,...] }.
api.post('/vms/upgrade-tools', requirePerm('tools'), async (req, res) => {
  let ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ ok: false, reason: '대상 VM이 없습니다.' });
  const snap = store.get();
  // 사용자 scope 강제(쓰기 경로) — id 는 `vcId:moref`. 범위 밖 vCenter 의 VM 에는 Tools 업그레이드를
  // 실행할 수 없다(범위 제한 계정이 타 사이트 VM 을 건드리는 것 차단).
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) {
    const vcOf = (id) => (id.indexOf(':') >= 0 ? id.slice(0, id.indexOf(':')) : id);
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
  for (const id of ids) {
    const sep = id.indexOf(':');
    const vcId = sep >= 0 ? id.slice(0, sep) : id;
    const moref = sep >= 0 ? id.slice(sep + 1) : '';
    if (!byVc.has(vcId)) byVc.set(vcId, []);
    byVc.get(vcId).push({ id, moref });
  }
  const cfg = loadVcenterConfig().vcenters;
  const results = [];
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
