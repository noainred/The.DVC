# 물리서버 점검(`bmcheck/` · 라우트 `routes/api/bmFolders.js` `/tools/bm-folders/check` · `routes/admin/bmAssets.js`) 불변조건 — v3.45

> 설계 · 시안 · 결정 기록은 `docs/design/bm-feature-proposals/README.md`(① 보증 · 계약 만료 ② 펌웨어 기준선 ③ BIOS 설정 편차 — 사용자 선택 ‘시안 그대로 · 엣지 서버까지’).
> 화면은 물리서버 상세 드로어의 구역 + 목록 칩(`web/src/views/tools/bmFolders/{checkText.js,CheckSections.jsx,AssetLedger.jsx}`).

- **새 수집이 없다.** 펌웨어 · BIOS 는 이미 읽는 iDRAC 인벤토리(`inv.firmware` · `inv.bios.attributes` — `idrac/biosKeys.js` 목록만), 보증은 관리자가 올린 자산 원장(CSV)에서만 온다.
  포탈은 제조사에 조회하지 않는다. 입력은 물리서버 폴더 목록과 **같은 것**(같은 구성원 · 같은 배치 · `hwLookupFactory`) — 판정용 수집 · 캐시를 따로 만들지 않는다(`state.js bmCheckFor`).
- **판정 코어는 순수 함수 넷**: `fw.js judgeFirmware` · `bios.js judgeBios` · `warranty.js warrantyOf` · `util/majority.js majorityOf`. 화면은 상태 코드를 글자로 옮기기만 한다(웹 `checkText.js` — 판정 복제 금지).
- **못 읽은 것 · 판정하지 않은 것은 정상에도 문제에도 넣지 않고 따로 둔다**: 보증 `unknown`(원장에 없음 · 만료일 없음) · 펌웨어 `unread`(목록 없음 — `fetchFirmwareInventory` 는 실패해도 `[]` 라 빈 목록 = 못 읽음) ·
  `unsent`(엣지가 보내지 않음) · `none`(기준 없음) · BIOS `unplaced`(미분류) · `none`(견줄 서버 없음) · 행 `tie`(다수 없음) · `mixed`(한 서버 안에서 같은 부품의 버전이 갈림).
  저장소 파일을 못 읽었으면 그 판정 **키 자체를 싣지 않는다**(`checkInputs` — 빈 원장으로 보고 전부 ‘모름’ 이라 하지 않는다 · 지정 기준이 없다고 하지 않고 ‘다수 버전으로만 대조’ 표지).
- **묶음은 법인을 넘지 않는다**(펌웨어 = 법인 · 모델 / BIOS = 법인 · 폴더 · 모델). 그래서 그 계정에 보이는 구성원만 넣어 판정해도 결과가 같고, 범위 계정의 판정 · 다수 대수에 다른 법인 서버의 값이 들어가지 않는다.
  묶음을 법인 밖으로 넓히려면(함대 다수 버전 등) 범위 계정 응답에 다른 법인의 버전 · 대수가 실리는지 먼저 볼 것. 관리자 지정 기준만 전 법인 공통이다(전체 범위 관리자가 정한 값).
- **다수 = 유일한 최다 값 · 2대 이상**(동률 · 1대는 다수가 아니다 — 어느 쪽이 옳다고 말하지 않는다). ‘뒤처짐’ 은 기준과 다르다는 뜻이지 올려야 한다는 판정이 아니고, ‘다수 값’ 은 옳다는 뜻이 아니다 — 문구가 그렇게 쓴다.
  기준보다 **높은** 버전은 뒤처짐이 아니다(`ahead`). 숫자 . 꼴이 아닌 버전은 순서를 지어내지 않는다(`differ` — `util/cmpVersion.js` 가 null).
- **구성요소 열쇠 = 종류 | 정규화한 이름**(`fwLabelOf` — 끝의 MAC/WWN · 공백/점으로 나뉜 3자리 이하 숫자 토큰을 걷어 낸다). 디스크 · `FW_TYPES` 밖 종류는 대조하지 않고 개수만(`skipped`).
  이름은 장비 · 엣지가 준 글자다 — **길이를 먼저 자르고 선형으로만** 본다(앵커 없는 무제한 반복 금지).
- **엣지 계약(v3.45)**: `agent/fleetPush.js` 가 베어메탈 항목에 `fw`(`{ c:[{ t, n, v, x? }], s }` — 서버당 40) · `bios`(아는 키만)를 싣고, 중앙 `central/fleet.js` 가 **검증된 이름(개별 토큰)만** `sanitizeFwPush` · `sanitizeBiosPush` 로 받는다
  (아는 종류 · 키만 · 글자만 · 상한 · 이름은 중앙이 다시 정규화). 인벤토리가 없으면 엣지는 **키를 만들지 않는다**(없음으로 올리지 않는다) → 중앙 `unsent`. 분류 서명(`hashList`)에는 넣지 않는다(hw 와 같다).
  새 필드를 더하면 보내는 쪽 · 중앙 정제 · `getEdgeFleetServers` 세 곳을 함께 고친다. MAC · 주소 · 계정은 싣지 않는다.
- **가림**: 응답에 서비스 태그 · 주소를 싣지 않는다. 계약 번호 · 비고(전체 범위 관리자가 올린 자유 글자)는 **관리자 판본만**(`isAdminDetailUser`) · 원장을 올린 사람도 관리자 판본만. `/check` 는 `/hw` 와 같은 노출 규칙(범위 밖 · 없는 키 404).
- **쓰기 게이트**: 자산 원장 올리기 · 펌웨어 기준 지정은 **관리자 + 조회 ∧ 쓰기 전체 범위**(`fullReadWriteScopeOnlyWith` — 전 법인에 걸친 값). 화면 단추 표지는 목록 `canFleet` · 상세 `canBaseline`(집행은 서버).
  올리기는 드라이런과 커밋이 **같은 함수**(`analyzeAssetImport`) · ‘원장을 파일로 바꾸기’ 는 오류 줄이 하나라도 있으면 아무것도 쓰지 않는다(오류 줄의 서버가 원장에서 사라지지 않게) · 감사 로그에 계약 번호 원문을 싣지 않는다.
- **저장소(`store.js`)**: `bm-assets.json` · `bm-fw-baseline.json` — 공용 로더(`util/jsonFileLoad.js`): 손상이면 보존 · 쓰기 409 · 읽기 오류는 원본을 두고 30초마다 다시 본다 · 원자 쓰기 · 성공 뒤에만 캐시 교체 · 세대(rev)는 목록 응답 캐시 열쇠(`checkRevKey` — 오늘 날짜도: 남은 일수).
  파일 이름은 코드에 글자 그대로 둔다(`scripts/config-doc.mjs` 가 뽑는다).
- 날짜는 날짜만(`parseDay` — 실제로 있는 날짜 · 1990~2100) · ‘오늘’ 은 포탈 날짜 경계(`util/dayKey.js`) · 만료일 당일은 아직 보증 안(남은 0일) · ‘곧’ 의 기준 일수는 서버 값(`WARRANTY_SOON_DAYS` → 응답 `soonDays` — 화면에 숫자를 박지 않는다).
- **라우트 · 이 폴더를 고치면 커밋 전에** `node scripts/api-doc.mjs` · `node scripts/arch-doc.mjs` · (저장소 파일을 더하면) `node scripts/config-doc.mjs`. 회귀 `server/test/bmCheck345.test.js` · 웹 `checkText.test.js` · `bmCheck345.test.jsx`.
- **아직 없는 것(다음 판)**: ⑨ 같은 묶음 대비(24시간 평균 — 엣지 서버는 서버마다 WAN 왕복 없이 엣지 한 번에 묶어 받는 새 요청이 필요하다) · 원장의 태그가 지금 목록에 없는 서버인지 알려 주기 · 법인별 펌웨어 요약 화면.
