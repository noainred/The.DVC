# 랙 실장도(`server/src/rack/` · 라우트 `routes/api/rack.js` · 화면 `web/src/views/tools/RackTool.jsx`) 불변조건

설계: `docs/design/rack-elevation/README.md` · 조회 계정 가림 재설계 `docs/design/rack-mask-redesign/README.md`(2026-11-27 컨펌 — 안 B′ · 지금은 1단계 '닫기' 까지). 회귀: `test/rackLedger.test.js` · `test/rackRoutes.test.js` · `test/rackVersions.test.js` · `test/rackAudit1124.test.js`(2026-11-24 점검) · `test/rackPerf1126.test.js`(개선 1 · 2) · `test/rackGaps{Pure,Db,Routes,Head,Leak,R2x,R2sec,Refute,R3x}1126.test.js` · `test/rackGapsR3fix1126.test.js`(가림 순수 함수를 느린 기준 구현과 무작위 대조 포함) · `test/rackMaskMatrix1126.test.js`(가림 표기 행렬 × 응답 경로 — **가림 판정을 고치면 이 표에 표기를 더할 것**)(2026-11-26 점검 1~3회차) · `web/src/views/tools/{rackView,rackViewGaps1126}.test.js`.

- **원장은 중앙 한 곳**(2026-11-20 사용자 결정). 사람이 정한 위치만 저장한다 — 상태 · 온도 · 전력 측정값은 넣지 않고 화면을 그릴 때 수집 모듈에서 잇는다.
  계층은 법인(`datacenter/store.js` DataCenter = 법인 묶음) → 데이터센터(site · 물리) → 전산실 → 랙 → 배치. 법인 하나에 데이터센터가 여럿일 수 있다.
- **편집은 관리자만**(사용자 결정) — `requireRole('admin')` + `isAdminDetailUser` + 그 법인의 할당 vCenter **전부** 쓰기 범위. 조회 밖 404 → 쓰기 밖 403.
  할당 vCenter 가 없는 법인은 범위 계정에 보이지 않는다(귀속 없는 데이터 미노출). 랙 종류(전 법인 공용)는 `isFullReadWriteScope` 관리자만.
- **서버는 서비스 태그로만 잇는다**(2026-11-19 사용자 결정). 비교 키는 `insights/serialKey.js normKey` 하나(시리얼 색인과 같은 함수 — 사본 금지).
  서버 목록은 `scopeIdracServers` 로 먼저 자른다. 관리 주소는 관리자 판본만 · 시리얼은 관리자 또는 전체(조회) 범위 계정만 · 이력 작업자 계정명은 관리자만.
- **전산실 단위 쓰기는 rev 대조**(다르면 409 `revConflict` — 조용히 덮어쓰지 않는다) + 한 트랜잭션에 이력까지. 아래 자료가 남은 상위(데이터센터 · 전산실 · 랙 · 쓰는 랙이 있는 종류)는 지우지 않는다.
  랙 높이를 줄여 장비가 넘치면 거절한다. 옮기기는 같은 전산실 안에서만(다른 전산실 랙 id 는 404).
- **못 읽은 값은 0 이 아니다**: 높이를 모르면 1U 로 가정하지 않는다(입력 필수) · 비운 전력 · 무게는 null 이고 합계는 '몇 대 중 몇 대' 와 함께.
- **법인별 판(최근 30개 · 2026-11-20 사용자 선택 '판 30개 + 되돌리기' · 오래된 판은 지움)**: 변경마다 법인 원장 전체를 같은 트랜잭션에 판으로(판 저장이 실패하면 변경도 취소) ·
  판이 없는 법인은 열 때 기준 판 · 되돌리기 = 관리자 ∧ 법인 쓰기 범위 · 최신 판 id 대조(다르면 409) · 다른 법인 자료와 id 가 겹치면 거절 · 손상 판 거절 ·
  전산실 rev 는 새 값 = 전역 바닥값(`rack_meta.revFloor` — 지운 전산실의 rev) · 전 전산실 최댓값 중 큰 것 + 1(시각 아님 — 지웠다 되살린 전산실이 옛 rev 를 받지 않게) ·
  되돌리기도 새 판(되돌리기를 되돌릴 수 있다) · 되돌리기는 이력(rack_log)을 지우지 않는다 · 판이 없는 법인은 **첫 변경 전에도** 기준 판(`ensureBaseline`) ·
  판 압축 해제는 `SNAP_MAX_BYTES` 상한 + 실패 경고(내용 없이) · 차이 결과 캐시는 (법인, 판, 최신 판) 키 + 사본 반환 · 차이에는 시리얼 값을 싣지 않는다(필드 이름만). 판정은 `rack/versions.js`.
  회귀 `test/rackVersions.test.js`(변이 13건 전부 잡힘).
- 겹침 판정은 서버 `layout.js placementIssue` 가 진실 — 웹 `rackView.js` 는 끌어 놓는 동안 미리 보기만 하고, 두 판정은 `rackView.test.js` 가 같은 입력으로 대조한다.
- **2026-11-24 점검(5축 + 반증 1인 · 확정 25건)에서 고정한 것**: 랙 합계에는 **후면 전용 장비도** 든다(`rackTotals` 가 앞 · 뒤 같은 U 를 한 번만 센다 — 라우트에서 거르지 말 것) ·
  비관리자 판본은 IP 로 등록한 서버의 id · 이름을 `addressMatcher` 로 가리고(토큰 · '이름 가림') OS 호스트 이름은 관리자만 · 시리얼을 가리는 판본은 이름 속 서비스 태그도 `stripTag` ·
  법인 원장 개수 상한 = 판 검사 상한(`versions.js SNAP_CAPS` — 넘는 변경은 `saveVersion` 에서 409 `corpCap`) · 되돌리기 미리 보기와 실제는 같은 `restorableSnapshot` ·
  전산실 삭제도 이력을 지우지 않는다 · 전산실 없는 이력도 법인마다 2,000건 · 엑셀은 랙 `RACKS_PER_SHEET` 대씩 시트를 나누고 랙마다 양보(ExcelJS 병합이 시트마다 제곱 — 300랙 21초 정지 실측) ·
  감사 상세는 서버가 만든 id. 화면: 보이는 전산실 = **지금 고른 전산실의 응답만**(늦은 응답으로 보이지 않는 원장에 쓰지 않게) · 성공한 쓰기의 rev 즉시 반영 + 저장 중 놓기 거절 ·
  rev 충돌이면 창을 닫지 않는다 · 지우기는 확인 · 데이터가 있으면 새로 고침 실패는 배너.
- **판 저장 조각 캐시 · 시리얼 키 색인(2026-11-26 사용자 요청 '개선 제안 1, 2, 3')**: 판 재료는 `(전산실 id, rev)` 조각 캐시에서 — **랙 · 장비를 바꾸는 쓰기는 반드시 그 전산실 rev 를 올린다**
  (roomWrite · 되돌리기 — rev 를 올리지 않고 바꾸는 경로를 만들면 틀린 판이 저장된다) · 조각은 **COMMIT 뒤에만** 캐시에(`tx` — ROLLBACK 된 내용이 같은 rev 로 남지 않게) ·
  핸들을 열 때 · 닫을 때 비운다 · 판 모양은 여전히 `buildSnapshot` 하나. 시리얼 중복 · 놓인 키 집합은 `rack_place_key(key, place_id)` 색인에서 — 장비 행을 쓰는 곳
  (놓기 · 고치기 · 빼기 · 되돌리기)이 같은 트랜잭션에서 `setPlaceKeys` 로 맞추고, 색인이 없던 원장은 열 때 한 번 채운다(`rack_meta placeKeys`). 새 장비 쓰기 경로(엑셀 가져오기 등)도 `setPlaceKeys` 를 부를 것.
  자기 점검 `RACK_SELF_CHECK=1`(랙 테스트 전부가 켠다)은 캐시로 만든 판 · 색인 판정을 원장 훑기와 매번 대조해 다르면 던진다 — SQL 로 원장을 직접 고친 테스트는 `_resyncForTest()`.
  실측(장비 5,100대 법인 · 4 vCPU 컨테이너 · 중앙값): 전산실 10곳이면 옮기기 33 → 12ms · 시리얼 고치기 45 → 10ms, **전산실 1곳에 다 있으면** 36 → 32ms · 46 → 32ms(그 전산실을 통째로 다시 읽는다) ·
  판 크기 67 → 72KB(gzip 1단계) · `placedSerialKeys` 는 5ms 그대로. 미배치 서버 목록은 법인당 `UNPLACED_MAX` 대까지 싣고 화면이 검색어로 거른다(`rackView.js matchUnplaced`).
- **조회 계정 응답은 칸 목록 투영 · 가림 재료는 줄지 않는다(2026-11-27 · 사용자 컨펌 '안 B′ · 메모는 관리자 전용' · 6 · 7회차 점검 반영 — 상세 `docs/rules/rack.md` 2026-11-27 · 11-28 절)**:
  응답은 **적어 둔 칸만** 싣는다 — `rack/project.js`(데이터센터 · 전산실 · 랙 종류 · 랙 · 장비 · hw · 연결 정보 `projectLink` · 판 차이)와 라우트(전산실 응답 머리 · 이력 줄 · 판 머리). 행을 펼쳐 싣지 않는다.
  관리자만: 메모 · 등록부 서버 이름 · OS 호스트 이름 · 관리 주소 · 미배치 목록(그 밖에는 대수 + `unplacedListed:false`) · 되돌리기 미리 보기 · 작업자.
  가림을 거쳐: 표시 이름 · 모델 · 랙의 이름 · 줄 · 용도 · 전산실 · 데이터센터 · 랙 종류 이름(전 법인 시리얼로) · 판 차이의 이름 · 위치 글 · 연결 모델 · CPU 모델.
  장비가 답한 값(펌웨어 판 꼴 `firmwareLike` · 전원 상태 열거값)은 주소 꼴 판정에 넣지 않는다(펌웨어 '7.00.00.171' 이 IPv4 로 읽혔다). 시리얼 칸은 입력 · 출력 같은 판정(`layout.js serialAddressLike` + 등록 주소).
  ⚠ 시리얼 칸 입력의 '등록 주소' 거절은 **쓰는 사람이 볼 수 있는 서버로만**(`hostIndexOf(scopeIdracServers …)` — 함대 색인은 조회 ∧ 쓰기 전체 범위 관리자만). 함대 재료로 거절하면 범위 관리자의 다른 법인 등록 여부 오라클이 된다(7회차 S7-1).
  **가림 재료**(`rack/material.js` · `rack/db.js maskAbsorb`): 메모리 사본이 진실 · 파일(rack_mask_seen)은 응답 뒤에 따라간다(busy_timeout 0 · 실패 30초부터 두 배 · 상한 2분 · 종료 훅 `flushMaskOnExit`) ·
  흡수는 모든 길(조회 — 관리자 포함 · 쓰기 · 60초 주기 `startMaterialWatch` — 원장 파일이 있을 때만) · 범위 계정 요청은 인벤토리 태그까지 매번 ·
  색인은 **세대마다 한 번**(`materialIndex` — 조각 + 양보 · 진행 중 빌드 공유) · 기록을 못 읽으면 조회 계정에 **503**(`maskUnavailable`) ·
  잘못 들어간 값은 전체 범위 관리자가 지운다(`mask.forget` · 감사 · 지금 등록부 값은 건너뜀) · 상한(종류마다 20만)과 255자 넘는 주소는 메모리 몫(5만)에만 —
  넘칠 것이면 **넣기 전에** 비우고 그 흡수의 지금 값을 되돌린다(넣는 도중에 비우면 지금 값을 잃는다 — 7회차 P7-1) · 그래도 못 담으면 조회 계정 503 · 64자 넘는 태그는 재료가 아니다. 조각 읽기는 행 값 비교(SCAN 금지).
  재료를 요청 판본 · 범위로 줄이는 최적화 금지. 비교 키는 폭에 무관(`serialKeyOf` · 이름 중복 `nameTaken` · 이름 바꾸기 `renameVerdict` — 쌍둥이와 폭만 다르면 그대로) — 키 함수를 바꾸면 `RACK_META_VERSIONS` 를 올린다.
  연결 키 · 훑기 중복 판정은 저장된 serial_key 칸이 아니라 `serialKeyOf(serial)` 로 만든다(7회차 C8 — 키 다시 만들기가 실패하면 칸이 옛 키로 남는다).
  **새 칸을 응답에 더하려면** 등급을 적고 `test/rackKeyPaths1127.test.js`(중첩 키 경로 — 목록과 양쪽 대조 · 엣지 서버 자극) · `rackProject1127`(표식)을 함께 고친다. 회귀 `rackMaterial1127` · `rackFix1127` · `rackR6probe*` · `rackR7fix1127` · `rack*Mut1127`.
  변이 검증은 작업 트리가 아니라 **사본**에서(중단된 실행이 작업 트리에 변이를 남긴 일이 있다).
  ⚠ 판정 방식은 아직 '찾아 지우기' 다 — 표기를 바꾼 식별자(등록 주소의 첫 마디 · 구분자를 바꾼 IP)는 그대로 보인다(가림 집계 `mask-census` 가 센다). 통째 판정 + 사람의 결정은 다음 단계.
- **비관리자 판본의 가림 · 화면의 늦은 응답(2026-11-26 점검 1~4회차 — 상세 · 근거 · 대가는 `docs/rules/rack.md`, 고치기 전에 읽을 것)**:
  표시 이름(label)은 관리자가 공개한 이름이다 — 주소와 (시리얼을 가리는 판본에서) 시리얼 · 태그만 가린다. **가림은 `routes/api/rack.js textMaskOf` 하나가 정한다**(주소 먼저 → 태그 나중 · 재료는 범위로 자르기 전 등록부 전체 +
  인벤토리 태그 + 그 법인의 시리얼 기록 `rack_serial_seen`). 같은 가림이 표시 이름 · 모델 · 랙/전산실/데이터센터/랙 종류 이름 · 이력 · 판 목록 · 판 글 · 판 차이(이름 · 위치 글)에 닿는다(등록부 서버 이름은 2026-11-27 부터 조회 계정에 싣지 않는다 — 아래). 이력 · 판 행의 `tags` 와 판 차이의 `_tags` 는 응답으로 나가지 않는다(`versionDetail` 이 유일한 출구).
  경계 규칙은 `rack/textMask.js` 머리말: 낱말 경계 = 글자 갈래(라틴 글자 · 숫자 / 그 밖)가 바뀌는 자리 · 6자 미만 키는 낱말 통째(원문에 구분자가 있으면 같은 모양도) · 점 없는 등록 주소는 호스트 이름 낱말 통째.
  글 속 IP 는 라우트의 `hasIpv4` · `hasIpv6`(마디 묶음 · MAC 포함)로 — 다른 화면의 `addressMatcher`(식별자 칸용)를 글에 쓰지 않는다. **자리표시 태그는 가림 재료도 연결 키도 아니다**(`usableTag` — 비 ASCII 값은 예외).
  이름 정리(`layout.js cleanText`)는 유니코드 속성으로 지우고 가림 판정도 같은 글자를 지운 글로 본다(`dropInvisible`). 바뀐 것이 없는 저장은 rev · 판 · 이력 · 감사를 만들지 않는다(`unchanged: true`).
  화면: **판정은 `web/src/views/tools/rackView.js` 의 순수 함수에 둔다**(`spotVisible` · `lostViewReason` · `modalWithRoom` · `conflictHint` · `nameTarget` · `sameSpot` · `viewAfterLoadFail` · `viewAfterMove` · `changedFields`) — `RackTool.jsx` 안에 판단을 새로 쓰지 않는다
  (컴포넌트는 단위 테스트가 닿지 않는다 — `rackViewR4x1126.test.js` 가 함수와 **배선**을 함께 본다). 창은 연 때의 대상(전산실 · 데이터센터 · 법인)에 쓰고, 늦게 온 응답은 그 자리를 아직 보고 있을 때만 알림 · 선택 이동을 한다.
  '다시 불러오지 못한 화면' 표시는 화면 자료(`staleErr`)에 붙는다. 끌어 놓기는 랙 id 를 항상 보내고, 고치기 창은 달라진 칸만 보낸다.
  테스트: 가림 규칙을 바꾸면 `rackMaskMatrix1126.test.js` 에 행을 먼저 더한다 · 무작위 대조의 난수는 `Math.imul`(`seed * 1103515245` 는 쏠린다) · `RACK_SELF_CHECK=1`.
