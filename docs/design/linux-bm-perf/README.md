# 설계: 리눅스 베어메탈 성능 모니터링 · 병목 진단 · 튜닝 포인트 — 방식 검토와 화면 시안

작성 2026-11-06 (main v2.915.0 기준 · 브랜치 `claude/sleepy-pasteur-v6ap1x`) · 상태 **시안 — 컨펌 대기**(구현은 컨펌 뒤 Opus) ·
시안 캔버스: https://claude.ai/artifact/QcfijJnPxj8Tp6q4vLQNoE (아트보드 5장 — ⓪ 방식 검토 · ① 함대 보드 1440 · ② 서버 상세 1440 · ③ 서버 상세 400 · ④ 상태 6종).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **서버 이름(bm-kr1-db01 …) · 법인 코드(KR-SEL · PL-WAW · US-EAST) · 수치는 전부 가상**이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로(새 hex 없음 — 강조색은 `#4ade80 #fbbf24 #f87171 #67e8f9` 와 rgba 오버레이뿐).
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이다.

## 1. 요구(사용자 2026-11-06 19:31 KST)

> "리눅스 베어메탈 서버의 모니터링을 위한 방법 찾아줘, 유명한 솔루션 참고해서 효율적이고 직관적이고 성능 모니터링, 튜닝 포인트, 병목을 진단하는 기능이 필요하고,
> 어떤 방식으로 모니터링을 진행할것인가에 대한 검토도 필요해, 클로드 디자인으로 시안 만들어서 보여줘"

요구를 넷으로 읽었다: ① 성능 모니터링 ② 병목 진단 ③ 튜닝 포인트 ④ 수집 방식 검토(어떻게 모을 것인가).

## 2. 지금 코드에서 확인한 것(설계의 근거 — 2026-11-06 19:31~19:34 KST)

| 사실 | 위치 |
|---|---|
| 베어메탈 사용률 모듈이 이미 있다(v2.550~). 대상은 `classifyFleet().bareMetal`, 법인 단위 opt-in(기본 꺼짐), 주기 5분(하한 60초), 원시 90일 + 일 롤업 5년 | `server/src/bmusage/` · `settings.js:56·102` |
| Linux 는 **SSH 명령 1회**로 `/proc/stat`·`/proc/meminfo`·`/proc/diskstats`·`/proc/net/dev`·`/sys/class/net`·`/sys/class/fc_host`·`df`·`uname` 을 구획 표지(`##STAT` …)로 받아 파서가 쪼갠다. 왕복을 늘리지 않는 것이 설계 | `bmusage/collectors/osSsh.js linuxCommand()` · `parse/linuxProc.js` |
| 지금 읽는 것: CPU 합계(idle+iowait 를 idle 로) · MemAvailable · 디스크 섹터·io_ticks(**14열 중 6·10·13 만**) · NIC 바이트·속도·물리 여부 · FC tx/rx words · df. **읽지 않는 것**: loadavg · `/proc/stat` 분해(user/system/iowait/steal) · `/proc/pressure/*` · `/proc/vmstat`(스왑·폴트·OOM) · diskstats 의 IOPS·read/write ticks·in_flight(await·대기열) · NIC errors/drops · `/proc/net/snmp`(재전송) · sysctl·`/sys` 튜닝 항목 · 프로세스 | `parse/linuxProc.js parseProcStat·parseDiskstats` · `osSsh.js:52~70` |
| DB 는 ‘지표를 열로’(`usage_history` cpu_pct·mem_pct·disk_busy_pct·disk_used_pct·net_pct·net_bps·hba_pct·hba_bps·io_pct) · 최신 전용 표 `usage_latest` · 일 롤업은 평균+최대 | `bmusage/db.js:84~123` |
| 누적 카운터 환산은 `rates.js` 하나 — 첫 표본·리셋·간격 비정상은 `null`. 대표값은 장치·회선 중 **최대**(`maxOrNull`) | `bmusage/rates.js` · `usage.js` |
| 엣지가 종합하고 **중앙은 볼 때만 pull**(`GET /api/collector/bm-usage`, 수집기와 같은 토큰 — 새 포트·새 인증 없음). 꺼져 있어도 응답(`enabled:false`) · 상한 `truncated` 명시 | `bmusage/edgePull.js` |
| iDRAC 텔레메트리 경로(`SystemUsage`·`NICStatistics`·`FCPortStatistics` 리포트 열거)가 OS 계정 없는 서버의 대체. **OS 안(런큐·PSI·프로세스·sysctl)은 구조적으로 없다** | `parse/idracTelemetry.js` · `idrac/redfish.js fetchUsage` · `docs/rules/idrac-server.md:246~` |
| 인증 실패(401/403·SSH 거부)는 주기 수집을 멈추고 자동 재시도하지 않는다(계정 잠금) · 수동 실행은 막지 않는다 · 세션 예산 50초 < 장비 시한 60초 | `util/authGuard.js` · `osSsh.js SESSION_BUDGET_MS` |
| OS 계정 저장소는 `bmstor/registry.js` 재사용(두 벌 금지) · 마운트는 `sanitizeMounts` 통과분만 명령에 | `docs/rules/idrac-server.md:172~` |
| 화면 `BmUsage.jsx`(855줄) — 신뢰 띠 → 표(5지표 · `—`) → 행 클릭 상세 → 추이 `BmUsageChart`. 폴링하지 않는다(마운트 1회 + 버튼) | `web/src/views/tools/BmUsage.jsx` |
| 엣지 Linux 에 도는 원격 명령 에이전트(RMA)는 **엣지 포탈 서버용**이고 베어메탈 대상 서버에는 없다 — 베어메탈로 가는 통로는 SSH(bmstor 계정)와 Redfish 둘뿐 | `server/src/rma/CLAUDE.md` |

규모(설계 제약): 법인 28곳 · 등록 서버 1,135대(bmusage 문서) · 법인 단위 opt-in · 사용자는 한국(RTT 800ms+ 법인 있음) · 백업·수집은 법인 로컬, 중앙은 통합 현황(루트 CLAUDE.md 2026-11-01).

## 3. 방식 검토 — 네 가지 중 D 를 권장(아트보드 ⓪)

| 방식 | 얻는 것 | 부담 | 판정 |
|---|---|---|---|
| A 지금 그대로(bmusage 5지표) | 사용률만 — ‘높다’ 는 보여도 ‘병목인지’ 못 말한다. 튜닝 항목 없음 | 없음 | 부족 |
| B 서버마다 에이전트(node_exporter/Netdata + Prometheus/Grafana) | 가장 풍부(수백 지표 · 초 단위 · Netdata 는 지표별 ML 이상 탐지) | 1,135대 설치·버전·포트(9100) · TSDB 운영 · 화면 이원화 · 법인마다 Prometheus 가 없으면 중앙이 WAN 너머를 직접 스크레이프 | 보류(이미 쓰는 법인이 있으면 그 값을 읽는 연동은 다음 단계) |
| C iDRAC 텔레메트리만 | CPU·메모리·전력·온도·NIC/FC 통계 | 없음 | 보조(OS 안을 못 본다) |
| **D A 를 넓힌다 — 같은 SSH 1회에 구획 추가 + 온디맨드 진단 스냅샷** | USE 세 칸 전부 + 튜닝 항목 + 프로세스·소켓·커널 로그(스냅샷) | 설치 없음 · 등록부 재사용 · 왕복 불변 · 엣지 DB 열 추가 · 읽기 전용 | **채택** |

채택 근거(코드): 통로(SSH 1회·구획 표지·`rates.js`·엣지 pull·authGuard)가 전부 있고, 부족한 것은 **읽는 구획과 열**이다. 5분 주기는 유지한다(초 단위 스파이크는 놓친다 — 화면이 말한다).

### 3.1 참고한 솔루션에서 가져오는 것(검색으로 확인한 것 — 출처는 §9)
- **USE 방법(Brendan Gregg)**: 자원마다 사용률(Utilization)·포화(Saturation)·오류(Errors)를 따로 묻는다. 보드의 매트릭스와 상세의 자원 4면이 이 틀.
- **node_exporter 기본 수집기**: cpu · meminfo · diskstats · netdev · loadavg · pressure(커널 4.20+ 또는 CONFIG_PSI) · vmstat · filesystem — 어느 `/proc` 을 읽을지는 이 목록을 따른다(지표 이름도 가능하면 같게 → 나중에 B 연동이 쉽다).
- **Grafana ‘Node Exporter Full’ 식 묶음**: CPU 분해 · 메모리 구성 · 디스크 await/IOPS · 네트워크 오류를 자원별로 묶는 구성(커뮤니티 대시보드의 일반적 구성 — 특정 판본을 복제하지 않는다).
- **Netdata**: 초 단위 수집 + 지표별 ML 이상 탐지 — **이번에 채택하지 않는다**(5분 주기 · 에이전트 없음). 이상 탐지는 앞으로의 후보로만 적어 둔다.

## 4. 데이터 — 무엇을 더 읽는가(Linux 명령 1회에 구획 추가)

| 구획 | 파일 | 얻는 것(USE 칸) | 비고 |
|---|---|---|---|
| `##STAT`(확장) | `/proc/stat` 전체 | user/system/iowait/irq/softirq/steal 분해(U) · `ctxt`·`intr`·`procs_running`·`procs_blocked`(S) · 코어별 최고 사용률 | 지금은 `cpu` 집계 줄만 |
| `##LOAD` | `/proc/loadavg` | 1·5·15분 · 런큐 ÷ 코어(S) | 코어 수는 `/proc/stat` cpuN 줄 수 |
| `##PSI` | `/proc/pressure/cpu·memory·io` | some/full avg10·avg60·avg300(S) | **없으면 absent**(커널 4.20 미만 · RHEL 8 계열은 `psi=1` 부팅 옵션 필요) — 못 읽음과 구분 |
| `##VMSTAT` | `/proc/vmstat` | `pswpin/pswpout`·`pgmajfault`(S) · `oom_kill`(E) | 누적 → `rates.js` |
| `##DISK`(확장) | `/proc/diskstats` 14열 전부 | reads/writes(IOPS) · read/write ticks(**await**) · in_flight·weighted ticks(**대기열**) | 지금은 6·10·13 열만 |
| `##BLKQ` | `/sys/block/*/queue/{scheduler,nr_requests,rotational}` | 튜닝 항목 | 장치별 1줄 |
| `##NET`(확장) | `/proc/net/dev` 16열 전부 | rx/tx errors·drops(E·S) | 지금은 bytes 만 |
| `##SNMP` | `/proc/net/snmp` Tcp 줄 | RetransSegs/OutSegs 재전송률(S) | 누적 |
| `##SYSCTL` | `sysctl -n` 묶음 · `/sys/kernel/mm/transparent_hugepage/enabled` · `/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor` · `/proc/sys/kernel/numa_balancing` · `/proc/meminfo HugePages_*` | 튜닝 포인트 현재값 | 읽기 전용 · 값이 없으면 ‘확인 불가’ |
| `##IRQ` | `/proc/interrupts` 요약(NIC 큐 irq 가 몇 코어에 퍼졌나) · `systemctl is-active irqbalance` | 튜닝 항목 | 출력 상한을 둔다(줄 수) |

- 모든 구획은 **지금처럼 항상 표지를 출력**한다('구획은 왔는데 0줄' = absent 의 양성 증거).
- 오류 칸(E)은 **5분 증가분**이다(누적값 그대로가 아니라) — 0 이 아니면 먼저 본다.
- 정규식: 장비 출력에 앵커 없는 무제한 반복 금지 — 줄 길이를 먼저 자르고 선형으로(루트 CLAUDE.md).

### 4.1 진단 스냅샷(온디맨드 — 사람이 누를 때만 · 엣지가 SSH 1회 · 읽기 전용)
`ps`(CPU·RSS 상위 N) · `/proc/<pid>/io` 2회 차(I/O 상위 — root 또는 CAP_SYS_PTRACE 가 필요할 수 있다 → 못 읽으면 ‘확인 불가’, **sudo 자동 시도 금지**) · `ss -s` · `dmesg --level=err,warn` 최근 N줄(`-T`) · `cat /proc/<pid>/status` 는 넣지 않는다(상한). 결과는 법인 엣지에 7일 보관, 중앙은 그 결과만 받는다. 명령은 전부 argv 화이트리스트(PID·N 은 숫자 정규식).

### 4.2 판정(USE) — 코어는 하나(순수 모듈, 웹·서버 복제 금지)
- 자원마다 U·S·E 세 값 → 각각 `ok | warn | bad | none(absent) | missing`. 기준값(사용률 90 · 런큐/코어 1.0 · 대기열 2 · PSI full 5% · 스왑아웃/s 등)은 **설정값이고 API 가 내려준다** — 화면에 박지 않는다.
- ‘병목’ = 세 칸 중 둘 이상 `bad`, ‘포화’ = S 가 `bad`, ‘오류’ = E 가 `bad`. 못 읽은 칸은 판정에 넣지 않고 따로 센다(`numOrNull` 규약).
- 판정 한 줄(“디스크 포화 — nvme1n1 await 18ms · PSI io full 12%”)은 엣지가 만들고 중앙은 그대로 전한다(v2.548 ‘중앙이 다시 판정하지 않는다’).

### 4.3 튜닝 포인트
역할(DB·웹·캐시·파일·일반)별 **권장 프로파일을 관리자가 설정에서** 정한다(기본 프로파일은 문서화된 일반값에서 시작 — 자동 적용은 없다, 읽기 전용). 항목마다 `현재 · 권장 · 근거(이 서버에서 읽은 것) · 상태(권고/적합/참고/확인 불가)`. ‘확인 불가’ 는 ‘적합’ 과 다른 칸이다.

### 4.4 DB · API(개요 — 구현 때 확정)
- `usage_history`/`usage_latest` 에 열 추가(지표를 열로 — 기존 판단 유지): `load1 · runq_ratio · cpu_user/sys/iowait/steal · psi_cpu_some · psi_mem_full · psi_io_full · swap_out_ps · majfault_ps · oom_kills · disk_await_ms · disk_iops · disk_qdepth · net_drops · net_errs · tcp_retrans_pct` 등. 튜닝 항목은 **별도 표**(`tuning_latest(agent,key,item,value,read_at)` — 항목이 동적이라 행).
- 엣지 봉투 `GET /api/collector/bm-usage` 에 필드 추가(중앙 정제 화이트리스트에도 추가 — 루트 CLAUDE.md ‘엣지가 보낸 것은 정제한다’).
- 스냅샷: `POST /tools/bm-perf/:key/snapshot`(엣지 대행 — 작업 하나를 법인에 보내 로컬에서 돌리고 결과만 올린다 · 동시 1건/서버 · 진행 중 잠금은 그 서버만) · `GET …/snapshot`(최근 1건).
- 권한은 기존 bmusage 와 같다(`tools` + vCenter scope · 법인 귀속 없는 서버는 범위 계정에 미노출 · 스냅샷 실행은 operator 이상).

## 5. 화면(IA) — 아트보드 5장

- ⓪ **방식 검토** — 법인 안(서버 ←SSH 1회/5분— 엣지 ←Redfish— iDRAC) · 중앙(볼 때만 pull) · 점선 = 온디맨드(진단 스냅샷) · 4안 비교표 · 참고 솔루션 · 한계.
- ① **함대 보드 1440** — 머리(범위 · 보기 세그먼트 보드/USE 매트릭스/튜닝 점검/표 · 기간 · 지금 수집 · CSV) → 신뢰 띠(켠 법인 · 대상 · 읽음 · 첫 주기 · 못 읽음 · PSI 없음) → KPI 5(병목 의심 · 포화 · 오류 · 튜닝 권고 · 정상) → **USE 매트릭스**(서버 × 자원 4 × U/S/E, 심각도 순 상위 10, 행 끝 ‘판정 한 줄’) + **병목 Top**(판정·근거·스냅샷 링크) + 24시간 포화 서버 수(자원별 선 4) → 튜닝 포인트 항목별 서버 수.
- ② **서버 상세 1440** — 머리(판정 배지 · 출처·신선도 · 기간 · 스냅샷 실행 · 지금 수집) → 판정 띠 → **자원 4면**(CPU 분해 띠 + U/S/E 3칸 + 보조 KV · 메모리 · 디스크 장치표(busy·await·IOPS·대기열·스케줄러·오류) · 네트워크 인터페이스표) → 24시간 추이(같은 % 축만 겹친다 — 단위 다른 await·IOPS 는 소형 차트 따로) + **튜닝 포인트 표**(현재·권장·근거·상태) → **진단 스냅샷**(I/O 상위 · CPU·메모리 상위 · dmesg·ss).
- ③ **서버 상세 400** — 같은 내용을 세로로. 세그먼트 전폭 · 버튼 44px · 표는 가로 스크롤 박스 · 긴 문구 `overflow-wrap:anywhere`.
- ④ **상태 6종** — 꺼짐(법인 미선택) · 첫 주기 · PSI 없음(absent) · 권한 부족(일부만 읽음) · 오래됨(엣지 무응답 → 보관분 흐리게) · 인증 정지(자동 재시도 없음). 칸 표기 규약(값/경계/초과/‘—’).

표는 전부 `STable`(머리글 클릭 정렬 · `—` 는 항상 뒤) · 문구에 백틱 없음 · 주기·상한·기준 숫자는 API 값.

## 6. 정직하게 밝혀야 하는 것
1. **실장비 출력을 본 적이 없다** — `/proc/pressure` 유무(커널·배포판·부팅 옵션), `/proc/<pid>/io` 권한, `/proc/interrupts` 표기는 첫 실수집에서 확인한다(v2.550 과 같은 정직 기록). 시안의 모든 수치는 가상이다.
2. 5분 주기라 **초 단위 스파이크는 못 본다**. PSI avg10/avg60 가 그 사이를 일부 메우지만 전부는 아니다 — 화면이 말한다.
3. 튜닝 ‘권장값’ 은 역할별 일반값이지 이 현장의 정답이 아니다 — 설정에서 관리자가 정하고, 자동 적용은 없다.
4. 진단 스냅샷의 프로세스별 I/O 는 권한이 없으면 비고, ‘확인 불가’ 로 둔다. sudo 를 자동으로 시도하지 않는다.
5. B(에이전트) 를 보류한 것은 운영 부담 판단이지 기능 우열이 아니다 — 이미 node_exporter 를 쓰는 법인이 있으면 그 값을 읽는 연동이 더 싸다(다음 단계 후보).
6. 참고 솔루션 서술 중 Grafana ‘Node Exporter Full’ 의 패널 구성은 검색으로 재확인하지 않았다(훈련 지식 — 일반적 구성이라는 수준으로만 썼다).

## 7. 컨펌 때 정할 것(기본값을 적어 둔다)
1. 방식 — **D(권장)** / B 연동 병행 / 다른 것.
2. 진단 스냅샷의 프로세스별 I/O — **권한 있으면 읽고 없으면 ‘확인 불가’(기본)** / 넣지 않음.
3. 튜닝 프로파일 — **역할 5종(DB·웹·캐시·파일·일반) 기본 프로파일 동봉, 설정에서 수정(기본)** / 항목만 보여 주고 권장값 없음.
4. 보드의 기본 보기 — **USE 매트릭스 포함 보드(기본)** / 기존 표 유지 + 상세만 확장.
5. 검증 수준 — 표준(관련 테스트 + Chromium 1440/400) / 전체 검증(엣지 수신 계약·권한이 바뀌므로 반증 1인 권장).

## 8. 구현 범위(컨펌 뒤 — Opus)
`bmusage/collectors/osSsh.js linuxCommand` 구획 추가 → `parse/linuxProc.js` 파서(순수 · 테스트) → `rates.js`·`usage.js` 열 추가 → `db.js` 열·튜닝 표 → USE 판정 순수 모듈(테스트가 웹·서버 같은 입력으로 대조) → `edgePull.js` 봉투 + 중앙 정제 화이트리스트 → 스냅샷 엣지 대행 라우트 → 웹(보드 · 상세 · 400 · 상태) → 목 데이터 → Chromium 1440/400 → 릴리스.

## 9. 출처(검색 2026-11-06)
- USE Method: Linux Performance Checklist — https://brendangregg.com/USEmethod/use-linux.html
- node_exporter 수집기 목록(loadavg · pressure 등) — https://github.com/prometheus/node_exporter · https://pkg.go.dev/github.com/prometheus/node_exporter
- Netdata 제품 설명(초 단위 · 지표별 ML 이상 탐지) — https://learn.netdata.cloud/docs/welcome-to-netdata/complete-product-description · https://github.com/netdata/netdata
