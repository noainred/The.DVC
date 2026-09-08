/**
 * relaytopo/validate.js — 입력한 토폴로지 표 자체의 오류 점검(순수, v2.431). SSH 없이 표만 보고 잡을 수 있는 것:
 *  중복 IP · Edge=IRS 같은 IP · IRS/vCenter IP 누락 · 서비스 listenPort 가 포탈 포트(4000)와 충돌 · 수집 서버 등록 누락/불일치.
 * 반환 [{ level:'error'|'warn'|'info', dc, code, text, fix }]
 */
const RE_IP4 = /^(\d{1,3}\.){3}\d{1,3}$/;

export function validateTopology(topo, collectors = []) {
  const out = [];
  const add = (level, dc, code, text, fix = '') => out.push({ level, dc, code, text, fix });
  const main = topo.main || {}; const services = (topo.services || []).filter((s) => s.enabled !== false); const sites = topo.sites || [];
  if (!main.privateIp && !main.publicIp) add('warn', '', 'main-missing', '중앙(Main) 포탈 IP 가 없습니다 — HQ 포탈(:4001) 백엔드를 만들 수 없습니다.', 'Main 행에 private/public IP 를 입력');
  const portalSvc = services.find((s) => s.listenPort === (main.portalPort || 4000));
  if (portalSvc) add('error', '', 'listen-portal-conflict', `서비스 '${portalSvc.key}' 의 listen 포트 ${portalSvc.listenPort} 가 포탈 포트와 같습니다 — 중계 엣지 자신의 포탈(:${main.portalPort || 4000})이 리슨 실패하거나 haproxy 가 기동하지 못합니다.`, '서비스 listen 포트를 4065~4068 대역으로 변경');
  if (portalSvc == null && !services.some((s) => s.target === 'irs' && s.targetPort === (main.portalPort || 4000))) add('info', '', 'no-irs-portal', 'IRS 포탈로 가는 서비스가 없습니다(예: portal 4068 → irs:4000). 중앙이 IRS 수집 서버에 닿을 수 없습니다.', 'services 에 portal 4068→irs:4000 추가');
  for (const s of services) {
    if (s.listenPort < 1024 && s.listenPort !== 22) add('warn', '', 'listen-low', `서비스 '${s.key}' listen ${s.listenPort} 은 특권 포트입니다 — 방화벽 정책/기존 데몬과 충돌할 수 있습니다.`);
    if (s.target === 'main' && s.targetPort !== (main.portalPort || 4000)) add('warn', '', 'hq-port', `서비스 '${s.key}'(main) 의 대상 포트 ${s.targetPort} 가 Main 포탈 포트 ${main.portalPort || 4000} 와 다릅니다.`, '대상 포트를 Main 포탈 포트로 맞춤');
  }
  // IP 중복(전 사이트 × 역할)
  const seen = new Map();
  const note = (ipv, where) => { if (!ipv) return; const k = ipv; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(where); };
  note(main.privateIp, 'Main private'); note(main.publicIp, 'Main public');
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
  const portOf = (u) => { try { const x = new URL(u); return Number(x.port) || (x.protocol === 'https:' ? 443 : 80); } catch { return 0; } };
  const cols = collectors.filter((c) => c.enabled !== false && c.url).map((c) => ({ id: c.id, dc: c.datacenter || '', host: hostOf(c.url), port: portOf(c.url) }));
  const irsPortalSvc = services.find((s) => s.target === 'irs' && s.targetPort === (main.portalPort || 4000));
  for (const s of sites) {
    const e = s.edge || {}, i = s.irs || {};
    for (const [ipv, w] of [[e.privateIp, `${s.dc} Edge private`], [e.publicIp, `${s.dc} Edge public`], [i.privateIp, `${s.dc} IRS private`], [i.publicIp, `${s.dc} IRS public`]]) note(ipv, w);
    if (!e.privateIp && !e.publicIp) add('error', s.dc, 'edge-missing', `${s.dc}: 중계 엣지(Edge DVC) IP 가 없습니다.`, 'Edge 행에 IP 입력');
    if (!i.privateIp && !i.publicIp) add('warn', s.dc, 'irs-missing', `${s.dc}: IRS IP 가 없습니다 — IRS 포탈/SSH 서비스(:4067/:4068)를 만들 수 없습니다(단독 사이트면 무시).`, 'IRS 행 입력 또는 서비스 비활성');
    if (e.privateIp && i.privateIp && e.privateIp === i.privateIp) add('error', s.dc, 'edge-eq-irs', `${s.dc}: Edge 와 IRS 의 private IP 가 같습니다(${e.privateIp}) — IRS 포트가 중계 엣지 자신으로 되돌아갑니다(self-loop).`, 'IRS 행의 IP 를 실제 IRS 서버 IP 로 수정');
    if (i.privateIp && !i.vcenterIp && services.some((x) => x.target === 'irs-vcenter')) add('warn', s.dc, 'irs-vc-missing', `${s.dc}: IRS 사이트 vCenter IP 가 없어 IRS vCenter 서비스 백엔드를 만들 수 없습니다.`, 'IRS 행의 vCenter IP 입력');
    if (!e.vcenterIp && services.some((x) => x.target === 'edge-vcenter')) add('info', s.dc, 'edge-vc-missing', `${s.dc}: Edge 사이트 vCenter IP 가 없어 Edge vCenter 서비스(:4065) 백엔드를 만들 수 없습니다.`, 'Edge 행의 vCenter IP 입력');
    for (const [ipv, w] of [[e.privateIp, 'Edge private'], [e.publicIp, 'Edge public'], [i.privateIp, 'IRS private'], [i.publicIp, 'IRS public'], [e.vcenterIp, 'Edge vCenter'], [i.vcenterIp, 'IRS vCenter']]) if (ipv && !RE_IP4.test(ipv)) add('info', s.dc, 'not-ipv4', `${s.dc} ${w} '${ipv}' 는 IPv4 가 아닙니다(호스트명이면 중계 엣지에서 DNS 해석이 돼야 합니다).`);
    // 수집 서버 대조 — 중앙이 접속하는 주소(Edge public 우선)
    const reach = e.publicIp || e.privateIp;
    if (reach && cols.length) {
      const edgeCol = cols.find((c) => c.host === reach && c.port === (main.portalPort || 4000));
      if (!edgeCol) add('warn', s.dc, 'collector-edge-missing', `${s.dc}: 수집 서버 목록에 Edge 포탈(http://${reach}:${main.portalPort || 4000})이 없습니다.`, '설정 › 수집 서버에 Edge 포탈 등록(또는 엣지 자기등록)');
      else if (edgeCol.dc && edgeCol.dc !== s.dc) add('warn', s.dc, 'collector-dc-mismatch', `${s.dc}: Edge 포탈 수집 서버 '${edgeCol.id}' 의 법인이 '${edgeCol.dc}' 로 다릅니다.`, '수집 서버의 법인을 맞춤');
      if (irsPortalSvc && (i.privateIp || i.publicIp)) {
        const irsCol = cols.find((c) => c.host === reach && c.port === irsPortalSvc.listenPort);
        if (!irsCol) add('warn', s.dc, 'collector-irs-missing', `${s.dc}: 수집 서버 목록에 IRS 포탈(http://${reach}:${irsPortalSvc.listenPort}, 중계 엣지 경유)이 없습니다.`, `설정 › 수집 서버에 http://${reach}:${irsPortalSvc.listenPort} 등록`);
        else if (edgeCol && irsCol.id === edgeCol.id) add('error', s.dc, 'collector-same-id', `${s.dc}: Edge 와 IRS 포탈이 같은 수집 서버 id 로 등록돼 있습니다.`, '서로 다른 id 로 등록');
      }
      const direct = cols.find((c) => (c.host === i.privateIp || c.host === i.publicIp) && c.host);
      if (direct) add('info', s.dc, 'collector-irs-direct', `${s.dc}: 수집 서버 '${direct.id}' 가 IRS 를 직접(${direct.host}) 가리킵니다 — 구성도상 중앙은 IRS 에 직접 닿지 않습니다(중계 엣지 :${irsPortalSvc?.listenPort || 4068} 경유).`, `URL 을 http://${reach}:${irsPortalSvc?.listenPort || 4068} 로 변경`);
    }
    if (!s.sshTargetId && !(e.ssh?.username) && !(e.ssh?.hasPassword || e.ssh?.hasPrivateKey || e.ssh?.password || e.ssh?.privateKey)) add('info', s.dc, 'edge-no-ssh', `${s.dc}: Edge SSH 계정이 없습니다 — '가져오기/적용'은 같은 IP 의 배포 대상이 있을 때만 됩니다.`, 'Edge 행에 SSH ID/비밀번호 또는 키 입력');
  }
  for (const [ipv, where] of seen) if (where.length > 1) add('error', '', 'dup-ip', `IP ${ipv} 가 ${where.length}곳에 있습니다: ${where.join(', ')}`, '표에서 중복 IP 확인');
  return out;
}

/** 서비스 키 → 경로 점검(relaycheck) kind 매핑(순수). 매핑 불가면 null. */
export function kindForService(s, main) {
  const pp = main?.portalPort || 4000;
  if (s.target === 'main') return 'hq-portal';
  if (s.target === 'irs-vcenter') return 'irs-vcenter';
  if (s.target === 'edge-vcenter') return 'edge-vcenter';
  if (s.target === 'irs' && s.targetPort === 22) return 'irs-ssh';
  if (s.target === 'irs' && s.targetPort === pp) return 'irs-portal';
  return null;
}
