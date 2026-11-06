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
