# 설계: 가상화 호스트 ↔ SAN 조닝·트래픽 귀속 + CVP 업링크 매칭

작성 2026-11-07 (v2.914.0 · main 작업본 기준) · 상태 **v2.920 구현(기본값 A 단계 — 2026-11-07 사용자 '기본값대로 구현해')** · 시안 캔버스: https://claude.ai/artifact/YB7ZxbXJXoLPWqNNRDfRrj
(캔버스 셋째 줄 ‘The.DVC 적용판’ D-①~④ 가 이 폴더의 `*.dc.html` 4장과 같은 내용이다. 첫째·둘째 줄 6장은 포탈 룩을 입히기 전의 일반 초안이라 참고만 한다.
색 · 글자 · 배지 · 카드는 `web/src/styles.css` `:root` 토큰과 `.card` · `.badge` · `.ht-kpi` · `.hd-nav` · `STable` 규격 그대로이고,
호스트 · 스위치 · 스토리지 이름과 **수치는 전부 가상값**이다. 계정의 ‘Design System’ 아티팩트는 앞 시안들과 같이 비어 있어 쓰지 않았다. 아트보드에 이모지는 없다.)

규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현(2026-11-03 ‘기억해’).

## 1. 요구(사용자 2026-11-06 ~ 11-07)

> "가상화 서버가 SAN 스토리지를 사용하는데, 가상화 서버의 WWN 을 읽어서 SAN switch 조닝 정보와 매치해서 가상화 서버가 실제로 사용하는 트래픽을 분석하고, 어떤 스토리지와 얼마만큼 트래픽이 발생하는지 통계내는 기능 추가해줘, 지금 SAN 스위치 정보를 수집하고 있어서 수집된 정보를 조합하면 만들 수 있을 거 같다"
> "가상화 서버의 MAC 정보, IP 정보 등을 사용해서 CVP 와 연결해서 CVP 에서 해당 서버의 트래픽 패킷 드랍 등의 정보를 수집해서 보고 싶어"
> "The.DVC 여기 repository 에 적용 가능한 시안 다시 만들어서 보여줘" · 범위 질문에 **표준** 선택(아트보드 4장 + 레퍼런스).

## 2. 지금 코드에서 확인한 것(설계의 근거 — 2026-11-07 00:40~00:55 KST)

| 사실 | 위치 |
|---|---|
| 호스트 HBA 는 `hbas[].{name,type,model,speedGbps,wwn}` 로 이미 수집된다(WWN 10진 → 콜론 16진 정규화) | `server/src/vcenter/soapClient.js:940~1022` · 화면 `components/EntityDetail.jsx HostHbaTable` |
| 호스트 멀티패스는 **개수만** 있다 — `hcfg.mp {luns,shared,paths,dead,deadLuns,singlePath,singleLuns,policies}`. 경로별 타깃 WWN 은 같은 SOAP 경로(`config.storageDevice.multipathInfo`)에 있지만 파서가 세고 버린다 | `server/src/hostcfg/parse.js:127~164` (`HOST_MP_PATH`) |
| SAN 스위치 스냅샷은 포트별 `attached[]`(연결 장비 WWN) · `nsRoles[wwn]`(네임서버 FC4 역할) · `zoning.zones[].members` · 누적 카운터 + 델타 `inBps/outBps`(첫 수집 null) 를 가진다 | `server/src/sanswitch/types.js` 스키마 · `zoning.js` · `rates.js` |
| 조닝 역할은 ‘보여 주는 것’ — `confirmed(●)` 네임서버 / `inferred(◐)` zone 그래프 2-색칠 / `guess(◔)` / `none(○)`. 기본값 initiator 금지 · VPLEX 는 가운데 열 | `docs/rules/sanswitch.md` · `web/src/views/tools/sanZoningView.js CONFIDENCE_LABEL` |
| SAN 성능은 15분·1시간 집계 표(perfDb)로 계산하고, 어레이는 **등록 스토리지 시리얼 일치**로 식별한다(`matched` → `array`, 미일치는 `::` 키) | `server/src/sanswitch/perfDb.js:945~956 endpointKind` |
| 스토리지 트래픽 카드는 **어레이 포트만** 더한다(HBA 포트는 같은 트래픽의 반대편) · 이월 한계 carryMs · 값 없으면 ‘—’ | `sanswitch/trafficTotal.js` · `docs/rules/sanswitch.md` v2.669 |
| 호스트 물리 NIC 는 `nics[].{device,mac,speedMb,link,driver}` · 가상 스위치 업링크 `net.switches[].uplinks` · 관리 IP | `soapClient.js parsePnics` · `views/HostDetail.jsx` ‘네트워크’ 카드 |
| VM vNIC MAC 은 VM 장치 캐시 `dev.nics[].mac` 에 있다 | `soapClient.js:805` |
| CVP 는 `port_latest(descr · speed_bps · oper · admin · vlan · lag · in/out_bps · in/out_util · in/out_err · mac · mtu)` · `port_sample` · `port_daily` · `events(title · description · eventType)` 를 가진다. **드롭(discards) · MAC 테이블 · LLDP · EndpointLocation 은 수집하지 않는다** | `server/src/cvp/db.js:63~78` · `parse.js:831~889`(카운터는 octets/errors 만) · `client.js:91~134`(경로 후보) |
| CVP 조회 경로는 전부 추정이고 화면이 그 사실을 말한다 · 후보 체인 · 원문 표본 · ‘읽음 0개 ≠ null’ | `docs/rules/cvp.md` v2.608 · v2.641 |
| 호스트 상세는 전체 페이지 `#/hosts/<id>` — 묶음 카드(`Card id`) + 묶음 이동 pill(`hd-nav`) + KPI(`ht-kpi`) | `web/src/views/HostDetail.jsx` (SECTIONS 10개) |
| SAN 도구는 `#/tools/san-switch` 하나이고 ‘포트별 · 연결 스토리지별’ 보기 세그먼트가 있다 · 도구 키는 바꾸지 않는다 | `web/src/views/tools/SanSwitchTool.jsx:912` · 루트 CLAUDE.md |

## 3. 화면(IA) — 아트보드 4장

```
D-① HostSan    #/hosts/<id> — 새 묶음 ‘SAN 경로 · 트래픽’(hd-nav 에 pill 1개 추가, 기존 ‘스토리지’ 카드는 그대로)
                KPI 5 · HBA↔스위치 포트↔Zone 표 · 조닝 체인(패브릭별 · ●/◐ 표기) · 스토리지별 트래픽 표(확정분/추정분 분리) · 멀티패스(지금 값) · 24h 처리량(읽기 실선 · 쓰기 점선) · 출처 칩
D-② HostNet    #/hosts/<id> — 기존 ‘네트워크’ 카드에 CVP 열 3개(스위치·포트 / 매칭 근거 / 지금 송신·수신) + 업링크 포트 블록 2(송신·수신·에러·드롭) + 24h 추이 + CVP 이벤트 + VM vNIC MAC 칩
D-③ SanAttrib  #/tools/san-switch — 보기 세그먼트에 ‘호스트 귀속’ 추가. 법인 칩 · 기간 · 패브릭 · ‘확정만’ · KPI 5 · 스토리지별 호스트 스택 바 · 신뢰도 규칙 카드 · 호스트 × 스토리지 매트릭스(STable) · 조닝만/미귀속 표
D-④ DataMap    화면 요소 ↔ 데이터(지금 있음 / 새 수집 / 계산) 표 · 새 수집 항목의 규약·위험 표 · 흐름 2줄
```

## 4. 설계

### 4.1 귀속 신뢰도(SAN) — 모든 트래픽 숫자 옆에 붙는다. 조닝 그림의 ●/◐ 와 같은 표기
- **● 확정** — HBA 포트의 활성 Zone 안 스토리지(등록 시리얼 일치)가 1개면 그 포트 카운터 전부가 그 스토리지다. 경로별 타깃 WWN 을 수집하면 working 경로가 1 스토리지일 때도 확정.
- **◐ 추정** — Zone 안 스토리지가 2개 이상이면 그 스토리지들의 **타깃 포트 카운터 비율**로 나눈다(호스트 × 타깃 포트 행렬 IPF 보정 — 행합 = 호스트 포트 Δ · 열합 = 타깃 포트 Δ). 값은 ≈ 로 적고 호버에 근거.
- **— 측정 없음** — 첫 수집 · 카운터 리셋 · 부분 합 버킷 · 수집 공백. 0 으로 채우지 않고 개수를 밝힌다(`rates.js` · `perfDb` 규약 그대로).
- **조닝만** — 허용(Zone)은 있는데 로그인이 없거나 24h 0 B. 통계에 넣지 않고 따로 표(정리 후보).
- 호스트 합계는 HBA 포트 카운터 그대로(확정) · 행별 분배만 추정 · **확정분과 추정분을 한 숫자로 합치지 않는다**(부분 합 규약).
- nsRoles 가 빈 패브릭은 타깃 역할도 추정이라 귀속이 확정으로 올라가지 않는다. VPLEX(가운데 계층)는 BE 쪽 어레이로 귀속.
- 방향: 호스트 F_Port 의 스위치 Tx(outBytes) = 읽기(스토리지 → 호스트) · Rx(inBytes) = 쓰기.

### 4.2 업링크 매칭 신뢰도(NET · CVP)
- 근거 우선순위 **LLDP 이웃(확정) → MAC 테이블 학습(높음) → 포트 설명 일치(보통 · 지금 가능) → 없음(미매칭)**. 근거 없는 매칭은 만들지 않는다.
- 호스트 MAC 집합 = 물리 NIC ∪ vmk ∪ VM vNIC(`dev.nics.mac`) — 스위치 포트가 학습하는 MAC 은 대부분 VM 것이다. MLAG peer 중복은 제거하고, 비-MLAG 두 포트에서 같은 MAC 이 보이면 ‘충돌’.
- 방향은 스위치 포트 기준: **In = 서버 송신 · Out = 서버 수신** — 화면 상단 띠와 열 이름이 말한다.
- 드롭 판정(‘어느 쪽 드롭인가’)은 CVP 측 discards 와 ESXi 측 vmnic 드롭이 **둘 다** 있을 때만. 지금은 CVP in_err/out_err 와 사용률만 판정 가능.

### 4.3 새 수집 · 새 계산(D-④ 표와 같다)
| 항목 | 종류 | 어디에 | 규약 |
|---|---|---|---|
| 경로별 타깃 WWN · state · isWorkingPath | 새 수집(같은 SOAP 경로) | `hostcfg/parse.js parseMultipath` → `hcfg.mp.paths[]` | 상한 · 엣지 push 화이트리스트 · 못 읽음 null |
| 귀속 엔진 | 새 계산 | `sanswitch/attribution.js`(순수) + `GET /tools/sanswitch/attribution` | 판정 코어 하나 · memoJson + scopeKey · 범위 계정은 자기 법인 · 큰 집계는 조각 + 양보 |
| CVP 드롭 카운터 | 새 수집(경로 추정) | `cvp/client.js counters` 후보 + `parse.js parseCounters` | 후보 체인 · 원문 표본 · usedPaths/missing 표시 |
| MAC 테이블 · LLDP · EndpointLocation | 새 수집(경로 추정) | `cvp/client.js` 새 종류 · `db.js mac_latest` · 엣지 push | 변경분 gzip push · 정제 화이트리스트 · MAC 정규화 · EndpointLocation 호출 상한 |
| 업링크 매칭 엔진 | 새 계산 | `cvp/hostMatch.js`(순수) + 라우트 · 웹 `hostNetText.js` | 매칭 이력 저장(이동 · vMotion) · ‘미매칭’ 을 지어내지 않음 |
| ESXi vmnic 드롭·에러 | 새 수집(선택) | vCenter perf `net.droppedRx/Tx` · `errorsRx/Tx` | 통계 레벨에 따라 없을 수 있다 → ‘—’ |
| 화면 | 수정 | `HostDetail.jsx` 카드 2 · `SanSwitchTool.jsx` 보기 1 · 문구 모듈(순수) | STable · 백틱 금지 · uppercase 금지 · min-width:0 · Chromium 1440/400 · 도구 키 불변 |

### 4.4 단계 제안(컨펌 때 고를 것)
- **A 단계 — 새 수집 없이 가능**: 귀속 엔진 + D-① SAN 묶음 + D-③ 호스트 귀속 보기 + D-② 의 ‘포트 설명 일치’ 매칭 · 지금 있는 CVP 값(bps · 사용률 · 에러 · 이벤트). 추정 행이 많지만 전부 근거가 붙는다.
- **B 단계 — 새 수집**: 경로별 타깃 WWN(추정 → 확정 승격) · CVP MAC 테이블/LLDP(매칭 ‘높음/확정’) · CVP 드롭 카운터 · ESXi vmnic 드롭. 경로는 원문 표본으로 확인한 뒤 굳힌다.
- **C 단계 — 선택**: Brocade Flow Vision 플로우(초기자→타깃 측정값 · 라이선스 필요) · EndpointLocation.

## 5. 결정할 것(컨펌 질문)
1. ‘호스트 귀속’ 보기 위치 — `#/tools/san-switch` 보기 세그먼트(시안) vs 새 도구 키(권한 파일 · 카탈로그 PRESET 추가 필요).
2. B 단계 CVP 새 수집 범위 — MAC 테이블·LLDP·드롭 셋 다 vs MAC 테이블만.
3. 추정 분배 방식 — 타깃 포트 비율만(단순 · 설명 쉬움) vs IPF 보정(행합·열합 맞춤 · 테스트로 고정).
4. 호스트 상세 묶음 — 새 묶음 ‘SAN 경로·트래픽’ 추가(시안) vs 기존 ‘스토리지’ 카드 확장.

## 6. 정직 기록
- ‘지금 있음’ 은 2026-11-07 00:40~00:55 KST 에 저장소 코드를 읽어 확인했다(§2 위치). 실장비 SAN 스위치 · CVP 는 이 세션에 없다.
- CVP 새 수집 경로(`/Smash/bridging/status/smashFdbStatus` · `/Sysdb/l2discovery/lldp/status/…` · `inDiscards/outDiscards` · EndpointLocation)는 포탈 기존 CVP 수집과 같은 처지의 **추정 경로**다 — 구현 때 원문 표본으로 확인해야 한다.
- Cisco MDS 는 포탈 SAN 수집기가 미구현(`sanswitch/types.js implemented:false`)이라 시안은 Brocade 두 패브릭으로만 그렸다.
- 아트보드의 수치(24h 64.2/26.8 TB · 어레이 합계 412/171 TB 등)는 화면 간 합이 맞도록 만든 **가상값**이다.
- 시안 파일은 저장소 작업본(docs/design/san-cvp-traffic/)에만 썼고 커밋·푸시하지 않았다(읽기 전용 클론) — 구현 단계에서 브랜치에 함께 올린다.

## 7. 구현 기록(v2.920 — 기본값 A 단계)
- §5 의 기본값으로 구현했다: ① 위치 — `#/tools/san-switch` 안(시안의 '보기 세그먼트' 는 실제 화면에 없어 **헤더 버튼 '호스트 귀속' + 모달**, 법인 칩 선택을 범위로) ·
  ② CVP 는 지금 있는 값 + **포트 설명 일치**(LLDP · MAC 테이블 · discards 수집은 B 단계로 남김) · ③ 추정 분배는 **타깃 포트 바이트 비율만**(IPF 는 다음) · ④ 호스트 상세에 **새 묶음 'SAN 경로·트래픽'**(기존 '스토리지' 카드는 그대로).
- B 단계 가운데 **경로별 타깃 WWN** 은 같은 SOAP 경로라 비용이 없어 함께 넣었다(`hostcfg/parse.js parseMultipath` → `hcfg.mp.targets[{adapter,wwn,live,dead,luns}]` · 엣지 정제 화이트리스트).
  구버전 엣지가 보낸 `hcfg` 에는 `targets` 키가 없고 엔진은 그때 후보를 좁히지 않는다.
- 코드: 서버 `sanswitch/attribution.js`(순수) · `sanswitch/endpointKey.js`(perfDb 의 순수 판정 분리) · `perfDb.portBytesMulti` · `cvp/hostMatch.js`(순수) · `cvp/db.js portsByDesc` ·
  `routes/api/hostSan.js`(라우트 3) · 웹 `HostSanSection.jsx`·`hostSanText.js` · `HostNetCvp.jsx`·`hostNetText.js` · `tools/SanHostAttrib.jsx`·`sanHostAttribText.js` · `HostDetail.jsx`·`SanSwitchTool.jsx` 연결.
  회귀 `server/test/sanAttrib2920.test.js`(6) · vitest 3 파일. 규칙은 `docs/rules/sanswitch.md`·`cvp.md`·`web.md` v2.920 항목.
- 시안과 다른 점(정직 기록): 기간 바이트는 portperfshow 합산값이라 **읽기/쓰기로 나뉘지 않는다**(시안의 '24h 읽기 / 쓰기' KPI 는 '기간 전송 합' + '지금 읽기/쓰기' 로) ·
  포트 에러·HBA 포트 사용률 KPI 는 이번에 넣지 않았다(기존 SAN 도구 포트 상세에 있다) · 업링크 '드롭' 열은 수집 전이라 '—'.

## 8. B 단계 기록(2026-11-07 사용자 'B 진행 순차적으로 모두 단행' — 검증 표준 · 항목마다 릴리스)
- **B-① CVP 드롭 카운터 — v2.923**: 수집·저장·push·정제는 같은 날 다른 작업(리눅스 베어메탈 성능 3a)이 **v2.922 로 먼저 넣었다**(`inDrop/outDrop` · `in_drop/out_drop`).
  처음 만든 같은 기능의 두 번째 구현(`inDisc/outDisc`)은 main 과 겹쳐 버렸고(PR noainred/The.DVC#947 닫음), main 에 없던 **보여 주기**만 얹었다 —
  CVP 도구 포트 표 2곳 ‘드롭(수/송)’ 열 · 호스트 업링크 블록 ‘업링크 에러/드롭 · 최근 24시간’ · 데모 드롭. 필드 이름은 여전히 추정이다(원문 표본으로 확인).
- B-②(MAC 테이블·LLDP)는 베어메탈 성능 작업이 '③ LLDP · ④ MAC — 미구현' 으로 남긴 매핑 출처와 같다 — 판정은 `cvp/hostMatch.js` 하나로 두고 두 화면이 함께 쓴다.
- **B-② CVP LLDP 이웃 · MAC 테이블 — v2.924**: 부품 주기(30분)에 두 표를 읽어(경로 추정) 장비마다 최신 한 벌로 저장하고, 엣지는 바뀐 장비만 중앙으로 보낸다(중앙이 받았다고 답할 때만 보낸 것으로 친다).
  호스트 업링크 매칭이 LLDP(확정) · 물리 NIC MAC(높음) · VM MAC 비율(높음) · 포트 설명(보통) 순으로 근거를 고르고 근거 문장을 보여 준다. 데모는 법인 호스트를 leaf 포트에 붙여 근거가 보인다.
- **B-③ ESXi vmnic 드롭·에러 — v2.925**: 호스트 상세 ‘네트워크’ 카드 버튼으로 vCenter 실시간 통계(최근 1시간)를 vmnic 마다 읽고, 같은 1시간 CVP 업링크 드롭과 방향 짝으로 나란히 놓아
  ‘ESXi 쪽 · 스위치 쪽 · 양쪽 · 드롭 없음’ 을 판정한다(§4.2 ‘둘 다 있을 때만’). 결측이 섞인 0 · 매칭 포트 없음은 판정 보류. 주기 수집은 하지 않았다(고RTT vCenter 로그인 수를 늘리지 않게).

## 9. C 단계 시안(2026-11-07 12:13~ KST · Fable + Claude Design — 사용자 'C 단계 시안 만들어줘')

시안 캔버스: https://claude.ai/artifact/TJGrCnB5sVW4ma1FP4RbWg · 이 폴더의 `C1-HostSanPath` · `C1-SanAttribIpf` · `C2-FlowVision` · `C3-EndpointLoc` · `C4-DataMap` 5장이 캔버스와 같은 내용이다(포탈 룩 · 수치는 전부 가상값).

### 9.1 사용자 결정(12:24) 과 추가 질문(12:25)
① Flow Vision 라이선스 확인 방법 안내 ② 포탈이 플로우를 직접 만든다 ③ EndpointLocation 은 버튼 + 주기 둘 다 ④ IPF 보정 넣기.
추가 질문 "라이선스 없이 … WWN 정보와 조닝 정보 … 활용하면 구현할 수 있을 것 같은데?" → **그렇다 — 짝 후보와 포트 합은 A 단계가 이미 조닝·WWN 으로 낸다.** 짝별 *분배*만 남는데 그것은
(a) ESXi 경로별 카운터(vCenter perf `storagePath` 그룹 — 라이선스 불필요 · 실측 · 경로 이름에 타깃 WWN) (b) IPF 보정(추정) (c) Flow Vision(스위치 쪽 실측 · 라이선스) 중 하나다.
그래서 시안은 **(a)+(b) 를 기본(C-①)** 으로, Flow Vision 은 **라이선스가 있을 때만 쓰는 교차검증(C-②)** 으로 바꿨다.

### 9.2 아트보드
- **C-① HostSanPath** — 호스트 상세 ‘SAN 경로·트래픽’ 묶음에 경로별 실측 표(HBA · 타깃 WWN · 스토리지 · 경로 상태 · 지금/1시간/24h 읽기·쓰기 · 지연 · 근거) · KPI(실측 분배 · IPF 추정 · 교차검증 차이) · 분배 규칙 카드(실측 → 확정 → IPF → 분배 불가) · 라이선스 띠.
- **C-① SanAttribIpf** — SAN 도구 ‘호스트 귀속’ 모달에 분배 방식 세그먼트(실측 우선 → IPF / IPF 만 / 타깃 포트 비율) · IPF 수렴 카드(반복 · 행합/열합 잔차 · 기준) · 매트릭스에 행합(HBA 포트 Δ) · 열합(타깃 포트 Δ) · 일치 표시 · 스위치별 Fabric Vision 라이선스 띠.
- **C-② FlowVision** — 새 도구 키 `san-flow`(운영 작업 · admin · OTP 재인증 · 감사 · 엣지 대행 큐 = testRuns 패턴) · 스위치 라이선스/계정 권한 점검 표 · 플로우 만들기 폼(호스트 → HBA → 포트 → 존 안 타깃 · 접두 `dvc_` · 명령 미리보기) · 실행 로그 타임라인 · 결과 표(ESXi 실측 대비 차이).
- **C-③ EndpointLoc** — 호스트 상세 업링크 타일 근거 ‘확정(CVP 위치)’(BASIS_RANK 에 `endpoint` — LLDP 다음) · ‘CVP 위치 조회 · 지금’ 버튼 · VM 상세 ‘네트워크 위치(CVP)’ 카드(일치/불일치/응답 없음 — vMotion L-5 보완) · CVP 설정(주기 수집 켜기 · 주기당 상한 · 우선순위 · 지원 버전).
- **C-④ DataMap** — 화면 요소 ↔ 데이터(지금 있음/새 수집/계산) · 규약 · 위험 · 단계 제안(① C-① → ② C-③ → ③ C-②) · 컨펌 질문 5.

### 9.3 정직 기록
- ESXi `storagePath` 카운터의 인스턴스 이름 형식 · 통계 레벨은 **실장비로 확인하지 못했다**(추정). 못 읽으면 IPF 로 떨어진다.
- Flow Vision: `flow` 명령은 Fabric Vision 라이선스 필요 · `--create/--activate/--deactivate/--modify/--reset/--show/--delete` · 상한 128(스위치)/512(디렉터) · 포트당 모니터 64 — FOS 8.0.1 명령 참조(Dell/ManualOwl 미러) · Flow Vision 8.1 안내서(Lenovo 미러) 기준. REST 노출은 확인 못 함. 현장 rbash 계정은 `flow` 가 막혀 있을 수 있다(`fosParse.js:850` 의 다른 명령들이 그랬다).
- CVP EndpointLocation: `GET /api/resources/endpointlocation/v1/EndpointLocation?key.searchTerm=<MAC|IP>` · CVP 2021.1+ · GetAll 없음(단건) — aristanetworks.github.io cloudvision-apis 기준.
- Flow Vision 라이선스 확인 방법: 포탈 SAN 도구 장비 상세 ‘라이선스:’ 줄(REST `brocade-license/license` 또는 SSH `licenseshow`), 또는 스위치에서 `licenseshow` / `flow --show` 직접 실행. 스냅샷에 ‘Fabric Vision’ 이 없는 것과 못 읽은 것은 다르다.
- 이 절은 컨펌 전 시안 기록이다 — 구현은 컨펌 뒤 Opus 가 한다.

## 10. C 단계 구현 기록(2026-11-07 13:21~ KST · Opus — 사용자 '구현' · 선택: 셋 다 순차(C-① → C-③ → C-②) · 검증 표준 · 릴리스 마지막에 한 번 · 기본값대로)

- **C-① ESXi 경로 카운터 + IPF**(`server/src/storpath/` · `sanswitch/ipf.js` · `attribution.js`): 호스트 상세 ‘경로별 실측 · ESXi’ 표 · KPI ‘확정 + 실측 비율’ ·
  SAN 도구 ‘호스트 귀속’ 분배 방식(자동 = 실측 비율 → IPF → 타깃 포트 비율 / IPF / 포트 비율) · IPF 카드(패브릭 — 조닝 서명으로 묶어 코어-엣지도 한 문제로) · 라이선스 카드.
  - ⚠ 시안과 다른 점(정직): 시안은 경로 카운터를 실시간 20초 표본으로 그렸지만, 함대(658 호스트 · 고RTT)에서 응답 크기를 묶으려고 **한 시간마다 5분(표본 15개)** 만 읽는다
    (`STORPATH_REFRESH_MS` 기본 1시간 · 하한 15분 · `STORPATH_PER_CYCLE` 200 · `STORPATH_SAMPLES` 15). 비율만 실측이고 바이트 양은 스위치 포트 바이트(정확)에 곱한다.
    인스턴스 이름 형식(`fc.…-fc.…-naa…` · `vmhbaN:Cn:Tn:Ln`)은 실장비로 확인하지 못했다 — 못 읽으면 IPF 로 떨어진다.
- **C-③ CVP EndpointLocation**(`server/src/cvp/endpoint.js` · `endpointNow.js` · `epRequests.js` · `db.js ep_loc/ep_meta`): 부품 주기 200 MAC(호스트 NIC → 최근 이동 VM → 순환) +
  ‘CVP 위치 조회 · 지금’ 버튼(위임 CVP 는 엣지 요청 큐) · 근거 순위 `endpoint`(LLDP 다음 ‘확정’) · LLDP 와 다르면 둘 다 보여 줌 · VM 상세 ‘네트워크 위치(CVP)’ 카드.
  - 반증 1인 확정 H1 · M5 · L10 중 L-10(엣지 시각 원본을 따로 남기지 않음 — 수신 시각으로 자르기만)을 뺀 전부를 고쳤다(`test/cvpEpReview2934.test.js`). H-2(404 의미)는
    실장비 응답을 못 봐서 **본문으로 가르는 추정**이다 — 구체적 not found = 위치 없음 · ‘Not Found’ 한 마디는 답한 MAC 없이 8번 이어질 때만 미지원 · 본문 표본을 사유에 남긴다.
  - 데모 결함(화면 판독): 데모 VM vNIC MAC 이 사이트마다 같아(사이트 안 순번만) 다른 법인 CVP 위치로 덮였다 → 넷째 바이트에 사이트 번호.
- **C-② Flow Vision 플로우 모니터**(도구 키 `san-flow` · ‘운영 작업’ · `server/src/sanswitch/flowCmd.js` · `flowJobs.js` · `routes/api/sanFlow.js` · 웹 `SanFlowTool.jsx`):
  admin · 전체 범위 · 만들기 · 지우기는 본인 OTP 재인증 · 감사. 명령은 서버만 만든다(이름 `dvc_` · 포트 · WWN 화이트리스트) — 엣지는 정의만 받아 **다시 검사하고 직접 만든다**.
  서버가 포트 · zone 안 타깃을 귀속 엔진으로 다시 판정한다(미리보기와 만들기가 같은 `planCreate`). 상한 스위치 128 · 디렉터 512 · 포트당 모니터 64. 15분마다 `flow --show`.
  - 시안에서 뺀 것: ‘비활성화’(deactivate) 버튼 · 호스트 상세 / 호스트 귀속 표에 ‘실측(스위치 플로우)’ 줄 — 이번에는 SAN 플로우 모니터 화면의 ‘ESXi 실측 대비’ 칸에만 보인다.
  - ⚠ 문법 · 출력 형식 · 상한은 FOS 8.0.1 명령 참조 기준이고 실장비로 확인하지 못했다. 출력을 못 읽으면 0 이 아니라 ‘카운터 형식을 알아보지 못했습니다’ + 원문(작업 기록).
  - 반증 1인 확정 H2 · M7 · L11 을 전부 고쳤다(사용자 ‘전부 고침’). 가장 큰 둘: 플로우 이름이 FOS 20자 상한을 넘어 실장비 만들기가 거부될 수 있었다(→ 19자 이하) ·
    15분 주기가 인증 실패 정지를 보지 않아 비밀번호가 바뀐 스위치에 하루 96번 로그인할 수 있었다(→ 폴러와 같은 정지 기록). 이 과정에서 기존 SAN 스위치 쓰기 라우트 13개의 게이트도
    ‘조회 · 쓰기 모두 전체 범위’ 로 좁혔다(writeVcenters 를 둔 admin 은 이제 스위치 등록 · 수집 · 설정 변경을 할 수 없다 — 의도한 변경).
  - 화면 판독으로 고친 것: 400px 가로 넘침(작업 제목 · 버튼) · 같은 정의 중복 만들기 · 86줄 스위치 표 아래로 밀리던 폼 · 기록 · 결과(→ 표 위로 · 라이선스 필터 · 20대 상한).
