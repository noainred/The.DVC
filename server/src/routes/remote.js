/**
 * Remote-access API: manage HAProxy Data Plane config + per-target SSH/RDP
 * mappings, and serve connection artifacts (.rdp file; SSH uses the WS gateway).
 * Mounted behind authMiddleware; mutating/config endpoints require admin.
 */

import { Router } from 'express';
import { store } from '../store.js';
import { requireRole, requirePerm } from '../auth/auth.js';
import { scopedVcenterIds } from '../auth/scope.js';
import {
  getConfig, getConfigSafe, saveConfig,
  listMappings, listMappingsForUser, getMapping, addMapping, removeMapping, setMappingStatus, touchMapping,
  listProxies, listProxiesSafe, getProxyById, resolveProxy, saveProxy, removeProxy,
} from '../proxy/registry.js';
import { testDataplane, applyMapping } from '../proxy/dataplane.js';
import { previewConfig, testDeploy, deployToProxy } from '../proxy/deploy.js';
import { provision, deprovision } from '../proxy/provision.js';
import { withSsh } from '../proxy/sshExec.js';
import { issueRdpTicket } from '../proxy/rdpTicket.js';
import { ssrfBlockReasonResolved, ipBlockReason } from '../collector/registry.js';

export const remoteRouter = Router();
const adminOnly = requireRole('admin');
const REDACT = '********'; // getConfigSafe 가 비밀을 가릴 때 쓰는 플레이스홀더(proxy/registry.js REDACT 와 동일)

// RDP 자격증명을 URL 쿼리스트링 대신 1회용 티켓으로 전달(감사 H18). 클라이언트는 접속 직전
// 이 엔드포인트로 자격증명을 보내 티켓 ID를 받고, WebSocket 쿼리엔 티켓 ID만 싣는다 →
// 비밀번호가 브라우저 히스토리/상위 프록시 액세스 로그에 남지 않는다. 터널과 동일 역할(admin/operator).
remoteRouter.post('/rdp-ticket', requirePerm('remote.access'), (req, res) => {
  const b = req.body || {};
  if (!b.username) return res.status(400).json({ ok: false, reason: '사용자명이 필요합니다.' });
  const ticket = issueRdpTicket({ username: b.username, password: b.password, domain: b.domain, security: b.security });
  res.json({ ok: true, ticket });
});

// Connection info for a mapping resolves through the mapping's assigned proxy.
const mappingProxy = (m) => getProxyById(m.proxyId);

// Public-ish (any authenticated user): list mappings + how to connect.
// v2.478(감사 S7): 목록도 remote.access 권한 게이트 — 비-admin 은 자기 소유 매핑만(listMappingsForUser).
remoteRouter.get('/mappings', requirePerm('remote.access'), (req, res) => {
  res.json({
    mappings: listMappingsForUser(req.user).map(({ error, ...m }) => {
      const p = mappingProxy(m);
      return { ...m, proxyName: p.name, proxyHost: p.proxyHost, guacdConfigured: !!p.guacd?.host };
    }),
  });
});

// Reachability probe: from the assigned proxy, ping the target and check the
// TCP port. Used to colour the VM "원격 접속" button (blue=open, red=closed).
// 선행 '-'를 막아 ping/포트체크에 플래그(인자) 주입을 차단(첫 글자는 영숫자/IP만).
const SAFE_HOST = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;

/**
 * targetHost 의 사용자 scope 검사(v2.320, 2026-08-13 감사 보류 갭 적용 — 순수, 테스트 고정).
 * 범위 계정은 **허용 vCenter 인벤토리에 실재하는 대상**(VM 의 IP/이름 또는 호스트 이름)만
 * 프로브/터널 생성 가능 — 임의 사내 IP 도달성 스캔(정찰)·범위 밖 피벗 준비를 차단한다.
 * 인벤토리에 없는 대상은 범위 계정에겐 거부('vCenter 귀속 없는 데이터 미노출' 규칙과 동일 취지).
 * 전체 범위 계정(allowed=null)은 기존 신뢰 모델 유지(임의 대상 허용 — 변화 없음).
 * @returns {string|null} 거부 사유(존재 여부를 흘리지 않는 일반 문구) 또는 null(허용)
 */
export function targetHostScopeIssue(snap, allowedSet, targetHost) {
  if (!allowedSet) return null;
  const t = String(targetHost || '').toLowerCase();
  for (const vm of snap.vms || []) {
    if (!allowedSet.has(vm.vcenterId)) continue;
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    if (ips.some((ip) => String(ip).toLowerCase() === t) || String(vm.name || '').toLowerCase() === t) return null;
  }
  for (const h of snap.hosts || []) {
    if (!allowedSet.has(h.vcenterId)) continue;
    if (String(h.name || '').toLowerCase() === t) return null; // 호스트 name 은 통상 FQDN/IP
  }
  return '범위 내 vCenter 의 VM/호스트(IP·이름)만 대상으로 할 수 있습니다.';
}
// 프록시에서 SSH로 ping/포트체크를 대행 — 내부망 도달성 탐침이므로 admin/operator만(감사 H3/H7).
remoteRouter.post('/probe', requirePerm('remote.access'), async (req, res) => {
  const { vcenterId, targetHost } = req.body || {};
  const targetPort = Math.min(65535, Math.max(1, Number((req.body || {}).targetPort) || 22));
  if (!targetHost || !SAFE_HOST.test(targetHost)) return res.status(400).json({ ok: false, reason: '대상 호스트가 올바르지 않습니다.' });
  {
    // v2.320 scope: 범위 계정의 내부망 도달성 스캔 차단(형식 검증만으로는 임의 IP 프로브 가능했음).
    const issue = targetHostScopeIssue(store.get(), scopedVcenterIds(req.user, store.get()), targetHost);
    if (issue) return res.status(403).json({ ok: false, reason: issue });
  }
  const proxy = resolveProxy(vcenterId);
  if (!proxy.deploy?.host || !proxy.deploy?.username) {
    return res.json({ ok: false, method: 'none', proxyName: proxy.name, reason: `프록시 '${proxy.name}'에 SSH(자동배포) 설정이 없어 사전 점검을 할 수 없습니다.` });
  }
  const creds = { host: proxy.deploy.host, port: proxy.deploy.port, username: proxy.deploy.username, password: proxy.deploy.password, privateKey: proxy.deploy.privateKey || undefined };
  try {
    const out = await withSsh(creds, async ({ exec }) => {
      const ping = await exec(`ping -c1 -W1 -- ${targetHost} 2>/dev/null | sed -n 's/.*time=\\([0-9.]*\\).*/\\1/p' | head -1`);
      const pingMs = parseFloat(ping.stdout.trim());
      const port = await exec(`timeout 2 bash -c '</dev/tcp/${targetHost}/${targetPort}' 2>/dev/null && echo OPEN || echo CLOSED`);
      return { pingOk: Number.isFinite(pingMs), pingMs: Number.isFinite(pingMs) ? pingMs : null, portOpen: port.stdout.includes('OPEN') };
    });
    res.json({ ok: true, method: 'ssh', proxyName: proxy.name, targetHost, targetPort, ...out });
  } catch (err) {
    res.json({ ok: false, method: 'ssh', proxyName: proxy.name, reason: err.message });
  }
});

// vCenter → proxy assignments (any authenticated user; secrets redacted for admin view).
remoteRouter.get('/proxies', requirePerm('remote.access'), (_req, res) => { // v2.480(3차 감사): 중계 주소는 원격접속 권한자에게만
  res.json({ proxies: listProxies().map((p) => ({ id: p.id, name: p.name, proxyHost: p.proxyHost, vcenterIds: p.vcenterIds, guacdConfigured: !!p.guacd?.host })) });
});

// Candidate targets from vCenter: VMs that have at least one IP, with all IPs
// so the user can pick which address to map (multi-homed VMs). Optional ?q / ?vcenterId.
remoteRouter.get('/targets', (req, res) => {
  const snap = store.get();
  const q = String(req.query.q || '').toLowerCase();
  const allowed = scopedVcenterIds(req.user, snap); // 사용자 scope 밖 VM(이름·IP)은 노출 금지
  const targets = [];
  for (const vm of snap.vms) {
    if (allowed && !allowed.has(vm.vcenterId)) continue;
    if (req.query.vcenterId && vm.vcenterId !== req.query.vcenterId) continue;
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    if (!ips.length) continue;
    if (q && !String(vm.name || '').toLowerCase().includes(q) && !ips.some((ip) => ip.includes(q))) continue;
    targets.push({ id: vm.id, name: vm.name, vcenterId: vm.vcenterId, guestOS: vm.guestOS, powerState: vm.powerState, ips });
  }
  targets.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  res.json({ targets: targets.slice(0, 500), total: targets.length });
});

remoteRouter.get('/config', adminOnly, (_req, res) => res.json({ config: getConfigSafe() }));

remoteRouter.put('/config', adminOnly, (req, res) => res.json({ ok: true, config: saveConfig(req.body || {}) }));

// --- per-vCenter proxy CRUD (admin) ---
remoteRouter.get('/proxies/full', adminOnly, (_req, res) => res.json({ proxies: listProxiesSafe() }));
remoteRouter.post('/proxies', adminOnly, (req, res) => {
  const r = saveProxy(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
remoteRouter.delete('/proxies/:id', adminOnly, (req, res) => {
  const r = removeProxy(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// Health check for one proxy — auto-selects Data Plane API or SSH deploy based
// on what the proxy has enabled. Returns { ok, ms, reason, method }.
remoteRouter.post('/proxies/:id/health', adminOnly, async (req, res) => {
  const proxy = getProxyById(req.params.id);
  if (!proxy) return res.status(404).json({ ok: false, reason: '프록시를 찾을 수 없습니다.', method: 'none' });
  try {
    if (proxy.dataplane?.enabled && proxy.dataplane?.url) {
      const r = await testDataplane(proxy.dataplane);
      return res.json({ ...r, method: 'dataplane' });
    }
    if (proxy.deploy?.enabled && proxy.deploy?.host) {
      const r = await testDeploy(proxy.deploy);
      return res.json({ ...r, method: 'ssh' });
    }
    return res.json({ ok: false, reason: '자동 프로비저닝(Data Plane/SSH) 미설정 — 수동 구성 프록시', method: 'manual' });
  } catch (err) {
    res.json({ ok: false, reason: err.message, method: 'error' });
  }
});

// Test a proxy's Data Plane API (by proxyId, or the default).
// ⚠ 보안(H-2, 2026-09-12 — v2.480 "연결 테스트 시 host/url 저장값 고정" 규칙 적용): 저장된 비밀번호를
// 재사용(플레이스홀더 또는 미입력)하면 접속 URL 도 저장값으로 고정한다. 그러지 않으면 admin 이 요청
// url 만 공격자 호스트로 바꾸고 password:'********' 를 보내 저장된 Data Plane 비밀번호를 그 호스트로
// 평문(Basic) 전송시킬 수 있다. 새 URL 을 시험하려면 비밀번호를 새로 입력해야 한다.
remoteRouter.post('/test', adminOnly, async (req, res) => {
  const proxy = getProxyById((req.body || {}).proxyId);
  const body = (req.body || {}).dataplane || {};
  const dp = { ...proxy.dataplane, ...body };
  const reuseSecret = body.password === REDACT || body.password === undefined;
  if (body.password === REDACT) dp.password = proxy.dataplane.password;
  if (reuseSecret) { dp.url = proxy.dataplane.url; dp.basePath = proxy.dataplane.basePath; }
  const block = await ssrfBlockReasonResolved(dp.url);
  if (block) return res.json({ ok: false, reason: `대상 주소가 차단되었습니다: ${block}`, method: 'blocked' });
  res.json(await testDataplane(dp));
});

// --- SSH-based proxy auto-deploy (alternative to Data Plane API) ---
// ⚠ 보안(H-2): 저장된 비밀번호/개인키를 재사용하면 접속 host/port 도 저장값으로 고정한다 —
// dep.host 만 바꿔 저장된 root 비밀번호·SSH 개인키를 공격자 sshd 로 보내는 것을 막는다.
remoteRouter.post('/deploy/test', adminOnly, async (req, res) => {
  const proxy = getProxyById((req.body || {}).proxyId);
  const body = (req.body || {}).deploy || {};
  const dep = { ...proxy.deploy, ...body };
  const reusePw = body.password === REDACT || body.password === undefined;
  const reuseKey = body.privateKey === REDACT || body.privateKey === undefined;
  if (body.password === REDACT) dep.password = proxy.deploy.password;
  if (body.privateKey === REDACT) dep.privateKey = proxy.deploy.privateKey;
  if ((reusePw && proxy.deploy.password) || (reuseKey && proxy.deploy.privateKey)) { dep.host = proxy.deploy.host; dep.port = proxy.deploy.port; }
  const block = ipBlockReason(dep.host);
  if (block) return res.json({ ok: false, reason: `대상 호스트가 차단되었습니다: ${block}`, method: 'blocked' });
  res.json(await testDeploy(dep));
});

// Push the generated HAProxy config for each proxy's mappings and reload.
remoteRouter.post('/deploy', adminOnly, async (req, res) => {
  const onlyId = (req.body || {}).proxyId;
  const results = [];
  for (const proxy of listProxies()) {
    if (onlyId && proxy.id !== onlyId) continue;
    if (!proxy.deploy?.enabled) continue;
    const ms = listMappings().filter((m) => (m.proxyId || 'default') === proxy.id);
    const r = await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' });
    if (r.ok) for (const m of ms) setMappingStatus(m.id, 'active', null);
    results.push({ proxy: proxy.name, ...r });
  }
  res.json({ ok: results.every((r) => r.ok), results });
});


// Create a mapping, then provision it on HAProxy. (admin-created = persistent)
remoteRouter.post('/mappings', adminOnly, async (req, res) => {
  const r = addMapping({ ...(req.body || {}), owner: req.user.username, ephemeral: false });
  if (!r.ok) return res.status(400).json(r);
  await provision(r.mapping);
  res.json({ ok: true, mapping: getMapping(r.mapping.id) });
});

// One-click connect from a VM detail: reuse an existing mapping for the same
// target+port+protocol, else create+provision one. 매핑 생성=프록시 경유 터널 개통이므로
// admin/operator만(감사 H3/H7/H14 — viewer의 오픈릴레이/내부 피벗 차단; WS 게이트웨이 역할
// 검사와 일관). targetHost 형식은 addMapping(SAFE_TARGET_HOST)이 최종 검증한다.
remoteRouter.post('/quick-connect', requirePerm('remote.access'), async (req, res) => {
  const { protocol = 'ssh', targetHost, vcenterId, name } = req.body || {};
  const proto = protocol === 'rdp' ? 'rdp' : 'ssh';
  const targetPort = Number((req.body || {}).targetPort) || (proto === 'rdp' ? 3389 : 22);
  if (!targetHost) return res.status(400).json({ ok: false, reason: '대상 IP가 필요합니다.' });
  {
    // v2.320 scope: 범위 계정은 범위 내 인벤토리 대상에만 터널 매핑 생성(범위 밖 피벗 준비 차단).
    const issue = targetHostScopeIssue(store.get(), scopedVcenterIds(req.user, store.get()), targetHost);
    if (issue) return res.status(403).json({ ok: false, reason: issue });
  }

  // Reuse this user's existing mapping for the same target, else create an
  // ephemeral one owned by them (auto-removed 1 day after last use).
  let m = listMappings().find((x) => x.targetHost === targetHost && Number(x.targetPort) === targetPort && x.protocol === proto && (!x.owner || x.owner === req.user.username));
  if (!m) {
    const r = addMapping({ name: name || `${proto.toUpperCase()} ${targetHost}`, vcenterId, protocol: proto, targetHost, targetPort, owner: req.user.username, ephemeral: true });
    if (!r.ok) return res.status(400).json(r);
    await provision(r.mapping);
    m = getMapping(r.mapping.id);
  } else {
    touchMapping(m.id); m = getMapping(m.id);
  }
  const p = mappingProxy(m);
  res.json({ ok: true, mapping: m, proxyName: p.name, proxyHost: p.proxyHost, guacdConfigured: !!p.guacd?.host });
});

// Re-apply (e.g. after fixing Data Plane settings).
remoteRouter.post('/mappings/:id/apply', adminOnly, async (req, res) => {
  const m = getMapping(req.params.id);
  if (!m) return res.status(404).json({ ok: false, reason: '매핑을 찾을 수 없습니다.' });
  try { await applyMapping(mappingProxy(m).dataplane, m); setMappingStatus(m.id, 'active', null); res.json({ ok: true, mapping: getMapping(m.id) }); }
  catch (err) { setMappingStatus(m.id, 'error', err.message); res.status(400).json({ ok: false, reason: err.message }); }
});

// v2.313 보안 감사 반영: 형제 라우트(apply=adminOnly, probe/quick-connect=requirePerm)와 달리
// RBAC 게이트가 없어 아무 인증 사용자나 도달했고, 소유자 검사도 `m.owner && ...` 단락 때문에
// **소유자 없는(레거시/시스템) 매핑**은 누구나 삭제(HAProxy 터널 강제 철거 — 가용성)할 수 있었다.
// (1) requirePerm('remote.access') 게이트 추가, (2) 소유자 없는 매핑은 admin 전용으로 보정.
remoteRouter.delete('/mappings/:id', requirePerm('remote.access'), async (req, res) => {
  const m = getMapping(req.params.id);
  if (!m) return res.status(404).json({ ok: false, reason: '매핑을 찾을 수 없습니다.' });
  // admin 은 전부, 그 외에는 **자기 소유** 매핑만. 소유자가 없는 매핑은 admin 만(단락 제거).
  if (req.user.role !== 'admin' && m.owner !== req.user.username) {
    return res.status(403).json({ ok: false, reason: '본인 접속 기록만 삭제할 수 있습니다(소유자 없는 매핑은 관리자만).' });
  }
  await deprovision(m);
  res.json(removeMapping(req.params.id));
});

// Download an .rdp file pointing at proxyHost:publicPort (client-side RDP).
// v2.478(감사 S8): 권한·소유자·scope 검사 없이 .rdp(중계 주소:포트)를 발급하던 경로. WS 게이트웨이와
// 같은 규칙(mappingAccessIssue 와 동일: 소유자 없는 매핑=admin 전용, 대상 호스트 scope)을 적용하고
// 위반은 404 로 존재를 숨긴다(조회 범위 밖 = 404 규약).
remoteRouter.get('/rdp/:id', requirePerm('remote.access'), (req, res) => {
  const m = getMapping(req.params.id);
  if (!m || m.protocol !== 'rdp') return res.status(404).end();
  if (req.user?.role !== 'admin') {
    if (m.owner !== req.user?.username) return res.status(404).end();
    if (targetHostScopeIssue(store.get(), scopedVcenterIds(req.user, store.get()), m.targetHost)) return res.status(404).end();
  }
  const proxyHost = mappingProxy(m).proxyHost;
  const host = proxyHost || m.targetHost;
  const port = proxyHost ? m.publicPort : m.targetPort;
  const rdp = [
    `full address:s:${host}:${port}`,
    'prompt for credentials:i:1',
    'administrative session:i:0',
    'screen mode id:i:2',
    'redirectclipboard:i:1',
    `gatewayhostname:s:`,
  ].join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'application/x-rdp');
  res.setHeader('Content-Disposition', `attachment; filename="${m.name.replace(/[^\w.-]/g, '_')}.rdp"`);
  res.send(rdp);
});
