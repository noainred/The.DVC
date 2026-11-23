# 설계: Unity SAN · NAS 인터페이스 — 속도 · 사용량 모니터링 / 트래킹

작성 2026-11-23 (main **v3.34.2** 기준 — ⚠ 정정: 처음 조사는 main 보다 1,500 커밋 뒤인 체크아웃(v2.914.0)에서 했다. `git merge --ff-only origin/main` 뒤 다시 확인해 §2 를 고쳤다 ·
브랜치 `claude/trusting-sagan-p6hh1x`) · 상태 **시안 — 컨펌 대기**(구현 전) ·
시안 캔버스: https://claude.ai/artifact/MX28kKbrDuJHQpeXV3oTij (아트보드 4장 — ① 전 장비 · ② 장비 한 대 · ③ 400px · ④ 상태 6종).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **장비 · 포트 이름 · IP · WWN · 수치는 전부 가상**이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰과 SAN 포트 사용량의 칸 색(`sanPortUsageText.js LEVELS`) 그대로(예외: SP 균형 막대의 `#a5b4fc` 한 곳 — 구현 때 토큰으로 바꿀 것).
계정의 ‘Design System’ 아티팩트는 타입 파일뿐이라(`project/README.md` · `tokens.json` 없음 — 파일 목록으로 확인) 쓰지 않았다.
⚠ 캔버스는 **렌더링해 직접 보지 않았다**(캔버스 도구 규칙 — 요청 없이 렌더 검증하지 않음). 깨진 아트보드가 있으면 알려 주면 고친다. ‘지금’ 보드(목 서버 캡처)도 만들지 않았다.

## 1. 요구(사용자 2026-11-23 14:39 KST)

> "유니티 스토리지의 SAN/NAS 인터페이스의 속도 사용량 모니터링/트래킹 하는 기능 추가해줘" → 이어서 "시안 만들어서 보여줘"

해석(추정 — 컨펌 때 바로잡을 것): **속도** = 포트의 링크 속도(연결 · 요청 · 최대)와 그 변화, **사용량** = 포트 처리량(읽기 · 쓰기)과 링크 속도 대비 사용률,
**트래킹** = 처리량 추이(24시간 · 7일 · 30일, 피크 · 평균 · 직전 기간 대비) + 속도 · 링크 변화 이력. SAN = FC · iSCSI 프런트엔드 포트, NAS = NAS 서버 파일 인터페이스(이더넷 포트 위).

## 2. 지금 코드에서 확인한 것(v3.34.2 · 2026-11-23 14:50~14:55 KST)

| 사실 | 위치 |
|---|---|
| **이미 있는 것 ①**: Unity(REST 수집)의 **SP CPU · FC 포트 처리량**을 5분 표본으로 읽는다(v2.952~). `metricValue` 로 `sp.*.cpu.summary.utilization` · `sp.*.fibreChannel.target.*.{readBytes,writeBytes,reads,writes}`(누적 카운터 → 최근 두 항목 델타/초). **읽기+쓰기를 합친 `hbps`** 와 IOPS 만 남긴다 | `server/src/storage/collectors/arrayPerf.js:44~47·329~430` |
| **이미 있는 것 ②**: 5분 표본 경로 — 폴러(`intervals.nodeLoadMs` 기본 5분 · 하한 1분 · 상한 60분 · 장비당 시한 60초 · 수집 주기와 장비 점유를 나눔 · 인증 정지 공유) · DB(`saveNodeLoadSample`) · 엣지 push(`nodeLoadSamples`) · 중앙 정제(`sanitizeNodeLoadSample`) · 단위 64 상한(부모 먼저, 포트는 남는 자리) | `storage/nodeLoadPoller.js` · `nodeLoad.js` · `db.js` |
| **이미 있는 것 ③**: 화면 — 독립 도구 **‘SAN 스토리지 성능’**(`san-storage`)이 스위치 `portperfshow` 표본을 어레이 → 컨트롤러(Unity SP) → 포트로 묶고, 어레이 측 표본(위 ①)을 대조한다. 스토리지 모니터링 장비 상세의 노드 부하 패널은 **아이실론만** 그린다 | `web/src/views/tools/SanStorageTool.jsx` · `StorageMonTool.jsx:1194` · 설계 `docs/design/san-storage-perf/` |
| **없는 것 ①**: 포트 구성 — **링크 속도(연결 · 요청 · 최대) · 링크 상태 · SFP · 묶음**을 읽는 코드가 없다(`fcPort` · `ethernetPort` · `/net/port` grep 0건. `fcPort` 는 캡처 가이드에만 있다) | `docs/design/san-storage-perf/CAPTURE-GUIDE.md:116` |
| **없는 것 ②**: **이더넷 포트 처리량**(iSCSI · NAS — `net.device`) · **iSCSI/NAS 인터페이스 목록**(IP · VLAN · NAS 서버) — grep 0건 |  |
| **없는 것 ③**: **SSH(uemcli) 수집 Unity 는 성능 표본이 아예 없다** — 표본 대상은 `collectMethod === 'api'` 뿐이다. 현장 Unity 18대가 대부분 SSH 라는 기록이 있다(지금도 그런지는 미확인) | `storage/registry.js:169` · `arrayPerf.js:28` · `docs/rules/storage.md`(v2.545 항목) |
| **없는 것 ④**: 읽기 · 쓰기 분리 저장 · 속도/링크 **변화 이력** · 어레이 포트 자신의 링크 속도 대비 사용률(SAN 스토리지 성능의 회선 사용률은 **스위치 포트 속도** 기준) |  |
| SSH 수집 명령은 `SPECS` 표 하나 — 세션 예산 150초 · 맨 뒤 `lowPriority`(전원 · LUN · 파일시스템). 명령 수 × 시한 산수는 테스트가 고정. v2.526 이 명령을 늘려 수집이 통째로 죽은 전례(v2.528) | `unitySsh.js SPECS` · `cliSsh.js:43` · `test/unitySshBudget2528.test.js` |
| 스토리지 모니터링 상단 보기 5개(`devices` · `dc` · `type` · `faults` · `trend`)는 해시 탭 — 새 보기를 같은 방식으로 붙일 수 있다(도구 키 `storage-mon` 그대로 → 권한 · 카탈로그 변경 없음) | `StorageMonTool.jsx:585` |
| 목 데이터: Unity 3대 + 어레이 측 표본 합성(`FE_DEMO_UNITS` SPA · SPB) — 포트 구성 · 이더넷 합성을 여기에 더한다 | `server/src/mock/demo/storage.js:45~47·556` |

요약: **FC 처리량의 뼈대(REST · 5분 표본 · 저장 · 엣지 · 화면 하나)는 이미 있다.** 이번 요구에서 새로 필요한 것은 ⓐ 포트 구성(속도 · 상태)과 변화 이력 ⓑ 이더넷(iSCSI · NAS) 처리량과 인터페이스 목록
ⓒ 읽기/쓰기 분리와 ‘포트 자신의 링크 속도 대비’ 사용률 ⓓ SSH 수집 Unity 를 어떻게 할지 ⓔ 이것을 한곳에 모은 화면이다.

## 3. 정직하게 밝혀야 하는 것

1. **Unity 의 필드 · 메트릭 경로 · uemcli 명령은 문서 지식이 근거이고, 이 저장소에서 실장비로 확인된 적이 없다** — 이미 구현된 `arrayPerf.js` Unity 부분도 머리말이 ‘실장비 미확인’ 이라고 적고 있다.
   이 저장소의 Unity uemcli 파서는 실장비 출력을 받은 뒤에야 맞았다(v2.525 → v2.542 전면 재작성). **구현 전에 §7 의 출력을 받는 것이 가장 큰 위험 감소**다.
2. **NAS · iSCSI 인터페이스별 사용량은 없다**(추정 — 문서 지식): Unity 메트릭은 물리 이더넷 포트(`net.device`) 단위다. 한 포트에 NAS 서버 인터페이스가 여럿이면 나눌 수 없어 화면이 ‘포트 값’ 이라고 말한다.
3. 사용률 = **읽기 · 쓰기 중 큰 쪽 ÷ 그 포트의 링크 속도**(FC 16 Gb = 1,600 MB/s · 이더넷 10 Gb = 1,250 MB/s 환산). ‘SAN 스토리지 성능’ 의 회선 사용률은 스위치가 본 **송수신 합 ÷ 스위치 포트 속도**라 정의가 다르다 — 두 화면의 %가 다를 수 있고 화면 주석에 적는다.
   ⚠ 기존 문서는 Unity 포트 상한을 16 Gb FC **1,500 MB/s**(Best Practices 인용 — 원문 미대조)로 적고 있다. 분모를 1,600(선로 환산)으로 할지 1,500(벤더 상한)으로 할지는 구현 때 `capBpsOf` 와 한 벌로 맞춘다.
4. 피크는 **5분 표본들 중 최댓값** — 표본 사이의 순간 최대는 보이지 않는다. 누적 카운터 델타라 첫 표본은 값이 없다.
5. 속도 · 링크 변화의 시각은 **처음 본 수집 시각**이다(구성은 수집 주기 1시간마다 읽으면 최대 1시간 늦다). 두 수집 사이에 내려갔다 올라온 변화는 남지 않는다.
6. 장비가 그 경로의 성능 이력을 보관하지 않으면 사용량은 못 읽는다 — 속도 · 상태만 보인다(상태 ④-1). `fibreChannel.target.*` · `net.device.*` 의 이력 수집이 켜져 있는지는 장비에서 확인해야 한다(기존 문서도 같은 한계를 적고 있다).
7. 시안의 ‘Unity 18대 · SSH 15 · API 3’ · 포트 288 · KPI 수치는 가상이다(18대는 `docs/rules/storage.md` 의 옛 기록에서 가져온 숫자).
8. 시안 ② 의 ‘수집 출처’ 에 적은 `uemcli /metrics/value/hist` 는 §6 질문 3 에서 ‘SSH 에도 성능 경로를 만든다’ 를 고른 경우의 모습이다 — 그 명령이 실제로 그렇게 도는지는 미확인.

## 4. 화면(아트보드)

- **① 전 장비**(`Main.dc.html`) — 스토리지 모니터링 상단에 새 탭 ‘인터페이스’(`#/tools/storage-mon/ifaces`). KPI 6(포트 · 속도 저하 · 포화 근접 · 유휴 · SP 편중 · 사용량 못 읽음) ·
  기간(24시간 · 7일 · 30일) · 종류(FC · iSCSI · NAS) · 단위 · 법인 · 검색 · 문제만 보기 · 포트 표(STable — 링크 속도 · 상태 · 읽기 · 쓰기 · 최근 5분 사용률 · 기간 피크 · 평균 · 24칸 띠 · 올라간 인터페이스/WWN) · 속도 · 링크 변화 이력 · 읽는 법.
- **② 장비 한 대**(`Device.dc.html`) — 포트 배치(SPA · SPB × 온보드 · I/O 모듈, 칸 띠 = 피크) · SP 균형 막대 · 고른 포트의 통계 5 + 읽기 · 쓰기 추이(링크 100% 선 · 포화 기준선 · 피크 표시) + 이전 · 다음 · 최신 ·
  이 장비의 포트 표 · 이더넷 포트에 올라간 인터페이스(iSCSI · NAS 서버 · IP · VLAN · 역할) · 이 장비의 변화 이력 · 수집 출처(명령별 읽음 · 건너뜀 사유).
- **③ 400px**(`Narrow.dc.html`) — 탭 줄바꿈 · KPI 2열 · 포트는 카드 목록 · 장비 화면은 세로 한 줄.
- **④ 상태 6종**(`States.dc.html`) — 이력 보관 꺼짐 · 이번 수집 건너뜀(지난 값 + 언제 값) · 엣지가 아직 올리지 않음 · 링크 다운/미연결/못 읽음 구분 · 속도 저하/고정 구분 · 인증 정지.

무거운 조회라 **폴링하지 않는다**(탭 열 때 1회 + 새로 고침 버튼 · 조건을 바꾸면 이전 요청 취소). FC 포트 행에서 ‘SAN 스토리지 성능’ 의 같은 어레이로 가는 링크를 둔다(스위치 쪽 값 대조).

## 5. 데이터 · 서버(안) — 새 폴러 · 새 DB 를 만들지 않고 기존 5분 표본 경로를 넓힌다

| 무엇 | REST(Unisphere) | SSH(uemcli) | 어디에 싣나 |
|---|---|---|---|
| FC 포트 구성(속도 · 요청 · 최대 · 상태 · WWN · SP) | `fcPort` | `/net/port/fc show -detail` | 수집 주기(1시간) 스냅샷 `extra.ifaces` |
| 이더넷 포트 구성(속도 · MTU · 상태 · 묶음) | `ethernetPort` · `linkAggregation` | `/net/port/eth show -detail` · `/net/la show -detail` | 〃 |
| iSCSI 인터페이스(포트 · IP · VLAN) | `iscsiPortal` | `/net/if show -detail` | 〃 |
| NAS 인터페이스(NAS 서버 · 포트 · IP · VLAN · 역할) | `fileInterface` | `/net/nas/if show -detail` | 〃 |
| FC 처리량 | **이미 있음**(`fibreChannel.target.*` — 읽기 · 쓰기를 따로 남기게 고침) | 없음 → §6 질문 3 | 5분 표본(`nodeLoad`) |
| 이더넷 처리량(iSCSI · NAS 공통) | `metricValue` `sp.*.net.device.*.{bytesIn,bytesOut}`(추정 경로) | 없음 → §6 질문 3 | 5분 표본 — 기존 `in` · `out` 열 |

- **구성(속도)은 수집 주기 스냅샷에, 처리량은 5분 표본에** 싣는다. 표본 단위 종류에 이더넷 포트를 더하고, FC 읽기 · 쓰기 분리는 표본 열 2개 추가(또는 기존 열 재사용 — 구현 때 `nodeLoad.js` 계약을 읽고 정한다).
  단위 64 상한: SP 2 + FC · 이더넷 포트 최대 수십 개라 Unity 480 한 대는 들어갈 것으로 본다(추정 — 넘으면 뺀 수를 probe 가 밝히는 기존 규칙).
- **SSH 구성 수집**은 `SPECS` 맨 뒤 `lowPriority` 로 4~5개 명령(용량 · 상태 · 버전을 밀어내지 않음 · 예산 산수 테스트 갱신). 건너뛰면 사유를 남기고 화면은 지난 값을 ‘언제 값’ 과 함께 보인다.
- **변화 이력**: 스냅샷을 저장할 때 직전 구성과 비교해 (장비, 포트, 이전 → 새 값, 처음 본 시각) 한 줄을 남긴다(새 표 하나 — `storage/db.js` · 상한 · prune 스로틀).
- **실행 위치**: 법인 엣지가 로컬에서 수집 → 기존 storage push 에 실림 → 중앙이 정제(아는 필드만 · 포트 수 상한 · 수치화) 후 저장. **새 필드는 중앙 정제 화이트리스트에도** 넣는다. 중앙이 법인 Unity 에 직접 붙지 않는다(엣지 없는 법인만 예외 — 기존과 같다).
- **API**: `GET /tools/storage/ifaces`(전 장비 요약 — `memoJson` + `scopeKey`) · `GET /tools/storage/devices/:id/ifaces?period&port&end`(추이 — 조회 밖 404) · CSV. 권한 · 범위는 `storage-mon` 과 같은 게이트.
- **판정은 서버 순수 모듈 하나**(속도 저하 · 포화 근접 · 유휴 · 편중 · 못 읽음) + 웹 문구 모듈 하나. 기준값은 API 가 내려 준다(화면에 박지 않는다). 못 읽은 값은 `numOrNull` — 0 으로 세지 않는다. 새 헬퍼는 `docs/COMMON.md` 에서 먼저 찾는다.
- **목**: `mock/demo/storage.js` 에 Unity 포트 구성 · 이더넷 표본 합성(Chromium 검증이 비지 않게).

## 6. 결정이 필요한 것(기본값은 괄호)

1. 위치 — **스토리지 모니터링의 새 탭 ‘인터페이스’**(기본 · NAS 포함이라 ‘SAN 스토리지 성능’ 밖 · 권한 변경 없음) / ‘SAN 스토리지 성능’ 의 Unity 상세에 넣음(FC 는 자연스럽지만 NAS 가 어색) / 별도 도구.
2. 범위 — **Unity 만**(기본) / PowerStore 도 같은 틀로.
3. **SSH 수집 Unity 의 사용량** — ⓐ **구성(속도 · 상태 · 인터페이스)은 SSH 로, 사용량은 REST 로 등록된 장비만**(기본 · 위험 작음 · SSH 장비는 ‘사용량 못 읽음’ 으로 따로 셈 → 장비 등록을 API 로 바꾸면 채워짐) /
   ⓑ uemcli `/metrics/value` 로 SSH 성능 경로를 새로 만든다(실장비 출력 필수 · SSH 세션이 5분마다 열림) / ⓒ SSH 장비도 성능 표본만 REST 로(같은 계정이 Unisphere REST 에 로그인되는지 확인 필요).
4. 읽기 · 쓰기 분리 — **분리해 보여 줌**(기본 · 표본 열 추가) / 합계만(지금 저장 그대로).
5. 기준 — **포화 근접 80% · 유휴 1%**(기본 · 설정에서 변경).
6. 알림(메일 · 포탈 알람) — **1차 제외**(기본) / 속도 저하 · 링크 다운 · 포화 근접을 알림으로.
7. FC 포트별 로그인 호스트 수 — **1차 제외**(기본 · 명령 1개 추가 필요) / 포함.

## 7. 구현 전에 받고 싶은 실장비 출력(Unity 한 대 · 민감 값은 가려도 됨 · 공개 저장소에 커밋하지 않는다)

SSH(uemcli):
```
uemcli /net/port/fc show -detail
uemcli /net/port/eth show -detail
uemcli /net/la show -detail
uemcli /net/if show -detail
uemcli /net/nas/if show -detail
uemcli /metrics/metric show
```
REST(`docs/design/san-storage-perf/CAPTURE-GUIDE.md` §4 의 `$Y` · `$A` 그대로 — 그 가이드의 `unity-metric-paths.json` · `unity-fc-bytes.json` · `unity-fc-ports.json` 을 이미 받았다면 아래 둘만):
```
eval curl $A "'$Y/types/ethernetPort/instances?fields=id,name,speed,requestedSpeed,supportedSpeeds,mtu,isLinkUp,health,storageProcessor&compact=true'" > unity-eth-ports.json
eval curl $A "'$Y/types/metricValue/instances?filter=path%20EQ%20%22sp.*.net.device.*.bytesIn%22&per_page=10'" > unity-net-bytes.json
```
필드 이름 · 경로는 문서 지식이라 틀릴 수 있다 — 오류가 나면 그 오류 문구가 곧 답이다. 출력 없이 구현하면 파서는 문서 예시 기준이 되고 ‘실장비 미확인’ 으로 남긴다(LUN · 파일시스템 v2.789 · 어레이 성능 v2.952 와 같은 방식).

## 8. 구현 범위 · 검증(컨펌 뒤)

서버(REST · SSH 구성 수집 + 파서 · 이더넷 표본 · 읽기/쓰기 분리 · 변화 이력 · 엣지 정제 · API · 판정 모듈 · 목) + 웹(탭 · 장비 화면 · 문구 모듈 · STable) + 테스트(파서 픽스처 · SSH 예산 산수 · 정제 · scope · 판정 대조) + 문서(`docs/rules/storage.md`) + 릴리스.
위험 등급: 엣지 수신 계약 · 표본 계약(`nodeLoad`) 변경 · SSH 예산이 걸려 **변이 검증 대상**이다. 예상 소요는 30분을 넘는다(추정 3~4시간 — 질문 3 에서 ⓑ 를 고르면 더) — 착수 전에 검증 수준을 다시 묻는다.
