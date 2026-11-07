# 튜닝 탭 — 항목별 근거와 출처 (3차 · 2026-11-06)

시안 아트보드 ⑤ `Tuning.dc.html` 의 표를 그대로 옮긴 것이다. 구현 때 이 표가 ‘역할별 권장 프로파일’ 기본값과 화면 각주의 원천이 된다(값을 코드에 흩뿌리지 말고 한 모듈 + 테스트).

## 근거 등급(화면 표기)

| 등급 | 뜻 | 이번에 해당 |
|---|---|---|
| ● | 공식 문서 **원문을 받아** 문장을 대조했다 | Rocky Linux 문서 2편(R1·R2 — HTTP 200 수신, `scratchpad` 에 텍스트 보관) |
| ◐ | 공식 문서지만 **검색 결과에 인용된 문장**으로만 확인했다(원문 미열람) | Red Hat 문서 전부(H1~H8) — docs.redhat.com 이 브라우저가 아닌 요청을 403 으로 막았고, 사용자 에이전트를 바꿔 우회하지 않았다 |
| ○ | Red Hat · Rocky 공식 문서에서 권고 문장을 **찾지 못했다**(벤더·커뮤니티 관행) | swappiness 10 · THP 끄기(DB 벤더) · numa_balancing · somaxconn · nr_requests · read_ahead_kb · khugepaged |

## 근거 문서 목록

| # | 문서 | URL | 확인 방법 | 등급 |
|---|---|---|---|---|
| R1 | Rocky Linux · KVM tuning (Rocky 8·9·10 공통 — “AI contribution policy” 표지 있음) | https://docs.rockylinux.org/guides/virtualization/kvm_tuning/ | 원문 수신(200) · 문장 대조 | ● |
| R2 | Rocky Linux 10 · IRQs and kernel packet drops (network performance tuning) | https://docs.rockylinux.org/10/guides/network/performance_tuning/network_performance_irq_tuning/ | 원문 수신(200) · 문장 대조 | ● |
| H1 | RHEL 9 · Monitoring and managing system status and performance › Getting started with TuneD | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/getting-started-with-tuned_monitoring-and-managing-system-status-and-performance | 검색 발췌 | ◐ |
| H2 | RHEL 9 · 같은 문서 › Setting the disk scheduler | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/setting-the-disk-scheduler_monitoring-and-managing-system-status-and-performance | 검색 발췌 | ◐ |
| H3 | RHEL 9 · 같은 문서 › Configuring huge pages (THP · HugeTLB) | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/configuring-huge-pages_monitoring-and-managing-system-status-and-performance | 검색 발췌 | ◐ |
| H4 | RHEL 9 · 같은 문서 › Configuring an operating system to optimize memory access | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/configuring-an-operating-system-to-optimize-memory-access_monitoring-and-managing-system-status-and-performance | 검색 발췌 | ◐ |
| H5 | RHEL 9 · 같은 문서 › Configuring an operating system to optimize CPU utilization (numad · irqbalance · tuna) | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/configuring-an-operating-system-to-optimize-cpu-utilization_monitoring-and-managing-system-status-and-performance | 검색 발췌 | ◐ |
| H6 | RHEL 8 · Tuning CPU frequency to optimize energy consumption / RHEL 10 · Optimizing CPU frequency scaling | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/monitoring_and_managing_system_status_and_performance/tuning-cpu-frequency-to-optimize-energy-consumption_monitoring-and-managing-system-status-and-performance | 검색 발췌(RHEL 9 판 미확인) | ◐ |
| H7 | RHEL 10 · Network troubleshooting and performance tuning › Tuning IRQ balancing · Tuning UDP connections | https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/network_troubleshooting_and_performance_tuning/tuning-irq-balancing · …/tuning-udp-connections | 검색 발췌(RHEL 10 — 9 와 다를 수 있음) | ◐ |
| H8 | RHEL 6 · Performance Tuning Guide 5.5 Tuning Virtual Memory (swappiness 10 · Oracle 예시) | https://docs.redhat.com/en/documentation/red_Hat_enterprise_linux/6/html/performance_tuning_guide/s-memory-tunables | 검색 발췌 · 구판 | ◐ |
| H9 | Red Hat 솔루션 6773531 (RHEL 8.5+ 에서 intel_cpufreq 로드) · RHEL 9 Managing power consumption with PowerTOP | https://access.redhat.com/solutions/6773531 | 검색 발췌 | ◐ |

Rocky 공식 문서에는 범용 ‘성능 튜닝 가이드’ 가 없다(검색 범위 내). Rocky 는 RHEL 재빌드이므로 RHEL 문서를 1차 근거로 쓴다.

## 항목표(역할 ‘DB’ 기준 — 권장값은 관리자가 설정에서 바꾼다)

| 분류 | 항목(읽는 곳) | 권장(DB) | 근거 요지(인용) | 출처 | 등급 |
|---|---|---|---|---|---|
| TuneD | `tuned-adm active` | throughput-performance(저지연 DB 는 latency-performance) | “A server profile optimized for high throughput. It disables power savings mechanisms and enables sysctl settings that improve the throughput performance of the disk and network IO. CPU governor is set to performance.” 프로파일 전환 시 이전 변경은 원복 | H1 | ◐ |
| TuneD | network-throughput | 10G+ 대량 전송만 | “It is based on the throughput-performance profile. It additionally increases kernel network buffers.” | H1 | ◐ |
| TuneD | virtual-host | KVM 호스트만 | “virtual-host: basic tuning for virtualization hosts. Enables transparent hugepages and adjusts kernel scheduling parameters.” | R1 | ● |
| CPU | `scaling_governor` | performance | throughput-performance 가 performance 로 둔다. powersave 는 “forces the CPU to use the lowest possible clock frequency … at the cost of the lowest CPU performance.” performance 는 전력·발열 증가(RHEL 10) | H1 · H6 | ◐ |
| CPU | `scaling_driver` | 정보 | RHEL 8.5+ 커널은 intel_pstate 대신 intel_cpufreq 로드 | H9 | ◐ |
| CPU | irqbalance | 실행 | “runs by default on Rocky Linux and is usually the right starting point for interrupt management.” 격리 CPU 는 IRQBALANCE_BANNED_CPULIST · 너무 많이 빼면 APIC 벡터 고갈. RHEL 10: 끄면 처리량 악영향 | R2 · H7 | ● / ◐ |
| CPU | NIC IRQ ↔ NUMA | 같은 노드 | “Assign IRQs only to CPUs on the matching NUMA node to avoid cross-node memory access during packet processing.” | R2 | ● |
| CPU | numad | 판단 보류 | “automatic NUMA affinity management daemon …” — 어느 워크로드에 켜라는 명시 권고 없음 | H5 | ◐ → 확인 불가 |
| CPU | `kernel.numa_balancing` | 판단 보류 | 공식 권고 문장 없음(커뮤니티: 핀 고정 워크로드면 0) | — | ○ → 확인 불가 |
| CPU | isolcpus · nohz_full · rcu_nocbs | 해당 없음 | “isolcpus=4-63: removes CPUs 4-63 from the general scheduler. Only explicitly pinned tasks run on them.” 전용 VM·RT 용 | R1 | ● |
| 메모리 | `vm.swappiness` | 10 | 0~200 · 기본 60 · 익명/페이지캐시 회수 선호. 0 은 “increases the likelihood that the oom_killer function kills processes …”(RHEL 10). 10 은 RHEL 6 Oracle 예시·DB 벤더 관행 | H4 · H8 | ◐ / ○ |
| 메모리 | THP `enabled` | madvise | “THP is enabled by default in Red Hat Enterprise Linux 9.” madvise 는 요청한 앱에만, “if the workload benefits significantly from THP, the performance decreases.” DB 끄기 권고는 벤더(MongoDB 등) | H3 | ◐ / ○ |
| 메모리 | HugeTLB `HugePages_Total` | DB 공유 버퍼만큼 | 부팅 때 예약이 가장 확실 · `default_hugepagesz=1G hugepagesz=1G` · hugepagesz 뒤에 hugepages. Rocky: “16384 MB / 2 MB = 8192 hugepages” → `vm.nr_hugepages` | H3 · R1 | ◐ / ● → DB 설정 못 읽으면 확인 불가 |
| 메모리 | `vm.min_free_kbytes` | 물리 메모리 1~2% 안 · 수백 MB 이하 | “A reasonable starting point is 1-2% of total physical memory, not exceeding a few hundred megabytes.” NUMA 존별 분배 → 너무 크면 한 노드 OOM. RHEL 9: 너무 낮으면 “system crashes and failure to service interrupts” | R1 · H4 | ● / ◐ |
| 메모리 | `vm.dirty_ratio` / `dirty_background_ratio` | 기본 20 / 10 유지 | dirty_ratio “a percentage of total system memory … The default value is 20 percent.” background 기본 10 | H4 | ◐ |
| 메모리 | khugepaged CPU | 보조 관찰 | 공식 튜닝 문장 없음 | — | ○ |
| 스토리지 | NVMe scheduler | none(바꾸지 않음) | NVMe 기본 none · Red Hat 은 바꾸지 말 것 권고 · 고성능 SSD/CPU 바운드 → none(대안 kyber) | H2 | ◐ |
| 스토리지 | HDD(SCSI) scheduler | mq-deadline 또는 bfq | “Traditional HDD with a SCSI interface — Use mq-deadline or bfq.” 가상 게스트 mq-deadline(멀티큐 HBA 면 none) · 영구화는 udev 또는 TuneD | H2 | ◐ |
| 스토리지 | `nr_requests` · `read_ahead_kb` | 권고 없음 | 공식 권장값 없음 | — | ○ |
| 네트워크 | `softnet_stat` time_squeeze | 0 유지 → 아니면 netdev_budget ↑ | “A nonzero time_squeeze value (column 3) means the kernel ran out of its netdev_budget before it could process all pending packets.” 기본 300 / 2000µs · 예 600 / 4000 | R2 | ● |
| 네트워크 | rx_dropped vs rx_dropped.nic | 판정 규칙 | “When rx_dropped.nic is zero but rx_dropped is increasing, the problem is in the kernel, not the hardware.” → 교차 판정 ④ 근거 | R2 | ● |
| 네트워크 | ring buffer rx/tx | 드롭 있을 때만 최대까지 | “Larger ring buffers give the kernel more time to process packets before the buffer overflows and drops occur.” 상한 = Pre-set maximums · 메모리 주의 · NM dispatcher 로 영구화 | R2 | ● |
| 네트워크 | `txqueuelen` | 1000 유지 | “Start with the default (1000) and increase only if monitoring confirms TX drops.” 20000 초과 bufferbloat | R2 | ● |
| 네트워크 | combined channels | 네트워크 처리 CPU 수 이하 | “set the combined channel count equal to the number of CPUs available for network processing …” | R2 | ● |
| 네트워크 | `net.core.rmem_max` / `wmem_max` | WAN 복제·대량 전송만 ↑ | 기본 212992(208 KiB) · setsockopt 상한 · 예시 16 MiB(RHEL 10) | H7 | ◐ → 확인 불가 |
| 네트워크 | `net.core.somaxconn` | 권고 없음 | 공식 권장값 없음(커뮤니티 65535 등) | — | ○ |

## 구현 메모
- 위 ‘읽는 곳’ 전부를 Linux 수집 명령의 `##SYSCTL`·`##BLKQ`·`##IRQ`·`##NETINFO` 구획에 넣는다(README §4). `tuned-adm active` · `ethtool -g/-l/-S` · `ip -s link` · `/proc/net/softnet_stat` 추가.
- 역할별 권장 프로파일 기본값은 이 표에서 시작하고, **근거 등급과 출처 번호를 데이터에 같이 둔다**(화면 각주가 번호를 가리킨다).
- ◐ 항목은 구현 때 브라우저로 원문을 한 번 더 대조하고, 틀린 것이 있으면 이 표와 화면 문구를 같이 고친다.
- **(v2.923 4단계 구현 — 2026-11-07)** 항목 26개를 `server/src/bmusage/tuning/catalog.js TUNING_ITEMS` 에, 출처를 `tuning/sources.js`(R1 · R2 · H1~H9 + 용도 A1~A6 · G1~G4 · R3 · 확인일 2026-11-06)에 옮겼다 — 화면은 항목마다 등급 기호 + 낱말과 출처 링크를 그린다.
  - 읽은 것: 기존 `##SYSCTL`(14키 추가) · `##BLKQ`(read_ahead_kb 추가) · `##IRQ` · `##NETINFO` + 새 구획 `##KARGS`(isolcpus 등 화이트리스트 키) · `##SOFTNET`(앞 세 열) · `##NETQ`(tx_queue_len · 큐 수) · `##UNITS`(numad · irqbalance). TuneD 는 `/etc/tuned/active_profile` 파일(`tuned-adm` 실행 없음).
  - **읽지 않은 것**: `ethtool -g/-l/-S`(ring 크기 · NIC 쪽 카운터 — 화면은 ‘확인 불가’) · IRQ 의 NUMA 노드 · DB 공유 버퍼 · RTT. 이 항목들은 권고로 세지 않는다.
  - ◐ 항목의 원문 재대조는 **아직 하지 않았다**(Red Hat 문서 403 — 사용자 에이전트를 바꿔 우회하지 않는다는 판단 그대로). 등급 ◐ 를 화면에 그대로 둔다.
