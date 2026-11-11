# 설계: ESXi 호스트 정보 — 가운데 모달을 VM 과 같은 오른쪽 드로어로

- 상태: **구현됨(v2.975.0 · 2026-11-11)** — 사용자 컨펌 ‘기본값대로 진행해줘’(§6 의 기본값 6개). 구현 기록은 §8.
- 캔버스(Claude Design): https://claude.ai/artifact/SAg5udiVmBZxN5airB7t5S (비공개 — 소유자만 열 수 있다)
- 아트보드 원본: 이 폴더의 `*.dc.html` 6개(캔버스에 올린 것과 같은 파일). 캔버스 렌더는 직접 열어 확인하지 않았다(Design 유형 규칙 — 요청 없이는 검증하지 않는다).
- 앞선 설계: `docs/design/vm-screen/`(VM 드로어 v2.909) · `docs/design/vm-perf/`(vCenter 트리 VM 클릭 → 드로어 v2.913 · 성능 화면).

## 1. 요구(사용자 2026-11-11 18:02 KST)

> "가상화 호스트 정보도 vm 처럼 깔끔하게 보여줘 시안 보여줘"

해석(내 판단): ‘vm 처럼’ = VM 을 누르면 열리는 **오른쪽 드로어**(`views/vms/VmDrawer.jsx`). 호스트는 같은 트리에서 아직 가운데 모달이 열린다.
개체 보기(탭 9개) · 전체 페이지 상세(`#/hosts/<id>`)는 이미 따로 있고 이번 요청의 대상이 아니라고 봤다 — 다르면 §6 ① 에서 바로잡는다.

## 2. 지금 코드에서 확인한 것(main v2.973.0 · 2026-11-11 18:02~18:17 KST)

| 무엇 | 어디 | 사실 |
|---|---|---|
| 호스트 모달 | `components/EntityDetail.jsx` `EntityDetail` (type='host') | 640px `Modal`. `HostBasicRows`(값 16개 · iDRAC 실측이 있으면 17개) → `HostCfgSection`(확인 항목 + 읽은 값 25개) → `PerfcSection` → `ClusterCfgSection` → `HostHbaTable` → GPU 배지 + `HostGpuPanel` → `HostPowerPanel` → 단추 3개(`HostMetricButton` · `IdracTrendLinkButton` · `ObjectViewButton`). ‘VM N대 보기’(`HostVmsModal`)는 이름 줄에. |
| 모달을 여는 곳 | `VCenterDetail.jsx`(트리 호스트 이름 · 검색 결과) · `Alarms.jsx` · `Explore.jsx`(Top-N 4개) · `tools/IpamCore.jsx`(소유 호스트) · `tools/IdracTrendTool.jsx` | 모두 `<EntityDetail type="host">` 한 컴포넌트. |
| VM 은 | `EntityDetail` 의 VM 가지 | v2.926 부터 `VmDrawer` 로 위임(`rows=[]` — ‹ › 잠김). vCenter 트리는 v2.913 부터 `rows=treeVmRows(...)`. |
| 호스트 표 | `views/Hosts.jsx` | 이름 = 개체 보기 링크(v2.915 ‘상세 한 규칙’). VM 표는 같은 규칙에 **이름 옆 ‘빠른 확인’**(`VmNameCell` — 드로어)이 있는데 호스트 표에는 없다. |
| 사유 배지 | `views/hostChecksText.js reasonBadges(host, { sec, checks })` | `hostReasons`(점검 · 끊김 · CPU 90% 초과 — `hostTriage.js`) + `CHECK_CHIPS` 10종(업링크 끊김 · 인증서 · 죽은 경로 · 예기치 않은 재부팅 · iDRAC 부품 · 재부팅 필요 · SSH · 로그 유실 · Veeam 최근 백업 없는 VM). 호스트 표 · 전체 페이지 머리가 쓴다 — **모달에는 없다.** |
| 점검 묶음 | `GET /hosts/checks?vcenterId[&q]` (`routes/api/hostChecks.js`) | `byId[id] = { hw, boot, vm:{n,on,templates,vcpu,memMB}, veeam:{y,n,unknown,total} }` · 서버 60초 캐시(범위 · 판본 키) · 권한 없는 묶음은 키를 싣지 않는다. 화면은 열 때 1회만 부른다. |
| 24시간 추이 | `GET /hosts/:id/metrics?types=cpu,mem&interval=day` | VM 과 같은 경로(로그인 1회 + QueryPerf 1회). `vms/vmSeries.jsx useDaySeries` 는 지금 `/vms/` 로 고정돼 있다. |
| 인벤토리 한 행 | `/hosts` 항목 | `tempC` · `tempMaxC` · `bootTime` · `nics[]` · `hcfg.mp` 가 이미 있다 — 모달은 쓰지 않는다. |

캡처(목 서버 · Chromium 1440 · 400 · 오류 0): 스크래치패드 `hcur-modal-1440.png` · `hcur-modal-1440-bottom.png` · `hcur-modal-400.png` — 캔버스 ⓪ 에 실었다.

캡처에서 읽은 문제:
1. 값 16개가 같은 무게로 나열 — CPU 99% 가 위에서 일곱째 줄.
2. 확인할 것이 본문 중간(16개 아래)에 있고, 사유 배지는 이 창에 없다.
3. 단추 3개가 맨 아래 — 끝까지 스크롤해야 성능 · 개체 보기로 간다.
4. 목록이 가려지고 이전/다음이 없다.
5. 24시간 추이 · 온도 · 업타임이 없다(값은 이미 있다).
6. 같은 트리에서 VM 은 드로어, 호스트는 모달.

## 3. 정직하게 밝혀야 하는 것

- 시안의 이름 · 숫자(`esx-kr1-02` · 99% · 458 W …)는 **가상**이다. 실제 값이 아니다.
- **새 수집은 없다.** 드로어가 더 부르는 것은 ⓐ 24시간 추이 1회(VM 드로어와 같음) ⓑ 점검 묶음 1회(vCenter 단위로 기억)뿐이다.
  ⓐ 는 호스트를 ‹ › 로 넘길 때마다 vCenter 로그인이 1회씩 생긴다 — VM 드로어도 같지만, 빠르게 넘기면 로그인이 몰린다(§7 디바운스).
- 신호의 ‘사실 줄’(예: `DSwitch-Prod · vmnic3`)은 `hostFindingDetail(f)` 가 지금 만드는 문자열을 쓴다 — 시안 문구와 글자가 다를 수 있다.
- ‘전력 · 온도’ 타일의 출처 글자(iDRAC 실측 / vCenter)는 `powerSource` 를 따른다. `tempC` 의 출처는 이번에 확인하지 않았다 — 호스트 표 ‘온도’ 열의 설명을 그대로 쓴다.
- 점검 묶음을 못 받으면(권한 · 실패) iDRAC 부품 · 재부팅 · Veeam 신호와 VM 타일의 켜짐/할당 줄은 **비운다** — ‘이상 없음’ 으로 세지 않는다(캔버스 ④-D).
- 엣지 위임 vCenter 는 중앙에서 실시간 성능을 읽지 못한다(409) — 스파크 자리에 ‘24시간 추이를 읽지 못했습니다’(VM 과 같음).
- 실제 vCenter · 엣지에서는 확인할 수 없다(이 컨테이너) — 구현 검증은 목 서버 + 응답 주입이다.

## 4. 데이터 · 판정(복제 금지 — 있는 것을 쓴다)

| 드로어 자리 | 값 | 출처(새 판정 없음) |
|---|---|---|
| 머리 점 · 상태 배지 | 연결 상태 · 전원 | 호스트 행 `connectionState` · `powerState` · `StateBadge` |
| 배지 줄 | 사유 + 구성·보안 요약 | `reasonBadges()` · `secCountsOf()` + `secText()` — 호스트 표 · 전체 페이지와 같은 함수 |
| 타일 CPU · 메모리 | 사용률 · 용량 | `hostUsagePct()` · `cpuUsageMhz/cpuTotalMhz` · `memUsageMB/memTotalMB` · 스파크 `useDaySeries`(호스트용으로 일반화) |
| 타일 VM | 수 · 켜짐/꺼짐 · vCPU:코어 | `vmCount` + 점검 묶음 `vm` · `ratioText()` |
| 타일 전력 · 온도 | W · °C | `powerWatts` · `powerSource` · `tempC` · `tempMaxC` |
| 신호 줄 | 사유마다 제목 · 사실 · 설명 · 바로가기 | `reasonBadges()` 의 kind → 글자는 새 순수 모듈(§7) · 사실은 `hostFindingDetail` · 점검 묶음 |
| 하드웨어 · 배치 | 모델 · 태그 · ESXi · 업타임 · CPU · 메모리 · NIC · 경로 · HBA/GPU · 위치 | 호스트 행 + `uptimeDays` · `coresText` · `nicLinkDownOf` · `deadPathsOf` · `lunsOf` |
| 구성 · 보안 | 확인 항목 + 읽은 값(접힘) | `HostCfgSection`(접기 prop 추가) |
| 경합 · 클러스터 · HBA · GPU · 전력 | 지금과 같음 | `PerfcSection` · `ClusterCfgSection` · `HostHbaTable` · `HostGpuPanel` · `HostPowerPanel` 그대로 |

### 모달 → 드로어 자리 옮김(빠지는 것 없음)

| 모달(HostBasicRows) | 드로어 |
|---|---|
| 이름 + ‘VM N대 보기’ | 머리 제목 · 단추 줄 ‘VM N대 보기’(`HostVmsModal` 그대로) |
| 상태 · 전원 | 머리 점 + 위치 줄의 배지 |
| vCenter · 클러스터 | 위치 줄 + 하드웨어 · 배치 |
| 제조사/모델 · 서비스 태그 · ESXi 버전 · CPU · CPU 모델 · 메모리 | 하드웨어 · 배치 |
| CPU 사용률 · 메모리 사용률 | 타일(+ 24시간 추이) |
| 소비전력 · iDRAC 실측 | 타일 ‘전력 · 온도’(둘 다 있으면 하드웨어 · 배치에 ‘iDRAC 실측’ 한 줄) |
| VM 수 | 타일 ‘VM’ |
| HBA / GPU | 하드웨어 · 배치 + 아래 표 |
| 단추 3개(맨 아래) | 단추 줄(맨 위) + ‘전체 페이지 상세’ 추가 |

## 5. 화면 — 아트보드 6장

| # | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` 1440×1000 | vCenter › 호스트 및 클러스터 트리에서 호스트 이름 클릭 → 드로어. 트리가 뒤에 남고 ‹ › · ↑↓ = 트리의 호스트 순서. |
| ② | `Full.dc.html` 640×2240 | 드로어 전체 길이: 머리 → 단추 → 한눈에(타일 4) → 신호 → 하드웨어 · 배치 → 구성 · 보안(읽은 값 접힘) → 경합 → 클러스터 → HBA → GPU → 전력 → 개체 보기 탭 바로가기. |
| ③ | `Narrow.dc.html` 400×1640 | 720px 미만 전체 화면 시트 — 타일 2열 · 단추 2열(44px) · 값 1열. |
| ④ | `States.dc.html` 1440×760 | A 점검 모드 · B 끊김(값 ‘—’ · 판정 안 함) · C 신호 없음(무엇을 봤는지 한 줄) · D 못 읽은 묶음(없음으로 세지 않음). |
| ⓪ | `Current.dc.html` 1440×900 | 지금 모달 캡처 3장 + 읽은 문제 6가지. |
| ⑤ | `Entry.dc.html` 1440×760 | ESXi 호스트 표의 이름 옆 ‘빠른 확인’ + 진입점 8곳의 지금 · 시안. |

드로어 뼈대 · 여백 · 글자 크기는 `vmHub.css` 의 `.vmh-drawer` 계열(오른쪽 640px · z 150/151 · 720px 미만 100vw)을 그대로 쓴다 — 새 틀을 만들지 않는다.

## 6. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

| # | 질문 | 기본값 | 다른 선택 |
|---|---|---|---|
| ① | 바꾸는 범위 | 모달을 여는 곳 전부(트리 · 알람 · 탐색 · IP 관리 · 통합 성능 모니터링) + ESXi 호스트 표에 ‘빠른 확인’ 추가 | 트리만 · 호스트 표 단추는 빼기 |
| ② | 타일 4칸 | CPU · 메모리 · VM · 전력·온도 | 전력·온도 자리에 업타임 또는 스토리지 경로 |
| ③ | 신호 | 호스트 표 사유 배지와 같은 판정 + 구성·보안 요약 배지 · 점검 묶음은 열 때 1회 | 점검 묶음 없이 인벤토리 사유만(호출 0) |
| ④ | 구성·보안 읽은 값 25개 | 드로어에서는 접어 둠(개체 보기 · 전체 페이지는 펼친 채) | 지금처럼 펼침 |
| ⑤ | 데이터스토어 모달 | 이번 범위 밖(그대로) | 같은 문법으로 함께(별도 시안 필요) |
| ⑥ | 검증 | 표준 — 관련 테스트 + Chromium 1440 · 400 1회 | 전체 검증 · 빠르게 |

## 7. 구현 메모(컨펌 뒤 · Opus)

- 새 파일: `web/src/views/hosts/HostDrawer.jsx`(뼈대는 `VmDrawer` 와 같은 클래스) · `hostDrawerText.js`(순수 — 사유 kind → 제목 · 사실 · 설명 · 바로가기 탭, 타일 글자) + 테스트.
- `EntityDetail` 의 호스트 가지를 `HostDrawer` 로 위임(`rows=[]`) — 호출처 6곳은 고치지 않는다. 데이터스토어 가지는 그대로.
- `VCenterDetail`: 호스트 클릭 = `setHostDrawer(h)` · 순서는 `vcd/treeRows.js` 에 `treeHostRows()` 추가(지금 트리에 보이는 호스트 — 검색 반영). 해시가 바뀌면 닫는다(VM 과 같음).
- `Hosts.jsx`: 이름 칸에 ‘빠른 확인’(VM 표의 `.vmd-quick`) · `rows` = 지금 표 순서. 표 폭 · 400px 2줄 목록을 Chromium 으로 본다.
- `useDaySeries(id, enabled, entity = 'vm')` — 경로만 일반화. ‹ › 로 넘기는 동안은 **잠깐 기다렸다 조회**(디바운스)해 로그인이 몰리지 않게 한다 — VM 드로어에도 같이 적용할지 구현 때 판단.
- 점검 묶음: `/hosts/checks?vcenterId` 를 드로어가 vCenter 별로 한 번만(늦게 온 이전 응답은 버린다 · 폴링 없음). 호스트 표에서 열면 표가 이미 가진 `checks.byId` 를 prop 으로 넘겨 다시 묻지 않는다.
- `HostCfgSection` 에 `foldValues` prop(기본 false — 개체 보기 · 전체 페이지는 그대로).
- 못 읽은 값은 `numOrNull` — ‘—’ + 단위 없음. 끊긴 호스트는 사용률 색 · 스파크 · 구성 판정을 그리지 않는다.
- 문구: `BoldText` 를 쓰면 백틱 금지 · 임계값(90%) 숫자는 `CPU_ATTENTION_PCT` 에서.
- 테스트: 순수 모듈 · 첫 렌더(신호 확인 중 → 받은 뒤) · 소스 스윕(훅은 조기 return 위 · 폴링 없음 · `EntityDetail` 위임). 기존 `vmPerf2911.test.jsx` 의 ‘호스트 모달은 그대로’ 단언은 갱신한다.
- 화면이 바뀌므로 Chromium 1440 · 400(오류 0 · 가로 넘침 0 · ‹ › · Esc · 모달 안에서 연 경우의 쌓임)을 직접 본다.

## 8. 구현(v2.975.0 · 2026-11-11 · 컨펌 ‘기본값대로 진행해줘’)

| 기본값 | 구현 |
|---|---|
| ① 범위 | `EntityDetail type='host'` → `HostDrawer` 위임(알람 · 탐색 · IP 관리 · 통합 성능 모니터링) · vCenter 트리 호스트 클릭(‹ › = `treeHostRows`) · 호스트 표 이름 옆 ‘빠른 확인’(‹ › = 표 순서) |
| ② 타일 | CPU · 메모리 · VM · 전력·온도 |
| ③ 신호 | `reasonBadges` + 구성·보안 요약 배지 · 점검 묶음은 vCenter 마다 1회(호스트 표에서는 표의 것을 재사용 — 요청 0) |
| ④ 읽은 값 | 드로어만 접힘(`HostCfgSection foldValues`) |
| ⑤ 데이터스토어 | 그대로(모달) |
| ⑥ 검증 | 표준 — 관련 테스트 + Chromium 1440 · 400 |

### 8.1 시안과 달리 한 것

- **‘전체 페이지 상세’ 는 단추 줄이 아니라 아래 바로가기 줄**에 둔다 — 단추 5개가 640px 에서 두 줄로 넘어갔다(Chromium 확인). 단추 줄은 4개 한 줄.
- **타일 글자를 줄였다** — 시안의 ‘32코어 · 76.0 / 76.8 GHz’ · ‘vCPU 50 할당 · 코어 대비 1.6 : 1’ 은 타일 폭(안쪽 약 110px)에서 잘렸다. CPU 는 GHz 만(코어 수는 하드웨어 · 배치), VM 은 한 줄에 한 가지(켜짐·꺼짐 / 템플릿 / vCPU 할당 / 코어 대비).
- **시안 ② 의 경합 섹션이 틀렸다(정정)** — 호스트에 ‘CPU 대기(Ready) · Co-stop’ 줄을 그렸는데 호스트 `perfc` 에는 그 값이 없다(최대 디스크 지연 · 측정 데이터스토어 수뿐). 구현은 기존 `PerfcSection` 그대로라 두 줄이다.
- 신호 줄의 사실 글자는 시안의 ‘DSwitch-Prod · vmnic3 링크 내려감 (업링크 2개 중 1개)’ 가 아니라 `findingDetail` 이 만드는 ‘DSwitch-Prod/vmnic3’ 이다(§3 에 미리 적은 대로).
- 섹션 머리(구성·보안 · 경합 · 클러스터 · HBA · 전력)는 기존 컴포넌트의 작은 회색 제목 그대로다 — 시안처럼 드로어 제목 모양으로 맞추지 않았다(VM 드로어와 같은 상태 · 공용 컴포넌트를 건드리지 않으려고).
- 400px 단추는 시안의 2열 격자(44px)가 아니라 VM 드로어와 같은 줄바꿈 줄이다(공용 단추 그대로).

### 8.2 Chromium 확인(목 서버 · 1440 · 400 · pageerror/console error 0 · 문서 가로 넘침 0)

- 트리 → 드로어(모달 0) · ‹ › · ↑↓ 이동(트리 순서) · ‘목록 2/24’ · 단추 4개 한 줄(높이 36px · 같은 y) · 타일 글자 잘림 0 · 읽은 값 펼치기(21줄).
- 빠르게 5번 넘김 → 추이 요청은 마지막 호스트 1건.
- 호스트 표: ‘빠른 확인’ 30개 · 이름 칸 230px 안(단추 59×18) · 드로어를 여는 동안 `/hosts/checks` 추가 요청 0 · › = 표의 둘째 행.
- 알람(호스트 알람 행) · 탐색(Top-N) → 드로어(‹ › 잠김).
- VM 보기 → 호스트 VM 모달 → VM 드로어가 맨 위 · Esc 순서 = VM 드로어 → 모달 → 호스트 드로어.
- 개체 보기 · 전체 페이지 상세 → 이동하고 드로어가 닫힌다.
- **주입**: 끊긴 호스트(‘—’ · 추이 없음 · ‘연결이 끊긴 호스트라 판정하지 않았습니다’) · 점검 호스트 · `/hosts/checks` 500(‘받지 못한 묶음 … 이상 없음이 아닙니다’).
- VM 드로어 회귀: 단추 줄 여백을 같이 고쳐 5개가 같은 높이 · 같은 y.

### 8.3 남긴 것

- VM 드로어의 24시간 추이에는 지연 조회를 넣지 않았다(기본값 0 — 동작을 바꾸지 않으려고). 같은 로그인 몰림이 VM 에도 있다.
- 모달 안에서 연 호스트 드로어(IP 관리의 소유 호스트)는 Chromium 으로 따로 보지 않았다 — VM 드로어와 같은 CSS 라 같게 동작할 것으로 **추정**한다.
- 실 vCenter · 엣지 위임 환경은 이 컨테이너에서 닿지 않는다 — 409(엣지 위임) 때 스파크 문구는 VM 과 같은 코드 경로지만 호스트로는 주입해 보지 않았다.
- 데이터스토어 상세는 여전히 가운데 모달이다(범위 밖).
