# 용도 분석 — OS × 기능 프로파일 · 장애 기록 · 평균/피크 (4차 · 2026-11-06)

시안 아트보드 ⑥ `Profiles.dc.html` · ⑦ `Faults.dc.html` · ⑧ `AvgPeak.dc.html` 의 근거. 요청(2026-11-06 22:08~22:20 KST, 세 건):
1. "베어메탈 서버가 용도가 rocky/ubuntu, hadoop, airflow, gpdb 등의 용도가 있어, Windows 서버도 있고, OS와 기능을 조합해서 분석하는 기능 추가해줘, 이번에는 Rocky 9.4 버전에 airflow, gpdb 기능만 추가하고, 향후에 추가 기능 추가할 수 있게 해줘, 일단 rocky9, airflow 의 정상 동작 점검 및 튜닝 가이드 등을 인터넷에서 분석해서 추가해줘"
2. "수집하고 있는 하드웨어 파트 장애도 수집하고 있으니까 장애 기록 보는 기능 추가해줘"
3. "성능 지표 수집하는데, 평균 값을 표현하는 화면과, 수집할때 피크치를 수집해 보여주는 화면을 두개로 보여주고, 시간축으로 동기화 해서 보는 기능 만들어줘, 보는 대상은 cpu disk network 다양한 큐 사용량, 버퍼 사용량 등을 보여줘"

## 1. 프로파일 모델(확장 구조)

> **(v2.923 구현)** 경로는 `server/src/bmusage/profiles/<id>.js`(예정 경로 `bmperf/` 가 아니라 기존 bmusage 아래) · `##PROCS` 는 comm 만(아래 `args` 는 뺐다 — 인자에 비밀이 실린다) · 다르게 둔 결정은 README §8 ‘4단계 구현됨’.

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

## 13. 집중 모니터링 — 10분 × 1분 간격 (10차 · 2026-11-06 23:29~)

요청: "데이터 수집을 설정에서 정한대로 하는데, 장애나 이슈 상황의 경우 '집중 모니터링' 을 위해서 10분동안 1분 간격으로 모니터링 하는 기능 추가해줘, 그리고 10분 동안 수집한 자료를 잘 볼 수 있도록 하는 기능도 추가해줘". 아트보드 ‘②-집중 모니터링 탭’.

- **트리거**: 수동 버튼(operator 이상 · 사유 필수 · 감사 로그 `bm-perf.focus`) + 자동 규칙(기본 꺼짐 · 법인 단위 옵트인): USE 판정이 병목/포화/오류로 바뀔 때 · 부품 장애 열림 · SEL Critical · CVP 포트 오류 증가 · 용도 프로파일 점검 실패. 같은 서버 재발 억제 30분(설정).
- **길이·간격**: 기본 10분 × 1분(설정 — 간격 하한 30초 · 길이 상한 60분). 설정 주기(5분) 수집은 그대로 돌고 집중 수집은 **별도 타이머·별도 표** — 해상도가 달라 같은 표에 섞지 않는다. 수집 1회 = SSH 1회(기존 구획 전부) + Redfish 1회 + 경량 스냅샷(ps 상위 5 · /proc/pid/io 차이 · softnet · ss -s).
- **엣지 보호**: 법인당 동시 집중 상한(기본 5대) · 전역 동시성 풀(32) 공유 · 서버당 세션 예산 50초 안 · 넘치면 대기열(화면이 ‘대기 n번째’). 인증 거부(SSH/Redfish 401)는 즉시 중단(authGuard — 1분마다 재시도하면 계정이 잠긴다). 결측 분은 비우고 0 으로 채우지 않는다 · OS/iDRAC 두 경로는 따로 센다.
- **저장**: 엣지 메인 DB `focus_session(id, agent, key, trigger, by, reason, start, end, interval_s, count, status)` + `focus_sample(session_id, minute_ts, …지표 열(평균·피크)…, snapshot_json)` — 30일 보관(설정). 중앙은 요약(판정 변화 · 원인 후보 · 결측 수)만 봉투로 받고 상세는 볼 때 당긴다. 추이 탭에서 그 10분 구간을 열면 5분 점 사이에 1분 점을 겹쳐 그린다.
- **보기**(서버 상세 ‘집중 모니터링’ 탭): 진행 띠(1분 칸 10개 · 색 = 판정 · 점선 = 결측) → 요약 KPI(판정 변화 · 최고값 · 원인 후보 프로세스 · 동반 신호 · 결측) → **지표 × 분 히트 표**(1분 창 평균/피크 · 칸 클릭 = 그 분 상세) + 앞 1시간(5분 평균) 대비 추이 + 분별 프로세스 상위 3 → 같은 10분의 이벤트 띠(부품 전이 · SEL · dmesg · CVP 포트 · 이슈) → **결론 카드**(판정 변화 · 원인 후보 — 상관을 ‘후보’ 로만 · 조치 제안 · 보고서 HTML/CSV/이슈 첨부) → 세션 목록(최근 30일 · 트리거 · 결측 · 상태). 보드에는 ‘집중 n 건 진행 중’ 칩.
- **용도 프로파일 연계**: 프로파일 checks 중 ‘집중용’ 표시가 있는 것(Airflow `jobs check`·헬스 200/503, GPDB 다운 세그먼트)을 분마다 같이 본다.
- 정직 기록: 1분 간격 SSH 가 서버에 주는 부하(sshd 로그인 10회/10분)와 엣지 CPU 는 실측 전이다 — 구현 때 재서 상한 기본값(5대)을 정정한다. 수치·이름은 가상.

## 14. 추천 기능 1·7·4·2·3 (11차 · 2026-11-06 23:35~)

요청: "1, 7, 4, 2, 3 시안으로 추가해줘"(추천 목록 중). 아트보드 ⑧ 점검 소모품 · ⑨ 알림 규칙 · ⑩ 구간 비교 + 변경 이벤트 띠.
- **1 알림 규칙 연결(⑨)**: 규칙 = USE 판정 변화 · 교차 판정 성립 · 집중 모니터링 결론 · 베이스라인 이탈 · 점검 소모품 · 용도 프로파일 점검 실패. 열 = 켬 · 조건 · 지속(주기) · 재발 억제 · 채널(기존 메일·웹훅) · 이슈 자동 등록(기존 문지기 — 관리자 + 전체 범위 · 하루 상한 · 법인 예외 · 시험 실행 = 만들지 않음) · 자동 집중 모니터링 · 법인 예외. 유지보수 창 억제(Bareos·Veeam 스케줄 자동 + 수동) · 하루 상한(알림 50 · 이슈 20 · 자동 집중 10). 판정·발송은 엣지(상태 파일 `bm-perf-alert-state.json` — 재시작 뒤 재발송 없음), 중앙은 발송 기록을 봉투로. 켠 규칙만 저장.
- **2 베이스라인 이탈(⑨)**: 지난 4주(설정) 같은 요일·같은 시각의 1시간 롤업 평균 ±40%(설정) 띠를 추이에 겹쳐 그리고 띠 밖만 색. USE 매트릭스에 ‘B’ 칸(이탈 배수). 표본 4주 미만·결측 많음이면 띠 없음·규칙 안 걸림. 휴일·월말 효과는 모른다(화면이 말함). ML 없음.
- **7 점검 소모품(⑧)**: 요약 탭 카드 8칸 — chrony 오프셋(●G1) · 실패 유닛(○) · OOM(◐USE) · 커널 오류율(◐NF) · 가동 시간·재부팅 필요(●R3) · FD/conntrack(●G1) · 인증서(기존 svcmon cert 재사용) · TuneD/SELinux/firewalld(●G1). 새 구획 `##CHRONY · ##DMESG · ##CHANGES` + 기존 `##UNITS · ##VMSTAT · ##SYSCTL`. 함대 표 ‘소모품 주의 서버’(며칠째 = 전이 기록).
- **4 구간 비교(⑩)**: A/B(어제 같은 시각 · 지난주 · 집중 세션 · 직접) 같은 길이·같은 롤업만 · 결측 양쪽 제외 · 지표(평균/피크 차이 ±20% 밖 색) · 프로세스 상위 차이(스냅샷 있는 구간만) · 튜닝 값 차이(바뀐 것만) · 보고서/CSV.
- **3 변경 이벤트 띠(⑩)**: `##CHANGES`(uptime · dnf history 최근 N · needs-restarting · sysctl 전체 해시+변경 키 · /etc/sysctl.d·cron.d·crontab 해시 · tuned-adm active · systemctl --failed) + iDRAC 인벤토리 diff(펌웨어) + CVP 매핑 변화 → **이전 주기와 다를 때만** `change_event` 표에(전이만). 추이 위 점 + 목록. ‘영향 추정’ 은 시각 일치만, 설정 파일 내용은 보관하지 않는다(비밀 혼입).
- 정직 기록: `dnf history`·`needs-restarting` 출력 형식은 실장비 미확인(파서는 구획·행 수 상한으로 보호). 알림 채널은 기존 설정 재사용. 수치는 가상.

## 15. 서버 비교 — 2~5대 한 화면 (12차 · 2026-11-06 23:43~)

요청: "내가 지정한 2개, 3개, 4개, 5개의 서버를 비교하는 기능 추가해줘 · 동시에 5개의 서버를 하나의 화면에서 사용율을 볼 수 있는 기능 추가". 아트보드 ⑪.
- **선택**: 2~5대(상한 설정 · 기본 5) — 보드 행 체크 → 비교 · 상세 머리 ‘비교에 추가’ · 용도 매트릭스 ‘그룹 전부(상위 5)’ · 병목 Top 5 · 저장된 세트(사용자별 · 서버 키 목록 · 사라진 서버는 ‘없음’). **범위 기본값은 ‘같은 법인만’**(첫 서버의 법인 · 다른 법인 칩은 비활성 + 이유) · ‘법인 간 허용’ 으로 바꾸면 섞을 수 있다(머리에 ‘법인 간’ 배지 · 법인별 읽은 시각 · 서버마다 그 법인 엣지에서 따로 당겨 합침 · 한 법인이 못 오면 그 열만 오래됨/없음 · 범위 계정은 자기 법인만이고 이 토글이 보이지 않는다, 밖은 404 은닉 · 저장된 세트는 범위 설정 포함). (추가 요청 2026-11-06 23:46 "기본적으로는 같은 법인의 서버만 비교하는데, 필요하면 다른 법인의 장비끼리도 비교할 수 있는 기능 추가")
- **보기 3**: A 나란히(열 = 서버 · 행 = 지표 · 칸 = 지금 평균/피크 + 24시간 스파크 · 행마다 5열 같은 눈금 · 눈금 밖은 ‘잘림’ + 확대) · B 겹쳐서(지표 하나를 5대 선 · 서버 키에 색 고정 · 범례 클릭) · C 표(선택 구간 평균/피크 · 편차 max÷min · 최고 서버 · USE 판정 · 베이스라인 이탈 — 결측 뺀 서버만, 2대 미만 ‘—’, 같은 용도 그룹에서 한 대만 높으면 ‘스큐 후보’ → 용도 탭 gprecoverseg 안내).
- 지표 묶음: 사용률 6종(CPU · 디스크 busy · await · 메모리/스왑 · 네트워크 · 전력/흡기) / USE 전부 / 큐·버퍼 / 하드웨어. 값: 평균+피크 / 평균 / 피크. 시간축·커서·구간·장치 토글은 추이 탭 규칙 공유.
- **5대 동시 집중 모니터링**: 선택 서버 전부에 10분 × 1분 세션(법인당 동시 상한 안 · 넘치면 대기열) → 끝나면 비교 화면이 세션을 나란히.
- 400폭: 서버 블록이 아래로 쌓이고 행 머리가 블록 위에. CSV 는 보기 모드대로. 수치는 가상.

## 16. 추천 C·A·B·E·D (13차 · 2026-11-06 23:52~)

요청: "C, A, B, E, D 시안으로 추가해줘". 아트보드 ⑫ 수집 건강 · ⑬ 운영 주석 + 공유 · ⑭ 진단 플레이북 + 목표선.
- **C 수집 건강 보드(⑫)**: KPI(켠 법인·대상 · 마지막 주기 성공률 · 주기 소요/예산(최대 법인) · 엣지 DB 크기 합(실측) · 샘플러 켠 서버와 부담 · 집중 진행/대기) → 법인별 표(대상 · 주기 소요/예산 · 성공률 · 실패 사유 · 동시성 사용 n/32 · SSH 중앙값/p95 · DB·월 파일 수 · 상태) → 주기 소요 추이(동시성 4→32 전후) → 실패 사유·조치 표(상태 9종과 같은 분류) → 저장·샘플러·중앙 pull 카드. 값은 엣지가 매 주기 쓰는 상태(무음 실패 금지 · `bmUsageStatus` 확장) · ‘주기 소요 80%’ · ‘성공률 90% 미만’ · ‘DB 상한 90%’ 는 알림 규칙(⑨)에 ‘수집 건강’ 행 · 중앙은 재판정 없음.
- **A 운영 주석(⑬)**: 추이·비교·집중 화면의 이벤트 줄에 사람 주석을 ◆ 핀으로(기계 이벤트는 ●). 시각 또는 범위 · 종류(작업 · 변경 · 외부 요인 · 사고/복구 · 메모) · 내용 · 대상(이 서버 · 선택 서버 · 법인 전체) · 연결(이슈 · 위키 · 집중 세션 · 백업 작업). 저장은 **중앙** `bm-perf-annotations`(사람이 쓰는 데이터는 중앙) · 작성자·시각 자동 · 감사 · 수정 이력 · 삭제는 작성자/관리자(흔적 유지) · 유지보수 창·집중 세션은 자동 주석.
- **B 공유 링크·캡처(⑬)**: URL 에 화면 · 서버/세트 · 기간 · 커서 · 선택 구간 · 장치 토글 · 평균/피크 · 지표군을 담는다(해시 라우팅 규약) · 링크는 권한을 주지 않는다(보는 사람 권한 · 범위 밖 404) · 사라진 서버는 ‘없음’ + 보관분 안내 · 캡처 PNG(1440 · 2x)는 브라우저가 만들고 맥락 각주(서버 · 법인 · 기간 · 커서 · 출처 · 수집 방식 · 생성자)를 찍는다 · 이슈/위키 첨부 · 웹훅.
- **E 진단 플레이북(⑭)**: 판정 id(교차 ①~⑤ · 용도 점검 실패 · 메모리 포화 …) → 단계(포탈에서 먼저 확인(자동 채움) → 서버 명령(복사용 · 읽기 전용만 · Netflix 60초/USE 순서) → 설정·DB 대조(튜닝 탭 권장값) → 하드웨어 의심 → 조치 후보·기록). 파일 하나 · 근거 번호 · 카탈로그 테스트 · 현장 수정은 위키 덮어쓰기 · 포탈은 실행하지 않는다.
- **D 목표선(⑭)**: 목표 = 지표 · 비교 기준(평균/피크/p95) · 값 · 출처(개별 > 용도 > 역할 — 튜닝 권장값과 같은 우선순위). 달성률 = 목표 안 주기 비율(결측·유지보수 창은 분모 제외, 그 수를 적음) · 위반 시간 · 최장 위반 · 일 추이 · 상태. 추이 탭에 위반 띠 · 법인 월간 보고서에 포함.
- 정직 기록: 수집 건강의 ‘동시성 사용 n/32’ 와 SSH p95 는 폴러에 계측 코드를 더해야 나온다(지금 `bmUsageStatus` 에는 없음 — 구현 범위). 캡처는 브라우저 html-to-image 류 라이브러리가 필요하다(의존성 추가 — `npm audit` 규칙 확인). 수치는 가상.

## 17. 로그 분석 — 성능 · 보안 · 이슈 · 장애 (14차 · 2026-11-06 23:58~)

요청: "주요 로그 분석해서 성능, 보안, 이슈, 장애와 관련된 이슈 보는 기능 추가". 아트보드 ⑮ · 서버 상세 ‘로그’ 탭 + 보드 KPI + 함대 표.

> **(7a 구현)** 같은 SSH 세션의 별도 exec(`bmusage/logs/command.js` — 구획 `##JOURNAL · ##JSEC · ##DMESG · ##SECURE · ##AUDIT · ##APPLOG` — JSEC 는 반증 F1 의 journald 보안 읽기) · 커서는 메인 DB `log_cursor` · 심각도는 포탈 엔진 이름(warning → medium) · 규칙 전부 ○ · 공통 원인 후보는 규칙 기준 — 다르게 둔 결정과 정직 기록은 README §6-21 · §8 ‘7a단계 구현됨’.
- **출처**: journald(우선순위 warning 이상 · 커서 증분) · dmesg · `/var/log/secure`(sshd · sudo — 읽기 권한 있을 때) · auditd(있을 때) · 용도 로그(GPDB pg_log · Airflow scheduler — 프로파일이 경로를 안다) · iDRAC SEL/LC(기존). 5분 주기 SSH 1회 안의 구획 `##JOURNAL · ##DMESG · ##SECURE`(+ 프로파일 구획) · 주기당 줄 상한(기본 5,000 · 설정) · ‘잘림 n줄’ 표시 · 커서(journal cursor · 파일 offset+inode)를 엣지가 기억.
- **분류 4**: 장애(MCE · EDAC UE · PSU · 패닉) · 성능(I/O timeout · OOM · soft lockup · 링크 플랩 · 스로틀 · tcp_mem) · 보안(SSH 실패 집중(임계 설정) · root 직접 로그인 · sudo · 계정/권한 변경 · AVC · auditd) · 이슈(유닛 실패/재시작 루프 · 커널 패키지 설치 → 재부팅 필요 · 시각 점프 · 읽기 전용 재마운트 · 디스크 가득) + 용도 규칙(APP-PG/GP/AF). 규칙 = 파일 하나(정규식 · 분류 · 심각도 · 근거 번호 · 표본 1줄) — **기존 `loganalysis/`(포탈 자체 로그 규칙 엔진 · 표본 검증 · id) 재사용**, 보안 집중 판정은 **`logs/loginFailPattern.js` 재사용**. 분류 못 하는 줄은 세기만(지어내지 않는다).
- **저장(엣지)**: 서명(가변부 치환 해시)별 `log_pattern(agent,key,sig,class,severity,count,first,last,rule_id)` + 샘플 5줄(`edgelog/redact.js` + 로그용 가림 규칙) · 시간당 집계 `log_hour` · 보안 상위 N(IP·계정). **원문 전체는 저장·전송하지 않는다**(법인 밖으로 안 나감 · 중앙은 집계·샘플만 봉투로).
- **화면**: KPI 4(분류별 패턴/줄 수) + 읽은 양(상한·잘림) → 시간대별 누적 막대(추이·집중과 같은 시간축) + 보안 패널(실패 상위 IP/계정 · 성공 · sudo · 계정 변경 · AVC · auditd 상태) → 패턴 표(분류 · 심각 · 횟수 · 첫/마지막 · 출처·유닛 · 서명 · 샘플 · 규칙·근거 · 연계(교차 판정 · 장애 기록 · 집중 세션 · 변경 이벤트 · 점검 소모품 · 플레이북 — ±5분 시각 매칭, 인과 아님)) → 규칙 카탈로그 + 수집 방식. 알림 규칙(⑨)에 ‘로그 — 장애/보안 high’ 행(기본 꺼짐) · 함대 표는 같은 규칙이 여러 서버에서 동시면 ‘공통 원인 후보’.
- 정직 기록: 커널·sshd·systemd 메시지 형식은 배포판·버전마다 달라 ○ 규칙은 실장비 표본으로 좁힌다 · auditd·SELinux 는 활성일 때만 · `/var/log/secure` 권한 없으면 ‘권한 없음’ · 보안 판정은 알림까지(차단·잠금 없음) · 수치·IP·이름은 가상(문서용 예시 대역 203.0.113.0/24 · 198.51.100.0/24).

## 18. 서버 등록 · 온보딩 — CSV/Excel · 엣지/중앙 수집 경로 (15차 · 2026-11-07 00:04~)

요청: "서버 데이터 수집을 중앙에서도 하고 엣지를 통해서도 해야 하는데, csv/excel 로 등록하는 기능 추가해줘, 엣지를 통해서 데이터 수집하는 기능도 추가해줘". 아트보드 ⑯ (설정 › 베어메탈 성능 › 서버 등록).
- **새 등록부 없음**: 한 장의 CSV/Excel(.xlsx 첫 시트 — 내보내기에 쓰는 exceljs 로 읽는다)이 기존 iDRAC 등록부(`idrac/registry.js`) · OS 계정 등록부(`bmstor/registry.js` — 이름·host·port·계정·agent·mounts·enabled) · 분류 태그(fleet-tags) · 용도/역할 · CVP 매핑으로 나뉘어 들어간다. 기존 CSV 가져오기(iDRAC CSV/JSON · 베어메탈 스토리지 `parseBmServersCsv`·`analyzeBmServersImport`)의 미리보기·분석 규칙을 재사용.
- **템플릿 14열**: name* · corp* · idrac_host · idrac_cred · service_tag · os_host · os_port · os_cred · **collect_via*(edge / central / auto)** · class · purposes · role · mounts · switch/port · enabled · note. 머리글 별칭(한/영) 인식 · 인코딩 감지 · 상한 5,000행/파일 · 업로드 파일은 보관하지 않는다.
- **비밀은 파일에 넣지 않는다**(원문이 있으면 그 행 거부). `*_cred` 는 **공통 계정** 이름(법인 단위 · OS 키 인증 권장 · iDRAC 읽기 전용 역할)이고 비밀은 공통 계정 화면에서 한 번 입력해 봉인 저장(secretVault). 키 회전은 전 서버 재시험. 포탈은 서버에 계정·키를 만들어 주지 않는다(현장 구성 관리) — 필요한 권한 목록을 템플릿 설명서에 적는다.
- **검증(적용 전 전부 표시)**: 필수 열 · 중복(이름·서비스 태그·주소) · 주소 형식·SSRF 가드(링크로컬·루프백·우회 표기) · 비밀 원문 · 법인/엣지/공통 계정 존재 · 마운트 정제. 신규/갱신/경고/거부/변화 없음을 세고 결과 CSV(판정 열)를 내려준다. 갱신에서 주소가 바뀐 행은 저장 비밀을 승계하지 않는다(secretCarry).
- **수집 경로(엣지/중앙)**: 서버마다 하나 — edge(법인 엣지) / central(중앙 직접) / auto(온라인 엣지 있으면 edge, 없으면 central — 기본). 경계는 지금 코드 그대로(엣지는 자기 agent 서버만 · 중앙은 agent 없는 서버만 — `remoteAgent`, 같은 서버를 두 곳이 열지 않는다). 배정 변경은 중앙 설정의 엣지 배포 경로로 전달되어 다음 주기부터 바뀐 쪽이 읽는다. 엣지가 사라져도 자동으로 central 로 넘기지 않는다(원문이 법인 밖으로 나가는 결정은 사람이). 중앙 직접은 RTT·동시성을 수집 건강(⑫)에 따로 보이고 800ms+ 법인은 경고. 이력은 수집한 쪽 DB 에 남고 경로 변경 시각을 적는다(합치지 않는다).
- **연결 시험(표본)** → **적용**(원자적 쓰기 · 감사 로그 · 직전 등록부 스냅샷 1벌) → **엣지 배포**(법인 단위). 인증 거부 서버는 ‘인증 정지’ 후보(자동 재시도 없음).
- **누락 점검**: 둘 다 / OS 만 / iDRAC 만 / 없음 / 미귀속 — 보드 커버리지와 같은 계산 · iDRAC 스캔 결과·DNS 이름 일치에서 ‘제안’ 을 내되 사람이 적용할 때만 등록(자동 등록 없음).
- 정직 기록: Excel 읽기는 exceljs 로 가능하지만 셀 서식·수식·병합 셀 처리는 구현 때 확인 · 1,000대 전수 연결 시험은 동시성 32 로 약 3분(추정) · 수치·이름은 가상.
- **SSH 키 저장소**(추가 요청 2026-11-07 00:08 "서버 설정에 SSH key 를 많이 등록해두고, 서버 등록할때 선택해서 사용할 수 있는 기능"): 설정 › 베어메탈 성능 › SSH 키 — 키 여러 개(이름 · 종류 · 지문 · 공개키 · 봉인 개인키 · passphrase · 등록자 · 등록일 · 회전 예정 · 쓰는 서버 수 · 상태). 저장 `ssh-keys.json`(등록부 계약: 원자적 쓰기 · 손상 보존 · secretVault 봉인) · 화면·API·내보내기에는 지문·공개키만 · 삭제는 쓰는 서버 0 일 때만. OS 등록부에 `keyRef`(기존 password 항목은 그대로) · 공통 계정은 기본 키를 가리킴 · CSV `os_key` 열(키 이름 · ‘password’ · 비면 공통 계정 기본 키 · 키 내용 원문은 거부) · 서버 등록/수정 폼의 ‘인증’ 드롭다운에서 선택 · 바꾸면 저장 전 연결 시험 권고 · 주소 변경 시 키 참조 승계 없음. 회전 순서: 새 키 등록 → authorized_keys 배포(현장) → 참조 교체 + 전 서버 재시험 → 옛 키 사용 0 이면 삭제 — 포탈은 authorized_keys 를 건드리지 않는다(정직 기록).

## 19. 보안 강화 방안 (16차 · 2026-11-07 00:13~)

요청: "보안 강화를 위한 방안도 고려해줘". 아트보드 ⑰ — 설계(1~15차)가 새로 만드는 공격면 7(SSH 키 저장소 · 1,000대 SSH 세션 · 엣지 샘플러 스크립트 · 로그 샘플 · CSV/Excel 업로드 · 집중/스냅샷 실행 · CVP 매핑)마다 위협 · 대책 · 기존 규약 · 상태(설계 반영 / 기존 규약 / 구현 때 확인 / 현장 권고)를 표로.
- **자격증명**: 개인키·passphrase·공통 계정 비밀은 secretVault 봉인(S-07 fail-safe) · 0600 · 원자적 쓰기·손상 보존 · 화면/API/내보내기/백업에는 지문·공개키만 · 키 관리(등록·회전·삭제·비밀 입력)는 설정 소유자 등급 + 본인 OTP 재인증 + 감사 · 주소 변경 시 비밀·키 참조 승계 없음(secretCarry) · 연결 시험은 저장 주소로만(v2.480) · 인증 거부는 즉시 정지·자동 재시도 없음(authGuard) · ed25519 권장·약한 알고리즘 거부·회전 예정일(○ 구현 때 인용) · 서버 쪽 읽기 전용 계정·ForceCommand/`restrict,from=`·소스 제한(현장 권고 — 포탈은 authorized_keys 를 건드리지 않음) · iDRAC 읽기 전용 역할·텔레메트리 계정 분리·세션 상한·TLS 로컬 디스패처.
- **접속·명령**: 호스트키 검증(무음 TOFU 금지 · peerTrust 변경 확인) · 셸 값은 화이트리스트 정규식 뒤에만(마운트 sanitizeMounts · PID/N 숫자 · 유닛 이름 규칙 · 프로파일 로그 경로는 카탈로그 상수 · 원격 출력 재검증) · 샘플러 스크립트는 번들 고정 + sha256 대조(다르면 ‘변조/다름’ 표시 · 샘플 불사용 — 서명 검증은 두지 않음) · 집중/스냅샷은 operator+사유+감사+법인당·하루·서버당 상한+세션 예산+재발 억제 · 동시성 32 는 경로별 상한 분리·수집 건강 경고 · 출력 상한(줄·바이트)·‘잘림’·정규식 선형(ReDoS 비율 테스트).
- **전송·저장**: 봉투 정제(아는 필드·객체·상한·수치·agent·수신 시각 · 새 필드는 화이트리스트) · HTTPS 기본(평문은 승인 예외) · WAN TLS 검증 ON · 엣지 DB 0600·비밀 없음·원문 미보관·파일 삭제 보존·백업 포함 설정 · 로그 샘플 redact + 로그용 규칙(password= · Authorization: · 키 블록 · 개인정보 꼴) · 업로드 상한·미보관·비밀 원문 거부·SSRF 가드·Excel 값만·내보내기 수식 주입 차단(`= + - @` 앞 `'`).
- **접근 제어·감사**: scope 교집합 먼저 · 단건 404 · 쓰기 403 · 미귀속 미노출 · memoJson scopeKey · ‘법인 간 허용’ 범위 계정 미노출 · 권한 세분(viewer/operator/admin/설정 소유자+OTP) · 카탈로그 adminOnly 대조 · 감사 로그 전 항목 · 공유 링크는 권한을 주지 않음 · 웹훅 URL 비밀 · 의존성 추가 전 `npm audit --omit=dev` · 보안 로그 분류 → 알림(차단 없음).
- **검증 계획**: 위험한 수정이므로 전체 검증 — 반증 1인(키 저장소 · 봉투 정제 · scope · 집중 상한 · 샘플러 해시) · 변이 검증(비밀 노출 스윕 · 승계 0) · ReDoS 비율 · security-auditor 신규 라우트 전수 · Chromium 범위 계정 화면.
- 정직 기록: ‘기존 규약’ 은 설계 선언이고 따랐는지는 구현 뒤 테스트·감사로만 확인된다 · OpenSSH 옵션·키 알고리즘 권고는 일반 관행(○) · 샘플러 무결성은 해시 대조까지.

## 20. 추천 3차 — 용량 예측 · 정비 창 · 프로세스 Top-N · 저활용 · 전력/온도 (17차 · 2026-11-07 00:20~00:29)

요청: "1, 3, 2, 6, 5 시안으로 추가해줘"(추천 3차에서 고른 번호). 아트보드 ⑱~㉒. 다섯 기능 중 새 SSH 구획이 필요한 것은 ⑱ inode(`##DFI`)와 ⑳ 프로세스(`##TOP`) 둘뿐이고, 나머지는 이미 저장되는 일 집계·전력 롤업·센서 표본의 집계다.
- **⑱ 용량 소진 예측**: 입력은 장치별 표(마운트별 1시간 90일)의 일 최대 + usage_daily 메모리 + 새 `df -Pi` 구획. 14일 창 최소제곱 선형(30일 창과 비교), 기울기 차 ±30% 또는 R² < 0.5 면 ‘불안정 · 예측 안 함’, 하루 −10%p 이상 하락은 리셋(정리·재부팅)으로 보고 그 뒤부터 창을 다시 잡는다. 정비 창(⑲) 구간 제외. 출력은 90%(또는 프로파일 목표선)·100% 도달일 · 하루 증가 · 신뢰(R² 글자로) · 함대 표·요약 카드·보드 KPI·알림 규칙 ‘소진 ≤ N일’(기본 꺼짐). 정직: 선형은 계단형·주기 정리를 틀리게 본다(보호장치 = 불안정 표시) · 메모리 소진은 MemAvailable 기준 ‘참고’ 등급 · 씬 풀/LVM 여유는 범위 밖 · xfs inode 는 ‘상한 없음’.
- **⑲ 정비 창 · 알림 억제**: 11차 ⑨ ‘유지보수 창 억제’ 와 ⑭ ‘분모 제외’ 가 가리키던 설정 화면. 창 = 이름·사유 + 대상(서버/태그/법인 중 하나) + 일정(일회 또는 매주 요일·매월 n째 요일, 법인 시간대, 일회 24h·반복 12h 상한) + 억제 범위 5종 켠 것만(① 알림 발송 억제 ② 파트 장애 전이 보류 HOLD_REASON=maintenance ③ 자동 집중 억제 ④ 수집 중단(기본 꺼짐 · 기존 vCenter maintenance 플래그와 같은 뜻) ⑤ 목표선 분모·베이스라인 롤업 제외) + 승인(법인 전체·태그·12h 초과는 설정 소유자). 중앙 `maintenance-windows.json` → 엣지 배포(15차 경로). 규칙: 창 안 초과는 기록만, 창 뒤에도 초과면 그때 1회 발송(‘창 안부터 초과’) · 인증 거부는 창과 무관하게 즉시 정지(authGuard) · 창 안 수집 실패는 ‘정비 중’ 으로 성공률에서 제외하고 따로 센다 · 추이 음영 + 변경 이벤트 ‘정비 창 안’ 묶음 · ‘지금 끝내기’ · 억제가 안 풀리는 버그 대비 수집 건강 ⑫ 에서 창 끝 뒤 억제 0 확인. 정직: 기존 코드에는 vCenter 단위 플래그만 있고 서버·태그·일정·억제 종류는 새 설계(○) · RRULE 전부가 아닌 두 꼴만.
- **⑳ 프로세스 Top-N**: `##TOP` 구획 — `top -b -n 2 -d 1 -w 512 -o %CPU` 둘째 프레임(1초 구간 · 첫 프레임은 부팅 이후 평균이라 버림 ● top(8)) · 대안 `/proc/[0-9]*/stat` 2회 차이 · RSS `ps -eo pid,user:16,rss,stat,etimes,comm --sort=-rss` · I/O 는 `/proc/<pid>/io` 2회 차이(CPU 상위 후보 20개만 · 권한 없으면 ‘—’, ④ ‘권한’ 과 같은 칸) · 실행 중·D 수. 출력 상한 40줄/8KB · comm 만(인자·환경 안 읽음 — 16차) · 비용 1초 추가(세션 예산 50초 안 · 1,000대×32 주기 +0.5분 추정 ○). 화면: 추이 팝업 ‘이 시점 프로세스’ 표(프로파일 매칭 열 · PID 재사용은 starttime 으로) · 시간×프로세스 띠 · I/O 탭. 저장 `top_proc` 5분 7일(롤업 없음) + `top_proc_hourly`(comm 별 CPU초 합·최대 RSS) 90일 · 크기 1,000대 7일 ≈ 3,000만 행(2~3GB) 추정 → ‘변화 있을 때만 저장’ 으로 60~80% 감소 추정 · 실측 뒤 보존 조정. 정직: RSS 는 공유 페이지 중복(PSS 안 씀) · 컨테이너 이름 없음 · 읽기 전용(kill 없음).
- **㉑ 저활용 서버 찾기**: usage_daily 30일 평균·일 최대 + power_hourly + 용도 태그. 점수 0~100(CPU 30 · 메모리 15 · 디스크 15 · 네트 15 · 전력 15 · 활동 흔적 10) — 지표가 없으면 분모에서 빼고 환산 · ≥70 후보 · 40~69 관찰 · 주 1회만 높은 서버는 ‘주기 사용’ 으로 별도 · ‘대기·DR’ 태그·데이터 부족(<21일)·정비 창 중은 제외하고 수를 적는다. 검토 상태(검토 중/반납 예정/유지+사유)는 주석 ⑬ 저장·감사 · 비교 ⑪ 로 보내기 · 후보 진입/이탈은 변경 이벤트 전이. 정직: 저활용 ≠ 불필요 · 전력 ‘유휴’ 는 서버별 30일 최소 기준 상대값(○) · ‘회수 가능 전력’ 은 측정 합이지 절감 추정 아님 · 기준값은 관행(설정).
- **㉒ 전력 · 온도 집계**: 기존 iDRAC 폴러 `power_samples`/`power_hourly` 와 `fetchSensors`(inletCelsius·maxCelsius·fans) 를 랙·법인 단위로 합산 — kW 지금/24h 평균/피크 · kWh(시간 평균 W×1h) · 월 누적 · 랙 상한(설정 kW) 여유 · 서버 PowerCap(fetchInventory powerCap) ‘걸림’(≥98%) · 흡기 ≥ 설정값(기본 27 °C) 상위 · 팬 경고는 ⑦ 에서 가져옴. 랙·U 는 15차 CSV ‘랙/위치’ 열(또는 iDRAC 위치 ○) · 없으면 ‘미매핑’ 묶음. 미측정(iDRAC 없음·읽기 실패·0 보고)은 합계에서 빼고 수를 적는다 · 기존 전력 대시보드(/power-breakdown 법인·리전)와 한 소스 → 교차 검증 테스트. 정직: 온도 시계열 저장·롤업 범위는 구현 때 코드 재확인(○) · 모델별 Dell 권장 흡기 범위 미인용(설정값이라고만 적음) · PDU 범위 밖.
- 캔버스 노트 s11(17차) 추가. 아트보드 ⑱~㉒ 사본은 docs/design/linux-bm-perf/ 에 둔다.
