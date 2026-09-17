/**
 * linkcheck/settingsKinds.js — **설정에 등록된 통신 대상의 카탈로그**(순수, v2.553).
 *
 * 사용자 요청(2026-09-18): "설정에 있는 모든 통신이 되는지 점검하고 해결책 제시하는 기능".
 * 선택: **전부 23종** · 해결책 **고정 조치문 + 맞춤 진단 둘 다** · **도달성만(인증은 수동 1회)** · 전체 검증.
 *
 * ── 왜 카탈로그를 따로 두는가 ────────────────────────────────────────────────
 * v2.552 의 `links.js` 는 **중앙↔엣지 토폴로지**(6종)를 계산한다. 이 파일은 그 축이 아니라
 * **'설정 화면에 등록된 모든 접속처'** 축이다 — 두 축은 겹치는 대상(vCenter·엣지)이 있지만
 * 질문이 다르다("수집 경로가 사는가" vs "등록한 주소가 닿는가"). 한 파일에 섞으면 링크 id 가
 * 충돌하고 화면이 같은 대상을 두 뜻으로 보여준다.
 *
 * ── ⚠⚠ 이 기능의 핵심 판정: **자격증명을 보내지 않으므로 401/403 은 '정상' 이다** ─────
 * v2.552 는 수집 토큰을 **보내고** 재기 때문에 401/403 이 '토큰 거부'(실패)였다. 여기서는
 * 사용자 선택에 따라 **장비 계정을 쓰지 않는다** — 그래서 401/403 은
 *   "서비스가 살아 있고 인증을 요구한다" = **도달 성공**이다.
 * 이것을 실패로 세면 화면이 **정상 장비를 전부 '인증 실패' 라고 말한다**(가장 흔한 오설계).
 * `authMode` 가 그 경계다: `'none'`(무인증 점검 — 401/403=ok) / `'token'`(포탈 자기 토큰을
 * 보내는 경우만 — 401/403=fail. 장비 계정이 아니라 **포탈이 발급한 토큰**이므로 잠금 위험이 없다).
 *
 * ── 무인증으로 확인할 수 있는 깊이는 종류마다 다르다(정직하게 등급을 매긴다) ────────
 *   `depth: 'identity'` — 무인증 엔드포인트가 **그 제품임을 증명**한다(vCenter·Redfish·엣지).
 *   `depth: 'http'`     — HTTP 응답은 받지만 제품 확인은 못 한다(401/403/200 전부 정상).
 *   `depth: 'tls'`      — TLS 핸드셰이크·인증서까지만(무인증 HTTP 경로가 없거나 GET 이 부작용).
 *   `depth: 'ssh'`      — SSH **KEX/배너까지만**(인증 시도 없음 — 계정 잠금 위험 0).
 *   `depth: 'smtp'`     — 220 배너 + EHLO 까지(AUTH 하지 않는다).
 *   `depth: 'tcp'`      — 포트 열림만(LDAP 등 — 익명 bind 도 시도하지 않는다).
 * 화면은 이 등급을 **그대로 보여준다** — 'tcp' 를 'identity' 처럼 말하면 "정상" 의 뜻이 달라진다.
 */

/** 설정 화면 경로(딥링크용). 문구가 아니라 **좌표**다 — 화면이 이 값으로 링크를 만든다. */
export const SETTINGS_PATHS = Object.freeze({
  vcenter: { label: '설정 › vCenter 관리', hash: '#/settings?tab=vcenters' },
  nsx: { label: '설정 › NSX 관리', hash: '#/settings?tab=nsx' },
  collector: { label: '설정 › 수집 서버', hash: '#/settings?tab=collectors' },
  horizon: { label: '설정 › Horizon 등록', hash: '#/settings?tab=horizon' },
  idrac: { label: '설정 › 서버(iDRAC/OME) 등록', hash: '#/settings?tab=idrac' },
  storage: { label: '특수기능 › 스토리지 모니터링 › 장비 등록', hash: '#/tools/storage-mon' },
  sanswitch: { label: '특수기능 › SAN 스위치 › 장비 등록', hash: '#/tools/san-switch' },
  pdu: { label: '특수기능 › PDU › 장비 등록', hash: '#/tools/pdu' },
  bmstor: { label: '특수기능 › 베어메탈 스토리지 › 서버 등록', hash: '#/tools/bm-storage' },
  gpuPhysical: { label: '설정 › GPU 사용량 수집 › 물리 GPU 서버', hash: '#/settings?tab=gpu' },
  remote: { label: '설정 › 원격 접속 서버', hash: '#/settings?tab=remote' },
  capture: { label: '특수기능 › 네트워크 캡처 › 캡처 호스트', hash: '#/tools/net-traffic' },
  deploy: { label: '설정 › 수집 서버 › 에이전트 배포 대상', hash: '#/settings?tab=collectors' },
  relaytopo: { label: '특수기능 › 중계 토폴로지', hash: '#/tools/relaytopo' },
  credentials: { label: '설정 › 통합 계정 관리', hash: '#/settings?tab=credentials' },
  mail: { label: '설정 › 메일 발송', hash: '#/settings?tab=mail' },
  alerts: { label: '설정 › 알림', hash: '#/settings?tab=alerts' },
  ad: { label: '설정 › User Control › AD 연동', hash: '#/settings?tab=users' },
  upgrade: { label: '설정 › 업그레이드', hash: '#/settings?tab=upgrade' },
  packages: { label: '설정 › 업그레이드 › 패키지 저장소', hash: '#/settings?tab=upgrade' },
  svcmon: { label: '서비스 모니터 › 대상 관리', hash: '#/svcmon' },
  central: { label: 'portal.env (CENTRAL_URL / CENTRAL_TOKEN)', hash: '' },
});

/**
 * 종류 카탈로그. **이 목록이 계약이다** — 화면·DB·테스트가 같이 쓴다.
 *
 * `probe`:
 *   · `mode`  실행할 점검기(`http`|`tls`|`ssh`|`smtp`|`tcp`)
 *   · `path`  http 모드의 경로
 *   · `authMode` `'none'`(자격증명 안 보냄 → 401/403 정상) | `'token'`(포탈 자기 토큰)
 *   · `identity` 무인증 응답으로 제품을 확인할 수 있으면 그 판정 이름
 * `defaultPort` 는 등록부에 포트가 없을 때만 쓴다(있으면 등록값이 이긴다).
 */
export const SETTING_KINDS = Object.freeze({
  'set:vcenter': {
    label: 'vCenter', group: '가상화', settings: 'vcenter', depth: 'identity',
    probe: { mode: 'http', path: '/sdk/vimServiceVersions.xml', authMode: 'none', identity: 'vcenter' },
    defaultPort: 443,
    desc: 'vCenter Server. 무인증 서비스 버전 문서로 그 주소가 정말 vCenter 인지까지 확인한다(로그인하지 않는다).',
  },
  'set:nsx': {
    label: 'NSX 매니저', group: '가상화', settings: 'nsx', depth: 'http',
    probe: { mode: 'http', path: '/api/v1/node', authMode: 'none' },
    defaultPort: 443,
    desc: 'NSX-T 매니저. 무인증 요청이라 401/403 이 정상 응답이다(서비스가 살아 있고 인증을 요구한다는 뜻).',
  },
  'set:collector': {
    label: '수집 서버(엣지 포탈)', group: '중앙↔엣지', settings: 'collector', depth: 'identity',
    probe: { mode: 'http', path: '/api/collector/ping', authMode: 'token', identity: 'edge' },
    desc: '엣지 포탈. 여기 쓰는 토큰은 **포탈이 발급한 수집 토큰**이라 장비 계정 잠금 위험이 없다 — 그래서 인증·정체까지 본다.',
  },
  'set:central': {
    label: '중앙 포탈(이 엣지 → 중앙)', group: '중앙↔엣지', settings: 'central', depth: 'identity',
    probe: { mode: 'http', path: '/api/central/health-probe', authMode: 'token', identity: 'central' },
    desc: '이 포탈이 엣지일 때만 나온다(CENTRAL_URL). 중앙이 이 토큰을 어느 엣지로 보는지까지 대조한다.',
  },
  'set:horizon': {
    label: 'Horizon 커넥션 서버', group: '가상화', settings: 'horizon', depth: 'http',
    probe: { mode: 'http', path: '/', authMode: 'none' },
    defaultPort: 443,
    desc: 'Horizon 커넥션 서버. REST 는 전부 인증이 필요해 무인증으로는 HTTP 응답까지만 본다.',
  },
  'set:idrac': {
    label: 'iDRAC', group: '서버', settings: 'idrac', depth: 'identity',
    probe: { mode: 'http', path: '/redfish/v1/', authMode: 'none', identity: 'redfish' },
    defaultPort: 443,
    desc: 'Redfish 서비스 루트는 규격상 무인증으로 열려 있어 `RedfishVersion` 으로 제품 확인이 된다.',
  },
  'set:ome': {
    label: 'OpenManage Enterprise', group: '서버', settings: 'idrac', depth: 'http',
    probe: { mode: 'http', path: '/api/ApplicationService/Info', authMode: 'none' },
    defaultPort: 443,
    desc: 'OME 관리 콘솔. 무인증 응답(401 포함)까지 본다.',
  },
  'set:storage-api': {
    label: '스토리지(API)', group: '스토리지', settings: 'storage', depth: 'http',
    probe: { mode: 'http', path: '/', authMode: 'none' },
    defaultPort: 443,
    desc: 'REST 로 수집하는 스토리지. 전 제품이 인증을 요구하므로 401/403 이 정상 응답이다.',
  },
  'set:storage-ssh': {
    label: '스토리지(SSH)', group: '스토리지', settings: 'storage', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: 'SSH 로 수집하는 스토리지(Unity uemcli·Isilon 등). **인증은 시도하지 않는다** — 틀린 비밀번호를 반복하면 계정이 잠긴다.',
  },
  'set:sanswitch-ssh': {
    label: 'SAN 스위치(SSH)', group: '네트워크', settings: 'sanswitch', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: 'Brocade FOS SSH. KEX·배너까지만 본다(로그인하지 않는다).',
  },
  'set:sanswitch-rest': {
    label: 'SAN 스위치(REST)', group: '네트워크', settings: 'sanswitch', depth: 'tls',
    probe: { mode: 'tls', authMode: 'none' }, defaultPort: 443,
    desc: 'FOS REST 는 로그인이 POST 라 무인증 GET 이 뜻이 없다 — TLS·인증서까지만 본다.',
  },
  'set:pdu': {
    label: 'PDU', group: '전력', settings: 'pdu', depth: 'http',
    probe: { mode: 'http', path: '/', authMode: 'none' }, defaultPort: 443,
    desc: 'APC Rack PDU 관리 웹. 무인증 응답까지 본다.',
  },
  'set:bmstor': {
    label: '베어메탈 스토리지(SSH)', group: '서버', settings: 'bmstor', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: '베어메탈 서버 OS SSH. 인증 시도 없음.',
  },
  'set:gpu-physical': {
    label: '물리 GPU 서버(SSH)', group: '서버', settings: 'gpuPhysical', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: 'nvidia-smi 수집 대상 SSH. 인증 시도 없음.',
  },
  'set:dataplane': {
    label: 'HAProxy Data Plane', group: '원격접속', settings: 'remote', depth: 'http',
    probe: { mode: 'http', path: '', authMode: 'none' },
    desc: 'Data Plane API. 인증이 필요하므로 401 이 정상 응답이다. ⚠ 경로는 등록된 `url + basePath` 를 그대로 쓴다(v2.503 S-1).',
  },
  'set:remote-ssh': {
    label: '원격접속 SSH 대상', group: '원격접속', settings: 'remote', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: 'SSH 터널 대상. 인증 시도 없음.',
  },
  'set:capture': {
    label: '캡처 호스트(SSH)', group: '네트워크', settings: 'capture', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: 'tcpdump 캡처 호스트. 인증 시도 없음.',
  },
  'set:deploy': {
    label: '에이전트 배포 대상(SSH)', group: '중앙↔엣지', settings: 'deploy', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: '엣지 설치·업그레이드 대상. 인증 시도 없음.',
  },
  'set:relaytopo': {
    label: '중계 토폴로지 노드(SSH)', group: '중앙↔엣지', settings: 'relaytopo', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: 'Main/Edge/IRS 노드. 인증 시도 없음.',
  },
  'set:credential-host': {
    label: '통합 계정 SSH 대상', group: '원격접속', settings: 'credentials', depth: 'ssh',
    probe: { mode: 'ssh', authMode: 'none' }, defaultPort: 22,
    desc: '통합 계정에 등록된 호스트 범위. 인증 시도 없음.',
  },
  'set:smtp': {
    label: 'SMTP(메일 발송)', group: '알림', settings: 'mail', depth: 'smtp',
    probe: { mode: 'smtp', authMode: 'none' }, defaultPort: 25,
    desc: '220 배너 + EHLO 까지. **AUTH 하지 않고 메일도 보내지 않는다**(테스트 메일은 설정 화면의 버튼이 따로 한다).',
  },
  'set:webhook': {
    label: '알림 웹훅(Slack·Teams·일반)', group: '알림', settings: 'alerts', depth: 'tls',
    probe: { mode: 'tls', authMode: 'none' }, defaultPort: 443,
    desc: '웹훅은 **POST 만 받는다** — GET 으로 찔러도 뜻이 없고 POST 하면 실제 알림이 발송된다. 그래서 TLS·인증서까지만 본다.',
  },
  'set:ad': {
    label: 'AD / LDAP', group: '인증', settings: 'ad', depth: 'tcp',
    probe: { mode: 'tcp', authMode: 'none' }, defaultPort: 389,
    desc: '포트 열림까지만. **익명 bind 도 시도하지 않는다**(디렉터리 정책에 따라 감사 로그·잠금 대상이 될 수 있다).',
  },
  'set:upgrade-src': {
    label: '업그레이드 원격 소스', group: '업그레이드', settings: 'upgrade', depth: 'http',
    probe: { mode: 'http', path: '/versions.json', authMode: 'none' },
    desc: '자동 업그레이드가 버전 목록을 읽는 주소. 이 링크가 죽으면 업그레이드가 조용히 멈춘다.',
  },
  'set:package-repo': {
    label: '패키지 저장소', group: '업그레이드', settings: 'packages', depth: 'http',
    probe: { mode: 'http', path: '', authMode: 'none' },
    desc: '오프라인 패키지 저장소.',
  },
});

export const SETTING_KIND_KEYS = Object.freeze(Object.keys(SETTING_KINDS));

/** 점검 깊이 라벨 — 화면이 '정상' 의 뜻을 정확히 말하기 위한 값이다. */
export const DEPTH_LABEL = Object.freeze({
  identity: '제품 확인까지',
  http: 'HTTP 응답까지',
  tls: 'TLS·인증서까지',
  ssh: 'SSH 협상까지',
  smtp: 'SMTP 배너·EHLO 까지',
  tcp: '포트 열림까지',
});

/** 그룹 표시 순서(화면 묶음). 목록에 없는 그룹은 뒤에 붙는다. */
export const GROUP_ORDER = Object.freeze(['중앙↔엣지', '가상화', '서버', '스토리지', '네트워크', '전력', '원격접속', '알림', '인증', '업그레이드']);
