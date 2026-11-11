# 설계: 서버 하드웨어 정보 내보내기(물리 · 가상화 · 값 선택 · 엑셀/CSV · 서버별 사양서)

작성 2026-11-11 · 상태 **구현됨 v2.966.0**(컨펌 2026-11-11 '기본안대로 구현해' · 기본안 7가지 · 표준 검증) · 시안 캔버스: https://claude.ai/artifact/E51be5ibsoDscW6Zq9xt5p
(아트보드 4장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 서버 이름·법인·수치·펌웨어 버전·MAC·IP 는 모두 가상이고
색·글자는 `web/src/styles.css` 토큰과 `server/src/vcenter/vmXlsxStyle.js PAL`(머리글 `1E3A5F` · 줄무늬 `F6F8FB` · 테두리 `D4D8DE`) 그대로.
계정에 등록된 ‘Design System’ 아티팩트는 내용이 비어 있어 쓰지 않았다.)

로컬 렌더 확인(2026-11-11): `docs/design/server-temp/support.js` 런타임 + npm 의 react 18.3.1 · @babel/standalone 사본을 Playwright 라우팅으로 끼워
②③④ 를 Chromium 으로 렌더해 스크린샷을 직접 봤다(②는 칩 클릭 뒤 상태도). 글꼴(Inter · Noto Sans KR)은 로컬에서 막혀 대체 글꼴로 본 것이다 —
캔버스의 실제 글꼴 폭과는 조금 다를 수 있다. ①은 문구만 바꿔 다시 보지 않았다.

## 1. 요구 (사용자 요청 2026-11-11 — 원문)

1. "물리서버로 분류된 서버의 hostname/CPU/memory/disk 등 하드웨어 정보를 excel 로 export 하는 기능 필요해, 클로드 디자인으로 초안 만들어서 보여줘"
2. "3번 시안이 잘 안보여, 다시 그려줘" → 탭·가로 스크롤을 없애고 시트를 펼친 판으로.
3. "export 할때 어떤 값들을 선택해서 export 할것인지 선택하는 기능 csv, excel 선택하는 기능, 상단에 어떤 법인의 장비인지 보여주는 기능 추가,
   법인의 물리서버만, 가상화 서버만, 둘다, 선택해서 export 하는 기능 추가, 서버의 모든 인터페이스의 속도, 펌웨어 등 idarc 에서 수집하는 모든 정보를 선택해서 epoxrt 하는 기능 추가해서 시안 만들어줘"
4. "추가적으로 서버 1대의 사양을 최대한 자세하게 볼 수 있는 정보를 sheet 1장에 서버 1대 표시하는 기능도 추가해줘"

## 2. 지금 있는 것(코드 근거)

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| 물리(베어메탈) · 가상화 호스트 분류 | `server/src/insights/fleetInventory.js classifyFleet()` → `bareMetal` · `virtualizationHosts`(`idracBacked`) | **대상 집합 · ‘구분’ 열 그대로**(판정 복제 금지) |
| 화면 — 특수 기능 › 통합 서버 인벤토리(`#/tools/fleet`) 두 탭 · CSV(화면 7열) | `web/src/views/tools/FleetInventory.jsx` | CSV 옆에 버튼 하나(시안 ①). 기존 CSV 는 그대로 |
| iDRAC 인벤토리 — `system`(hostName·model·manufacturer·serviceTag·assetTag·uuid·powerState) · `cpu`·`cpus[]` · `memory`·`memoryDimms[]` · `disks[]` · `storageControllers[]` · `nics[]`(어댑터 firmware · 포트 id·link·speedMbps·mac) · `firmware[]` · `gpus[]` · `psus[]`·`powerCap` · `pcie[]` · `bios`(주요 항목) · `boot` · `idrac`(firmwareVersion·model) · `network[]`(iDRAC 호스트·FQDN·MAC·IPv4) · `licenses[]` · `health` · `collections`(읽음/실패) | `server/src/idrac/redfish.js:562~968` · 저장 `idrac/invCache.js` | ‘내보낼 값’ 묶음 13개의 출처. 내려받을 때 장비에 접속하지 않는다 |
| 엣지 서버의 축약 인벤토리 | `server/src/collector/compactInv.js` | 위임 법인 서버도 같은 열. **축약본에 없는 값**(제조사·UUID·자산 태그·스레드·어댑터/PSU/PCIe 펌웨어·BIOS 설정·iDRAC 네트워크·라이선스·부팅)은 엣지 서버에서 빈 칸 — 채우려면 `compactInv` 와 중앙 `remoteInventory INV_SHAPE` 를 **둘 다** 넓혀야 한다(구현 범위에 넣을지 컨펌 항목) |
| 코어·메모리 산정 | `server/src/idrac/physicalCapacity.js` | 요약 열·띠 소계·합계 칸은 이 함수로 |
| 주소 가림(관리자 판본) | `auth/addressMask.js` · `auth/demoGuest.js isAdminDetailUser` | iDRAC 주소·MAC 칩/열은 관리자만 |
| 엑셀 서식·시트 이름·내부 링크·동시 1건·워커 | `vcenter/vmXlsxStyle.js` · `gpu/allocTreeXlsx.js corpSheetNames` · `util/xlsxInternalLink.js` · `util/exportBusy.js` · `util/xlsxWorkerRun.js` | 같은 서식·가드 |
| CSV 셀 이스케이프(수식 주입 방지) | `web/src/util/csv.js` · 서버 쪽 선례 | CSV 형식에도 같은 처리 |

## 3. 시안

### ① 진입(`Main.dc.html`)
통합 서버 인벤토리의 CSV 옆에 **‘하드웨어 정보 내보내기’** 버튼. 두 탭 어디서 눌러도 같은 창(연 탭이 대상 기본값).

### ② 내보내기 창(`ExportModal.dc.html` — 눌러 볼 수 있음)
| 칸 | 내용 |
|---|---|
| ① 파일 형식 | **엑셀(.xlsx)** / CSV. CSV 는 표마다 파일 하나, 여러 개면 ZIP |
| ② 대상 서버 | **물리서버만** / 가상화 서버만 / 둘 다(대수 표시). 가상화 서버는 iDRAC 받침이 있어야 부품 값이 채워진다(없으면 vCenter 의 모델·코어·메모리 + 비고) |
| ③ 법인(vCenter) | 칩(기본 모두) · ‘모두’·‘모두 해제’·‘화면 필터대로’ · 0곳이면 버튼 잠금. ‘미지정’ 은 전체 범위 계정에만 |
| ④ 법인 표시 | **띠로 묶기**(맨 위 ‘포함된 법인’ 줄 + 법인이 바뀔 때 띠) / 법인마다 시트(파일) / 법인 열만 |
| ⑤ 내보낼 값 | 묶음 13개(기본 식별 · CPU · 메모리 · 디스크 · 스토리지 컨트롤러 · 네트워크 인터페이스 · 펌웨어 · GPU · 전원 · PCIe · BIOS·부팅 · iDRAC 관리 · 상태)의 값 칩. **요약 열** 칩 = 서버 요약의 열, **상세** 칩 = 부품 한 개가 한 줄인 시트(파일). 묶음 버튼 ‘기본’·‘하드웨어 전체’·‘네트워크 · 펌웨어’·‘모두’·‘모두 빼기’. 잠긴 칩(법인·구분·서버·Hostname·서비스태그)은 항상 포함 |
| ⑥ 서버별 사양서 | 서버 한 대 = 시트 한 장(+ 목차). 엑셀에서만. 시트 수 상한은 서버가 알려 주고, 넘으면 법인마다 파일을 나눠 ZIP |
| 아래 | ‘서버 N대 · 요약 열 N개 · 시트 N장’ · 파일 이름 `server-hardware_<대상>_<범위>_<YYYYMMDD-HHmm>.<xlsx\|csv\|zip>` |

고를 수 없는 것: iDRAC 사용자 계정 목록(`idracUsers`) · 이벤트 로그(`events`) · 시리얼 번호 · 접속 계정.

### ③ 내려받은 파일(`Workbook.dc.html`)
대상 ‘둘 다’ · 띠로 묶기 · ‘네트워크 · 펌웨어’ 묶음의 예. 서버 요약(포함된 법인 줄 · 합계 칸 6개 · 법인 띠 · 구분 열) + NIC(포트 한 개 = 한 줄) + 펌웨어(구성요소 한 개 = 한 줄) + 메모리 · 디스크 + CSV(ZIP 구성과 첫 줄들) + ‘고른 것에 따라 파일이 어떻게 달라지나’ 표.

### ④ 서버별 사양서(`SpecSheet.dc.html`)
맨 위 띠(법인 · 구분 · 모델·서비스태그 · 인벤토리 시각) + 13구역(기본 식별 · 요약 · CPU · 스토리지 컨트롤러 · 메모리 DIMM 전부 · 디스크 전부 · NIC 포트 전부 · 펌웨어 · 전원 · PCIe · BIOS·부팅 · iDRAC 관리 · 상태). ⑤ 의 값 선택과 무관하게 수집된 사양 전부(관리자 전용 값 제외).
장착되지 않은 것은 ‘없음’, 읽지 못한 것은 ‘읽지 못함’(`inv.collections` 로 가른다). 시트 이름 = 서버 이름(31자·금지 문자·겹침 `~2`), 목차에서 링크.

## 4. 한계 — 정직 기록

- **디스크는 iDRAC 이 보는 물리 디스크**다. RAID 뒤 가용 용량·OS 파일시스템 사용량은 없다.
- Hostname 은 iDRAC 이 OS 에서 받은 값이라 보고하지 않는 서버는 빈 칸 + 비고.
- **띠는 필터·정렬을 깬다**(데이터 줄 사이에 띠 줄이 낀다) — 그래서 ‘법인 열만’ 을 따로 뒀다. 띠 판본에는 자동 필터를 걸지 않는 쪽이 안전하다(구현 때 확정).
- **서버별 사양서는 시트가 서버 수만큼** 생긴다 — 운영 규모(호스트 약 658 + 베어메탈)에서 한 파일의 시트 수·크기·생성 시간은 **측정하지 않았다**. 상한·분할 기준은 구현 때 측정해서 정하고 화면에는 API 값으로 보인다.
- OME 로만 잡힌 서버·수동 태그로 베어메탈이 된 ESXi 호스트는 `invCache` 인벤토리가 없다고 **추정**(`fleetInventory.js:294·315` 를 읽은 것 — 구현 때 실제 데이터로 확인).
- BIOS 설정은 `redfish.js` 가 고른 주요 항목만 저장한다(전체 속성 아님). 시안의 항목 이름 4개는 예시다 — 실제 curated 키 목록은 구현 때 코드에서 가져온다.
- ‘상태’ 묶음은 수집 시점의 Redfish 글자다. 판정(정상·주의·장애)을 새로 만들지 않는다 — 쓰려면 `partfault/classify` 판정 그대로.
- 시안의 대수·코어·용량·버전은 가상값이다.

## 5. 구현 메모(컨펌 뒤 Opus) — 손댈 곳(예상)

| 영역 | 파일 | 내용 |
|---|---|---|
| 서버 | `insights/hwExportCatalog.js`(신규 · 순수) | 묶음·값 카탈로그(key 고정 · 요약/상세 · 관리자 전용 · 잠금) — 웹 창과 서버가 같은 목록(웹 사본이면 테스트가 대조) |
| 서버 | `insights/hwExportRows.js`(신규 · 순수) | 대상(물리/가상화/둘 다) + 인벤토리(로컬 `getInventory` · 원격 `findRemoteServer`) → 서버 요약 행 · 상세 행 · 사양서 구역. 못 읽은 값은 null |
| 서버 | `insights/hwExportXlsx.js` · `hwExportCsv.js`(신규) | 엑셀(띠·법인별 시트·사양서·목차 링크·워커) · CSV(표마다 파일 · ZIP) |
| 서버 | `routes/api/…` `/insights/fleet/hardware-meta` · `/insights/fleet/hardware.(xlsx\|csv\|zip)` | `requirePerm('insights')` · scope 교집합 · 관리자 전용 값은 `isAdminDetailUser` · `acquireExport` · 값 key 화이트리스트 검증 |
| 웹 | `FleetInventory.jsx` · `FleetHwExportModal.jsx`(신규) · 문구 모듈 | 버튼 · 창 · 값 조합 기억(계정별 — `ui-settings` 또는 localStorage, 구현 때 결정) |
| (선택) 엣지 | `collector/compactInv.js` + `collector/remoteInventory.js INV_SHAPE` | 엣지 서버에서 비는 값을 채우려면 양쪽 동시 확장(컨펌 3) |
| 테스트 · 문서 | `server/test/` · `web/src/views/tools/*.test.js` · `docs/rules/idrac-server.md` · `docs/API.md` · 릴리스 노트 | 대상 집합 일치 · null ≠ 0 · 범위 계정 · 관리자 전용 값 가림 · 값 선택 → 열/시트 · 띠 소계 · 시트 이름 규칙 · CSV 이스케이프 |

## 6. 컨펌 때 정할 것(기본안은 굵게)

1. 창의 기본값 — 형식 **엑셀** · 대상 **연 탭(베어메탈 탭이면 물리서버만)** · 법인 **모두** · 법인 표시 **띠로 묶기** · 값 **‘기본’ 묶음** · 사양서 **끔**.
2. 서버별 사양서의 내용 — **수집된 사양 전부**(값 선택과 무관) / ⑤ 에서 고른 묶음만.
3. 엣지 서버에서 비는 값(제조사·어댑터 펌웨어·BIOS 설정·iDRAC 네트워크 등) — **이번에는 빈 칸으로 두고 안내에 적음** / 엣지 축약 인벤토리를 넓혀 채움(엣지·중앙 동시 변경 · 엣지 업그레이드 뒤부터 채워짐).
4. iDRAC 주소 · MAC — **관리자 계정에만** / 아예 넣지 않음.
5. 시리얼 번호 — **넣지 않음** / 관리자 판본에만(엣지 서버는 축약본에 없어 빈 칸).
6. 값 조합 기억 — **계정마다 기억** / 매번 기본값.
7. 화면 표에도 CPU·메모리·디스크 열 추가 — **아니오** / 예.
