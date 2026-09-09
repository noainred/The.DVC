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
  /*
   * 배포 대상 폴백(v2.435 — 감사 S2 로 좁힘).
   *
   * 예전에는 `role === 'irs'` 분기가 **자격증명 출처(배포 대상)와 접속 대상(토폴로지 입력값)을 분리**해서,
   * IRS IP 를 공격자 호스트로 적어 두고 sshTargetId 로 아무 배포 대상을 고르면 `agent-deploy-targets.json`
   * (봉인 저장·정상 API 로는 반환되지 않는 값)의 SSH 비밀번호가 그 호스트로 전송됐다 — 다른 비밀 저장소의
   * 자격증명을 이 도구로 끌어내는 교차 유출이다.
   *
   * 이제 배포 대상 자격증명은 **그 배포 대상 자신의 host 로 접속할 때만** 쓴다:
   *  · Edge/Main : 접속 host 가 배포 대상 host 와 같아야 한다(같은 IP 로 저장된 대상만 매칭되므로 자연히 성립).
   *  · IRS       : 중계 엣지를 경유하므로 '접속 host = 중계 엣지' 다. 그 중계 엣지가 **바로 그 배포 대상**일
   *                때만 허용한다(엣지 자신에 SSH 로 들어가는 것과 같은 신뢰 경계). 그 외에는 거부하고
   *                IRS 노드에 자체 자격증명을 입력하라고 안내한다.
   */
  const idMatch = site?.sshTargetId ? getTargetRaw(site.sshTargetId) : null;
  const hostMatch = listTargetsRaw().find((x) => [node.publicIp, node.privateIp].filter(Boolean).includes(String(x.host || '').trim()) && (x.password || x.privateKey));
  const t = idMatch || hostMatch;
  if (t && (t.password || t.privateKey)) {
    if (role !== 'irs') {
      const tHost = String(t.host || '').trim();
      if (![node.publicIp, node.privateIp].filter(Boolean).includes(tHost)) {
        return { error: `${role} 의 지정 배포 대상(${t.id})은 호스트가 ${tHost} 라 이 노드(${node.publicIp || node.privateIp})와 다릅니다 — 다른 서버의 자격증명을 보내지 않도록 거부했습니다. 노드에 자체 SSH 계정을 입력하세요.`, host, port, via };
      }
      return { host: tHost, port: Number(t.port) || 22, via, source: `deploy:${t.id}`, creds: { host: tHost, port: Number(t.port) || 22, username: t.username, password: t.password || undefined, privateKey: t.privateKey || undefined, passphrase: t.passphrase || undefined } };
    }
    // IRS: 접속 host 는 중계 엣지다. 그 엣지가 이 배포 대상 자신일 때만 자격증명을 쓴다.
    const edgeIps = [site?.edge?.publicIp, site?.edge?.privateIp].filter(Boolean);
    if (edgeIps.includes(String(t.host || '').trim()) && edgeIps.includes(host)) {
      return { host, port, via, source: `deploy:${t.id}`, creds: { host, port, username: t.username, password: t.password || undefined, privateKey: t.privateKey || undefined, passphrase: t.passphrase || undefined } };
    }
    return { error: `IRS 는 배포 대상(${t.id}, host ${t.host})의 자격증명을 쓸 수 없습니다 — 접속 대상(${host}:${port})이 그 배포 대상이 아니라, 다른 서버의 비밀번호가 전송될 수 있습니다. IRS 노드에 자체 SSH 계정을 입력하세요.`, host, port, via };
  }
  return { error: `${role} SSH 자격증명이 없습니다(토폴로지 노드의 ID/비밀번호·키 또는 배포 대상 ${node.publicIp || node.privateIp}).`, host, port, via };
}

const sudo = (creds) => (creds.username === 'root' ? '' : 'sudo -n ');
/**
 * `systemctl is-active` 출력 판정(순수, v2.435 — 감사 I1).
 * ⚠ 예전 정규식 `/active\s*$/` 는 **'inactive' 에도 매치**됐다(실측). 그래서 reload 실패로 haproxy 가
 * 내려앉아도 '성공' 으로 보고되고 롤백이 실행되지 않았다. 마지막 비어있지 않은 줄을 정확히 비교한다.
 */
export function isActiveOut(out) {
  const lines = String(out || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === 'active';
}
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
export function lastResults({ full = false } = {}) { return Object.fromEntries([..._last.entries()].map(([dc, r]) => [dc, full ? r : stripCfg(r)])); }
export function lastResult(dc, { full = false } = {}) { const r = _last.get(dc); return r ? (full ? r : stripCfg(r)) : null; }
/**
 * 응답 축약(v2.435 — 감사 S3). 예전 `stripCfg = (r) => r` 은 이름과 달리 아무것도 지우지 않아,
 * 원격 `haproxy.cfg` 전문·`portal.env` 발췌·노드 IP/커널이 그대로 나갔다. haproxy.cfg 에는 `stats auth`·
 * `insecure-password` 같은 자격증명이 관행적으로 들어간다. 조회 권한이 낮은 경로에는 **요약만** 준다.
 */
function stripCfg(r) {
  if (!r) return r;
  const node = (n) => (n ? { ...n, haproxy: n.haproxy ? { ...n.haproxy, cfg: '', cfgBytes: (n.haproxy.cfg || '').length } : n.haproxy,
    portal: n.portal ? { units: n.portal.units, env: [], envCount: (n.portal.env || []).length } : n.portal,
    node: n.node ? { hostname: n.node.hostname } : n.node } : n);
  return { ...r, edge: node(r.edge), irs: node(r.irs) };
}
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
      // S6(v2.435): `cat … || true` 는 '파일 없음' 과 '읽기 실패' 를 구분하지 못한다. 읽기에 실패했는데
      // 빈 문자열로 넘어가면 병합 결과가 **관리 블록만 담은 cfg** 가 되고, 그건 haproxy 문법상 유효해
      // `haproxy -c` 를 통과한 뒤 기존 global/defaults/listen 을 전부 날린다. 존재 여부를 별도 신호로 받는다.
      const cur = await exec(`test -f ${CFG} && echo __HAS__ || echo __NONE__; ${S}cat ${CFG} 2>/dev/null || true`, 15_000);
      const m0 = /^(__HAS__|__NONE__)\r?\n?/.exec(cur.stdout || '');
      const hadCfg = m0?.[1] === '__HAS__';
      const before = m0 ? (cur.stdout || '').slice(m0[0].length) : (cur.stdout || '');
      if (hadCfg && !before.trim()) {
        step('현재 cfg 읽기', false, `${CFG} 는 있는데 내용을 읽지 못했습니다(권한·I/O). 빈 파일로 간주하면 기존 설정을 통째로 잃으므로 중단합니다.`);
        return { applied: false };
      }
      step('현재 cfg 읽기', true, hadCfg ? `${before.length}바이트` : '기존 cfg 없음(새로 만듭니다)');
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
      // S5(v2.435): 예전에는 `test -f … && cp -a …; install …` 이라 **cp 가 실패해도 `;` 뒤의 install 이 진행**됐다.
      // 디스크 풀·ro 마운트·SELinux 로 백업이 안 된 채 원본을 덮어쓰면, reload 실패 시 롤백이 없는 백업을
      // 복사하려다 실패해 원본이 영구 유실된다. 백업 → 확인 → 교체를 `&&` 로 묶고 실패 코드를 구분한다.
      const b = await exec(`${S}sh -c 'set -e; if [ -f ${CFG} ]; then cp -a ${CFG} ${bak} || exit 91; [ -s ${bak} ] || exit 92; fi; install -m 644 ${tmp} ${CFG} || exit 93; rm -f ${tmp}; echo replaced'; echo "rc=$?"`, 15_000);
      const brc = Number((/rc=(\d+)/.exec(b.stdout) || [])[1]);
      if (!/replaced/.test(b.stdout)) {
        const why = brc === 91 ? `백업(cp -a ${CFG} → ${bak}) 실패 — 원본을 건드리지 않고 중단했습니다.`
          : brc === 92 ? `백업 파일이 비어 있습니다(${bak}) — 원본을 건드리지 않고 중단했습니다.`
            : brc === 93 ? `교체(install) 실패 — 백업은 ${bak} 에 있습니다.`
              : (b.stderr || b.stdout || '알 수 없는 오류');
        step('백업·교체', false, why);
        return { applied: false, merged, backup: hadCfg ? bak : '' };
      }
      step('백업·교체', true, hadCfg ? `백업 ${bak}` : '(기존 cfg 없음 — 백업 생략)');
      const rl = await exec(`${S}systemctl reload haproxy 2>&1 || ${S}systemctl restart haproxy 2>&1; ${S}systemctl is-active haproxy`, 30_000);
      const ok = isActiveOut(rl.stdout);   // I1(v2.435): 'inactive' 를 성공으로 읽던 정규식 제거
      step('reload/restart', ok, rl.stdout.trim());
      if (!ok && hadCfg) {
        const rb = await exec(`${S}sh -c 'cp -a ${bak} ${CFG} && (systemctl reload haproxy || systemctl restart haproxy) >/dev/null 2>&1; systemctl is-active haproxy'`, 30_000);
        const rbOk = isActiveOut(rb.stdout);
        step('롤백(백업 복원)', rbOk, rbOk ? `${bak} 복원 후 active` : `복원했으나 서비스가 ${rb.stdout.trim() || '미상'} 입니다 — 수동 확인 필요`);
        return { applied: false, rolledBack: true, rollbackOk: rbOk, merged, backup: bak };
      }
      if (!ok) { step('롤백 불가', false, '기존 cfg 가 없어 복원할 백업이 없습니다 — haproxy 상태를 직접 확인하세요.'); return { applied: false, merged }; }
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
