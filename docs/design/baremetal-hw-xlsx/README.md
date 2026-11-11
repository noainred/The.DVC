# 설계: 베어메탈(물리서버) 하드웨어 정보 엑셀 내보내기

작성 2026-11-11 · 상태 **시안 — 컨펌 대기**(구현 전) · 시안 캔버스: https://claude.ai/artifact/E51be5ibsoDscW6Zq9xt5p
(아트보드 3장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 서버 이름·법인·수치는 모두 가상이고
색·글자는 `web/src/styles.css` 토큰과 `server/src/vcenter/vmXlsxStyle.js PAL`(머리글 `1E3A5F` · 줄무늬 `F6F8FB` · 테두리 `D4D8DE`) 그대로.
계정에 등록된 ‘Design System’ 아티팩트는 앞선 시안들과 같이 내용이 비어 있어 쓰지 않았다.)

## 1. 요구 (사용자 요청 2026-11-11)

- "물리서버로 분류된 서버의 hostname/CPU/memory/disk 등 하드웨어 정보를 excel 로 export 하는 기능 필요해, 클로드 디자인으로 초안 만들어서 보여줘"

## 2. 지금 있는 것(코드 근거)

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| ‘물리서버(베어메탈)’ 분류 — iDRAC/OME 물리 서버 가운데 ESXi 호스트로 확인되지 않은 것 + 수동 태그 | `server/src/insights/fleetInventory.js classifyFleet().bareMetal` | **대상 집합 그대로**(판정 복제 금지 — `bmusage/targets.js` 도 같은 집합을 쓴다) |
| 화면 — 특수 기능 › 통합 서버 인벤토리(`#/tools/fleet`) 베어메탈 탭 · CSV(화면 7열) | `web/src/views/tools/FleetInventory.jsx` | CSV 옆에 버튼 하나(시안 ①). CSV 는 그대로 |
| 하드웨어 인벤토리 — `system.hostName·model·manufacturer·serviceTag` · `cpu.model·count·cores` · `memory.totalGiB` · `cpus[]` · `memoryDimms[]` · `disks[]`(model·capacityGB·media·protocol) · `nics[]` · `gpus[]` · `bios.version` · `idrac.firmwareVersion` · `collectedAt` | `server/src/idrac/redfish.js:562~` · 저장 `idrac/invCache.js getInventory` | 엑셀 값의 출처. 내려받을 때 장비에 접속하지 않는다(저장값만) |
| 엣지 서버의 축약 인벤토리(시리얼 제외 · 같은 필드 대부분) | `server/src/collector/compactInv.js` · 중앙 `collector/remoteInventory.js` | 위임 법인 서버도 같은 열을 채운다(중앙 화면이 비지 않게). `system.manufacturer` 는 축약본에 없어 엣지 서버는 제조사 칸이 빈다 |
| 코어·메모리 산정(인벤토리 없으면 합계에 넣지 않고 개수만) | `server/src/idrac/physicalCapacity.js` | 서버 요약의 코어·메모리와 맨 위 합계 칸은 **이 함수**로 |
| 엑셀 서식·동시 1건·워커 | `vcenter/vmXlsxStyle.js` · `util/exportBusy.js` · `util/xlsxWorkerRun.js` · 선례 `vcenter/hostExportXlsx.js` · `gpu/allocTreeXlsx.js` | 같은 서식·가드 |
| 내보내기 창 선례(법인 칩 기본 전부 선택 · 시트 체크 · 파일 이름 미리보기) | `web/src/views/tools/GpuAllocExportModal.jsx` · `docs/design/gpu-alloc-corp-sheets` | 시안 ② 가 같은 틀 |

## 3. 시안

### ① 진입(`Main.dc.html`)
통합 서버 인벤토리 베어메탈 탭의 CSV 옆에 **‘하드웨어 정보 엑셀’** 버튼. 화면의 다른 부분은 바뀌지 않는다.

### ② 내보내기 창(`ExportModal.dc.html`)
- **법인(vCenter) 칩** — 기본 모두 선택 · ‘모두’·‘모두 해제’·‘화면 필터대로’. 칩마다 베어메탈 대수. ‘미지정’ 칩은 전체 범위 계정에만.
- 범위 글자 ‘베어메탈 N대(인벤토리 있음 n · 없음 m)’ — 값은 메타 API 가 준다(화면에서 더하지 않음). 고른 법인이 0 이면 버튼 잠금.
- **시트** — 서버 요약(항상) · CPU · 메모리(DIMM) · 디스크(기본 켬) · NIC · GPU(기본 끔) · 안내(항상).
- 값의 출처와 한계 4줄(저장값 · 물리 디스크 기준 · Hostname 미보고는 빈 칸 · 시리얼 미포함) · 서식 목록 · 파일 이름 `baremetal-hardware_<범위>_<YYYYMMDD-HHmm>.xlsx`.

### ③ 엑셀 파일(`Workbook.dc.html` — 시트 5장을 한 장에 펼침 · 상세 시트는 앞 8행만)
| 시트 | 한 줄 | 열 |
|---|---|---|
| 서버 요약 | 서버 1대 | 법인(vCenter) · 서버 · Hostname(OS) · 제조사 · 모델 · 서비스태그 · CPU 모델 · 소켓 · 코어(합계) · 메모리 GB · DIMM 수 · 디스크 수 · 디스크 합계 GB · 디스크 구성 · GPU · BIOS · BMC 펌웨어 · 수집원 · 인벤토리 시각 · 비고 |
| CPU | 소켓 1개 | 법인 · 서버 · Hostname · 서비스태그 · 소켓 · 모델 · 코어 |
| 메모리(DIMM) | DIMM 1개 | 법인 · 서버 · Hostname · 서비스태그 · 슬롯 · 크기 GB · 종류 · 속도 MHz · 제조사 · 부품번호 |
| 디스크 | 물리 디스크 1개 | 법인 · 서버 · Hostname · 서비스태그 · 디스크 · 모델 · 용량 GB · 매체 · 인터페이스 |
| 안내 | — | 대상 · 출처 · 열의 뜻 · 빈 칸의 뜻 · 인벤토리 없는 서버 목록 · 넣지 않는 것 · 범위·기준 시각 |

- 맨 위 요약 칸: 서버 · CPU 코어 합계 · 메모리 합계 · 물리 디스크 합계 · 인벤토리 없음(합계 제외).
- **인벤토리가 없는 서버도 서버 요약에 한 줄**(대수가 화면과 같게) — 하드웨어 칸은 비우고 비고에 사유. 숫자 칸은 **빈 칸**(0 아님 — `numOrNull` 규약).
- 머리글 고정 · 자동 필터 · 줄무늬 · 숫자 서식 · A4 가로 한 쪽 너비.

## 4. 한계 — 정직 기록

- **디스크는 iDRAC 이 보는 물리 디스크**다. RAID 뒤 가용 용량·OS 파일시스템 사용량은 이 파일에 없다(OS 계정 경로 `bmstor`·`bmusage` 는 등록된 서버에만 있어 열로 섞지 않았다).
- Hostname 은 iDRAC 이 OS 에서 받은 값(`system.hostName`)이라 보고하지 않는 서버가 있다 — 빈 칸 + 비고.
- OME 로만 잡힌 서버·수동 태그로 베어메탈이 된 ESXi 호스트(`serverId = host:<vc>:<name>`)는 `invCache` 인벤토리가 없다고 **추정**한다(`fleetInventory.js:294·315` 를 읽은 것 — 구현 때 실제 데이터로 확인). 후자는 vCenter 값(모델·코어·메모리)으로 채울 수 있는지도 구현 때 판단.
- 시안의 서버 수·코어·용량은 가상값이다. 운영 규모(베어메탈 대수 · DIMM/디스크 행 수 · 파일 크기 · 생성 시간)는 구현 뒤 측정해 보고한다.

## 5. 구현 메모(컨펌 뒤 Opus) — 손댈 곳(예상)

| 영역 | 파일 | 내용 |
|---|---|---|
| 서버 | `insights/bareMetalHwRows.js`(신규 · 순수) | `bareMetal` 행 + 인벤토리(로컬 `getInventory` · 원격 `findRemoteServer`) → 시트별 행. 코어·메모리는 `physicalCapacity` 함수로 |
| 서버 | `insights/bareMetalHwXlsx.js`(신규) | exceljs 문서(서식은 `vmXlsxStyle`) · 행이 많으면 워커 |
| 서버 | `routes/api/…`(`/insights/fleet/hardware.xlsx` · `/insights/fleet/hardware-meta`) | `requirePerm('insights')` · scope 교집합(범위 밖 법인·미지정 미노출) · `acquireExport` · 파일 이름 함수 공유 |
| 웹 | `FleetInventory.jsx` · `FleetHwExportModal.jsx`(신규) · 문구 모듈 | 버튼 · 창(법인 칩·시트 체크·메타) |
| 테스트 | `server/test/` · `web/src/views/tools/*.test.js` | 대상 = `bareMetal` 과 같은 집합 · 못 읽은 값은 빈 칸(0 아님) · 범위 계정 · 엣지 서버 행 · 시트 선택 · 파일 이름 |
| 문서 | `docs/rules/idrac-server.md` · `docs/API.md` 재생성 · 릴리스 노트 | |

## 6. 컨펌 때 정할 것(기본안은 굵게)

1. 대상 — **베어메탈만** / 가상화 호스트(ESXi)도 고를 수 있게.
2. 상세 시트 기본값 — **CPU·메모리·디스크 켬, NIC·GPU 끔** / 전부 켬 / 서버 요약만.
3. 시리얼 번호·iDRAC 주소 — **넣지 않음** / 관리자 판본에만 넣음(엣지 서버 시리얼은 축약 인벤토리에 없어 빈 칸).
4. 부품 상태(정상·주의·장애) 열 — **넣지 않음(사양 문서)** / 넣음(`partfault/classify` 판정 그대로).
5. 화면 표에도 CPU·메모리·디스크 열 추가 — **아니오** / 예.
6. OS 파일시스템 사용량(`bmstor`) 시트 — **아니오(별건)** / 예.
