# 용도 분석 — OS × 기능 프로파일 · 장애 기록 · 평균/피크 (4차 · 2026-11-06)

시안 아트보드 ⑥ `Profiles.dc.html` · ⑦ `Faults.dc.html` · ⑧ `AvgPeak.dc.html` 의 근거. 요청(2026-11-06 22:08~22:20 KST, 세 건):
1. "베어메탈 서버가 용도가 rocky/ubuntu, hadoop, airflow, gpdb 등의 용도가 있어, Windows 서버도 있고, OS와 기능을 조합해서 분석하는 기능 추가해줘, 이번에는 Rocky 9.4 버전에 airflow, gpdb 기능만 추가하고, 향후에 추가 기능 추가할 수 있게 해줘, 일단 rocky9, airflow 의 정상 동작 점검 및 튜닝 가이드 등을 인터넷에서 분석해서 추가해줘"
2. "수집하고 있는 하드웨어 파트 장애도 수집하고 있으니까 장애 기록 보는 기능 추가해줘"
3. "성능 지표 수집하는데, 평균 값을 표현하는 화면과, 수집할때 피크치를 수집해 보여주는 화면을 두개로 보여주고, 시간축으로 동기화 해서 보는 기능 만들어줘, 보는 대상은 cpu disk network 다양한 큐 사용량, 버퍼 사용량 등을 보여줘"

## 1. 프로파일 모델(확장 구조)

- **프로파일 1개 = 파일 1개**(`server/src/bmperf/profiles/<id>.js` 예정): `{ id, kind: 'os'|'app', match, checks[], tunings[], sources[] }`.
  - `match`(전부 읽기 전용 감지): OS 는 `/etc/os-release`(ID · VERSION_ID) 와 Windows `Caption`; 기능은 systemd running 유닛(이름은 설정값) · 프로세스 이름 · 수신 포트(`ss -ltn`) · 설정 파일 경로 · 계정 존재(`getent passwd`). **수동 태그가 덮어쓴다**(기존 fleet-tags 의 baremetal/virtualization/exclude 와 같은 저장소 형식에 `purposes[]` 를 더한다 — 새 등록부를 만들지 않는다).
  - `checks[]`: `{ id, title, how(명령·SQL·HTTP — 엣지가 실행), freq, severity, verdict(순수 함수), source }`.
  - `tunings[]`: `{ key, read(어디서 읽나), recommend(값 또는 함수), evidence, source, grade('●'|'◐'|'○') }`.
  - **우선순위: 기능 &gt; 역할 &gt; OS 기본**. 같은 키가 겹치면 상위가 이기고 화면이 ‘누가 정했는지’(프로파일 id)를 적는다. 예: `vm.swappiness` — OS 기본 60 / 역할 DB 10 / gpdb 1 → gpdb.
  - 한 서버에 기능이 둘 이상이면 둘 다 적용(Airflow 워커 + GPDB 세그먼트).
  - 카탈로그 테스트: 매칭 규칙 · 모든 항목의 `source` 번호 · `grade` 가 비면 실패. 새 프로파일은 파일 추가 + 테스트.
- 감지를 위해 Linux SSH 1회 명령에 구획 추가: `##OSREL`(os-release) · `##UNITS`(`systemctl list-units --type=service --state=running --no-legend`, 상한 줄 수) · `##PROCS`(`ps -eo comm,args --sort=-%cpu | head -N`) · `##PORTS`(`ss -ltnH`). 왕복은 그대로 1회.
- 이번 활성: `rocky9-base`(OS) · `airflow`(기능) · `gpdb`(기능). 예정: `ubuntu-base` · `windows-base` · `hadoop`. 프로파일이 없는 조합은 매트릭스에 ‘프로파일 없음’ 으로 보이고 **점검하지 않는다**(틀린 판정보다 낫다).

## 2. rocky9-base — 점검 항목과 근거

| 점검 | 방법 | 근거 | 출처 | 등급 |
|---|---|---|---|---|
| 버전·업그레이드 경로 | `/etc/os-release` VERSION_ID · `dnf check-update` 요약 | “You can upgrade from Rocky Linux 9.x to Rocky Linux 9.4 by running sudo dnf -y upgrade.” 8 → 9 업그레이드 경로 없음(새로 설치) | R3 | ● |
| 폐기 스트림 사용 여부 | `dnf module list --enabled` | Node.js 16 · .NET 7 · OpenJDK 11(2024-10 EoL) 은 더 이상 갱신되지 않는다 | R3 | ● |
| 알려진 문제 분류 | 링크만 | 9.4 알려진 문제는 분류(설치·보안·커널·파일시스템…)만 적고 상세는 upstream — 화면은 분류와 링크만 보여 준다 | R3 | ● |
| TuneD 활성 프로파일 | `tuned-adm active` | 튜닝 탭(⑤) H1 | H1 | ◐ |
| PCP/Cockpit 전제(선택) | `systemctl is-active pmlogger pmproxy cockpit` | RHEL 9 웹 콘솔 ‘Metrics and history’ 는 pmlogger·pmproxy 가 켜져 있어야 한다 | RHEL 9 web console 문서(검색 발췌) | ◐ |
| systemd 실패 유닛 · journal 오류 · chrony 동기 | `systemctl --failed` · `journalctl -p err --since -24h` · `chronyc tracking` | 공식 권고 문장 없음(일반 관행). 시각 동기화는 GPDB 가 요구한다(G1 “Synchronize system clocks”) | — / G1 | ○ / ● |
| SELinux · firewalld · RemoveIPC | `getenforce` · `systemctl is-active firewalld` · `logind.conf RemoveIPC` | GPDB 요구(“SELinux must either be Disabled or configured to allow unconfined access …” · firewalld 끄거나 허용 · RemoveIPC=no) — gpdb 프로파일이 있을 때만 판정 | G1 | ● |

## 3. airflow — 점검·튜닝과 근거(원문 확인 ●)

점검: 스케줄러 하트비트(`airflow jobs check --job-type SchedulerJob --hostname $(hostname)`, 비정상이면 non-zero) · 스케줄러 헬스 서버(`[scheduler] enable_health_check=True`, 기본 False, 포트 8974, 200/503 — 켜면 기존 svcmon HTTP 점검으로 등록) · API 서버 `/api/v2/monitor/health`(metadatabase · scheduler · triggerer · dag_processor, 임계값 `scheduler_health_check_threshold` 등; 웹서버 프로브는 `api/v2/version` 권고) · 메타 DB 외부(PostgreSQL/MySQL — SQLite 는 시험용) · 실행기(LocalExecutor 기본, 다중 노드는 원격 실행기) · 다중 스케줄러 조건(PostgreSQL 12+ / MySQL 8.0+, `use_row_level_locking`) · 메트릭(StatsD/OTel — `dag_processing.import_errors` · `total_parse_time` · `dagbag_size` · `executor.open_slots` · `queued_tasks` · `pool.open_slots` · `scheduler.tasks.starving` · `ti_failures`): **수신기가 없어 이번 범위 밖(‘미수집’ 표시)** · 서비스 유닛·로그(유닛 이름은 현장 설정 ○).

튜닝: `max_tis_per_query ≤ core.parallelism`(0 = 같게) ● · `use_row_level_locking` ● · `max_dagruns_per_loop_to_schedule`(작은 DAG ↑ · 500+ 태스크 DAG ↓) ● · `orphaned_tasks_check_interval` · `scheduler_health_check_threshold` ● · DAG top-level 코드·Variable 접근 제거 ● · 스케줄러 자원(CPU·메모리·I/O, working memory 기준) ● · `parsing_processes` · `min_file_process_interval` · `parallelism` · `max_active_tasks_per_dag` 은 3rd party 요약(◐ — Airflow 3 는 dag-processor 설정으로 옮겨 갔을 수 있어 구현 때 configurations-ref 대조).

## 4. gpdb — 점검·OS 요구값과 근거(원문 확인 ●)

점검(권장 주기·심각도는 문서값): 다운 세그먼트(`gp_segment_configuration status='d'` · `gpstate -Q`, 5~10분 IMPORTANT) · 선호 역할 이탈(→ `gprecoverseg -r`, 5~10분 CRITICAL) · 분산 쿼리 1행/primary · 데이터 볼륨 공간(5~30분 CRITICAL, 권장 임계 **75%**) · NIC 오류·드롭(매시 IMPORTANT) · RAID(5분 CRITICAL) → 통합 행의 네트워크 E · iDRAC 컨트롤러 값 재사용 · `gpcheckcat -O`(주 1회) · 통계 누락 `gp_stats_missing` · 블로트 `gp_bloat_diag` · VACUUM(일 1회 CRITICAL) · `gpstate -s` · 로그 뷰 · `gpcheckperf`(DB 정지 필요 → 자동 실행 금지).

OS 요구값(“Configuring Your Systems”): `vm.overcommit_memory=2`(“the only safe setting”) · `overcommit_ratio=95` · `vm.swappiness=1` · `kernel.shmall/shmmax` = 물리 메모리 절반(계산식) · `shmmni=32768` · `kernel.sem=32000 1048576000 1000 32768` · `ip_local_port_range=10000 65535` · `net.core.rmem/wmem_max=16777216` · `rmem/wmem_default=2097152` · `netdev_max_backlog=10000` · `tcp_tw_reuse=1` · `zone_reclaim_mode=0` · dirty: 64GB 초과 `dirty_background_bytes=1.5GB` · `dirty_bytes=4GB`(ratio 0), 64GB 이하 ratio 3/10 · `min_free_kbytes` 3%(5% 초과 금지) · limits nofile 524288 · nproc 131072 · core unlimited · `core_pattern=/var/core/core.%h.%t` · XFS `rw,nodev,noatime,inode64` · read-ahead 16384(재부팅에 안 남음) · 스케줄러 NVMe none / SSD none / 그 밖 mq-deadline(RHEL 8·9) · THP never · `RemoveIPC=no` · SELinux 끄거나 허용 · firewalld 끄거나 허용 · 시각 동기화. gpadmin 계정이 아니면 SQL 점검은 ‘권한 없음’.

## 5. 장애 기록(⑦) — 새 수집 없음

기존 `partfault/`(엣지가 iDRAC 부품 상태의 **전이만** 기록 → 중앙 push, `#/tools/part-faults` 의 열린 장애·장애별·종류별·이력)의 `incidents.js` 묶기를 **그대로 재사용**한다(복제 금지). 새로 만드는 것: ① 서버 상세 ‘장애 기록’ 탭(한 서버로 좁힌 incidents + 서버 센서의 최근 SEL/LC + OS 스냅샷 dmesg 를 시간순으로) ② 통합 보드의 하드웨어 E 칸·함대 표(법인·종류·상태·기간 필터) ③ 교차 판정 ‘연관’ 열. 규약은 incidents.js 그대로: 종료 기록 없음 ≠ 정상 복귀 · 부품 제거 ≠ 고침 · 수동 닫음은 평균 지속 제외 · 보류 사유(unknown · device-failed · collection-failed · missing · edge-stale …)는 장애가 아니다 · key-migrated 는 한 건.

## 6. 평균 · 피크 두 화면(⑧)

- 평균 = 지금 `usage_history` 5분 평균. 피크 = 같은 5분 안의 최대 + 발생 시각(`_peak` · `_peak_at` 열 — 지표를 열로 두는 판단 유지, 행 수 불변). 롤업은 평균의 평균 / 최대의 최대.
- 한 시간축: 같은 start/end·롤업 · 커서·brush 공유 · 아래 표는 선택 구간의 평균/피크/상한 대비. 결측은 두 화면 모두 끊고, 피크 샘플이 없는 주기는 ‘—’ 띠.
- 큐·버퍼: CPU 런큐(`loadavg`·`procs_running`) · PSI · 디스크 대기열 깊이(diskstats 12열) 와 await · Dirty/Writeback(`meminfo`) 대 `dirty_bytes` · softnet 백로그 드롭/time_squeeze(`softnet_stat`) 대 `netdev_max_backlog` · qdisc 백로그(`tc -s qdisc`) 대 `txqueuelen` · TCP accept 큐(`ss -ltn` Recv-Q) 대 `somaxconn` · 소켓 메모리(`/proc/net/sockstat`) 대 `tcp_mem` · 페이지 캐시·스왑. **NIC 링 버퍼 점유율은 직접 읽을 수 없다**(rx_dropped.nic 로 간접) — 화면이 ‘관측 불가’ 로 적는다. 상한값은 튜닝 탭(⑤)이 읽는 같은 값을 재사용.
- 피크 수집 3안(정직): **A** 세션 안 1초×N(예 10) 샘플 — ‘10초 창의 피크’(기본) · **B** 서버 경량 샘플러(systemd timer + 셸, 1초 → 5분 avg/max/peak_at 파일, SSH 가 수거, 원시 1초 샘플 서버에 7일 — 법인 단위 옵트인, 스크립트 배포가 필요하고 CPU 부담은 실측 전) · **C** PSI avg10/avg60 · iDRAC 집계 근사(보조). 화면은 피크 값 옆에 어느 안으로 모았는지 항상 적는다.

## 7. 근거 문서(4차 추가 — 확인일 2026-11-06)

| # | 문서 | 확인 |
|---|---|---|
| A1 | Apache Airflow (stable) · Checking Airflow Health Status — https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/check-health.html | ● 원문(HTTP 200) |
| A2 | Apache Airflow (stable) · Production Deployment — https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/production-deployment.html | ● 원문 |
| A3 | Apache Airflow (stable) · Scheduler — https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html | ● 원문 |
| A4 | Apache Airflow (stable) · Metrics Configuration — https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/metrics.html | ● 원문 |
| A5 | Astronomer · Scaling Airflow to optimize performance (3rd party) — https://www.astronomer.io/docs/learn/airflow-scaling-workers | ◐ 검색 발췌 |
| A6 | Apache Airflow (stable) · Best Practices — https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html | ● 원문 |
| G1 | Tanzu Greenplum 7 · Configuring Your Systems — https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/install_guide-prep_os.html | ● 원문 |
| G2 | Tanzu Greenplum 7 · System Configuration (Best Practices) — https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/best_practices-sysconfig.html | ● 원문 |
| G3 | Tanzu Greenplum 7 · Recommended Monitoring and Maintenance Tasks — https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/admin_guide-monitoring-monitoring.html | ● 원문 |
| G4 | Tanzu Greenplum 7 · System Monitoring and Maintenance — https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/best_practices-maintenance.html | ● 원문 |
| R3 | Rocky Linux · Release notes 9.4 — https://docs.rockylinux.org/9/release_notes/9_4/ | ● 원문 |

정직 기록: ① Rocky 9.4 의 공식 ‘정상 동작 점검’ 항목은 릴리스 노트의 세 가지(업그레이드 경로·알려진 문제 분류·폐기 스트림)뿐이라 나머지는 ○(일반 관행)이거나 GPDB 요구(●)에서 가져왔다. ② Airflow 메트릭은 StatsD/OTel 수신기가 있어야 보인다 — 이번 범위 밖. ③ Airflow 3 의 파싱 설정 위치는 미확인. ④ GPDB SQL 점검은 gpadmin 권한이 전제. ⑤ 피크 수집 B 안의 CPU 부담은 실측 전. ⑥ Ubuntu · Windows · Hadoop 프로파일은 만들지 않았다. ⑦ docs.vmware.com 의 Greenplum 주소는 techdocs.broadcom.com 으로 넘어갔다(리다이렉트 확인).

## 8. 추이 탭(②-추이) — 평균/피크 화면을 서버 상세 탭 열로 · 추천 지표 출처 (5차 · 2026-11-06 22:38~)

요청: "⑧ 아트보드를 서버 상세 ‘추이’ 탭 안으로 넣어줘" · "성능 측정, 장애 분석, 서버 성능을 분석할때 보면 좋은 지표도 레딧, 각종 커뮤니티, 벤더사에서 자료 찾아서 차트에 넣어줘".

- ⑧ 은 **서버 상세의 ‘추이’ 탭**이 됐다(아트보드 제목 ②-추이 · ② 와 같은 행에 배치). 서버 상세 ②·⑤·⑦ 의 탭 열을 하나로 통일(요약 · 자원 · 하드웨어 · 장애 기록 · 튜닝 · 용도 · 진단 스냅샷 · 추이(평균 · 피크)). ② 의 24시간 추이 카드에 ‘추이 탭에서 두 화면으로 보기’ 링크.
- 추천 지표 묶음(출처별) + 추가 차트 행 12 를 추이 탭에 넣었다. 각 행은 출처 태그(SRE · NF · USE · DELL · ND · CM)를 달고 평균(회색)·피크(색) 두 선으로 그린다. 읽는 곳은 전부 기존·추가 SSH 구획 안(새 명령 없음).

| 태그 | 출처 | 채택 지표 | 확인 | 등급 |
|---|---|---|---|---|
| SRE | Google SRE Book ch.6 Monitoring Distributed Systems — https://sre.google/sre-book/monitoring-distributed-systems/ | 골든 시그널 4(지연·트래픽·오류·포화). **평균의 위험**(“Observing CPU load over the time span of a minute won’t reveal even quite long-lived spikes”) · 비용 절감은 “internal sampling on the server, then … aggregate” → 평균/피크 두 화면과 B 안의 근거 | 원문(HTTP 200) | ● |
| NF | Netflix TechBlog · Linux Performance Analysis in 60,000 Milliseconds — https://netflixtechblog.com/linux-performance-analysis-in-60-000-milliseconds-accc10403c55 | 60초 체크리스트 10(uptime · dmesg · vmstat · mpstat -P ALL · pidstat · iostat -xz · free · sar -n DEV · sar -n TCP,ETCP · top) — 오류·포화 먼저 | Medium 403 — 미러·요약(sdtimes · SlideShare SREcon 2016 · 노션 미러) | ◐ |
| USE | Brendan Gregg · USE Method: Linux Performance Checklist — https://brendangregg.com/USEmethod/use-linux.html | CPU 포화 = vmstat r > CPU · sar -q(로드 평균 제외 사유: D-state) · 메모리 si/so · sar -B · OOM dmesg · 네트워크 sar -n DEV/EDEV(drop·fifo·rxerr/txerr) | 프록시에서 연결 실패(000) — 검색 발췌 | ◐ |
| DELL | Dell · iDRAC9 Telemetry Streaming Performance Report 백서 — https://dl.dell.com/manuals/common/dell-emc-idrac9-telemetry-streaming-performance-report.pdf | SystemUsage(CPUUsage · MemoryUsage · IOUsage · AggregateUsage, 4.40+ 스키마 · 이전 CUPS) · Power/Thermal 리포트 · 펌웨어 4.00+ · Datacenter 라이선스 | PDF 403 — 검색 발췌 | ◐ |
| ND | Netdata · system CPU · ctxt · softnet 차트(community 가이드 · proc.plugin 문서) | CPU dimensions(user system nice iowait irq softirq steal guest) · 컨텍스트 스위치/s · softirq | 검색 발췌 | ◐ |
| CM | 커뮤니티 블로그 합의(linuxblog.io · sematext · netdata academy · xitoring 등) | 로드 ÷ 코어(1.0× 주의·2.0× 심각 — 출처마다 다름) · iowait 10~30% 지속 → 디스크 · await 20~25ms · %util 80%+ · 2~5분 지속 알림 · 베이스라인 | Reddit r/sysadmin·r/linuxadmin 스레드는 검색 엔진이 돌려주지 않아 직접 인용 못 함 | ○ |

추가 차트 행 12: 로드 1분÷코어(NF·CM) · 런큐 r(USE·NF) · iowait·steal(NF·ND) · 컨텍스트 스위치/s(ND) · softirq·irq(ND·R2) · 코어별 불균형 max−avg(NF) · 스왑 si/so·주요 폴트(USE·NF) · 디스크 avgqu-sz·await(NF·CM) · 디스크 %util(NF·CM) · NIC %ifutil·rxkB/txkB(NF·USE) · NIC rxerr·drop·fifo(USE·R2) · TCP retrans·active/passive(NF). 임계값은 출처마다 달라 **설정값**으로 두고 화면은 출처 범위를 적는다.

정직 기록: Netflix(Medium)·Dell PDF 는 403, brendangregg.com 은 프록시 연결 실패라 원문을 열지 못했다(사용자 에이전트 변경 등 우회는 하지 않았다). Reddit 스레드는 두 번의 검색(extended)에서 하나도 돌아오지 않아 ‘커뮤니티’ 는 블로그 합의(○)로만 적었다. SRE Book 은 원문 확인(●).

## 9. 장치별 보기 — 디스크 · 파티션/마운트 · 인터페이스 (6차 · 2026-11-06 22:53~)

요청: "디스크별, 파티션별, 사용량 · 네트워크 인터페이스별 사용량 보는 기능 추가". 추이 탭(②-추이)에 ‘장치별 보기’ 절을 더했다 — 장치 축 세그먼트(서버 전체 · 디스크별 · 파티션·마운트별 · 인터페이스별)와 장치 칩. 장치를 고르면 위 평균/피크 두 화면이 그 장치 계열로 바뀐다(시간축·구간 유지).

- **A 디스크별 I/O**: `/proc/diskstats` 장치 행 — busy 평균/피크 · await 평균/피크 · IOPS r/w · 처리량 · 대기열/상한(nr_requests) · 오류·SMART(iDRAC) · 추이. 물리 디스크 + dm/md, loop·ram·zram·sr 제외(기존 `isWholeDisk`). **파티션 행은 옵션**(기본 접힘) — 파티션 I/O 는 병합·캐시 때문에 디스크 합과 다를 수 있다고 화면이 말한다. 저장: 장치별 행(`usage_device_history(agent,key,ts,dev,…)` — 장치 수 × 5분, 90일; 서버 대표값과 별개 표).
- **B 파티션·마운트별 공간**: `df -P -k`(가상 FS 제외) + `df -i` — 마운트 · 장치(파티션) · FS · 크기 · 사용/가용 · 사용률 · inode · 7일 증가(일 롤업 기울기) · **가득 예상(선형 추정 — 기울기 0 이거나 7일 미만이면 ‘—’)** · 30일 추이. NFS 등 원격은 제외(스토리지 화면 소관). 기존 `bmstor mounts` 는 그대로 쓰고 나머지 마운트는 이 화면에서만 읽는다(등록부에 넣지 않는다). GPDB 프로파일이 있으면 데이터 볼륨에 75% 임계(G3)를 같이 그린다. 수집: Linux 명령의 `##DF` 를 전체 마운트로 넓힌다(`df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs` · `df -P -i …`).
- **C 인터페이스별**: `/proc/net/dev` + `/sys/class/net`(speed · operstate · bonding 멤버) + iDRAC NICStatistics(CRC · 링크) — 종류(물리/논리/가상) · 속도·상태 · rx/tx 평균·피크 · 사용률 평균/피크 · 드롭 · 오류·CRC · 추이. 사용률은 물리 회선과 bond(멤버 속도 합)만(tun/tap·veth·bridge 제외 — 기존 규칙) · 속도 없으면 처리량만 · 드롭(OS)과 CRC(iDRAC)는 다른 칸.
- 서버 대표값(‘가장 바쁜 장치·회선’)은 그대로이고, 이 절이 그 장치가 어느 것인지 보여 준다. 수치는 가상.

## 10. CVP 스위치 포트 연동 (7차 · 2026-11-06 22:59~)

요청: "CVP 와 연동해서 스위치에서 서버가 연결된 포트의 드랍, 에러, 사용율을 보는 기능 추가". 추이 탭 C 인터페이스별 표에 **스위치 포트(CVP) · 포트 사용률 in/out · 포트 오류·드롭 · 매핑 출처** 4열을 더하고, D ‘스위치 포트 연동’ 절(매핑 출처 표 · 양쪽 대조 표 · 상태 5종)을 넣었다.

**지금 CVP 모듈이 가진 것(코드 근거)**: `cvp/db.js port_latest`(descr · speed_bps · oper · admin · vlan · lag · in/out_bps · in/out_util · in/out_err · rate_ts) · `port_sample`(원시) · `port_daily`(평균+최대) · 인터페이스 설명(v2.649 intfConfig). **없는 것**: 포트 드롭(discards) · LLDP 이웃 · MAC 테이블 — 세 가지 모두 CVP 조회 경로가 **추정**이고(CVP 수집 규칙 v2.608 ‘조회 경로는 전부 추정 · 화면이 말한다’), 실장비에서 FastCounters 가 빈 응답이었던 기록(v2.641)이 있다.

- **매핑 출처(우선순위)**: ① 수동 매핑(설정 파일 — 서버 NIC ↔ 스위치·포트, 확정) ② 포트 설명 매칭(수집 중 — 호스트명·서비스 태그가 설명에 있으면 ‘후보 — 확인 필요’, 사람이 확정) ③ LLDP 이웃(미수집 · 경로 추정 — 구현 때 Telemetry Browser 로 확인) ④ MAC 테이블(미수집 · 보조 — bond·VLAN 에서 흔들린다). 서버 쪽 lldpctl 은 설치 여부가 달라 기본 경로가 아니다(있으면 `##LLDP` 구획). 케이블 이동 등으로 매핑 근거가 바뀌면 승계하지 않고 ‘확인 필요’ 로 되돌린다.
- **포트 드롭**: `parseCounters` 후보 필드에 `inDiscards/outDiscards`(추정) 를 더하고 `port_latest/sample/daily` 에 `in_drop/out_drop` 열 추가. 못 읽으면 ‘미수집’ 으로 둔다(0 아님).
- **양쪽 대조(교차 판정 ⑤)**: 서버 tx ≈ 포트 in · 서버 rx ≈ 포트 out 을 같은 창에서 비교. 기준(예 5%) 이상 어긋나면 ‘중간 손실 또는 계측 창 불일치 후보’ · 포트 오류·드롭만 있으면 ‘케이블·광모듈(GBIC 화면)’ · 서버 드롭만 있으면 ‘커널/큐(교차 ④)’. 서버 5분 · CVP 수집 주기가 다르면 창을 맞춘 뒤 비교하고 못 맞추면 비교하지 않는다.
- **상태**: 매핑 없음 · 후보(확인 필요) · CVP 미등록 법인(열 전체 ‘—’) · 포트 카운터 없음(CVP 빈 응답) · 오래됨.
- **범위·저장**: 범위 계정은 자기 법인 CVP 포트만 · CVP 이력은 기존 표 그대로(서버 쪽에 복제 적재하지 않음) · 사용률은 CVP 의 0~100 밖 버림 규칙 그대로.
- 정직 기록: LLDP·MAC·discards 의 CVP 경로는 이 세션에서 공식 문서로 확인하지 못했다(검색에서 Arista 공식 경로 문서가 나오지 않음). 구현 때 실장비 Telemetry Browser 캡처로 좁힌다(v2.640 ‘원문 표본·파서 시험’ 도구 재사용).

## 11. 추이 확대 팝업 (8차 · 2026-11-06 23:02~)

질문: "추이를 누르면 큰 팝업이 뜨면서 큰 차트를 볼 수 있어?" → 그렇게 설계했다. 추이 탭의 모든 추이 셀(장치별 표의 스파크 15개 · 추천 지표 타일 12개)과 ①② 패널의 ‘⤢ 확대’ 가 **확대 팝업**(아트보드 ②-추이 › 확대 팝업 1440×900)을 연다.
- 팝업(1240×800 모달): 제목(장치 · 지표 · 판정 배지) · 장치/지표 select · 기간 세그먼트 · 표시(평균+피크 / 평균 / 피크) · CSV · 전체 화면 · 닫기(Esc) → 요약 4(평균 · 피크와 시각 · 피크/평균 · 기준 초과 비율) → 큰 차트(평균 회색 · 피크 빨강 · 기준선 설정값 · 선택 구간 음영 · 커서 · 피크 점 툴팁: 그 5분의 평균·대기열·Dirty) → 구간 이동 줄(◀ 이전 · 슬라이더 · 다음 ▶ · 최신 · 날짜로 이동 — 전송 속도·VM 성능과 같은 `WindowScroll` 패턴) → 범례 · 조작 안내 · ‘추이 탭으로’ 링크.
- 피크 점을 누르면 그 5분의 1초 샘플 300개(옵션 B 가 켜진 서버)를 펼친다 — A 안(10초 창)만 있으면 ‘10초 창 샘플 10개’ 로 표기.
- 구현: 기존 `components/VmMetrics.jsx MetricModal`(900px · recharts) 패턴을 넓혀 쓰되 두 선(avg·peak)과 선택 구간·구간 이동을 더한다. 공용 창 계산은 vm-perf 설계의 ‘순수 모듈 공용화’ 를 따른다(복제 금지). 400 폭에서는 전체 화면 모드로 연다.

## 12. 평균/피크 패널의 장치 토글 (9차 · 2026-11-06 23:10~)

요청: "이걸 토글해서 전체 디스크와 개별 디스크/파티션 별로 보는 기능 추가, 전체 네트워크 사용량과 개별 인터페이스 사용량을 보는 기능 추가해서 시안 그려줘".
- 추이 탭 ①② 패널 위에 **토글 줄**(두 패널 공유 · 체크 해제 시 따로): 디스크 행 = 전체(가장 바쁜 장치) / 디스크별 / 파티션·마운트별 · 네트워크 행 = 전체(가장 높은 회선) / 인터페이스별 · 개별 표시 = 겹쳐서(한 행 + 범례) / 행 나눠서(장치마다 행). 새 아트보드 ‘②-추이 › 장치 토글 상태’ 가 토글한 모습(평균: 디스크별 겹침 + 인터페이스별 행 / 피크: 파티션별 행 + 인터페이스별 겹침)을 보여 준다.
- 규칙: 전체 = 대표값(지금) · 개별 = `usage_device_history` 계열(평균·피크 두 벌) · 장치 색 고정(필터로 색이 바뀌지 않는다) · 범례 클릭 = 하나만, Shift = 추가 · 8개 초과면 상위 8 + ‘기타(최대)’ 이고 겹침은 행 나눔으로 자동 전환 · 파티션 I/O 는 옵션(병합·캐시 주의) · 가상 장치·링크 없는 포트 제외 · 개별 행 클릭 = 확대 팝업(장치 상태 공유) · CSV 는 토글 상태대로.
