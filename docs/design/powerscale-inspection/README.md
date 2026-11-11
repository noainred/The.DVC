# PowerScale 법인별 장비 점검 · 주간 보고 — 설계 (2026-11-10)

> 상태: **시안 단계(컨펌 전)**. 구현하지 않았다. 사용자가 컨펌한 범위만 다음 단계에서 구현한다.
> Claude Design 캔버스: https://claude.ai/artifact/42G2ykLPiZmKucWdF9z5e5 (아트보드 5장 + 메모 2장 · 비공개).

## 1. 요구

사용자 원문(2026-11-10 14:27 KST): "법인별로 전체 power scale 장비의 장비 점검을 하는 기능을 만들어줘, 인터넷/레딧/dell/emc 홈페이지에서
정기 점검, 세부점검에 대한 메뉴얼, 보고 양식, 명령어를 찾아서 주간/보고 양식을 만들고 거기에 따른 점검도 진행해줘, 노드별 IO 상태를 기록하고 있다가,
보고할 때 전체 노드의 10 top 사용 노드의 편중된 장비 사용율도 보고해서, 클로드 디자인으로 시안 만들어서 보여주고, 어떤 자료를 참고했는지도 같이 적어서
신뢰도를 높여줘". 시안 범위 선택: '표준 5장'.

## 2. 조사에서 확인한 것과 못 한 것 (★ 먼저 읽을 것)

- **원문 전체를 직접 연 자료는 0건이다.** 이 세션에서 `www.dell.com` 은 프록시 허용 뒤에도 사이트가 자동 클라이언트를 거부(Akamai 'Access Denied')했고,
  `infohub.delltechnologies.com` 은 환경 허용 목록에 없어 프록시가 막았으며, 조회 도구(WebFetch)는 컨테이너 DNS 규칙이 갱신되지 않아 실패했다. 우회(브라우저 위장 등)는 하지 않았다.
- 그래서 아래 참고 자료는 전부 **검색 도구가 그 페이지에서 인용한 구절 · 요약** 수준이다(§7 표의 '확인 수준' 열). 인용 구절은 검색 결과에 원문 그대로 실린 문장이다.
- **Reddit 은 검색 도구가 접근을 거부해(도메인 차단) 한 건도 참고하지 못했다.**
- **Dell 이 내놓은 '주간 보고 양식' 은 찾지 못했다.** 주기는 Dell 'PowerScale Healthy Habits Checklist'(일 · 월 · 분기)와 Dell 지원 동영상(주간 검토 설명)을,
  보고서 구분 5가지는 CloudIQ 건강 점수 분류를 따라 **포탈이 구성**했다.
- **실장비 출력 표본은 한 건도 보지 못했다.** 명령 문법은 OneFS 판마다 다르다 — 구현 전에 실장비 `--help` 와 실제 출력으로 확인해야 한다(v2.937 설계 §8 과 같은 상태).
- '문법 미확인' 2건(`isi_for_array -s 'gmirror status'` · `isi storagepool settings view`)은 문서 인용을 찾지 못해 기억으로 적은 명령이다.

## 3. 무엇을 만드나

스토리지 도구 아래 **'PowerScale 장비 점검'**(보기 5개 — 시안 ①~⑤). 등록된 아이실론(PowerScale) 장비 전부가 대상이고 **법인(= vCenter = 엣지) 단위**로 묶는다.

| 보기 | 내용 |
|---|---|
| ① 법인별 현황 | 법인 · 클러스터마다 주간 20항목 결과(칸 20개 띠) · 용량(80% · 90% 눈금) · 지난주 대비 · 편중(최대 ÷ 평균) · 이상/주의 목록 · 확인 불가 사유 |
| ② 점검 결과 | 장비 하나의 20항목 — 결과 · 본 값 · 기준 · 읽는 방법(명령/API) · 출처 번호 · 조치 안내 · 최근 10회 비교 |
| ③ 주간 보고서 | A4 2쪽(1쪽 결재용 요약 · 2쪽 근거 수치) + 부록(장비별 20항목 · 참고 자료) · 메일 본문 + PDF · CSV 첨부 · 법인 담당자는 자기 법인판만 |
| ④ Top 10 노드 편중 | 전 법인 노드를 주간 평균으로 줄 세운 상위 10개 + 각 노드의 '자기 클러스터 평균 대비' · '클러스터 안 비중' · CPU · busy · 클러스터별 노드 분포 |
| ⑤ 점검 주기 · 근거 | 일 · 주 · 월 · 분기 표 · 참고 자료와 확인 수준 |

### 3.1 상태 5가지 (SAN 월간 점검 `sanswitch/healthCheck.js` 와 같은 규칙)

`정상` · `주의` · `이상` · **`확인 불가`**(명령 없음 · 권한 없음 · 출력 미인식 — 사유를 함께) · `해당 없음`(기능 미사용 — 예: SyncIQ 정책 없음).
**확인 불가를 정상으로 세지 않는다.** 종합은 다섯 개수를 나란히 적는다.

### 3.2 주간 점검 20항목 (구분은 CloudIQ 건강 점수 5분류 [20])

| # | 구분 | 항목 | 기준(출처가 준 것만) | 읽는 방법(읽기 전용) | 출처 |
|---|---|---|---|---|---|
| 1 | 구성 요소 | 클러스터 건강 | Cluster Health = OK | `isi status` | [3] |
| 2 | | 그룹(쿼럼) | 전 노드가 그룹에 있음 | `sysctl efs.gmp.group` | [4] |
| 3 | | 미해결 이벤트 | critical 이상 0건 | `isi event groups list --resolved=false` | [3] |
| 4 | | 노드 상태 | ATTENTION · SMARTFAIL · DOWN 없음 | `isi status -v` | [5] |
| 5 | | 드라이브 | HEALTHY 아닌 드라이브 0 | `isi devices drive list --node-lnn all`(HEALTHY 제외) | [6][7] |
| 6 | | 부트 드라이브 미러 | 전 노드 미러 정상 | `isi_for_array -s 'gmirror status'` ⚠ 문법 미확인 | [5] |
| 7 | | 전원 공급 장치 | 전부 good | `isi_hw_status \| grep -i -A2 "Power Supplies"` | [8] |
| 8 | | NVRAM 배터리 | 전부 Good | `isi batterystatus list` | [9] |
| 9 | | 네트워크 인터페이스 | 구성된 포트 전부 up | `isi network interfaces list` | [9] |
| 10 | 구성 | HealthCheck 평가 | 최근 평가에 FAIL 없음(포탈은 평가를 **돌리지 않고** 결과만 읽는다) | `isi healthcheck evaluations list` · 권한 ISI_PRIV_SYS_SUPPORT | [15][16] |
| 11 | | 시간 동기 | NTP 서버 1개 이상 구성 | `isi ntp servers list` | [9] |
| 12 | 용량 | 클러스터 사용률 | 90% 미만 유지 · 80% 부터 증설 발주(주의) | 포탈 기존 수집(`isi status` · REST) | [1][10] |
| 13 | | 노드 풀 사용률 | 풀마다 90% 미만(장비 기본 이벤트 70 · 80 · 90 · 97%) | REST `storagepool/nodepools`(기존 수집) | [10][11] |
| 14 | | 가상 핫 스페어 | 켜짐 · 10% 이상 | `isi storagepool settings view` ⚠ 문법 미확인 | [10] |
| 15 | | 스냅샷 사용 | 10% 이하 · 과대한 단일 스냅샷 없음 | `isi snapshot snapshots list` | [1][9] |
| 16 | 성능 | 디스크 busy(주간) | 90% 를 계속 넘지 않음 | 포탈 5분 표본(`isi statistics drive` — 기존 `node_load_*` 표) | [4][12] |
| 17 | | 노드 편중(주간) | 가장 바쁜 노드 < 노드 평균 × 1.5 — **포탈 기준(v2.937 `SKEW_FACTOR_DEF`) · Dell 수치 아님** | 포탈 5분 표본 | [14] |
| 18 | 데이터 보호 | 잡 엔진 | 실패 · 멈춘 잡 0 | `isi job jobs list` | [4][17] |
| 19 | | FlexProtect · SmartFail | 진행 중인 재보호 없음(있으면 주의 — 그동안 업데이트 금지) | `isi job jobs list` · `isi status -v` | [6][17] |
| 20 | | SyncIQ | 지난 7일 보고서 실패 0(정책 없으면 해당 없음) | `isi sync reports list` | [1][9] |

- **노드 CPU 는 판정하지 않는다** — Dell 이 기준 숫자를 주지 않는다([4] 는 `isi statistics system --nodes --top` 로 보라고만 한다). Top 10 표에 평균 · 피크 값만 싣는다
  (SAN 월간 점검 제2 규칙 '임계값을 지어내지 않는다').
- 제3자 자료 [22] 의 '용량 85% 경고' 는 채택하지 않았다(Dell 수치는 80% 발주 · 90% 상한).
- [12] 의 디스크 busy 90% 는 오래된 KB 다 — 구현 때 설정으로 바꿀 수 있게 하고 화면이 출처를 말한다.

### 3.3 월간 · 분기 세부 점검 (사람이 검토 — 보고서에 확인란)

| 주기 | 내용 | 출처 |
|---|---|---|
| 월 | 고장 드라이브 교체 완료 · 알림 경로 동작(메일 · 원격 지원) · SyncIQ 가 복제 목표 시간(RPO · RTO)을 지키는가 · SmartPools 계층 이동 검토 · 스냅샷 10% 초과/과대 단일 스냅샷 · 중복 제거 잡이 매주 도는가 · SmartConnect 분산 정책(포탈 추가) | [1][2][14] |
| 분기 | OneFS 판 · 롤업 패치 · 펌웨어 검토(`isi upgrade cluster view` · `isi upgrade cluster nodes firmware devices`) · 용량 추세(6개월 안에 증설 필요한가) | [1][9][18][19] |

### 3.4 Top 10 노드 편중

- 원천: 이미 쌓고 있는 노드 부하 기록(`storage-history.db` `node_load_hourly` · `node_proto_hourly` · `node_client_hourly` — v2.926 ~ v2.937). **새 장비 호출 없음.**
- 전 법인 노드를 주간 평균(기본 프로토콜 ops/s · 전환: 처리량 In+Out · 디스크 busy · CPU)으로 정렬해 상위 10개. 각 줄에 **자기 클러스터 평균 대비 배수** · **클러스터 안 비중** ·
  CPU 평균/피크 · 디스크 busy 평균/피크 · 주 프로토콜 · 고정 클라이언트 수 · 7일 추이.
- 순위에 올랐다고 편중은 아니다 — 프랑크푸르트처럼 노드 여럿이 0.9 ~ 1.3배면 '고르게 바쁜 것'. 편중은 평균 × 1.5 이상(포탈 기준)일 때만 표시한다.
- 읽지 못한 표본은 0 으로 넣지 않고 평균에서 뺀다(표본 수를 함께 싣는다). 표본 수집이 꺼진 장비 · 표본이 없는 주는 '기록 없음' 으로(0 아님).
- 편중의 배경 설명: SmartConnect 기본 정책(라운드 로빈)은 연결 수만 나눠 노드 사이 부하가 고르지 않을 수 있다 [14].

## 4. 구현 설계 초안 (컨펌 뒤 확정)

- **수집**: `server/src/storage/inspect/`(가칭) — 점검 명령 묶음을 **법인 엣지가 로컬에서** 한 세션으로 실행하고 판정 요약만 중앙으로(운영 환경 규칙 — 명령 수만큼 WAN 왕복 금지).
  읽기 전용 명령 화이트리스트(인자 고정 · 사용자 입력을 명령에 넣지 않는다) · 장비당 시한(`withDeadline`) · SSH 세션 예산 < 장비 시한 · 인증 실패는 `storage/authGuard` 와 같은 정지 레코드(자동 재시도 없음) ·
  표본 폴러와 장비 점유 공유(`runSampleExclusive`). REST 만 등록된 장비는 SSH 항목을 **확인 불가**로(사유와 함께).
- **판정**: 순수 모듈 하나(`inspectJudge.js` 가칭 — 서버 · 엣지 · 화면이 같은 결과를 쓴다 · 화면은 다시 판정하지 않는다). 못 읽은 값은 null(`numOrNull`) → 확인 불가.
- **저장**: 점검 실행 이력(장비 × 실행 — 최근 N회 · 항목별 결과와 관측값) · 원본 출력은 엣지에 단기 보관(중앙에는 싣지 않는다 — 크기 · 민감 정보). 엣지 → 중앙 필드는 중앙 정제 화이트리스트에 등록.
- **API**(조회는 `toolsPerm + fullScopeOnly` 또는 법인 범위 — 컨펌 때 결정 · '지금 점검' 은 operator 이상 + 쓰기 범위): 현황 · 장비 결과 · 이력 · Top 10 · 보고서 모델 · 메일 설정.
- **보고서 · 메일**: 기존 `storage/usageMail.js` · `sanswitch/storagePerfReport*.js` 의 일정(`planMonthlyTick` 류) · 첨부 · 수신자 구조를 재사용. 법인판은 그 법인 수신자에게만.
- **화면**: `web/src/views/tools/PowerScaleInspect*.jsx`(가칭) · 문구 · 좌표는 순수 모듈 + vitest · 표는 `STable` · 폴링 없음(마운트 1회 + 버튼) · 도구 카탈로그 등재(상태를 바꾸지 않으므로 '스토리지' 소속).
- **데모**: 목 모드에 6개 장비의 점검 결과 합성(이상 1 · 주의 · 확인 불가 포함).

## 5. 컨펌이 필요한 것

1. 주간 20항목 구성(§3.2)과 판정하지 않는 것(CPU)에 동의하는가 · 빼거나 더할 항목.
2. SSH 로만 읽는 항목(2 · 6 · 7 · 8 · 10 등)을 위해 **읽기 전용 SSH 수집 계정**을 쓰는가(지금도 `isi status` 는 SSH 로 읽는 장비가 있다). `isi_for_array` · `sysctl` 은 root 가 필요할 수 있다 — 미확인.
3. 조회 범위 — 전체 범위 계정만(기존 스토리지 도구와 같음) / 법인 범위 계정도 자기 법인 것은 보게.
4. 보고서 — 결재란 · 문서 번호 유무 · 발송 요일 · 시각 · 수신자.
5. 구현 단계 나누기 — 1차(점검 수집 · 판정 · 현황 · 결과 · Top 10) → 2차(주간 보고서 · 메일 · PDF) → 3차(월간 · 분기 확인란 · 이력 비교).

## 6. 시안에서 쓴 가상 데이터

법인 6 · 클러스터 6 · 노드 33 · 항목 120(정상 101 · 주의 10 · 이상 1 · 확인 불가 6 · 해당 없음 2). 이름 · 수치는 전부 지어낸 예시다.
시안 5장은 로컬 Chromium 1440×900 으로 렌더해 넘침 · 잘림이 없는 것을 확인했다(첫 렌더에서 보고서 2쪽 · 참고 자료 표가 넘쳐 고친 뒤 게시).

## 7. 참고 자료 (22건 — 전부 검색 인용 수준 · 원문 전체 열람 0건)

| # | 자료 | 발행 · 종류 | 이 설계에서 쓴 곳 | 확인 수준 | 주소 |
|---|---|---|---|---|---|
| 1 | PowerScale Healthy Habits Checklist (H18769) | Dell · 공식 점검표 | 일 · 월 · 분기 주기 · 용량 90% · 스냅샷 10% · 6개월 용량 추세 | 인용 구절(일부 — 추출 텍스트가 깨져 월 · 분기 목록은 검색 요약) | https://www.delltechnologies.com/resources/en-us/asset/tech-notes/products/storage/h18769-tn-powerscale-healthy-habits-checklist.pdf |
| 2 | Tutorial on Dell PowerScale | Dell 지원 동영상 | 주간 검토 항목(알림 · 스냅샷 · SyncIQ · SmartPools) · 주기는 조정 가능 | 인용 구절 | https://www.dell.com/support/contents/en-us/videos/videoplayer/tutorial-on-dell-powerscale/6297632052001 |
| 3 | How to check the cluster health and unresolved events (KB 000223412) | Dell · 공식 KB | `isi status` · `isi event groups list --resolved=false` | 인용 구절 | https://www.dell.com/support/kbdoc/en-us/000223412/powerscale-how-to-check-the-cluster-health-and-unresolved-events |
| 4 | Considerations and Best Practices for Large Clusters (H17300) | Dell · 공식 백서 | `sysctl efs.gmp.group` · `isi job jobs list` · `isi statistics drive` 열(Busy% · Queued · TimeInAQ · TimeAvg) · `isi statistics system --nodes --top` | 인용 구절 | https://www.delltechnologies.com/asset/en-us/products/storage/industry-market/h17300-wp-powerscale-onefs-large-cluster.pdf |
| 5 | OneFS Upgrade Planning and Process Guide — Check hardware health (CLI) | Dell · 공식 매뉴얼 | `isi status -v`(ATTENTION · SMARTFAIL · DOWN) · 비정상 드라이브 · 부트 드라이브 미러 | 인용 구절 | https://www.dell.com/support/manuals/en-us/isilon-onefs/ifs_pub_upgrade_planning_and_process_guide/check-hardware-health-cli |
| 6 | On-Cluster Analysis — Drives Health (KB 000035312) | Dell · 공식 KB | `isi devices drive list --node-lnn all \| grep -v HEALTHY` · SMARTFAIL/FlexProtect 중 업데이트 금지 | 인용 구절 | https://www.dell.com/support/kbdoc/en-vc/000035312/isilon-on-cluster-analysis-drives-health |
| 7 | One or more drives are ready to be replaced (KB 000047373) | Dell · 공식 KB | 교체 준비 이벤트 · 빨리 교체 | 인용 구절 | https://www.dell.com/support/kbdoc/en-us/000047373/isilon-onefs-event-notification-one-or-more-drives-are-ready-to-be-replaced-event-id-100010010-100010011 |
| 8 | How to check if a Power Supply has failed (KB 000020717) | Dell · 공식 KB | `isi_hw_status \| grep -i -A2 "Power Supplies"` | 인용 구절 | https://www.dell.com/support/kbdoc/en-in/000020717/isilon-how-to-check-if-a-power-supply-is-genuinely-failed-and-to-confirm-its-firmware-version-using-cli |
| 9 | OneFS CLI Command Reference (9.3 ~ 9.15) | Dell · 공식 매뉴얼 | `isi batterystatus list` · `isi network interfaces list` · `isi ntp servers list` · `isi sync reports list` · `isi snapshot snapshots list` · `isi upgrade cluster nodes firmware` | 명령 이름만(옵션 미확인) | https://www.dell.com/support/manuals/en-us/isilon-onefs/ila/isi-batterystatus-list |
| 10 | PowerScale OneFS Best Practices | Dell Info Hub · 공식 백서 | 80% 에서 증설 발주 · 90% 미만 유지(풀마다) · 가상 핫 스페어 10% 이상 · 잡은 한가한 시간에 | 인용 구절 | https://infohub.delltechnologies.com/l/powerscale-onefs-best-practices/cluster-capacity-management/ |
| 11 | Node pool is at or over capacity (KB 000082018) | Dell · 공식 KB | 풀 용량 이벤트 기본 단계 70 · 80 · 90 · 97% | 요약만 | https://www.dell.com/support/kbdoc/en-us/000082018/isilon-onefs-8-2-2-onefs-generates-event-every-hour-node-pool-pool-name-node-pool-id-id-is-at-or-over-capacity |
| 12 | Check your cluster for bottlenecks (KB 000008978) | Dell · 공식 KB(오래된 글) | 디스크 busy 가 90% 를 계속 넘지 않게 | 요약만 | https://www.dell.com/support/kbdoc/en-us/000008978/check-your-cluster-for-bottlenecks |
| 13 | Troubleshooting Performance Issues (KB 000015384) | Dell · 공식 KB | 성능 점검 명령(참고 — 내용 미확인) | 제목만 | https://www.dell.com/support/kbdoc/en-us/000015384/emc14001790-troubleshooting-performance-issues |
| 14 | How SmartConnect Connection Policies Distribute Client Connections (KB 000008416) | Dell · 공식 KB | 라운드 로빈이 기본 · 노드 사이 연결 불균형 가능 | 인용 구절 | https://www.dell.com/support/kbdoc/en-us/000008416/onefs-how-smartconnect-connection-policies-distribute-client-connections |
| 15 | How to run the online Health Check Framework (KB 000009330) | Dell · 공식 KB | `isi healthcheck evaluations run/list/view` · 권한 ISI_PRIV_SYS_SUPPORT · 결과 위치 | 인용 구절 | https://www.dell.com/support/kbdoc/en-us/000009330/onefs-how-to-online-run-health-check-framework-hcf-on-cluster |
| 16 | PowerScale OneFS isi healthcheck | Dell · 공식 매뉴얼 | `isi healthcheck checklists list` · 평가 결과 보기 | 인용 구절 | https://www.dell.com/support/manuals/en-us/isilon-onefs/ifs_onefs_isi_healthcheck/list-all-checklists |
| 17 | PowerScale OneFS Job Engine | Dell Info Hub · 공식 백서 | 잡 최대 3개 동시 · FlexProtect 동작 · IntegrityScan | 인용 구절 | https://www.dell.com/en-us/infohub/articles/powerscale-onefs-job-engine-1 |
| 18 | PowerScale OneFS Current Patches (KB 000184794) | Dell · 공식 KB | 분기 패치 검토 | 요약만 | https://www.dell.com/support/kbdoc/en-us/000184794/powerscale-onefs-current-patches |
| 19 | On-Cluster Analysis — Upgrade Status (KB 000033892) | Dell · 공식 KB | `isi upgrade cluster view` | 요약만 | https://www.dell.com/support/kbdoc/en-us/000033892/isilon-on-cluster-analysis-upgrade-status |
| 20 | CloudIQ: A Detailed Review · Talking CloudIQ: Proactive Health Scores | Dell Info Hub · 공식 백서 | 보고서 구분 5가지(Components · Configuration · Capacity · Performance · Data Protection) | 인용 구절 | https://infohub.delltechnologies.com/p/talking-cloudiq-proactive-health-scores/ |
| 21 | Unstructured Data Quick Tips — OneFS Healthcheck Enhancements · Pre-upgrade Healthchecks | 개인 블로그 · 비공식 | HealthCheck 항목 예(참고만) | 요약만 | http://www.unstructureddatatips.com/onefs-healthcheck-enhancements/ |
| 22 | PowerScale (Isilon) OneFS Command Reference: 90+ Safety-Rated Commands | WUC Technologies · 비공식 | 명령 주기 예(참고만 · 용량 85% 기준은 채택하지 않음) | 인용 구절 | https://www.wuctechnologies.com/resources/field-guides/powerscale-isilon-command-reference/ |
| — | Reddit | — | 미참고 | 검색 도구 접근 거부 | — |

주소는 검색 결과에 나온 것을 그대로 적었다(지역 · 언어 경로는 여러 판이 있다). 구현 전에 운영 담당자가 [1] · [3] · [5] · [6] · [10] · [15] 여섯 건은 원문을 직접 열어 대조해 주는 것을 전제로 한다.

## 8. 구현 결과 (v2.963 — 사용자 선택 '1차 + 2차' · SSH '기존 계정으로 읽기' · 조회 '전체 범위 계정만' · 검증 '표준 + 반증 1인')

규칙 요약은 `docs/rules/storage.md` 38항. 시안과 달라진 것 · 못 한 것을 먼저 적는다.

- **정정 — PDF 첨부 → 자급형 HTML 첨부 + 브라우저 인쇄**: 시안 ③ 과 §3 표는 '메일 본문 + PDF' 라고 적었지만 이 저장소에는 PDF 라이브러리가 없다.
  서버 PDF 대신 ① 화면의 흰 종이를 브라우저 인쇄로 PDF 저장(`@media print` 가 종이만 찍는다) ② 메일에는 같은 내용의 **HTML 파일**을 첨부(열어서 인쇄 › PDF)한다.
  A4 2쪽 · 부록 구성 대신 보고서는 8절 한 문서(요약 · 법인별 결과 · 이상/주의와 조치 · 확인 불가 · Top 10 · 데이터 보호 · 다음 주 확인할 것 · 근거 자료)다.
- **만든 것(1차 + 2차)**: 점검 실행(SSH 12명령 · REST 13경로 — 전부 조회) · 판정 20항목 · 이력(장비당 12회) · 엣지 위임 장비는 엣지 로컬 실행(요청 큐 → 결과 push) ·
  보기 5개(법인별 현황 · 점검 결과 · 주간 보고서 · Top 10 노드 편중 · 점검 주기와 근거) · 주간 일정(요일 · 시각) · 보고서 메일(전체판 + 법인판) · HTML · CSV 받기 · 기준값 조정.
- **안 만든 것(3차 — 사용자 선택에서 제외)**: 월간 · 분기 확인란(사람이 체크) · 회차 간 이력 비교 화면. 월간 · 분기 8항목은 '점검 주기 · 근거' 보기에 목록으로만 있다.
- **화면에서 시안과 다른 점**: 1440px 에서 본문 표와 옆 칸을 나란히 두면 표 오른쪽 열이 표 안 스크롤로 숨어(Chromium 실측) 옆 칸을 아래 격자로 내렸다(넓은 화면에서는 시안처럼 옆).
- **실장비 미확인(그대로 남는다)**: 명령 문법 · REST 경로 · JSON 모양은 §7 의 검색 인용과 기존 수집기 코드에 맞췄을 뿐 실장비 출력으로 확인하지 않았다.
  특히 `isi_for_array -s 'gmirror status'`(부트 미러)는 문서 인용을 못 찾아 화면에 '문법 미확인' 을 단다. 첫 실점검의 '확인 불가 사유' 를 보고 파서를 고친다.
- 검증: 서버 단위 테스트 12건(`psInspect2963`) + 반증 반영 회귀 10건(`psInspectReview2963`) · 웹 vitest 14건 · Chromium 1440/400(목 서버 데모 장비 4대 — 오류 0 · 가로 넘침 0 · 표 안 스크롤 0) ·
  반증 검토 1인 — 재현 결함 15건(중간 7 · 낮음 8)은 전부, 추정 4건 중 2건(E1 · E2)을 고쳤다(상세 `docs/rules/storage.md` 38항 끝). 고치지 않은 것: 추정 E3(SSH 출력 4MB) · E4(폴러 대기).
