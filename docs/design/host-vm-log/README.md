# 설계: 호스트별 VM 기록 — 가상화 호스트마다 매시 정각에 어떤 VM 이 돌고 있었는지 남긴다

- 상태: **시안 — 컨펌 대기**(2026-11-26). 구현은 컨펌 뒤(규칙: 설계는 Fable + Claude Design 시안 → 컨펌 → Opus 구현).
- 캔버스(Claude Design · 비공개 — 소유자만 열 수 있다): https://claude.ai/artifact/LGvNZYjANNJoq51D5Jri5C
- 아트보드 원본: 이 폴더의 `*.dc.html` 4개(캔버스에 올린 것과 같은 파일 — 복사 대상이 아닌 레퍼런스). 캔버스 렌더는 직접 열어 확인하지 않았다(Design 유형 규칙 — 요청 없이는 검증하지 않는다).
- **호스트 · VM · vCenter 이름(esx-pl1-04 · db-pl1-ora01 · VC-PL1 …) · IP · 수치 · 시각은 전부 그림용 가상값**이다. 메뉴 경로 · 알림 제목 · 탭 이름만 실제 포탈 것이다.
- 색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로(새 hex 없음 · 보조 글자는 대비 때문에 `--text-faint` 대신 `--text-dim`). 계정의 ‘Design System’ 아티팩트는 지금도 유형 파일뿐이라(`project/README.md` · `tokens.json` 없음 — 2026-11-26 목록으로 확인) 쓰지 않았다.

## 1. 요구(사용자 2026-11-26 12:15 KST)

> "1시간에 1번씩 가상화 호스트에 어떤 vm 동작하고 있는지 기록 남기는 기능 만들어줘, 가상화 호스트가 장애가 발생했을때 빠른 조치를 위해서 필요해, 시간 만들어서 보여줘,"

읽기(내 판단): ‘시간 만들어서 보여줘’ 는 ‘**시안** 만들어서 보여줘’ 의 오타로 봤다(설계 요청 → 시안 먼저). 다르면 바로잡는다.
목적이 ‘호스트 장애 때 빠른 조치’ 이므로 화면의 중심은 **기록 열람이 아니라 장애 호스트 한 대** — 직전 기록에 있던 VM 이 누구이고(이름 · IP · 크기) **지금 어디에 있는가**다.

## 2. 지금 코드에서 확인한 것(main v3.44.0 · 2026-11-26 12:15~12:25 KST)

| 사실 | 위치 |
|---|---|
| ‘어느 시각에 어느 호스트에 어떤 VM 이 있었나’ 를 남기는 기능은 **없다**. VM 수량 추이는 00시 · 12시에 **수량 + 생긴/사라진/전원이 바뀐 VM** 만 남기고, `roster.host` 는 지금 값 한 칸(덮어씀)이다 | `server/src/vmtrack/db.js`(snaps · changes · roster) · `poller.js` |
| 같은 방식의 선례 — **VM 전원 이력**(v3.39.0): 10분마다 수집 결과(store 스냅샷)를 읽기만 하고, **바뀐 VM 만** ‘같은 상태가 이어진 구간’ 한 행으로 저장 · 관측 시각은 vCenter 당 한 행 · 관측이 끊긴 시간은 따로(`power_gaps`) · 못 읽은 vCenter 는 관측에서 뺀다 | `server/src/vmpower/spans.js` · `watcher.js` · `db.js` |
| 못 읽은 vCenter 판정은 한 벌 — 점검중 · 연결 실패 · 낡음 · 긴급중단 | `server/src/metrics/sampler.js samplingUnreadReasons` |
| VM 레코드: `host`(호스트 **이름**) · `cluster` · `clusterRef` · `powerState` · `connectionState` · IP · `guestOS` · `cpuCount` · `memMB` · `instanceUuid` · `id = <vc>:<ref>`. **호스트 ref(id)는 VM 레코드에 없다** | `server/src/vcenter/soapClient.js:2351` 부근 |
| 호스트 레코드: `id = <vc>:<ref>` · `connectionState` 는 `CONNECTED` · `MAINTENANCE` · `DISCONNECTED`(vCenter 의 notResponding 도 `DISCONNECTED` 로 싣는다) | `soapClient.js:2152` |
| ‘호스트 연결 끊김: <이름>’ 알림이 이미 있다(경고 · 키 `host:<id>`) | `server/src/alerts.js:336` |
| 수집 주기 기본 30초(`POLL_INTERVAL_MS`) — 엣지 위임 vCenter 도 중앙 스냅샷에 병합돼 있어 **중앙이 읽기만 하면 된다**(vCenter 왕복 · WAN 왕복 없음) | `server/src/config.js:104` · `vmtrack/service.js` 머리 주석 |
| 호스트 개체 보기에 ‘VM’ 탭 · 호스트 빠른 확인(드로어)에 ‘VM 보기’ 단추가 있다 — 둘 다 **지금** 목록 | `web/src/views/vcd/objTabs.js HOST_OBJ_TABS` · `views/hosts/HostDrawer.jsx` |
| 메뉴: 서버 › Hypervisor(`hv` — `also: host-hygiene · esxi · hba · cluster-check`) · 도구 키는 `specialToolsList.js` · `toolcats/catalog.js` · `auth/toolAccess.js` 세 곳 | `web/src/views/topMenu.js:40` |
| 범위 계정 규칙 선례(VM 수량 추이): 조회는 `requirePerm('tools')` + `scopedVcenterIds` · 전 법인 수동 실행은 범위 계정 403(`denyScopedRun`) · DB 경로는 관리자 판본만 | `server/src/routes/api/vmtrack.js` |

정정 기록: 이 세션은 처음에 **main 보다 뒤인 브랜치(v2.914)** 에서 조사를 시작했다 — 시안 4장을 올린 뒤 `git merge --ff-only origin/main`(v3.44.0)으로 맞추고 위 표를 다시 확인했다.
바뀐 것: 메뉴 이름(가상화 서버 → 서버 › Hypervisor — 보드 ①②④ 문구 수정) · 선례(`vmpower`)가 생겨 §4 저장 방식의 근거가 됐다 · 호스트 드로어(v2.975)가 생겨 진입점에 더했다.

## 3. 정직하게 밝혀야 하는 것

1. **정각 기록은 최대 59분 전 것이다.** 14:00 기록 뒤 14:37 에 호스트가 멈추면, 그 37분 사이 DRS · 수동 이동으로 들어오거나 나간 VM 은 목록과 다를 수 있다 — 화면이 그대로 말한다(①). 줄이는 길은 질문 1(기록 간격) · 질문 2(끊김을 본 순간의 기록).
2. **‘지금 다른 호스트에서 구동 중’ 은 위치만 말한다.** HA 재시작인지 사람이 옮긴 것인지는 이 기록으로 알 수 없다(판단하지 않는다).
3. **기록 사이에 들어왔다 나간 VM 은 남지 않는다**(관측 방식의 한계 — 전원 이력과 같다).
4. **이동 빈도(DRS)를 실측하지 못했다** — 저장량은 ‘VM 수(약 5,850행) + 호스트 · 전원이 바뀔 때마다 1행’ 이라는 구조만 확실하고, 1년 뒤 행 수는 추정도 적지 않았다(구현 뒤 실측해 설정 화면에 보인다).
5. 기능을 켜기 **전**의 과거는 채울 수 없다(VM 수량 추이의 `changes` 에 호스트 칸이 있지만 생성 · 삭제 · 전원 전환 때의 값뿐이라 ‘그 시각의 전체 목록’ 을 되살릴 수 없다 — 소급하지 않는다).
6. 호스트 이름이 바뀌면 이어 보려면 **VM 레코드에 호스트 ref 가 필요하다** — 지금은 이름뿐이다(§2). 구현 때 `hostId` 를 싣거나(엣지 정제 화이트리스트에도 추가) 이름 기준으로 두고 ‘이름이 바뀌면 끊긴다’ 고 말하거나 — 질문 6.
7. vCenter 가 그 호스트 위에서 돌다가 같이 멈추면 ‘지금’ 열은 전부 ‘모름’ 이다(③ 상태 2). 그때 목록 · IP 는 포탈 DB 에 있어 그대로 보인다.

## 4. 데이터 · 서버(새 vCenter 호출 없음 — 수집 결과를 읽기만 한다)

### 4.1 저장 — ‘구간’ 모델(전원 이력과 같은 방식 · 권장)
매시 5,850행을 통째로 복사하면 90일에 약 1,260만 행(5,850 × 24 × 90)이다. 대신 **VM 이 한 호스트에 같은 전원 상태로 머문 구간을 한 행**으로 둔다 — 화면이 보는 결과(‘그 시각 그 호스트의 VM’)는 같다.

- `place_spans(vcenter_id, vm_id, name, host, host_id?, cluster, power, conn, ip, guest_os, cpu, mem_mb, instance_uuid, from_ts, to_ts NULL=진행 중)` — 호스트 또는 전원이 바뀌면 앞 구간을 닫고 새 구간을 연다. 이름 · IP 는 구간 안에서 마지막으로 본 값.
- `place_slots(slot, vcenter_id, ts, hosts, vms_on, vms_total)` — **그 시각을 실제로 기록한 vCenter** 만 한 행(28 × 24 = 하루 672행). 행이 없으면 ‘기록 없음’(0대가 아니다).
- `host_spans(vcenter_id, host_id, name, cluster, state, from_ts, to_ts)` — 호스트 연결 상태 구간(끊김을 처음 본 시각 · ‘호스트가 연결돼 있던 마지막 기록’ 계산).
- 조회: `host = ? AND from_ts <= S AND (to_ts IS NULL OR to_ts >= S)` + 그 vCenter 의 슬롯 S 가 있는지. 인덱스 `(vcenter_id, host, from_ts)` · prune 용 `to_ts` 단독.
- 규약(perf-db): 한 번의 기록은 vCenter 하나당 트랜잭션 하나 + 사이사이 양보 · prune 은 스로틀(기동 첫 틱 금지) + 청크 · WAL · `util/sqliteOpen.js`. 못 읽은 vCenter 는 `samplingUnreadReasons` 로 빼고 **열린 구간을 닫지 않는다**.

### 4.2 기록기(`server/src/hostvmlog/` — 가칭)
60초 틱 + 재진입 가드(수동 실행과 공유) · 정각 슬롯 키(포탈 시각 `util/dayKey.js`) · 그 슬롯이 비어 있으면 1회 기록(포탈이 정각에 꺼져 있었으면 켜진 뒤 늦게 채운다 — `vmtrack/poller.js` 와 같은 모양) · 첫 수집 중(pending) vCenter 는 기다린다.
기록기가 3번 넘게 빠지면 화면 머리가 경고한다(무음 실패 금지 — ③ 상태 6).

### 4.3 API(가칭 · 조회는 `requirePerm('tools')` + 범위)
- `GET /tools/host-vm-log` — 상태(마지막 슬롯 · 기록한 vCenter 수 · 보관) + 호스트 목록(마지막 기록의 구동 VM 수 · 지금 연결 상태) + **지금 끊긴 호스트**(끊김을 처음 본 시각 · 직전 기록 · VM 수).
- `GET /tools/host-vm-log/host?hostId&slot` — 그 시각 그 호스트의 VM + **지금 대조**(요청 때 store 스냅샷과 맞춘다: 응답 없음 · 다른 호스트 구동 · 꺼짐 · 인벤토리에 없음 · 모름) + 그 24시간의 슬롯별 수 · 변화. 범위 밖 호스트는 404.
- `POST /tools/host-vm-log/run`(지금 기록) · 보관 설정 — 관리자 + 전체 범위(`fullScopeOnly`) · 감사 로그.
- 상시 폴링하지 않는다(마운트 1회 + ‘지금 다시 조회’). CSV 는 화면이 받은 행으로 만든다.

## 5. 화면 — 아트보드 4장

| 보드 | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` | **장애 호스트를 연 모습**(1440): 머리(마지막 기록 · 기록한 vCenter · 보관 · 지금 기록) · **지금 연결이 끊긴 호스트** 띠 → 직전 기록 보기 · 왼쪽 호스트 고르기(검색 · 끊김/유지보수 칩 · 마지막 기록의 구동 VM 수) · 오른쪽: **시각 24칸**(칸 숫자 = 그 시각 구동 VM 수 · 밑줄 = 직전과 달라진 시각 · 점선 ‘—’ = 기록 없음) + ◀ 이전 24시간 · 날짜로 이동 · **그때/지금 타일 6**(그때 구동 18 · 할당 합 · 지금 응답 없음 5 · 다른 호스트 구동 11 · 꺼짐 1 · 인벤토리에 없음 1 — 누르면 그 VM 만) · VM 표(이름 · OS · IP · vCPU · 메모리 · 이 호스트에 있던 기간 · 지금 위치 · 지금 상태 — 조치 필요가 위) · 이름 복사 · CSV · 이 24시간의 변화(들어옴 · 나감) |
| ② | `Narrow.dc.html` | ① 의 400px — 시각 줄은 가로 밀기 · 타일 2열 · 표는 카드 목록 · 단추 44px |
| ③ | `States.dc.html` | 상태 6종 — 그 시각 기록 없음(앞 · 뒤 기록으로) · 지금 상태 모름(vCenter 연결 불가) · 그 시각 호스트 없음 · 첫 기록 전 · 범위 계정 · 저장소 사용 불가 |
| ④ | `Entry.dc.html` | 들어오는 길 3곳(끊김 알림 행의 ‘VM 목록 보기’ · 호스트 개체 보기 VM 탭/드로어의 ‘시각별 기록 보기’ · 서버 › Hypervisor 메뉴 `#/tools/host-vm-log[/<호스트>]`) + 기록 설정(주기 · 보관 · 제안 2가지 · 저장 현황) |

## 6. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

1. **기록 간격** — 기본: **1시간(요청대로 · 매시 정각)**. 대안: 10분(전원 이력과 같은 관측기 — 저장은 바뀐 것만이라 용량 차이는 작고, ‘직전 기록’ 이 최대 59분 전 → 최대 9분 전이 된다. 화면의 시각 줄은 그대로 1시간 칸으로 보이고 칸 안에서 더 가까운 기록을 고른다).
2. **끊김을 본 순간의 기록** — 기본: **남긴다**(호스트가 연결됨 → 끊김으로 바뀐 것을 본 순간, 그 직전 수집의 그 호스트 VM 목록을 한 번 더 남긴다. 메모리에 직전 배치만 들고 있다가 그때만 쓴다). 빼면 정각 기록만.
3. **끊김 알림 메일에 VM 이름** — 기본: **넣지 않는다**(알림 화면에 링크만). 넣으면 메일 본문에 직전 기록의 VM 이름(상한 있음) — 알림 경로를 고치므로 검증 범위가 늘어난다.
4. **보관 기간** — 기본: **90일**(설정에서 30일 · 90일 · 180일 · 1년). VM 수량 추이처럼 1,095일로 둘 수도 있다.
5. **내려받기** — 기본: **CSV + 이름 복사**. Excel(xlsx)도 원하면 추가.
6. **호스트 이름이 바뀐 경우** — 기본: **VM 레코드에 `hostId` 를 싣고 식별자로 잇는다**(수집 · 엣지 정제 화이트리스트 수정 포함). 대안: 이름 기준(수집을 건드리지 않는다 · 이름이 바뀌면 기록이 끊긴다).
7. **검증 수준** — 기본: **표준**(관련 테스트 + Chromium 1440/400 + 전량 verify) + 범위 404 · 못 읽은 vCenter 를 빈 목록으로 닫지 않는지 **변이 검증 1회**. ‘전체 검증’ 이면 반증 1인 추가.

## 7. 구현 메모(컨펌 뒤)

- 서버: `server/src/hostvmlog/{spans.js(순수 — 구간 계획 · 슬롯 키 · 지금 대조 판정),db.js,poller.js,service.js}` · `routes/api/hostVmLog.js` · `index.js` 기동 · `edgelog/spec.js` 등재 여부 확인(중앙 전용이면 불필요) · `alerts.js` 끊김 알림 detail 에 링크 값.
- 웹: `web/src/views/tools/HostVmLogTool.jsx` + `hostVmLogText.js`(순수 — vitest) · 표는 `STable` · `specialToolsList.js` · `toolcats/catalog.js` PRESET · `auth/toolAccess.js` · `topMenu.js hv.also` · `HostObject` VM 탭 · `HostDrawer` · `Alarms` 링크.
- 먼저 `docs/COMMON.md` 에서 슬롯 키 · 구간 스크롤(창 계산) · CSV 공용 모듈을 찾는다(복제 금지).
- 테스트: 구간 계획(이동 · 전원 전환 · 못 읽은 vCenter 는 열린 구간 유지 · 슬롯 누락) · 조회(그 시각 목록 = 통째 복사 결과와 같다 — 대조 시험) · 범위 404 · 지금 대조 5분류 · 웹 문구.
- 문서: `docs/rules/vcenter.md` 항목 · 이 README §8 ‘시안과 달리 한 것’. 릴리스: 포탈 동작이 바뀌므로 버전업 + 게시 1회.
