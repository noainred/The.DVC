# 서비스 인벤토리(`servicemap/` · 라우트 `routes/api/svcInventory.js` · 도구 키 `svc-inventory`) 불변조건 — v2.887

> 설계·결정 기록은 `docs/design/service-map/README.md`. 사용자 선택: 시안 2(전역 카탈로그 globalId + 커버리지 매트릭스) · 1+2단계 전부.

- **판정 코어는 `resolve.js` 하나**(순수): 고정(pin) → vCenter 폴더 규칙(vmPlacement `/ERP/prod` 모양 · `/` 경계 · 가장 긴 접두 · 루트 규칙은 `/` 만) →
  스캔 엔트리 라벨(서비스명 또는 별칭) → vSphere 태그(전역 카테고리 + 법인 켬일 때만 · 태그 못 읽음 = unchecked, 미지정과 다르다) → 이름 규칙(접두·접미·포함, 정규식 아님) → 미지정.
  **서비스는 자동으로 만들지 않는다** — 규칙 값에 맞는 서비스가 없으면 '매핑 안 된 값' 큐로 보낸다. 판정은 구성원당 1회, 결과 Map 을 표·큐·전역이 공유한다.
- **집계는 `corpusage/build.js` 의 `emptyAgg/addAgg/finishAgg` 를 그대로 쓴다**(가중 사용률 = Σ(사용률×용량)÷Σ용량 · 꺼진 VM 제외 · 못 읽음·오래됨·용량 없음은 따로 센다).
  같은 입력이면 법인 사용률 화면과 같은 값이어야 한다 — 복제 판정 금지.
- **저장소(`store.js`)**: 메모리가 진실 · 200ms 디바운스 원자 쓰기 · rev 단조 증가. 파일이 손상이면 **빈 트리로 시작하지 않고** 503 + 쓰기 차단,
  초기화(`store.reset`)는 전체 범위 관리자만이고 손상본을 보존한다(`preserveCorrupt`). 비밀은 싣지 않는다.
- **범위**: 조회는 `scopedVcenterIds` 교집합이 요청 필터보다 먼저 · 법인 대상 쓰기는 `corpWriteAccess`(모르는 법인·조회 밖 404 → 쓰기 밖 403, writeVcenters 미설정 = 조회 범위) ·
  전역 카탈로그·태그 카테고리·초기화는 전체 범위 관리자(`FLEET_OPS`). 법인 미지정 구성원은 범위 계정에 싣지 않는다. 응답 캐시는 범위·쓰기 범위·관리자·저장소 rev 를 키에 넣는다.
  비관리자 판본에는 스캔 엔트리 대역(CIDR)·주소 모양 BM 이름을 싣지 않는다.
- **고정**: 법인이 있는 구성원만(법인 없는 서버는 통합 서버 인벤토리에서 법인을 먼저 정한다). 자동 판정과 다르면 드리프트 큐. 법인이 바뀌면 무시(pinMismatch).
  '고정 유지'(`pins.review`)는 그 순간의 자동 판정을 `reviewedAuto` 로 저장하고 **그와 같은 드리프트만** 가린다 — 자동 판정이 다른 서비스로 바뀌면 다시 묻는다.
  `reviewedAuto` 가 없는 옛 표지는 같다고 보지 않는다(5차 반증 R8 — 예전에는 검토 한 번이 이후 모든 드리프트를 숨겼다).
  화면은 '고정 유지' 에 **자기가 본 자동 판정(`expectAuto`)** 을 보내고, 지금 판정과 다르면 서버가 409 로 막는다(사람이 보지 못한 새 드리프트를 숨기지 않게 — 1차 반증 3).
  '불필요한 고정 지우기' 는 `onlyIfRedundant` — 지금도 고정 = 자동 판정인 키만 지운다(1차 반증 8).
  고정 파일(`service-map-pins.json`)은 **설정 변경 감시 밖**(`backup/service.js CHANGE_WATCH_EXCLUDE` — 번들에는 들어간다). 빼면 고정 한 번이 '설정 변경' 백업을 만든다(R1).
  유령 키는 그 법인을 못 읽었거나 베어메탈 출처를 못 읽었으면 **판정 보류**로 따로 둔다(지우지 않는다).
- **등록 해제된 vCenter** = **스냅샷에도 등록부(vcenters.json)에도 없는** 법인 키: 법인 행 `orphan` · 쓰기 버튼 잠금(`writable:false` — 법인 쓰기는 `corpWriteAccess` 404) · 그 법인 고정은 유령이 아니라 `orphaned`.
  지우는 길은 전체 범위 관리자 `corp.purge`(dry 로 개수 먼저 · `expect` 개수가 다르면 409) 하나다(5차 반증 R2). **스냅샷만 보지 말 것** — 등록 직후 스냅샷 갱신 전·mock 데이터 소스에서
  등록된 vCenter 를 지웠다(5차 1차 반증 1 — 재현). 스냅샷이나 등록부가 비었거나 못 읽으면 아무것도 orphan 으로 보지 않고 purge 는 409(fail-closed).
- **별칭 ↔ 서비스명**: 판정은 서비스명을 별칭보다 먼저 본다 — 다른 서비스 이름과 같은 별칭, 다른 서비스 별칭과 같은 서비스명은 409(R4). 검사는 이름이 실제로 바뀔 때만 하고,
  옛 이름이 다른 서비스의 별칭이기도 하면(검사 전 옛 데이터) 개명을 409 로 막는다 — 그 별칭이 살아나 구성원이 조용히 옮겨 간다(1차 반증 4·5). 개명은 옛 이름으로 걸리던 대수(`stat.byName`)를
  화면이 보이고 사람이 고른 종류만 `keepAlias` 로 별칭을 남긴다(R3 — 자동으로 쌓지 않는다).
- **백업 칸은 법인 Director 매핑(`bareos.json sites[].vcenterId`) ∪ 원장에 잡이 있는 법인 기준** — 그 밖의 법인 VM 은 `undefined`(해당 없음, `stat.backup.na`). 함대 잡 수로 판단하지 않는다(M1).
  설정 손상은 `settingsLoadError()` 로만 안다(`loadSettings` 는 던지지 않는다) — 손상이면 모름(null)이지 해당 없음이 아니다(1차 반증 2). 범위 계정 `meta.backup` 은 자기 법인 기준(`backupMetaFor`).
- **키**: VM = `iu:<vcenterId>:<instanceUuid>`(없으면 `vm:<moref id>`) · 베어메탈 = `st:<서비스태그>`(없으면 `fl:<fleetId sha1 16자>` — 주소 원문을 키에 싣지 않는다).
- **의존 방향**: 도메인 모듈(`servicemap/*`)은 `routes/` 를 import 하지 않는다(arch 테스트) — 스냅샷·fleet·장애·백업 입력 수집은 라우트 층에서 한다.
- **판정 결과 memo(`inventoryFor`)**: 키 = 스냅샷 세대 · 저장소 rev · 입력 세대(gather 시각 · inputRev) · 알려진 법인 · 범위 · 관리자 판본(12초 · 4개). 판정에 새 입력을 더하면
  **그 입력이 바뀔 때 키도 바뀌는지** 먼저 답할 것(5차 2차 M10/R5). 읽기 경로는 깊게 동결한 참조(`peekMap`·`peekPins`)만 쓰고 고치지 않는다 — 고치면 던진다.
- **입력 다시 읽기**(`?fresh=1`): 쓰기 계정 · 프로세스당 `FRESH_MIN_MS` 한 번(429) — 화면은 `meta.limits.freshMinMs` 로 안내한다(숫자를 박지 않는다).
- **스캔 엔트리 id 는 세 경로**: 등록부 `scanRangeId` · 엣지 push(`fleetPush` → `central/fleet.js` — 필드 없음 = null) · 수집 서버 pull(`collector/agent.js buildExport` →
  `remoteInventory.js SERVER_STR_KEYS` — 필드 없음 = 구버전). 판정은 `scanInfoOf` 하나(모르는 엔트리 · 구버전 · 수동 등록을 나눈다 — R6·R18).
- **라우트(`routes/api/svcInventory.js`)·이 폴더를 고치면 커밋 전에 `node scripts/api-doc.mjs` · `node scripts/arch-doc.mjs`** — 줄 번호가 바뀌어 `apiDoc2563`·`audit2613h` 가 깨진다(v2.887·v2.890 두 번 전량 verify 에서 처음 잡혔다).
- 회귀: `server/test/svcInventory2887.test.js` · `server/test/svcInventoryReview5.test.js`(5차 검토 1차 — 수정 전 코드에서 10/10 실패 확인) · `svcInventoryReview5b.test.js`(2차) · 웹 `web/src/views/tools/svcInventoryText.test.js`.
