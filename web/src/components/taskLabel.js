/**
 * 요청 경로 → **사람이 읽는 작업 이름**(v2.501) — 순수 함수.
 *
 * 사용자 요구: "대기가 3초 이상이면 구체적으로 어떤 작업을 하는지 진행상태를 보여줄 것."
 * 그래서 스피너가 `/tools/waste` 같은 경로 대신 'Optimization 분석' 이라고 말해야 한다.
 *
 * 정직성 규약:
 *  · **모르는 경로를 지어내지 않는다** — 표에 없으면 경로를 다듬어 그대로 보여주고 `known:false` 로
 *    표시한다. "데이터 조회 중" 같은 뭉뚱그린 말로 덮으면 무엇을 기다리는지 알 수 없게 된다.
 *  · `slow` 는 **설계상 오래 걸리는 것이 정상**인 작업만 true 다(고RTT vCenter 라이브 조회·엑셀 생성·
 *    롱폴). 이 표시는 "느려도 고장이 아니다" 를 알리는 용도이고, 근거가 있는 경로에만 붙인다.
 *  · 예상 소요 시간을 숫자로 말하지 않는다 — 측정한 값이 없으므로 지어내면 거짓이 된다.
 *
 * 표를 늘릴 때: 라우트를 실제로 확인하고 그 작업이 무엇을 하는지 적을 것. 추측으로 채우지 말 것.
 */

/**
 * 정확 일치 표. 키는 `perfClientLogic.normPath()` 를 통과한 형태(쿼리 제거·식별자 `:id` 마스킹).
 * slow: 설계상 오래 걸리는 것이 정상(사용자에게 그 사실을 알린다).
 */
const EXACT = {
  '/summary': { label: '전 vCenter 요약 집계' },
  '/overview': { label: '대시보드 개요 집계' },
  '/vcenters': { label: 'vCenter 목록·상태' },
  '/hosts': { label: 'ESXi 호스트 목록' },
  '/vms': { label: 'VM 목록' },
  '/datastores': { label: '데이터스토어 목록' },
  '/networks': { label: '네트워크 목록' },
  '/alarms': { label: '알람 목록' },
  '/nsx': { label: 'NSX 매니저·게이트웨이 조회' },
  '/nsx/group-members': { label: 'NSX 보안그룹 구성원 조회' },
  '/compare/matrix': { label: '비교 매트릭스 집계' },
  '/health': { label: '서버 상태 확인' },
  '/release-notes': { label: '릴리스 노트' },
  '/auth/me': { label: '로그인 정보 확인' },
  '/auth/config': { label: '로그인 설정 확인' },

  // 도구·분석 — 스냅샷 집계는 빠르지만 라이브 조회를 동반하는 것은 slow 로 표시한다.
  '/tools/waste': { label: 'Optimization 분석' },
  '/tools/waste/export': { label: 'Optimization 엑셀(ZIP) 생성', slow: true },
  '/tools/capacity': { label: '리소스 적정성 분석' },
  '/tools/capacity-forecast': { label: '용량 추이 예측' },
  '/tools/insights': { label: '인사이트 집계' },
  '/tools/gpu': { label: 'GPU 사용량 조회' },
  '/tools/gpu/vms': { label: 'GPU 할당 VM 조회' },
  '/tools/gpu/export': { label: 'GPU 시계열 내보내기', slow: true },
  '/tools/hardware': { label: '하드웨어 인벤토리' },
  '/tools/esxi': { label: 'ESXi 버전·패치 현황' },
  '/tools/esxi-temp': { label: '서버 온도 조회' },
  '/tools/esxi-temp/spark': { label: '서버 온도 24시간 추이' },
  '/tools/hba': { label: 'HBA·스토리지 경로 조회' },
  '/tools/licenses': { label: '라이선스 현황' },
  '/tools/license-expiry': { label: '라이선스 만료 점검' },
  '/tools/guest-os': { label: '게스트 OS 분포' },
  '/tools/guest-disk': { label: '게스트 디스크 사용량' },
  '/tools/duplicate-ips': { label: '중복 IP 점검' },
  '/tools/network-check': { label: '네트워크 구성 점검' },
  '/tools/deep-search': { label: '전체 심층 검색', slow: true },
  '/tools/vm-finder': { label: 'VM 찾기' },
  '/tools/ipam': { label: 'IP 원장 조회' },
  '/tools/ipam/netmap': { label: 'IP 대역 지도 집계' },
  '/tools/ipam/sheet': { label: 'IP 원장 시트 생성', slow: true },
  '/tools/relaycheck': { label: 'HAProxy 경로 점검 상태' },
  '/tools/relaycheck/run': { label: 'HAProxy 경로 즉시 점검', slow: true },
  '/tools/relaytopo': { label: '중계 토폴로지 조회' },
  '/tools/pdu': { label: 'PDU 전력 조회' },
  '/tools/bm-storage': { label: '베어메탈 스토리지 조회' },
  '/tools/vmware-config': { label: 'VMware 구성 내보내기', slow: true },
  '/tools/ip-ping': { label: 'IP 응답 확인', slow: true },
  '/search/nl': { label: '자연어 검색', slow: true },
  '/insights/chatops': { label: 'AI 질의 응답', slow: true },
};

/**
 * 접두 일치 표(정확 일치가 없을 때). **긴 접두부터** 검사한다.
 * 배열 순서가 곧 우선순위이므로, 더 구체적인 접두를 위에 둘 것.
 */
const PREFIX = [
  ['/vms/', { label: 'VM 상세 조회' }],
  ['/hosts/', { label: '호스트 상세 조회' }],
  ['/datastores/', { label: '데이터스토어 탐색', slow: true }],
  ['/provision/', { label: 'VM 프로비저닝 준비', slow: true }],
  ['/vmclone/', { label: 'VM 복제 작업' }],
  ['/vmtrack/', { label: '추이 트래킹 조회' }],
  ['/idrac/', { label: 'iDRAC 전력·센서 조회' }],
  ['/storage/', { label: '스토리지 수집 조회' }],
  ['/sanswitch/', { label: 'SAN 스위치 조회' }],
  ['/svcmon/', { label: '서비스 모니터 조회' }],
  ['/ping/', { label: '핑 모니터 조회' }],
  ['/remote/', { label: '원격 접속 준비', slow: true }],
  ['/rma/', { label: '원격 명령 작업', slow: true }],
  ['/central/rma-poll', { label: '엣지 명령 대기(롱폴)', slow: true }],
  ['/admin/perf', { label: '서버 성능 측정 조회' }],
  ['/admin/security/self-check', { label: '보안 자가진단' }],
  ['/admin/backup', { label: '포탈 백업 작업', slow: true }],
  ['/admin/agent-deploy', { label: '엣지 배포 작업', slow: true }],
  ['/admin/', { label: '관리 설정 조회' }],
  ['/tools/', { label: '특수 기능 조회' }],
  ['/insights/', { label: '인사이트 조회' }],
  ['/reports/', { label: '리포트 생성', slow: true }],
];

/** 표에 없는 경로를 읽을 수 있게 다듬는다 — 지어내지 않고 경로를 그대로 쓴다. */
function humanize(path) {
  const p = String(path || '').replace(/^\/+/, '');
  if (!p) return '요청';
  return p.replace(/\//g, ' › ');
}

/**
 * 경로 → 작업 이름.
 * @returns {{label:string, slow:boolean, known:boolean, path:string}}
 */
export function taskLabel(path) {
  const p = String(path || '');
  const hit = EXACT[p];
  if (hit) return { label: hit.label, slow: !!hit.slow, known: true, path: p };
  for (const [prefix, v] of PREFIX) {
    if (p.startsWith(prefix)) return { label: v.label, slow: !!v.slow, known: true, path: p };
  }
  return { label: humanize(p), slow: false, known: false, path: p };
}

/** 초를 짧게(1초 미만은 '1초 미만' — 0초라고 쓰면 안 기다린 것처럼 보인다). */
export function secText(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return '1초 미만';
  return `${Math.round(n / 1000)}초`;
}

/**
 * 진행 중 요청 목록 → 표시용 행. 오래 기다린 것부터, 최대 `limit` 건.
 * 같은 작업이 여러 건이면 하나로 묶고 건수를 붙인다(폴링이 겹칠 때 같은 줄이 반복되지 않게).
 */
export function taskRows(inflight = [], { limit = 3, normalize = (x) => x } = {}) {
  const rows = (inflight || []).filter((x) => x && x.path);
  const byLabel = new Map();
  for (const r of rows) {
    const t = taskLabel(normalize(r.path));
    const prev = byLabel.get(t.label);
    const ms = Number(r.ms) || 0;
    if (prev) { prev.count += 1; prev.ms = Math.max(prev.ms, ms); }
    else byLabel.set(t.label, { label: t.label, slow: t.slow, known: t.known, path: t.path, ms, count: 1 });
  }
  return [...byLabel.values()].sort((a, b) => b.ms - a.ms).slice(0, Math.max(1, limit));
}

/**
 * 전역 진행 표시용 판정(순수). 가장 오래 기다린 요청이 문턱을 넘었을 때만 보인다.
 *
 * 왜 전역인가: 화면 로딩(`<Loading/>`)뿐 아니라 **버튼 동작**(저장·연결 테스트·내보내기·배포)도
 * 3초 이상 기다릴 수 있다. 호출부 100여 곳을 고치는 대신, 요청 등록부(perfClient)를 구독해
 * 한 곳에서 보여준다 — 새 화면을 만들어도 자동으로 적용된다.
 *
 * @returns {{show:boolean, tasks:Array, oldestMs:number}}
 */
export function visibleProgress(inflight = [], { detailMs = 3_000, limit = 3, normalize = (x) => x } = {}) {
  const rows = (inflight || []).filter((x) => x && x.path);
  const oldestMs = rows.reduce((m, r) => Math.max(m, Number(r.ms) || 0), 0);
  if (!rows.length || oldestMs < detailMs) return { show: false, tasks: [], oldestMs };
  return { show: true, tasks: taskRows(rows, { limit, normalize }), oldestMs };
}
