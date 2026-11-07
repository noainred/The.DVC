/**
 * bmusage/tuning/catalog.js — 튜닝 탭 **항목 26 카탈로그**(v2.923 예정 · 리눅스 성능 4단계 · 설계 `TUNING-SOURCES.md` 항목표 · 아트보드 ⑤ Tuning.dc.html).
 *
 * 값을 코드에 흩뿌리지 않는다 — 항목 · 읽는 곳 · 역할별 권장 · 근거 요지(인용) · 출처 id · 근거 등급을 **이 표 하나**에 둔다(TUNING-SOURCES 구현 메모).
 * 판정은 `judge.js`(순수) · 역할 권장값의 법인 덮어쓰기는 `overrides.js`(설정 소유자 · 감사) · 기능 프로파일의 요구값 병합은 `profiles/merge.js`.
 *
 * ⚠⚠ **자동 적용 없음** — 이 모듈 · 판정 · API 어디에도 쓰기 경로(sysctl -w · tuned-adm · ethtool -G)가 없다. 화면은 읽기 전용이다(설계 §4.3 · §6-3).
 * ⚠ **역할 권장값의 근거는 ‘DB’ 열뿐이다**(TUNING-SOURCES ‘항목표(역할 DB 기준)’). 웹·캐시·파일·일반 역할에는 **워크로드와 무관한 문서 권고만** 같은 값으로 두고
 *   (irqbalance · 스케줄러 · softnet · txqueuelen · 채널 · min_free_kbytes · dirty 기본), DB 를 전제로 한 값(TuneD 프로파일 · governor · swappiness 10 · THP madvise · HugeTLB)은
 *   **권장 없음(참고)** 으로 둔다 — 값을 지어내지 않는다(관리자가 설정에서 정한다).
 * ⚠ 근거 등급은 설계 표 그대로(● 원문 대조 · ◐ 검색 발췌 · ○ 공식 문서 없음). 출처가 없는(—) 항목은 등급 ○ 다(테스트가 고정).
 *
 * 규칙(rule) 모양 — judge.js 가 해석한다:
 *   { kind:'oneOf', values:[…], text } · { kind:'eqNum', value, text } · { kind:'maxPctMem', pct, text }(물리 메모리 대비 상한) ·
 *   { kind:'info', text }(권장 없음 · 참고) · { kind:'hold', text, reason }(판단 보류 → 확인 불가) · { kind:'custom', id, text }(judge.js 의 이름 있는 규칙)
 */

export const ROLES = Object.freeze(['db', 'web', 'cache', 'file', 'general']);
export const DEFAULT_ROLE = 'general';
/** 분류 ①~⑤(아트보드 카드 순서). */
export const CATEGORIES = Object.freeze([
  { no: 1, id: 'tuned', title: 'TuneD 프로파일 — 먼저 프로파일, 그다음 개별 sysctl', reads: 'tuned-adm active(/etc/tuned/active_profile)' },
  { no: 2, id: 'cpu', title: 'CPU · 전력 · 인터럽트 · NUMA', reads: '/sys/devices/system/cpu/cpu0/cpufreq · systemctl is-active irqbalance · /proc/interrupts 요약 · /proc/sys/kernel/numa_balancing · /proc/cmdline(화이트리스트 키)' },
  { no: 3, id: 'mem', title: '메모리', reads: 'sysctl vm.* · /sys/kernel/mm/transparent_hugepage/enabled · /proc/meminfo HugePages_*' },
  { no: 4, id: 'disk', title: '스토리지 I/O', reads: '/sys/block/*/queue/{scheduler,nr_requests,read_ahead_kb,rotational}' },
  { no: 5, id: 'net', title: '네트워크', reads: '/proc/net/softnet_stat · /sys/class/net/*(tx_queue_len · 큐 수) · sysctl net.core.* · 수집 주기의 NIC 드롭 증가분' },
]);

/** 상태 code(서버) — 화면 문구는 웹이 소유한다. ‘확인 불가’(unknown)는 ‘불일치’ 가 아니다 — 권고 수에 넣지 않는다. */
export const TUNING_STATUS = Object.freeze(['advise', 'ok', 'info', 'unknown']);
/** 사유 code(서버) — 웹 문구 표와 1:1(테스트 대조). */
export const TUNING_REASON = Object.freeze([
  'notRead',          // 그 값을 읽지 못했다(구획 못 읽음)
  'notPresent',       // 구획은 읽었는데 그 값이 없다(파일 없음 — TuneD 미사용 · 가상 머신의 cpufreq 없음 등)
  'noRec',            // 이 역할에 문서 근거 권장값이 없다(참고)
  'hold',             // 문서가 판단 기준을 주지 않는다(판단 보류)
  'noDevice',         // 해당 장치가 없다(NVMe 없음 등)
  'cumulative',       // 부팅 이후 누적값 — 지금 늘고 있는지 모른다
  'ethtoolNotRead',   // NIC 쪽 카운터(ethtool)를 읽지 않는다
  'numaNotRead',      // IRQ 의 NUMA 노드를 읽지 않는다
  'dbConfigNotRead',  // DB 설정(공유 버퍼)을 읽지 못한다
  'noRtt',            // RTT 측정값이 없다(판단 재료 없음)
  'snapshotOnly',     // 진단 스냅샷에서만 보이는 값
  'changed',          // 기본값에서 바뀌었다(바꾼 근거 확인 — 참고)
  'noDrops',          // 드롭이 없다 — 지금은 손댈 이유가 없다
  'unitsNotRead',     // 실행 유닛 목록을 못 읽었다
  'memNotRead',       // 물리 메모리 크기를 못 읽었다(비율 계산 불가)
  'coresNotRead',     // 코어 수를 못 읽었다
  'appConfigNotRead', // 앱 설정 파일(airflow.cfg 등)을 읽지 않는다
  'policyNotRead',    // 켜져 있지만 허용 구성인지(SELinux 정책 · 방화벽 규칙) 읽지 않는다
  'notExplicit',      // 명시 설정이 없다(배포판 기본값은 확인하지 않았다)
  'systemMount',      // 시스템 마운트라 판정에서 뺐다(데이터 볼륨 구분 불가 — 추정)
]);

const SYS = (k) => (tu) => (tu?.sysctl && Object.hasOwn(tu.sysctl, k) ? tu.sysctl[k] : undefined);
/**
 * v2.923(반증 R9) — 두 값을 한 칸으로 묶은 사실(‘a / b’). 한쪽을 못 읽으면 그 자리는 ‘—’(표시용)이고, **판정은 하지 않는다**(judge.js evalRule 이 hasMissingPart 로
 *   확인 불가 처리 — ‘16777216 / —’ 를 ‘16777216 / 16777216’ 과 비교해 권고로 만들지 않는다). 업그레이드 기간에 새 sysctl 키를 보내지 않는 엣지(v2.922)가 섞여도 권고가 새지 않게.
 */
export const PART_MISSING = '—';
export function pairText(a, b) { return a === undefined && b === undefined ? undefined : `${a ?? PART_MISSING} / ${b ?? PART_MISSING}`; }
export function hasMissingPart(v) { return typeof v === 'string' && v.includes(' / ') && v.split(' / ').some((x) => x.trim() === PART_MISSING); }
/** 이번 주기 물리 NIC 드롭 증가분의 합(OS) — 읽은 NIC 가 없거나 전부 첫 표본이면 undefined(0 으로 두지 않는다). */
export function osDropSum(detail) {
  if (!Array.isArray(detail?.nics)) return undefined;
  const v = detail.nics.map((x) => x?.dropDelta).filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * 항목 26. `fact(tu, detail)` 는 현재값(표시용 문자열 · 숫자 · 장치 배열)을 돌려준다 — 못 읽었으면 undefined(‘확인 불가’).
 * `section` 은 그 값이 오는 구획(tuning.sections) — 구획이 ok 인데 값이 없으면 ‘그 서버에 없음’(파일 없음)이다.
 * `rec` 는 역할 → 규칙. `all` 은 다섯 역할 공통. `overridable` 은 관리자 덮어쓰기를 받는 항목(eq · eqNum 의미만).
 */
export const TUNING_ITEMS = Object.freeze([
  // ── ① TuneD ─────────────────────────────────────────────────────────────
  {
    id: 'tuned.active', cat: 1, title: 'tuned-adm active', reads: '/etc/tuned/active_profile', section: 'sysctl', fact: SYS('tuned.active_profile'), valueKind: 'str', overridable: true,
    rec: { db: { kind: 'oneOf', values: ['throughput-performance', 'latency-performance'], text: 'throughput-performance(저지연 DB 면 latency-performance)' } },
    evidence: '“A server profile optimized for high throughput. It disables power savings mechanisms and enables sysctl settings that improve the throughput performance of the disk and network IO. CPU governor is set to performance.” 프로파일을 바꾸면 이전 프로파일의 변경은 원래대로 돌아간다.',
    sources: ['H1'], grade: '◐',
  },
  {
    id: 'tuned.netThroughput', cat: 1, title: 'network-throughput', reads: '/etc/tuned/active_profile', section: 'sysctl', fact: SYS('tuned.active_profile'), valueKind: 'str',
    rec: { all: { kind: 'info', text: '10G 이상 대량 전송 서버만' } },
    evidence: '“It is based on the throughput-performance profile. It additionally increases kernel network buffers.”',
    sources: ['H1'], grade: '◐',
  },
  {
    id: 'tuned.virtualHost', cat: 1, title: 'virtual-host', reads: '/etc/tuned/active_profile', section: 'sysctl', fact: SYS('tuned.active_profile'), valueKind: 'str',
    rec: { all: { kind: 'info', text: 'KVM 호스트 역할만' } },
    evidence: '“virtual-host: basic tuning for virtualization hosts. Enables transparent hugepages and adjusts kernel scheduling parameters.” 활성화 후 재부팅 권고.',
    sources: ['R1'], grade: '●',
  },
  // ── ② CPU · 전력 · 인터럽트 · NUMA ───────────────────────────────────────
  {
    id: 'cpu.governor', cat: 2, title: 'scaling_governor', reads: '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', section: 'sysctl', fact: SYS('cpu.governor'), valueKind: 'str', overridable: true,
    rec: { db: { kind: 'oneOf', values: ['performance'], text: 'performance' } },
    evidence: 'throughput-performance 가 governor 를 performance 로 둔다. powersave 는 “forces the CPU to use the lowest possible clock frequency … at the cost of the lowest CPU performance.” performance 는 전력·발열이 늘 수 있다(RHEL 10 문서).',
    sources: ['H1', 'H6'], grade: '◐',
  },
  {
    id: 'cpu.driver', cat: 2, title: 'scaling_driver', reads: '/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver', section: 'sysctl', fact: SYS('cpu.scaling_driver'), valueKind: 'str',
    rec: { all: { kind: 'info', text: '정보' } },
    evidence: 'RHEL 8.5+ 커널은 같은 장비에서 intel_pstate 대신 intel_cpufreq 가 로드된다(Red Hat 솔루션 6773531). 액티브/패시브는 scaling_driver 값으로 구분.',
    sources: ['H9'], grade: '◐',
  },
  {
    id: 'cpu.irqbalance', cat: 2, title: 'irqbalance', reads: 'systemctl is-active irqbalance', section: 'irq', fact: (tu) => (tu?.irq ? (tu.irq.irqbalance ?? undefined) : undefined), valueKind: 'str', overridable: true,
    rec: { all: { kind: 'oneOf', values: ['active'], text: '실행(active)' } },
    evidence: '“The irqbalance daemon automatically distributes hardware interrupts across CPUs. It runs by default on Rocky Linux and is usually the right starting point for interrupt management.” 격리 CPU 는 IRQBALANCE_BANNED_CPULIST 로 빼고, 너무 많이 빼면 남은 CPU 의 APIC 벡터가 고갈된다. RHEL 10: 끄면 네트워크 처리량에 악영향.',
    sources: ['R2', 'H7'], grade: '● / ◐',
  },
  {
    id: 'cpu.nicIrqNuma', cat: 2, title: 'NIC IRQ ↔ NUMA', reads: '/proc/interrupts 요약(NIC 큐 IRQ 가 0 이 아닌 코어 수)', section: 'irq',
    fact: (tu) => (tu?.irq && tu.irq.nicIrqs != null ? { nicIrqs: tu.irq.nicIrqs, spreadMin: tu.irq.spreadMin, spreadMax: tu.irq.spreadMax, cpus: tu.irq.cpus } : undefined), valueKind: 'irqSpread',
    rec: { all: { kind: 'hold', reason: 'numaNotRead', text: '같은 NUMA 노드 CPU' } },
    evidence: '“Assign IRQs only to CPUs on the matching NUMA node to avoid cross-node memory access during packet processing.” irqbalance 가 못 맞추면(벡터 제약) 수동 핀.',
    sources: ['R2'], grade: '●',
  },
  {
    id: 'cpu.numad', cat: 2, title: 'numad', reads: 'running 서비스 유닛 목록(numad.service)', section: 'units',
    fact: (tu) => (tu?.units && Array.isArray(tu.units.list) ? (tu.units.list.includes('numad.service') ? 'running' : (tu.units.capped ? undefined : 'not-running')) : undefined), valueKind: 'str',
    rec: { all: { kind: 'hold', reason: 'hold', text: '판단 보류(명시 권고 없음)' } },
    evidence: '“numad is an automatic NUMA affinity management daemon. It monitors NUMA topology and resource usage within a system in order to dynamically improve NUMA resource allocation and management.” 어느 워크로드에 켜라는 명시 권고는 못 찾았다.',
    sources: ['H5'], grade: '◐',
  },
  {
    id: 'cpu.numaBalancing', cat: 2, title: 'kernel.numa_balancing', reads: '/proc/sys/kernel/numa_balancing', section: 'sysctl', fact: SYS('kernel.numa_balancing'), valueKind: 'num', overridable: true,
    rec: { all: { kind: 'hold', reason: 'hold', text: '판단 보류(핀 고정 워크로드면 0 — 커뮤니티)' } },
    evidence: 'Red Hat 공식 권고 문장을 찾지 못했다. 벤더·커뮤니티 자료는 ‘수동 핀한 DB·VM 호스트에서 끈다’ 고 적는다 — 판단 보류.',
    sources: [], grade: '○',
  },
  {
    id: 'cpu.isolcpus', cat: 2, title: 'isolcpus · nohz_full · rcu_nocbs', reads: '/proc/cmdline(화이트리스트 키)', section: 'kargs',
    fact: (tu) => {
      if (!tu?.kargs || typeof tu.kargs !== 'object') return undefined;
      const on = ['isolcpus', 'nohz_full', 'rcu_nocbs'].filter((k) => Object.hasOwn(tu.kargs, k)).map((k) => `${k}=${tu.kargs[k]}`);
      return on.length ? on.join(' · ') : '없음';
    },
    valueKind: 'str',
    rec: { all: { kind: 'info', text: '전용 RT·VM 워크로드만(일반 서버는 해당 없음)' } },
    evidence: '“isolcpus=4-63: removes CPUs 4-63 from the general scheduler. Only explicitly pinned tasks run on them.” — 전용 VM·실시간용이고 일반 서버에는 해당 없음.',
    sources: ['R1'], grade: '●',
  },
  // ── ③ 메모리 ─────────────────────────────────────────────────────────────
  {
    id: 'mem.swappiness', cat: 3, title: 'vm.swappiness', reads: '/proc/sys/vm/swappiness', section: 'sysctl', fact: SYS('vm.swappiness'), valueKind: 'num', overridable: true,
    rec: { db: { kind: 'eqNum', value: 10, text: '10' } },
    evidence: '값 0~200 · 기본 60 · 익명 메모리 회수와 페이지 캐시 회수 중 무엇을 선호할지. 0 은 “increases the likelihood that the oom_killer function kills processes during memory or I/O-intensive workloads”(RHEL 10 문구). 10 은 RHEL 6 Performance Tuning Guide 의 Oracle DB 예시와 DB 벤더 관행 — RHEL 9 문서의 명시 권고는 아니다.',
    sources: ['H4', 'H8'], grade: '◐ / ○',
  },
  {
    id: 'mem.thp', cat: 3, title: 'transparent_hugepage/enabled', reads: '/sys/kernel/mm/transparent_hugepage/enabled', section: 'sysctl', fact: SYS('thp.enabled'), valueKind: 'str', overridable: true,
    rec: { db: { kind: 'oneOf', values: ['madvise'], text: 'madvise' } },
    evidence: '“THP is enabled by default in Red Hat Enterprise Linux 9.” madvise 는 요청한 앱에만 huge page 를 주며 “if the workload benefits significantly from THP, the performance decreases.” DB 벤더(MongoDB 등)는 희소 접근 패턴 때문에 끄기를 권장 — Red Hat 문서에 DB 전용 권고는 없다.',
    sources: ['H3'], grade: '◐ / ○',
  },
  {
    id: 'mem.hugetlb', cat: 3, title: 'HugePages_Total (HugeTLB)', reads: '/proc/meminfo HugePages_Total', section: 'hugepages', fact: (tu) => (tu?.hugepages ? (tu.hugepages.total ?? undefined) : undefined), valueKind: 'num',
    rec: { db: { kind: 'hold', reason: 'dbConfigNotRead', text: 'DB 공유 버퍼 크기만큼 예약' } },
    evidence: '부팅 때 예약이 가장 확실(“memory is allocated during the kernel boot”), 1GB 페이지는 default_hugepagesz=1G hugepagesz=1G. Rocky: “Hugepages reduce TLB misses … 16384 MB / 2 MB = 8192 hugepages” 식으로 계산해 vm.nr_hugepages 로 예약.',
    sources: ['H3', 'R1'], grade: '◐ / ●',
  },
  {
    id: 'mem.minFree', cat: 3, title: 'vm.min_free_kbytes', reads: '/proc/sys/vm/min_free_kbytes · /proc/meminfo MemTotal', section: 'sysctl', fact: SYS('vm.min_free_kbytes'), valueKind: 'num',
    rec: { all: { kind: 'maxPctMem', pct: 2, text: '물리 메모리 1~2% 안 · 수백 MB 이하' } },
    evidence: '“A reasonable starting point is 1-2% of total physical memory, not exceeding a few hundred megabytes.” NUMA 에서는 노드별 존에 나뉘어 적용되므로 너무 크면 한 노드만 워터마크를 못 채워 OOM. RHEL 9: 너무 낮으면 회수가 안 돼 “system crashes and failure to service interrupts”.',
    sources: ['R1', 'H4'], grade: '● / ◐',
  },
  {
    id: 'mem.dirty', cat: 3, title: 'vm.dirty_ratio / dirty_background_ratio', reads: '/proc/sys/vm/dirty_ratio · dirty_background_ratio', section: 'sysctl',
    fact: (tu) => pairText(SYS('vm.dirty_ratio')(tu), SYS('vm.dirty_background_ratio')(tu)),
    valueKind: 'str',
    rec: { all: { kind: 'custom', id: 'dirtyDefault', text: '기본 20 / 10 유지' } },
    evidence: 'dirty_ratio “a percentage of total system memory … starts writing those changes to disk. The default value is 20 percent.” background 는 백그라운드 쓰기 시작점, 기본 10. 바꿀 근거(쓰기 지연·캐시 급증)가 없으면 기본 유지.',
    sources: ['H4'], grade: '◐',
  },
  {
    id: 'mem.khugepaged', cat: 3, title: 'khugepaged CPU', reads: '진단 스냅샷의 프로세스 상위(주기 수집 아님)', section: null, fact: () => undefined, valueKind: 'str',
    rec: { all: { kind: 'hold', reason: 'snapshotOnly', text: 'THP madvise 면 줄어듦(보조 관찰)' } },
    evidence: '공식 문서의 khugepaged 튜닝 문장은 찾지 못했다 — THP 권고의 보조 관찰값으로만.',
    sources: [], grade: '○',
  },
  // ── ④ 스토리지 I/O ───────────────────────────────────────────────────────
  {
    id: 'disk.nvmeSched', cat: 4, title: 'NVMe scheduler', reads: '/sys/block/nvme*/queue/scheduler', section: 'blkq', valueKind: 'devices', overridable: true,
    devices: (d) => /^nvme/.test(String(d.name || '')), devValue: (d) => d.scheduler,
    rec: { all: { kind: 'oneOf', values: ['none', 'kyber'], text: 'none(바꾸지 않음 · 대안 kyber)' } },
    evidence: 'NVMe 는 기본이 none 이고 Red Hat 은 바꾸지 말 것을 권고. 표: 고성능 SSD·빠른 스토리지의 CPU 바운드 → none(대안 kyber).',
    sources: ['H2'], grade: '◐',
  },
  {
    id: 'disk.hddSched', cat: 4, title: 'HDD(SCSI) scheduler', reads: '/sys/block/*/queue/scheduler (rotational=1)', section: 'blkq', valueKind: 'devices', overridable: true,
    devices: (d) => d.rotational === true, devValue: (d) => d.scheduler,
    rec: { all: { kind: 'oneOf', values: ['mq-deadline', 'bfq'], text: 'mq-deadline 또는 bfq' } },
    evidence: '“Traditional HDD with a SCSI interface — Use mq-deadline or bfq.” 가상 게스트는 mq-deadline, 멀티큐 HBA 면 none. 영구 설정은 udev 규칙 또는 TuneD 로(Red Hat 권고).',
    sources: ['H2'], grade: '◐',
  },
  {
    id: 'disk.nrReqRa', cat: 4, title: 'nr_requests · read_ahead_kb', reads: '/sys/block/*/queue/{nr_requests,read_ahead_kb}', section: 'blkq', valueKind: 'devices',
    devices: () => true, devValue: (d) => `${d.nrRequests ?? '—'} · ${d.readAheadKb ?? '—'}KB`,
    rec: { all: { kind: 'info', text: '권고 없음' } },
    evidence: '공식 권장값 없음. 순차 읽기 비중이 크면 read_ahead 를 올리는 것이 관행이나 근거 문서가 없어 권고하지 않는다.',
    sources: [], grade: '○',
  },
  // ── ⑤ 네트워크 ───────────────────────────────────────────────────────────
  {
    id: 'net.softnet', cat: 5, title: 'softnet_stat time_squeeze', reads: '/proc/net/softnet_stat 3열(누적) · net.core.netdev_budget(_usecs)', section: 'softnet',
    fact: (tu) => (tu?.softnet && tu.softnet.squeezed != null ? tu.softnet.squeezed : undefined), valueKind: 'num',
    rec: { all: { kind: 'custom', id: 'softnet', text: '0 유지 — 0 이 아니면 netdev_budget / netdev_budget_usecs ↑' } },
    evidence: '“A nonzero time_squeeze value (column 3) means the kernel ran out of its netdev_budget before it could process all pending packets.” 0 이 아니면 netdev_budget / netdev_budget_usecs(기본 300 / 2000) 를 올린다(예 600 / 4000).',
    sources: ['R2'], grade: '●',
  },
  {
    id: 'net.dropCounters', cat: 5, title: 'rx_dropped vs rx_dropped.nic', reads: '수집 주기 NIC 드롭 증가분(OS) · ethtool -S(읽지 않음)', section: null,
    fact: (tu, detail) => osDropSum(detail), valueKind: 'num',
    rec: { all: { kind: 'custom', id: 'dropCounters', text: '판정 규칙(커널 드롭인지 NIC 드롭인지)' } },
    evidence: '“When rx_dropped.nic is zero but rx_dropped is increasing, the problem is in the kernel, not the hardware.” 케이블·SFP 교체로는 커널 드롭이 안 잡힌다 — 교차 판정 ④ 의 근거.',
    sources: ['R2'], grade: '●',
  },
  {
    id: 'net.ring', cat: 5, title: 'ring buffer rx/tx', reads: 'ethtool -g(읽지 않음) · 수집 주기 NIC 드롭 증가분', section: null,
    fact: () => undefined, valueKind: 'str',
    rec: { all: { kind: 'custom', id: 'ring', text: '드롭이 있을 때만 최대까지' } },
    evidence: '“Larger ring buffers give the kernel more time to process packets before the buffer overflows and drops occur.” 상한은 ethtool -g 의 Pre-set maximums. 큐가 많으면 메모리가 커진다 — 단계적으로. 재부팅에 지워지므로 NM dispatcher 로 영구화.',
    sources: ['R2'], grade: '●',
  },
  {
    id: 'net.txqueuelen', cat: 5, title: 'txqueuelen', reads: '/sys/class/net/*/tx_queue_len(물리 NIC)', section: 'netq', valueKind: 'nics', overridable: true,
    nicValue: (x) => x.txqlen,
    rec: { all: { kind: 'custom', id: 'txqueuelen', value: 1000, text: '1000 유지(TX 드롭이 확인될 때만 ↑ · 20000 초과 금지)' } },
    evidence: '“Start with the default (1000) and increase only if monitoring confirms TX drops.” 20000 초과는 bufferbloat.',
    sources: ['R2'], grade: '●',
  },
  {
    id: 'net.channels', cat: 5, title: 'combined channels', reads: '/sys/class/net/*/queues/rx-*(물리 NIC 큐 수 — ethtool -l 의 근사)', section: 'netq', valueKind: 'nics',
    nicValue: (x) => x.rxq,
    rec: { all: { kind: 'custom', id: 'channels', text: '네트워크 처리 CPU 수 이하' } },
    evidence: '“A common approach is to set the combined channel count equal to the number of CPUs available for network processing. Having more queues than available CPUs … offering no performance benefit.”',
    sources: ['R2'], grade: '●',
  },
  {
    id: 'net.rmemMax', cat: 5, title: 'net.core.rmem_max / wmem_max', reads: '/proc/sys/net/core/{rmem_max,wmem_max}', section: 'sysctl',
    fact: (tu) => pairText(SYS('net.core.rmem_max')(tu), SYS('net.core.wmem_max')(tu)),
    valueKind: 'str',
    rec: { all: { kind: 'hold', reason: 'noRtt', text: 'WAN 복제·대량 전송만 ↑' } },
    evidence: '기본 212992 바이트(208 KiB) — setsockopt() 가 요청할 수 있는 상한. 고처리량 예시는 16 MiB(RHEL 10 문서 — RHEL 9 원문 미확인). RTT 측정값이 없어 판단 불가.',
    sources: ['H7'], grade: '◐',
  },
  {
    id: 'net.somaxconn', cat: 5, title: 'net.core.somaxconn', reads: '/proc/sys/net/core/somaxconn', section: 'sysctl', fact: SYS('net.core.somaxconn'), valueKind: 'num', overridable: true,
    rec: { all: { kind: 'info', text: '권고 없음' } },
    evidence: 'Red Hat·Rocky 공식 권장값을 찾지 못했다(커뮤니티 글은 65535 등을 제안) — 권고하지 않는다.',
    sources: [], grade: '○',
  },
]);

const BY_ID = new Map(TUNING_ITEMS.map((x) => [x.id, x]));
export function itemOf(id) { return BY_ID.get(String(id || '')) || null; }

/** 역할 → 항목 규칙(기본값). 역할 키가 없으면 `all`, 그것도 없으면 ‘권장 없음’. */
export function roleRule(item, role) {
  if (!item?.rec) return null;
  return item.rec[role] || item.rec.all || null;
}
export const NO_REC = Object.freeze({ kind: 'info', text: '권장 없음(이 역할에 문서 근거 권장값 없음 — 관리자가 설정에서 정합니다)', reason: 'noRec' });
