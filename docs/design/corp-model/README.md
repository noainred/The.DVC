# 법인 모델 정정 — 법인 1 : 서비스 N · 서비스 1 = vCenter 1 + Bareos 1

사용자(2026-11-13): "1개의 법인에 2개 이상의 서비스가 존재하고, 1개의 서비스에 1개의 vcenter 와 1개의 bareos 가 존재할 수 있다, 따라서 1대의 법인에 다수의 vcenter 와 bareos 가 있는 것으로 수정해줘" · "그리고 기억해".
선택: 반영 범위 **전부(Bareos 묶음 포함)**. 순서: 조사(Opus · 이 문서) → 시안(Fable · Claude Design — 컨펌 대기) → 구현(Opus). 루트 CLAUDE.md 규칙은 같은 날 바꿨다(10-30 의 '1:1:1' 대체).

## 1. 조사 결과(읽기 전용 — 줄 번호는 조사 시점 · 상세 표는 조사 에이전트 보고)

- **이미 되는 것**: DataCenter 하나에 vCenter 여럿 배정(`datacenter/store.js` `assign:{vcenterId: datacenterId}` · 설정 › DataCenter(법인) 화면 'vCenter 수' 열) ·
  Bareos 'vCenter → Director 1 · Director → vCenter N'(`bareos/settings.js` 17행 — `directors[]` + `sites[].{vcenterId, directorId}`). Director 에는 DC 필드가 없다(법인 표시는 묶인 vCenter 의 DC 로 유도 가능 — 새 저장 필드 불필요).
- **범위(권한)에 DC 축이 없다** — `scope.vcenters` · `regions` · `writeVcenters` 뿐(`auth/scope.js`).
- **운영 데이터 확인 못 함** — 실제로 DC 하나에 vCenter 가 여럿 배정됐는지 · 법인당 엣지 수.

### [C] 판정이 틀려지는 곳(핵심)
| # | 위치 | 내용 |
|---|---|---|
| C1 | `idrac/serverByCorp.js` 179~185(귀속 ⑤) | DC 의 vCenter 가 **정확히 하나**일 때만 귀속(메인 직접 확인) — 둘 이상이면 물리 전용 서버가 '법인 미지정'. 판정 코어 하나라 아래가 모두 따라간다. 시험 `serverByCorp2583` 이 고정 |
| C2 | `idrac/corpAttribution.js` | 색인에 DC 귀속이 없다 — `idracServerVcOf` 범위 절단에서 귀속 '' 서버는 범위 계정에 숨는다 |
| C3 | `routes/api/overviewNsx.js` | 범위 계정은 자기 법인 물리서버가 0 으로 보일 수 있다 |
| C4 | `corpusage/build.js` | 법인별 사용량 '귀속 없음' |
| C5 | `bmusage/targets.js` 275~278 | 기본 설정(`includeUnassigned` 꺼짐)이면 사용률 수집 대상에서 빠짐 |
| C6 | `routes/api/svcInventory.js`(베어메탈 corp = vc) | '(법인 미지정)' · 물리서버 폴더에 못 넣음(재료 `dcOfServer` 는 이미 있음) |
| C7 | `bmfolders/build.js` 88~89 | 귀속만 DC 로 바꾸고 저장 키를 두면 기존 등록이 전부 mismatch — **C6 과 D1 은 한 릴리스에서** |
| C8 | `bareos/install/targets.js` | 설치 대상 행 = vCenter · 설치 위치 = 그 vCenter 를 수집하는 엣지 — 엣지 하나가 서비스 둘이면 두 행이 같은 노드(초기화 · 볼륨 삭제가 있는 기능 — 실제 결과 확인 못 함) |

### [D] 저장 키 이전
- D1 물리서버 폴더 `bm-folders.json corps[vcenterId]` · `rules[].corp` · `bm-folders-assign.json assign[].corp` — 같은 DC 두 vCenter 의 같은 경로 합침 · 법인당 폴더 상한 · DC 미배정 vCenter · assign 파일은 변경 감시 백업 밖(이전 전 사본).
- D2 서비스 인벤토리 `corps[vcenterId]` · 고정(조건부 — 베어메탈 corp 를 DC 로 올릴 때) · D3 `fleet-assign.json`(서비스 태그 → vCenter) · D4 bmusage vCenter 키(엣지 배포 키 `corps` — 혼재 버전) · D5(추정) bmstor OS 등록 `vcenterId` 'os-foreign'.

### [B] 묶음을 법인(DC)으로 올릴 곳(저장 그대로 · 표시 · 집계 · 메일)
Bareos 통합/법인별 현황 · 진행 현황판 · 설정 · 법인별 설정('법인' 고르기 = Director 목록) · 그룹 목록 · 복원 트리 루트 · 일일 요약 · 실패 알림 · 사전 점검 · 복원 검증 `perCorp`(단위 결정 필요 — 지금은 Director 마다) ·
호스트 · VM '법인별' · 법인별 사용량 · 개요 · fieldcheck · bmusage '법인당' 상한.

### [A] 로직 그대로(주석 · 문구만)
이미 DC 기준(storage/inspect · sanswitch 알림 · hostSan · cvp · analysisServers · bmstor/corp · guestdisk) · 서비스 단위라 맞음(svcInventory 백업 칸 · Bareos '같은 Director' 복원 제약 · DR · 그룹) · 엣지 → vCenter 여럿 허용(bmusage edgeCorpIndex · scanDatacenter).
'법인(vCenter)' 류 표기 파일 server+web 97개(개별 로직 전수 판정은 안 함).

## 2. 위험 · 결정 필요(시안에서 정할 것)
- R1 범위: DC 로만 귀속되는 물리서버 · DC 폴더 트리를 범위 계정에 보이는 규칙 — 'DC 의 vCenter 를 전부 가진 계정만' vs '하나라도' (뒤는 범위 밖 노출 방향 — 반증 대상).
- R2 데이터 손실: C6 만 바꾸면 폴더 등록이 화면에서 빠진다 · C8 초기화/볼륨 삭제.
- R3 엣지 계약: Bareos 묶음은 중앙 표시뿐 · bmusage `corps` 는 엣지 배포 키.
- R4 캐시 열쇠에 DC 배정 세대가 없다(bareosViews memo 등).
- R5 용어: 새 '서비스'(vCenter + Bareos)와 기존 '서비스 인벤토리'(응용 서비스)의 '서비스' 가 다르다 — 화면 용어를 정해야 한다.
- R6 시험 고정: `serverByCorp2583` · `collectorDc2972` · 웹 `overviewServerText`.

## 3. 확인 못 함
운영 DC 배정 상태 · 법인당 엣지 수 · C8 순차 설치 실제 결과 · 전력 귀속(`allMeasuredPower`)이 같은 ⑤ 를 쓰는지 · 엣지에서 귀속 ⑤ 경로 · Veeam 법인 묶음 · 97개 파일 개별 로직.
