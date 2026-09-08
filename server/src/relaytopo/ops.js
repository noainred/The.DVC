/**
 * relaytopo/ops.js — 중계 토폴로지 노드에 SSH 로 들어가 실제 구성을 가져오고(HAProxy cfg·서비스·리스너·포탈 env) 대조하며,
 * 생성한 관리 블록을 검증(haproxy -c) 후 적용한다(v2.431).
 *
 * 규약(CLAUDE.md): 노드당 타임아웃은 withDeadline+signal 로 **세션을 실제로 끊는다**. 전체 가져오기는 동시 4개 제한. 재진입 가드(DC 단위).
 * 자격증명: 토폴로지 노드에 입력한 SSH(ip/id/pw/키) → 없으면 배포 대상(sshTargetId 또는 같은 IP) 순. IRS 는 중앙에서 직접 닿지 않으므로
 * 중계 엣지의 SSH 서비스 포트(기본 :4067)를 경유한다(토폴로지에 그 서비스가 있을 때).
 */
import { withSsh, withDeadline } from '../proxy/sshExec.js';
import { getTargetRaw, listTargetsRaw } from '../agent/deployRegistry.js';
import { ipBlockReason } from '../collector/registry.js';
import { loadTopologyRaw } from './store.js';
import { renderManagedBlock, mergeManagedBlock, parseConfig, diffConfig } from './haproxy.js';

const TIMEOUT_MS = Math.max(10_000, Number(process.env.RELAYTOPO_SSH_TIMEOUT_MS) || 45_000);
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.RELAYTOPO_CONCURRENCY) || 4));
const CFG = '/etc/haproxy/haproxy.cfg';
const ENV_KEYS = 'PORT|CENTRAL_URL|EDGE_ADVERTISE_URL|AGENT_NAME|COLLECTOR_DATACENTER|COLLECTOR_NAME|EDGE_NAME|TRUST_PROXY';

const _last = new Map();   // dc → 마지막 가져오기 결과
const _busy = new Set();   // 진행 중 dc

/** 노드 접속 정보(순수): 어디로(host:port) 어떤 자격증명으로. 비밀은 반환에 포함(내부용). */
export function resolveNodeAccess(topo, site, role) {
  const main = topo.main || {};
  const node = role === 'main' ? main : site?.[role];
  if (!node) return { error: '노드가 없습니다.' };
  let host = node.publicIp || node.privateIp; let port = node.ssh?.port || 22; let via = '';
  if (role === 'irs' && site) {
    const relay = (topo.services || []).find((s) => s.enabled !== false && s.target === 'irs' && s.targetPort === (node.ssh?.port || 22));
    const edgeHost = site.edge?.publicIp || site.edge?.privateIp;
    if (relay && edgeHost) { host = edgeHost; port = relay.listenPort; via = `중계 엣지 ${edgeHost}:${relay.listenPort} 경유(${relay.key})`; }
  }
  if (!host) return { error: `${role} IP 가 없습니다.` };
  const blocked = ipBlockReason(host); if (blocked) return { error: blocked };
  const own = node.ssh || {};
  if (own.username && (own.password || own.privateKey)) return { host, port, via, source: 'topology', creds: { host, port, username: own.username, password: own.password || undefined, privateKey: own.privateKey || undefined, passphrase: own.passphrase || undefined } };
  const t = (site?.sshTargetId && getTargetRaw(site.sshTargetId)) || listTargetsRaw().find((x) => [node.publicIp, node.privateIp].includes(String(x.host || '').trim()) && (x.password || x.privateKey));
  if (t && role !== 'irs') return { host: t.host, port: Number(t.port) || 22, via, source: `deploy:${t.id}`, creds: { host: t.host, port: Number(t.port) || 22, username: t.username, password: t.password || undefined, privateKey: t.privateKey || undefined } };
  if (t && role === 'irs') return { host, port, via, source: `deploy:${t.id}`, creds: { host, port, username: t.username, password: t.password || undefined, privateKey: t.privateKey || undefined } };
  return { error: `${role} SSH 자격증명이 없습니다(토폴로지 노드의 ID/비밀번호·키 또는 배포 대상 ${node.publicIp || node.privateIp}).`, host, port, via };
}

const sudo = (creds) => (creds.username === 'root' ? '' : 'sudo -n ');
const listenPorts = (out) => [...new Set(String(out || '').split(/\s+/).map((a) => Number(a.split(':').pop())).filter((n) => n > 0))];

/** 노드 1개 검사(SSH 1세션, 노드당 타임아웃). role: 'edge'|'irs'|'main'. */
export async function inspectNode(topo, site, role, { timeoutMs = TIMEOUT_MS, trace = null } = {}) {
  const acc = resolveNodeAccess(topo, site, role);
  const base = { role, dc: site?.dc || '', host: acc.host || '', port: acc.port || 0, via: acc.via || '', source: acc.source || '', at: Date.now() };
  if (acc.error) return { ...base, ok: false, error: acc.error };
  const t0 = Date.now();
  try {
    const r = await withDeadline(timeoutMs, (signal) => withSsh({ ...acc.creds, signal, trace }, async ({ exec }) => {
      const S = sudo(acc.creds);
      const id = await exec("hostname; echo ---; hostname -I 2>/dev/null || ip -4 -o addr 2>/dev/null | awk '{print $4}'; echo ---; uname -r; echo ---; id -un", 15_000);
      const [hostname, ips, kernel, user] = id.stdout.split('---').map((x) => x.trim());
      const ha = await exec(`${S}systemctl is-active haproxy 2>/dev/null; echo ---; ${S}systemctl is-enabled haproxy 2>/dev/null; echo ---; haproxy -v 2>/dev/null | head -1; echo ---; test -f ${CFG} && echo cfg-yes || echo cfg-no`, 15_000);
      const [active, enabled, ver, hasCfg] = ha.stdout.split('---').map((x) => x.trim());
      const cfg = hasCfg === 'cfg-yes' ? await exec(`${S}cat ${CFG} 2>/dev/null`, 15_000) : { stdout: '' };
      const ss = await exec(`ss -ltnH 2>/dev/null | awk '{print $4}' || netstat -ltn 2>/dev/null | awk 'NR>2{print $4}'`, 15_000);
      const portal = await exec(`${S}systemctl list-units --type=service --all --no-legend --plain 'vmware-portal*' 2>/dev/null | awk '{print $1, $3, $4}'; echo ---; grep -hE '^(${ENV_KEYS})=' /etc/vmware-portal/*.env 2>/dev/null | head -40`, 15_000);
      const [units, env] = portal.stdout.split('---').map((x) => x.trim());
      return {
        node: { hostname, ips: ips.split(/\s+/).filter(Boolean), kernel, user },
        haproxy: { installed: !!ver, version: ver, active: active === 'active', activeText: active || 'unknown', enabled: enabled === 'enabled', hasCfg: hasCfg === 'cfg-yes', cfg: cfg.stdout || '' },
        listeners: listenPorts(ss.stdout),
        portal: { units: units.split('\n').filter(Boolean).map((l) => { const [unit, activeState, sub] = l.split(/\s+/); return { unit, active: activeState, sub }; }), env: env.split('\n').filter(Boolean) },
      };
    }), `노드 SSH 타임아웃(${site?.dc || 'Main'} ${role})`);
    delete r.log; // 명령 로그(cfg 전문 중복) 제거
    return { ...base, ok: true, ms: Date.now() - t0, ...r };
  } catch (e) { return { ...base, ok: false, ms: Date.now() - t0, error: e.message }; }
}

/** 사이트 가져오기: Edge(필수) + IRS(선택) 검사 → 서비스 대조 표. 재진입 가드(dc). */
export async function fetchSite(dc, { withIrs = true, timeoutMs = TIMEOUT_MS } = {}) {
  const topo = loadTopologyRaw();
  const site = topo.sites.find((s) => s.dc === dc);
  if (!site) return { ok: false, reason: `사이트 '${dc}' 가 없습니다.` };
  if (_busy.has(dc)) return { ok: false, reason: `사이트 '${dc}' 가져오기가 진행 중입니다(겹침 방지).` };
  _busy.add(dc);
  try {
    const edge = await inspectNode(topo, site, 'edge', { timeoutMs });
    const irs = withIrs && (site.irs?.privateIp || site.irs?.publicIp) ? await inspectNode(topo, site, 'irs', { timeoutMs }) : null;
    const services = topo.services.filter((s) => s.enabled !== false);
    let rows = [];
    if (edge.ok) rows = diffConfig(services, site, topo.main, parseConfig(edge.haproxy.cfg), { listeners: edge.listeners, active: edge.haproxy.installed ? edge.haproxy.active : false });
    if (edge.ok && !edge.haproxy.installed) rows.unshift({ key: '_haproxy', label: 'HAProxy', listenPort: 0, status: 'missing', issue: 'haproxy 가 설치돼 있지 않습니다.', fix: 'dnf install -y haproxy && systemctl enable --now haproxy (그 뒤 관리 블록 적용)', expected: null, actual: null, mode: '' });
    // IRS 쪽 확인: 포탈 유닛이 돌고 IRS 포탈 포트를 리슨하는지
    const irsIssues = [];
    if (irs?.ok) {
      const pp = topo.main.portalPort || 4000;
      if (!irs.listeners.includes(pp)) irsIssues.push({ level: 'error', text: `IRS 가 :${pp} 를 리슨하지 않습니다(포탈 미기동) — 중계 :${services.find((s) => s.target === 'irs' && s.targetPort === pp)?.listenPort || 4068} 이 503/연결 거부가 됩니다.`, fix: 'IRS 에서 systemctl status vmware-portal 확인' });
      const centralUrl = irs.portal.env.find((l) => l.startsWith('CENTRAL_URL='))?.slice(12) || '';
      const hq = services.find((s) => s.target === 'main');
      const edgeHost = site.edge.privateIp || site.edge.publicIp;
      if (hq && centralUrl && !centralUrl.includes(`:${hq.listenPort}`)) irsIssues.push({ level: 'warn', text: `IRS 의 CENTRAL_URL(${centralUrl})이 중계 엣지의 HQ 포트(:${hq.listenPort})를 지나지 않습니다 — 구성도상 IRS 는 Edge ${edgeHost}:${hq.listenPort} 로 중앙에 갑니다.`, fix: `portal.env CENTRAL_URL=http://${edgeHost}:${hq.listenPort}` });
      const adv = irs.portal.env.find((l) => l.startsWith('EDGE_ADVERTISE_URL='))?.slice(19) || '';
      const irsSvc = services.find((s) => s.target === 'irs' && s.targetPort === pp);
      if (irsSvc && !adv) irsIssues.push({ level: 'warn', text: `IRS 에 EDGE_ADVERTISE_URL 이 없습니다 — 자기등록 시 중앙이 피어 IP(중계 엣지)를 URL 로 잘못 유도합니다.`, fix: `portal.env EDGE_ADVERTISE_URL=http://${site.edge.publicIp || edgeHost}:${irsSvc.listenPort}` });
    }
    if (edge.ok && edge.portal.units.length && !edge.listeners.includes(topo.main.portalPort || 4000)) irsIssues.push({ level: 'warn', text: `Edge 가 :${topo.main.portalPort || 4000} 를 리슨하지 않습니다(Edge 포탈 미기동).`, fix: 'systemctl status vmware-portal' });
    // summary.bad 는 대조 문제 + Edge 접속 실패(1) + IRS 오류 수준 항목 — Edge 에 못 들어가면 '문제 0건' 으로 보이면 안 된다.
    const result = { ok: true, dc, at: Date.now(), edge, irs, rows, irsIssues, summary: { total: rows.length, bad: rows.filter((r) => r.status !== 'ok').length + (edge.ok ? 0 : 1) + irsIssues.filter((i) => i.level === 'error').length, edgeFailed: !edge.ok, irsFailed: !!(irs && !irs.ok) } };
    _last.set(dc, result);
    return result;
  } finally { _busy.delete(dc); }
}

async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (let n = it.next(); !n.done; n = it.next()) await fn(n.value); }));
}
export async function fetchAll(opts = {}) {
  const topo = loadTopologyRaw(); const out = [];
  await pool(topo.sites.map((s) => s.dc), CONCURRENCY, async (dc) => { out.push(await fetchSite(dc, opts)); });
  return out;
}
export function lastResults() { return Object.fromEntries([..._last.entries()].map(([dc, r]) => [dc, stripCfg(r)])); }
export function lastResult(dc) { const r = _last.get(dc); return r ? stripCfg(r) : null; }
/** 응답용: cfg 전문은 남기되 노드 비밀은 없음(inspectNode 가 비밀을 반환하지 않음). */
const stripCfg = (r) => r;
export function _resetForTest() { _last.clear(); _busy.clear(); }

/**
 * 관리 블록 적용: 현재 cfg 가져오기 → 병합 → 임시 파일 → haproxy -c 검증 → 백업 → 교체 → reload(실패 시 restart) → 리스너 확인.
 * dryRun=true 면 검증까지만(파일 교체 없음). 검증 실패 시 원본 불변.
 */
export async function applySite(dc, { dryRun = false, timeoutMs = TIMEOUT_MS * 2 } = {}) {
  const topo = loadTopologyRaw();
  const site = topo.sites.find((s) => s.dc === dc);
  if (!site) return { ok: false, reason: `사이트 '${dc}' 가 없습니다.` };
  if (_busy.has(dc)) return { ok: false, reason: `사이트 '${dc}' 작업이 진행 중입니다(겹침 방지).` };
  const acc = resolveNodeAccess(topo, site, 'edge');
  if (acc.error) return { ok: false, reason: acc.error };
  const { text: block, missing } = renderManagedBlock(site, topo.services, topo.main);
  _busy.add(dc);
  const steps = [];
  const step = (name, ok, detail = '') => steps.push({ name, ok, detail: String(detail || '').slice(0, 2000) });
  try {
    const r = await withDeadline(timeoutMs, (signal) => withSsh({ ...acc.creds, signal }, async ({ exec }) => {
      const S = sudo(acc.creds);
      const ver = await exec('haproxy -v 2>/dev/null | head -1', 15_000);
      if (!ver.stdout.trim()) { step('haproxy 확인', false, 'haproxy 가 설치돼 있지 않습니다. dnf install -y haproxy 후 다시 시도'); return { applied: false }; }
      step('haproxy 확인', true, ver.stdout.trim());
      const cur = await exec(`${S}cat ${CFG} 2>/dev/null || true`, 15_000);
      const before = cur.stdout || '';
      const merged = mergeManagedBlock(before, block);
      if (merged === before) { step('변경 없음', true, '관리 블록이 이미 같습니다.'); return { applied: false, unchanged: true, merged }; }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const tmp = `/tmp/haproxy.cfg.portal-${ts}`;
      const b64 = Buffer.from(merged, 'utf8').toString('base64');
      const w = await exec(`printf '%s' '${b64}' | base64 -d > ${tmp} && chmod 600 ${tmp} && echo written`, 15_000);
      if (!/written/.test(w.stdout)) { step('임시 파일 기록', false, w.stderr || w.stdout); return { applied: false }; }
      step('임시 파일 기록', true, tmp);
      const chk = await exec(`${S}haproxy -c -f ${tmp} 2>&1; echo "rc=$?"`, 30_000);
      const rc = Number((/rc=(\d+)/.exec(chk.stdout) || [])[1]);
      if (rc !== 0) { step('haproxy -c 검증', false, chk.stdout.replace(/rc=\d+\s*$/, '')); await exec(`rm -f ${tmp}`, 5000).catch(() => {}); return { applied: false, merged }; }
      step('haproxy -c 검증', true, chk.stdout.replace(/rc=\d+\s*$/, '').trim() || 'Configuration file is valid');
      if (dryRun) { await exec(`rm -f ${tmp}`, 5000).catch(() => {}); step('모의 실행', true, '검증만 수행(파일 교체 없음)'); return { applied: false, dryRun: true, merged }; }
      const bak = `${CFG}.bak-${ts}`;
      const b = await exec(`${S}sh -c 'test -f ${CFG} && cp -a ${CFG} ${bak}; install -m 644 ${tmp} ${CFG} && rm -f ${tmp} && echo replaced'`, 15_000);
      if (!/replaced/.test(b.stdout)) { step('교체', false, b.stderr || b.stdout); return { applied: false, merged }; }
      step('백업·교체', true, before ? `백업 ${bak}` : '(기존 cfg 없음)');
      const rl = await exec(`${S}systemctl reload haproxy 2>&1 || ${S}systemctl restart haproxy 2>&1; echo "rc=$?"; ${S}systemctl is-active haproxy`, 30_000);
      const ok = /\nactive\s*$/.test(`\n${rl.stdout.trim()}`) || /active\s*$/.test(rl.stdout.trim());
      step('reload/restart', ok, rl.stdout.trim());
      if (!ok && before) { const rb = await exec(`${S}sh -c 'cp -a ${bak} ${CFG} && (systemctl reload haproxy || systemctl restart haproxy); systemctl is-active haproxy'`, 30_000); step('롤백(백업 복원)', /active/.test(rb.stdout), rb.stdout.trim()); return { applied: false, rolledBack: true, merged }; }
      const ss = await exec(`ss -ltnH 2>/dev/null | awk '{print $4}'`, 15_000);
      const ports = listenPorts(ss.stdout);
      const want = topo.services.filter((s) => s.enabled !== false && !missing.some((m) => m.key === s.key)).map((s) => s.listenPort);
      const lacking = want.filter((p) => !ports.includes(p));
      step('리스너 확인', lacking.length === 0, lacking.length ? `리슨 안 됨: ${lacking.join(', ')}` : `리슨 중: ${want.join(', ')}`);
      return { applied: true, merged, listeners: ports, backup: bak };
    }), `적용 SSH 타임아웃(${dc})`);
    delete r.log; // base64 cfg 를 담은 명령 로그는 응답에서 제외
    return { ok: steps.every((s) => s.ok), dc, at: Date.now(), steps, block, missing: missing.map((m) => m.key), ...r };
  } catch (e) { step('SSH', false, e.message); return { ok: false, dc, at: Date.now(), reason: e.message, steps, block, missing: missing.map((m) => m.key) }; }
  finally { _busy.delete(dc); }
}

/** SSH 접속 테스트(노드 1개) — hostname/계정만 확인. */
export async function testNode(dc, role, { timeoutMs = 20_000 } = {}) {
  const topo = loadTopologyRaw();
  const site = role === 'main' ? null : topo.sites.find((s) => s.dc === dc);
  if (role !== 'main' && !site) return { ok: false, reason: `사이트 '${dc}' 가 없습니다.` };
  const acc = resolveNodeAccess(topo, site, role);
  if (acc.error) return { ok: false, reason: acc.error, host: acc.host, port: acc.port, via: acc.via };
  const t0 = Date.now(); const trace = [];
  try {
    const r = await withDeadline(timeoutMs, (signal) => withSsh({ ...acc.creds, signal, trace: (m, lv) => trace.push({ at: Date.now(), m, lv }) }, async ({ exec }) => exec('echo RELAY-OK; hostname; id -un', 10_000)), 'SSH 테스트 타임아웃');
    return { ok: /RELAY-OK/.test(r.stdout), host: acc.host, port: acc.port, via: acc.via, source: acc.source, detail: r.stdout.trim(), ms: Date.now() - t0, trace };
  } catch (e) { return { ok: false, host: acc.host, port: acc.port, via: acc.via, source: acc.source, reason: e.message, ms: Date.now() - t0, trace }; }
}
