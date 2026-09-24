/**
 * relaytopo/haproxy.js — HAProxy 구성 생성·파싱·대조(순수, v2.431).
 *  - renderManagedBlock(site, services, main): 관리 블록(# BEGIN/END vmware-portal-relay) 텍스트. 기존 haproxy.cfg 의 다른 내용은 건드리지 않는다.
 *  - parseConfig(text): listen/frontend+backend 블록 → [{ name, binds:[port], mode, servers:[{host,port}], timeouts:{...} }]
 *  - diffConfig(expected, actual, site): 기대(토폴로지) vs 실제(엣지에서 가져온 cfg) 오류 목록.
 */
export const BEGIN = '# BEGIN vmware-portal-relay (자동 생성 — 이 블록은 포탈이 관리합니다. 수동 편집은 블록 밖에서)';
export const END = '# END vmware-portal-relay';

/** 서비스가 가리키는 백엔드 host:port 결정(순수). 못 정하면 null(예: IRS vCenter IP 미입력). */
export function backendFor(service, site, main) {
  const t = service.target;
  if (t === 'irs') return site.irs?.privateIp ? { host: site.irs.privateIp, port: service.targetPort } : null;
  if (t === 'irs-vcenter') return site.irs?.vcenterIp ? { host: site.irs.vcenterIp, port: service.targetPort } : null;
  if (t === 'edge-vcenter') return site.edge?.vcenterIp ? { host: site.edge.vcenterIp, port: service.targetPort } : null;
  if (t === 'main') { const h = main?.publicIp || main?.privateIp; return h ? { host: h, port: main?.portalPort || service.targetPort } : null; }
  return null;
}

export function renderManagedBlock(site, services, main) {
  const lines = [BEGIN, `# 사이트 ${site.dc} · 중계 엣지 ${site.edge?.privateIp || '?'}(${site.edge?.publicIp || '-'}) · IRS ${site.irs?.privateIp || '?'}`];
  const missing = [];
  for (const s of services.filter((x) => x.enabled !== false)) {
    const be = backendFor(s, site, main);
    if (!be) { missing.push(s); lines.push(`# (건너뜀) ${s.key} :${s.listenPort} — 백엔드 주소 미입력(${s.target})`); continue; }
    lines.push('', `listen relay_${s.key}_${s.listenPort}`, `    bind *:${s.listenPort}`, `    mode ${s.mode}`,
      '    timeout connect 10s', '    timeout client  10m', '    timeout server  10m',
      ...(s.mode === 'http' ? ['    option forwardfor', '    option http-server-close'] : []),
      `    server ${s.key} ${be.host}:${be.port} check`);
  }
  lines.push('', END);
  return { text: lines.join('\n'), missing };
}

/** 관리 블록을 기존 cfg 에 삽입/교체(순수). 블록이 없으면 끝에 추가. */
export function mergeManagedBlock(existing, block) {
  const src = String(existing || '');
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a >= 0 && b > a) return `${src.slice(0, a)}${block}${src.slice(b + END.length)}`;
  return `${src.trimEnd()}\n\n${block}\n`;   // v2.599(SEC2599-02): replace(/\s*$/) 는 O(n²) — 같은 뜻
}

/** haproxy.cfg 텍스트 파싱(순수) — listen 과 frontend/backend(default_backend 연결)를 같은 형태로. */
export function parseConfig(text) {
  const out = []; const fronts = []; const backs = new Map();
  let cur = null;
  const push = () => { if (!cur) return; if (cur.kind === 'listen') out.push(cur); else if (cur.kind === 'frontend') fronts.push(cur); else if (cur.kind === 'backend') backs.set(cur.name, cur); cur = null; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(listen|frontend|backend|defaults|global)\s*(\S*)/.exec(line);
    if (m) { push(); cur = { kind: m[1], name: m[2] || '', binds: [], mode: '', servers: [], timeouts: {}, defaultBackend: '' }; continue; }
    if (!cur) continue;
    const b = /^bind\s+(\S+)/.exec(line); if (b) { const p = Number(b[1].split(':').pop()); if (p) cur.binds.push(p); continue; }
    const md = /^mode\s+(\S+)/.exec(line); if (md) { cur.mode = md[1]; continue; }
    const sv = /^server\s+(\S+)\s+([^\s:]+):(\d+)/.exec(line); if (sv) { cur.servers.push({ name: sv[1], host: sv[2], port: Number(sv[3]) }); continue; }
    const tm = /^timeout\s+(\S+)\s+(\S+)/.exec(line); if (tm) { cur.timeouts[tm[1]] = tm[2]; continue; }
    const db = /^default_backend\s+(\S+)/.exec(line); if (db) { cur.defaultBackend = db[1]; continue; }
  }
  push();
  for (const f of fronts) { const bk = backs.get(f.defaultBackend); out.push({ ...f, kind: 'listen', servers: bk?.servers || [], mode: f.mode || bk?.mode || '', timeouts: { ...(bk?.timeouts || {}), ...f.timeouts } }); }
  return out.filter((x) => x.kind === 'listen');
}

/** 시간 문자열(10s/10m/5000) → ms. */
export function timeoutMs(v) { const m = /^(\d+)(ms|s|m|h)?$/.exec(String(v || '')); if (!m) return null; const n = Number(m[1]); return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3600_000 : n; }

/**
 * 기대(토폴로지) vs 실제(엣지 cfg) 대조 → 표 행 + 오류. runtime: { listeners:[port], active:boolean } (선택).
 * 반환 [{ key, listenPort, label, expected:{host,port}|null, actual:{host,port}|null, mode, status:'ok'|'missing'|'wrong-backend'|'self-loop'|'no-listener'|'unknown-backend'|'timeout', issue, fix }]
 */
export function diffConfig(services, site, main, actualBlocks, runtime = null) {
  const rows = [];
  const own = new Set([site.edge?.privateIp, site.edge?.publicIp].filter(Boolean));
  for (const s of services.filter((x) => x.enabled !== false)) {
    const expected = backendFor(s, site, main);
    const blk = actualBlocks.find((b) => b.binds.includes(s.listenPort));
    const actual = blk?.servers?.[0] ? { host: blk.servers[0].host, port: blk.servers[0].port } : null;
    const row = { key: s.key, label: s.label || s.key, listenPort: s.listenPort, target: s.target, expected, actual, mode: blk?.mode || '', status: 'ok', issue: '', fix: '' };
    if (!blk) { row.status = 'missing'; row.issue = `haproxy.cfg 에 :${s.listenPort} 을 bind 하는 블록이 없습니다.`; row.fix = `관리 블록 적용(listen relay_${s.key}_${s.listenPort}) 후 systemctl restart haproxy`; }
    else if (!actual) { row.status = 'unknown-backend'; row.issue = `:${s.listenPort} 블록에 server 줄이 없습니다.`; row.fix = 'server <백엔드 IP>:<포트> check 추가'; }
    else if (expected && own.has(actual.host) && actual.port === (main?.portalPort || 4000) && s.target === 'irs' && s.targetPort === 4000) { row.status = 'self-loop'; row.issue = `:${s.listenPort} 이 중계 엣지 자신(${actual.host}:${actual.port})으로 되돌아갑니다 — IRS 포탈이 아니라 Edge 포탈이 응답합니다.`; row.fix = `server 를 ${expected.host}:${expected.port} 로 수정`; }
    else if (expected && (actual.host !== expected.host || actual.port !== expected.port)) { row.status = 'wrong-backend'; row.issue = `백엔드가 ${actual.host}:${actual.port} 인데 토폴로지 기대값은 ${expected.host}:${expected.port} 입니다.`; row.fix = `server 를 ${expected.host}:${expected.port} 로 수정(또는 토폴로지 표의 IP 를 확인)`; }
    else if (!expected) { row.status = 'ok'; row.issue = '토폴로지에 백엔드 IP 가 없어 대조 생략(실제: ' + `${actual.host}:${actual.port})`; }
    if (row.status === 'ok' && blk) {
      const srv = timeoutMs(blk.timeouts.server), cli = timeoutMs(blk.timeouts.client);
      if ((srv != null && srv < 120_000) || (cli != null && cli < 120_000)) { row.status = 'timeout'; row.issue = `timeout client/server 가 2분 미만(${blk.timeouts.client || '-'} / ${blk.timeouts.server || '-'}) — RMA 롱폴·업그레이드 번들 전송이 끊깁니다.`; row.fix = 'timeout client 10m / timeout server 10m'; }
      if (s.mode === 'http' && blk.mode !== 'http') { row.status = row.status === 'ok' ? 'ok' : row.status; row.issue += ` mode 가 ${blk.mode || 'tcp'} (기대 http).`; }
    }
    if (runtime?.listeners && !runtime.listeners.includes(s.listenPort) && row.status === 'ok') { row.status = 'no-listener'; row.issue = `cfg 에는 있으나 :${s.listenPort} 리스너가 없습니다(HAProxy 미재시작 또는 설정 오류).`; row.fix = 'haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl restart haproxy'; }
    rows.push(row);
  }
  if (runtime && runtime.active === false) rows.unshift({ key: '_service', label: 'HAProxy 서비스', listenPort: 0, status: 'missing', issue: 'haproxy 서비스가 active 가 아닙니다.', fix: 'systemctl enable --now haproxy', expected: null, actual: null, mode: '' });
  return rows;
}
