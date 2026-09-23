/**
 * central/scanRemedy.js — 위임 iDRAC 스캔이 '대기(에이전트 인출 전)'에서 멈췄을 때
 * **무엇을 어떻게 고치는지**를 만드는 순수 모듈(v2.440, 사용자 요구 '해결방법을 구체적으로 화면에 표시').
 *
 * 왜 필요했나: 기존 진단(idracScanJobs.getIdracScanJobLog)은 **원인 설명**까지만 했다 —
 * "AGENT_NAME 불일치일 수 있습니다", "CENTRAL_URL/CENTRAL_TOKEN 이 설정·재시작됐는지 확인하세요".
 * 맞는 말이지만 사용자는 **어느 파일의 어느 값을 무엇으로 바꾸고 무엇으로 검증하는지** 알 수 없어
 * 화면을 보고도 손을 못 댔다. 여기서 확인 명령·수정 절차·검증 방법·바로 갈 화면까지 만들어 준다.
 *
 * 순수: 네트워크·파일 접근 없음. 입력(잡 상태 + 폴링 중인 이름 목록 + 배포 대상 정보)만으로 판정한다.
 */

/** 편집 거리(Levenshtein). 이름이 짧아 O(n·m) 로 충분하다. 오타/접미사 누락 후보를 고르는 데 쓴다. */
export function editDistance(a, b) {
  const s = String(a || ''); const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * 폴링 중인 이름들과 대조해 '이름 문제'를 좁힌다(순수).
 * 실제 현장 사례: 잡은 'nb-irs' 인데 폴링 목록에는 'nb' 는 있고 'nb-irs' 만 없다. 다른 사이트는
 * 전부 '<사이트>-irs' 가 폴링 중 → **NB 사이트의 IRS 엣지만** 설정이 빠진 것으로 좁혀진다.
 * 이 좁히기가 '어느 장비를 만져야 하는가' 를 결정하므로 조치의 출발점이다.
 */
export function analyzeAgentName(agent, pollingAgents = []) {
  const a = String(agent || '').trim().toLowerCase();
  const list = (pollingAgents || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  const out = { agent: a, polling: list.includes(a), caseVariant: '', base: '', suffix: '', baseIsPolling: false, peers: [], near: [] };
  if (!a) return out;

  // 대소문자만 다른 이름이 폴링 중이면 그건 사실상 일치다(서버가 소문자로 비교하므로 여기까지 오면 드묾).
  const exact = (pollingAgents || []).find((x) => String(x).trim().toLowerCase() === a && String(x).trim() !== agent);
  if (exact) out.caseVariant = exact;

  // '<base>-<suffix>' 구조 분해 — 이 저장소의 명명 규약(중계 엣지 'nb' / IRS 엣지 'nb-irs').
  const m = a.match(/^(.+?)-([a-z0-9]+)$/);
  if (m) { out.base = m[1]; out.suffix = m[2]; out.baseIsPolling = list.includes(m[1]); }

  // 같은 접미사를 쓰는 다른 사이트들(예: 다른 '-irs') — 규약이 이미 통용됨을 보여주는 근거.
  if (out.suffix) out.peers = list.filter((x) => x !== a && x.endsWith(`-${out.suffix}`)).slice(0, 8);

  // 오타 후보(편집거리 1~2). base 자기 자신은 제외 — 그건 baseIsPolling 으로 따로 다룬다.
  out.near = list
    .filter((x) => x !== a && x !== out.base)
    .map((x) => ({ name: x, d: editDistance(a, x) }))
    .filter((x) => x.d > 0 && x.d <= 2)
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map((x) => x.name);
  return out;
}

const ENV = '/etc/vmware-portal/portal.env';   // 설치 기본 경로(설치 위치가 다르면 화면 문구에서 그대로 안내)

/**
 * '대기 중인데 그 이름으로 폴링이 없음' 상황의 조치 카드(순수).
 * @param {{agent:string, pollingAgents:string[], isRegisteredCollector:boolean, deployTarget?:{host:string,port:number,agentName:string}|null}} ctx
 * @returns {{title:string, why:string, steps:Array<{text:string, cmd?:string}>, links:Array<{label:string,hash:string}>, quickFix?:object}}
 */
export function buildPendingRemedy(ctx = {}) {
  const agent = String(ctx.agent || '');
  const nameInfo = analyzeAgentName(agent, ctx.pollingAgents || []);
  const t = ctx.deployTarget || null;
  const sshHint = t?.host ? `ssh ${t.username || 'root'}@${t.host}${t.port && t.port !== 22 ? ` -p ${t.port}` : ''}` : 'ssh <엣지 호스트>';

  // 원인을 한 줄로 좁힌다 — 아래 절차가 어느 장비를 향하는지가 여기서 정해진다.
  let why;
  if (nameInfo.caseVariant) {
    why = `폴링 목록에 대소문자만 다른 '${nameInfo.caseVariant}' 가 있습니다 — 사실상 같은 이름이므로 잡 배정 쪽 이름 표기를 맞추면 됩니다.`;
  } else if (nameInfo.baseIsPolling) {
    why = `'${nameInfo.base}'(중계 엣지)는 폴링 중인데 '${agent}' 만 없습니다${nameInfo.peers.length ? ` — 다른 사이트는 ${nameInfo.peers.join(', ')} 가 정상 폴링 중입니다` : ''}. 중앙↔그 사이트 네트워크는 살아 있으므로, **'${agent}' 장비(IRS 엣지) 자체의 설정**이 빠졌거나 프로세스가 안 떠 있는 것입니다.`;
  } else if (nameInfo.near.length) {
    why = `'${agent}' 로는 폴링이 없고 비슷한 이름 ${nameInfo.near.map((n) => `'${n}'`).join(', ')} 가 폴링 중입니다 — 엣지의 AGENT_NAME 오타이거나, 잡을 만들 때 고른 에이전트 이름이 틀렸을 수 있습니다.`;
  } else if ((ctx.pollingAgents || []).length === 0) {
    why = '중앙에 폴링하는 에이전트가 하나도 없습니다 — 개별 엣지 설정이 아니라 중앙 쪽 수신 경로(포트·토큰)나 전체 네트워크 문제일 수 있습니다.';
  } else {
    why = `'${agent}' 이름으로 폴링한 기록이 없습니다 — 그 엣지에 스캔 폴링 설정(CENTRAL_URL·CENTRAL_TOKEN·AGENT_NAME)이 없거나 포탈이 안 떠 있습니다.`;
  }

  const steps = [];
  // ① 즉시 우회 — 설정을 못 고치는 상황에서도 지금 스캔을 돌리는 방법. 실무에서 가장 먼저 쓸 수 있다.
  steps.push({
    text: "지금 당장 스캔이 필요하면 **스캔 방식을 '중앙→엣지 직접(PUSH)'** 으로 바꾸세요. 중앙이 등록된 수집 서버 URL 로 엣지에 직접 보내므로 **엣지 폴링 설정 없이 동작**합니다(이 엣지는 이미 수집 서버로 등록돼 있습니다).",
    when: ctx.isRegisteredCollector ? 'now' : 'maybe',
  });
  // ② 근본 원인 확인 — 값 3개를 눈으로 본다.
  steps.push({ text: `엣지에 접속해 설정 3개를 확인합니다.`, cmd: sshHint });
  steps.push({ text: '스캔 폴링에 필요한 값이 있는지 봅니다(세 줄이 모두 나와야 합니다).', cmd: `grep -E '^(AGENT_NAME|CENTRAL_URL|CENTRAL_TOKEN)=' ${ENV}` });
  // ③ 수정
  steps.push({
    text: `없거나 다르면 ${ENV} 에 넣습니다 — **AGENT_NAME 은 이 잡의 이름과 정확히 같아야 합니다**(대소문자 무관).`,
    cmd: `AGENT_NAME=${agent}\nCENTRAL_URL=<중앙 포탈 주소>\nCENTRAL_TOKEN=<중앙 토큰>`,
  });
  steps.push({ text: '엣지 포탈을 재시작합니다(설정은 기동 시 읽습니다).', cmd: 'systemctl restart vmware-portal' });
  // ④ 검증 — 고쳤는지 스스로 확인할 수 있어야 조치가 끝난다.
  steps.push({ text: '엣지 로그에 스캔 에이전트 기동 줄이 보이는지 확인합니다.', cmd: `journalctl -u vmware-portal -n 50 | grep idrac-scan-agent` });
  steps.push({ text: `기대 출력: ‘[idrac-scan-agent] started (central=…, name=${agent})’. 이 줄이 나오면 5초 안에 이 화면의 '현재 폴링 중인 에이전트' 목록에 '${agent}' 가 나타납니다.` });

  const links = [
    { label: '스캔 방식 바꾸기(대역 설정)', hash: '#/settings/idrac-admin' },
    { label: '엣지에 SSH 로 설정 반영(엣지 노드 포탈 설치)', hash: '#/settings/agent-deploy/status' },
    { label: '수집 서버 연결 상태 확인', hash: '#/settings/collectors' },
  ];
  return {
    title: `'${agent}' 가 중앙에 스캔 폴링을 하지 않습니다 — 해결 절차`,
    why,
    nameInfo,
    steps,
    links,
  };
}

/**
 * PUSH(중앙→엣지 직접) 스캔이 실패했을 때의 조치 카드(순수, v2.440).
 * 상태코드별 원인은 **실측으로 확정**한 것이다(로컬 엣지에 직접 요청해 확인):
 *   403 = collector 라우터 도달 + 토큰 불일치 · 401 = 경로 없음(구버전) → 인증 라우터가 응답
 *   404 = collector 비활성(COLLECTOR_TOKEN 미설정) · 그 외 = 엣지 내부 오류/네트워크
 * '401 이면 토큰부터 뒤진다' 는 오답을 막는 것이 이 함수의 목적이다.
 */
export function buildPushErrorRemedy({ agent = '', httpStatus = 0, error = '', collectorUrl = '' } = {}) {
  const st = Number(httpStatus) || Number((String(error).match(/HTTP (\d{3})/) || [])[1]) || 0;
  const links = [
    { label: '수집 서버(원격) — 버전 확인·업그레이드', hash: '#/settings/collectors' },
    { label: '수집 서버 연결 상태 — 토큰 진단·정렬', hash: '#/settings/agent-deploy/status' },
    { label: '스캔 방식 바꾸기(대역 설정)', hash: '#/settings/idrac-admin' },
  ];
  const where = collectorUrl ? [`이 PUSH 가 향한 주소: ${collectorUrl}/api/collector/idrac-scan`] : [];

  if (st === 401) {
    return {
      title: `'${agent}' 엣지에 PUSH 스캔 기능이 없습니다 (HTTP 401)`,
      why: '401 은 토큰이 틀린 것이 아니라 **그 경로가 없어서** 요청이 collector 라우터를 지나 일반 인증 미들웨어로 떨어진 것입니다. 토큰이 틀렸다면 403 이 옵니다. 즉 이 엣지가 구버전이라 ‘/api/collector/idrac-scan’ 을 아직 갖고 있지 않습니다.',
      steps: [
        { text: "**설정 › 수집 서버(원격)** 에서 이 엣지의 '버전' 열을 중앙 버전과 비교하세요. 낮으면 그 행의 [업그레이드]를 누르면 됩니다.", when: 'now' },
        { text: '업그레이드가 어려우면 **스캔 방식을 에이전트 폴링으로** 바꾸세요(엣지에 CENTRAL_URL·CENTRAL_TOKEN 이 있어야 합니다).' },
        { text: '엣지에서 직접 확인하려면 버전을 봅니다.', cmd: 'grep -m1 version /opt/vmware-portal/package.json' },
        { text: '업그레이드 후 다시 PUSH 스캔을 실행해 403/401 이 사라지는지 봅니다.' },
      ],
      links, where,
    };
  }
  if (st === 403) {
    return {
      title: `'${agent}' 엣지가 수집 토큰을 거부했습니다 (HTTP 403)`,
      why: '403 은 요청이 엣지의 collector 라우터까지 **도달했고** 토큰만 다르다는 뜻입니다(경로가 없으면 401 이 옵니다). 중앙에 저장된 수집 토큰과 엣지의 COLLECTOR_TOKEN 이 어긋나 있습니다.',
      steps: [
        { text: "**설정 › 엣지 노드 포탈 설치 › 수집 서버 연결 상태** 에서 [진단]을 눌러 중앙 토큰·대상 토큰 중 **어느 값이 실제로 통하는지** 실측한 뒤, 권장 방향으로 정렬하세요.", when: 'now' },
        { text: '엣지에서 직접 보려면(값은 화면에 남기지 마세요).', cmd: 'grep -m1 ^COLLECTOR_TOKEN= /etc/vmware-portal/portal.env' },
        { text: '정렬 후 다시 PUSH 스캔을 실행합니다.' },
      ],
      links, where,
    };
  }
  if (st === 404) {
    return {
      title: `'${agent}' 엣지의 collector 기능이 꺼져 있습니다 (HTTP 404)`,
      why: '엣지에 COLLECTOR_TOKEN 이 설정되지 않아 collector 엔드포인트가 통째로 비활성입니다(그러면 중앙의 데이터 수집도 안 됩니다).',
      steps: [
        { text: '엣지에 수집 토큰을 넣고 재시작합니다.', cmd: 'COLLECTOR_TOKEN=<중앙 수집 서버 화면의 토큰>' },
        { text: '재시작.', cmd: 'systemctl restart vmware-portal' },
        { text: '중앙의 수집 서버 목록에서 이 엣지가 정상으로 바뀌는지 확인합니다.' },
      ],
      links, where,
    };
  }
  return {
    title: `'${agent}' PUSH 스캔 실패`,
    why: `엣지가 예상치 못한 응답을 했습니다${st ? ` (HTTP ${st})` : ''} — ${String(error).slice(0, 200)}`,
    steps: [
      { text: '수집 서버 목록에서 이 엣지가 정상(연결됨)인지 먼저 확인하세요.', when: 'now' },
      { text: '엣지 로그에서 그 시각의 오류를 봅니다.', cmd: 'journalctl -u vmware-portal -n 100' },
      { text: '해결이 어려우면 스캔 방식을 에이전트 폴링으로 바꿔 시도해 보세요.' },
    ],
    links, where,
  };
}
