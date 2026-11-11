/**
 * storage/inspect/catalog.js — PowerScale(아이실론) 주간 점검 **항목 · 구분 · 상태 · 참고 자료 표**(v2.964 · 순수 · 설계 `docs/design/powerscale-inspection/README.md` §3 · §7).
 *
 * 규칙(SAN 월간 점검 `sanswitch/healthCheck.js` 와 같다):
 *  · 상태는 다섯 — ok · warn · bad · **unknown(확인 불가 — 사유를 함께)** · na(해당 없음). unknown 을 ok 로 세지 않는다.
 *  · 기준 숫자는 **출처가 준 것만** 쓴다(용량 80 · 90 · 가상 핫 스페어 10 · 스냅샷 10 · 디스크 busy 90). 노드 CPU 는 Dell 이 숫자를 주지 않아 판정하지 않는다.
 *  · 편중 1.5배는 **포탈 기준**(nodeLoad.js SKEW_FACTOR_DEF — v2.937)이고 Dell 수치가 아니다 — 화면 · 보고서가 그렇게 말한다.
 *  · 참고 자료는 전부 '검색 도구가 그 페이지에서 인용한 구절' 수준이다(원문 전체 열람 0건 — README §2). `level` 이 그 사실을 싣는다.
 *
 * ⚠ 명령 · REST 경로는 **실장비 미확인**이다(README §2). 'syntaxUnverified' 는 문서 인용조차 찾지 못하고 기억으로 적은 것.
 */
import { SKEW_FACTOR_DEF } from '../nodeLoad.js';

export const STATUSES = Object.freeze(['ok', 'warn', 'bad', 'unknown', 'na']);
export const STATUS_KO = Object.freeze({ ok: '정상', warn: '주의', bad: '이상', unknown: '확인 불가', na: '해당 없음' });
/** 나쁜 순(정렬 · 구분 대표 상태) — 확인 불가는 주의와 정상 사이(정상으로 흡수하지 않는다). */
export const STATUS_RANK = Object.freeze({ bad: 4, warn: 3, unknown: 2, ok: 1, na: 0 });

/** 구분 다섯 — CloudIQ 건강 점수 분류 [20]. */
export const GROUPS = Object.freeze([
  { id: 'components', label: '구성 요소' },
  { id: 'config', label: '구성' },
  { id: 'capacity', label: '용량' },
  { id: 'performance', label: '성능' },
  { id: 'protection', label: '데이터 보호' },
]);

/** 기준값 기본(설정에서 바꿀 수 있다 — settings.js). */
export const THRESHOLD_DEFAULTS = Object.freeze({
  capWarnPct: 80,      // 증설 발주 시점 [10]
  capBadPct: 90,       // 유지 상한 [1][10]
  poolBadPct: 90,      // 풀마다 90% 미만 [10]
  poolWarnPct: 80,     // 장비 기본 풀 이벤트 단계(warn 80) [11]
  vhsMinPct: 10,       // 가상 핫 스페어 최소 [10]
  snapMaxPct: 10,      // 스냅샷 사용 [1]
  busyMaxPct: 90,      // 디스크 busy 를 '계속' 넘지 않음 [12] — 주간 평균으로 본다
  skewFactor: SKEW_FACTOR_DEF, // 포탈 기준(Dell 수치 아님)
});

/**
 * 주간 점검 20항목. `how` 는 화면 · 보고서에 그대로 싣는 '읽는 방법' 문구, `ssh` · `rest` 는 실제로 쓰는 경로 표지(runner.js 와 같은 이름).
 * `source`: 'snapshot'(기존 수집값 재사용) · 'ssh-only'(REST 경로 없음) · 'both' · 'portal'(포탈 5분 표본).
 */
export const ITEMS = Object.freeze([
  { id: 'cluster-health', no: 1, group: 'components', label: '클러스터 건강', basis: 'Cluster Health 가 OK', how: 'isi status', source: 'snapshot', refs: [3] },
  { id: 'group', no: 2, group: 'components', label: '그룹(쿼럼)', basis: '전 노드가 그룹에 있음', how: 'sysctl efs.gmp.group', source: 'ssh-only', refs: [4] },
  { id: 'events', no: 3, group: 'components', label: '미해결 이벤트', basis: 'critical 이상 0건', how: 'isi event groups list --resolved=false', source: 'both', refs: [3] },
  { id: 'node-state', no: 4, group: 'components', label: '노드 상태', basis: 'ATTENTION · SMARTFAIL · DOWN 없음', how: 'isi status -v', source: 'snapshot', refs: [5] },
  { id: 'drives', no: 5, group: 'components', label: '드라이브', basis: 'HEALTHY 가 아닌 드라이브 0', how: 'isi devices drive list --node-lnn all', source: 'both', refs: [6, 7] },
  { id: 'boot-mirror', no: 6, group: 'components', label: '부트 드라이브 미러', basis: '전 노드 미러 정상', how: "isi_for_array -s 'gmirror status'", source: 'ssh-only', refs: [5], syntaxUnverified: true },
  { id: 'psu', no: 7, group: 'components', label: '전원 공급 장치', basis: '전부 good', how: 'isi_hw_status(Power Supplies)', source: 'both', refs: [8] },
  { id: 'battery', no: 8, group: 'components', label: 'NVRAM 배터리', basis: '전부 good', how: 'isi batterystatus list', source: 'both', refs: [9] },
  { id: 'ifaces', no: 9, group: 'components', label: '네트워크 인터페이스', basis: '구성된 포트 전부 up', how: 'isi network interfaces list', source: 'both', refs: [9] },
  { id: 'healthcheck', no: 10, group: 'config', label: 'HealthCheck 평가', basis: '최근 평가에 FAIL 없음(포탈은 평가를 돌리지 않고 결과만 읽는다)', how: 'isi healthcheck evaluations list', source: 'both', refs: [15, 16] },
  { id: 'ntp', no: 11, group: 'config', label: '시간 동기(NTP)', basis: 'NTP 서버 1개 이상 구성', how: 'isi ntp servers list', source: 'both', refs: [9] },
  { id: 'capacity', no: 12, group: 'capacity', label: '클러스터 사용률', basis: '90% 미만 유지 · 80% 부터 증설 발주', how: '포탈 기존 수집(isi status · REST)', source: 'snapshot', refs: [1, 10] },
  { id: 'pools', no: 13, group: 'capacity', label: '노드 풀 사용률', basis: '풀마다 90% 미만(80% 부터 주의 — 장비 기본 이벤트 단계)', how: '포탈 기존 수집(storagepool)', source: 'snapshot', refs: [10, 11] },
  { id: 'vhs', no: 14, group: 'capacity', label: '가상 핫 스페어', basis: '켜짐 · 10% 이상', how: 'isi status(VHS) · storagepool settings', source: 'both', refs: [10] },
  { id: 'snapshots', no: 15, group: 'capacity', label: '스냅샷 사용', basis: '10% 이하', how: 'isi snapshot snapshots list', source: 'both', refs: [1, 9] },
  { id: 'disk-busy', no: 16, group: 'performance', label: '디스크 busy(7일)', basis: '90% 를 계속 넘지 않음(가장 바쁜 노드의 7일 평균)', how: '포탈 5분 표본(isi statistics drive)', source: 'portal', refs: [4, 12] },
  { id: 'node-skew', no: 17, group: 'performance', label: '노드 편중(7일)', basis: '가장 바쁜 노드 < 노드 평균 × 1.5(포탈 기준)', how: '포탈 5분 표본(isi statistics)', source: 'portal', refs: [14] },
  { id: 'jobs', no: 18, group: 'protection', label: '잡 엔진', basis: '실패한 잡 0', how: 'isi job jobs list · isi status(Failed jobs)', source: 'both', refs: [4, 17] },
  { id: 'reprotect', no: 19, group: 'protection', label: 'FlexProtect · 재보호', basis: '진행 중인 재보호 없음(진행 중이면 업데이트 금지)', how: 'isi job jobs list · isi status', source: 'both', refs: [6, 17] },
  { id: 'synciq', no: 20, group: 'protection', label: 'SyncIQ', basis: '지난 7일 보고서 실패 0(정책이 없으면 해당 없음)', how: 'isi sync reports list', source: 'both', refs: [1, 9] },
]);
export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** 월간 · 분기 세부 점검 — 사람이 검토(보고서 확인란). 자동 판정하지 않는다. */
export const REVIEW_ITEMS = Object.freeze([
  { id: 'm-drive-replaced', cadence: 'month', label: '고장 드라이브 교체가 끝났는가', refs: [1, 7] },
  { id: 'm-alerting', cadence: 'month', label: '알림 경로(메일 · 원격 지원)가 동작하는가', refs: [1, 2] },
  { id: 'm-synciq-rpo', cadence: 'month', label: 'SyncIQ 가 복제 목표 시간(RPO · RTO)을 지키는가', refs: [1] },
  { id: 'm-smartpools', cadence: 'month', label: 'SmartPools 계층 이동이 의도대로인가', refs: [1, 2] },
  { id: 'm-dedupe', cadence: 'month', label: '중복 제거 잡이 매주 도는가(쓰는 장비만)', refs: [1] },
  { id: 'm-smartconnect', cadence: 'month', label: 'SmartConnect 분산 정책이 맞는가(포탈 추가)', refs: [14] },
  { id: 'q-upgrade', cadence: 'quarter', label: 'OneFS 판 · 롤업 패치 · 펌웨어 검토', refs: [1, 18, 19] },
  { id: 'q-capacity-trend', cadence: 'quarter', label: '용량 추세 — 6개월 안에 증설이 필요한가', refs: [1] },
]);

/**
 * 참고 자료(22건) — 설계 README §7 과 같은 표. level: quote(인용 구절) · summary(요약만) · names(명령 이름만) · title(제목만) · partial(인용 일부).
 * ⚠ 원문 전체를 직접 연 자료는 없다(이 세션의 자동 접속이 거부되거나 막혔다).
 */
export const REFS = Object.freeze([
  { n: 1, title: 'PowerScale Healthy Habits Checklist (H18769)', kind: 'Dell 공식 점검표', level: 'partial', url: 'https://www.delltechnologies.com/resources/en-us/asset/tech-notes/products/storage/h18769-tn-powerscale-healthy-habits-checklist.pdf' },
  { n: 2, title: 'Tutorial on Dell PowerScale', kind: 'Dell 지원 동영상', level: 'quote', url: 'https://www.dell.com/support/contents/en-us/videos/videoplayer/tutorial-on-dell-powerscale/6297632052001' },
  { n: 3, title: 'How to check the cluster health and unresolved events (KB 000223412)', kind: 'Dell KB', level: 'quote', url: 'https://www.dell.com/support/kbdoc/en-us/000223412/powerscale-how-to-check-the-cluster-health-and-unresolved-events' },
  { n: 4, title: 'Considerations and Best Practices for Large Clusters (H17300)', kind: 'Dell 백서', level: 'quote', url: 'https://www.delltechnologies.com/asset/en-us/products/storage/industry-market/h17300-wp-powerscale-onefs-large-cluster.pdf' },
  { n: 5, title: 'OneFS Upgrade Planning and Process Guide — Check hardware health (CLI)', kind: 'Dell 매뉴얼', level: 'quote', url: 'https://www.dell.com/support/manuals/en-us/isilon-onefs/ifs_pub_upgrade_planning_and_process_guide/check-hardware-health-cli' },
  { n: 6, title: 'On-Cluster Analysis — Drives Health (KB 000035312)', kind: 'Dell KB', level: 'quote', url: 'https://www.dell.com/support/kbdoc/en-vc/000035312/isilon-on-cluster-analysis-drives-health' },
  { n: 7, title: 'One or more drives are ready to be replaced (KB 000047373)', kind: 'Dell KB', level: 'quote', url: 'https://www.dell.com/support/kbdoc/en-us/000047373/isilon-onefs-event-notification-one-or-more-drives-are-ready-to-be-replaced-event-id-100010010-100010011' },
  { n: 8, title: 'How to check if a Power Supply has failed (KB 000020717)', kind: 'Dell KB', level: 'quote', url: 'https://www.dell.com/support/kbdoc/en-in/000020717/isilon-how-to-check-if-a-power-supply-is-genuinely-failed-and-to-confirm-its-firmware-version-using-cli' },
  { n: 9, title: 'OneFS CLI Command Reference (9.3 ~ 9.15)', kind: 'Dell 매뉴얼', level: 'names', url: 'https://www.dell.com/support/manuals/en-us/isilon-onefs/ila/isi-batterystatus-list' },
  { n: 10, title: 'PowerScale OneFS Best Practices — Cluster capacity management', kind: 'Dell Info Hub', level: 'quote', url: 'https://infohub.delltechnologies.com/l/powerscale-onefs-best-practices/cluster-capacity-management/' },
  { n: 11, title: 'Node pool is at or over capacity (KB 000082018)', kind: 'Dell KB', level: 'summary', url: 'https://www.dell.com/support/kbdoc/en-us/000082018/isilon-onefs-8-2-2-onefs-generates-event-every-hour-node-pool-pool-name-node-pool-id-id-is-at-or-over-capacity' },
  { n: 12, title: 'Check your cluster for bottlenecks (KB 000008978 · 오래된 글)', kind: 'Dell KB', level: 'summary', url: 'https://www.dell.com/support/kbdoc/en-us/000008978/check-your-cluster-for-bottlenecks' },
  { n: 13, title: 'Troubleshooting Performance Issues (KB 000015384)', kind: 'Dell KB', level: 'title', url: 'https://www.dell.com/support/kbdoc/en-us/000015384/emc14001790-troubleshooting-performance-issues' },
  { n: 14, title: 'How SmartConnect Connection Policies Distribute Client Connections (KB 000008416)', kind: 'Dell KB', level: 'quote', url: 'https://www.dell.com/support/kbdoc/en-us/000008416/onefs-how-smartconnect-connection-policies-distribute-client-connections' },
  { n: 15, title: 'How to run the online Health Check Framework (KB 000009330)', kind: 'Dell KB', level: 'quote', url: 'https://www.dell.com/support/kbdoc/en-us/000009330/onefs-how-to-online-run-health-check-framework-hcf-on-cluster' },
  { n: 16, title: 'PowerScale OneFS isi healthcheck', kind: 'Dell 매뉴얼', level: 'quote', url: 'https://www.dell.com/support/manuals/en-us/isilon-onefs/ifs_onefs_isi_healthcheck/list-all-checklists' },
  { n: 17, title: 'PowerScale OneFS Job Engine', kind: 'Dell Info Hub', level: 'quote', url: 'https://www.dell.com/en-us/infohub/articles/powerscale-onefs-job-engine-1' },
  { n: 18, title: 'PowerScale OneFS Current Patches (KB 000184794)', kind: 'Dell KB', level: 'summary', url: 'https://www.dell.com/support/kbdoc/en-us/000184794/powerscale-onefs-current-patches' },
  { n: 19, title: 'On-Cluster Analysis — Upgrade Status (KB 000033892)', kind: 'Dell KB', level: 'summary', url: 'https://www.dell.com/support/kbdoc/en-us/000033892/isilon-on-cluster-analysis-upgrade-status' },
  { n: 20, title: 'CloudIQ — Proactive Health Scores', kind: 'Dell Info Hub', level: 'quote', url: 'https://infohub.delltechnologies.com/p/talking-cloudiq-proactive-health-scores/' },
  { n: 21, title: 'Unstructured Data Quick Tips — OneFS Healthcheck (개인 블로그 · 비공식)', kind: '비공식', level: 'summary', url: 'http://www.unstructureddatatips.com/onefs-healthcheck-enhancements/' },
  { n: 22, title: 'PowerScale (Isilon) OneFS Command Reference (WUC Technologies · 비공식)', kind: '비공식', level: 'quote', url: 'https://www.wuctechnologies.com/resources/field-guides/powerscale-isilon-command-reference/' },
]);
export const REF_LEVEL_KO = Object.freeze({ quote: '인용 구절', partial: '인용 구절(일부)', summary: '요약만', names: '명령 이름만', title: '제목만' });
export const SOURCES_NOTE = '참고 자료는 전부 검색 도구가 그 페이지에서 인용한 구절 · 요약 수준입니다(원문 전체 열람 0건 · Reddit 미참고). 명령 · REST 경로는 실장비 출력으로 아직 확인하지 못했습니다.';

/** 조치 안내(이상 · 주의일 때 보고서 · 화면이 싣는 한 줄) — 근거 번호를 함께. 장비 설정은 포탈이 바꾸지 않는다. */
export const ACTIONS = Object.freeze({
  'cluster-health': '노드 · 이벤트 · 드라이브 항목과 함께 원인을 확인합니다 [3]',
  group: '그룹에서 빠진 노드를 바로 확인합니다(전원 · 백엔드 네트워크) [4]',
  events: '미해결 critical 이벤트를 확인하고 처리한 뒤 resolve 합니다 [3]',
  'node-state': '해당 노드 상태를 확인합니다(isi status -v) [5]',
  drives: 'SmartFail 이 끝나 교체 준비 이벤트가 뜨면 바로 교체합니다 — 그동안 업데이트 작업 금지 [6][7]',
  'boot-mirror': '부트 드라이브 미러를 확인하고 지원을 요청합니다 [5]',
  psu: '전원 공급 장치를 확인하고 지원을 요청합니다 [8]',
  battery: 'NVRAM 배터리를 확인하고 지원을 요청합니다 [9]',
  ifaces: '포트 링크 · 케이블 · 스위치 쪽을 확인합니다',
  healthcheck: 'HealthCheck 실패 항목을 확인합니다(isi healthcheck evaluations view) [15]',
  ntp: 'NTP 서버를 구성합니다 [9]',
  capacity: '80% 를 넘으면 증설 발주를 시작하고 90% 를 넘기지 않습니다 [1][10]',
  pools: '찬 풀의 데이터 정리 · 계층 이동 · 증설을 검토합니다 [10][11]',
  vhs: '가상 핫 스페어를 10% 이상으로 켭니다 [10]',
  snapshots: '큰 스냅샷과 만료 정책을 확인합니다 [1]',
  'disk-busy': '디스크 병목 — 노드별 busy · 큐(isi statistics drive)를 확인합니다 [4][12]',
  'node-skew': '쏠린 노드의 고정 클라이언트 재배치를 검토합니다(노드 부하 › 연결 그래프) [14]',
  jobs: '실패한 잡의 원인을 확인합니다 [17]',
  reprotect: '재보호가 끝날 때까지 업그레이드 · 펌웨어 작업을 보류합니다 [6][17]',
  synciq: '실패한 정책과 복제 목표 시간(RPO)을 확인합니다 [1]',
});

