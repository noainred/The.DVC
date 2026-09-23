/**
 * 중계 토폴로지 라우트(v2.431) — 특수기능 '중계 토폴로지(HAProxy 구성)'. 조회는 tools 권한, 저장/가져오기/적용은 admin + 감사.
 * 비밀(SSH 비밀번호/키)은 어떤 응답에도 없다(has* 플래그). 내보내기(JSON/CSV)도 비밀을 제외한다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { loadTopology, loadTopologyRaw, saveTopology, parseTopologyTable, topologyToCsv, mergeImport, normalizeTopology, redactTopology, DEFAULT_SERVICES, TARGETS } from '../../relaytopo/store.js';
import { validateTopology, kindForService } from '../../relaytopo/validate.js';
import { renderManagedBlock } from '../../relaytopo/haproxy.js';
import { fetchSite, fetchAll, applySite, testNode, lastResults, resolveNodeAccess } from '../../relaytopo/ops.js';
import { loadCollectors } from '../../collector/registry.js';
import { listTargets } from '../../agent/deployRegistry.js';
import { todayStamp } from "../../util/dayKey.js";

const adminOnly = requireRole('admin');
/**
 * v2.435(감사 S3): 조회를 **admin 전용**으로 올렸다.
 * 예전에는 `requirePerm('tools')` 였는데 `auth/permissions.js` 기준 **operator 가 tools 를 기본 보유**하므로,
 * 화면 카드가 adminOnly 여도 API 직접 호출로 원격 `haproxy.cfg` 전문·`portal.env` 발췌·배포 대상 목록·
 * 전 사이트 내부 IP 가 그대로 나갔다(`server/CLAUDE.md` "기능 권한은 서버가 진실의 원천" 위반).
 * haproxy.cfg 에는 `stats auth`·`insecure-password` 같은 자격증명이 관행적으로 들어간다.
 * tools 권한 계정에는 **요약만** 준다(cfg/env 본문 제거 — ops.stripCfg).
 */
const toolsPerm = requirePerm('tools');
// 거부 기본값 — authMiddleware 는 인증 비활성 시에도 req.user 를 AUTH_DISABLED_ROLE 로 채우므로
// (auth.js:909) 이 판정으로 충분하고, authMiddleware 없이 mount 되는 사고에도 데이터가 새지 않는다.
const isAdmin = (req) => req.user?.role === 'admin';
const RE_DC = /^[^\s/\\]{1,40}$/;

export function registerRelayTopo(api) {
api.get('/tools/relaytopo', toolsPerm, (req, res) => {
  const admin = isAdmin(req);
  const topo = loadTopology();
  const issues = validateTopology(topo, loadCollectors());
  const raw = loadTopologyRaw();
  const access = Object.fromEntries(raw.sites.map((s) => [s.dc, { edge: accessView(raw, s, 'edge'), irs: accessView(raw, s, 'irs') }]));
  access._main = { main: accessView(raw, null, 'main') };
  // v2.593(감사 AUTHZ-01 — 재현): tools 권한(operator 기본 보유)만으로 전 사이트 Main/Edge/IRS 의 사설·공인 IP·
  //   vCenter IP·SSH 계정명이 그대로 나갔다(카드는 adminOnly 지만 API 는 아니었다 — v2.555 '표시 관례 ≠ 접근제어').
  //   비-admin 에는 **주소·계정을 가리고** 그 사실을 밝힌다(v2.500 D/M1 relaycheck · v2.574 ping overview 와 같은 방식).
  //   점검 결과(issues)는 문구에 주소가 들어가므로 개수만 준다.
  res.json({
    ok: true, admin, topology: admin ? topo : maskTopology(topo), issues: admin ? issues : [],
    ...(admin ? {} : { addressHidden: true, issueCount: issues.length }),
    results: lastResults({ full: admin }),                       // 비-admin 에는 cfg/env 본문 제거
    access: admin ? access : {},                                 // 접속 경로·자격증명 출처는 admin 만
    targets: TARGETS, defaultServices: DEFAULT_SERVICES,
    deployTargets: admin ? listTargets().map((t) => ({ id: t.id, host: t.host, username: t.username })) : [],
    kinds: topo.services.map((s) => ({ key: s.key, kind: kindForService(s, topo.main) })),
  });
});
/** 비-admin 응답용 — 노드의 주소·SSH 계정명을 비운다(구조·서비스 구성·DC 이름은 남긴다). */
// v2.594(감사 R2594-06): 주소를 비우면 화면이 'IRS 있음' 을 판정할 수 없다 — 존재 여부만 불리언으로 남긴다.
const maskNode = (n) => (n ? { ...n, privateIp: '', publicIp: '', vcenterIp: '', present: !!(n.privateIp || n.publicIp), ssh: { ...(n.ssh || {}), username: '' } } : n);
function maskTopology(t) {
  return { ...t, main: maskNode(t.main), sites: (t.sites || []).map((s) => ({ ...s, edge: maskNode(s.edge), irs: maskNode(s.irs), sshTargetId: '' })) };
}
function accessView(raw, site, role) { const a = resolveNodeAccess(raw, site, role); return { host: a.host || '', port: a.port || 0, via: a.via || '', source: a.source || '', error: a.error || '' }; }

api.put('/tools/relaytopo', adminOnly, (req, res) => {
  try {
    const saved = saveTopology(req.body || {});
    logAudit({ user: req.user?.username, action: '중계 토폴로지 저장', detail: `sites=${saved.sites.length} services=${saved.services.map((s) => `${s.key}:${s.listenPort}`).join(',')}`, ip: req.ip });
    res.json({ ok: true, topology: saved, issues: validateTopology(saved, loadCollectors()) });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/** 가져오기: body { text?(표/CSV/TSV 붙여넣기 또는 파일 내용), json?(내보낸 JSON 객체), replace?, apply? }. apply=false 면 미리보기만. */
api.post('/tools/relaytopo/import', adminOnly, (req, res) => {
  try {
    const { text = '', json = null, replace = false, apply = false } = req.body || {};
    let parsed; let format = 'table';
    if (json && typeof json === 'object') { const n = normalizeTopology(json); parsed = { main: n.main, sites: n.sites, services: n.services, skipped: [] }; format = 'json'; }
    else if (typeof text === 'string' && text.trim().startsWith('{')) { const n = normalizeTopology(JSON.parse(text)); parsed = { main: n.main, sites: n.sites, services: n.services, skipped: [] }; format = 'json'; }
    else { if (String(text).length > 2_000_000) throw new Error('입력이 2MB 를 넘습니다.'); parsed = parseTopologyTable(text); }
    if (!parsed.sites.length && !(parsed.main?.privateIp || parsed.main?.publicIp)) return res.status(400).json({ ok: false, reason: '인식된 행이 없습니다. 열 순서(Datacenter, Server(Main/Edge/IRS), private IP, public IP …) 또는 내보낸 CSV/JSON 을 확인하세요.', skipped: parsed.skipped });
    const merged = mergeImport(loadTopologyRaw(), parsed, { replace: !!replace });
    const preview = redactTopology(normalizeTopology(merged, loadTopologyRaw()));
    if (!apply) return res.json({ ok: true, preview, format, parsedSites: parsed.sites.length, skipped: parsed.skipped.slice(0, 50), issues: validateTopology(preview, loadCollectors()) });
    const saved = saveTopology(merged);
    logAudit({ user: req.user?.username, action: '중계 토폴로지 가져오기', detail: `format=${format} sites=${parsed.sites.length} replace=${!!replace} skipped=${parsed.skipped.length}`, ip: req.ip });
    res.json({ ok: true, topology: saved, format, parsedSites: parsed.sites.length, skipped: parsed.skipped.slice(0, 50), issues: validateTopology(saved, loadCollectors()) });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/** 내보내기(비밀 없음): ?format=json|csv */
api.get('/tools/relaytopo/export', adminOnly, (req, res) => {
  const topo = loadTopology(); const day = todayStamp();
  logAudit({ user: req.user?.username, action: '중계 토폴로지 내보내기', detail: `format=${req.query.format || 'json'} sites=${topo.sites.length}`, ip: req.ip });
  if (String(req.query.format || 'json').toLowerCase() === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="relay-topology-${day}.csv"`);
    return res.send(topologyToCsv(topo));
  }
  const strip = (n) => ({ ...n, ssh: { port: n.ssh?.port || 22, username: n.ssh?.username || '' } });
  const out = { version: 1, exportedAt: new Date().toISOString(), note: '비밀(SSH 비밀번호/키)은 포함되지 않습니다.', main: strip(topo.main), services: topo.services, sites: topo.sites.map((s) => ({ ...s, edge: strip(s.edge), irs: strip(s.irs) })) };
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="relay-topology-${day}.json"`);
  res.send(JSON.stringify(out, null, 2));
});

api.get('/tools/relaytopo/render/:dc', adminOnly, (req, res) => {   // 관리 블록에는 전 사이트 내부 IP 가 들어간다(v2.435)
  const topo = loadTopology(); const site = topo.sites.find((s) => s.dc === req.params.dc);
  if (!site) return res.status(404).json({ ok: false, reason: '사이트가 없습니다.' });
  const { text, missing } = renderManagedBlock(site, topo.services, topo.main);
  res.json({ ok: true, dc: site.dc, text, missing: missing.map((m) => m.key) });
});

api.post('/tools/relaytopo/fetch', adminOnly, async (req, res) => {
  logAudit({ user: req.user?.username, action: '중계 토폴로지 전체 가져오기(SSH)', ip: req.ip });
  res.json({ ok: true, results: await fetchAll({ withIrs: req.body?.withIrs !== false }) });
});
api.post('/tools/relaytopo/fetch/:dc', adminOnly, async (req, res) => {
  if (!RE_DC.test(req.params.dc)) return res.status(400).json({ ok: false, reason: '잘못된 사이트 이름' });
  logAudit({ user: req.user?.username, action: '중계 토폴로지 가져오기(SSH)', target: req.params.dc, ip: req.ip });
  res.json(await fetchSite(req.params.dc, { withIrs: req.body?.withIrs !== false }));
});
api.post('/tools/relaytopo/apply/:dc', adminOnly, async (req, res) => {
  if (!RE_DC.test(req.params.dc)) return res.status(400).json({ ok: false, reason: '잘못된 사이트 이름' });
  const dryRun = !!req.body?.dryRun;
  if (!dryRun && req.body?.confirm !== true) return res.status(400).json({ ok: false, reason: '적용에는 confirm=true 가 필요합니다(중계 엣지의 haproxy.cfg 를 교체하고 reload 합니다).' });
  logAudit({ user: req.user?.username, action: dryRun ? '중계 HAProxy 구성 검증(모의)' : '중계 HAProxy 구성 적용', target: req.params.dc, ip: req.ip });
  const r = await applySite(req.params.dc, { dryRun });
  logAudit({ user: req.user?.username, action: `중계 HAProxy 구성 ${dryRun ? '검증' : '적용'} 결과`, target: req.params.dc, detail: `ok=${r.ok} applied=${!!r.applied} ${(r.steps || []).filter((s) => !s.ok).map((s) => s.name).join(',')}`, ip: req.ip });
  res.json(r);
});
api.post('/tools/relaytopo/test-ssh', adminOnly, async (req, res) => {
  const { dc = '', role = 'edge' } = req.body || {};
  if (!['edge', 'irs', 'main'].includes(role)) return res.status(400).json({ ok: false, reason: 'role 은 edge|irs|main' });
  if (role !== 'main' && !RE_DC.test(dc)) return res.status(400).json({ ok: false, reason: '잘못된 사이트 이름' });
  logAudit({ user: req.user?.username, action: '중계 토폴로지 SSH 테스트', target: `${dc || 'Main'}/${role}`, ip: req.ip });
  res.json(await testNode(dc, role));
});
}
