// 수집기 CRUD/운영·데이터센터·VM 재구성 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { requirePerm, setLocalPassword } from '../../auth/auth.js';
import { store } from '../../store.js';
import { forceCollectorToken } from '../../agent/deploy.js';
import { listTargets, getTargetRaw } from '../../agent/deployRegistry.js';
import { logAudit } from '../../audit.js';
import { loadVcenterConfig } from '../../config.js';
import { getVmHardware, reconfigVm } from '../../provision/reconfig.js';
import { listCollectors, addCollector, updateCollector, removeCollector, loadCollectors, ssrfBlockReason } from '../../collector/registry.js';
import { clearCollectorServers } from '../../collector/remoteInventory.js';
import { listDatacenters, getDatacenterAssign, addDatacenter, updateDatacenter, removeDatacenter, setVcenterDatacenterMany, getDatacenterOrder, saveDatacenterOrder } from '../../datacenter/store.js';
import { allCollectorStatus, clearCollectorHosts } from '../../collector/state.js';
import { pullNow } from '../../collector/puller.js';
import { pushUpgradeToCollectors } from '../../collector/upgradePush.js';
import { resilientFetch } from '../../util/resilientFetch.js';
import { resolveBundleBytes, lastBundleReject } from '../../upgrade/bundleSource.js';
import { upgradeManager } from '../../upgrade/manager.js';
import { adminOnly, ensureCollectorDatacenter } from './shared.js';


// ── VM 사양 변경(ReconfigVM) — vCPU/RAM/디스크 증설·추가, NIC 추가/삭제 (관리자) ──────────
// vmId 형식 '<vcId>:<moref>'. 스냅샷으로 VM 존재·vCenter 자격증명을 확인한 뒤 SOAP 실행.
function resolveVmTarget(vmId) {
  const snap = store.get();
  const vm = (snap.vms || []).find((v) => v.id === vmId);
  if (!vm) return { error: 'VM을 찾을 수 없습니다(현재 스냅샷에 없음 — 해당 vCenter 연결이 끊겼거나 폴링 전일 수 있습니다).', code: 404 };
  if (snap.source === 'mock') return { error: '데모(mock) 모드에서는 사양 변경을 사용할 수 없습니다.', code: 400 };
  const sep = String(vmId).indexOf(':');
  const vcId = sep >= 0 ? vmId.slice(0, sep) : vmId;
  const moref = sep >= 0 ? vmId.slice(sep + 1) : '';
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcId);
  // vCenter가 이 포탈에 직접 등록돼 있지 않으면(위임/엣지 수집 vCenter) 자격증명이 없어 사양 변경 불가.
  if (!vc) return { error: `이 VM의 vCenter('${vcId}')가 이 포탈에 등록되어 있지 않아 사양 변경을 할 수 없습니다(위임/엣지 수집 vCenter). 해당 vCenter가 직접 등록된 포탈에서 변경하세요.`, code: 400 };
  return { vm, vc, moref, snap };
}

export function registerCollectorsDc(adminRouter) {

// ---- Distributed collection: remote collector agents ----------------------

// List registered collectors (tokens redacted) + live pull status.
adminRouter.get('/collectors', adminOnly, (_req, res) => {
  res.json({ collectors: listCollectors(), status: allCollectorStatus() });
});

adminRouter.post('/collectors', adminOnly, (req, res) => {
  // 관리자 UI 등록 = 수동 고정(managed) — 엣지 자기등록이 URL/토큰을 덮어쓰지 못하게.
  const result = addCollector(req.body || {}, { managed: true });
  if (result.ok) { ensureCollectorDatacenter(result.collector); pullNow().catch(() => {}); logAudit({ user: req.user?.username, action: '수집 서버 등록', target: result.collector?.id || '', detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' }); }
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/collectors/:id', adminOnly, (req, res) => {
  // 관리자 UI 수정 = 수동 고정(managed) — 저장한 URL/토큰이 자기등록으로 원복되던 버그 방지.
  const result = updateCollector(req.params.id, req.body || {}, { managed: true });
  if (result.ok) {
    ensureCollectorDatacenter(result.collector);
    // 비활성화 시 그 수집기의 원격 데이터도 즉시 걷어낸다 — 풀러는 disabled를 건너뛰므로
    // 남겨두면 서버 분석/전력 화면에 유령 서버가 재시작 전까지 계속 표시된다.
    if (result.collector?.enabled === false) { clearCollectorHosts(req.params.id); clearCollectorServers(req.params.id); }
    pullNow().catch(() => {});
    logAudit({ user: req.user?.username, action: '수집 서버 수정', target: req.params.id, detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' });
  }
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/collectors/:id', adminOnly, (req, res) => {
  const result = removeCollector(req.params.id);
  if (result.ok) {
    clearCollectorHosts(req.params.id);   // 원격 전력 병합 상태 제거
    clearCollectorServers(req.params.id); // 서버 분석용 원격 인벤토리 제거(유령 서버 방지)
    logAudit({ user: req.user?.username, action: '수집 서버 삭제', target: req.params.id, ip: req.ip || '' });
  }
  res.status(result.ok ? 200 : 404).json(result);
});

// 엣지 포탈 로컬 계정 비밀번호 일괄 변경 — 기본(admin) 비번을 중앙에서 한 번에 교체.
// Body: { username?='admin', password, ids?: string[](미지정=활성 전체), includeCentral?: boolean }
// 엣지의 /api/collector/set-password(COLLECTOR_TOKEN 가드)로 병렬 푸시. 비밀번호는 어디에도 로깅하지 않는다.
adminRouter.post('/collectors/set-password', adminOnly, async (req, res) => {
  const username = String(req.body?.username || 'admin').trim();
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ ok: false, reason: '비밀번호는 8자 이상이어야 합니다.' });
  if (password.length > 128) return res.status(400).json({ ok: false, reason: '비밀번호는 128자 이하여야 합니다.' });
  const idFilter = Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids.map(String)) : null;
  const targets = loadCollectors().filter((c) => c.enabled !== false && c.url && (!idFilter || idFilter.has(String(c.id))));

  const results = await Promise.all(targets.map(async (c) => {
    if (!c.token) return { id: c.id, name: c.name || c.id, ok: false, reason: '이 수집 서버에 저장된 토큰이 없습니다(수정에서 토큰 입력).' };
    try {
      const r = await resilientFetch(`${String(c.url).replace(/\/+$/, '')}/api/collector/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Collector-Token': c.token },
        body: JSON.stringify({ username, password }),
        timeoutMs: 15_000, retries: 1,
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 404) return { id: c.id, name: c.name || c.id, ok: false, reason: '엣지가 이 기능을 지원하지 않습니다(v2.107 미만 — 먼저 업그레이드하세요).' };
      if (r.status === 403) return { id: c.id, name: c.name || c.id, ok: false, reason: '토큰 불일치(엣지 COLLECTOR_TOKEN 확인).' };
      return { id: c.id, name: c.name || c.id, ok: r.ok && body.ok !== false, reason: body.reason || (r.ok ? null : `HTTP ${r.status}`), edgeVersion: body.version || null, totpEnabled: body.totpEnabled || false };
    } catch (e) {
      return { id: c.id, name: c.name || c.id, ok: false, reason: `연결 실패: ${e.message}` };
    }
  }));

  // 옵션: 중앙 포탈 자신의 동일 계정도 함께 변경(엣지/중앙 비번 통일용).
  let central = null;
  if (req.body?.includeCentral === true) {
    const r = setLocalPassword(username, password);
    central = { ok: r.ok, reason: r.reason || null };
  }

  const okN = results.filter((r) => r.ok).length;
  logAudit({ user: req.user?.username, action: '엣지 비밀번호 일괄 변경', target: username, detail: `성공 ${okN}/${results.length}${central ? ` · 중앙 ${central.ok ? '변경' : '실패'}` : ''}`, ip: req.ip || '' });
  res.json({ ok: true, username, total: results.length, succeeded: okN, results, central });
});

// ── DataCenter(법인) — vCenter의 상위 개념. 설정에서 종류 정의 + vCenter 할당 (관리자) ────────
adminRouter.get('/datacenters', adminOnly, (_req, res) => {
  // 백필: 등록된 수집 서버의 데이터센터를 DataCenter 목록에 없으면 자동 생성(이미 등록된 OC1 같은
  // 수집기도 재등록 없이 '스캔 대역 추가' 등에서 바로 보이게 한다). idempotent.
  try { for (const c of loadCollectors()) ensureCollectorDatacenter(c); } catch { /* best effort */ }
  res.json({ datacenters: listDatacenters(), assign: getDatacenterAssign() });
});
adminRouter.post('/datacenters', adminOnly, (req, res) => {
  const r = addDatacenter(req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 등록', target: r.datacenter?.id || '', detail: r.datacenter?.name || '', ip: req.ip || '' });
  res.status(r.ok ? 201 : 400).json(r);
});
// '/datacenters/assign'을 '/:id'보다 먼저 둬야 라우트 충돌이 없다.
adminRouter.put('/datacenters/assign', adminOnly, (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 5000) : [];
  if (!entries.length) return res.status(400).json({ ok: false, reason: 'entries가 비었습니다.' });
  const r = setVcenterDatacenterMany(entries);
  if (r.ok) logAudit({ user: req.user?.username, action: 'vCenter→DataCenter 할당', target: `${r.changed}건`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.put('/datacenters/:id', adminOnly, (req, res) => {
  const r = updateDatacenter(req.params.id, req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 수정', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/datacenters/:id', adminOnly, (req, res) => {
  const r = removeDatacenter(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 삭제', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 404).json(r);
});
// DataCenter 표시 순서(vCenter 순서와 동일한 개념) — 모든 'DataCenter 선택' 목록에 적용.
adminRouter.get('/datacenter-order', adminOnly, (_req, res) => {
  res.json({ order: getDatacenterOrder(), datacenters: listDatacenters().map((d) => ({ id: d.id, name: d.name, region: d.region || '' })) });
});
adminRouter.put('/datacenter-order', adminOnly, (req, res) => {
  const r = saveDatacenterOrder((req.body || {}).order);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 순서 변경', detail: `${(r.order || []).length}개`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// 현재 하드웨어 + NIC 추가용 네트워크 목록.
adminRouter.get('/vm/:id/hardware', requirePerm('vm.reconfig'), async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  try {
    const hw = await getVmHardware(t.vc, t.moref);
    // 이름 자연정렬(숫자 접미사 고려: uplink1 < uplink10, VMAX-2 < VMAX-10).
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    const networks = (t.snap.networks || [])
      .filter((n) => n.vcenterId === t.vc.id)
      .map((n) => ({ id: n.id, name: n.name, type: n.type, moref: String(n.id).split(':').slice(1).join(':') }))
      .sort(byName);
    // 디스크 추가 시 선택할 데이터스토어 후보(해당 vCenter). 이름순으로 정렬(여유/총용량은 라벨에 표시).
    const datastores = (t.snap.datastores || [])
      .filter((d) => d.vcenterId === t.vc.id)
      .map((d) => ({ name: d.name, freeGB: d.freeGB, capacityGB: d.capacityGB }))
      .sort(byName);
    res.json({ ok: true, vmName: t.vm.name, powerState: hw.powerState, hw, networks, datastores });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

// 사양 변경 실행. body: { numCPUs?, memoryMB?, diskGrows?, diskAdds?, nicAdds?, nicRemoves? }
adminRouter.post('/vm/:id/reconfig', requirePerm('vm.reconfig'), async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  const b = req.body || {};
  const plan = {
    numCPUs: b.numCPUs != null ? Number(b.numCPUs) : undefined,
    coresPerSocket: b.coresPerSocket != null ? Number(b.coresPerSocket) : undefined,
    memoryMB: b.memoryMB != null ? Number(b.memoryMB) : undefined,
    diskGrows: Array.isArray(b.diskGrows) ? b.diskGrows.slice(0, 64) : [],
    diskAdds: Array.isArray(b.diskAdds) ? b.diskAdds.slice(0, 16).map((a) => ({
      sizeGB: a?.sizeGB, controllerKey: a?.controllerKey,
      datastore: a?.datastore ? String(a.datastore) : undefined,
    })) : [],
    nicAdds: Array.isArray(b.nicAdds) ? b.nicAdds.slice(0, 10) : [],
    nicRemoves: Array.isArray(b.nicRemoves) ? b.nicRemoves.slice(0, 10) : [],
    nicConnects: Array.isArray(b.nicConnects) ? b.nicConnects.slice(0, 20) : [],
  };
  // 선택한 데이터스토어가 이 vCenter의 실제 데이터스토어인지 검증(오타·타 vCenter 차단).
  const validDs = new Set((t.snap.datastores || []).filter((d) => d.vcenterId === t.vc.id).map((d) => d.name));
  for (const a of plan.diskAdds) {
    if (a.datastore && !validDs.has(a.datastore)) return res.status(400).json({ ok: false, reason: `데이터스토어 '${a.datastore}'를 찾을 수 없습니다(이 vCenter의 데이터스토어를 선택하세요).` });
  }
  try {
    const r = await reconfigVm(t.vc, t.moref, plan);
    logAudit({
      user: req.user?.username, action: 'VM 사양 변경',
      target: t.vm.name,
      detail: r.ok ? (r.changes || []).join(', ') : `실패: ${r.error}`,
      ip: req.ip || '',
    });
    if (r.ok) { store.refresh().catch(() => {}); return res.json({ ok: true, changes: r.changes }); }
    res.status(400).json({ ok: false, reason: r.error, changes: r.changes });
  } catch (e) {
    logAudit({ user: req.user?.username, action: 'VM 사양 변경', target: t.vm.name, detail: `오류: ${e.message}`, ip: req.ip || '' });
    res.status(502).json({ ok: false, reason: e.message });
  }
});

// Trigger an immediate pull of all collectors.
adminRouter.post('/collectors/pull', adminOnly, async (_req, res) => {
  await pullNow();
  res.json({ ok: true, status: allCollectorStatus() });
});

// Push an upgrade bundle to collector agents. Body: { id?, force? }.
// Brings one (id) or all registered agents up to the central portal's version.
adminRouter.post('/collectors/upgrade', adminOnly, async (req, res) => {
  const { id, force } = req.body || {};
  const bundle = await resolveBundleBytes(upgradeManager.settings);
  if (!bundle) {
    // 무결성 검증 실패(sha 불일치/부재)와 '번들 자체가 없음'을 구분해 알린다.
    const why = lastBundleReject();
    return res.status(409).json({ ok: false, reason: why || '업그레이드 번들을 찾을 수 없습니다 (감시 폴더/원격 소스 확인).' });
  }
  const results = await pushUpgradeToCollectors(bundle.bytes, { ids: id ? [id] : null, force: Boolean(force) });
  const ok = results.filter((r) => r.ok).length;
  res.json({ ok: true, version: bundle.version, source: bundle.source, pushed: results.length, succeeded: ok, results });
});

// Test connectivity to one collector (saved by id, or an ad-hoc {url, token}).
adminRouter.post('/collectors/test', adminOnly, async (req, res) => {
  const body = req.body || {};
  let { url, token } = body;
  if (body.id) { const saved = loadCollectors().find((c) => c.id === body.id); if (saved) { url = url || saved.url; token = token || saved.token; } }
  if (!url) return res.status(400).json({ ok: false, reason: 'url이 필요합니다.' });
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  // SSRF 방어: 링크로컬/클라우드 메타데이터 주소로는 토큰을 붙여 요청하지 않는다(등록 경로와 동일 가드).
  const ssrf = ssrfBlockReason(url);
  if (ssrf) return res.status(400).json({ ok: false, reason: ssrf });
  const started = Date.now();
  let retried = 0;
  try {
    // 단발 fetch는 고RTT·일시적 네트워크 블립에 '가끔 연결 안 됨'으로 오판된다 → 재시도로 흡수.
    const r = await resilientFetch(`${url.replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', ...(token ? { 'X-Collector-Token': token } : {}) },
      timeoutMs: config.collector.timeoutMs, retries: 2,
      onRetry: () => { retried++; },
    });
    if (!r.ok) {
      // 서버가 준 사유(collector 라우터의 error 필드)와 상태코드별 해결 힌트를 함께 안내한다.
      let serverMsg = '';
      try { const j = await r.json(); serverMsg = j?.error || j?.reason || ''; } catch { /* 본문 없음/비JSON */ }
      const hint = r.status === 404
        ? "수집 서버에 COLLECTOR_TOKEN이 설정되지 않았습니다(export 비활성). 그 에이전트를 'COLLECTOR_TOKEN=<토큰>' 환경변수와 함께 실행/재시작하세요(리눅스: /etc/vmware-portal/portal.env)."
        : (r.status === 403 || r.status === 401)
          ? '토큰 불일치(인증 실패). 이 화면의 토큰을 에이전트의 COLLECTOR_TOKEN과 동일하게 맞추세요.'
          : (r.status === 405 || r.status === 400)
            ? '이 주소가 수집 에이전트(포탈)가 아닐 수 있습니다. URL/포트를 확인하세요.'
            : '';
      return res.json({ ok: false, reason: `HTTP ${r.status}${serverMsg ? ` — ${serverMsg}` : ''}${hint ? ` · ${hint}` : ''}`, status: r.status, ms: Date.now() - started, retried });
    }
    const data = await r.json();
    res.json({ ok: true, ms: Date.now() - started, retried, hosts: data.hosts, version: data.version, datacenter: data.datacenter });
  } catch (err) {
    res.json({ ok: false, reason: err.message, ms: Date.now() - started, retried });
  }
});

// 토큰 강제 동기화 — 연결 테스트가 403(토큰 불일치)일 때, 수집 서버 URL의 호스트와 일치하는
// 'Edge 노드 포탈 설치' 저장 대상(SSH)을 찾아 엣지 portal.env의 COLLECTOR_TOKEN을 이 화면의
// 토큰으로 교체·재시작하고, 중앙 저장 토큰도 같은 값으로 고정(managed)한 뒤 재검증한다.
adminRouter.post('/collectors/:id/force-token', adminOnly, async (req, res) => {
  const saved = loadCollectors().find((c) => c.id === req.params.id);
  if (!saved) return res.status(404).json({ ok: false, reason: `없는 수집 서버: ${req.params.id}` });
  const token = String(req.body?.token || saved.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, reason: '토큰이 없습니다. 이 화면에서 토큰을 입력(또는 자동 생성)한 뒤 다시 시도하세요.' });
  let url = String(req.body?.url || saved.url || '').trim();
  if (url && !/^https?:\/\//.test(url)) url = `http://${url}`;
  const ssrf = url ? ssrfBlockReason(url) : 'URL이 없습니다.';
  if (ssrf) return res.status(400).json({ ok: false, reason: ssrf });
  let host = ''; let urlPort = 0;
  try { const u = new URL(url); host = u.hostname; urlPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { /* 아래에서 처리 */ }
  if (!host) return res.status(400).json({ ok: false, reason: '수집 서버 URL에서 호스트를 확인할 수 없습니다.' });
  const target = listTargets().map((t) => getTargetRaw(t.id)).find((t) => t && String(t.host || '').trim() === host);
  if (!target) {
    return res.status(404).json({ ok: false, reason: `SSH 배포 대상에 ${host} 가 없습니다. '수집 서버 → 원격 법인(DC)에 Edge 노드 포탈 설치'에서 이 호스트를 먼저 저장(SSH 계정 포함)하세요.` });
  }
  // URL 포트를 실제 서비스 중인 인스턴스를 역추적해 적용 — 같은 호스트 다중 인스턴스(:4000/:4001)나
  // NAT 포워딩(다른 장비)일 때 기본 인스턴스만 고치고 '성공'으로 오판하던 버그 방지.
  const r = await forceCollectorToken(target, token, { urlPort });
  logAudit({ user: req.user?.username, action: '수집 서버 토큰 강제 동기화', target: `${saved.id} (${host})`, detail: r.ok ? `성공 · 서비스 ${r.active}` : `실패 — ${r.reason}`, ip: req.ip || '' });
  if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, host, sshTarget: target.id, log: r.log });
  // 중앙 저장 토큰도 동일 값으로 고정(managed) — 엣지 자기등록이 이 값을 덮어쓰지 않게.
  const upd = updateCollector(saved.id, { ...saved, token, url: saved.url }, { managed: true });
  // 재검증: 새 토큰으로 export가 200인지 확인(서비스 기동 직후라 재시도 여유).
  let verified = false; let verifyReason = '';
  try {
    const vr = await resilientFetch(`${String(saved.url || url).replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', 'X-Collector-Token': token },
      timeoutMs: config.collector.timeoutMs, retries: 2,
    });
    verified = vr.ok;
    if (!vr.ok) verifyReason = `HTTP ${vr.status}`;
  } catch (e) { verifyReason = e.message; }
  if (verified) pullNow().catch(() => {});
  res.json({ ok: true, host, sshTarget: target.id, active: r.active, unit: r.unit, envFile: r.envFile, note: r.note || undefined, savedToken: upd.ok, verified, verifyReason: verified ? undefined : verifyReason });
});
}
