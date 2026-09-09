/**
 * views/collectorDiag.js — 수집 서버 표의 경고 배지('이름 충돌'·'거부 N'·'응답 …')를 **읽을 수 있는
 * 진단 카드**로 바꾸는 순수 함수(v2.437).
 *
 * 왜 분리했나: 기존에는 배지에 `title=` 툴팁 한 줄이 전부여서 (a) 마우스를 올려야만 보이고 (b) 줄바꿈 없이
 * 잘리고 (c) '무엇이·어디서·어떻게 고치는지'가 빠져 있었다. 사용자가 실제로 물었다 — "자세한 오류 메시지
 * 표시하게 해줘, 어디서 볼 수 있어? 해결방법". 판정·문구는 여기서 회귀로 고정한다(웹 테스트가 node 환경이라
 * 컴포넌트 렌더 테스트가 불가 — CLAUDE.md '문구 로직은 순수 함수에' 규약).
 *
 * 반환 카드: { kind, badge, tone, title, summary, evidence:[{k,v}], steps:[…], where:[…] }
 *   · evidence = 화면이 근거로 제시할 수치/시각/IP (추정이 아니라 서버가 실제로 관측한 값만)
 *   · steps    = 해결 절차, where = 원문을 더 볼 수 있는 위치
 */

const ts = (v) => (v ? new Date(v).toLocaleString('ko-KR') : '—');
const lower = (v) => String(v || '').trim().toLowerCase();

/** '거부 N' — 엣지가 collector 토큰을 거부한 요청들. status.authDeny 는 엣지 export 가 실어 온다. */
export function denyCard(status) {
  const d = status?.authDeny;
  if (!d || !(d.count > 0)) return null;
  const recent = Array.isArray(d.recent) ? d.recent : [];
  const bySrc = Array.isArray(d.bySrc) ? d.bySrc : [];
  const last = recent[0] || null;
  // 사유별 해결 절차 — 세 갈래가 서로 다른 조치를 요구한다.
  const why = String(last?.why || d.lastWhy || '');
  let steps;
  if (/미설정/.test(why)) {
    steps = [
      '이 엣지의 portal.env 에 COLLECTOR_TOKEN 이 없습니다 — 수집 기능 자체가 꺼져 있습니다.',
      '설정 › 수집 서버에서 이 항목의 토큰을 확인한 뒤, 엣지 portal.env 에 같은 값으로 COLLECTOR_TOKEN 을 넣고 재시작하세요.',
      '또는 설정 › 엣지 노드 포탈 설치 › 수집 서버 연결 상태에서 "대상 → 엣지(SSH)" 로 토큰을 반영할 수 있습니다.',
    ];
  } else if (/헤더 없음/.test(why)) {
    steps = [
      '요청에 X-Collector-Token 헤더가 아예 없었습니다 — 중앙의 정상 폴링은 항상 헤더를 붙이므로 이 요청은 중앙이 아닐 가능성이 높습니다.',
      '아래 "출처" 의 IP 가 중앙 포탈(또는 알고 있는 관리 도구)인지 확인하세요.',
      '모르는 IP 라면 방화벽에서 이 엣지의 포탈 포트 접근을 중앙 IP 로 제한하세요.',
    ];
  } else {
    steps = [
      '토큰 값이 다릅니다 — 중앙에 저장된 값과 엣지 portal.env 의 COLLECTOR_TOKEN 이 어긋났습니다.',
      '설정 › 엣지 노드 포탈 설치 › 수집 서버 연결 상태에서 "진단" 을 눌러 어느 쪽 값이 통하는지 실측한 뒤 방향을 골라 정렬하세요.',
      '출처 IP 가 중앙이 아니라면, 예전 중앙/복제한 설정이 이 엣지를 두드리고 있는 것입니다 — 그쪽 등록을 지우세요.',
    ];
  }
  return {
    kind: 'deny',
    badge: `거부 ${d.count}`,
    tone: 'amber',
    title: `엣지가 수집 요청을 거부했습니다 — ${d.count}건`,
    summary: '엣지가 X-Collector-Token 검증에 실패해 403/404 로 되돌린 요청입니다(엣지 기동 후 누적). 지금 수집이 되고 있다면 다른 요청자가 틀린 토큰으로 두드리는 것일 수 있습니다.',
    evidence: [
      { k: '누적 건수', v: `${d.count}건 (엣지 기동 후)` },
      { k: '마지막 시각', v: ts(last?.at || d.lastAt) },
      { k: '마지막 사유', v: why || '—' },
      { k: '마지막 대상', v: last?.endpoint || d.lastEndpoint || '—' },
      { k: '마지막 출처 IP', v: last?.ip || '(구버전 엣지 — 미제공)' },
    ],
    rows: recent,
    bySrc,
    steps,
    where: [
      '엣지 원문 로그: journalctl -u vmware-portal -n 200 | grep "인증 거부" (30초 스로틀, 토큰 값은 남지 않음)',
      '이 표의 값은 엣지 export(/api/collector/export)의 authDeny 필드입니다 — 엣지 재시작 시 0 으로 초기화됩니다.',
    ],
    note: recent.length === 0 ? '이 엣지는 구버전이라 상세 목록을 보내지 않습니다(v2.437 이상으로 업그레이드하면 출처 IP·엔드포인트별 내역이 보입니다).' : '',
  };
}

/**
 * '이름 충돌' — 실제로는 두 가지 다른 사고다. v2.436 까지는 같은 빨간 배지 하나로 뭉뚱그려
 * 원인을 구분할 수 없었다. 여기서 갈라 각각의 근거와 해결 절차를 준다.
 */
export function identityCards(collector, ident) {
  const cards = [];
  const keys = [lower(collector?.id), lower(collector?.name)].filter(Boolean);
  const a = keys.map((k) => ident?.byAgent?.[k]).find(Boolean);
  if (a?.conflict) {
    cards.push({
      kind: 'agent-name',
      badge: '이름 충돌',
      tone: 'red',
      title: `같은 엣지 이름(AGENT_NAME '${a.agent}')을 두 장비가 쓰고 있습니다`,
      summary: '중앙은 push 본문의 agent 이름으로 데이터 주인을 판단합니다. 두 장비가 같은 이름을 쓰면 인벤토리·함대·스토리지·원격 명령이 서로를 덮어씁니다(마지막에 보낸 쪽만 남음).',
      evidence: [
        { k: '엣지 이름', v: a.agent },
        { k: '지금 이 이름으로 보내는 장비', v: `${a.hostname || '(hostname 미제공)'}${a.peer ? ` · ${a.peer}` : ''}` },
        { k: '직전에 같은 이름으로 보낸 장비', v: `${a.conflict.hostname || '(hostname 미제공)'}${a.conflict.peer ? ` · ${a.conflict.peer}` : ''}` },
        { k: '충돌 관측', v: `${a.conflict.flips || 1}회 · 마지막 ${ts(a.conflict.at)}` },
        { k: '이 이름으로 받은 push', v: `${a.seen || 0}회 · 마지막 ${ts(a.at)}` },
      ],
      steps: [
        '두 장비 중 한 쪽의 portal.env 에서 AGENT_NAME 을 다른 값으로 바꾸세요(대개 한 엣지의 portal.env 를 복사해 설치한 것이 원인입니다).',
        'IRS 엣지는 중계 엣지와 다른 이름을 쓰세요 — 예: 중계가 hd 면 IRS 는 hd-irs.',
        '이름을 바꾼 뒤 그 엣지를 재시작하고, 중앙에서 이 항목의 등록 id 도 새 이름과 맞추세요.',
        '개별 토큰(설정 › 수집 서버 › 엣지별 central 토큰)을 발급하면 body.agent 위조·혼선이 원천 차단됩니다.',
      ],
      where: [
        '이 판정은 중앙 인메모리(central/agentIdentity.js)이며 30분 창 + 중앙 재시작 시 초기화됩니다.',
        '엣지 쪽 확인: grep AGENT_NAME /opt/vmware-portal/portal.env (또는 설치 경로의 portal.env)',
      ],
    });
  }
  const vcs = (ident?.vcenterConflicts || []).filter((x) => keys.includes(lower(x.agent)) || keys.includes(lower(x.other)));
  for (const vc of vcs) {
    cards.push({
      kind: 'vcenter-owner',
      badge: 'vCenter 중복',
      tone: 'red',
      title: `같은 vCenter id '${vc.vcenterId}' 를 두 엣지가 번갈아 보냅니다`,
      summary: '엣지 이름은 다르지만 보내는 vCenter id 가 같습니다. 중앙은 vCenter id 로 인벤토리를 저장하므로 두 엣지의 데이터가 서로를 덮어씁니다 — 호스트/VM 수가 주기마다 튀거나 0 이 됩니다.',
      evidence: [
        { k: 'vCenter id', v: vc.vcenterId },
        { k: '지금 보내는 엣지', v: `${vc.agent}${vc.hostname ? ` (${vc.hostname})` : ''}${vc.peer ? ` · ${vc.peer}` : ''}` },
        { k: '직전에 보낸 엣지', v: `${vc.other}${vc.otherHostname ? ` (${vc.otherHostname})` : ''}${vc.otherPeer ? ` · ${vc.otherPeer}` : ''}` },
        { k: '충돌 관측', v: `${vc.flips || 1}회 · 마지막 ${ts(vc.at)}` },
      ],
      steps: [
        '두 엣지의 vcenters.json 을 열어 같은 vCenter 를 양쪽에 등록했는지 확인하세요 — 한 쪽에서 지우면 끝납니다.',
        'vcenters.json 을 복사해 설치했다면 vCenter id 까지 같아집니다. 실제로 다른 vCenter 라면 한 쪽의 id 를 새로 발급하세요(vCenter 를 지웠다가 다시 등록).',
        'DATA_SOURCE=mock 으로 실행 중인 엣지는 생성기가 만든 동일한 가짜 id(vc-ap-… 형태)를 보냅니다 — portal.env 에 DATA_SOURCE=live 를 넣고 재시작하세요.',
      ],
      where: [
        '중앙 인메모리(30분 창, 재시작 초기화). 엣지 쪽 확인: 해당 엣지 포탈 › 설정 › vCenter 목록의 id.',
      ],
    });
  }
  return cards;
}

/** '응답 <agent>' — 등록 URL 이 다른 엣지에 닿았다(puller.identityIssue). */
export function urlIdentityCard(status) {
  const i = status?.identity;
  if (!i) return null;
  return {
    kind: 'url-identity',
    badge: `응답 ${i.agent}`,
    tone: 'amber',
    title: '등록한 URL 이 다른 엣지에 닿았습니다',
    summary: i.reason || '',
    evidence: [
      { k: '응답한 엣지', v: `${i.agent}${i.hostname ? ` (${i.hostname})` : ''}` },
    ],
    steps: [
      '중계 엣지의 포트포워딩이 자기 자신으로 되돌아오는지 확인하세요(예: 4068 이 중계 엣지 포탈로 감).',
      '이 항목의 URL 을 실제로 그 엣지에 닿는 주소로 고치거나, 배포 대상의 광고 URL(advertiseUrl)을 지정하세요.',
    ],
    where: ['중앙 로그: [collector] <id> 정체 불일치: …'],
  };
}

/** 한 행의 모든 진단 카드(배지 렌더 순서와 동일). */
export function rowCards(collector, status, ident) {
  return [urlIdentityCard(status), ...identityCards(collector, ident), denyCard(status)].filter(Boolean);
}
