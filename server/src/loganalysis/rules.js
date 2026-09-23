/**
 * loganalysis/rules.js — 로그 규칙 카탈로그(v2.583). 한 규칙 = '이 문장이 찍히면 무슨 뜻이고 무엇을
 * 하라' 이다. 설정 › Log › 로그 분석이 이것으로 **개선점**을 만든다.
 *
 * 규칙을 더할 때(정직성):
 *  · 정규식은 **실제로 찍히는 문구**에서 만든다 — 그 문구를 찍는 파일:줄을 `src` 에 적는다. 테스트가
 *    각 규칙의 `sample` 을 실제로 매칭해 보고, `src` 파일에 그 문구의 고정 조각(`probe`)이 있는지 본다
 *    (문구가 바뀌어 규칙이 조용히 죽는 것을 막는다).
 *  · `action` 은 **이 포탈 안에서 할 수 있는 조치**를 적고 `link` 로 그 화면을 가리킨다. 원인을 모르면
 *    '확인하라' 까지만 적는다(추측을 조치처럼 쓰지 않는다).
 *  · `entity` 는 정규식 캡처 그룹 번호다 — 그 값(수집 서버 id·VM 이름·경로)을 세어 '어디서' 를 보인다.
 *  · 한 줄은 **첫 번째로 맞는 규칙 하나**에만 센다 — 구체적인 규칙을 위에 둔다.
 * 샘플의 이름은 전부 합성값이다(공개 저장소 — v2.513 규약).
 */

export const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/** 규칙 분류 — 화면의 묶음 이름. */
export const CATEGORY_LABEL = {
  stability: '안정성', config: '설정', network: '네트워크', auth: '인증', data: '데이터 손실 위험', noise: '로그 잡음', perf: '성능', other: '기타',
};

const R = (o) => ({ entity: 0, category: 'other', link: '', linkLabel: '', ...o });

export const CORE_RULES = [
  // ── 안정성 ──
  R({ id: 'fatal-uncaught', tag: 'fatal', severity: 'critical', category: 'stability',
    re: /^\[fatal\] uncaughtException|^uncaughtException:/,
    src: 'server/src/index.js', probe: "uncaughtException (계속 실행)", sample: '[fatal] uncaughtException (계속 실행): TypeError: x is not a function',
    title: '처리되지 않은 예외(uncaughtException)',
    meaning: '코드 결함으로 예외가 끝까지 올라왔습니다. 프로세스는 계속 돌지만 그 작업은 중단됐고 상태가 어긋났을 수 있습니다.',
    action: '표본의 스택 추적을 개발자에게 전달하세요. 같은 문장이 반복되면 결함이 확실합니다.',
    link: '#/settings/diagnostics', linkLabel: '진단·로그' }),
  R({ id: 'fatal-unhandled', tag: 'fatal', severity: 'high', category: 'stability',
    re: /^\[fatal\] unhandledRejection|^unhandledRejection:/,
    src: 'server/src/index.js', probe: "unhandledRejection (계속 실행)", sample: '[fatal] unhandledRejection (계속 실행): Error: socket hang up',
    title: '처리되지 않은 비동기 실패(unhandledRejection)',
    meaning: '비동기 작업의 실패를 아무도 받지 않았습니다. 요청이 응답 없이 매달리거나 결과가 조용히 버려졌을 수 있습니다.',
    action: '표본의 원인 문구로 어느 기능인지 확인하고 개발자에게 전달하세요.',
    link: '#/settings/perf-monitor', linkLabel: '서버 성능 측정' }),
  R({ id: 'store-corrupt', tag: 'atomicwrite', severity: 'critical', category: 'data', entity: 1,
    re: /^\[atomicWrite\] (\S+) 파싱 실패/,
    src: 'server/src/util/atomicWrite.js', probe: '파싱 실패', sample: '[atomicWrite] ping-targets.json 파싱 실패(Unexpected end) — 손상본을 ping-targets.json.corrupt-1 로 보존하고 빈 값으로 시작합니다.',
    title: '설정 파일 손상 — 빈 값으로 시작함',
    meaning: '저장 파일을 읽지 못해 손상본을 따로 보존하고 빈 값으로 시작했습니다. 그 파일의 등록 내용이 화면에서 사라졌습니다.',
    action: '설정 디렉터리의 손상본(.corrupt-*)을 확인해 수동으로 복구하세요. 자동 저장이 덮어쓰기 전에 해야 합니다.',
    link: '#/settings/backup', linkLabel: '포탈 백업' }),
  R({ id: 'exit-flush-fail', tag: 'exit-flush', severity: 'high', category: 'data', entity: 1,
    re: /^\[exit-flush\] (\S+) 실패/,
    src: 'server/src/util/exitFlush.js', probe: '[exit-flush]', sample: '[exit-flush] login-store 실패(SIGTERM): EACCES',
    title: '종료 시 저장 실패',
    meaning: '재시작·종료 직전에 모아 둔 변경을 파일에 쓰지 못했습니다. 마지막 몇 초의 변경이 유실됐을 수 있습니다.',
    action: '설정 디렉터리의 권한·여유 공간을 확인하세요.',
    link: '#/settings/diagnostics', linkLabel: '진단·로그' }),

  R({ id: 'idrac-poll-fail', tag: 'idrac', severity: 'high', category: 'stability',
    re: /^\[idrac\] pollNow 실패: /,
    src: 'server/src/idrac/poller.js', probe: 'pollNow 실패', sample: '[idrac] pollNow 실패: invRefreshed is not defined',
    title: 'iDRAC 폴 전체가 예외로 끝남',
    meaning: '전력·센서 폴 한 주기가 예외로 끝났습니다. 폴 주기마다 반복되면 코드 결함입니다(v2.548~2.582 의 invRefreshed 결함이 이 문장이었습니다 — 파트 장애 즉시 판정이 돌지 않았습니다).',
    action: '표본의 예외 문구를 개발자에게 전달하세요. 포탈을 최신 버전으로 올리면 해결되는지 먼저 확인하세요.',
    link: '#/settings/idrac-admin', linkLabel: 'iDRAC 서버 등록' }),

  // ── 수집 서버(엣지) ──
  R({ id: 'collector-identity-mismatch', tag: 'collector', severity: 'medium', category: 'config', entity: 1,
    re: /^\[collector\] (\S+) 정체 불일치: 이 URL 에 응답한 엣지는 '([^']+)'/,
    src: 'server/src/collector/puller.js', probe: '정체 불일치', sample: "[collector] edge-old 정체 불일치: 이 URL 에 응답한 엣지는 'EDGE-A'(host-a) 인데 등록 항목은 'edge-old' 입니다 — 'EDGE-A' 은 다른 수집 서버 항목입니다(포워딩이 그 엣지, 대개 중계 엣지 자신으로 감).",
    title: '수집 서버 등록이 다른 엣지를 가리킴(중복 등록·포워딩)',
    meaning: '등록 항목의 URL 에 다른 이름의 엣지가 응답합니다. 문구 끝이 "다른 수집 서버 항목입니다" 면 같은 엣지가 두 이름으로 등록돼 매 주기 두 번 당겨지고 있습니다.',
    action: '수집 서버 목록에서 이 항목과 응답한 엣지 항목을 비교하세요. 같은 엣지면 옛 항목을 지우되, 그 항목에 걸린 vCenter 귀속을 먼저 옮기세요. 다른 엣지면 포트포워딩 대상을 고치세요.',
    link: '#/settings/collectors', linkLabel: '수집 서버' }),
  R({ id: 'collector-pull-fail', tag: 'collector', severity: 'medium', category: 'network', entity: 1,
    re: /^\[collector\] (\S+) pull 실패\((\d+)\): /,
    src: 'server/src/collector/puller.js', probe: 'pull 실패(', sample: '[collector] edge-a pull 실패(2): fetch failed (ECONNREFUSED)',
    title: '수집 서버(엣지) 당겨오기 실패',
    meaning: '중앙이 엣지의 데이터를 가져오지 못했습니다. 2회 연속이면 그 법인의 서버·전력 데이터가 낡습니다.',
    action: '표본의 원인 문구를 보세요. 인증·토큰이면 토큰 점검, 연결 거부·시한이면 엣지 서비스와 방화벽을 확인하세요.',
    link: '#/settings/collectors', linkLabel: '수집 서버' }),

  // ── GPU 게스트 수집 ──
  R({ id: 'gpu-guest-vc-login', tag: 'gpu-guest', severity: 'high', category: 'auth', entity: 1,
    re: /^\[gpu-guest\] (\S+) vCenter 로그인 실패: /,
    src: 'server/src/gpu/poller.js', probe: 'vCenter 로그인 실패', sample: '[gpu-guest] vc-a vCenter 로그인 실패: 401 Unauthorized',
    title: 'GPU 게스트 수집 — vCenter 로그인 실패',
    meaning: '그 vCenter 의 GPU VM 전부를 이번 주기에 수집하지 못했습니다.',
    action: 'vCenter 계정·비밀번호와 연결을 확인하세요.',
    link: '#/settings/vcenter-test', linkLabel: 'vCenter 연결 테스트' }),
  R({ id: 'gpu-guest-ssh-auth', tag: 'gpu-guest', severity: 'medium', category: 'auth', entity: 1,
    re: /^\[gpu-guest\]\s+✗ (.+?): .*SSH 인증 실패/,
    src: 'server/src/gpu/sshCollect.js', probe: 'SSH 인증 실패(계정/비번 또는 비밀번호 로그인 비활성)', sample: '[gpu-guest]   ✗ gpu-vm-01: SSH 수집 실패: SSH 인증 실패(계정/비번 또는 비밀번호 로그인 비활성)',
    title: 'GPU 게스트 수집 — SSH 인증 실패',
    meaning: '게스트 OS 가 계정·비밀번호를 거부했거나 비밀번호 로그인을 막았습니다. 매 주기 반복되면 게스트 계정이 잠길 수 있습니다.',
    action: '해당 VM 의 게스트 계정을 확인하고, 수집이 필요 없는 VM 이면 대상에서 빼세요.',
    link: '#/settings/gpu-guest', linkLabel: 'GPU 게스트 수집' }),
  R({ id: 'gpu-guest-ssh-refused', tag: 'gpu-guest', severity: 'low', category: 'network', entity: 1,
    re: /^\[gpu-guest\]\s+✗ (.+?): .*SSH 연결 거부/,
    src: 'server/src/gpu/sshCollect.js', probe: 'SSH 연결 거부(sshd 미동작/포트 차단)', sample: '[gpu-guest]   ✗ gpu-vm-02: SSH 수집 실패: SSH 연결 거부(sshd 미동작/포트 차단)',
    title: 'GPU 게스트 수집 — SSH 연결 거부',
    meaning: '게스트에 sshd 가 없거나 포트가 막혀 있습니다. Windows VM 이면 sshd 가 없는 것이 보통입니다.',
    action: 'Windows VM 은 게스트 작업(VMware Tools) 사유를 보세요(v2.583 부터 같은 줄에 함께 기록). Linux 면 sshd·방화벽을 확인하세요.',
    link: '#/settings/gpu-guest-diag', linkLabel: 'GPU 수집 진단' }),
  R({ id: 'gpu-guest-ssh-timeout', tag: 'gpu-guest', severity: 'low', category: 'network', entity: 1,
    re: /^\[gpu-guest\]\s+✗ (.+?): .*SSH 타임아웃/,
    src: 'server/src/gpu/sshCollect.js', probe: 'SSH 타임아웃(IP 미도달/방화벽)', sample: '[gpu-guest]   ✗ gpu-vm-03: SSH 수집 실패: SSH 타임아웃(IP 미도달/방화벽)',
    title: 'GPU 게스트 수집 — SSH 시한 초과',
    meaning: '게스트 IP 에 닿지 않습니다(라우팅·방화벽). 수집 서버가 게스트 망에 닿지 않는 구성일 수 있습니다.',
    action: '수집 방식을 게스트 작업으로 바꾸거나, 수집 서버에서 게스트 IP 로의 22번 포트를 여세요.',
    link: '#/settings/gpu-guest', linkLabel: 'GPU 게스트 수집' }),
  R({ id: 'gpu-guest-fail-other', late: true, // v2.583: 모든 ✗ 줄을 잡는 일반 규칙 — 카탈로그의 세부 분류보다 **뒤에** 본다(index.js activeRules)
     tag: 'gpu-guest', severity: 'low', category: 'other', entity: 1,
    re: /^\[gpu-guest\]\s+✗ (.+?): /,
    src: 'server/src/gpu/poller.js', probe: '✗ ${v.name}', sample: '[gpu-guest]   ✗ gpu-vm-04: 게스트작업: 파일 다운로드 실패(404)',
    title: 'GPU 게스트 수집 — 기타 실패',
    meaning: 'SSH 가 아닌 사유(게스트 작업·VMware Tools·nvidia-smi 결과 없음 등)로 실패했습니다.',
    action: 'GPU 수집 진단에서 VM별 사유를 보세요.',
    link: '#/settings/gpu-guest-diag', linkLabel: 'GPU 수집 진단' }),
  R({ id: 'central-gpu-drop', tag: 'central', severity: 'medium', category: 'config', entity: 1,
    re: /^\[central\] gpu-guest-data: (\S+) 가 소유하지 않은 vCenter 항목 (\d+)개 드롭/,
    src: 'server/src/routes/central.js', probe: '소유하지 않은 vCenter 항목', sample: '[central] gpu-guest-data: EDGE-A 가 소유하지 않은 vCenter 항목 12개 드롭(위조 방지)',
    title: '엣지가 담당 아닌 vCenter 의 GPU 값을 보냄(드롭됨)',
    meaning: '그 엣지가 보낸 GPU 값이 다른 엣지 담당 vCenter 것이라 버려졌습니다. 담당 지정이 어긋나 있습니다.',
    action: 'vCenter 등록에서 그 vCenter 의 담당 엣지(수집 방식 site)를 확인하세요.',
    link: '#/settings/vcenter-admin', linkLabel: 'vCenter 등록' }),
  R({ id: 'central-gpu-empty', tag: 'central', severity: 'info', category: 'noise', entity: 1,
    re: /^\[central\] gpu-guest-data 수신: agent=(\S+) hosts=0 vms=0$/,
    src: 'server/src/routes/central.js', probe: 'gpu-guest-data 수신', sample: '[central] gpu-guest-data 수신: agent=EDGE-A hosts=0 vms=0',
    title: '엣지 GPU 게스트 보고 — 수집 대상 0',
    meaning: '그 엣지는 GPU 게스트 수집 대상이 없거나 수집을 켜지 않았습니다. 엣지는 진단을 위해 0건이어도 보냅니다 — 이상이 아닙니다.',
    action: 'GPU VM 이 있는 법인인데 0 이면 GPU 수집 진단에서 선별 단계를 보세요. 아니면 조치할 것이 없습니다.',
    link: '#/settings/gpu-guest-diag', linkLabel: 'GPU 수집 진단' }),
  R({ id: 'central-gpu-recv', tag: 'central', severity: 'info', category: 'noise', entity: 1,
    re: /^\[central\] gpu-guest-data 수신: agent=(\S+) /,
    src: 'server/src/routes/central.js', probe: 'gpu-guest-data 수신', sample: '[central] gpu-guest-data 수신: agent=EDGE-A hosts=11 vms=40',
    title: '엣지 GPU 게스트 보고 수신(정상)',
    meaning: '정상 수신 기록입니다. v2.582 까지는 엣지 수 × 주기(기본 60초)마다 찍혀 로그의 큰 몫을 차지했고, v2.583 부터는 값이 바뀔 때와 1시간마다만 찍습니다.',
    action: '조치할 것이 없습니다. 구버전 포탈의 로그를 덤프할 때는 이 줄을 빼면(grep -v) 필요한 줄이 더 보입니다.',
    link: '', linkLabel: '' }),
  R({ id: 'central-agent-config', tag: 'central', severity: 'info', category: 'noise', entity: 1,
    re: /^\[central\] agent-config 수신: agent=(\S+) /,
    src: 'server/src/routes/central.js', probe: 'agent-config 수신', sample: '[central] agent-config 수신: agent=EDGE-A (14개)',
    title: '엣지 설정 사본 수신(정상)',
    meaning: '엣지가 자기 설정 사본을 올린 정상 기록입니다.',
    action: '조치할 것이 없습니다.',
    link: '', linkLabel: '' }),

  // ── 엣지 → 중앙 push 실패(v2.583: 예전에는 상태 객체에만 남고 로그에 없었다 — 카탈로그 에이전트 N2·감사 #33·#34) ──
  R({ id: 'edge-push-storage-fail', tag: 'storage-push', severity: 'medium', category: 'network', edge: true,
    re: /^\[storage-push\] (?:상태 보고 )?실패: /,
    src: 'server/src/storage/push.js', probe: '[storage-push] 실패: ', sample: '[storage-push] 실패: storage-data <- 403',
    title: '스토리지 상태를 중앙에 올리지 못함(엣지)',
    meaning: '엣지가 스토리지 스냅샷을 중앙에 보내지 못했습니다. 중앙 화면의 이 법인 스토리지 값이 그 시점부터 낡습니다.',
    action: '403 이면 이 엣지의 중앙 토큰을, 연결 실패면 중앙 주소·방화벽을 확인하세요. 포탈 점검의 토큰 점검과 통신 점검이 같은 경로를 봅니다.',
    link: '#/tools/portal-check', linkLabel: '포탈 점검' }),
  R({ id: 'edge-push-sanswitch-fail', tag: 'sanswitch-push', severity: 'medium', category: 'network', edge: true,
    re: /^\[sanswitch-push\] 실패: /,
    src: 'server/src/sanswitch/push.js', probe: '[sanswitch-push] 실패: ', sample: '[sanswitch-push] 실패: sanswitch-data <- 403 (청크 1/1)',
    title: 'SAN 스위치 상태를 중앙에 올리지 못함(엣지)',
    meaning: '엣지가 SAN 스위치 스냅샷을 중앙에 보내지 못했습니다. 중앙 화면의 이 법인 스위치 상태가 낡습니다.',
    action: '403 이면 중앙 토큰을, 413 이면 중앙 본문 한도를, 연결 실패면 중앙 주소를 확인하세요.',
    link: '#/tools/portal-check', linkLabel: '포탈 점검' }),
  R({ id: 'edge-push-pdu-fail', tag: 'pdu-push', severity: 'medium', category: 'network', edge: true,
    re: /^\[pdu-push\] 실패: /,
    src: 'server/src/pdu/push.js', probe: '[pdu-push] 실패: ', sample: '[pdu-push] 실패: HTTP 403',
    title: 'PDU 상태를 중앙에 올리지 못함(엣지)',
    meaning: '엣지가 PDU 스냅샷을 중앙에 보내지 못했습니다. 중앙 화면의 이 법인 PDU 값이 낡습니다.',
    action: '403 이면 중앙 토큰을, 연결 실패면 중앙 주소·방화벽을 확인하세요.',
    link: '#/tools/portal-check', linkLabel: '포탈 점검' }),
  R({ id: 'edge-push-curuser-fail', tag: 'curuser-push', severity: 'medium', category: 'network', edge: true,
    re: /^\[curuser-push\] 실패/,
    src: 'server/src/agent/curUserPush.js', probe: '[curuser-push] 실패(', sample: '[curuser-push] 실패(0/1 청크 전송 후): curuser -> 403',
    title: '현재 사용자 수를 중앙에 올리지 못함(엣지)',
    meaning: '엣지가 현재 사용자 수집 결과를 중앙에 보내지 못했습니다. 중앙의 현재 사용자 화면에서 이 법인 값이 낡습니다.',
    action: '413 이면 청크 크기(중앙 본문 한도)를, 403 이면 중앙 토큰을 확인하세요.' }),
  R({ id: 'edge-ipscan-agent-fail', tag: 'ipscan-agent', severity: 'medium', category: 'network', edge: true,
    re: /^\[ipscan-agent\] 실패/,
    src: 'server/src/agent/ipScanWorker.js', probe: '[ipscan-agent] 실패(', sample: '[ipscan-agent] 실패(연속 3회): assignment 403',
    title: 'IP 스캔 위임을 가져오거나 보고하지 못함(엣지)',
    meaning: '엣지가 중앙에서 IP 스캔 배정을 받거나 결과를 올리지 못했습니다. 그 법인의 IP 대장이 갱신되지 않습니다.',
    action: '403 이면 이 엣지의 중앙 토큰·에이전트 이름을, 연결 실패면 중앙 주소를 확인하세요. 엣지 로그 화면의 IP 스캔 위임 항목에 연속 실패 횟수가 있습니다.',
    link: '#/tools/edge-log', linkLabel: '엣지 로그' }),
  R({ id: 'edge-config-push-fail', tag: 'config-push', severity: 'low', category: 'network', edge: true,
    re: /^\[config-push\] 실패: /,
    src: 'server/src/agent/configPush.js', probe: '[config-push] 실패: ', sample: '[config-push] 실패: HTTP 413 — 중앙 본문 한도 초과(설정 파일이 너무 큼)',
    title: '설정 사본을 중앙에 올리지 못함(엣지)',
    meaning: '엣지가 자기 설정 사본을 중앙에 보내지 못했습니다. 중앙의 엣지 설정 보기·백업에 이 법인의 최신 설정이 없습니다.',
    action: '413 이면 설정 디렉터리에 큰 JSON 이 있는지, 403 이면 중앙 토큰을 확인하세요.' }),
];

/**
 * 규칙 정리 — 정규식이 컴파일되고 필수 필드가 있는 것만 쓴다(카탈로그 병합 시 방어).
 * 같은 id 는 먼저 온 것이 이긴다.
 */
export function normalizeRules(list = []) {
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || !r.id || seen.has(r.id)) continue;
    let re = r.re;
    if (!(re instanceof RegExp)) { try { re = new RegExp(String(r.re || '')); } catch { continue; } }
    if (!re.source || re.source === '(?:)') continue;
    if (!SEVERITY_RANK[r.severity]) continue;
    seen.add(r.id);
    out.push({ ...r, re, tag: String(r.tag || '').replace(/^\[|\]$/g, '').toLowerCase(), entity: Number(r.entity) || 0 });
  }
  return out;
}
