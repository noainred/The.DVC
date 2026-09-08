/**
 * relaycheck/remedy.js — 점검 실패 → 원인 후보와 해결방안(순수, v2.429). 문구는 추측을 사실처럼 쓰지 않는다("…가능성이 큽니다").
 * @param {object} r { kind, host, port, phase, error, expect:{agent}, got:{agent, hostname} }
 * @returns { title, cause, steps:string[], haproxy:string }
 */
import { KINDS } from './settings.js';

const snippet = (port, backend, mode = 'tcp') => `# /etc/haproxy/haproxy.cfg (중계 엣지)
listen fwd_${port}
    bind *:${port}
    mode ${mode}
    timeout connect 10s
    timeout client  10m
    timeout server  10m
    server target ${backend} check`;

export function remedyFor(r = {}) {
  const kind = KINDS[r.kind] ? r.kind : 'edge-portal';
  const k = KINDS[kind].label;
  const hp = `${r.host}:${r.port}`;
  const err = String(r.error || '');
  const backendHint = kind === 'irs-portal' ? '<IRS IP>:4000' : kind === 'irs-ssh' ? '<IRS IP>:22' : kind === 'irs-vcenter' ? '<IRS vCenter IP>:443' : kind === 'edge-vcenter' ? '<이 사이트 vCenter IP>:443' : kind === 'hq-portal' ? '<중앙 IP>:4000' : '(자기 포탈 — 포워딩 아님)';
  const restart = 'sudo haproxy -c -f /etc/haproxy/haproxy.cfg && sudo systemctl restart haproxy && sudo systemctl status haproxy';
  const phase = r.phase || (/ECONNREFUSED/.test(err) ? 'refused' : /타임아웃|timeout|ETIMEDOUT|무응답/i.test(err) ? 'timeout' : /EHOSTUNREACH|ENETUNREACH/.test(err) ? 'unreach' : 'unknown');
  if (phase === 'refused') {
    return { title: `${k} ${hp}: 포트에 리스너가 없음(연결 거부)`, cause: kind === 'edge-portal' ? '중계 엣지 포탈(vmware-portal)이 내려가 있거나 PORT 가 다릅니다.' : `중계 엣지에서 HAProxy 가 :${r.port} 을 bind 하지 않고 있습니다(설정 누락·HAProxy 중지·bind 오타).`,
      steps: kind === 'edge-portal' ? ['중계 엣지에서 `systemctl status vmware-portal`, `ss -ltnp | grep 4000`', 'portal.env 의 PORT 확인 후 재시작'] : [`중계 엣지에서 \`ss -ltnp | grep ${r.port}\` — 리스너가 없으면 haproxy.cfg 에 아래 listen 블록 추가`, `\`systemctl status haproxy\` 로 서비스 상태 확인, 중지면 \`systemctl enable --now haproxy\``, `설정 검증·재시작: \`${restart}\``],
      haproxy: kind === 'edge-portal' ? '' : snippet(r.port, backendHint) };
  }
  if (phase === 'timeout' || phase === 'unreach') {
    return { title: `${k} ${hp}: TCP 무응답(방화벽/경로)`, cause: '중앙에서 중계 엣지 IP:포트로 SYN 이 닿지 않거나 응답이 돌아오지 않습니다 — 중간 방화벽이 이 포트를 막았거나(4000 은 열고 4068 은 안 연 경우가 흔함) 중계 엣지 자체가 다운입니다.',
      steps: [`중앙에서 \`nc -vz ${r.host} ${r.port}\` 로 도달 확인, 같은 호스트 :4000 은 되는데 :${r.port} 만 안 되면 방화벽 정책에 포트 추가`, '중계 엣지 OS 방화벽: `firewall-cmd --list-ports` / `firewall-cmd --permanent --add-port=' + r.port + '/tcp && firewall-cmd --reload`', '중계 엣지가 살아 있는지(ping/SSH) 확인'], haproxy: '' };
  }
  if (phase === 'tls') {
    return { title: `${k} ${hp}: TCP 는 되나 TLS 응답 없음(백엔드 끊김)`, cause: 'HAProxy frontend 는 살아 있는데 backend(vCenter)로 전달이 끊긴 상태가 가장 유력합니다(backend DOWN·잘못된 backend 주소·vCenter 다운).',
      steps: ['중계 엣지에서 `echo "show stat" | socat stdio /var/run/haproxy.sock | grep ' + r.port + '` 또는 HAProxy stats 로 backend 상태 확인', `haproxy.cfg 의 listen :${r.port} 의 server 주소가 ${backendHint} 인지 확인`, '중계 엣지에서 `nc -vz <backend IP> 443` 로 직접 도달 확인', `수정 후 \`${restart}\``], haproxy: snippet(r.port, backendHint) };
  }
  if (phase === 'http') {
    return { title: `${k} ${hp}: TLS 는 되나 HTTP 응답 없음`, cause: '백엔드 서비스(vpxd/포탈)가 지연·중단됐거나, 포워딩이 엉뚱한 서비스로 갑니다.', steps: ['백엔드 장비에서 서비스 상태 확인(vCenter: `service-control --status`, 포탈: `systemctl status vmware-portal`)', `haproxy.cfg 의 :${r.port} backend 주소 재확인`], haproxy: '' };
  }
  if (phase === 'identity') {
    const got = r.got?.agent || '?';
    const own = kind === 'irs-portal' && r.expect?.relayAgent && got.toLowerCase() === String(r.expect.relayAgent).toLowerCase();
    return { title: `${k} ${hp}: 응답한 것이 기대한 대상이 아님(응답 '${got}')`, cause: own ? `:${r.port} 이 IRS 가 아니라 중계 엣지 자신(:4000)으로 되돌아갑니다 — haproxy.cfg 의 backend 가 자기 IP:4000 이거나 포트 오타입니다.` : `:${r.port} 이 다른 장비('${got}'${r.got?.hostname ? `, ${r.got.hostname}` : ''})로 갑니다. 기대: '${r.expect?.agent || '?'}'.`,
      steps: [`haproxy.cfg 의 listen :${r.port} 의 server 주소를 ${backendHint} 로 수정`, '수집 서버 항목의 id/이름과 IRS 의 AGENT_NAME 이 같은지 확인(대소문자 무시)', `수정 후 \`${restart}\``], haproxy: snippet(r.port, backendHint) };
  }
  if (phase === 'auth') {
    return { title: `${k} ${hp}: 토큰 거부(403)`, cause: '응답한 포탈이 수집 서버 항목의 토큰을 거부했습니다 — 포워딩이 다른 포탈(중계 엣지 자신)로 가거나, 항목 토큰이 대상의 COLLECTOR_TOKEN 과 다릅니다.',
      steps: ['수집 서버 화면의 "테스트"로 응답 엣지 이름 확인 — 중계 엣지 이름이면 haproxy backend 수정', '대상(IRS) portal.env 의 COLLECTOR_TOKEN 과 중앙 항목 토큰을 맞춤(포워딩 항목에는 "강제 동기화"를 쓰지 말 것)'], haproxy: '' };
  }
  if (phase === 'hq') {
    return { title: `${k} ${hp}: 중앙 자신이 아님`, cause: `:${r.port} 이 이 중앙 포탈로 오지 않습니다(다른 포탈/구버전 중앙/자기 자신으로 루프). IRS 의 push·자기등록이 엉뚱한 곳으로 갑니다.`,
      steps: [`haproxy.cfg 의 listen :${r.port} 의 server 를 <중앙 IP>:4000 으로`, 'IRS 의 CENTRAL_URL 이 http://<중계 엣지>:' + r.port + ' 인지 확인', `수정 후 \`${restart}\``], haproxy: snippet(r.port, '<중앙 IP>:4000') };
  }
  if (phase === 'banner') {
    return { title: `${k} ${hp}: SSH 배너 없음`, cause: 'TCP 는 열렸지만 SSH 서버가 아닙니다 — backend 가 22 가 아닌 다른 포트/장비로 갑니다.', steps: [`haproxy.cfg 의 :${r.port} backend 를 ${backendHint} 로`, 'IRS 에서 `systemctl status sshd`'], haproxy: snippet(r.port, backendHint) };
  }
  return { title: `${k} ${hp}: 점검 실패`, cause: err || '알 수 없는 오류', steps: ['수집 서버 화면의 "테스트" 로 단계별 결과 확인', `중계 엣지에서 \`ss -ltnp | grep ${r.port}\`, \`systemctl status haproxy\``], haproxy: '' };
}
