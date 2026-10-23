# 규칙 — 회차별 점검(감사) 기록 v2.583~v2.744

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: 같은 영역을 다시 점검할 때 — 확정분·남긴 것·작업 방식 교훈

## 목차

- (원래 974행) v2.727 — 버그 점검 6축(사이드바·게시판·정직성·엣지·화면·성능) + 상단 메뉴 C안 + 메뉴 아코디언 + iDRAC 통합 추이 A안
- (원래 1040행) 2026-10-09 검토 보고서 개선(기준 v2.729.0 · 20건) — 되돌리지 말 것
- (원래 1098행) v2.731 — 점검 1회차(6축 분석 → 반증 → 9그룹 수정) 확정분
- (원래 1125행) v2.732 — 점검 2회차(6축 분석 → 반증 → 11그룹 수정) 확정분
- (원래 1152행) v2.733 — 점검 3회차(6축 분석 → 반증 → 11그룹 수정) 확정분
- (원래 3373행) v2.583 — 전체 소스 감사 확정 42건 + 검증 후속 · 로그 분석 메뉴 · 요청 ID · 개요 물리 서버
- (원래 3467행) v2.586 — 문서의 미해결 기록 정리 + 서버 결함 스윕 확정 5건
- (원래 3756행) v2.589 — 5축 병렬 감사 확정분
- (원래 3789행) v2.590 — 6축 병렬 감사(2차 점검) 확정분
- (원래 3882행) v2.591 — 7축 병렬 감사(3차 점검) 확정분
- (원래 3990행) v2.593 — 7축 병렬 감사(4차 점검) 확정분
- (원래 4032행) v2.594 — 7축 병렬 감사(5차 점검) 확정분
- (원래 4064행) v2.595 — 7축 병렬 감사(6차 점검) 확정분
- (원래 4093행) v2.596 — 7축 병렬 감사(7차 점검) 확정분
- (원래 4117행) v2.597 — 7축 병렬 감사(8차 점검) 확정분
- (원래 4148행) v2.598 — 10축 감사 + 발견별 2인 반증(9차 점검) 확정분
- (원래 4183행) v2.599 — 10차 점검(v2.598 회귀 우선) 확정분
- (원래 4210행) v2.600 — 11차 점검 확정분
- (원래 4232행) v2.601 — 12차 점검 확정분
- (원래 4252행) v2.602 — 13차 점검 확정분
- (원래 4270행) v2.603 — 14차 점검 확정분
- (원래 4289행) v2.604 — 15차 점검 확정분
- (원래 4305행) v2.605 — 16차 점검 확정분
- (원래 4331행) v2.606 — 17차 점검 확정분
- (원래 4355행) v2.607 — 18차 점검 확정분
- (원래 4717행) v2.611 — 19차 점검(v2.608~2.610 회귀 우선) 확정분
- (원래 4766행) v2.612 — 20차 점검 확정분
- (원래 4796행) v2.613 — 특수 기능·신규 기능 아키텍처 점검(1단계) 확정분
- (원래 4908행) v2.618 — 전면 점검(6축 병렬) 확정분
- (원래 4937행) v2.620 — 6축 감사(버그·코드 개선) 확정분
- (원래 4965행) v2.621 — 6축 감사(버그·코드 개선 2회차) 확정분
- (원래 4999행) v2.622 — 6축 감사(버그·코드 개선 3회차) 확정분
- (원래 5066행) v2.628 — 6축 감사("프로그램 개선해줘") 확정분
- (원래 5085행) v2.629 — '다시 3번더' 1회차 확정분
- (원래 5095행) v2.630 — '다시 3번더' 2회차 확정분
- (원래 5104행) v2.631 — '다시 3번더' 3회차 확정분
- (원래 5112행) v2.632 — '한번더' 확정분
- (원래 5165행) v2.689 — 전체 소스 점검(6영역 분석 → 컨펌 → 7그룹 Opus 병렬 수정) 확정분
- (원래 5212행) v2.741 — 전체 소스 점검(10축 발견 → 발견마다 2인 반증 → 12그룹 병렬 수정) 확정분
- (원래 5260행) v2.742 — '세 번 반복' 1회차(10축 발견 → 발견마다 2인 반증 → 12그룹 수정) 확정분
- (원래 5299행) v2.743 — '세 번 반복' 2회차(10축 발견 → 발견마다 2인 반증 → 12그룹 수정) 확정분
- (원래 5335행) v2.744 — '세 번 반복' 3회차(10축 발견 → 발견마다 2인 반증 → 10그룹 수정 → 후속 3그룹 → 수정분 적대적 회귀 검토) 확정분
- (원래 5556행) v2.719 — 데모 모드·데모 계정이 실제 장비·운영 동작에 닿던 경로를 막았다(코드 리뷰·안정화 1회차)
- (원래 5571행) v2.720 — 2회차: 1회차 수정이 만든 회귀 4건이 먼저였다
- (원래 5586행) v2.721 — 3회차: 이번에도 직전 수정이 만든 회귀가 절반이었다
- (원래 5810행) v2.680 — 1회차 점검(버그·튜닝·개선·보안) 확정분
- (원래 5820행) v2.681 — 2회차 점검 확정분
- (원래 5830행) v2.682 — 3회차 점검 확정분

## 본문

- ⚠⚠ **v2.727 — 버그 점검 6축(사이드바·게시판·정직성·엣지·화면·성능) + 상단 메뉴 C안 + 메뉴 아코디언 + iDRAC 통합 추이 A안**
  (사용자 요청 "버그 찾아서 개선해줘" 외 3건. 상세 `docs/AUDIT-2026-10-08b.md`. 회귀 `server/test/audit2727{a,b,c,d,e}.test.js` + 웹 `audit2727e`·`audit2727g3a`·
  `headerText`·`sideMenu`·`menuEdit`·`topMenu`·`shellStyles`·`bulletinText`·`idracLayout2727` — 그룹별 변이 검증):
  · ⚠⚠ **메뉴를 읽지 못했으면 편집을 잠근다**(A-01 — v2.618 WEB-2 '조회 실패 → 저장' 의 재발): App 의 메뉴 조회 상태 `loading|ok|error` + 백오프 재시도(5→15→60초),
    `resolveMenu({failed})` 는 `source:'unknown'`, 편집 창은 저장·삭제·복원·배포를 잠근다. 서버는 내용이 바뀐 저장의 직전 메뉴를 `prev{mode:'save'}` 로 한 단계 보관한다.
  · **사용자 메뉴 키는 `usermenu/store.js menuUserKey`**(소문자 · `[a-z0-9._@-]{1,64}` 밖이면 `h:<sha1>`) — AD 이름의 역슬래시·공백이 500 이던 것, 대소문자가 다른 메뉴이던 것.
    로드 때 옛 키를 옮기며 같은 키는 더 최근 것만. 비-admin·데모 계정 응답에는 `distributed.by`·`prev.by` 를 싣지 않는다.
  · ⚠ **사이드바 CSS 는 전부 `.sb` 자손**(A-02) — 바닥 선택자 `.sb-label` 이 하단 상태바의 같은 이름 클래스를 바꿨다. `shellStyles.test.js` 가 `.sb-` 바닥 선택자 0 을 고정한다.
  · **좌측 메뉴는 한 번에 한 그룹만 펼친다**(`sideMenu.nextOpenGroup` — 열린 그룹을 다시 누르면 닫힘, 지금 위치의 그룹은 자동으로 열림, 레일은 영향 없음).
  · **상단 메뉴 C안**(`views/headerText.js`): 역할은 한글(`roleLabel` — 데모 계정 → 슈퍼 관리자 → 관리자·운영자·조회자 순), 가운데 '기능 · 화면 찾기' 버튼이
    V4 팔레트를 **페이지 없이**(`includePages={false}`) 연다, ⌘K/Ctrl+K 는 **기본 셸에서만**(V4·V5·V6·관제 콘솔은 각자 단축키). `.user-role` 에 text-transform 금지.
  · **게시판·공지 쓰기는 300ms 묶음 비동기**(`bulletin/store.js` — tmp → fsync → rename, 종료 flush 등록, 실패는 상태·콘솔에, 자동 재시도 루프 없음) + 합계 상한
    (`BOARD_MAX_BYTES` 기본 16MB — 넘는 글·댓글은 409 `board-full`, 공감·삭제는 막지 않는다). `central/edgeRecord.createDebouncedWriter` 를 쓰지 않은 이유: 그 헬퍼는 파일을
    **상태 파일**로 등록하는데 게시판은 사용자 데이터라 백업 번들에 들어가야 한다(대신 백업 '변경 감시' 지문에서는 뺐다 — 글마다 change 백업 금지).
  · ⚠⚠ **결측을 null 로 바꿨으면 소비처를 전수로 따라갈 것 — 이번엔 12곳**(C-01 — v2.719 B1-09 의 VM `storageGB`/`uncommittedGB`): 디스크 추이 시계열·인벤토리 합계·
    정지 VM 회수량·공개 API 가 `|| 0` 으로 더했다. 합계에서 빼고 `vmStorageUnknown`(공개 API 선언 필드 추가)으로 센다. GPU VRAM(`memGB`)·라이선스 used/total·
    vSAN 멤버 수(enabled 인데 0개 = null)·비용 배분 일부 모름(`partialCost`)·전력 '시각 없음'(`noTime`)도 같은 규칙. 날짜 경계 KST 리터럴은 `arch2582` 스윕이 금지한다.
  · **VM 이동·구성 변경 이력은 `trackedEventsAsync`**(F-01 — 1일 조각 + 양보, 한 문장 판과 결과 동일 대조, 최장 동기 구간은 비율) · 손상된 iDRAC 스캔 배정·GPU 게스트 배포
    파일은 503 `settingsUnreadable`(D-01) · 인벤토리 상한 넘침 `overCount` · `pushBundleToEdge` 도 `recordOutbound`(`/api/upgrade/` 추적 접두) · vCenter 삭제 때 vmcfg·contention
    재시도 기록도 비움(F-04 — 그 전엔 호출부 0) · CLI 계정 메뉴의 변경은 감사 로그(비밀 미기재).
  · ⚠ **감사 보고를 그대로 믿지 말 것**(D-03): '엣지가 추적을 자르지 않는다·재전송이 거짓 실패를 남긴다' 는 틀렸다 — `makeTracer` 가 이미 600줄·2,000자로 자르고
    `completeTestRun` 은 완료된 run 에 `already` 를 준다(멱등). BIG_JSON 등록만 했다.
  · **iDRAC 통합 추이 A안**: `.idrac-trend-row`(① 보기 탭 + 법인·서비스·서버 ② 종류 칩 + 도구 버튼) + KPI 카드 `.idrac-trend-kpi-val`(값 옆에 평균·최대). 720px 이하는
    오른쪽 덩어리를 왼쪽 정렬로. 도구 버튼의 기준선 숫자는 켜졌을 때만 글자에, 꺼졌을 때는 title 에 — 글자를 길게 두면 1440px 에서 둘째 줄이 다시 두 줄로
    갈린다(Chromium 판독에서 발견). 무응답 구간의 'iDRAC 무응답' 글자는 구간 폭이 보이는 범위의 12% 이상일 때만(`gapLabelShown`) — 좁은 띠에서는 'AC 무응답' 으로 잘렸다.
  · ⚠ 작업 방식: 수정 에이전트 셋이 세션 한도로 중간에 멈췄다 — 변이 백업·작업 트리 대조로 남은 변이가 없는지 확인하고, 변이 단계 전에 멈춘 그룹은 리드가 파일 단위로
    감사 시작 커밋판으로 되돌려 다시 검증했다. WIP 커밋 두 개가 변이 도중의 파일을 담았다(작업 트리가 정답 — 그 커밋판으로 되돌리지 말 것).

- ⚠⚠ **2026-10-09 검토 보고서 개선(기준 v2.729.0 · 20건) — 되돌리지 말 것**(사용자 제공 `DVC-CLAUDE-CODE-REVIEW-2026-10-09.md`. 항목마다 실패하는 회귀
  테스트 → 최소 수정 → 변이 검증. 테스트 파일 이름의 `rv<그룹>_` 접두가 그 항목이다. 보안 기본값 전환(S-01·S-02·S-09·S-10)은 사용자 승인):
  · **I-01 공용 정렬은 부호를 읽는다**(`components/sortableText.js NUM_RE`): `-3` 이 +3 으로 정렬되던 것. 유니코드 마이너스(−)·`±0` 도 숫자다.
    ⚠ 결측 정렬값은 음수 sentinel(`-1`·`-9999`)이 아니라 **`''`** 다 — 이제 진짜 음수로 읽혀 오름차순 맨 앞에 온다(`sortableTextSignI01.test.js` 스윕).
  · **I-02 `/api/vms` 는 `paged=1`·`cursor` 로 5,000 뒤를 페이지로**(`inventory/vmPaging.js`): 순서는 첫 페이지 시점에 고정(pin) — 키셋으로 바꾸지 말 것(값이 바뀌는 정렬에서
    중복·누락). 기억 없음 + 스냅샷 변경이면 409 `cursor-stale`. 400·409 는 memoJson **앞**에서. 필터를 늘리면 `VM_FILTER_KEYS` 에도. 파라미터 없으면 예전 응답 그대로.
  · **I-03 OneFS 영역 수집 요약은 영역마다 예정·시도·미시도 엔드포인트를 싣고 판정은 웹 `onefsAreaState.js` 하나**: 중간에서 멈춘 영역은 `failed===0` 이어도 초록이 아니다 ·
    시한이 끊은 요청은 failed 가 아니라 미시도 · 구버전 요약은 '완료 여부 미상'(지어내지 않는다). 중앙 정제 `storageEdge.narrowStorageAreas`(아는 필드만).
  · **I-04 `usePolling` 은 실패해도 직전 data 를 남긴다** — `error && !data` 만 그리면 첫 성공 뒤의 실패가 화면에서 사라진다(`views/tools/sanFreshText.js`):
    '직전 조회 결과 표시 중' + 마지막 성공·실패 시작 시각을 말하고 실패 중엔 실시간 배지를 쓰지 않는다. 선택을 바꾼 직후 한 렌더는 이전 조건 data 다 — 요청 키로 거른다.
  · **I-05 게시판·공지는 '수용됨' 과 '저장 완료' 를 나눈다**(`bulletin/store.js` seq/savedSeq): 쓰기 응답 `persist.state` saved·pending·failed · 디스크 실패는 200 + failed(되돌리지 않음) ·
    제한된 backoff 재시도(6회·상한 5분) · `GET /board/persist`·`POST /board/persist/retry`(전체 범위 관리자) · 오류 원문(tmp 절대 경로)은 상태·콘솔에 싣지 않는다 ·
    ⚠ 동기 flush 는 진행 중 비동기 쓰기의 tmp 를 먼저 지운다 — 지우면 늦은 rename 이 새 본문을 덮고 상태는 '저장됨' 이라 말한다(재현). 서비스 점검 `bulletin-store` 행.
  · **I-06 Node 런타임 계약은 `util/runtimeCheck.js RUNTIME_CONTRACT` 하나**(major 22 · engines `>=22.5.0 <23` · 검증 22.23.2 — .nvmrc·.node-version·CI·release.yml·build-package.sh):
    `rvE_runtimeCheck.test.js` 가 일치를 고정한다. 전역 fetch + 패키지 undici 6 Agent 라 다른 major 에서 통신이 실패할 수 있어(검토 Node 26 `invalid onError method`)
    기동 자가 점검(루프백 1회)이 `/api/health runtime`·서비스 점검·기동 로그·화면 배너(`views/runtimeBannerText.js` — 세 셸 공통)로 말한다. **기동은 막지 않는다.**
  · **I-07·S-01·S-04·S-02** — `server/CLAUDE.md` 의 같은 날짜 절(장비 신뢰·WS 폐기·백프레셔). **S-03·S-05·S-06·S-08** — 세션·AD(`server/CLAUDE.md`).
  · **I-08·S-10 업그레이드 설치 경로는 전부 `upgrade/signature.js decideSignature` 하나**(Ed25519 manifest — 원격·감시 폴더·push 엣지/수집기·패키지 받기·중앙 /dl·오프라인
    verifyCli·install.sh·배포 deploy.js). 신뢰 키 = 저장소 `release-signing-keys.json` + 호스트 `release-signing-keys.conf`(회수는 어느 출처든 이긴다) · 기본 require ·
    탈출구는 portal.env `UPGRADE_SIGNATURE_POLICY=warn` 뿐이고 '틀린 서명' 은 warn 이어도 거부 · **CI 사전 점검(`release-sign.mjs --check`)을 지우지 말 것**(개인키는
    CI 비밀에만). 백업 복원은 보안 스위치(`envRedact.HOST_PINNED_ENV`)를 현재 호스트 값으로 고정한다(번들이 정책을 약화하지 못하게). 절차 `docs/RELEASE-SIGNING.md`.
    ⚠⚠ **v2.735.1(사용자 결정 '이번만 서명 없이 게시')**: 신뢰 키가 **하나도 설정되지 않은** 설치본(저장소·호스트 어디에도 키 항목 없음 · 호스트 파일 없음 · 키 파일 오류 없음)은
    env 가 없으면 **warn**(`signatureCore.resolvePolicy`·`trustUnconfigured` 한 벌 — 런타임·CI·오프라인 `verifyCli --policy` 가 같이 쓴다). 키가 든 릴리스를 설치하면 저절로 require.
    CI 는 공개키 목록이 완전히 비어 있고 비밀도 없을 때만 서명 없이 통과(`signed=false` → 서명 생략 · `REQUIRE_MANIFEST=0`)하고 한쪽만 설정되면 실패다. 이 허용은 위 규칙이
    warn 을 돌려줄 때만 성립한다 — 규칙을 '항상 require' 로 되돌리면 CI 도 막는다(그 버전 설치 현장이 다음 버전을 영원히 못 받는 사고 방지). 화면·자가진단은 '키 미설정' 을
    관리자가 끈 warn 과 구분해 말한다(조치가 '키 등록' 이다). ✅ v2.735.2 에 공개키 `ed25519:d8a83ad56120662d` 를 등록했다(첫 서명 릴리스 — 그 전 버전은 경고 후 설치, 설치 뒤 서명 필수). 회귀 `rvK_releaseSigning.test.js`.
    ⚠ v2.736.1(사용자 캡처 '마지막 검증 — 아직 검증한 번들이 없습니다'): 검증 기록이 메모리에만 있어 업그레이드 재시작마다 지워졌다 — 이제 최근 10건을 상태 파일
    `upgrade-signature-log.json`(동기 원자 쓰기 0600 · 아는 필드만 · 손상 보존)에 남긴다. **파일에 쓰는 것은 index.js 가 `enableSignatureLog()` 를 부른 서버 프로세스뿐** —
    verifyCli(install.sh 가 root 로 부를 수 있다)는 쓰지 않는다. 누적 개수는 여전히 '프로세스 시작 뒤'. '지금 실행 중인 버전' 표지는 확인된 기록에만. 회귀 `upgradeSigLog2736_1`(변이 10/10).
    ⚠⚠ v2.736.2(사용자 신고 "아직도 자동 업그레이드가 안 되고 같은 메시지 · 서명 필수"): **'마지막 검증 없음' 은 서명이 막은 것이 아니라 시도하지 않은 것**이다
    (decideSignature 는 성공·실패 모두 기록한다 — 게시된 2.736.1 은 실제 코드로 서명 필수에서 통과·설치를 확인했다). 시도하지 않는 이유(확인 주기 0분 = 중앙 기본값 ·
    자동 적용 꺼짐 · 설치 경로 없음 · 확인 실패)를 화면이 말하지 않았다. 판정은 `upgrade/autoState.js autoUpgradeState` 하나(코드 `AUTO_CODES` ↔ 웹 `upgradeAutoText.js
    AUTO_TEXT` 1:1 — 웹 테스트가 서버 소스와 대조) · 다음 확인 = 무장 시각 + 주기의 배수(모르면 null) · 백그라운드 확인 결과 `lastTick`. 확인·적용·자동 확인 기록은
    `upgrade-status.json`(statusStore.js — 서버 `start()` 만 쓴다 · 동기 원자 0600 · 아는 필드만 · 주소 계정·쿼리 제거 · 손상 보존)에 남고, 되살린 '새 버전 있음' 은 **지금 버전
    기준으로 다시 계산**한다(설치는 언제나 새로 받은 정보로만). `lastResult` 는 setter 라 routes 의 대입도 파일에 남는다. '새 버전 확인' 결과가 늘 '실패' 로 보이던 것
    (확인 응답에 ok 없음)은 `actionMsg` 하나가 고친다. 회귀 `upgradeAuto2736_2` + 웹 `upgradeAutoText.test.js`(변이 12/12 + 리뷰분 11/11).
    ⚠ 같은 릴리스 리뷰 확정분: 'not newer'(같은 번들 push)는 `upToDate:true` · 대상 버전이 이미 설치됐거나 그 뒤 자동 확인이 '최신' 이면 지난 실패(`failureMoot` — status() 가
    currentVersion 을 넘긴다) · 소스가 없으면 tick outcome `no-source`('최신' 금지) · 'applying' 의 '프로세스가 끝났다' 는 **재시작 전 기록일 때만**(지금이면 적용 중) ·
    확인·적용 버튼은 **저장된** enabled 기준. **기록을 파일에 남기기 시작하면 그 기록이 '지금 사유' 인지 판정하는 조건을 함께 둘 것** — 영속화가 실패를 원인보다 오래 살게 한다.
    ⚠⚠ v2.736.3(사용자 신고 v2.735.3 · 사내 미러 '전체 시한(10초) 안에 다 받지 못해 중단'): **전체 시한을 시도 시한으로도 쓰면 재시도가 없다** — v2.730 I-08 이
    versions.json 받기를 전체 10초로 묶으며 `timeoutMs` 에도 같은 10초를 넣어, 첫 응답이 10초를 넘는 미러(원본을 받아 오는 Nexus 등)에서 요청 1번으로 실패했다(재현 —
    v2.729 는 시도 10초 × 3번이라 두 번째 시도로 받았다). 이제 `versionsDoc.js META_FETCH_TIMEOUT_MS`(기본 60초 · env `UPGRADE_CHECK_TIMEOUT_MS` · [5초, 120초]) 안에서
    시도마다 `attemptTimeoutMs`(1/3, 하한 5초) — versions.json·서명 manifest·패키지 받기·번들 출처·설치 경로 확인(예전 15초 상한)이 같은 값이다. 사유는 `metaTimeoutReason`
    하나(헤더 대기 / 본문 수신 · 시도 횟수 · 앞머리 문구 불변). 화면 원격 행 라벨은 `upgradeAutoText.remoteSourceLabel`(GitHub 주소만 '원격(GitHub)').
    **전체 시한 신호를 새로 걸 때 `timeoutMs` 를 같은 값으로 두지 말 것**(회귀 `upgradeCheckTimeout2736_3` ⑧ 이 소스로 고정 · 변이 4/4).
    ⚠ 이 수정이 없는 v2.735.3~v2.736.2 포탈은 원격 확인이 같은 이유로 막힐 수 있다 — 감시 폴더에 번들 + 같은 버전 manifest 를 함께 넣으면 원격 확인 없이 설치된다.
    ⚠⚠ v2.740.1(사용자 신고 "업데이트를 하면 랙이 걸려 · 이전에는 안 그랬어" — 캡처 `upgrade › check · 19초`): **시도마다 끊고 기다리면 첫 응답만 늦는 저장소에서 그 시도 시한을 통째로 기다린다**
    (재현 — 첫 응답 25초 가짜 저장소 20.5초 · 모든 응답 25초 저장소는 60초 뒤 실패). 메타데이터(versions.json·manifest) 받기는 `upgrade/hedgedFetch.js` 하나 — 앞 시도가
    `UPGRADE_CHECK_HEDGE_MS`(기본 3초 · 0 = 예전처럼 순서대로) 안에 응답하지 않으면 **끊지 않고** 다음 시도를 함께 보내고 먼저 온 응답을 쓴다(최대 3번 · 나머지는 끊는다 ·
    재시도 대상 상태·일시 오류는 400·800ms 뒤 다음 시도 · 일시 오류가 아닌 실패는 다시 보내지 않는다). 측정 3.1초 · 25초. **번들·설치 패키지 다운로드에는 쓰지 말 것**(큰 파일을 두세 번 받는다 —
    회귀 `upgradeHedge2740_1` ⑪ 이 소스로 고정). 시간을 다루는 재시도를 새로 만들 때 '다음 시도를 언제 보내는가' 와 '앞 시도를 끊는가' 를 따로 정할 것.
  · **I-09 '버튼으로 여러 번 조회하는' 화면은 최신 요청만 반영**(`createHistLoader` — abort·요청 키, Horizon 추이) · **I-10 `downloadFile` 류에는 `/api` 뒤 경로**(`/api/api/…` 금지 — 스윕).
  · **S-07 암호화 정책 손상·유실 시 평문 저장 금지** — `server/CLAUDE.md` secretVault 절.
  · **S-09 중앙↔엣지 URL 은 HTTPS 기본, 평문 HTTP 는 승인된 예외만**(`collector/transportPolicy.js evaluateCollectorUrl` 하나 — 화면·CSV·자기등록·배포 자동등록·배포 대상 동기화):
    원격 http 는 ⓐ 저장값과 같은 URL(업그레이드 전 항목 — 경고) ⓑ 관리자 예외(사유·감사) ⓒ `COLLECTOR_HTTP_ALLOW` 뿐 · 스킴 없는 주소 = https · 자기등록은 예외를 못 만들고
    https 를 http 로 내리지 못한다. 포탈 직접 TLS 는 `util/httpsServer.js`(TLS_CERT_FILE·TLS_KEY_FILE, 틀리면 fail-closed · 인증서 재로드 · TLS_HTTP_ALSO 전환기) —
    index.js 의 `server` 는 리스너 묶음이고 게이트웨이·upgrade catch-all·타임아웃은 리스너마다 건다. 사설 CA 는 `WAN_TLS_CA_FILE`(기본 신뢰 저장소에 덧붙인다).
    resilientFetch 는 https→http 리다이렉트를 따라가지 않는다. 자가진단 `wan-transport`.
- ⚠⚠ **v2.731 — 점검 1회차(6축 분석 → 반증 → 9그룹 수정) 확정분**(사용자 요청 "전체 소스 분석해서 버그 잡고 프로그램 개선하는 작업 5번" 의 1회차.
  상세 `docs/AUDIT-2026-10-10.md`, 회귀 `server/test/audit2731*` + 웹 `audit2731*` — 그룹별 변이 검증):
  · ⚠⚠ **장비 신뢰는 지문 '목록'이다(상한 8, 승인은 추가가 기본, 교체는 `replace:true`)** — 이중화 SP·VIP 뒤 장비는 인증서·호스트키가 둘 이상이라 하나만 기억하면
    관찰 모드에서도 번갈아 거부됐다(A1-01). 저장은 첫 지문 `trusted`(객체) + 나머지 `trustedMore` — **`trusted` 를 배열로 바꾸지 말 것**(되돌림 설치가 전 장비 거부).
    거부 문구는 승인할 노드를 말한다(엣지면 그 엣지 이름). 처음 보는 장비 기록은 2초 묶음 저장, 바뀐 지문·관리자 동작은 즉시.
  · ⚠⚠ **접속처가 바뀌면 저장 비밀을 승계하지 않는다 — 두 곳 더**(A3-01, v2.503 S-2 의 누락): 업그레이드 원격 토큰(remoteBase 변경)·위임 IP 스캔 할당 비밀번호
    (대역 집합·계정 변경). env 위에 덮는 설정은 폐기를 `delete` 가 아니라 저장값 `''` 로 한다(delete 면 env 비밀이 되살아난다). 엣지는 비밀번호가 빈 할당을
    스캔하지 않는다(`no-password` — 빈 비밀번호로 대역 전체에 로그인하면 계정 잠금 위험).
  · **중앙↔엣지 클라이언트가 자체 Agent 를 만들면 `resilientFetch.wanTlsConnectOptions()` 를 통째로**(A4-01 — 사설 CA 엣지 거짓 tls-fail) ·
    **'포탈 포트' 는 `httpsServer.listeningPortalPorts()`**(A4-02 — HTTPS 전용 구성에서 config.port 는 듣지 않는 포트) ·
    **엣지가 중앙 주기를 따르는 워커는 '재확인 간격 + 마지막 스캔 시도 기준 due'**(A4-03 — setInterval(env) 금지, 변경 알림이 없다).
  · **측정 끝을 '지금' 으로 두지 않는다**(A2-01 — VM 가용성: 그 vCenter 이벤트가 온전한 마지막 시각까지만 재고, 자른 VM 은 행이 말한다) ·
    **서버 온도 ESXi 대체 행도 `unreadVcenterReasons` 로 오래됨**(A2-03) · **하위 시스템 롤업 배지는 `idrac/invView.js partHealthRollup` 하나**(A2-02 — 못 읽음을 OK 로,
    Critical 을 Warning 으로 접지 않는다) · **누적 카운터 '비율' 도 간격 경계**(A2-04 — bmusage `rates.spanOk` · CVP `parse.counterGapOk`).
  · **putJson·patchJson·delJson 반환값은 `views/changeResult.js requireChanged` 로 판정한 뒤 성공 처리**(A5-01 — 400 본문을 '저장됨' 으로 읽던 5화면 23곳.
    api.js 의 400 본문 반환 규약은 그대로, `audit2727e` 스윕이 버린 반환값을 센다) · **원격 콘솔 닫힘 사유가 원인 코드**(A5-02 — `host-key-<사유>`·`mapping-denied`…,
    웹 `remote/sshSend.js remoteCloseReasonText` 와 1:1. 새 닫힘 사유는 그 표에도) · 표 자리는 `pollPart`(data·오류·조회 중) · 추이는 `createHistLoader`.
  · **목록 응답은 요약만, 응답 기억 키는 입력 내용 지문**(A6-05 — SAN 목록이 스위치마다 조닝 전체를 싣고 요청마다 재직렬화: 260대 11.55MB → 0.68MB.
    스냅샷 세대 키(memoJson)면 '지금 수집' 직후 옛 값을 준다) · **`power_hourly` 서버별 요약은 `statsSinceAsync`**(A6-03 — GROUP BY server_id 는 보존기간 전체,
    30일 최장 멈춤 1.2초 → 18ms) · 메모리 추세 `metaRange`(A6-04).
  · ⚠ **디바운스는 '버스트를 묶는 것' 이지 '블로킹 제거' 가 아니다**(A6-01 — IP 스캔 결과 저장): 큰 맵 저장은 조각 직렬화 + 비동기 tmp→fsync→rename, 종료 flush 는 동기,
    동기 flush 가 진행 중 비동기 쓰기를 대체할 때 tmp 지우기 + 세대 검사(각각 단독으로도 막는 이중 방어). 스캔 결과·이력 파일은 한 줄 JSON 이다.
  · ⚠⚠ **IP 원장 계산은 생성기 `ipam/ledger.js ipamRowsGen` 하나를 동기판(`buildIpamRows`)·양보판(`buildIpamRowsAsync`)이 같이 돈다**(A6-02) — 원장 행을 고칠 때 그것만 고칠 것.
    store 는 원장 항목 2,000 이상이면 양보판이고, 더 새 호출이 오면 옛 계산을 취소, 도중 입력이 바뀌면 버리고, 3번 연달아 버려지면 한 번 동기(진행 보장). 쓰기·기억은
    `_commitLedger` 하나(v2.619 입력 지문·v2.620 ABA 규칙 그대로). ✅ `ipam/db.js` 레코드 전송은 v2.732 B6-04 에 2,000행 조각 + 양보로 고쳤다(v2.741 LEFT-10 에 이 줄을 정정).
  · 테스트에서 수만 행 객체를 `assert.equal`/`deepStrictEqual` 의 actual 로 넘기지 말 것 — 실패 시 보고기가 직렬화하다 프로세스가 메모리로 죽는다(G5a 변이 검증에서 SIGKILL).
    `util.isDeepStrictEqual` + `assert.ok` 로.
- ⚠⚠ **v2.732 — 점검 2회차(6축 분석 → 반증 → 11그룹 수정) 확정분**(같은 요청의 2회차. 상세 `docs/AUDIT-2026-10-10b.md`,
  회귀 `server/test/audit2732*` + 웹 `audit2732*` — 그룹별 변이 검증):
  · ⚠⚠ **v2.731 이 만든 회귀(B1-01)**: 누적 카운터 간격 한계를 60분으로 고정하자 주기 60분 이상 베어메탈의 CPU 가 매 주기 비었다 —
    한계는 `bmusage/rates.js spanLimitMs`(max(60분, 주기 × 3 + 직전 실행 소요 + 지연))이고 모든 누적 지표가 같은 한계다. **간격 상한을 새로 넣으면 수집 주기 설정의 최댓값과 비교할 것.**
  · **낡은 위임 vCenter 판정은 `store.siteInventoryStale` 하나**(B2-01 — v2.570 이 '확정 결함 ①' 로 적고 화면만 만든 것): 롤업·`/health` 의 `vcentersStale`,
    vCenter 카드·법인 표·경영 보기·V6·Platform 의 '낡은 값' 표시, 공개 API 행 `collectedAt`(실제 받은 시각)+`stale`. 연결 수(N/M)는 바꾸지 않았다(구버전 화면 계약).
    경보 미조회는 `store.vcAlarmsUnknown`(healthReport·alerts 통일은 남은 일).
  · **CVP 장비 담당은 `cvp/overview.js rowOwnerOf(servers)` 하나**(B2-02) — 라우트·Overview 카드·장애 판정(faultScan)이 같은 판정. 전력·GBIC 탭은 `faults.partsFresh` 로
    낡은 장비를 합계에서 빼고 사유별로 센다(B2-03 — `docs/CVP.md` §18).
  · ⚠⚠ **'직접 수집 대상' 판정은 `vcenter/collectTarget.js directCollectSkipReason` 하나**(B4-01): 비활성·점검중·site(엣지 위임)는 중앙이 로그인하지 않는다 —
    vCenter 로그·게스트 디스크·OS 판별이 같은 판정을 쓰고 거부는 `vcAuthGuard` 정지로 기록한다. ⚠ **동작 변화**: 중앙은 site vCenter 이벤트를 모으지 않는다(엣지가 올리는 경로 없음).
    미보호 VM 리포트는 `not-collected` 로 따로 세고, vCenter 로그 검색은 site 를 연합 조회(remote)로 읽는다(`classifyLogSources`). 다른 이벤트 리포트의 표시는 3회차 회귀 축.
    로그 DB 적재·리포트 조회는 `insertManyAsync`(시각 경계 조각 + COMMIT 뒤 양보)·`queryAsync`(1시간 조각) — 결과는 예전 경로와 같다(테스트 대조).
  · **IP 원장**(B4-02·B6-04): 워커 시한 실패(`SCAN_DEADLINE`)는 메인에서 다시 돌리지 않는다 · 쓰기 전송은 2,000행 조각 · 워커는 commit 메시지에서만 트랜잭션 · 동기화는 직렬.
    범위 계정의 IP DB 정보는 `count:null` + `fleetCountsHidden` — 웹은 `ipamDbInfoText.dbCountText`(null 이면 '—'. `count.toLocaleString()` 크래시를 리드가 잡았다).
  · **장비 신뢰 파일을 못 읽으면 닫는 쪽**(B4-03, `security/peerTrust.js`): 원본 보존 + enforce(load-error), 보존 불가면 쓰기 차단 + 관리 동작 409. `.corrupt.*` 만 남은 재시작도 enforce.
    엣지 인벤토리의 미래 `collectedAt` 은 받은 시각으로 자르고 원본은 `edgeCollectedAt`(v2.630 규약의 remoteInventory 누락) · Isilon 전력 부분 합은 `isiPowerResult`.
  · **SAN 스냅샷은 주기 끝 한 번 기록**(B6-02, `sanswitch/store.js` + 30초 안전 타이머 + 종료 flush) · 데모 사용량도 `heavyQuery` 키(demo-*)로 · 포트 상세의 패브릭 스위치 IP·계정은 `addressMask` 로 가린다.
  · **권한·노출**(B3-01·03·05·06·07): 데모 계정의 Horizon 라이선스 조회는 `demoOnly`(접속 0 · `demoSkipped`) · 범위 계정에 웹훅 URL 원문·`updatedBy` 를 싣지 않는다 ·
    게시판 남의 글 관리 = `isBoardModerator`(admin + 전체 범위) · `/tools/gpu.json` 은 `csvPerm`.
  · ⚠⚠ **설정 PUT 의 '모르는 id 거부' 는 새로 들어온 id 만**(B5-02): 이미 저장돼 있던 낡은 id(삭제된 vCenter·VM·호스트)는 통과·보존하고 GET·PUT 응답 `staleIds`(vmseries 는 `staleTargets`)로 밝힌다.
    조용히 걸러 저장하면 vmperf 는 그 vCenter 의 DB 파일을 지운다. 화면은 `views/staleSettingIds.js` 로 '목록에 없음' 칩을 그려 사람이 뺀다. 실패 응답이면 편집값을 유지한다(`settingsSaveOutcome`).
  · **웹 SSH 콘솔**(B5-07): 새 시도 전 `remote/sshConsoleState.js releaseConsole`(옛 소켓 핸들러를 먼저 떼고 닫는다) · 모든 핸들러가 '이 시도의 소켓' 확인 · 빈 비밀번호는 접속하지 않는다(`canConnect`).
  · **화면 실패 정직성**(B5-01·03~06·08): `postJson` 반환도 `requireChanged`(409·ok:false 를 성공으로 읽던 것) · 설정 캐시는 **디스크 쓰기 성공 뒤에** 갱신(SAN 사용량·스토리지 주기) ·
    조회 실패를 '없음'·'미지정' 으로 보이지 않는다. `audit2727e` 허용 목록에서 고친 6파일을 뺐다(늘리지 말 것).
  · 남긴 것(3회차 후보): ✅ storage/store.js 전체 재기록·sanSwitchConfigPull 장비마다 쓰기·gpu/poller.js 필터·iDRAC 스캔 주기 쓰기 전 캐시·`DELETE /perf/hangs` 실패 감사는
    v2.733 C4-01~C4-05 에 고쳤다(v2.741 LEFT-10 정정). ✅ 전력 합계 네트워크 기준(v2.740 F-03 `power/total.js cvpPartsStaleReason`·`staleBy`)·게이트웨이 빈 비밀번호 서버측 거부(v2.740 F-10 `proxy/sshGateway.js`)도 고쳤다(v2.742 LEFT-03 정정). 남은 것: 데모 계정의 관리 IP 조회(정책).
- ⚠⚠ **v2.733 — 점검 3회차(6축 분석 → 반증 → 11그룹 수정) 확정분**(같은 요청의 3회차. 상세 `docs/AUDIT-2026-10-10c.md`,
  회귀 `server/test/audit2733*` + 웹 `audit2733*` — 그룹별 변이 검증):
  · ⚠⚠ **수집을 멈춘 대상은 그 데이터를 쓰는 리포트 전부가 '0건' 이 아니라 '수집하지 않음' 으로 말한다**(C1-01 — v2.732 B4-01 의 파급): 판정은 `logs/coverage.js
    eventNotCollectedMap` 하나(등록부 + `directCollectSkipReason`, mock 은 빈 맵 — 로그 폴러와 같은 기준). 단일 선택은 판정 불가·null, 전체 보기는 빼고 개수를 밝힌다.
    logs DB 를 읽는 새 리포트는 `notCollected:[{vcenterId, why}]`(범위 안만)를 싣고 웹 문구는 `views/eventCoverageText.js`. **어떤 수집을 끄는 변경은 그 데이터의 소비처를 같은 릴리스에서 따라갈 것.**
  · ⚠⚠ **시한 초과는 '결과 없음' 이 아니다**(C1-02 — v2.732 B4-02 회귀): IP 스캔이 시한에 걸리면 결과를 버려 해제 판정이 살아 있는 IP 를 down 으로 바꿨다.
    실패·시한은 `recordAgentIncomplete`(완료로 기록하지 않음) · 완료 스캔이 해제 기준 안에 없으면 해제 보류(시한 = 기준 + max(기준, 24시간), 지나면 `unverified`) ·
    시한 안에 받은 응답은 `mergeScanResults(…, {seenOnly:true})`. 엣지의 `incomplete` 보고는 중앙 2.733.0 확인 뒤에만(구버전 중앙은 완료로 받는다).
    ⚠ **동작 변화**: 스캔이 꺼졌거나 삭제·불통인 에이전트의 IP 는 해제까지 3시간이 아니라 기본 27시간 뒤 '미확인 해제' 다.
  · **데모 합성은 mock 모드에서만**(C2-01 — NSX 등록 0개가 live 에서 데모 매니저 3대를 `source:'live'` 로 만들었다).
  · **vCenter 추정 전력은 `idrac/service.js vcPowerSkipReason` 을 지난다**(C2-02): 읽지 못한 vCenter·끊긴 호스트는 적재·합산·폴백 합계·fleet 전력 칸에서 빼고
    `vcPowerSkipped` 로 센다. 판정 본체는 leaf `metrics/unreadVcenters.js`(store 는 sampler 를 import 할 수 없다 — 순환 SCC) — sampler 는 import + export 로 재수출만.
  · **호스트 용량을 모르면 null**(C2-06 — REST 폴백): `store.hostCapacityKnown` · 롤업 `hostsCapacityUnknown` · 비율·여유는 '—'. 웹 `clusterRows` 의 부하도 둘 다 모르면 null(용량 어드바이저가 '부하 0' 으로 추천하던 것).
  · **증가량 합계는 실제 구간이 요청 일수 × 1.1(내림)을 넘는 장비를 빼고 `inexact` 로 센다**(C2-03 — 장비 칸은 그대로, 1일·1주는 하루 공백도 뺀다). 서버 growth.js·웹 storageGrowthText.js
    두 벌이고 테스트가 같은 입력으로 대조한다. 공개 API 는 행 `growthSpanDays` + meta `maxSpanDays`·`inexactCount`·`spanNote`(키 집합 변경).
  · **N+1 잔여 용량은 VM 을 받을 수 있는 호스트만**(C2-04 — MAINTENANCE 제외, 부하는 사용량에 남김 · 클러스터 없는 호스트 묶음은 `n1Ok:null`) · **예측 ETA 는 마지막 표본 시각부터**(C2-07 — `lastTs`·`stale`).
  · **설정 화면의 '목록에 없음' 판정은 그 vCenter 의 인벤토리를 읽었을 때만**(C1-03 — vmseries `staleUnknown`, 골격·pending·disabled·이월 없는 unreachable/maintenance).
  · **GPU 게스트 폴러도 `directCollectSkipReason` 으로 site·비활성·점검중을 로그인 전에 거른다**(C4-01 — v2.732 B4-01 의 형제 누락). site 는 unreadVcenters(push 보류 사유)에
    넣지 않는다 — '못 읽음' 이 아니라 '이 노드의 몫 아님'. **새 vCenter 로그인 수집기는 이 판정을 먼저 볼 것.**
  · **엣지 설정 pull 은 '지금 수집' 을 기다리지 않는다**(C4-02 — SAN: 테스트 대행 먼저, 수집은 단일비행 작업 + 호스트 잠금). ✅ storage·PDU 도 v2.741 LEFT-02 에 같은 단일비행 작업(`collectJob`·`collectRun`)으로 고쳤다(v2.743 LEFT-05 정정).
  · **스토리지 스냅샷도 SAN 과 같이 주기 끝 1회 + 안전 타이머 + 종료 flush**(C4-03) — 쓰기 실패는 수집을 멈추지 않고 콘솔·`snapshotSave` 에 남는다. 여러 대를 차례로 수집하는
    호출부는 `collectDeviceNow(id, {flush:false})` + 끝에 `flushSnapshotsNow()` 한 번(SAN·스토리지 둘 다 인자가 있다). `util/adaptiveTimer.js` 는 fn 오류를 1시간에 한 번 로그한다.
  · ⚠ **설정·등록부 캐시는 디스크 쓰기 성공 뒤에만 바꾸고 리스너도 그 뒤에**(C4-04 — v2.732 B5-03 이 2곳, 이번 8곳: partfault·pdu·cvp(엣지 applyCentral 포함)·curuser·relaycheck·
    relaytopo·storage growth·iDRAC 스캔 주기). 캐시를 먼저 바꾸면 쓰기 실패 뒤 다음 pull 이 '이미 같다' 로 건너뛴다. 삭제·정리 라우트는 실패를 200 으로 주지 않는다(C4-05 perf/hangs).
  · ⚠⚠ **주문형 vCenter 성능 조회도 인증 정지를 본다 — `vcenter/authStopGate.js` 하나**(C3-01 — v2.590 가드의 누락 5경로: 스파크라인·VM 사용량·호스트/클러스터 추이·라이트사이징·VM 찾기):
    정지면 로그인 0(여러 대상 경로는 그 vCenter 만 null + `authStopped`, 단건은 409) · 거부는 주 폴러와 같은 기록 · 여러 대상은 `createVcAuthGate` 로 vCenter 당 **첫 시도 결과를 본 뒤** 나머지를 시작한다
    (동시에 시작하면 틀린 비밀번호가 대상 수만큼 로그인한다 — 재현 112회 → 0). 정지 VM 의 유휴 판정은 null(판정 불가). 웹 문구 `views/vcAuthStopText.js`. **새 주문형 성능 경로도 이 헬퍼로.**
  · **쓰기 범위 판정은 '조회 밖 404 → 쓰기 밖 403' 순서의 한 함수**(C3-02a — 게스트 조사 작업 `guestScanAccess`): 바깥 조건을 `scopedVcenterIds` 로 두면 조회 무제한 + writeVcenters 계정이
    통째로 빠진다. GET 은 조회 범위로 보여 주고 쓰기 밖 작업에 `writable:false` — 화면이 버튼을 잠그고 사유를 말한다.
  · ⚠ **폴링 라우트는 스냅샷 세대 키로 기억하지 말 것**(C6-01 — `/tools/ipam/subnets`): v2.619 '입력이 같으면 원장을 안 만든다' 와 세대 키 캐시가 만나면 새 세대 캐시는 늘 비어
    요청마다 원장·시트를 동기로 다시 만든다(합성 4만 VM 1,041ms → 7.6ms). 원장 입력 지문 `store.ledgerInputSignatureOf` + vCenter·범위·리비전·귀속으로 기억하고 used 는 원장 행에서 센다.
    스캔 lastSeen 최댓값(`_maxSeen`)은 `_agentCount` 와 같은 세 지점(로드·병합·정리)에서 유지한다 — results 를 고치는 새 경로는 둘 다 갱신할 것.
    `vmperfMeta` 는 단독 MIN·MAX 문장(v2.550.3), 행 수는 `vmperfCount`(C6-05).
  · **조회 실패는 `views/readFailText.js` 로 말한다**(C5-02 — 6곳): catch 에서 빈 목록·`{available:false}`·null 로 바꾸면 '0개·패키지 없음' 이라는 틀린 원인이 된다. 폴링 화면은 직전 값을 지우지 않는다.
    범위 계정 저장 응답의 `ignoredGlobal` 은 `views/scopeSaveMsg.js` 로 말한다(C5-03 — '즉시 적용' 이라 말하지 않는다).
  · **결과 문구를 쓰고 곧바로 목록을 다시 읽는 함수를 부르지 말 것**(C5-01 VmCredManager) — 다시 읽기의 초기화가 성공·비밀번호 폐기 안내를 지운다. 문구는 다시 읽기에 넘기고,
    거부(400)면 다시 읽지 않아 입력을 남긴다(판정 `vmCredSaveOutcome`).
  · 범위 관리자에게 GPU 게스트 수집 상태(lastRun·overlay)는 실행 시각과 허용 vCenter 목록만(`scopeGpuGuestStatus` — v2.629 A6-04 와 같은 기준).
  · 남긴 것(4회차 첫 후보): docs/AUDIT-2026-10-10c.md '다음 회차 후보' · 정책 판단 3건(C3-02b·c·d — 원격 터널·GPU 게스트 시험·수집 데이터 삭제의 쓰기 범위) ·
    ✅ 스파크라인의 VM 마다 로그인은 v2.741 LEFT-03 에 vCenter 당 1회 묶음 조회로 고쳤다(`soapClient.js fetchVmsPerfSeries` — v2.742 LEFT-03 정정).
- ⚠⚠ **v2.583 — 전체 소스 감사 확정 42건 + 검증 후속 · 로그 분석 메뉴 · 요청 ID · 개요 물리 서버**(사용자 요청
  "전체 소스 분석해서 버그수정, 취약점 분석, 전체 문서 업데이트 … 지금 분석하고 있는 로그를 분석해서 개선점 도출할 수
  있는 메뉴와 기능을 설정에 만들어줘" · "불러오는 중 … 누가 이 지연을 발생시켰는지 ID 도" · "서버 합계에 물리서버
  수량 안나오는거 수정". 감사는 워크플로 6개 발견 에이전트 + 검증 에이전트 · 회귀는 `test/audit2583.test.js` 외 9개 파일):
  - **로그 분석(`loganalysis/` + 웹 `views/LogAnalysis.jsx`·`logAnalysisText.js`)**: 원천 5가지(누적·링 버퍼·저널·
    붙여넣기·엣지 보관분)를 같은 엔진이 본다. ⚠⚠ **엔진은 태그별 '처음 맞는 규칙 하나' 만 센다 — 순서가 곧 분류다.**
    카탈로그 에이전트가 시뮬레이션으로 확인했다: 코어 `gpu-guest-fail-other`(모든 ✗ 줄)가 앞에 있으면 세부 분류 13개가
    **한 번도 맞지 않는다**. 그래서 `index.js activeRules` 순서는 ① 카탈로그 `early` ② 코어 ③ 카탈로그 ④ 코어 `late`.
    테스트가 **전 규칙의 표본이 자기 규칙에 떨어지는지**(가려짐 0)와 소스에 문장이 실재하는지(probe)를 고정한다 —
    규칙을 더하면 그 테스트가 곧 순서 검사다. 카탈로그(`catalog.js`)는 생성물이다: 에이전트 120개 → 변환 스크립트가
    컴파일·태그 일치·표본 매칭·대상 캡처·probe 실재 다섯을 통과한 118개. ⚠ 저널은 서비스 계정(vmportal)에 보통
    **읽기 권한이 없다** — 빈 출력을 '로그 없음' 이라 말하지 말 것(권한·저널 없음·journalctl 없음을 구분).
    ⚠ 로그 분석은 **로그에 찍힌 것만** 본다 — 이번에 스토리지·SAN·PDU push 실패가 `_last` 에만 있고 콘솔에 없어 규칙을
    만들 수 없었다(고쳤다). **새 push/워커는 실패를 상태 객체와 콘솔 둘 다에** 남길 것(v2.566 규약의 이유가 하나 더 늘었다).
  - **요청 ID(`perf/requestId.js` + 웹 `perfClient.js`·`TaskWho.jsx`)**: 브라우저가 `w<탭 6자>-<순번>` 을 만들어
    `X-Request-Id` 로 보내고 서버가 형식 검사 후 되돌린다(없으면 `s<부팅>-<순번>`). 로딩 표시는 문턱을 넘긴 요청만
    5초에 한 번 `/perf/req-status` 로 묻고 **지연의 주체를 나눠** 말한다 — 처리 중(서버) / 이미 응답(전송·브라우저) /
    기록 없음(미도달·재시작·밀려남 — **단정하지 않는다**). 상태 조회는 소유자 본인만(admin 은 전부).
  - **개요 물리 서버**: 귀속 순서 = 명시 vCenter → 호스트명 → 서비스태그 → 통합 서버 인벤토리 지정 → **vCenter 가 하나뿐인
    DataCenter**. 그래도 못 붙인 서버는 법인 열에 억지로 넣지 않고 데이터센터별 고정 행(`unplacedByDatacenter`)으로 센다.
  - ⚠⚠ **범위 계정 롤업은 '걸러서' 만들지 말고 '다시 계산' 한다**(`store.scopedRollups`): `byRegion` 한 행은 그 지역의
    **모든** vCenter 합이고 `global` 은 전 함대 합이다. v2.582 까지 `/overview` 는 존재하지 않는 `r.region` 으로 걸러 빈
    배열을 주고 `global` 을 그대로 내보냈다(범위 계정이 전 함대 수치를 봤다). `/health` 헤더도 같은 기준이다.
    전 함대 값(iDRAC 등록 수·미매핑 전력)은 범위 계정에 null.
  - ⚠⚠ **'바인딩' 과 '결과' 를 다른 시계로 만료시키지 말 것**(`central/logQueries.js`): 바인딩(소유자·vCenter)이 큐잉
    시각, 결과가 결과 시각 기준이라 바인딩이 **먼저** 지워졌고 라우트의 `if (owner && …)` 가 빈 값으로 검사를 건너뛰었다
    (v2.478 IDOR 가드 우회). 결과가 바인딩을 들고, 라우트는 바인딩이 없으면 **거부**(fail-closed). `if (x && …)` 형태의
    권한 검사는 x 가 비는 경로가 곧 우회로다.
  - **숫자 칸 빈 값**: `Number('') === 0` 이 설정 PUT 으로 가면 서버 clamp 가 하한으로 올려 **보존일이 줄고 이력이 지워진다**
    (bm-usage). 서버는 패치에서 빈 값·0(하한>0)을 미지정으로 버리고(`dropUnspecifiedNumbers`), 화면은 이전 값으로 되돌린다.
    **보존일 env 0 = 전부 보관** 계약도 `Number(x) || d` 가 깨고 있었다(`retentionEnv` — 빈 문자열은 미지정).
  - **키 하나 원칙**: 토큰 점검이 표시 이름·id 를 섞어 유령 행을 만들었다 — 엣지의 키는 **수집 서버 id(= 에이전트 이름)**.
    표시 이름은 id 로 접는다(`collectorAlias`).
  - **무인증 거부 감사 로그는 `util/denyAuditGate.js` 하나**: 출처당 1분 한 줄 + 합친 개수. 잠금 발동 줄은 게이트 없이.
  - **엣지 push 0대**: 위임이 정말 0대면 빈 목록으로 중앙을 비우고, 위임은 있는데 스냅샷이 없으면 보내지 않는다(v2.581
    BUG-D 와 같은 판단 — 빈 목록으로 덮으면 재기동 직후 중앙 화면이 빈다).
  - **시간대**: `toLocaleString('ko-KR')`·`getHours()` 류 로컬 getter 도 프로세스 TZ 를 따른다 — 사람이 읽는 시각은
    `util/dayKey.js localStamp`, 파일명은 `fileStamp`. ✅ `vmtrack/diff.js slotKey` 는 v2.586 에 포탈 오프셋으로 옮겼다 —
    KST 호스트에서는 출력이 **바이트 단위로 같고**(9,600시간 대조 0건), UTC 호스트에서만 전환일에 1회 불연속이 생긴다.
  - **응답 본문 캐시와 제자리 수정**: `util/compress.js` 는 응답 객체 **정체성**으로 본문·ETag 를 캐시한다. 모듈 캐시 원소를
    그대로 `res.json` 하고 나중에 제자리에서 고치면 옛 본문이 나간다(provision saved). **캐시 원소를 응답할 때는 사본**.
  - **화면**: JSX 텍스트 노드의 `**` 는 BoldText 를 안 거친다 — `uiText.test.js` 가 스윕한다(문구 모듈 반환값을 plain 으로
    그리는 경우는 호출부를 봐야 해서 스윕이 못 잡는다 — 정직 기록). V4 셸 CSS(`v4.css`·`console.css`)도 uppercase 금지.
    vCenter 카드 본문은 `views/vcCardText.js` 가 상태별로(대기·점검·비활성·연결 실패) 말한다.
  - ⚠ **정직 기록 — 확인하지 못한 것**: 로그 분석의 서비스 저널 경로는 이 컨테이너에 systemd 저널이 없어 **실패 분기만**
    실제로 확인했다(권한·저널 없음·journalctl 없음). 코드 스캔 규칙 118개는 표본이 합성이고 **실제 운영 로그로 맞춰 보지
    못했다** — 첫 실사용에서 '미분류' 탭에 남는 문장을 보고 규칙을 더할 것.

- ⚠⚠ **v2.586 — 문서의 미해결 기록 정리 + 서버 결함 스윕 확정 5건**(사용자 요청 "버그 아키텍처 개선 수정 등의
  업그레이드 작업" · 선택 "문서의 미해결 기록 우선 + 전체 검증". 회귀는 `test/audit2586.test.js`·`healthWord2586`·
  `ipv4_2586`·`vmtrack` · 웹 `consoleData.test.js`):
  - ⚠⚠ **상태 단어 판정은 `storage/healthWord.js` 하나다(웹 `storageNodeText.nodeHealthKind` 가 같은 정규식을 쓰고
    테스트가 두 구현을 대조)**. 수집기 3곳(Isilon·VPLEX·XtremIO SSH)이 `/ok|healthy|connected/` 처럼 **경계 없는 부분
    일치**라 `disconnected` 가 **connected** 로, `Broken`·`Not OK` 가 **ok** 로 읽혀 비정상 노드가 **정상으로 세였다**
    (오류 없이 틀린 값). 판정 순서: unknown 집합 → 부정(`not ok`·`non-healthy`) → 나쁨 단어 → 좋음 단어(단어 경계) →
    그 밖은 나쁨(모르는 단어를 정상으로 칠하지 않는다). 파트장애 `healthStringState` 도 `\b` 로 고정했다.
  - **IPv4 파서는 `util/ipv4.js` 하나다**(6벌 통합). 가장 느슨한 판본(`ipam/scan.js isIpv4` — IPAM 키 검증기)이
    `Number('') === 0` 으로 `'10..1.1'`·`'10.1.1.'`·16진·지수를 **유효 IP 로 받았다**. ⚠ **선행 0 은 예전 전 판본처럼
    10진수로 받는다** — 거부로 바꾸면 저장된 스캔 범위·override 키가 깨진다(초판이 그렇게 만들었다가 svcmon T35 가
    잡았다). 원문 토큰을 접속처로 쓰는 곳은 `numToIp` 로 정규화하거나 `genspec nonCanonicalIp` 처럼 거부한다.
    부수 효과로 ipam settings↔ledger 정적 순환이 사라져 SCC 5 → 4(`arch2579` 상한도 4).
  - **숫자 칸 빈 값 두 곳 더**(v2.583 `dropUnspecifiedNumbers` 와 같은 계열): vCenter 로그 보관(`logs/settings.js` —
    빈 칸이 `0` = **무제한**이 되어 prune·용량 상한이 '저장됨' 과 함께 멈췄다) · 일일 보고(`reports/dailyReport.js` —
    시각 칸을 비우면 발송이 00:00 으로). 판정은 `numOrNull(v) ?? cur` — **명시적 0 만** 값이다.
  - ⚠⚠ **로그 문자열을 맵 키로 쓰면 프로토타입 오염이다**(`loganalysis/engine.js safeKey`·`own`): `[__proto__] …`
    한 줄이 `st.tags['__proto__']` 로 `Object.prototype.n = NaN` 을 만들었다(실측). 실시간 분석은 콘솔 **전 줄**을
    받는다. 예약 이름은 `(이름)` 으로 바꾸고 조회는 자기 속성만(`toString` 같은 상속 함수에 더하지 않게). 엣지 보고
    병합(`mergeState`)도 같은 규칙 — 입력이 JSON 이어도 `__proto__` 는 자기 속성으로 들어온다.
  - **Unity 버전 후보의 성공 조건은 '버전' 이다(모델 아님)**: `accept` 가 모델만 읽어도 참이라 첫 후보(`svc_diag`)가
    모델만 주는 장비에서 뒤 uemcli 후보 둘이 **한 번도 실행되지 않았다**. 모델은 버리지 않고 원문 표본에서 건진다
    (`extra.modelSource`). ⚠ v2.585 '18대 전부 —' 의 원인인지는 **확인하지 못했다**(가설 — 실장비 출력 필요).
  - **사람이 읽는 시각 5곳 더**(v2.583 규약의 누락): 폴더 사용량 메일 제목·수집 줄(시각이 없으면 '지금' 을 지어내던 것도
    `—` 로) · VM 복제 클론/스냅샷 이름 · DB 이전 스크립트 파일명·README · 배포 성공 힌트 · 릴리스 노트 기본 날짜.
  - **`vmtrack slotKey` 는 포탈 오프셋이다** — 위 '시간대' 항목의 별건을 닫았다. **도메인 타일 메타**는 `waitMeta` 로
    `loadState` 판정을 받는다(V4·관제 콘솔 양쪽). 위 v2.509·v2.583·v2.578·v2.579 의 '남은 것' 줄도 함께 정정했다 —
    **문서의 '남아 있다' 는 다음 점검의 첫 후보이고, 고친 뒤에는 그 줄을 반드시 고칠 것**(이번에 4줄이 이미 고쳐진
    결함을 '남아 있다' 로 적고 있었다).
  - ✅ (당시 확인하지 못한 것) `curUser /settings` 가 범위 계정에 함대 전체 `overLimit`·`push.last.records` 를 줄
    수 있다는 스윕 후보는 **v2.589 SEC-2589-02 에 고쳤다**(범위 계정에 null — v2.590 에 이 줄을 정정).

- ⚠⚠ **v2.589 — 5축 병렬 감사 확정분**(사용자 요청 "아키텍처 점검 개선 버그패치 업그레이드 보안점검" · 선택: 병렬 에이전트
  5개 · 전체 검증 · 확정분 전부 수정. 회귀는 `test/audit2589.test.js` 11건 — 변이 검증: 수정 전 코드로 5건 실패 ·
  웹 `components/errorBoxProps.test.js`):
  - ⚠⚠ **인증에 실패한 요청의 이름을 계측 키로 쓰지 말 것**(`routes/central.js` GET 훅 + `central/pullStats.js
    PULL_UNAUTH_KEY`): v2.587 이 막힌 pull 도 세겠다며 `?agent=`/`X-Agent-Name` 을 믿었더니 **토큰 없는 요청 하나로
    실제 엣지의 기록에 실패가 합쳐졌다**(개별 토큰 엣지면 '검증됨' 행이라 지도에 거짓 장애) · 이름 500개로 LRU 가 실제
    기록을 밀어냈다. 버그·보안·아키텍처 **3축이 독립 재현**했다. 인증 실패는 `(인증 실패)` 한 칸 · 상한 초과 때 검증된
    행은 밀지 않는다. v2.570 `ingestReject` 는 이미 `unverified` 로 분리돼 있었는데 GET 계측만 그 규약을 놓쳤다
    (형제 비대칭 — 새 계측기를 만들 때 **인증 실패 경로의 키**를 먼저 정할 것).
  - ⚠⚠ **IPv4 허용 판정은 '정규형만' 이다**(`util/ipv4.js strictIpv4Num`·`cidrMatch`): v2.586 통합에서 빠진 사본 3벌
    (`rma/commands.js targetAllowed`·`security/credentialStore.js hostAllowed`·`rma/settings.js ipAllowed`)이
    `'010.0.0.5'` 를 10.0.0.5 로 허용했는데 실제 접속의 `dns.lookup`(glibc inet_aton)은 **8진수 8.0.0.5** 로 해석한다
    — RMA SSH 명령·볼트 비밀이 허용 대역 밖으로 나갈 수 있었다. 목록 항목(관리자 입력)은 느슨히 읽고, **접속 대상은
    비정규 표기면 거부**한다. ⚠ 손 grep 스윕(v2.586)은 `ipToInt`·`isIpv4` 이름만 봤다 — 이번 테스트는
    `split('.').map(Number)` 형태를 소스에서 금지한다.
  - ⚠ **`ErrorBox` 는 `message`·`error` 둘 다 받는다**(`components/primitives.jsx`): 26곳이 `error=` 로 넘겨 **빈
    '오류:'** 가 떴고 403 권한 안내·업그레이드 중 '잠시 후 다시' 안내까지 함께 사라졌다(v2.398·v2.459 의 단일 지점
    처리가 그 화면들에서 통째로 무력했다). **`.btn`·`.banner` 는 v2.588 까지 CSS 규칙이 없었다**(37·11곳) — 브라우저
    기본 버튼·맨 글자. 둘 다 새 화면에서 계속 쓰이던 클래스라 **수치로는 안 잡히고 스크린샷으로만** 보인다.
  - **svcmon 파일명·버킷 경계는 포탈 오프셋**(`util/dayKey.js portalParts`·`portalMs`) — 로컬 getter 금지(v2.582
    규약의 누락 지점). KST 호스트는 파일명이 한 글자도 바뀌지 않고 UTC 호스트만 전환 시 1회 불연속이 생긴다
    (v2.586 `slotKey` 와 같은 판단). 테스트의 기준 시각 헬퍼도 같은 기준으로 바꿨다(`svcmonAnalyze.test.js L`).
  - **로그 분석 합산에서 `Object.keys(x).length` 를 루프 안에서 세지 말 것** — 168버킷 × 키 700개에서 1,682ms 로
    이벤트 루프를 막았다(A/B 실측 → 65ms). 오래된 버킷의 `http` 도 상위 100개로 줄인다(무인증 404 경로가 들어온다).
  - 그 밖: 통신 지도 수신 행은 **마지막 수신이 가장 늦은 행**(바이트 순 첫 행 금지) · 삭제된 vCenter 명시 지정은 귀속
    아님(`matchedBy.explicitStale`) · `dayKey` 범위 밖 값은 `''` · 통신 점검의 중앙→엣지 호출도 `recordOutbound` ·
    curuser `overLimit`·`push` 는 범위 계정에 null · `VMSERIES_MIN_FREE_GB` 빈 값은 기본 5GB.
  - 의존성: express 4.22.3 · ws 8.21.3(patch, lockfile 만). `--omit=dev` 신규 critical/high 0. dev 전용 잔여에 **vite high**
    가 있다(dev 서버 전용 — 위 의존성 줄의 수용 목록에 없던 이름이라 적어 둔다).
  - ⚠ 정직 기록: 성능 에이전트는 운영 규모(`MOCK_SCALE=3`) 폴링 라우트 p50 ≤ 1ms · 3단 지도 조립기 선형(30×4,000 에서
    14~17ms)으로 **고칠 것이 없다**고 보고했다 — 없는 결함을 만들지 않았다. 확인 못 한 것: 실엣지 규모의 지도 라우트,
    express·ws patch 의 changelog(전량 테스트로만 확인).

- ⚠⚠ **v2.590 — 6축 병렬 감사(2차 점검) 확정분**(사용자 요청 "한번더" = v2.589 와 같은 "아키텍처 점검 개선 버그패치
  업그레이드 보안점검". 회귀는 `test/audit2590.test.js` 27건 — **변이 검증 6/6**: 수정을 하나씩 되돌리면 그 테스트가 실패한다):
  - ⚠⚠ **`requirePerm` 은 역할을 보지 않는다 — 상태 변경 라우트는 `requireRole` 을 먼저**(D1): IPAM 쓰기 7곳
    (`routes/api/ipamExport.js canWrite`)·`/vms/upgrade-tools` 가 `requirePerm('tools')` 뿐이라 **viewer + tools** 가
    주석·override·정책을 바꾸고 게스트 재부팅 유발 작업을 실행할 수 있었다. `docs/AUDIT-2026-06-27.md` 가 'C2 대부분 수정
    확인' 이라 적은 것이 **틀린 기록**이었다(정정). 테스트는 실제 `api` 라우터를 띄워 상태코드 + `requiredRole` 을 본다.
  - ⚠⚠ **`.gitignore` 는 `server/config/*` 기본 차단 + `!*.example.json`**(D4): 파일 단위 열거라 CONFIG-FILES.md 의
    **33개**가 공개 저장소에 올라갈 수 있었고 `vcenter-order.json` 은 이미 추적 중이었다(추적 해제). v2.575 SEC-12 는
    '고침' 으로 분류됐지만 실제로는 남아 있었다. 테스트가 **문서 전수를 `git check-ignore`** 로 고정한다 —
    새 설정 파일은 이제 자동으로 막힌다.
  - ⚠⚠ **위임 '지금 수집' 요청은 claim→ack 다**(P16, `util/collectRequestQueue.js` — 스토리지·SAN·PDU·SAN 사용량 4큐 공용):
    엣지가 인출하는 순간 지우면 고RTT 회선에서 응답이 유실돼도 '처리됨' 으로 보였다. 결과 push 가 도착하면 `ack`,
    시한 안에 없으면 1회 재인출, 그래도 없으면 폐기하고 `lastDropped` 로 **밝힌다**. 인출 전 수집분(1분 여유)으로는 완료
    처리하지 않는다. **새 위임 큐는 이 팩토리를 쓸 것**(CLAUDE.md 가 v2.290 부터 적은 규약의 네 번째 누락이었다).
  - ⚠⚠ **백업 변경 감시는 상태 파일을 설정으로 보지 않는다**(P1, `backup/service.js isRuntimeStateFile`·`settingsFingerprint`):
    엣지 push·폴러가 쓰는 파일에도 반응해 같은 내용의 change 백업이 보관 슬롯을 채우고 **정기·수동 백업을 지웠다**(엣지가
    많으면 반대로 디바운스가 계속 초기화돼 실제 설정 변경 백업이 한 번도 안 생겼다). 지문이 같으면 생략 · 자동 사유
    (change·startup)는 최대 10개 · 파일명에 사유. ⚠ 8MB 초과 설정 파일은 **조용히 빼지 않고** 결과·번들·화면에 밝힌다(D5).
    복원 전 자동 백업은 설정된 보관 개수를 따른다(P2 — 하드코딩 30 이었다).
  - ⚠⚠ **'못 읽은 값' 은 해소도 정상도 아니다 — 세 곳에서 또 밟았다**:
    · PDU(F5): 장비는 읽혔지만 센서·뱅크 값을 못 읽은 주기를 '정상으로 돌아왔습니다' 로 알렸다. 이제 `readAlertKeys` 로
      **값을 읽은 항목만** 해소 판정하고, 오래(`HOLD_MAX_MS` 6시간) 못 읽으면 알림 없이 끊는다(bmusage 규약과 같다).
    · SAN(F3): `porterrshow` 의 k/m/g 축약 카운터는 **반올림값**이라 `1.2m → 1.2m` 이 '신규 0 — 정상' 이 됐다. 파서가
      `_approx` 를 싣고 포트 행 `errApprox`·`framesApprox` → 기준선 `_approx` → 판정은 **증분 보류(unknown)**, 처리량은
      `fpsHeld:'approx'`. 누적값 표시는 그대로다(누적은 맞다).
    · SAN(F4): REST 스위치 스냅샷은 섹션 키가 달라(`stats`·`media`) 월간 점검이 **이미 받은 광량·에러를 보지 않고**
      '명령이 없거나 권한이 없다' 는 틀린 조치를 줬다(−15.2 dBm 포트가 있는데 종합 '정상(일부 미확인)'). 판정 쪽
      `restHealthSections` 가 SSH 키로 맞추고(구버전 엣지 스냅샷도 고쳐진다) REST 가 조회하지 않는 항목은 그렇게 말한다.
      ⚠ 점검 문구의 **백틱 6곳**도 함께 뺐다(서버 문자열이 BoldText 로 그려진다 — 웹 스윕이 못 보는 자리).
  - **추이 carry-in**(P3·P4·P5): 게스트 디스크는 조회 기간 안에 변화가 없으면 파티션·선이 사라졌다(diff 저장의 이면) →
    기간 시작 전 마지막 행을 `carried:true` 로 싣는다. vmtrack DS 는 1GB 미만씩 늘면 기준이 첫 관측에 고정돼 차트가
    실제에서 계속 벌어졌다 → 비교 기준을 **series 의 마지막 값**으로. prune 은 DS 별 마지막 행(`MAX(rowid)`)을 남긴다.
  - **만료 없는 대기**(P11): 인출하는 엣지가 없는 ping·로그 연합 조회 요청이 영원히 '대기 중' 이었다 → `expired`
    (ping 90초·로그 60초) + 화면이 **'엣지가 가져가지 않았다' 와 '결과가 오지 않았다'** 를 나눠 말한다. 중앙 직접 수집
    vCenter 의 ping 은 엣지 큐에 넣지 않는다(가져갈 엣지가 없다).
  - **svcmon push**(D2): 전 메타를 첫 청크에 몰아 항목 약 5,500개 이상이면 **매 주기 413 · 영원히 needMeta** 였고,
    413 재시도는 뒷부분 행을 오류 없이 버렸다 → `splitSvcmonChunks` 가 메타를 청크마다 나누고 413 이면 스냅샷 전체를
    다시 나눈다. `/api/central/svcmon-report` BIG_JSON 등록. ⚠ 로그 문구를 바꾸면 **로그 분석 카탈로그의 probe 도**
    바꿀 것(`logAnalysis2583` 이 잡았다 — 이번에 실제로 깨졌다).
  - 그 밖: LLM URL SSRF 검사(D6) · 로그 분석 붙여넣기 BIG_JSON 게이트 등록 · 전원꺼짐 점검이 수집 대기·연결 실패 vCenter 의
    'VM 0개' 를 전부 꺼짐으로 세던 것(P6) · VM 복제 일일 스케줄 포탈 오프셋(P8) · 스토리지 보존일 env 출처(P9) · 로그 DB
    크기에 -wal · VACUUM 뒤 체크포인트(P10) · 같은 수집 시각 용량 표본 이중 계수(P12) · 볼트 사용 기록 종료 flush(P13) ·
    업그레이드 체크포인트 하위 디렉터리(P14) · 원시/롤업 보존일 분리 prune(P15) · RMA outbox 가 보내는 중 추가분을 지우던
    것(P17) · DB 점검 quick_check 가 512MB 초과 파일에서 루프를 막던 것 → 생략하고 밝힌다 + 동시 점검 가드(P7) ·
    Horizon 이름 목록 절단 시 전체 사용자 **하한값**(F8) · Isilon 경보 절단·이벤트 절 부재(F10) · 베어메탈 NIC·HBA 사용률
    방향별 최대(F9 — rx+tx 합을 한 방향 속도로 나눠 최대 2배) · `/proc/stat` guest 이중 계수(F11) · HAProxy 백업 파일명(D9).
  - ⚠⚠ **인증 실패 정지 가드가 vCenter·iDRAC·NSX 에 없었다 — 가장 많이 로그인하는 수집기였다**(수집기 축 F1 high ·
    `vcenter/restClient.js vcAuthGuard`·`idrac/poller.js`·`nsx/client.js` + SSH 5종. 상세·남은 것은 `server/CLAUDE.md`):
    server/CLAUDE.md 가 v2.541 에 '아직 가드가 없다' 고 적은 목록에 **이 셋은 들어 있지도 않았다**. 28개 vCenter 계정이
    30초마다 로그인하므로 비밀번호가 바뀐 구간에 **서비스 계정이 잠긴다**. 회귀 테스트는 가짜 vCenter(SOAP
    InvalidLogin + REST 401)·Redfish·NSX·ssh2 서버로 **실제 로그인 시도 수**를 센다(다음 주기 0회 · 자격증명 변경 시
    재개 · 수동 실행은 시도 · 연결 거부는 멈추지 않음). 변이 14종 중 13종 검출(나머지 1종은 문구 기반 이중 방어).
    · 함께 드러난 결함: `redfish.get` 의 401 문구에 숫자가 없어 bmusage 가 **401 을 '연결 불가' 로 분류**했다.
  - **vCenter 수집 데드라인이 세션을 실제로 끊는다**(docs F7 — v2.417 규약의 vCenter 누락. PERF-AUDIT-2026-09-13 §4 미해결):
    `store.collectWithDeadline` 이 AbortController 로 abort 하고 SOAP·REST 요청 신호는 `AbortSignal.any([건별 시한,
    외부 신호])` 다. 예전 `Promise.race` 는 결과만 버리고 남은 SOAP 왕복을 계속해 다음 주기가 같은 vCenter 에 두 번째
    세션을 열었다. 로그아웃은 외부 신호를 무시하고 끝까지 정리한다. 테스트가 서버 쪽 소켓이 약 300ms 에 끊기는 것을 본다.
  - **iDRAC 센서 실패가 '표본 0' 으로 숨던 것**(F7): `fetchSensors` 가 모든 실패를 삼켜 v2.493 센서 진단·v2.548 팬 컬렉션
    실패 표시가 도달 불가였다 → Chassis 루트 실패는 던지고 Thermal 전부 실패면 `thermalOk:false` + `sensorError`.
  - **SAN '헬스 경보 없음' 은 상태를 읽었을 때만**(F6): 못 읽으면 `health.alerts` 가 0 이 아니라 null 이고 KPI 가
    '헬스 상태 미확인 N대' 를 말한다(REST 는 상태를 조회하지 않아 **언제나** 0 이었다).
  - **웹 전수(159경로 × 1440/400 · admin·operator·viewer, 약 400회 로드) 확정 8건**:
    · ⚠⚠ **W1 폴러 상태의 `lastRun`·`lastCheck` 는 `{ at, … }` 객체다**(metrics·ipscan·gpu·upgrade) — `health/services.js` 가
      숫자로 빼 `최근 NaN분 전` 이었고, **`NaN > 30분` 이 항상 거짓이라 지표 샘플러가 멈춰도 '정상'** 이었다(`atOf`).
      새 상태 헬퍼를 소비할 때 **모양을 먼저 확인할 것**.
    · ⚠⚠ **W2·W3 관리자 전용 조회 실패를 삼키면 거짓 초록·거짓 결함이 된다**: 긴급중단 화면은 operator 가 상태를 못 읽어
      **전 수집이 멈춘 상태에서 '🟢 정상 — 수집 동작 중'** 을 봤다(이제 '❔ 확인하지 못했습니다' + AccessDenied). DS 사용량
      'DataCenter별' 은 법인 목록 403 을 삼켜 **전부 '⚠ 법인 미지정'**(설정 결함처럼 읽힌다) → '법인 정보를 읽지 못함' + 사유 배너.
      `.catch(() => {})` 로 끝나는 관리자 전용 조회를 새로 만들지 말 것 — **'못 읽음' 을 기본값(비활성·미지정)으로 칠하는 것**이다.
    · W4·W5·W6·W7 400px: 메일 설정 표 772px(`STable minWidth`) · `.cols-2/.cols-3` 좁은 폭 트랙 `minmax(0,1fr)`(v2.576
      `.vc-grid` 와 같은 결함 — 2화면) · IPAM 도구줄 579px + 세로 글자 버튼 · 서버 분석·네트워크 체크·vCenter 포트 버튼 행 wrap ·
      3D 토폴로지 `flex:none` · 인사이트 카드 `minWidth:0` · 알람 핫스팟 2열 고정 · 디스크 트렌드 `minmax(min(380px,100%),1fr)` ·
      특수 기능 카테고리 오른쪽 패널이 **폭 2px 로 사라지던 것**(`.toolcat-grid` 좁은 폭 1열 — 넘침 0 이라 수치로는 안 잡혔다).
    · W8 NIC 속도·모델 '대상' 이 **수집된 행 수**라 `대상 0 · 수집됨 0 · 미수집 204` 로 스스로 모순 → `collected + missing`
      (필터 버튼의 행 수는 `rowCount`).
  - **런타임·의존성**(15분 장시간 실행 · 운영 규모 `MOCK_SCALE=3` · 힙 스냅샷 비교 — **누수 없음**(9분 +0.2MB), `.db` 핸들
    47 고정): ⚠ **30초마다 `store.refresh` 에서 200~360ms 정지** 원인은 `ledgerSignature` 의 문자 단위 djb2 JS 루프였다
    (내용이 그대로여도 매 틱 전량) → 네이티브 sha1(43ms → 13~26ms). 더 줄이려면 '수집 변동 없는 틱은 syncLedger 생략' 이
    있지만 외부 ipam.db 리더의 신선도 계약을 바꾸므로 **사용자 결정 사항**이다(측정하지 않았다). ⚠ **CI 는 root 를 audit 하지
    않는다** — root `concurrently` 9.2.1 이 `shell-quote` critical 2 를 핀하고 있었고 아무도 몰랐다(9.2.4 로 0). 새 dev
    도구를 root 에 넣으면 `npm audit`(root)도 볼 것. 범위 안 전이 업데이트는 사본에서 테스트·빌드·Chromium A/B 로 확인 후 적용했다
    (three 0.184→0.186 은 semver 를 따르지 않는다 — 3D 화면은 1회 렌더 확인까지만). `ldapjs`(AD 로그인)는 상류가 **decommissioned**
    로 표시했다(정보 — 보안 수정이 더 나오지 않는다).
  - ⚠ **API 문서 생성기는 '선언 줄 끝의 주석 + 다음 줄 핸들러' 를 게이트로 읽는다** — 이번에 `async` 가 '뜻 모르는 게이트' 로
    실렸다. 라우트 선언에 주석을 붙이려면 **선언 위 줄**에 둘 것.
  - 문서: 이미 고친 것을 '아직'·'후속' 으로 적은 줄 2개 정정 · AUDIT-2026-09-21 표 누락(BUG-17·18·21)·SEC-12 분류 정정 ·
    문서의 원시 NUL 바이트 2개 제거(grep 이 문서를 바이너리로 취급했다).
  - ⚠⚠ **테스트용 SSH 호스트 키에 `ssh2.utils.generateKeyPairSync('ed25519')` 를 쓰지 말 것**(v2.590 **릴리스 CI 가 이것으로
    실패했다** — PR CI·로컬은 통과): ssh2 1.17.0 의 그 생성기는 **자기 파서가 거부하는 키**(`Malformed OpenSSH private key`)를
    **5,000회 중 26회(0.52%)** 만든다(실측 재현). `authStop2590` 은 서버를 4개 띄워 실행당 약 **2.1%** 였다. Node
    `crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1'})` 의 **SEC1 PEM** 은 5,000회 0회다(`credentials`·
    `sanSwitchTest2421` 은 RSA PKCS1 PEM — 역시 안전). 제품 코드는 이 생성기를 쓰지 않는다(grep 0건).

- ⚠⚠ **v2.591 — 7축 병렬 감사(3차 점검) 확정분**(사용자 요청 "한번더" = v2.589·v2.590 과 같은 "아키텍처 점검 개선 버그패치
  업그레이드 보안점검" · 같은 릴리스에 "데이터 흐름 지도 메인 연결 만들어줘". 회귀는 `test/audit2591.test.js` 33건 — **변이 검증 21/21**
  (수정을 하나씩 되돌리면 그 테스트가 실패한다) + `test/authStop2591.test.js` 24건(변이 24종 중 23종) ·
  웹 `consoleData.test.js`·`dataFlow.test.js`·`collectDropText.test.js`·`emptyInvText.test.js`):
  - ⚠⚠ **v2.590 P16 claim→ack 큐는 두 시계를 비교하고 있었다 — 기준선은 '엣지가 보낸 마지막 collectedAt' 이다**
    (`util/collectRequestQueue.js`, R-Q1·PR-3): 완료 판정이 `collectedAt(엣지 시계) >= takenAt(중앙 시계)` 라 엣지 시계가
    60초 넘게 늦으면 요청마다 장비를 두 번 수집하고 결국 조용히 폐기했다. 이제 인출 시점에 **그 장비의 마지막 collectedAt**
    을 기준선으로 잡고 **그보다 새 수집**만 완료로 본다(시계를 섞지 않는다). 중앙 재시작 직후에는 보관 중인 엣지 스냅샷의
    수집 시각(`baseOf` — 엣지 수신 모듈이 `set*BaseResolver` 로 등록. 순환 import 를 피하려고 주입한다)이 기준선이다.
    · **인출은 엣지 처리량만큼**(`TAKE_MAX` 20 — 엣지 설정 pull 이 20대만 처리한다). 넘겨 인출하면 나머지가 시도 없이 시한을 먹었다.
    · **시한은 개수에 비례**(`ackMs + n × perItemMs`, perItem = 그 도구의 장비 시한) — 순차 수집 5대 × 3분이 10분 시한을 넘겼다.
    · 폐기는 `drops`(최근 20)로 남고 목록 라우트 3종이 `collectDrops` 로 싣는다 — 화면이 '결과 없이 폐기됨(수집됐다는 뜻이
      아니다)' 를 말한다(`web/src/views/tools/collectDropText.js`). v2.590 은 `lastDropped` 를 만들고 **아무 데도 노출하지 않았다**.
  - ⚠⚠ **수신 집계의 이름은 인증된 agent 가 먼저다**(`routes/central.js` POST 훅 · `central/ingestStats.js`, PR-1·PR-2):
    본문 `agent` 를 그대로 Map 키로 써서 ① 인증된 엣지 하나가 긴 문자열로 중앙 메모리를 밀어 올렸고(데이터 흐름 지도가 10초 정지
    뒤 500) ② 개별 토큰 엣지도 '(unknown)'·남의 이름으로 그려졌다. 개별 토큰이면 `auth.agent`, 공유 토큰이면 주장된 이름을
    64자로 자르고 `verified:false`. 라우트별 요약은 `res.locals.ingestSummary` 로 넘긴다(라우트가 recordIngest 를 두 번 부르지 않게).
    v2.589 GET 계측(`PULL_UNAUTH_KEY`)과 같은 판단의 POST 쪽 누락이었다.
  - **본문 파서 413·400 도 거부 기록에 남긴다**(`index.js` 전역 오류 처리기 → `recordReject`, `too-large` 종류 — PR-6).
    '보냈는데 막혔다' 가 중앙 어디에도 안 보이던 경로다. 위임 워커 3종(ping·capture·bmstor)은 **HTTP 오류 응답**도
    `_last` + 콘솔에 남긴다(`httpFail`·`postResult` — v2.574 IMP-07 은 catch 경로만 고쳤다, PR-5). 설정 pull 6종·capacityPush 의
    403 도 콘솔에 남긴다(`util/logThrottle.js createChangeLogger` — 같은 사유는 10분에 1줄, PR-7).
  - **svcmon 메타 구멍**(PR-4): sig 가 같으면 메타를 다시 요청하지 않아, 청크 유실로 일부 행의 메타가 비면 영원히 비었다 —
    행 중 메타 없는 것이 하나라도 있으면 `needMeta`.
  - ⚠⚠ **'못 읽은 값' 을 정상·0 으로 칠하지 않는다 — 이번에도 네 곳**:
    · 개요 물리 서버(C4): `physical`(iDRAC 대수·코어·메모리)이 범위 계정에도 **함대 전체 값**이었다(같은 화면이 70대와 9대를
      동시에 말했다). `serversByCorp(…, { onAttributed })` 로 **같은 귀속 판정**을 받아 허용 vCenter 귀속 서버만 다시 집계한다
      (판정을 호출부에 복제하지 말 것). `matchedBy` 는 범위 계정에 null, `disabled` 는 범위 안에서 다시 센다.
    · V4·관제 콘솔 SAN(C9)·스토리지(P2): 수집 실패 스냅샷의 `ports`·`capacity` 는 emptySnapshot 초기값(0)이다 — 초록 '0/0'·
      '0.0 TB · 노드 0' 이 됐다. 실패는 `failed` 로 따로 세고(`sanTotals.failed`) 용량은 전체가 양수일 때만 싣는다.
    · 데이터 흐름 '내부 수집'(C1): 최상위 `{at, ok:false, reason}` 모양(selfRegister·pdu push)을 못 봐 실패가 초록이었다.
      ISO `generatedAt` 도 읽는다(⚠ 숫자 문자열은 Date.parse 에 넘기지 않는다 — v2.562).
    · 빈 인벤토리(C8): `storeStatus` 의 vCenter 별 호스트·VM 이 **항상 null** 이었고 웹이 0 으로 합산해 '빈 vCenter — 이상이
      아닙니다' 로 **확신 판정**했다. 스냅샷 원소로 세고, 하나라도 모르면 판정 보류(⑨).
  - **epoch ms 숫자를 Date.parse 에 넘기지 말 것**(C2, `consoleData.tsMs`): 스토리지 `collectedAt` 은 숫자인데 `ageText` 가
    `Date.parse` 만 받아 방금 수집한 장비가 '—'(미수집)였고 정렬도 무효였다.
  - **물리 메모리 'GB' 는 vCenter 카드와 같은 이진 단위**(C6): vCenter 의 'GB' 는 실제로 GiB 인데 물리는 10진으로 바꿔 같은
    카드의 두 값이 7.4% 어긋났다(주석은 '같은 단위' 라 적었다 — 반대였다).
  - **VM 상세 ping 은 만료를 볼 때까지 폴링한다**(C7): 웹이 33초에 폴링을 끊어 서버의 90초 `expired`(v2.590 P11)를 볼 수 없었다.
    전부 끝난 상태(up·down·error·expired)가 되면 멈추고 최대 2분. 요청 직후의 `unknown` 은 15초 동안 '확인 중' 이다.
  - ⚠⚠ **lifecycle 축(21분 장시간 실측 · 누수 없음) 확정분**:
    · 스토리지 단건 수집(L1)은 같은 장비가 수집 중이면 **새 세션을 열지 않는다**(SAN·PDU 는 이미 그랬다 — 형제 비대칭).
      라우트는 409 `busy`. 예전 주석 '1대 한정이라 안전' 은 틀렸다(같은 어레이에 세션 2개 · 옛 결과가 새 스냅샷을 덮음).
    · ⚠⚠ **setInterval/setTimeout 은 24.8일(2^31−1ms)을 넘으면 1ms 가 된다**(L2·L3): 백업 '매 30일' 이 3초 만에 보관 슬롯
      30개를 같은 내용으로 교체했고, 업그레이드 확인 주기 43,200분이 2초에 원격 확인 1,331회를 냈다. 긴 주기는
      `util/longTimer.js every()`(조각 타이머) · 업그레이드 주기는 1분~7일 클램프 + tick 재진입 가드. **사용자가 정하는 주기를
      setInterval 에 넣을 때는 상한을 먼저 볼 것.**
    · 자동 백업 성공이 '건너뜀' 으로 기록됐다(L5 — v2.590 회귀): `createBackup` 의 `skipped` 는 성공에서도 **배열**(D5)인데
      `if (m.skipped)` 로 판정했다 → lastRun 이 영원히 비고 서비스 점검이 '백업 없음'. 생략은 `m.skipped === true` 뿐.
    · 호스트 접근 자동 되돌림(L6): 확정이 진행 중이면 revert 가 busy `{ok:false}` 를 **반환**(throw 아님)해 조용히 버려졌다 —
      pending 이 남아 있으면 2초 뒤 다시 본다.
    · svcmon CSV 종료 flush(L7): 스트림이 없으면 대기 행을 버렸고(첫 flush 전 100행 → 파일 없음), 있으면 write 직후 exit 해
      백프레셔 조각이 잘렸다(60,000행 → 573행). 스트림이 없으면 동기로 붙이고, 정상 종료는 `closeCsvLogAsync` 로 finish 를 기다린다.
    · `central-fleet.json`(L8) 주기 저장이 대상 파일 직접 쓰기였다 — tmp + rename, 쓰는 중 종료도 동기 원자 flush.
    · 기동 스태거 전 reschedule(L9)이 만든 interval 이 start* 에서 고아가 됐다(metrics·gpu-guest·ipscan) — start* 가 먼저 지운다.
    · SAN 사용량·베어메탈 사용률·HAProxy 경로 점검 폴러(L10)에 설정 변경 리스너가 없어 주기를 줄여도 옛 주기(최대 6시간)가
      지나야 먹었다(v2.409 규약의 누락 — vmseries·curuser 는 있었다).
  - ⚠⚠ **보안 축**: ChatOps(S1)가 `inv.*` 권한 없이 원본 VM 객체·호스트·DS·경보 이름을 줬다 — v2.583 `/search/nl` 게이트의
    형제 누락. 결과 종류→권한 표는 `llm/nlSearch.js NL_ENTITY_PERM` **하나**가 소유하고 두 곳이 쓴다(표가 두 벌이면 한쪽에만
    종류가 는다). 권한 없는 종류는 `search.withheld` 로 밝히고, 컨텍스트의 이름은 '(권한 없음 — 이름 생략)' 이다(개수는 대시보드 수준).
    로그 분석 붙여넣기(S2)가 이벤트 루프를 24초 멈췄다 — 템플릿 정규식의 무제한 앞보기(`(?=[\w.-]*\d)`)가 단어 경계마다 끝까지
    훑어 O(n²) 였다(`{0,80}` 로 묶어 4,000자 23ms → 2.5ms, 결과 동일). 분석 루프도 줄 수만이 아니라 **시간(25ms)** 으로 양보한다.
    **정규식에 무제한 `[…]*` 앞보기를 쓰지 말 것** — 경계마다 재시작하는 패턴이면 곧 초선형이다.
  - 회귀 방지 기록: `R-B1` 실제 설정 파일 2개(`svcmon-log.json`·`agent-assignments.json`)가 v2.590 에 '상태 파일' 로 분류돼
    편집해도 변경 백업이 안 생겼다(`SETTINGS_NOT_STATE`) · `R-D1` 정합성 점검을 생략한 DB 를 '정상' KPI 로 셌다(`uncheckedCount`) ·
    `R-G1` 게스트 디스크 carry-in 이 **제거된 파티션**을 되살려 '축소 후보(safe)' 를 냈다(`currentPartPaths` → `removed`) ·
    `R-H1` 지표 샘플러 점검이 주기 30분 초과 설정에서 거짓 warn · `R-P1` 점검중(maintenance) 위임 vCenter 를 ping 이 '직접 수집' 으로 오판.
  - ⚠⚠ **packaging 축**(게시된 v2.590 자산으로 재현):
    · **Windows 패키지가 `DEFAULT_ADMIN_PASSWORD=admin123` 을 배포했다**(P1 high) — 리눅스는 2026-06-27 H4 에 고쳤는데 Windows
      예제만 남았다(형제 비대칭). 인바운드 4000 을 여는 수집기라 정당한 관리자보다 먼저 로그인한 사람이 자기 OTP 를 등록해
      계정을 가져갈 수 있었다. 예제는 주석 처리한 빈 값이고 `config.js` 기본값도 `''` 다(ENV.md 에 그대로 실린다).
    · **Windows 빌드가 빌드 머신의 `server/config` 를 통째로 담았다**(P2) — 게시된 zip 에 CI 의 `auth-secret`·`audit.ndjson`·
      내부 IP 가 있었다. CONFIG_DIR 없이 앱 폴더에서 실행하면 그 공개 키로 세션 토큰을 위조할 수 있다. offline 빌드의 L-9
      정리와 같은 `find` 를 넣었다. **새 패키지 빌드 스크립트를 만들면 이 정리부터 복사할 것.**
    · push 경로의 `X-Bundle-Sha256` 은 **자기신고 해시**다(P6) — 손상·잘림만 잡고 토큰 탈취·중간자는 못 막는다. 주석·
      server/CLAUDE.md 의 과장된 주장을 정정했다(진짜 무결성은 수신측 키 서명 — 별건).
    · in-app 업그레이드가 **하드링크를 버리고 모드를 0644 로** 썼다(P4 — `sshcrypto.node` 소실 → ssh2 가 JS 폴백). 하드링크는
      앞서 나온 대상의 사본, 실행 비트만 옮긴다. ⚠ **심링크는 계속 건너뛴다** — 심링크 뒤에 그 아래 경로의 파일이 오면
      `path.resolve` 검사를 통과한 채 스테이징 밖에 쓴다(zip slip 의 심링크 변형).
    · 스테이징 쓰기 실패가 `.new.<ts>` 를 남겨 자동 적용 재시도마다 디스크 부족이 악화됐다(P7) · install.sh(초)와 in-app(ms)
      백업 시각을 그대로 비교해 가장 최근 수동 재설치 백업이 먼저 지워졌다(P8 — 11자리 미만은 초로 본다) · 오프라인
      패키지에 `otp-enroll.sh` 가 없어 문서의 잠금 복구 도구가 설치되지 않았다(P5).
  - **데이터 흐름 지도 MAIN 연결**(`dataFlowLayout.js mainSummary·edgeDirections` + `DataFlow.jsx`, 사용자 요청 "데이터 흐름
    지도 메인 연결 만들어줘" — 선택: **데이터 방향** · 전체 검증 · v2.591 에 함께):
    · 방향은 **데이터가 가는 쪽**이다 — 엣지 → 메인 = push·결과 회신·**메인이 가져옴(cpull)**, 메인 → 엣지 = 설정·자료 pull·
      작업 인출·메인이 보냄(cpush). 시안은 cpull 을 '메인 → 엣지' 에 두었는데 사용자가 고른 기준으로 옮겼다. 엣지 카드의
      '↑ 올림 · ↓ 가져감 · ⇄ 중앙 호출' 은 **요청한 쪽** 기준이라 축이 다르다 — 범례가 그 차이를 말한다(합치지 말 것).
    · 선 색 = 그 방향 연결 중 가장 나쁜 상태, **기록이 없으면 회색 점선**(정상 아님). 판정은 `edgeDirections` 하나이고 카드·선·
      상세 표가 같은 값을 쓴다. `UP_KINDS ∪ DOWN_KINDS` 는 서버 KINDS 6종과 같아야 한다(테스트 고정 — 종류를 늘리면 여기도).
    · 엣지는 **2열**이다. 오른쪽 열은 곧은 선, 왼쪽 열은 열 사이 통로(NEAR·FAR)로 내려가 **그 카드 아래 행 간격**을 지난다 —
      테스트가 1·7·8·28곳에서 선이 어떤 카드도 가로지르지 않음과 통로 세로선이 겹치지 않음을 선분 단위로 고정한다.
      ⚠ MAIN 카드는 **마지막 행 아래 간격까지** 내려와야 한다 — 자체 테스트가 잡았다(빼면 마지막 행 왼쪽 선이 허공에 꽂혔다).
    · ⚠ flex 안의 점(`Dot`)에 `flexShrink:0` 이 없으면 좁은 칸에서 **세로 막대로 찌그러진다**(v2.591 스크린샷 판독에서 발견 —
      수치로는 안 잡혔다). MAIN 카드 칸은 '전' 을 뺀 짧은 표기(`12초`)이고 열 머리가 '경과' 다.
    · ⚠ 정직 기록: Chromium 검증은 **실제 경로 목록 + 합성 엣지 1·8·28곳**(route 가로채기)로 했다 — 실엣지 규모의 실제
      링크 분포는 보지 못했다.
  - ⚠⚠ **인증 실패 정지 가드 확장**(authguard-rest 축 F1~F7 + R-N1·R-BM1·R-BM2, 상세는 `server/CLAUDE.md` 'v2.541' 절 — 회귀
    `test/authStop2591.test.js` 24건이 가짜 vCenter·Redfish·SSH·SMTP 로 **실제 로그인 시도 수**를 센다): vCenter 보조 수집기 7종이
    주 폴러 정지를 **읽기만** 하고 · 게스트 계정 거부는 vCenter 거부가 **아니며** · 여러 대상을 같은 계정으로 도는 조사는
    **회로 차단기**(연속 3회) · iDRAC 대역 스캔·SMTP·네트워크 모니터도 멈춘다. ⚠ v2.590 이 '가드 없음' 목록에 넣은 `metrics` 는
    오탐이었다(스냅샷만 읽는다) — 목록을 쓸 때 **로그인 호출이 실제로 있는지 import 부터** 볼 것.
  - **iDRAC 인증 캐시**(L4, `idrac/redfish.js`): 512 **FIFO** 라 대상이 그보다 많으면 순차 폴링에서 전부 밀려났고, 세션 전용 iDRAC 에
    매 주기 새 세션을 만들고 지우지 않았다(재현: 600대 → 회차마다 600개). **LRU**(조회 성공도 뒤로) · 상한 `IDRAC_AUTH_CACHE_MAX`
    기본 4096 · 밀려나거나 바뀐 세션은 **DELETE**. ⚠ 크기 상한이 있는 캐시는 **등록 규모와 비교해** 정할 것(v2.503 snapCache ·
    v2.581 vmperf 와 같은 교훈의 네 번째).
  - **RMA 결과 회신**(PR-9): `resilientFetch` 는 비-2xx 를 throw 하지 않는다 — `.catch` 만 두면 413·403 이 무음이다(형제 워커 3종은
    v2.591 PR-5 가 고쳤다). `/api/central/rma-result` 도 BIG_JSON 에 등록했다. **`resilientFetch` 결과는 `r.ok` 를 볼 것.**

- ⚠⚠ **v2.593 — 7축 병렬 감사(4차 점검) 확정분**(사용자 요청 "아키텍처 점검, 개선, 버그 개선, 튜닝, 업그레이드 찾아서 진행, 문서화" ·
  선택: 병렬 에이전트 7축 · 전체 검증 · 범위 안 patch/minor 만. 발견 30 = 확정 22 · 가능성 5 · 반증 3, 고침 23. 회귀는
  `test/audit2593.test.js` 17건 — **변이 검증 18/18**(고친 파일을 하나씩 되돌리면 해당 테스트가 실패한다). 상세 `docs/AUDIT-2026-09-24.md`):
  - ⚠⚠ **세션을 만드는 캐시는 키마다 생성을 한 번으로 묶는다**(`idrac/redfish.js SESSION_INFLIGHT`, R2593-01 — v2.591 L4 의 회귀):
    같은 iDRAC 에 여러 수집(폴러·bmusage·파트장애)이 동시에 캐시를 놓치면 각자 세션을 만들고, 뒤 요청의 `touchAuthCache` 가
    앞 요청의 세션을 DELETE 해 앞 요청이 **거짓 401** 을 받았다 — 그 401 한 번이 v2.590 authGuard 로 **멀쩡한 서버의 주기 수집을
    멈춘다**. 진행 중인 생성을 공유하고, 캐시 토큰의 401 은 그 사이 바뀐 새 토큰으로 한 번 더 본다. **세션을 지우는 캐시를
    만들 때는 '그 세션을 지금 쓰는 요청이 있는가' 를 먼저 답할 것.**
  - ⚠⚠ **압축 해제 상한은 '해제된 스트림' 이 아니라 '만들어지는 사본' 까지 센다**(`upgrade/archive.js parseTar`, R2593-02 —
    v2.591 P4 의 회귀): 하드링크는 헤더 크기가 0 이라 gunzip `maxOutputLength` 가 원본을 한 번만 센다 — 20KB tgz 가 1.22GB 로
    풀렸다. 사본을 만드는 **동안** 누적 크기·개수를 센다(v2.488 L-1 · v2.577 의 연장). 복사로 늘어나는 모든 전개에 같은 규칙.
  - **폐기는 시한 초과만이 아니다**(`util/collectRequestQueue.js`, R2593-03): 한 번도 인출되지 않은 채 TTL 이 지난 요청이 drops 없이
    사라졌다 — 엣지가 꺼져 있을 때(가장 흔한 경우)가 화면에 안 보였다. 사유 `untaken`·`requeued-expired`·`no-result` 를 나눠 싣고
    `collectDropText` 가 조치(엣지 상태를 보라 / 장비 수집 오류를 보라)를 나눠 말한다.
  - **계측 상한의 '검증된 행 보호' 는 POST·GET 둘 다**(`central/ingestStats.js`, R2593-04 — v2.589 pullStats 의 형제 누락).
  - ⚠ **카드가 adminOnly 여도 API 는 아니다 — 주소는 역할로 가린다**(`routes/api/relaytopo.js maskTopology`, AUTHZ-01):
    `/tools/relaytopo` 가 tools 권한(operator 기본 보유)으로 전 사이트 IP·SSH 계정명을 줬다. 비-admin 은 주소·계정을 비우고
    `addressHidden`·`issueCount`(점검 문구에 주소가 들어가 개수만)로 밝힌다. **`export` 를 라우트 등록 함수 안에 두지 말 것** —
    이번에 그렇게 넣었다가 모듈 전체가 SyntaxError 가 됐다(`node --check` 는 잡지 못했고 테스트가 잡았다).
  - **대리 도달성 확인은 '그 화면이 보내는 값' 으로 좁힌다**(`/tools/ip-ping`, AUTHZ-02): 범위만 보고 IP 는 무엇이든 받았다 —
    그 vCenter VM 에서 수집된 IP 만 받고 뺀 개수(`rejected`)를 밝힌다.
  - **ack 는 성공해야 '적용 완료' 다**(`agent/svcmonConfigPull.js`, EDGE-1): ack 전에 appliedSig 를 세워 ack 한 번 유실이 중앙 배정을
    **영원히 pending** 으로 만들었다(다음 pull 이 unchanged 라 다시 ack 하지 않는다). ⚠ `resilientFetch` 는 비-2xx 를 throw 하지
    않는다 — 결과의 `r.ok` 를 볼 것(v2.591 PR-9 의 형제 두 곳 `agent/scanner.js`·`idracScanWorker.js` 도 이번에 상태에 실었다).
  - **'못 읽은 값' 을 0 으로 — 이번엔 REST 스토리지 5종과 GPU**(DATA-01·02·04): `Number(x) || 0` 이 사용량 결측을 0 으로 만들었다
    (v2.561 은 SSH 적재 지점만 고쳤다 — **수집기 쪽 원천**이 남아 있었다). MIG `utilNA` 는 사용률 null + 플래그로 싣고 호스트 대표값에서
    뺀다. ⚠ 보고된 0 은 값이다 — 테스트가 둘을 모두 고정한다.
  - **분모가 0 인 사용률은 0% 가 아니라 '—'**(Overview, DATA-05) · '준비 중' 도구 주소는 안내를 보인다(UI-01) · 기능 플래그로 꺼진
    탭 주소도 안내를 보인다(UI-02 — ⚠ `isAllowed` 에서 `health` 를 보지 말 것: 그 함수는 health 선언보다 먼저 실행돼 TDZ 가 된다) ·
    상태바는 720px 이하에서 2×2(UI-03).
  - **튜닝**: `listNotes` mtime 캐시(1.9MB 읽기·파싱 23~48ms → 0) — 저장 경로는 캐시를 직접 버린다(같은 ms·같은 크기 저장 대비).
  - **아키텍처**: `util/ping.js` 손 풀 → `poolRun`(concurrency 0 이면 0 워커 — v2.579 ③-b 와 같은 결함) · `upgrade.js cmpVersion` →
    `cmpVersionTuple` · `ipam/scanStore.js` IPv4 사본 → `util/ipv4` · `arch2579` 가 `export … from` edge 도 센다(순환 SCC 는 여전히 4) ·
    CI 가 루트 `npm audit` 도 본다 · dompurify 3.4.16.
  - **남긴 것(판단 필요 — 다음 점검의 첫 후보)**: ① ✅ **DISCONNECTED 호스트가 사용률 분모에만 남는다**(→ v2.594 `store.js usageReadable` 로 고침 — v2.613 에 이 줄을 정정) ② ✅ **30초마다 IPAM 원장 재구성·서명 50~85ms**(→ v2.619 입력 지문 생략으로 고침 · PERF-1 —
    외부 ipam.db 리더 신선도 계약, 사용자 결정) ③ PDU·SAN push 0건 조기 반환(EDGE-3 — v2.583 설계 · ✅ v2.613 EDGE2613-04 에 상태 전용 push 로 고침) ④ ✅ 손으로 쓴 풀 7곳 더(v2.594 에 '결함 아님' 판정 — 목록에서 뺀다)
    (`ping/monitor.js`·`bmstor/collect.js`·`idrac/redfish.js` 2·`idrac/scan.js`·`deployLlm.js` 2·`certMonitor.js` — 호출부가 전부
    고정값·클램프라 잠재) ⑤ 버전 비교 사본 3곳(`bundleSource.js cmp3`·`dlsource.js cmp`·`release-notes.js cmpVersionDesc` — 입력이
    정규식 검증된 값) ⑥ IPv4 류 사본 3곳(`ipam/insights.js`·`netmap.js`·`ledger.js` — /24 기준 문자열이라 IP 파서가 아니다).
  - ⚠ 정직 기록: 실장비(iDRAC 동시 세션 한도·Redfish 세션 DELETE 동작·실 Unity/Isilon 결측 응답·MIG nvidia-smi 출력)로는 확인하지
    못했다 — 전부 가짜 서버·합성 입력 재현이다. 웹 전수(90카드·43설정·206로드)는 UI 축이 목 스택에서 봤다.

- ⚠⚠ **v2.594 — 7축 병렬 감사(5차 점검) 확정분**(사용자 요청 "세번 더 수행" 의 1회차 — 선택은 v2.593 과 같다. 확정 19 · 가능성 5 ·
  반증 5, 고침 22. 회귀는 `test/audit2594.test.js` 16건 — **변이 검증 21/21**. 상세 `docs/AUDIT-2026-09-24b.md`):
  - ⚠⚠ **결측을 null 로 바꿨으면 그 값을 소비하는 곳을 전부 따라갈 것**(R2594-01·02·03·05 — v2.593 DATA-01 의 재발): 수집기가 null 을
    내도 ① 정규화(`powermax.js normalizePowermax` 의 `|| 0`) ② 파생 계산(Isilon `max(0, null − ssd) = 0`) ③ 화면 합산(`a + (x || 0)`)
    ④ SQL `SUM`(NULL 을 건너뛰어 분자만 줄어든다) 이 **각자** 0 으로 되돌렸다. 화면 합계는 `storageUnits.capacityTotals` 하나 —
    사용률은 **사용량을 읽은 장비끼리만**, 뺀 대수는 `unknownUsed`. `formatBytes(null)` 은 이제 `'—'` 다(예전 `0.0 TB`).
    통합 추이 SQL 은 결측 장비가 있는 버킷의 사용량을 NULL 로 두고 `used_unknown` 을 준다(부분 합 = 거짓 하락).
  - ⚠⚠ **역할별 가림은 '그 데이터가 응답에 실리는 경로 전부' 에 — 한 곳을 가리면 형제 경로가 우회로다**(R2594-04 — v2.593 AUTHZ-01 의
    우회. v2.550.3 `status.last` 와 같은 교훈): 토폴로지 본체를 가린 뒤에도 `lastResults` 로 IP·오류 문구·대조 백엔드·IRS 점검 문구가
    나갔다. 비-admin 결과는 `stripCfg` 가 주소 칸을 비우고 문구는 개수만(`irsIssueCount`·`maskedAddress`). 가린 뒤 화면이 판정에
    쓰던 값이 사라지는지도 볼 것 — 'IRS 있는 사이트' 가 항상 0 이 됐다(`present` 불리언, R2594-06).
  - ⚠⚠ **페이징 인자는 `util/pageArgs.js` 하나 + DB 헬퍼의 `clampPage`**(SEC-2594-01~03): `Math.min(1000, Number(limit) || 200)` 은
    **하한이 없다** — SQLite 는 `LIMIT -1` 을 '제한 없음' 으로 읽고, 배열은 `slice(o, o−1)` 로 거의 전량이다. 실수·1e20 은 바인드
    datatype mismatch(500). **새 페이징 라우트는 이 헬퍼를 쓸 것.** 응답 헤더 파일명에 요청값을 넣지 말 것(SEC-2594-04).
  - **연결 끊긴 호스트는 사용률 계산에서 빠진다**(`store.js usageReadable` — v2.593 이 판단을 남긴 DATA-03). 용량 합계(GHz·GB)에는
    남고 사용량·사용률만 뺀다(개요 KPI 가 뺀 대수를 적는다). ⚠ 정직 기록: 실 vCenter 가 끊긴 호스트의 `summary.hardware` 를 계속
    주는지 확인하지 못했다 — 주지 않으면 원래 영향이 없었다(재현은 목 생성기·합성 스냅샷).
  - **보고 부속 객체에도 크기 상한**(EDGE2-01 — svcmon 엣지 `poller`·`caps`·`log`, 16KB 초과면 `{dropped, bytes}`) · 상한 퇴출 Map 은
    **지우고 다시 넣어야** 최근 항목이 뒤로 간다(EDGE2-02) · 병합에서 버린 원소를 병합 수로 보고하지 말 것(EDGE2-03) · 진행 보고도
    무음 실패 금지(EDGE2-04 — 형제 회신은 v2.591 에 고쳤는데 진행 보고만 남았다).
  - **IPAM 저장 키는 정규형**(`ipam/overrides.js canonIp` · annotations 도 같다, LO-2 — 재현): 파서가 선행 0 을 받는 것(v2.586 호환)과
    원장이 **문자열로** 대조하는 것이 만나 유령 행·유령 /24 시트가 생겼다. 받는 표기는 넓게, 저장은 정규형 하나.
  - **VM 수량 추이는 첫 수집 중인 vCenter 가 있으면 슬롯 기록을 미룬다**(`vmtrack/poller.js PENDING_WAIT_MS` 30분, DATA2594-03). 그래도
    빠지면 결과가 `skippedVcenters` 로 밝힌다. ⚠ 수집 실패(unreachable) vCenter 가 빠진 슬롯은 여전히 부분 합이다(스키마에 표식 없음 — 별건).
  - 그 밖: PDU 데이지체인은 **E1xx 만** '유닛 없음' 이다(그 밖의 실패는 `unitsIncomplete` + 노트) · GPU 진단의 MIG 는 `N/A(MIG)` ·
    상세 모달 그리드는 `repeat(auto-fit, minmax(min(260px,100%),1fr))`(v2.576 `.vc-grid` 와 같은 결함 — Modal 이 overflow:hidden 이라
    잘렸다) · IPAM 쓰기 워커에는 레코드 배열만 보낸다 · 서버 문자열도 BoldText 로 그려지면 **백틱 금지**(PowerMax 용량 설명).
  - ⚠ 반증·재판정: 손 풀 7곳·버전 비교 사본 3곳은 입력이 고정·검증돼 **결함이 아니다**(v2.593 '남긴 것' 목록에서 뺀다) · VM 사용률
    결측(rightsizing 'idle' 오판)은 현 수집기로 **도달 불가**. 남은 판단: ✅ PERF-1(→ v2.619) · EDGE-3(v2.583 설계 — ✅ v2.613).
  - ⚠ 정직 기록: Chromium 은 목 스택으로 개요·스토리지(장비 0대)·중계 토폴로지(admin)·VM 상세 모달 1440/400 을 봤다 — 비-admin 가림
    화면과 사용량 결측 장비가 있는 스토리지 표는 **화면으로 보지 못했다**(단위·합계 로직은 테스트로 고정).

- ⚠⚠ **v2.595 — 7축 병렬 감사(6차 점검) 확정분**("세번 더 수행" 2회차. 확정 31 · 가능성 8 · 반증 1, 고침 32. 회귀는
  `test/audit2595.test.js` 17건 — **변이 검증 34/34**. 상세 `docs/AUDIT-2026-09-24c.md`):
  - ⚠⚠ **키를 정규화했으면 그 키로 하는 판정도 전부 같은 정규화를 거칠 것**(R2595-01 — **v2.594 가 만든 범위 우회**, 재현):
    v2.594 가 IPAM 저장 키를 정규형으로 바꾸고 범위 판정(`ipInWriteScope`)은 원문으로 소유자를 찾아, 범위 계정이 선행 0 표기로
    범위 밖 IP 에 썼다. 예전에는 원문 키로 저장돼 유령 행만 생겼다 — **고친 것이 더 위험한 결함을 만든 사례**다. 정규형은
    `util/ipv4.js canonIp` 하나다(v2.594 의 두 벌을 올렸다).
  - ⚠⚠ **REST 를 고쳤으면 SSH 형제도**(C2595-01): v2.593 DATA-01 은 REST 수집기 5종만 고쳤고 PowerStore·XtremIO·Isilon **SSH** 가
    'N/A' 사용량을 0 으로 적재했다. 전체 용량은 `toBytes`(0 이면 건너뜀) · **사용량은 `toBytesOrNull`/`parseSizeOrNull`** 이다.
  - **텔레메트리 퍼센트는 `redfish.js pctFromMetric`**(C2595-02) — 숫자만 뽑는 `replace(/[^\d.]/g,'')` 는 null·'N/A' → 0, '-1' → 1 이다.
  - **디렉터 sfpshow 는 `slot/port` 키**(C2595-03) — 슬롯마다 Port 0 부터 다시 세므로 포트 번호 키는 덮어쓰고, 전역 Index 로 찾으면
    **다른 포트의 광량**이 붙는다. ⚠ porterrshow 의 디렉터 행 형식은 여전히 실장비로 보지 못했다.
  - ⚠ **응답 필드 누출은 '상태 객체' 를 싣는 곳에서 난다**(AUTHZ-2595-01~04): svcmon 엣지 `sourceIp`·`portalPort`(→
    `auth/scopeStatus.redactEdgeSummary`, admin + 전체 범위만) · vmseries `push.last`(범위 밖 vCenter id·오류 원문·centralUrl) ·
    DB 절대 경로(vmtrack·Horizon 세션·SAN 점검 이력 — `scopeDbStatus`). v2.550.3 `status.last` · v2.574 SEC-07 과 같은 계열이다.
  - **사용률 기준은 `store.usageReadable` 하나**(R2595-04·05·WT-01): 읽을 호스트가 없으면 `null`('0%' 아님) · `hostsUsageExcluded`
    (NOT_RESPONDING 포함 — `hostsDisconnected` 는 그것을 세지 않는다) · vCenter 카드·관제 콘솔·Summary 가 같은 기준을 쓴다.
    ⚠ 공개 API `/inventory/summary` 의 합계(used/total)는 **대조 계약** 때문에 전 호스트 그대로다 — 사용률(%)만 바뀌었다.
  - **설정·실행 결과가 섞인 파일의 백업 지문은 `last*` 를 뺀다**(`backup/service.js MIXED_STATE_FILES`, FS-1) · 실행 결과는 **id 로 찾은
    현재 항목**에 쓴다(FS-2·3 — 편집이 캐시 항목을 새 객체로 바꾼다) · finops·일일 보고 로드도 `preserveCorrupt`(FS-4 — arch2582
    allowlist 에서 뺐다). ⚠ 정직 기록: 암호화 모드에서 봉인 값이 저장마다 달라지면 FS-1 지문이 여전히 바뀔 수 있다(확인 못 함).
  - **사용자 주기 → setInterval 은 상한부터**(T2595-01 — 알림 엔진, 상한 1일 + 재진입 가드. v2.591 L2·L3 의 형제 누락) ·
    '기다림' 의 기준 시각은 **그 상태를 처음 본 시각**이다(R2595-03 — vmtrack 이 슬롯 시작을 기준으로 재서 늦은 재시작에 대기가 0).
  - **숫자 설정의 빈 칸은 `util/clampSetting.js`**(DEPS2595-01 — OS 스캔: 빈 칸 저장이 주기 720→5분·재스캔 30일→0). 같은 모양의
    사본이 17벌 있다고 보고됐다 — 이번에는 재현된 OS 스캔만 옮겼고 나머지는 **다음 점검 후보**다.
  - 그 밖: 서버 문구(bulkAdvice·scanRemedy) 백틱 → ‘ ’ · GPU 게스트 연결 테스트 MIG · 센서 빈 상태 주기 · '-%' · DS 추이 사용률 null ·
    인시던트 limit(`pageArgs`) · CONFIG-FILES 생성기가 `createActivityLog({fileName})` 를 읽는다(6종 추가) · portalDb 유령 파일명 7개.
  - 남긴 것(정보·가능성): 죽은 export 56개(판정 사본 `isMonitored`·`isVcenterGpuMonitored` 는 오인 위험) · adaptiveTimer 재무장 중 두 번째
    실행(가능성) · SAN rates 빈 목록 주기(가능성) · uemcli 부분 번호(가능성) · sfpshow uW 단위(가능성) · clamp 사본 16벌.

- ⚠⚠ **v2.596 — 7축 병렬 감사(7차 점검) 확정분**("세번 더 수행" 3회차. 확정 24 · 가능성 9 · 반증 5, 고침 27. 회귀는
  `test/audit2596.test.js` 12건 — **변이 검증 15/15**. 상세 `docs/AUDIT-2026-09-24d.md`):
  - ⚠⚠ **가림은 그 값을 싣는 응답 전부에 — v2.595 도 형제 경로를 놓쳤다**(R2596-01 — 재현): svcmon 엣지 주소 가림을 `/edges`·
    `/state`·`/diag` 에 걸고 `/edges/:agent/probe`·`/assign` 은 놓쳤다. **가림을 추가할 때는 그 필드를 grep 해 모든 응답을 볼 것.**
  - ⚠⚠ **지문(fingerprint)을 낼 때 암호화 모드를 잊지 말 것**(R2596-02 — 재현): 봉인 값은 저장마다 salt·iv 가 새로 뽑혀 내용이 같아도
    암호문이 다르다. `backup/service.js fingerprintContent` 가 JSON 을 `openSecretsDeep` 으로 연 뒤 비교한다(해시에만 쓰고 남기지 않는다).
    실행 필드는 `last*`·`useCount`(`RUN_FIELD_RE`) · 대상 파일은 `MIXED_STATE_FILES`(엣지 토큰·연동 키·일일 보고를 더했다).
  - ⚠⚠ **숫자 설정의 빈 칸은 서버·웹 둘 다 '미지정'**(CLAMP2596-01~06 — v2.595 가 1곳만 고친 계열의 5곳): 세션 총 상한·스파이크
    임계/보존일·게스트 디스크 주기·VM 성능 보존일·업그레이드 확인 주기. 서버는 `numOrNull` 로 빈 값을 걸러 이전 값을 유지하고
    (명시적 0 만 값), 웹은 `views/blankOr.js` 로 빈 칸을 **보내지 않는다**. ⚠ '0 = 무제한/끔' 인 필드가 가장 위험하다 — 빈 칸이
    '끔' 이 되면 오류 없이 정책이 풀린다. 새 숫자 설정을 만들면 두 쪽 다 이 규칙을 따를 것.
  - **엣지 pull 은 '빠진 것' 도 정리한다**(EF-2·3): svcmon 배정 해제(명시적 200 + assigned:false)면 `central:` 배치를 지우고,
    스토리지 `applyPulledDevices` 가 빠진 id(`removed`)를 돌려줘 스냅샷을 지운다(SAN 스위치 `onRemoved` 와 같은 규칙).
    ✅ PDU 의 같은 경로는 v2.600 `agent/pduConfigPull.js:57` 에 고쳤다(v2.613 에 이 줄을 정정).
  - **큰 목록은 정렬 뒤 자른다**(PERFWEB-01 — IPAM 8,028행 전량 렌더 12.5초 정지 실측 → `DataTable limit` 1,000 + 뺀 개수) ·
    **정적 해시 자산은 `util/staticGzip.js`**(파일마다 한 번 비동기 gzip · 캐시 상한 · 작은 파일·gzip 미지원은 원본) —
    ⚠ `index.js` 첫 import 는 여전히 `logbuffer.js` 다(테스트가 고정) · 모달·상세 전용 차트는 `lazy()` 로(Datastores·VCenters).
  - **늦게 온 이전 응답은 버린다**(WS-1~4): vCenter·범위·기간을 바꾸는 화면의 fetch 는 `active` 플래그나 세대 ref 를 둔다.
    ⚠ VM 프로비저닝의 배치 초기화는 **칩을 누를 때** 한다 — 효과(useEffect)에서 하면 저장 작업 불러오기의 배치까지 지운다.
  - 그 밖: CSV 수식 가드는 웹 `util/csv.js csvCell` · 서버 `util/csv.js guardCell` 하나(bmUsage·svcmon 사본을 옮겼다) · 알림 폴링은
    401/403 이면 10분 쉰다 · 통신 점검 `ms_n` 열 추가 시 구 행 합을 비운다 · prune 은 인덱스 열로 거른다(`t0 < ? AND t1 < ?`).
  - 남긴 것: ✅ SQLite open 일시 잠금 래치(→ v2.597 L2597-02 `util/sqliteOpen.js` · v2.613 PERSIST2613-03 에 `metrics/db.js`·`storage/db.js` 도 적용) · ✅ 엣지별 설정 조회 대소문자(→ v2.597 `util/agentKey.js`) · PRAGMA 묶음 exec
    (가능성) · `/vcenters` 중복 요청(정보) · 스파이크·현재 사용자 설정 전량 배포는 **설계**(반증).

- ⚠⚠ **v2.597 — 7축 병렬 감사(8차 점검) 확정분**("한번 더". 확정 21 · 가능성 9 · 반증 4, 고침 28. 회귀는
  `test/audit2597.test.js` 22건 — **변이 검증 19/19** + 웹 `cssVars.test.js`. 상세 `docs/AUDIT-2026-09-24e.md`):
  - ⚠⚠ **지문·해시 경로에서 봉인을 '열지' 말 것 — 캐시에 있을 때만**(RECENT-01 — **v2.596 이 만든 회귀**, 재현): v2.596 이
    암호화 모드 지문을 맞추려고 `openSecretsDeep` 을 부르자 캐시에 없는 봉인 값마다 `scryptSync`(약 100ms)가 메인 스레드에서
    돌아 값 100개에 **10~22초** 이벤트 루프가 멈췄다. `secretVault.openSecretIfCached` 는 파생키가 이미 있을 때만 연다(없으면
    `null` → 고정 표식). **값마다 KDF 를 돌리는 함수를 폴링·백업 경로에서 부르지 말 것.**
  - ⚠⚠ **결측 → 0 은 REST 수집기에도 남아 있었다**(C2597-02~05): v2.593 DATA-01·v2.595 C2595-01 이 고친 뒤에도 Unity REST
    `sizeTotal`(없으면 '정상 · 0 바이트')·Isilon `byKey`/노드 통계(`Number(v)||0` 이 **'읽었다' 판정 has() 를 통과**)·
    PowerStore 어플라이언스 풀이 0 이었다. **`Number(x) || 0` 은 grep 으로 전수를 볼 것** — 이번에도 형제 수집기에서 나왔다.
  - **PDU 데이지체인 유닛 2 이상은 뱅크·상을 읽지 않는다**(C2597-01): `bkReading`/`phReading` 에는 유닛 축이 없어 유닛마다 같은
    명령이 나가고 **유닛 1 값이 복제돼** unit=i 로 적재됐다. 실장비 유닛 지정 문법을 확인하기 전까지 `banksNotCollected` 로 밝힌다.
  - ⚠⚠ **알림 발생 상태는 파일에 남긴다**(LC2597-01, `alerts-state.json`): 인메모리뿐이라 재시작마다 발생 중 알림 전부가 쿨다운과
    무관하게 재발송됐다. 복원 목록은 **쿨다운이 남은 동안만** 들고 있는다 — 첫 평가에서 비우면 기동 직후 스냅샷이 비어(첫 수집 중)
    전부 잃고 수집 뒤 다시 보낸다(구현 중 실제로 그렇게 만들었다가 고쳤다).
  - **재무장 함수를 만들었으면 부르는 곳이 있는지 볼 것**(LC2597-02): `reschedulePhysicalPoller` 는 호출부가 0 이었고 엣지 pull 은
    `rescheduleGpuGuestPoller` 도 부르지 않았다. 상태 화면은 새 주기를 보고했다(v2.409 규약의 누락).
  - **SQLite 첫 open 잠금은 래치하지 않는다**(L2597-02): 'database is locked' 를 영구 `unavailable`·NDJSON 폴백으로 굳히지 말 것 —
    `busy_timeout` 을 **journal_mode 보다 먼저** 걸고, 잠금이면 핸들을 닫고 다시 연다.
  - **엣지 이름 조회는 `util/agentKey.js`**(L2597-03): 토큰 바인딩·장비 배정은 소문자 비교인데 주기·GPU·사용자 설정은 글자 그대로라
    같은 응답이 장비는 주고 설정은 빠뜨렸다. 정확히 같은 키 → 대소문자만 다른 키 순서(저장 형식은 그대로).
  - **디렉터 포트 처리량 키는 slot/port**(C2597-07, `sanswitch/rates.js rateKey`) — REST 폴백 index('1/10'·'11/0' → 110)가 겹쳤다.
  - **fallback 없는 `var(--x)` 는 정의가 있어야 한다**(WEBUI-01 — `cssVars.test.js` 스윕): `--muted` 104곳이 정의 없이 쓰여 선언이
    무효가 되고 본문색을 물려받았다. **수치로는 안 잡히고 스크린샷으로만** 보인다(v2.589 `.btn` 과 같은 계열).
  - 그 밖: vmtrack 부분 합 `skipped` 열 + 배지 · PDU push 재진입 가드·pull 로 빠진 장비 스냅샷 즉시 정리 · GPU 메모리 사용률 부분 결측 ·
    vCenter REST 폴백 DS free_space 결측 → null · ping 범위는 대상 vcenterId 먼저 · service-check 범위 계정 문구 생략 ·
    svcmon probe 문구 가림 · staticGzip q=0 · 오프라인 패키지 config 정리를 Windows 와 같은 식(테스트가 두 find 식을 대조) ·
    루트 `config/` 무시·추적 해제 · 워크플로 `persist-credentials: false`·CI/릴리스 Node 통일·릴리스 `npm ci`.
  - 남긴 것: Windows 서비스 ACL(DEPS-04 — Windows 환경 없음) · 자산 prune 순서(DEPS-07 — 1000개 상한과 얽힘) ·
    vCenter REST 폴백 DS 결측이 있으면 스토리지 합계가 부분 합(합계 헬퍼가 null 을 0 으로 더한다 — 폴백 경로 한정).
  - ⚠ 정직 기록: 실장비(APC 데이지체인 CLI·Isilon/Unity 결측 응답·다중 프로세스 SQLite 잠금)로는 확인하지 못했다 — 합성 입력 재현이다.

- ⚠⚠ **v2.598 — 10축 감사 + 발견별 2인 반증(9차 점검) 확정분**("더 자세하게, 두번 더" 1회차. 발견 68 = 확정 49 · SPLIT 4 ·
  가능성 4 · 반증 11, 고침 55. 회귀는 `test/audit2598{a..f}.test.js` 95건 + 웹 vitest 6파일 — 그룹별 변이 검증. 상세 `docs/AUDIT-2026-09-24f.md`):
  - ⚠⚠ **암호화 모드는 저장마다 재봉인하지 않는다**(L2598-01 high — 40대 1대 수정 저장 4.1초 → 1ms): 세션 키 + 문맥(필드·식별 필드) HMAC
    기반 **암호문 재사용**. 보안 의미 변경은 `server/CLAUDE.md` 'v2.598' 절. 백업 지문은 봉인 원문을 그대로 비교한다(RECENT2598-01 —
    v2.597 openSecretIfCached 표식이 캐시 상태로 뒤집혀 무변경 change 백업이 생겼다).
  - ⚠⚠ **엣지가 올리는 진단·결과는 '아는 필드만' 담는다**(CENTRAL-01~03): gpuGuestDiag 는 상한 없이 상주했고 오염 원소가 로그 소스 화면을
    TypeError 로 죽였다. 스캔 결과의 수치가 객체면 화면이 React #31. 정제는 **저장 함수 안**에 둔다(라우트가 아니라 — 로드한 옛 파일도 거친다).
    ⚠ 정제 헬퍼는 모듈 로드 코드보다 **위에** 둘 것(아래면 TDZ 로 로드가 실패해 정상 파일이 손상 파일로 보존된다 — 구현 중 실제로 그랬다).
  - **가림은 역할·범위로 — 이번 형제 누락 5곳**(AUTHZ-2598-01~05): ping 추이 엣지 주소(`canSeeEdgeAddress` 하나로 판정) · 원격 프록시 범위 ·
    svcmon push/pull `centralUrl`·실패 원문(`scopeStatus.redactPushStatus`, 문구 상수 `ADMIN_ONLY_TEXT`) · 작업 로그 절대 경로
    (`scopeFilePaths` — 라우트의 `*LogInfo()`·`FILE` 은 전부 이것을 거치게 스윕 테스트가 고정) · 도구 사용 기록 키 화이트리스트.
  - ⚠⚠ **node:sqlite 는 JS number 를 REAL 로 바인딩한다 — `ts/?` 버킷은 `CAST(ts/? AS INTEGER)`**(DB2598-01): ping 24시간 추이가 1,440칸이었다.
    정수 나눗셈을 기대하는 새 SQL 은 같은 규칙.
  - **시한은 결과가 아니라 세션을 끊는다 — 네 곳 더**(T2598-01·02): Isilon 영역 수집(연속 무응답 3회면 멈추고 `notTried`) · vCenter 로그 ·
    이벤트(`collectVCenterEvents` signal, 정리 호출은 `callRaw({ignoreExternal})`) · 게스트 디스크. v2.417·v2.590 F7 규약의 누락이었다.
    `adaptiveTimer` 는 실행 중 재무장하지 않는다(T2598-04).
  - **저장된 요청 시한은 [1초, 10분]**(T2598-03 — `soapParse.js normRequestTimeoutMs`/`effectiveRequestTimeoutMs`): 3e9 가 setTimeout 1ms 가 되어
    모든 요청이 즉시 실패했다. 옛 저장값도 실행 시점에 자른다(vCenter·NSX·Horizon·REST·store 데드라인).
  - **vCenter 가공 정확성**(VC2598-01~10): 스냅샷 크기는 delta·sesparse·vmem·vmsd·uniqueSize 포함 · 성능 -1 은 null · GPU 호스트 키는
    `gpuHostKey(vcenterId, host)` · 네트워크 hostCount/vmCount 는 **모르면 null**(예전 값은 지어낸 것) · 파생 알람 시각은 처음 본 시각 ·
    vCenter id 는 `vcRefOf`/`morefOf` 로 푼다(**콜론 split 금지**) · freeSpace 없으면 null + 'inaccessible' 알람 · 전력 -1 저장 안 함 ·
    자기닫힘 `<val/>`. ⚠ 보류: 템플릿을 VM 수에 넣을지(VC2598-09 — 공개 API 대조 계약) — 롤업에 `templates` 개수만 추가했다.
  - **결측을 0 으로 — 이번에도 여덟 곳**(RECENT2598-03·04, WEBUI-01·02·06·07, IDRAC-02·03, DB-03): DS 사용량 결측은 합계에서 빼고
    '사용량 모름 N개 제외' · 알림은 보류(해소 아님) · Horizon·현재 사용자 확인 불가는 null(추이는 `vms_ok=0` 행을 null 로 읽는다) ·
    라이선스 0 포트 사용률 '—' · KPI 0 을 경고색으로 칠하지 않음 · 보드 퍼센트 범위 밖은 null · 리포트 미갱신은 0 B/s 가 아니라 null ·
    PDU 데이지체인 추이는 유닛 **합**(한 유닛이라도 못 읽은 시각은 빼고 `partialSamples`).
  - **정규식 ReDoS 두 곳**(INJ-01·06): PDU about 440KB 2.9초 → 27ms(사이 구간 400자 + 입력 64KB) · `stripUemcliBanner` 800KB 7.9초 → 26ms
    (줄 단위 O(n)). 장비 출력도 '외부 입력' 이다 — 긴 출력에 무제한 `[\s\S]*?` 를 쓰지 말 것.
  - **설정 파일에 들어가는 문자열은 제어 문자를 지운다**(INJ-02): 중계 토폴로지 dc 이름의 개행이 HAProxy 설정에 listen/bind 줄을 넣었다.
  - **SFP 광량 'N uW (M dBm)' 는 dBm 을 쓴다**(L2598-05): 선두 값을 dBm 으로 읽어 316.2 dBm 이 됐다. 괄호 dBm 우선, 없으면 환산, 0 uW 는 null.
  - 반증: L2598-04(라우트 검증이 저장 전에 거부) 외 검증 단계 11건. ⚠ 정직 기록: 목 데이터로 만들 수 없는 상태의 안내 문구는 브라우저로
    보지 못했다 · 실장비 응답(Unity health 열거·iDRAC 리포트 목록·실 vCenter 결측)은 합성 재현이다.
  - ⚠ **작업 방식**: 병렬 수정 중 stop hook 때문에 WIP 커밋을 넣으면 HEAD 에 이미 수정이 들어간다 — 변이 검증의 '수정 전' 판본은
    **감사 시작 커밋**(`git show <base>:경로`)으로 할 것(HEAD 로 하면 거짓 통과한다).

- ⚠⚠ **v2.599 — 10차 점검(v2.598 회귀 우선) 확정분**("더 자세하게, 두번 더" 2회차. 발견 49 = 확정 44 · SPLIT 3 · 가능성 1 · 반증 1,
  고침 47. 회귀 `test/audit2599{a..f}.test.js` + 웹 vitest 6파일. 상세 `docs/AUDIT-2026-09-24g.md`):
  - ⚠⚠ **고친 것이 만든 결함이 셋이었다 — 다음 회차도 '직전 diff 회귀' 축을 맨 먼저 둘 것**: ① 베어메탈 알림 지속 판정이 '관측 간격 ≤ 주기×1.5'
    였는데 **적응 타이머는 수집이 끝난 뒤 재무장**한다 — 간격 = 주기 + 수집 시간이라 서버가 많으면 알림이 영원히 안 울렸다(`runMs` 를 더한다)
    ② 암호문 재사용 문맥이 부모의 식별 필드만 봤다 — **맵 키로만 구분되는 항목**(gpu-guest vcenters/vms·byAgent)과 id 없는 배열이 충돌해
    같은 비밀번호가 같은 암호문이 됐다(문맥에 경로) ③ DS 사용량 null 을 한 곳에서 내기 시작하면 **형제 소비처 전부**(diskTrend·compareMatrix·
    forecast·rollup)가 그 null 을 받는다 — 결측을 새로 만들 때는 소비처를 grep 으로 전수.
  - ⚠⚠ **엣지가 보낸 배열 원소 하나가 함대 전체를 멈출 수 있다**(CEN-2599-01): `/inventory` 의 null 원소가 저장돼 매 주기 `store.refresh` 가
    던졌다. 수신 **그리고 병합부** 둘 다에서 객체만 받는다(디스크에 이미 남은 값이 있으므로). 원소 vcenterId 는 본문 vcenterId 에 묶는다
    (CEN-02 — 남의 법인 주입). 스토리지·PDU·SAN 수신 정제는 `central/edgeRecord.sanitizeEdgeDevices` 하나(v2.598 CENTRAL 규약의 확장).
  - ⚠⚠ **TOFU 소유권은 관리자가 푼다 — 자동 인계는 기본 꺼짐**(EDGE2599-03): `POST /api/admin/central/inventory/owner`(adminOnly·감사).
    `CENTRAL_INVENTORY_OWNER_HANDOVER_HOURS` 기본 0 — 켜면 소유 엣지가 오래 조용할 때 다른 개별 토큰 엣지가 넘겨받으므로 **기본값으로 켜지 말 것**.
  - **관리 주소 가림은 `auth/addressMask.js`**(AUTHZ-2599-03): 스토리지·SAN·PDU 목록뿐 아니라 **작업 로그·점검 이력·포트 상세·PDU 상세**가 같은
    주소를 싣는다(목록만 가렸을 때 Chromium 하단 표에 IP 가 남아 찾았다). `cliRaw` 원문 속 주소는 가리지 않는다(정직 기록).
  - **주기 env 는 `config.js clampIntervalMs`/`offOrIntervalMs`**(T2599-02): 2^31 초과·0 이하가 1ms 루프였다. 문서화된 '0 = 끔'
    (`COLLECTOR_PULL`·`IDRAC_SCAN`·`AGENT_EDGELOG_POLL_MS`)만 0 을 유지한다. 새 주기 env 는 이 헬퍼로.
  - **SQLite open 은 `util/sqliteOpen.js`**(DB2599-02): busy_timeout 먼저 · 잠금이면 그 시도의 핸들만 닫고 재시도(폴백 모듈 `retryOnLock`,
    unavailable 모듈 `createLockRetry` 30초). 폴링 경로 15종 적용, 미적용 7종(점검 시에만·ipam 외부 공유·v2.597 기적용)은 그룹 e 보고에 근거.
  - **장비 출력 정규식은 선형으로**(SEC2599-02): `replace(/\s+$/)` 는 긴 공백 줄에서 O(n²) — `trimEnd()`. 스윕 테스트가 server/src 전체에서 0 을
    고정하고, 파서 11개가 공백 3만 자에서 150ms 안인지 본다. 남은 후보 `cliSsh.parseJsonLoose`(구조적 O(n²)).
  - **비밀은 명령 인자로 보내지 않는다**(SEC2599-05): 배포(agent·rma)가 토큰을 `bash -c "printf …"` 로 보내 `ps` 에 보였다 → `appendSecretText`
    (SFTP 0600 임시 파일 + `cat >>`, finally 삭제). 엣지 로그 가림에 URL 비밀번호·Basic/Digest 추가(SEC-04).
  - 수집기: Isilon REST 처리량은 **B/s → bps(×8)** · PowerStore SSH 는 REST 와 같은 판정(`powerstoreCore.js` — 순환 회피로 분리) · NSX 는 cursor
    페이징(상한 20, `listsTruncated`) · 알람 상한은 개수를 밝힌다 · bmstor 사용률은 **df 정의** used/(used+avail).
  - ⚠ 작업 방식(v2.598 기록의 재확인): 병렬 수정 중 WIP 커밋은 변이 검증 기준을 흐린다 — 감사 기준 커밋을 모든 그룹에 명시했다. 이번에도
    한 그룹의 변이 도중 WIP 커밋이 '되돌린 판본' 을 담은 적이 있다(다음 커밋에서 바로잡힘) — **변이 검증 중에는 WIP 커밋을 피할 것**.

- ⚠⚠ **v2.600 — 11차 점검 확정분**("세번더" 1회차. 발견 67 = 확정 51 · SPLIT 5 · 가능성 9 · 반증 2, 고침 62 + 후속 17.
  회귀 `test/audit2600{a..f}.test.js` 72건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24h.md`):
  - ⚠⚠ **엣지 수신 정제는 '객체면 버린다' 가 아니라 '하위 필드를 좁힌다' 다**(RECENT2600-01 — **v2.599 가 만든 회귀**): `vcenter.location` 은
    원래 객체라 null 로 만들자 위임 vCenter 전부가 지역 'Unknown'·지도 좌표를 잃었다. 정제 대상 필드의 **정상 모양을 먼저 확인**할 것.
  - ⚠⚠ **크기 상한은 '통째로 버리기' 가 아니라 '잘라서 받고 밝히기'**(RECENT2600-02): 장비당 1MB 상한이 조닝이 큰 SAN 스위치를 전량 버렸고
    엣지는 응답을 읽지 않아 흔적이 0 이었다. 중앙 `trimZoningToFit`(`limited`·`trimmed`) · 엣지 slim 도 조닝 축약 · push 는 응답의
    `rejected`·`dropped`·`zoningTrimmed` 를 상태·콘솔에. **새 상한을 넣으면 그 상한에 걸리는 정상 입력의 최대치를 계산할 것.**
  - **가림 형제 경로 — 이번에도 여덟 곳**(RECENT2600-03·AUTHZ-2600-01~08): storage-growth · 시리얼 조회 JSON/CSV · SAN 사용량 요약·폴러 ·
    Horizon 세션 · `/idrac/host-power`(권한 게이트 자체가 없었다) · bm-usage 대상. 폴러 상태는 `addressMask.maskPollerStatus`. 이름이 주소라
    가린 행은 `maskedNameLabel`(빈 문자열 금지). 범위 계정의 중계 점검은 403.
  - **로그인 잠금 Map**(T2600-01·02): 키 128자 초과는 sha256 으로 접고(자르면 다른 계정이 카운터를 공유) · 하한캡 퇴출은 **잠금 없는 카운터부터**
    (활성 잠금을 먼저 지우면 분산 실패 요청으로 잠금이 풀린다) · `routes/auth.js` 는 256자 초과 사용자명을 인증 전에 400.
  - **엣지가 보낸 한 원소가 함대 적재를 롤백시킬 수 있다**(CEN2600-01 — GPU 사용률 객체). 결과 저장소 5곳(ping·캡처·iDRAC 스캔·로그 조회·bmstor)도
    아는 필드만 담는다(v2.598 CENTRAL 규약의 형제). 엣지는 **중앙 직접 수집 vCenter 에 쓰지 못한다**(`edgeVcWriteDenied`).
  - **재시작 직후 빈 슬라이스로 중앙을 지우지 않는다**(EDGE2600-04): 엣지는 불통·대기이면서 0개인 vCenter 를 보내지 않고, 중앙은 6시간 안의 직전
    목록을 유지(`held`, 데이터 시각은 그대로라 낡음으로 보인다). 재전송은 멱등으로(`cover_batch`). 엣지 요청 시한 env 는 `agent/envTimeout.js`.
  - **버킷 합계는 장비별 마지막 값을 이어 붙인다**(DB2600-01): 10분 버킷에 수집 시각이 다른 엣지 장비가 흩어져 함대 합계가 1/4 로 그려졌다.
    `storage/db.js sumCapacityBuckets`(한계 = 수집 주기 × 2, `missing`·`carried`). **시간 버킷 SUM 을 새로 만들 때 같은 함정을 볼 것.**
  - 롤업 폴백은 '원본이 더 많을 때만'(DB2600-02 — metrics·vmperf) · 원격 임시 경로는 `agent/deploy.js remoteTmpDir` · 설정 빈 칸 4곳 더 ·
    NSX 합계는 `nsx/scope.js scopedNsxRollup` 한 벌(실패 목록은 null) · 웹 빈 칸 유지는 `views/blankKeep.js`.
  - 남긴 것: COL-2600-07(Horizon 같은 pod 이중 계수 — 세션 id 저장 여부와 함께 판단) · 엣지 push 게스트 디스크의 `partsUnknown` 중앙 합산.

- ⚠⚠ **v2.601 — 12차 점검 확정분**("세번더" 2회차. 발견 52 = 확정 43 · SPLIT 3 · 가능성 4 · 반증 2, 고침 48 + 후속 13.
  회귀 `test/audit2601{a..f}.test.js` 65건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24i.md`):
  - ⚠⚠ **결측을 null 로 바꾸면 저장 스키마까지 따라갈 것**(RECENT2601-01 high — **v2.600 이 만든 회귀**): 게스트 파티션 `usedGB` 를 null 로
    바꾸자 중앙 직접 수집 경로가 `used_gb REAL NOT NULL` 에 넣어 **vCenter 전체 커밋이 매 주기 롤백**됐다. 두 경로(직접·엣지)는
    `sanitizeGuestDiskVms` 하나를 쓰고, `commitCollection` 은 숫자가 아닌 행을 적재하지 않고 센다.
  - **보류(withhold)에는 반드시 시한**(RECENT2601-02): 엣지가 불통 vCenter 의 빈 슬라이스를 무기한 보류하면 중앙 HOLD 규칙이 영원히
    집행되지 않는다. `WITHHOLD_MAX_MS`(= LASTGOOD_HOLD) 뒤에는 보낸다. 점검중(maintenance)도 '못 읽음' 상태다.
  - **식별자 자체가 주소인 행**(AUTHZ-2601-01~04): iDRAC 은 id·name 이 IP 인 경우가 많다. `addressMask.maskedIdToken`(프로세스별 키 HMAC,
    `masked-<12자>`)으로 바꾸고 조회 시 `resolveMaskedToken` 으로 되찾는다 — 같은 원문은 같은 토큰이라 표 매칭이 유지된다.
    ⚠ 캐시(memoJson)의 `extraKey` 에 **역할을 넣을 것** — 없으면 먼저 연 사람의 판본이 다른 역할에 나간다.
  - **엣지에 내려간 비밀은 중앙에서 지우면 엣지도 지운다**(EDGE2601-01): GPU 게스트 설정 pull 이 병합만 해서 지운 VM 비밀번호가 남았다.
    `applyPulledGpuGuestSettings`(중앙 사본에 없는 키 삭제 · 엣지 로컬 vCenter 는 보존).
  - **수신 원소 정제 — 또 두 곳**(CEN2601-01 high: IP 스캔 결과가 IPAM 원장 저장을 매 주기 실패시킴 · CEN2601-02: `/fleet` 귀속은 그 엣지가
    소유한 vCenter 에만). 공유 토큰 이름·원소 수 상한을 둔다(`omitted` 로 밝힘).
  - **같은 origin 엣지 구분**(WEB2601-01·02): `util/outboundStats.js withOutboundTag`(AsyncLocalStorage)로 수집 서버 id 를 싣고, 행에 `base`
    (origin + 경로 접두). 태그 없는 중복 주소 기록은 어느 엣지에도 붙이지 않는다(`sharedUrl`). 새 중앙 → 엣지 호출은 태그로 감쌀 것.
  - prune 은 키별 마지막(이월) 행 보존(guestdisk·vmtrack) · vCenter 로그 prune 은 `pruneAsync` · zip 은 같은 localOffset 거부 ·
    AD 타임아웃 빈 칸 = 이전 값 · 설정 파일 JSON null 은 손상 보존 · `getMs()` 예외에도 타이머 재무장.
  - 남긴 것: VACUUM 동기 · 공유 토큰 사칭 한계 · 태그 없는 중앙 → 엣지 호출 4종(linkcheck·relaycheck — ✅ v2.613 EDGE2613-10 에 태그 · 배포 후 검증·자기등록은 남음).

- ⚠⚠ **v2.602 — 13차 점검 확정분**("세번더" 3회차. 발견 47 = 확정 35 · 가능성 3 · 반증 9, 고침 37 + 후속 10.
  회귀 `test/audit2602{a..f}.test.js` 51건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24j.md`):
  - ⚠⚠ **응답마다 도는 가림·정제는 '행 수 × 대상 수' 를 운영 규모로 먼저 계산할 것**(RECENT2602-01 — **v2.601 이 만든 회귀**): 가림 헬퍼가
    행마다 호스트 1,200개의 변형을 다시 만들어 2,000행에 5.6초 정지. `addressMask.makeScrubber`·`scrubberFor`(목록당 1회 · 트라이) ·
    `extendMatcher`. 수정 전 구현을 테스트에 옮겨 **결과 동일성**을 대조한다 — 성능 수정은 출력이 같다는 증거와 함께.
  - **엣지 pull 도 수신이다**(CEN2602-01 high): push 만 정제하고 pull(export)은 원소를 그대로 보관해, 오염된 `serviceTag` 하나가 함대
    물리 서버 집계를 죽였다. `collector/remoteInventory.js` 정제 · 버린 개수 `serversDropped`. **새 pull 경로도 같은 규칙.**
  - **svcmon 변경은 전체 범위 계정만**(AUTHZ-2602-01): 변경 라우트 32개 `fullScopeOnly`. 조회 GET 은 그대로(N-2).
  - **`/\/+$/` 는 O(n²) 이다 — 선형 루프로**(SEC2602-01·04 + normPath): 입력 길이 상한과 함께. ✅ 저장소에 남은 `collector/registry.js` 2곳은 v2.611 `util/trimSlashes.js` 로 고쳤다.
  - ⚠ **정정**: v2.550.3 이 `sanswitch/perfDb.js perfDbStats` 를 '폴링하지 않는 진단 경로' 로 적은 것은 틀렸다 — 설정 화면이 **20초마다** 부른다.
    v2.602 에 MIN/MAX 단독 + COUNT 60초 캐시(`countsAt`)로 줄였고, **v2.728 에 COUNT 자체를 없앴다**(rowid 어림 — 아래 v2.728 SAN 항목). '폴링하지 않는다' 고 적기 전에 화면의 호출 주기를 grep 할 것.
  - **다운로드는 `res.ok` 를 먼저**(WEB2602-01): 409·403 오류 JSON 이 .xlsx 로 저장되던 8곳 → `api.js downloadFile`·`saveResponseAsFile`.
    웹 스윕 테스트가 `.blob()` 을 쓰는 화면 파일의 `res.ok` 확인을 고정한다.
  - **설정 push 감시는 백업과 같은 상태 파일 기준**(EDGE2602-01 — `isRuntimeStateFile` 한 벌 + 설정 지문 무변경 생략).
  - 부분 합은 **적재하지 않는다**(iDRAC 섀시 일부 Power 실패 → `powerNotStored`) · NSX cluster/status 실패는 unknown · 처리량 분모는 카운터를
    읽은 시각 · 상태 전용 push 는 중앙 버전 확인 뒤(2.581.0+) · 보존일 음수는 무제한이 아니다 · `VMPERF_RETENTION_DAYS=0` = 무제한.
  - 남긴 것: svcmon 미등록 agent 이름 거부(공유 토큰 미리 배정 흐름과 충돌 — 판단 필요) · 지표 보존 상한 3650일(제안 1830) · SSH 유휴 하한 1분.

- ⚠⚠ **v2.603 — 14차 점검 확정분**("자세하게 3번 더" 1회차. 발견 47 = 확정 34 · SPLIT 6 · 가능성 2 · 반증 5, 고침 40 + 후속 17.
  회귀 `test/audit2603{a..f}.test.js` 73건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24k.md`):
  - ⚠⚠ **반증 기록은 '그 근거로는 결함이 아니다' 이지 '결함이 없다' 가 아니다**: v2.601·v2.602 에서 반증한 두 건(현재 사용자 0건 ·
    파트 장애 꺼짐)을 v2.603 이 **새 근거**(latest 표 무기한 잔존 · 중앙이 꺼짐을 스스로 내려보내 원인을 안다)로 뒤집었다. 반증할 때
    근거를 함께 적어야 다음 감사가 다른 각도로 다시 볼 수 있다. 파트 장애는 kind `off`(+`offSource`).
  - **수신 저장소는 전부 개수 상한**(CEN2603-01 high — GPU byVm·byHost 180만 항목 +486MB · scanStore · agentIdentity): 검증된 엣지는
    밀지 않고 새 항목을 거절하며 `omitted` 로 밝힌다. 미등록 vCenter 로 온 원소는 버린다.
  - **`push(...큰배열)` 금지 — `util/pushAll.js`**(CEN2603-03 — 14만 행 RangeError). 스윕 테스트가 허용 목록 밖 0건을 고정한다.
  - **본문 객체의 toString/valueOf 는 입구에서 지운다**(`util/coercionTrap.js`, CEN2603-05 — 16개 경로 500).
  - **ALTER TABLE 은 table_info 로 없는 열만, 'duplicate column name' 만 삼킨다**(DB2603-01 — 잠금을 '열 있음' 으로 삼켜 ipam 원장이
    프로세스 끝까지 NDJSON 폴백). ipam.db 는 여전히 WAL 금지.
  - **시계열 보존 DELETE 는 `util/chunkedPrune.js createPruneFlight`**(진행 공유 한 벌) — 스윕 테스트가 한 방 DELETE 를 허용 목록(사유)과 대조한다.
    허용 목록의 '후속 후보'(capacity samples 등)는 규모를 재지 않았다.
  - **본문 상한은 스트림으로**(`util/readPrefix.js` — svcmon·RMA 가 전체를 읽은 뒤 잘랐다. 주석의 '256KB' 가 사실이 아니었다).
  - **호스트:포트는 `util/hostPort.js splitHostPort`**(IPv6 대괄호) · HAProxy 줄은 `haproxyAddress`(`ipv6@` — ⚠ `haproxy -c` 미확인).
  - **이벤트 핸들러에 기본 인자 함수를 그대로 넘기지 말 것**(WEB2603-01 high — 클릭 이벤트가 vCenter id 가 되어 IPAM 서브넷 대장이 빔). 웹 스윕이 0건을 고정한다.
  - ReDoS 5곳(SAN sensorshow 3차 · uemcli 배너 · FC 속도 · Unity 버전 · Isilon 풀) — 성능 수정은 옛 정규식과 **결정적 난수 대조**로 결과 동일성을 함께 고정한다.
  - ⚠ 성능 상한 테스트는 전량 병렬 부하에서 단독의 3~4배가 나온다(v2.602 가림 55~80ms → 260ms). 상한은 **회귀와 확실히 갈리는 값**으로(여기선 1초 vs 5.6초).

- ⚠⚠ **v2.604 — 15차 점검 확정분**("자세하게 3번 더" 2회차. 발견 39 = 확정 35 · SPLIT 2 · 반증 2, 고침 37 + 후속 9.
  회귀 `test/audit2604{a..f}.test.js` 51건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24l.md`):
  - ⚠⚠ **이름으로 찾는 설정은 저장·조회 둘 다 `util/agentKey.js`**(RECENT2604-01 — **v2.603 이 만든 회귀**): 배정은 쿼리 이름, 결과는 토큰
    이름으로 대소문자 구분 조회해 스캔 결과가 전량 409. 새 거부(409·403)를 넣으면 **정상 경로가 같은 키로 찾는지**부터 볼 것.
  - **외부 응답은 `.json()`·`.text()` 를 그대로 쓰지 않는다**(CEN2604-01 high·CEN2604-02) — `readJsonCapped`·`readBodyPrefix`. 두 소스
    스윕 테스트가 고정한다(허용 목록 사유 포함). 경로를 변수로 조립하는 호출은 스윕이 못 본다(✅ upgrade.js 엣지 push·`collector/upgradePush.js` 는 이미 `readJsonCapped` 를 쓴다 — v2.742 LEFT-03 정정).
  - **자기등록은 검증이 아니다**(CEN2604-04): 공유 토큰 자기등록 이름을 '아는 엣지' 로 세면 v2.601 미검증 상한이 우회된다.
  - **비밀 가림 정규식은 `_PASS`·`_PWD`·`_CREDS` 까지**(SEC2604-01 — `util/envRedact.js`, 밑줄 접두만). 파일별 추가 봉인 필드는
    `secretVault FILE_EXTRA_SECRET_FIELDS`(alerts.json 의 url — 전역 SECRET_FIELDS 에 url 을 넣으면 접속 주소까지 봉인된다).
  - **공개 API 는 내부 비-admin 과 같은 가림 함수를 쓴다**(AUTHZ-2604-01·02) — 따로 구현하면 한쪽만 가린다.
  - **반올림 용량은 적재하되 해상도를 밝힌다**(COL-2604-01 — Isilon SSH `5.0P`, `capacityApprox.resolutionBytes`, 공개 API `resolutionBytes`).
  - **긴 기간 조회는 롤업**(DB2604-01 — ping `samples_hourly`, 365일 10.6초 → 0.2초).
  - **존재하지 않는 설정 필드로 분기하지 말 것**(vmclone `config.mode` — 목 모드에서 실제 vCenter 를 탔다). `getDataSource()` 를 쓴다.
  - ⚠ **병렬 에이전트의 변이 백업 경로는 에이전트별로**(이번 회차 사고 — `mut.bak` 공유로 파일 3개가 잠시 서로 덮였다. 전 변경 파일
    머리말·삭제 비율·테스트·변이 유효성으로 복구를 확인했다).

- ⚠⚠ **v2.605 — 16차 점검 확정분**("자세하게 3번 더" 3회차. 발견 53 = 확정 50 · 가능성 3 · 반증 0(중복 3쌍), 고침 51.
  회귀 `test/audit2605{a..f}.test.js` 62건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24m.md`):
  - ⚠⚠ **범위 admin 의 PUT 은 '받은 목록 = 전체 목록' 이 아니다 — 범위 밖 키는 보존 병합한다**(AUTHZ2605-01 high, `auth/scopeMerge.js`):
    GET 이 범위로 거른 설정을 화면이 그대로 PUT 하면 다른 법인 설정이 지워지고 **vmperf DB 파일까지 삭제**됐다(실제 라우터로 재현 3 → 1).
    **GET 에 범위 필터를 넣은 설정 라우트는 PUT 에 병합도 넣을 것** — 한쪽만 있으면 왕복이 곧 삭제다. 전 법인에 접속하는 수동 실행은
    형제 bm-usage/collect 처럼 범위 계정에 403(AUTHZ2605-02).
  - ⚠⚠ **보류(withhold)에는 반드시 시한 — v2.601 규약을 v2.604 가 또 놓쳤다**(RECENT2605-01 high): fleet push 보류가 무기한이라 중앙 TTL(30분)이
    그 엣지 베어메탈 전체를 지웠다. **새 보류를 만들 때는 받는 쪽의 TTL 과 비교해** 시한을 그보다 짧게(`FLEET_WITHHOLD_MAX_MS` 20분).
  - ⚠⚠ **엣지 수신 정제는 글자 필드만이 아니라 수치 필드도**(CEN2605-01 high): 문자열 수치가 `+= x || 0` 에서 문자열 이어붙이기가 되어
    함대 합계가 `'1616'` 이 됐다. `INV_NUM_KEYS` 를 `numOrNull` 로. 새 수치 필드는 목록에 더할 것(목록 밖은 좁혀지지 않는다 — 정직 기록).
  - **사용자 입력이 닿는 정규식은 길이 상한과 함께**(SEC2605-01 high — 자연어 검색 `/(\d+)\s*%/` O(n²), viewer 요청 한 번으로 서버 정지):
    숫자열·반복 문자에 앵커 없는 `\d+` 는 시작 위치마다 끝까지 훑는다. `(?<!\d)` 로 시작을 고정하고 입력을 자른다(`NL_QUERY_MAX` 500).
  - **허용 목록의 사유는 사실이어야 한다**(LEFT2605-01): v2.604 가 relaycheck 를 '관리자 수동 실행' 으로 적어 상한 스윕에서 뺐는데 실제로는
    주기 폴러였다. 허용 목록에 사유를 적을 때는 호출부(타이머 등록)를 grep 할 것.
  - **엣지 재시작 직후 '일부만 수집된 목록' 도 빈 목록만큼 위험하다**(EDGE2605-01·02): 중앙이 목록을 통째로 교체하면 아직 안 읽은 장비가
    사라진다. 첫 수집 전에는 보류(시한 15분 + 사유). v2.583 '0건이면 보내지 않는다' 가드는 1건이라도 있으면 통과했다.
  - **REST 수집기는 `{signal}` 을 받아 getter 까지 넘긴다**(TIM2605-02 — XtremIO·Isilon 누락, 스윕 테스트가 storage/collectors 전수를 고정).
  - 그 밖: 가상 NIC 는 사용률(%)에서 제외(물리·bond 만) · Windows 디스크 I/O 는 `100 − PercentIdleTime` · vGPU 표본 없음은 0 이 아니라 미수집 ·
    원격 전력 키에 수집 서버 축(DB 키는 충돌할 때만 나눠 이력 연속) · 끊긴 호스트는 웹 클러스터 평균에서도 제외 · ping baseline 7일 하한 ·
    전력 정리·Capacity·게스트 디스크 prune 청크 · 데이터스토어 탐색 캐시 만료 청소·문자열 평탄화 · 설정 push `_again` · 숫자 칸 빈 값 4곳 더.
  - 남긴 것: LEFT2605-08(장비 REST 응답 상한 — 정상 최대치 미확인) · ✅ EDGE2605-05(중앙 등록부 손상 → 엣지 빈 목록 전파 — v2.612 LEFT2612-01 에 503 `registryUnreadable` 로 고침) · 범위 admin 의 전 법인 공통
    스칼라 설정 · 재등록 일시 검증 실패 강등(collector/registry.js) · ping seriesOf `meta()` · env 허용 목록 잔여 89개.
  - ⚠ 작업 방식: 이 컨테이너는 CPU 4개라 Workflow 동시 상한이 2였다 — Agent 도구로 10축을 직접 병렬 실행하고 '전량 테스트·빌드 금지' 를 명시했다
    (load 2 안팎). stop hook 이 WIP 커밋을 요구해 변이 검증 도중 WIP 커밋이 들어갔고, 한 번은 **되돌려 둔 판본(idrac/db.js)을 담았다** —
    다음 WIP 커밋에서 바로잡혔고 변이 기준은 감사 기준 커밋이라 결과에는 영향이 없다.

- ⚠⚠ **v2.606 — 17차 점검 확정분**("자세하게 두번 더" 1회차. 발견 63 = 확정 58 · SPLIT 2 · 가능성 2 · 반증 1, 고침 60.
  회귀 `test/audit2606{a..g}.test.js` 70건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24n.md`):
  - ⚠⚠ **범위 admin 은 '쓰기로 읽기 범위를 넓힐 수' 없어야 한다**(AUTHZ2606-01·02): Ping 대상 PUT 으로 `vcenterId` 를 바꾸거나 통합 인벤토리 귀속을
    바꾸면 조회 라우트의 범위 은닉이 무력화된다. **조회에 범위 필터가 있는 자원은 쓰기에서 기존 값과 새 값 둘 다** 범위 판정할 것.
    v2.605 '범위 병합' 과 짝이다(그쪽은 삭제, 이쪽은 탈취). 전 vCenter 를 건드리는 동작은 범위 계정 403(`denyScopedRun`·`fleetFullScopeOnly`).
  - ⚠⚠ **엣지 보고의 식별자는 인증된 agent 로 다시 계산해 대조한다**(CEN2606-01): 통신 점검은 `kind`·`from` 만 보고 `link.id` 를 믿어 엣지 하나가
    다른 엣지의 링크를 '정상' 으로 덮었다. 결정적으로 만들 수 있는 id(`linkIdOf`)는 **받은 값이 아니라 계산한 값**과 비교한다(대소문자 무시).
  - ⚠⚠ **`.slice(0, N)` 은 메모리 상한이 아니다**(TIM2606-02): V8 SlicedString 이 원문을 붙잡아 64자 키가 5MB 를 들고 있었다. 외부 문자열을
    상주 구조(Map 키·recent 링)에 넣을 때는 `util/capStr.js`(자르고 평탄화). v2.605 dsBrowse 평탄화의 형제 — **계측 상한을 만들 때 힙으로 잴 것**.
  - ⚠⚠ **접속 대상이 바뀌면 저장 비밀은 승계하지 않는다 — 대상이 '목록' 이어도**(LEFT2606-01·02): iDRAC 스캔 대역·GPU 게스트 고정 IP 가 v2.503 S-2
    `secretCarry` 에서 빠져 있었다. 비밀을 가진 설정에 새 '주소 칸' 을 만들면 그 칸도 판정에 넣을 것.
  - **스캔 대상은 등록 장비가 아니다 — 응답 본문 상한을 건다**(SEC2606-01): v2.605 LEFT2605-08(등록 장비 응답 상한 보류)과 전제가 다르다. 미등록 호스트의
    서비스 루트·401 본문은 수백 바이트가 정상이므로 64KB/16KB 로 자르고 넘으면 '응답 과대' 로 건너뛴다.
  - **정규식 ReDoS 형제 3곳**(SEC2606-03·04·05): Digest 챌린지 `(\w+)\s*=` · GPU 실패 본문 `<[^>]+>` · racadm `(\d+)\s*%`. 앵커 없는 반복 + 뒤따르는 리터럴은
    전부 같은 모양이다 — **새 파서를 쓸 때 입력 길이를 먼저 자르고 경계로 시작을 고정**할 것. 옛 정규식과 정상 입력 결과 동일성을 대조 테스트로 둔다.
  - **'부분' 은 하한으로 말한다**(COL2606-01·04, WEB2606-09): 현재 사용자 원문 절단·Horizon 페이지 절단·상태 미확인 세션은 '최소 N' 이고 추이에는 **적재하지 않는다**
    (부분 합은 거짓 하락). 끊긴 호스트는 N+1·용량·비교 매트릭스에서도 `store.usageReadable` 로 뺀다(WEB2606-02 — v2.594·v2.605 의 형제).
  - 엣지: GPU 게스트 push 는 **모든 대상 vCenter 를 읽은 폴**만 보낸다(인벤토리 미수집 빈 폴이 v2.605 보류를 통과했다) · svcmon 예열 중 완결은 GC 하지 않는다 ·
    push 는 중앙 거절 요약을 읽는다(`agent/centralReply.js`) · LLM 타임아웃은 숫자로 저장(문자열이 AI 검색 전부를 죽였다).
  - 남긴 것: ✅ curuser 청크 0 교체 · ✅ `sshExec withDeadline`/`execCapture` 시한 상한 · ✅ linkcheck poller 의 currentIds(셋 다 v2.607 에 고침 — v2.613 에 이 줄을 정정) · 새 응답 필드의 화면 표시 일부
    (SAN `failed`·RMA 거절·fleet partial·`hostsUsageExcluded`·`patternsOmitted`·`droppedSecrets`) · SEC2606-07 · COL2606-07.
  - ⚠ 작업 방식: 보안 축 재현 검증자가 결과를 쓰지 못하고 끝났다(안전 분류기) — 의도 검증 + 수정 그룹의 기준 커밋 재현으로 확정했다. 보안 재현 스크립트는
    **입력을 작게**(1.6만 자·수 MB) 두도록 지시할 것.

- ⚠⚠ **v2.607 — 18차 점검 확정분**("자세하게 두번 더" 2회차. 발견 65 = 확정 60 · SPLIT 2 · 가능성 2 · 반증 1, 고유 수정 54 + 통합 2.
  회귀 `test/audit2607{a..h}.test.js` 66건 + 웹 vitest. 상세 `docs/AUDIT-2026-09-24o.md`):
  - ⚠⚠ **범위 admin 은 사용자 관리로 자기 범위를 넓힐 수 없다**(AUTHZ2607-01): 새 scope 는 요청자 범위의 부분집합이고, 전체 범위 계정의 생성·수정·
    비밀번호/OTP 변경·삭제는 거부한다. v2.605 '범위 병합'·v2.606 '쓰기로 읽기 범위를 넓히지 않는다' 의 가장 큰 형제였다 — **권한을 주는 라우트 자체**를
    먼저 볼 것. 전 법인 데이터·동작 게이트는 `fleetOnly`(감사 로그·중앙 인벤토리·중앙 IPAM) · `fleetWideOnly`(vCenter 등록·데이터 소스·표시 순서).
    **새 게이트 이름은 `scripts/api-doc.mjs GUARD_NOTE` 에 등록할 것**(없으면 apiDoc2563 이 실패한다).
  - ⚠⚠ **시한 값은 `util/deadline.js deadlineMs` 하나를 지난다**(TIM2607-02): `withDeadline(3e9)`·NaN·음수가 1ms 시한이 되어 수집·대량 테스트·업그레이드
    push 가 즉시 실패했다. NaN/≤0 → 기본 60초, [1초, 2시간]. `AbortSignal.timeout`·`setTimeout` 에 설정값을 넣는 곳은 전부 이 관문으로.
  - ⚠⚠ **상주 레코드의 외부 문자열은 `capStr`/`capTrim`**(TIM2607-01): v2.606 은 계측 Map 키만 고쳤다 — 수신 저장소 레코드(fleet·rma 결과·엣지 로그·
    진단)도 SlicedString 으로 원문을 붙잡는다. 소스 스윕이 central/*·rma/jobs.js 의 `.slice` 를 허용 목록(사유)과 대조한다.
  - **REST 폴백 vCenter 는 알람을 모른다**(LEFT2607-04·WEB2607-06): `alarmsUnknown` 이면 알람 칸 '—' · 합계 제외 · 알림 엔진은 해소 판정 보류.
    `collectMode` 는 site/direct 만이고 REST 여부는 `collectSource` 다(섞으면 빈 인벤토리 판정이 흔들린다).
  - **중앙 직접 수집 장비는 엣지 push 로 덮이지 않는다**(CEN2607-03 `notOwned`) · SAN 스냅샷 정제는 health·extra 하위 목록까지(CEN2607-01·05) ·
    통신 점검 엣지 보고는 중앙이 그 agent 에 내려준 링크만(LEFT2607-01).
  - **비밀 승계는 `accessMoved(host·port·username)` — agent 변경은 승계 유지**(SEC2607-07, 위임 수집에 필요) · 폐기 사실은 `droppedSecrets` 로 응답하고
    화면은 `views/droppedSecretText.js` 하나로 말한다(수집 서버 PUT 이 그 필드를 버리고 있었다 — INT2607-01).
  - **재전송 경로는 '첫 시도가 이미 바꾼 것' 을 기억한다**(INT2607-02 · LEFT2607-09): 청크 0 이 교체한 뒤 재전송이 실패하면 중앙은 부분 목록이다 — '직전 그대로' 는 거짓.
  - 업그레이드·패키지 다운로드는 `util/readBytesCapped.js`(바이트 상한 스트림) · SSH 배너·stderr·WS hostname 채널 상한 · 정규식 수정은 옛 결과와 동일성 대조.
  - 남긴 것: 미등록 장비·vCenter id 수신(공유 토큰 흐름) · ✅ `sftpReadFile` 크기 상한(v2.612 LEFT2612-07 `SFTP_READ_MAX`) · 폴러 `*_DEVICE_TIMEOUT_MS` 상한(관문이 자른다) · IPAM import dryRun 의
    범위 밖 존재 노출 · COL2607-06·08(가능성).
  - ⚠ 작업 방식: 수정 도중 세션 사용량 한도로 전 그룹이 중단됐다 — 재개 시 **반쯤 적용된 파일을 기준판으로 되돌리고** 변이 백업을 지운 뒤 처음부터 다시 돌렸다.
    중단된 그룹의 부분 수정을 이어 쓰지 말 것(어디까지 됐는지 알 수 없다).

- ⚠⚠ **v2.611 — 19차 점검(v2.608~2.610 회귀 우선) 확정분**(사용자 요청 "디버깅 아키텍처 점검 개선 튜닝 진행" · 선택 10축 병렬 + 반증 ·
  전체 검증. 발견 약 75건 → 확정·일부 확정 약 60건, 반증·재보고 10여 건. 회귀 `test/audit2611{a,b,c,e}.test.js` 54건 + 웹 vitest(`virtRatioText`·
  `audit2611d`·`scanRunText`·`cvpText`). 그룹별 변이 검증 전부 통과. 상세 `docs/AUDIT-2026-09-25.md`):
  - ⚠⚠ **'계정이 없어 시도하지 않은 서버' 는 부분 결과다 — replace 를 병합으로 낮춘다**(RECENT2611-01 high, **v2.610 이 만든 회귀**):
    iLO 전용 대역을 replace-datacenter 로 스캔하면 Dell 은 noCreds 로 빠지고 발견된 HPE 만으로 법인 목록을 교체해 **기존 Dell 등록이
    자격증명째 지워졌다**. 판정은 `idrac/scan.js scanPartialReasons` 하나(중단·절단·인증 정지 건너뜀·noCreds·**authFailed**·iLO 없이 스캔했는데
    그 법인에 HPE 등록 있음)이고 scanPoller·localScan 이 같이 쓴다. authFailed 를 넣은 대가: 인증 실패가 계속되는 대역은 replace 정리가 안 된다.
    **스캔 결과에 새 '건너뜀' 종류를 만들면 이 함수에 더할 것**(v2.591 authSkipped 와 같은 계열의 두 번째 누락이다).
  - ⚠⚠ **자격증명은 벤더가 '확인된' 장비에만**(`makeScanCredsFor` — SEC/RECENT/LEFT 세 축 독립 보고): 폴백 `dellCred || iloCred` 가
    벤더 미상 장비(아무 HTTPS 서버)에 iLO 비밀번호를 보냈다. iLO 는 hpe 에만, unknown 은 Dell 계정만(없으면 noCreds).
  - ⚠⚠ **정제 화이트리스트에 새 필드를 넣지 않으면 기능이 위임 경로에서만 조용히 죽는다**(CEN2611-01): v2.610 이 엣지 결과에 HPE 필드를
    더했는데 중앙 `sanitizeIdracScanData` 가 몰라서 전부 버렸다 → 'HPE 0대(정확)'. 새 결과 필드를 만들면 **수신 정제·`hpeCountsOf` 같은
    소비처**까지 따라갈 것. 소비처의 `Number(v)` 도 null 을 0 으로 읽고 있었다(numOrNull).
  - **구버전 엣지에는 새 계약을 위임하지 않는다**(EDGE2611-01~03 — `central/idracScanPush.js iloEdgeGate`, `MIN_ILO_EDGE_VERSION` 2.610.0):
    v2.609 엣지는 `ilo` 를 몰라 빈 계정으로 대역 전체에 로그인했다. 버전은 `allCollectorStatus().version`(인메모리 — 재시작 직후 미상).
    iLO 전용 대역은 구버전·미상이면 보류(`held`·사유), Dell+iLO 대역은 위임하고 회신에 `iloEnabled` 필드 자체가 없으면 `iloIgnoredByEdge`.
    ⚠ 수집 서버로 등록되지 않은 폴 전용 엣지는 버전이 늘 미상이라 iLO 전용 대역이 계속 보류된다(정직 기록 — 사유 문구가 말한다).
  - **HPE 서비스태그는 SerialNumber**(COL2611-01, `redfish.js systemServiceTag`): `SKU||SerialNumber` 는 HPE 에서 모델 공통 부품번호라
    같은 모델 서버가 dedup·전력 합계에서 한 대로 합쳐졌다. 이미 SKU 로 등록된 항목은 인벤토리 갱신 때 `correctHpeServiceTag` 가 **1회 교정** —
    ⚠ 그 결과 파트 장애·bmusage 키가 바뀌어 열린 장애가 한 번 새로 열릴 수 있다(✅ v2.612 에 `key-migrated` 로 옮기고 화면이 '식별 키 변경' 배지로 보인다 — `partfault/incidents.js`·`partFaultText.js`, v2.742 LEFT-03 정정).
    HPE 팬 `ReadingUnits:'Percent'` 는 rpm 이 아니라 `pct`, Absent 온도 센서는 건너뛴다.
  - ⚠⚠ **범위 admin 의 쓰기 — 이번엔 '등록부 파일 11개' 전체였다**(AUTHZ2611-01·02·03·04, LEFT2611-02·03·07): v2.607 fleetWideOnly 를
    `/vcenters/import {mode:'replace'}` 가 그대로 우회했다(검증 중 신규 발견). 각 파일 상단 `const fleetOnly = fullScopeOnlyWith('<사유>')`.
    `/admin/status` 는 403 대신 범위 필터(`scoped`·`omittedOutOfScope` — 진단 화면이 10초마다 부른다). IPMS·GPU 게스트 설정은 범위 병합.
    **새 admin 라우트 파일을 만들면 '범위 참조 0건' 인지 먼저 볼 것** — 이번 누락은 전부 그 파일들이었다.
  - **엣지가 보낸 region 이 등록부 region 을 덮지 않는다**(AUTHZ2611-05, `store.js withRegistryRegion` — site·점검중 두 분기).
    지역 범위(`scope.regions`)가 스냅샷 region 으로 판정되므로 덮어쓰면 엣지가 범위 경계를 정한다(v2.548 F5 계열).
  - ⚠⚠ **DB 를 못 쓰면 200 이 아니라 503**(CEN2611-03 = EDGE-04 = DB-03 — CVP·SAN 포트 사용량): 200 + `unavailable` 을 엣지가 성공으로 읽고
    커서를 전진해 **표본이 영구 소실**됐다. 형제 guest-disk·vmseries 는 이미 500 이었다(계약 비대칭). 엣지는 구버전 중앙의 `unavailable` 도 실패로.
    DB 불가는 래치라 엣지가 매 주기 재전송한다 — 콘솔은 `createChangeLogger` 로 줄인다.
  - **CVP push**: 꽉 찬 페이지는 같은 호출에서 이어 보낸다(`CVP_PUSH_MAX_ROUNDS`) · `backlogRows`·`lostUnsent`(prune 이 미전송분을 지움) ·
    비-2xx 본문 사유 · `touched < touch.length` 면 `_sent` 삭제. 수신 이름은 `canonicalAgent`(대소문자 무시 저장 + 변형 키 정리 — v2.604 규약의 CVP 누락).
  - **CVP 수집**: 요청 시한 `min(30초, 남은 예산)` · counters·bgp 앞 예산 확인 · 시한에 걸린 장비는 `aborted`(pending 이 아니다) ·
    `_partsAt` 은 부품을 실제로 읽었을 때만 · presence 긍정값만 있으면 unknown(fault 아님) · 0대 보고면 prune 1시간 보류(`CVP_ZERO_PRUNE_HOLD_MS`) ·
    `speed2p5Gbps` · 포트 델타 간격에 실행 소요를 더한다 · 파트를 안 읽은 주기에 extra 를 보존 · '지금 수집' 큐 시한은 설정의 장비 시한.
  - ⚠⚠ **WAL/SHM 은 본체 권한을 복사한다 — chmod 는 PRAGMA 전에**(DB2611-01, `util/sqliteOpen.js chmodDbFiles`): chmod 가 첫 쓰기 뒤면
    12종 DB 의 `-wal`/`-shm` 이 0644 로 생기고 재시작해도 남았다. `db.location()` 으로 본체 + 기존 wal/shm 을 0600(ipam 은 wal:false 라 제외).
    `dbLocation` mkdir 은 0o700. **새 DB 모듈은 openSqlite 를 쓰거나 생성자 직후 이 헬퍼를 부를 것.**
  - **CVP DB**: `samplesAfter` 는 `+agent = ''` 로 인덱스를 우회(EXPLAIN 에 TEMP B-TREE 없음을 고정 — 25.7→5.7ms) · 적재는 2,000행 트랜잭션,
    **양보는 COMMIT 뒤**(트랜잭션을 연 채 양보하면 같은 연결의 다른 요청이 BEGIN 에서 실패한다 — 재현) · prune 은 enabled 와 분리 · 일 롤업 오류 합에 `_n`.
  - **웹**: 수집 전 vCenter 의 가상화율은 '—'·회색 '미수집'(`virtRatioText.js`) · 늦게 온 이전 응답 버림 5화면 · 조회 실패를 '없음' 으로,
    삭제 실패를 무음으로 보이던 7화면 · HPE 전용 대역 편집 시 root 주입 · CVP KPI 부분 합(못 읽은 장비 수) · `<0.1%`.
  - 그 밖: iDRAC 로컬 임시 스캔은 주기 스캔과 같은 잠금(`tryAcquireScan` — 409 busy)과 인증 회로 차단기 · 시한 env 상한 2곳 ·
    IPAM 원장 조립 행당 1회 파싱(약 28% 단축, **옛 판본과 5조합 deepStrictEqual**) · 스캔 대역 단건 IP 비정규 표기 거부 · FinOps 빈 칸 ·
    수집 서버 URL 끝 슬래시 정리 선형화(`util/trimSlashes.js`) · 중앙→엣지 호출 태그 5곳.
  - ⚠ **속도 절대값 테스트는 CPU 에 따라 깨진다**: `audit2606g` 의 '옛 정규식 > 150ms' 가 이 컨테이너에서 110ms 로 나와 전량 테스트가
    실패했다 — `tOld > 40 && tOld > tNew × 5`(상대 비율)로 바꿨다. **ReDoS 회귀 테스트는 비율로 쓸 것.**
  - 남긴 것: ✅ 파트 장애 키 변경 배지(COL-01 — v2.612 `key-migrated`) · CVP BGP 피어 IP 가림(AUTHZ-06, 정책 판단) · pdu 등 다른 표본 커서 push 의 같은 모양 ·
    `/idrac/:id/gpu-probe` GET 로그인 · 실장비(iLO·CVP·구버전 엣지) 미확인 — 전부 가짜 서버·합성 입력 재현이다.
- ⚠⚠ **v2.612 — 20차 점검 확정분**(사용자 요청 "코드 리뷰 보안 패치, 성능 개선 등" · 선택 10축 병렬 + 반증 · 전체 검증.
  확정·부분 확정 약 45건, 반증 7건. 회귀 `test/audit2612{a..e}.test.js` + 웹 `audit2612f.test.js` 외. 상세 `docs/AUDIT-2026-09-25b.md`):
  - ⚠⚠ **범위 관리자 차단은 '파일 단위' 로 훑어야 한다 — 이번엔 `routes/api/*` 였다**(AUTHZ2612-01~08): v2.607·v2.611 이 `routes/admin/*`
    등록부 파일만 훑어, 스토리지·PDU·SAN 장비 내보내기·삭제·일괄 수집, 중계 토폴로지(전 사이트 IP·SSH 계정 · PUT 으로 전체 삭제),
    RMA 원격 명령, 베어메탈 스토리지·계정 볼트, 성능 모니터 hang 로그, 전 법인 공통 설정(SAN 사용량 보존일 · 스토리지·PDU 주기·임계)이
    범위 관리자에게 열려 있었다. **같은 파일의 목록 GET 은 이미 403 이었다**(형제 누락). 이제 그 파일들의 adminOnly 라우트 전부가
    `fullScopeOnly`/`fleetOnly` 이고 `audit2612a` 가 **소스 스윕으로** 고정한다(새 adminOnly 라우트를 게이트 없이 더하면 실패).
    `relaytopo`·`relaycheck` 의 `!admin &&` 예외(admin 은 통과)도 없앴다 — v2.607 이후 범위 관리자는 '관리자' 가 아니라 '범위 계정' 이다.
    비상 정지는 요청자·승인자 모두 전체 범위여야 한다. ⚠ **새 admin/api 라우트 파일을 만들면 '범위 참조 0건' 인지 먼저 볼 것.**
  - ⚠⚠ **대량 이동·적재는 요청 경로에서 한 문장으로 하지 않는다**(PERF2612-01·02 — v2.611 이 만든 회귀): CVP 이름 변형 병합이
    `UPDATE OR IGNORE`+`DELETE` 한 문장으로 100만 행에 약 13초 정지했다. 5,000행 rowid 청크 · **COMMIT 뒤에만** 양보 · 백그라운드
    single-flight(`{wait:true}` 로만 기다림) · 같은 날 일 롤업은 **합친다**(버리면 표본·피크 소실 — RECENT2612-04). `saveDevices` 도 30대마다 커밋.
  - ⚠⚠ **자격증명을 싣는 요청은 리다이렉트를 따라가지 않는다 — `resilientFetch` 밖의 클라이언트도**(SEC2612-02·03): 전역 fetch 기본
    follow 가 307 대상(루프백 포함)으로 계정·비밀번호 본문을 다시 보냈고, IP 리터럴 대상은 SSRF lookup 을 타지 않는다. CVP 는
    `redirect:'manual'`(3xx = 실패), Redfish·OME 는 `redfish.bmcFetch`(같은 출처 + 같은 호스트 https 상향만, 최대 3회, 호출자 signal 유지).
    ⚠ `resilientFetch.fetchFollowing` 을 그대로 쓰지 말 것 — 호출자 signal 을 자체 타임아웃으로 덮어 v2.417 세션 절단이 깨진다.
  - **파서 누적은 제자리로**(SEC2612-01): `{...prev, ...fields}` 를 반복하면 O(n²) — CVP 8천 건 11.7초. 개체당 필드 상한 400 + `droppedFields`.
  - ⚠⚠ **등록부를 못 읽었으면 '빈 목록' 을 내려보내지 않는다**(LEFT2612-01 — v2.605 가 남긴 것): 손상 → `preserveCorrupt` → 빈 목록 →
    설정 pull 이 `ok:true` 로 엣지 장비·스냅샷·관리 계정을 지웠다. 등록부 5종 `registryLoadError()` · 설정 pull 5경로 503 `registryUnreadable` ·
    **원본이 없고 `.corrupt.*` 만 있으면(손상 뒤 재시작) 역시 못 읽은 것**이다. 재수집 큐를 꺼내기 전에 검사한다.
  - **중앙 → 엣지 '동작' 요청은 재전송하지 않는다**(EDGE2612-01): `resilientFetch` 는 메서드를 보지 않고 재시도한다 — 엣지 라우트가
    동기(끝까지 기다림)라 시한 뒤 재전송이 같은 스캔·수집을 동시에 두 번 돌렸다(로그인 두 배). `retries:0` + 엣지 409 `busy`(iDRAC 스캔은
    주기·지금 스캔·임시 스캔·폴 워커와 **같은 잠금** `tryAcquireScan`). **새 중앙 → 엣지 POST 는 멱등인지부터 볼 것.**
  - 그 밖: 위임 0건 엣지는 CVP 상태 칸을 차지하지 않는다(`noDelegation`) · CVP 파트 조회는 '시도함' 이면 주기를 넘긴다(전부 404 인 장비를
    매 주기 다시 묻고 '시간 예산' 탓을 하던 것) · `disconnected`→down · 모르는 hwStatus 는 unknown · BGP prefix 부분 합은 '최소' ·
    NIC 사용률 100% 초과는 null + 사유(v2.578 D3) · `toBytes('3 tiers')` · PDU VA ×1 · 빈 팬 슬롯 absent · HPE 서비스태그 교정 시 파트 장애는
    `key-migrated` 로 옮긴다(알림 재발송 없음) · 임시 스캔은 인증 실패를 기록하지 않는다 · GPU 게스트 엣지 배포도 `droppedSecrets` ·
    ping 추이는 MIN/MAX 단독 · `sftpReadFile` 크기 상한 · 웹 늦은 응답·조회 실패를 0 으로 보이던 7화면 · 표 minWidth 10곳.
  - 남긴 것: ✅ PERF2612-03(백업 gzip 비동기 — v2.620) · ✅ `corruptOnlyReason`(registryCore 하나 — v2.613) · ✅ CVP BGP 피어 IP 가림(v2.640) — v2.741 LEFT-10 정정.
    남은 것: DB2612-03(LRU 가 prune 핸들 닫음 — vCenter 48개 초과) · GPU 배포 이름 대소문자 · 엣지 `bmstorWorker` 잠금 공유. 실장비(CVP·iLO·OME 리다이렉트 동작)는 보지 못했다.
- ⚠⚠ **v2.613 — 특수 기능·신규 기능 아키텍처 점검(1단계) 확정분**(사용자 요청 "신규 기능, 특수기능 아키텍처 점검" ·
  선택 "둘 다(점검 먼저 → 그 결과를 화면으로)" · 전체 검증. 8축 발견 96 = 확정 57 · SPLIT 25 · 가능성 6 · 반증 8 → 파일이 겹치지
  않는 8그룹 병렬 수정 + 그룹별 워크트리 변이 검증. 회귀 `test/audit2613{a..h}.test.js` + 웹 `audit2613a/b.test.js` 외.
  상세 `docs/AUDIT-2026-09-25c.md`. 2단계(운영 포탈이 스스로 도는 '아키텍처 점검' 화면)는 v2.614):
  - ⚠⚠ **카탈로그의 `adminOnly` 는 이제 실제 API 게이트와 일치해야 한다 — 테스트가 docs/API.md 게이트 열과 대조한다**
    (CATALOG2613-01, `web/src/views/audit2613a.test.js`): v2.555 가 "adminOnly 는 표시 관례이고 접근제어가 아니다" 라고
    적은 뒤 15개가 양방향으로 어긋난 채 남아 있었다(관리자 전용 라우트인데 카드는 열려 있거나 그 반대). 새 도구를 넣을 때
    플래그를 라우트 게이트와 맞추고 `node scripts/api-doc.mjs` 를 돌릴 것(그 문서가 대조 원천이다).
    · 잠금 판정은 `views/toolVisibility.js lockReasonOf` 하나 — 카드 그리드·V4 내비·⌘K 팔레트·pages/Tools 가 같은 함수를 쓴다
      (예전엔 V4 내비가 잠금을 표시하지 않았다). 소유 화면 밖에서 `/api/tools/<seg>` 를 부르는 파일은 `toolAllowed(키)` 를
      먼저 본다(IPMS 대조·NSX 세그먼트 — 웹 스윕이 허용 목록과 대조).
    · **새 도구의 `/api/tools/<seg>` 는 세그먼트 == 카탈로그 키**다(`auth/toolAccess.js` 머리말 규약). 다른 것은 동결된
      `LEGACY_SEGMENT_KEYS`(18)뿐이고 늘리면 테스트가 실패한다. `TOOL_PATH_KEYS` 의 `current-users`·`horizon-sessions` 는
      `curuser` 로(예전 선언은 사실이 아니었다).
    · 도구 안 서브탭은 `useHashTab({base:['tools',<k>]})` 로 URL 에 싣는다(포탈 점검·통신 점검·파트 장애). ⚠ SanSwitchTool 의
      `tab` 은 장비 모달 안의 탭이라 대상이 아니다(검증 표가 틀렸다 — 장비 id 없는 딥링크는 뜻이 없다).
    · 옛 상단 주소 `#/explore`·`#/nsx` 도 `MOVED_TABS` 로 옮긴다(v2.592 규약의 누락 2건).
  - ⚠⚠ **중앙 pull 사다리는 `central/edgePull.js pullFromEdge` 하나**(CONTRACT2613-01·EDGE2613-02): 엣지 로그·bm-usage·토큰
    점검이 각자 등록부→fetch→상태코드→본문 판정을 갖고 있어 같은 404 본문을 셋이 다르게 읽었다. 새 '중앙이 엣지에서 당기는'
    경로는 이 함수를 쓰고 `EDGE_PULL_KINDS`(10종) 안의 kind 만 낸다(웹 `edgeLogText.FETCH_KIND_TEXT` 와 1:1 — 테스트 대조).
    · 엣지 최소 버전은 서버가 상수로 갖고 응답에 싣는다 — CVP `MIN_CVP_EDGE_VERSION='2.608.0'`(kind old-version/
      unknown-version/silent/waiting) · 통신 점검 `MIN_EDGE_VERSION='2.552.0'`. '첫 보고 대기' 는 **기다리면 되는 경우에만**.
  - ⚠⚠ **SAN 스위치·PDU 도 상태 전용 push 를 보낸다 — 단 중앙이 2.613 이상일 때만**(EDGE2613-04, `agent/centralStatusOnly.js`
    `DEVICE_STATUS_ONLY_MIN_CENTRAL`): 수신 분기(`statusOnly:true` 면 목록을 건드리지 않는다)가 이 릴리스에 생겼으므로 구버전
    중앙에 빈 목록을 보내면 **목록이 지워진다**. 지원 여부는 health-probe 버전으로 필요 버전별 캐시(1h/실패 5m). storage 의
    `STATUS_ONLY_MIN_CENTRAL='2.581.0'` 은 그대로. v2.583 이 설계로 남긴 EDGE-3 을 닫았다.
    · sanswitch push 단일비행은 형제 5개와 같은 `_busy(프라미스)+_again` — `sanSwitchConfigPull` 의 `BUSY_REASON` 대조·
      `sleep(2s)×90` 루프는 삭제했다(합류 결과를 기다리면 된다). 거절 요약은 `util/centralReply.js dropSummaryOf` 하나
      (`dropped` 객체·`coerced`·`zoningTrimmed`·`evicted` 까지 읽는다 — `readDropSummary` 사본 3벌 삭제).
    · `/api/central/*` 51개의 인라인 토큰 게이트 쌍은 `requireCentral()` 미들웨어 하나(404→403 순서·본문 3변형 보존).
      `scripts/api-doc.mjs GUARD_NOTE` 에 등록했다.
  - ⚠⚠ **상태 파일을 만드는 헬퍼가 자기 파일명을 등록한다**(`util/stateFiles.js registerStateFile`, PERSIST2613-01·08):
    v2.590 P1 이 이름 목록으로만 막아 CVP 의 `central-agent-cvp.json`·`cvp-push.json` 이 백업 '설정 변경' 감시에 다시 잡혔다.
    `createDebouncedWriter`·`createActivityLog`·`createAuthGuard` 가 등록하고 `backup/service.js isRuntimeStateFile` 이 등록부도
    본다. **새 상태 파일 헬퍼는 등록할 것** — 스윕 테스트가 호출부 파일명 전부를 상태로 판정하는지 본다.
    · 등록부 5종(storage·sanswitch·pdu·cvp·bmstor)의 손상 판정·원소 필터·`devicesForThisNode/ForAgent` 는 `util/registryCore.js`
      하나. ⚠ 동작 차이: `devicesForAgent('')` 는 이제 `[]`(빈 이름이 중앙 직접 장비와 짝지어지지 않는다).
    · SQLite open 사본 3벌(storage/db·horizon/sessionDb·metrics/db)을 `util/sqliteOpen.js openSqlite + createLockRetry` 로 —
      `audit2611c` 의 이름 예외를 지워 일반 스윕(`new DatabaseSync(` ∧ ¬`openSqlite(` = ∅)이 전부를 본다.
    · 파트 장애 보존일은 설정 `retentionDays`(30~3650, 기본 730) + env `PARTFAULT_RETENTION_DAYS`(0 = 전부 보관). 화면
      `retentionText` 가 0 일을 빈 조각으로 두지 않는다(예전 `db?.retentionDays ? … : ''` 는 '전부 보관' 이 사라졌다).
  - ⚠⚠ **서비스 점검 대상은 `edgelog/spec.js STATUS_SPEC collect.*` 에서 파생한다**(RUNTIME2613-01, `health/services.js MODS`):
    고정 13항목이라 폴러 26개(vCenter 로그·용량 샘플러·인증서 감시 …)를 점검하지 않았다. **spec 에 collect.* 를 더하면 MODS 에도
    한 줄** — `audit2613g` 의 spec ⊆ MODS 검사가 먼저 깨진다. 응답 `coverage` 가 대상 밖 push/pull 워커를 말한다(웹 표시는 남은 일).
    · 기동 스태거 `STAGGER_STEP_MS = min(1500, floor(60000/N))` — 폴러 74개면 마지막 기동 59초(전 110초).
    · bmusage OS·ENT 세션 예산은 기동 시 장비 시한 − 5초로 자른다(`coupleBudget`, 잘랐으면 console.warn 1줄) — v2.550.3·v2.554
      의 '예산 < 시한' 산수를 코드가 강제한다. storage cliSsh(150s) vs poller(180s)는 아직 상수 관계다(남은 일).
    · `gpu-guest-data`·`fleet` push 는 BIG_JSON 등록 + gzip + 413 로그(v2.503 체크리스트의 누락 2곳).
  - **의존 방향**: `agent/envTimeout.js`·`agent/central404.js` 본체는 `util/` 로(옛 경로는 재수출 — `config.js` 는 util/·security/·
    내장만 import, arch2579 ②-c). '순환 회피' 라 적힌 동적 import 3곳은 순환이 없어 정적으로 바꿨다 — **동적 import 에 '순환'
    주석을 달려면 실제 되돌이 경로가 있어야 한다**(테스트가 BFS 로 확인, 진짜 3곳은 동결 목록). 정적+동적 이중 import 잔여 7곳은
    `KNOWN_STATIC_DYNAMIC_DUP` 로 고정(늘면 실패). 설정 pull 4종(gpuGuest·pdu·storage·users)은 404 를 `classifyCentral404` 로 가른다.
  - **웹 공용 코어**: 화면은 `/auth/me` 를 다시 부르지 않는다 — `api.hasRole`·`getCurrentUser()`(인증 꺼짐이면 App 이 `/auth/config`
    의 `serviceHubUrl` 을 Anonymous 사용자에 싣는다) · `util/fmt.fmtBytes(null) === '—'` · 상대시각은 `relTime.agoText`·
    `util/fmt.fmtAgo`, 톤 색은 `views/tools/toneVar.js` · 직접 `fetch(` 대신 `delJson/downloadFile`(IpamNet 의 1곳은 403·409 를
    성공처럼 보이던 무음 실패였다) · 온도 임계는 `serverTemp/board.js` 상수. 웹 스윕 4종이 사본 0 을 고정한다.
    ⚠ 그룹 보고가 '사용 0' 이라 적은 `PortalCheck.jsx` 의 `ago` 는 사용 중이었다(:225) — **'죽은 코드' 판정은 grep 결과를 붙일 것.**
  - **테스트·문서**: 설정 pull 진입 함수 4종을 목 중앙으로 실제 호출(`edgeSweep2574` IMP-06 이 `(push|pull|run)\w*(Now|Once)` 30개를
    열거) · `*Status` 스윕이 `async` 도 잡는다(spec 에 `collect.vcLogs`·`collect.capacity`·`collect.certs` 추가) · 2줄 stripComments
    사본 24파일 → `test/_stripComments.js` · 절대 시간 단언은 1초 상한 + 입력 확대(회귀 시 수 초) · `docs/ARCHITECTURE.md` 모듈
    지도·`docs/INDEX.md` 목록은 `scripts/arch-doc.mjs` 생성(CI `--check`). **docs/*.md 를 추가하면 생성기를 다시 돌릴 것**
    (이 릴리스의 감사 문서를 추가한 뒤 `audit2613h` 가 실제로 그것으로 실패했다).
  - ⚠ 작업 방식: 첫 수정 워크플로 8개가 전부 세션 한도(`session limit`)로 즉시 실패했다 — 작업 트리는 깨끗했으므로 한도 해제 뒤
    **처음부터 재실행**했다(v2.607 규약). 그룹 보고의 '리드가 할 것' 은 `scratchpad/arch2613/LEAD-TODO.md` 에 모아 통합에서 전부 처리했다.
- ⚠⚠ **v2.618 — 전면 점검(6축 병렬) 확정분**(사용자 요청 "코드 수정·튜닝·오류 수정·튜닝 포인트·보안·메모리 누수·코드·아키텍처 점검".
  상세 `docs/AUDIT-2026-09-26.md`, 회귀 `server/test/audit2618.test.js` + 웹 `views/audit2617.test.js`(v2.747 에 version_5/ 에서 옮김)):
  - ⚠⚠ **새로 만든 상한·게이트는 '인증된 저권한 계정' 이 점유할 수 있는지 먼저 볼 것**(SEC-1 — v2.617 초판이 그랬다): 전역 풀 하나를
    세션(viewer 포함)과 엣지가 나눠 쓰면 느린 본문 몇 개로 엣지 수신 전체가 막힌다. 계열별 풀 · 요청자당 상한 · 본문 읽기 시한이 짝이다.
  - **503 에 Retry-After 를 실었으면 받는 쪽이 따르는지 확인할 것**(ARCH-2) — `resilientFetch.retryDelayMs`(429·503, 상한 30초 + 흔들림).
  - ⚠⚠ **조회 실패를 빈 목록으로 삼킨 화면에 '저장' 버튼이 있으면 데이터 소거 경로다**(WEB-2 — vCenter 순서). 실패는 따로 들고 저장을 막고,
    서버도 빈 목록 저장은 명시적 초기화일 때만 받는다. 설정 화면을 만들 때 '불러오기 실패 → 저장' 순서를 먼저 떠올릴 것.
  - **env 숫자의 빈 값(`KEY=`)은 미지정**(`config.js numEnv` — BUG-1). `Number('') === 0` 이 '0 = 끔' 계약과 만나면 빈 줄 하나가 기능을 끈다.
  - **vCenter 상태 개수는 `consoleData.vcStatusCounts` 하나**(ARCH-1) — 롤업의 `vcentersPending`·`vcentersUnreachable` 를 읽는다.
    '전체 − 연결 − 점검' 뺄셈을 새로 쓰지 말 것(첫 수집 중·비활성을 불가로 센다).
  - 웹 사본 스윕(`audit2617.test.js`): 상대시각은 `relTime.js`, 숫자 판정은 `numOrNull.js` 만.
  - **메모리 누수 측정 결과 — JS 힙 누수 없음**(20분·힙 스냅샷 2장·+0.8MB). RSS 증가는 네이티브(추정). '누수' 로 적기 전에 힙 스냅샷을 볼 것.
  - 남긴 것: ✅ **PERF-1**(→ v2.619 — 아래) · ARCH-7 · ARCH-9.
  - ⚠ 작업 방식: 게시 전 PR 에 다음 버전 작업을 섞지 말 것 — 이번에 **추적되지 않은 새 테스트 파일이 stash 에서 빠져** 이전 릴리스 커밋에
    함께 올라갔다(`git stash` 는 untracked 를 담지 않는다 — `git stash -u` 또는 패치로 백업).
- ⚠⚠ **v2.620 — 6축 감사(버그·코드 개선) 확정분**(사용자 요청 "버그 및 코드 개선" · 선택: 병렬 감사 + 반증 · 전체 검증.
  상세 `docs/AUDIT-2026-09-26b.md`, 회귀 `server/test/audit2620{a..e}.test.js`·`perf2619.test.js ⑦` — 변이 검증 리드 6/6 · A 7/7 · B 15/15 · C 10/10 · D 10/10):
  - ⚠⚠ **'기억(서명)으로 쓰기를 생략' 하는 경로는 쓰기를 내보내는 순간 기억을 비운다**(RECENT2620-01 — **v2.619 가 만든 회귀**): 진행 중인 쓰기 B 와
    되돌아온 내용 A 가 겹치면 A 는 '옛 기억과 같다' 로 생략되고 B 는 seq 불일치로 기억을 못 세워 ipam.db 가 B 로 굳었다. 쓰기는 워커 한 줄로
    순서대로 끝나므로 현재 seq 의 성공만 기억을 세운다. **새로 '같으면 건너뛰기' 를 만들면 진행 중 쓰기와의 ABA 를 먼저 볼 것.**
  - ⚠⚠ **등록부 손상 503 은 설정 pull 만이 아니라 엣지 수신에도**(EDGE2620-01): 수신 라우트가 빈 등록부로 소유 판정을 하면 200 + 삭제·버림이 되고
    엣지는 커서를 전진해 **영구 소실**이다(v2.612 LEFT2612-01 의 형제 누락). 상태 전용 보고는 등록부를 쓰지 않으므로 200.
  - ⚠⚠ **자격증명을 싣는 장비 요청은 `util/noRedirect.js`**(SEC2620-01 — v2.612 SEC2612-02 가 CVP·Redfish 에만 고친 것의 형제 7곳): 전역 fetch 의
    follow 는 307 에 로그인 본문·커스텀 세션 헤더를 다시 보내고 IP 리터럴이면 SSRF lookup 도 없다. ⚠ 동작 변경 — http 로 등록하고 장비의 https
    리다이렉트에 기대던 현장은 '리다이렉트로 응답했습니다' 오류를 받는다(조치: 등록 주소를 https 로). **새 장비 클라이언트도 이 헬퍼를 쓸 것.**
  - **엣지 push 의 이름은 `util/agentNameHeader.js` 로 헤더에도**(RECENT2620-02): 큰 본문 게이트는 본문을 읽기 전에 요청자를 가려야 한다. 한글 이름을
    헤더에 원문으로 넣으면 fetch 가 요청째 던지므로 ASCII 안전할 때만 싣는다(본문 agent 와 **같은 값**만 — 개별 토큰 바인딩 대조). 이름 없는 엣지를
    IP 한 칸으로 묶지 않는다. ✅ 원문 헤더를 싣던 나머지 워커는 v2.629 A6-01 에 `agent/agentNameCarry.js` 로 옮겼다(v2.741 LEFT-10 정정).
  - **세션 큰 본문 풀은 경로 권한을 먼저 본다**(`bigJsonGate sessionBigBodyAllowed` — viewer 가 풀을 점유해 admin 붙여넣기가 503) · 게이트 503 은
    `recordReject(kind:'busy')` · **Retry-After 대기는 abort 를 본다**(`resilientFetch abortableSleep` · `fetchFollowing` 이 호출자 signal 을 합친다 —
    호출자 abort 가 이제 진행 중 요청도 끊는다).
  - **dead-band 계열을 원본으로 읽는 조회는 이월**(SRV2620-02, `metrics/db.js recentAvgStep`·`historyStep`): 0.5℃ 미만 변화를 저장하지 않으므로 짧은 창의
    원본 평균·1시간 미만 버킷은 안정된 호스트를 빼거나 비운다. 이월은 `직전 저장 + maxGap + 5분`·마지막 실제 샘플(`lastSeen`)까지만.
    ✅ 실내 온도 1d(30분 버킷)도 v2.628 에 `historyStep` 으로 옮겼다(v2.741 LEFT-10 정정).
  - **낡은 vCenter 는 지표 적재에서 뺀다**(SRV2620-03, `metrics/sampler.js staleVcenterIds`): LASTGOOD_HOLD·위임 캐시가 서빙하는 마지막 값을 매 주기
    '지금 값' 으로 쌓으면 평탄선이다(v2.504 iDRAC 규약의 vCenter 판). 빠진 vCenter 가 있으면 전체('') 합계는 적재하지 않는다(부분 합 = 거짓 하락).
    `updateVmStats`(라이트사이징 인메모리)는 같은 유형이 남아 있다.
  - 그 밖: 폴더 사용량은 전체 이름 지문(`name_set`)으로 '삭제·신규' 와 '순위 밖·순위 진입' 을 가른다 · 엣지 설정 push 는 상태 파일 제외 + gzip + 413 1회
    재전송 · 백업 gzip 비동기(`createBackup`·`restoreCentral` 은 이제 async, 백업끼리 직렬) · 불통 엣지는 pull 큐 뒤·재시도 0 · 스토리지·SAN 엣지 보관
    키 정규화 · DataCenter 빈 순서는 `clear:true` 만(v2.618 vCenter 순서와 같은 모양 — **조회 실패 → 저장** 경로를 가진 화면을 만들면 먼저 볼 것) ·
    V5 상태 카드는 `healthError`·`upgrading` 을 먼저 말한다 · iDRAC 스캔 대역·결과·로그 **조회**도 fleetOnly · 파트 장애 `lastView`·CVP `maskErrText`.
  - 남긴 것: SRV2620-04(시계열 일 버킷 UTC 경계 — 차트 경계가 바뀌는 설계 판단) · WEB2620-06(V5 법인 선택의 vCenter 탭 적용) · PERF2620-02(LRU 가
    prune 핸들 닫음 — vCenter 48 미만이면 도달 불가) · 백업 `JSON.stringify` 동기 몫 · puller 첫 주기(실패 이력 전) 불통 엣지 약 61초.
- ⚠⚠ **v2.621 — 6축 감사(버그·코드 개선 2회차) 확정분**(사용자 요청 "한번 더" = v2.620 과 같은 방식. 발견 36 = 확정 32 · 가능성 3 · 반증 1,
  6그룹 + 리드 통합. 상세 `docs/AUDIT-2026-09-26c.md`, 회귀 `server/test/audit2621{a,b,c,d,f,lead}.test.js` + 웹 `views/audit2621e.test.js`·
  `views/tools/audit2621f.test.js`·`serverTemp/board.test.js` — 그룹별 변이 검증 전부 통과):
  - ⚠⚠ **`ErrorBox` 는 문자열·Error·HttpError 를 다 받는다 — 정규화는 `accessDeniedText.errorBoxInput` 하나**(WEB-01·RECENT-01 — **v2.620 이
    만든 회귀**): v2.620 이 `setLoadErr(e)` 로 객체를 넘기자 4xx 하나로 탭 전체가 React #31 로 죽었다(12곳). 403 은 권한 안내, 5xx 는 서비스 안내.
    ⚠ 오류 객체를 상태에 넣었으면 **그 상태를 글자로 그리는 다른 곳**(`폴링 오류: {err}`)도 문자열로 바꿀 것 — 같은 크래시가 된다.
    403 은 다시 물어도 결과가 같다 — 폴링하는 화면은 403 이면 **폴링을 멈춘다**(긴급중단·폴더 사용량 2화면·트래픽 분석·iDRAC 스캔 잡).
  - ⚠⚠ **step 채움을 넣었으면 점 상한도 다시 계산할 것**(RECENT-02 — v2.620 회귀): 빈 버킷도 점이 되자 5000점 상한이 '1주·분' 을 3.47일로
    조용히 잘랐다. 상한은 기간을 덮는 버킷 수(상한 1주×분)이고 넘치면 `truncated`·`coveredSince`·`limit` 을 싣는다 — 모달이 `histCutNote` 로 말한다.
  - **'못 읽은 것' 을 정상으로 보고하지 않는다 — 이번엔 일일 헬스체크**(DATA-02): 경보 미조회·첫 수집 중·낡은 위임·점검중 vCenter·사용량 미상 DS 는
    섹션 `unknown`('확인 불가') 이고 전체 순서 crit > warn > unknown > ok. 점검중 vCenter 샘플 제외(RECENT-03)는 `unreadVcenterReasons` 하나 —
    첫 수집 중(pending)은 **일부러 뺐다**(push 하지 않는 site 가 전체 합계를 영원히 막는다 — 판단 필요로 남김).
  - **시각 오프셋 변환은 `loganalysis/parse.js` 와 같은 식**(DATA-01): `+0900` 이 `++09:00` 이 되어 게스트 로그인 실패가 전부 '지금' 으로 적재됐다.
    저널이 있으면 저널만 읽는다(rsyslog 가 옮겨 적은 secure 와 이중 적재). `runGuestScript` 의 stdout 상한은 `outMax`(기본 2000 — 호출부 불변) ·
    잘리면 `stdoutTruncated` — 로그인 조사는 32,000자(tail 80줄의 **최신** 줄이 앞 2000자 밖이었다).
  - **위임 잡을 순차로 처리하는 엣지에는 한 번에 하나만 준다**(EDGE-01 — `idracScanJobs TAKE_MAX` 1): 전량 인출하면 뒤 잡이 거짓 재대기·gc 로
    결과가 200 과 함께 버려진다. 모르는 reqId 는 410 `unknown-job` · 결과 재수신은 정제본 서명으로 멱등(EDGE-07) · 레거시 할당 스캐너도 공용
    스캔 잠금(`tryAcquireScan('assign')`, LIFE-01). ✅ `captureJobs` 의 모르는 reqId 는 v2.622 LEFT-03 에 410 이 됐다(v2.741 LEFT-10 정정).
  - **엣지 push 3종(스토리지·SAN·PDU)은 `registryLoadError()` 를 먼저 본다**(EDGE-03): 예전 catch 는 죽은 코드라 손상 등록부가 '위임 0대' 로 중앙을
    비웠다(CVP 는 v2.620 에 고쳤다 — 형제 비대칭). 중앙 part-faults 수신도 등록부 손상이면 503(EDGE-04).
  - **설정 push 413 재전송은 뺀 파일을 `retainFiles` 로 밝힌다**(RECENT-09): 중앙이 그 이름의 직전 사본을 유지(`retained`). 구버전 중앙은 몰라서
    교체한다 — 엣지가 `centralRetainUnsupported` 로 상태·콘솔에 남긴다. `AGENT_CONFIG_PUSH_TARGET_BYTES`(기본 15728640).
  - **범위 관리자 차단 — 이번엔 중계 프록시 형제 라우트·GPU 게스트 SSH 테스트·폴더 사용량 조회**(SEC-01~03): 새 게이트 이름
    `fleetReadOnly`·`rawIpFleetOnly` 는 `scripts/api-doc.mjs GUARD_NOTE` 에 등록했다(없으면 apiDoc2563 이 실패한다 — 이번에 실제로 실패했다).
    v2.611 이 '폴더 사용량 조회는 연다' 고 정한 것을 되돌렸다(응답이 RMA 엣지 IP·fileRoots 를 싣는다 — `audit2611b` 단언 갱신).
    GPU 게스트 수집기의 `usableIp` 는 정규식 + 접두 비교라 `000.0.0.0` 이 루프백에 닿았다 → `strictIpv4Num` + `ipBlockReason` + 루프백 상시 제외.
  - **HPE 서버는 목록·CSV·상세에서 벤더로 구분한다**(WEB-04·05, `views/tools/serverVendorText.js` 하나): 엣지 export 가 `vendor`(hpe·dell)를
    싣고 중앙은 그 둘만 받는다(없으면 '벤더 미상' — Dell 로 채우지 않는다). 미지원 장비의 `noCreds` 는 '통과' 가 아니라 '시도 안 함'.
    ⚠ 위임 스캔 결과 정제(`sanitizeIdracScanData`)에도 새 필드를 더할 것 — 이번에도 한 번 빠졌다(v2.611 CEN2611-01 과 같은 유형).
  - 그 밖: 팹 스위치 합산 부분 합은 이월(주기×2) 또는 `partial`(DATA-03) · HPE PSU 센서는 흡기 아님(DATA-04, 가능성) · IPMS 스캔 대역 조회 실패면
    저장 잠금(`vcRangesGate`) · 개요 '사용량 미상 DS N개' 문구(`storageUsageUnknownNote`) · V4 물리 서버 KPI 대체 제거(`physicalServersKpi`) ·
    작업 로그는 같은 틱을 묶어 쓴다(N=60: 83ms → 4ms) · Enterprise 대체 경로 Redfish 는 signal 을 끝까지(공유 세션 POST 제외) · 수집 요청 큐 seen 상한.
  - 남긴 것: RECENT-10 · DATA-05(가능성) · 새 엣지 상태 필드의 전용 문구 · `updateVmStats` 낡은 누적. ✅ `rawGet` 세션 폴백의 거짓 인증 정지(v2.622 LEFT-01 `sessionTransient`)와
    섀시 Sensors 일시 오류의 6시간 absent 캐시(v2.622 LEFT-02 — 404 에만)는 고쳤다(v2.741 LEFT-10 정정).
- ⚠⚠ **v2.622 — 6축 감사(버그·코드 개선 3회차) 확정분**(사용자 요청 "한번 더" = v2.620·v2.621 과 같은 방식. 발견 34 = 확정 26 · 가능성 4 · 반증 4,
  6그룹 + 리드 통합. 상세 `docs/AUDIT-2026-09-27.md`, 회귀 `server/test/audit2622{a..e,lead}.test.js` + 웹 `views/audit2622f.test.js`·`views/tools/audit2622d.test.js`·
  `views/audit2622lead.test.js` — 그룹별 변이 검증 전부 통과):
  - ⚠⚠ **세션 폴백의 '인증 실패' 는 명시적 401/403 뿐이다**(LEFT-01 — `idrac/redfish.js` rawGet): 세션 POST 가 시한·5xx 로 실패하거나 토큰 GET 이
    실패하면 예전에는 Basic 401 로 떨어져 authGuard 가 **멀쩡한 iDRAC 의 주기 수집을 정지**시켰다. 이제 그 경로는 `sessionTransient`(authFailed 없음).
    **새 인증 폴백을 만들 때 '폴백 실패' 와 '자격증명 거부' 를 같은 결과로 합치지 말 것**(v2.535 authGuard 가 그 차이에 기댄다).
  - **'없음' 캐시는 404 에만**(LEFT-02 — Sensors 컬렉션): 503·시한을 6시간 absent 로 기억하면 일시 오류가 6시간 공백이 된다.
  - ⚠ **점검중(maintenance)은 기한 없는 상태다 — 전체 합계를 막는 집합에 넣지 말 것**(RECENT-01 — v2.621 이 만든 회귀): 그 vCenter 행만 빼고
    부분 합(`totalPartial`·`maintenanceExcluded`)을 싣는다. pending 을 뺀 이유(합계를 영원히 막는다)와 같다. unreachable·stale 은 예전대로 보류.
    ✅ 화면은 v2.628 에 `samplerWithheldText`(totalPartial)로 그 사실을 말한다(v2.741 LEFT-10 정정).
  - **같은 이름의 숫자는 판정도 한 벌**(RECENT-02): 일일 헬스체크 '사용량 미상 DS' 는 `store.dsUsageUnknownOf`(capacityGB>0 조건)를 쓴다.
  - **하한값을 추이에 적재하지 않는다**(DATA-02·03 — Horizon·현재 사용자 이름 목록 절단): v2.606 COL2606-01 규약의 누락. 합집합은 `unionLowerBound` 로 '최소 N명'.
  - **'판정 근거 없음' 을 미보호로 세지 않는다**(DATA-05): 이벤트를 수집하지 않은 vCenter 의 VM 은 '판정 불가' 로 따로 센다 — 라우트가 로그 설정과
    조회 창 커버리지를 넘겨야 동작한다(함수만 고치고 호출부를 잊으면 수정이 무효다 — 이번에 그룹 수정이 딱 그 상태였다).
  - ⚠⚠ **위임 잡의 '조용한 삭제' 를 없앤다**(RECENT-03·EDGE-02): 엣지가 잠금 중이면 폴하지 않아 대기 잡이 10분 뒤 기록 없이 지워졌다. gc 는 오류로
    종결하고 보존 뒤 지운다. 잠금 중 생존 폴(`?busy=1`)은 **중앙이 2.622.0 이상일 때만**(`IDRAC_BUSY_POLL_MIN_CENTRAL`) — 구버전 중앙은 busy 를 무시하고
    잡을 주고, 엣지는 받은 잡을 반납할 수 없다. **새 쿼리 플래그로 중앙 동작을 바꾸면 구버전 중앙이 그 플래그를 무시했을 때를 먼저 볼 것.**
  - **모르는 reqId 는 410, 재전송은 멱등**(LEFT-03 capture · EDGE-03 bmstor) · **순차 실행 엣지에는 한 번에 1건**(EDGE-01 RMA — v2.621 iDRAC 스캔 TAKE_MAX 의 형제) ·
    **stored:false·acked:false 는 실패**(EDGE-04 edgeLogWorker).
  - **범위 관리자**: 전역 알림·일일 보고 저장/발송(SEC-01) · GPU 게스트 배포/진단/엣지 사용자/물리 GPU 조회(SEC-03) · NSX 매니저 목록(SEC-04).
  - **웹**: 대상(엣지·vCenter)을 바꾸는 설정 화면은 새 대상 조회가 성공하기 전에 폼을 비우고 저장을 잠근다(WEB-01·03·04·08 — 이전 대상 값이 새 대상에
    저장·삭제되던 것) · 조회 실패를 '없음' 으로 보이지 않는다(WEB-06) · `null GB` 금지(WEB-02) · HPE 서버 상세 제목은 모든 진입점이 `detailServerOf` 를 쓴다(RECENT-04).
  - 남긴 것: curuser `partialRows` 표시 · 물리 GPU·NSX 403 의 권한 안내 컴포넌트화. ✅ 용량 추이 화면의 `vmperfStale`·`vmStatsSkipped` 표시는 v2.628 `samplerWithheldText` 가 한다(v2.741 LEFT-10 정정).
- ⚠⚠ **v2.628 — 6축 감사("프로그램 개선해줘") 확정분**(상세 `docs/AUDIT-2026-09-27b.md`, 회귀 `server/test/audit2628{a,b,d}.test.js` +
  웹 `views/tools/audit2628a.test.js`·`views/audit2628c.test.js`(v2.747 에 옮김)·`views/audit2628d.test.js` — 그룹별 변이 검증 전부 통과):
  - ⚠⚠ **범위 관리자 차단은 `routes/` 최상위 파일도 본다**(SEC2628-01 high — 재현): `routes/upgrade.js` 가 역할만 봐서 범위 관리자가 업그레이드
    설정·적용·재시작·번들 설치를 할 수 있었다. `audit2612a` 스윕은 `routes/api/*`·`routes/admin/*` 만 본다 — `routes/capacity.js`·`routes/auth.js`
    (AD 설정·연결 테스트)도 같은 이유로 빠져 있었다. **새 라우터 파일은 위치와 무관하게 '범위 참조 0건' 인지 먼저 볼 것.**
    ⚠ `routes/auth.js` 의 `const adminOnly = [authMiddleware, requireEnrolled, requireRole('admin')];` 는 **글자 그대로** 둔다
    (`securityAudit2026-08-17` 가 고정한다) — 게이트를 더할 때는 별도 이름(`adFleetOnly`)으로. 새 게이트 이름은 `api-doc.mjs GUARD_NOTE` 에.
  - ⚠⚠ **짧은 이름 색인에 IP 를 넣지 말 것**(C2628-01 high — 재현): `shortOf('10.20.1.11')` 가 `'10'` 이 되어 10.x 로 등록된 iDRAC 서버 전부가
    그 ESXi 호스트와 같은 장비·같은 법인이 됐다(개요 물리 전용 과소 · v2.626 부터 법인별 사용량·수집 대상까지). 짧은 이름이 두 vCenter 에 걸리면
    판정 근거가 아니다(`AMBIGUOUS`). 이름 매칭을 새로 만들 때 **IP·중복 짧은 이름** 두 경우를 테스트에 넣을 것.
  - **법인별 사용량**: 읽히지 않는 vCenter(`metrics/sampler.js unreadVcenterReasons`)의 호스트 값은 대체값으로 쓰지 않는다 · 엣지 행은 그 엣지 주기로
    신선도(`_freshMs`) · 다른 vCenter 의 같은 key 는 조용히 빼지 않고 `keyConflict` · 지표별 대체 + `cpuMissing`/`memMissing` · 출처 합집합은 `mixed`.
    ✅ (v2.629 에 `corpusage edgeRowOf` 로 고쳤다 — v2.741 LEFT-10 정정) **남긴 것 C2628-05**: 엣지 위임 베어메탈(서비스태그 없음)의 중앙 키(`edge:<agent>:<fleetId>`)와 엣지 행 키가 달라 늘 '못 읽음' 이다 —
    fleet push 계약 변경이 필요하다(다음 점검 첫 후보).
  - **배포 인출 기록**: 공유 토큰 인출은 `verified:false` 이고 검증 기록을 덮지 못한다 · 엣지는 받기 전 판을 알리므로 방금 받은 엣지는 `delivered`.
  - **베어메탈 사용률 폴러**: 보존 정리는 켜짐·대상 수와 무관하게 돈다(`pruneTick`, 첫 틱 제외) · 입력 실패는 `sourceErrors` + 분류 실패는 '대상 없음' 이
    아니라 실패 · 404·CENTRAL_URL 없음은 `keptCopy`/`staleCopy` 로 '마지막 배포 사본이 계속 적용된다' 고 말한다(사본 유지 설계는 그대로).
  - 남긴 것: 새 상태 필드(`sourceErrors`·`lastPrune`·`keptCopy`·`staleCopy`·전산실 `stepFilled`)의 화면 문구. ✅ `GET /admin/metrics/settings` 의 범위 관리자 lastRun 은
    v2.629 A6-04 `scopeSamplerStatus` 로 고쳤다(v2.741 LEFT-10 정정).
- ⚠⚠ **v2.629 — '다시 3번더' 1회차 확정분**(상세 `docs/AUDIT-2026-09-27c.md`, 회귀 `server/test/audit2629{a..e}.test.js` + 웹 `views/audit2629{a,f}.test.js` — 그룹별 워크트리 변이 검증 전부 통과):
  - ⚠⚠ **'서버 분석 조회에는 범위를 걸지 않는다'(v2.604) 규약은 폐기다**(AUTHZ2629-03): 범위 관리자는 허용 vCenter 에 귀속된 iDRAC 서버만 본다
    (`routes/admin/idracCore.js scopeIdracServers` — 귀속 = 명시 vcenterId → mappedVcenterId → 서비스태그 ESXi, 귀속 없음 미노출). iDRAC 에 **실시간 로그인**하는
    경로(gpu-probe·inventory?refresh=1·sensors?live=1)는 전체 범위 전용이다. 새 서버 분석 조회를 만들면 이 헬퍼를 쓸 것.
  - ⚠⚠ **엣지 → 중앙 요청의 이름은 `agent/agentNameCarry.js`**(A6-01): 원문 `'X-Agent-Name': name` 은 비-ASCII 이름이면 fetch 가 요청째 던진다. 헤더로 안전할 때만
    싣고 아니면 `?agent=`(중앙 requestedAgent 가 쿼리 → 헤더 → 본문 순서로 본다). v2.620 이 9곳만 옮기고 23곳이 남아 있었다 — `audit2629c` 가 원문 헤더 0 을 스윕한다.
  - **배포분을 교체하는 pull 은 '지우기 전에 검증'**(EDGE2629-01 — svcmon 배정): 새 정의가 거부되면 이전 배포분을 그대로 두고 ack 가 그 사실을 말한다.
  - **회수 가능량은 정지 VM 과 스냅샷이 겹친다**(DATA2629-01·02 — `diskTrend.snapshotReclaimGB`): 정지 VM 의 committed 에 스냅샷이 이미 들어 있다. ✅ 시계열은 v2.630 DATA2630-01 에 `vm_snap_on_gb`(켜진 VM 스냅샷만)를 더해 고쳤다(v2.741 LEFT-10 정정).
  - **같은 서비스태그 = 같은 물리 서버**(A1-2629-01): 키 충돌(keyConflict)은 이름·fleetId 키에만 쓰고, 서비스태그가 같으면 한 대만 센다(`dupSameBox`).
  - 사용자 입력 문자열을 반복문 안에서 가공하지 말 것(AUTHZ2629-01 — 검색어 900KB × VM 2,242 = 3.2초) · 압축 파일은 로드 전에 선언 크기 합을 본다(SEC2629-09).
- ⚠⚠ **v2.630 — '다시 3번더' 2회차 확정분**(상세 `docs/AUDIT-2026-09-27d.md`, 회귀 `server/test/audit2630{a..d,lead}.test.js` + 웹 `views/audit2630{e,f}.test.js`):
  - ⚠⚠ **압축 해제 상한은 '선언' 이 아니라 '실제로 푼 양' 이다**(SEC2630-01 — v2.629 가드의 우회. `svcmon/formats.js zipInflatedSize`): zip 중앙 디렉터리의 크기는
    파일이 스스로 적은 값이다. 로드 전에 각 항목을 `maxOutputLength` 로 실제로 풀어 센다(v2.593 R2593-02 '만들어지는 사본까지 센다' 와 같은 판단).
  - ⚠⚠ **엣지 시각은 원본(`edgeCollectedAt`)과 표시용 clamp(`collectedAt`)를 나눠 싣는다**(A4-02, `routes/central.js stampEdgeCollectedAt`): '지금 수집' 완료 판정·
    중복 제거·기준선은 **엣지 시계 원본**끼리 비교한다(v2.591 R-Q1 '두 시계를 섞지 않는다' 의 수신 쪽 누락). 새 엣지 수신 경로도 같은 규칙.
  - **범위 계정 iDRAC 귀속은 corpAttribution 색인까지 본다**(R2630-01 — v2.629 의 사본 판정이 DataCenter 규칙 서버를 뺐다). 귀속 판정을 새로 쓰지 말 것.
  - **판정 헬퍼를 단건·일괄이 공유한다**(AUTHZ2630-01 — IPAM bulk 가 기존 claim 을 보지 않았다): 형제 라우트에 판정을 인라인으로 두면 한쪽이 빠진다.
  - 게스트 디스크 부분 합은 추이에 적재하지 않는다(A2-01 — v2.606 '부분은 하한' 규약의 누락) · CVP 미연결 포트·모르는 BGP 상태는 down 이 아니다(A2-02·03).
  - 폼은 서버의 '끔(0)' 을 기본값으로 덮지 않고, 바꾼 칸만 보낸다(WEB2630-01·02 — `web/src/views/settingsFormDiff.js`).
- ⚠⚠ **v2.631 — '다시 3번더' 3회차 확정분**(상세 `docs/AUDIT-2026-09-27e.md`, 회귀 `server/test/audit2631{a,b,c}.test.js` + 웹 `views/audit2631d.test.js`·`views/tools/audit2631{c,e}.test.js`):
  - ⚠⚠ **엣지에 배포하는 '설정' 도 손상 판정이 필요하다 — 등록부만이 아니다**(EDGE2631-01 high, `util/settingsLoadError.js`): 설정 모듈이 손상 파일을 기본값(꺼짐)으로 읽으면
    pull 라우트가 그 기본값을 200 으로 전 엣지에 내려 **엣지 사본까지 덮는다**(유일한 정상 사본 소실). 설정 모듈은 `*LoadError()` 를 두고 pull 라우트는 503 `settingsUnreadable`.
    '원본 없이 `.corrupt` 만 있음'(손상 뒤 재시작)도 못 읽은 것이다(v2.612 `corruptOnlyReason` 재사용). **새 중앙→엣지 설정 배포를 만들면 이 판정부터.**
  - **부분 합을 보류할 때 '보류 기준' 이 부분 합이 아닌지 확인할 것**(R2631-01 — v2.630 게스트 디스크): 표시용으로 넣은 부분 합 행이 다음 주기의 '직전 온전한 값' 이 되면 값이 영원히 멈춘다. 행에 `partial` 표지를 두고 보류에는 시한을 둔다(v2.601 '보류에는 반드시 시한').
  - **서버가 null 을 보내기 시작하면 그 값을 그리는 화면을 같은 릴리스에서 맞출 것**(이번 회차 `/summary`·`/tools/waste`·`/top`): `${v}%` 는 'null%' 가 된다 — `unitText` 로.
  - 정렬값 `data-sort={v ?? -1}` 금지 — 값 없는 행이 오름차순 맨 앞에 온다. `?? ''`(STable 이 빈 값을 항상 뒤로 보낸다).
  - 웹소켓 서버는 `maxPayload` 를 준다(ws 기본 100MiB — 프레임 하나로 수백 MB 할당).
- ⚠⚠ **v2.632 — '한번더' 확정분**(상세 `docs/AUDIT-2026-09-27f.md`, 회귀 `server/test/audit2632{a..f,lead}.test.js` + 웹 `views/audit2632{b,f,lead}.test.js`·`views/tools/audit2632c.test.js`):
  - ⚠⚠ **설정 손상 판정은 '배포되는 설정 전부' 에 — v2.631 은 5종만 막았다**(EDGE2632-01 high): 성능점검 배정·SAN 포트 사용량·스토리지/PDU 주기·통신 점검·IP 스캔 배정이 빠져 있었다.
    **새 중앙→엣지 설정 배포를 만들면 `util/settingsLoadError.js` 등록부에 넣고 pull 이 503 또는 `…Unreadable` 표지로 답할 것.**
    ⚠ 엣지가 `body?.x || {}` 로 적용하는 경로는 중앙이 필드를 빼기만 해도 지운다 — 구버전 엣지에는 응답 전체 503 이다(`?intervalsHold=1` 을 보내는 새 엣지만 필드 생략).
  - ⚠⚠ **새 503 을 만들면 받는 엣지가 그것을 '무연결' 로 세지 않는지 볼 것**(AX1-01 — v2.631 회귀): RMA 오프라인 명령은 연락 부재 시간으로 발동한다.
  - **undici 기본 입출력 시한은 300초다 — 그보다 긴 시한은 `resilientFetch.dispatcherFor`**(AX1-03 — v2.631 회귀): 시한만 늘리면 headersTimeout 이 먼저 끊는다.
  - **같은 숫자를 내는 경로(내부·공개 API·화면)는 같은 기준**(AX1-04·AX2-01): 비율의 분모는 설치 용량, 사용률은 읽은 데이터스토어만. 공개 API 대조 테스트는 재구현이 아니라 **내부 라우트 응답**과 비교한다.
  - 그 밖: 범위 관리자 형제 라우트 4곳(중계 프록시 설정·VM 생성 작업·DataCenter 목록·인증서 재확인) · RDP 티켓 필드 상한 · GPU 내보내기 스트리밍 + 동시 1건 · 용량 요약 60초 캐시 · 로그 CSV `(ts, rowid)` 커서 · NSX·Horizon 부분 합 · 이상 탐지 척도 하한 · 인시던트 시각 미상.
- ⚠⚠ **v2.689 — 전체 소스 점검(6영역 분석 → 컨펌 → 7그룹 Opus 병렬 수정) 확정분**(사용자 요청 "전체 소스 분석해서 버그·개선 각 10개 찾아
  중요도 보여주고 컨펌 받고 진행" · 사용자 질문 "분석은 Fable, 실행은 Opus 가 효과적인가?" → 그렇게 했고 **비교 데이터는 없다**(첫 기록 —
  `docs/AUDIT-2026-10-04.md` 그룹별 소요·되돌림 0건). 회귀는 `server/test/{releaseVersions,capacitySummary,g2Backup,g2Compress,g3Audit,g3Gates,
  g3Insights,g4CacheGc}2689.test.js` + 웹 `g5Web2689` + `horizon-uag-monitor/tests/MonitorFixTests.cs` + `uagmon/test/{server,units}2689` — 전부 변이 검증 통과):
  - ⚠⚠ **릴리스 워크플로는 이전 `versions.json` 을 못 받으면 '빈 목록으로 시작' 하지 않는다**(`release.yml` 'Fetch previous versions.json'):
    예전 `download … \|\| true` 한 줄이 일시 오류를 삼켜 새 버전 1개짜리 목록을 만들고, 그 뒤 prune 이 **목록 밖 버전 자산을 전부 지웠다**
    (롤백 경로·이력 소실). 3회 재시도 → 그래도 못 받으면 `gh release view` 로 자산 유무를 확인해 **자산이 있으면 실패**, '정말 처음' 일 때만
    `first=true` 로 prune 생략. `update-versions.mjs` 도 손상 목록은 중단. **이 두 보호를 `\|\| true` 로 되돌리지 말 것.**
  - ⚠⚠ **`/capacity` 요약은 시간 기준 양보 + stale-while-revalidate**(`capacity/evaluate.js`): 호스트×임계 지표 동기 SQL 이 700호스트 합성에서
    3,316ms 정지(최장 30ms 로) — v2.672 '양보는 시간 기준' 규약의 누락 지점. TTL 뒤에는 옛 값을 바로 주고 뒤에서 1건만 재계산하므로 응답
    `summaryRefreshing`·`summaryAt` 이 그 사실을 말한다(✅ 화면은 `CapacityAdvisor.jsx summaryCalcNote` 가 그린다 — v2.742 LEFT-03 정정).
  - ⚠⚠ **세션 연장 상한은 `lt`(원래 로그인 시각) 기준**(`auth/auth.js signToken` · `routes/auth.js /extend`): `iat` 는 연장마다 새로 찍혀
    `sessionMaxHours` 가 밀렸다(연쇄 연장 = 무기한). `lt` 는 토큰에 서명돼 승계되고 구버전 토큰만 iat 폴백. `/extend` 에 `requireEnrolled`.
  - **로그인 감사·활성 세션·실패 분석의 IP 는 `clientIp(req)`** — XFF 원문은 판정에 쓰지 않고 `xff` 필드(64자)로만 남긴다(형제 `auditMiddleware` 는 이미
    그랬다 — 비대칭). `/api`·`/api/svcmon` 에도 `auditMiddleware`(읽기성 POST 제외 목록 `audit.js AUDIT_SKIP` — 새 읽기성 POST 를 `/api` 에
    만들면 여기에 넣을 것, 아니면 감사가 쏟아진다). 게이트: GET `/admin/host-access` 전체 범위+소유자 · `/memtrack` fleetOnly ·
    `/emergency-stop` 은 범위 계정에 `by` 가림(`byHidden` — `audit2612a` 가 '상태는 본다' 를 고정해 403 으로 하지 않았다).
  - **vGPU 사용률 캐시는 `max(주기×3, 15분)` 을 넘으면 적용하지 않는다**(`soapClient.js applyGpuUtilCache` — 값 없음, 0 금지) · 조회 실패 시에도
    적용 루프는 돈다(예전엔 catch 가 적용을 통째로 건너뛰었다) · 캐시는 vCenter 별 Map 이고 수집마다 live ref 로 정리. 삭제 장비 캐시 정리 4곳
    (`storage/poller pruneAreasAt` · `fosSsh pruneCaps` · `redfish pruneSensorPaths`)은 **등록부 손상이면 생략**(빈 목록 = 전부 삭제가 되지 않게).
  - **백업 gz 는 `atomicWriteFileSync` 뒤에만 prune** · `restoreCentral` 은 `failed[]`(라우트가 감사 detail·`note` 에 싣는다) · `collectConfigDirAsync`
    (동기판은 `agent/configPush.js` 가 쓰므로 남겼다) · `util/compress.js` 는 진행 중 gzip Promise 를 공유(`gzPromise`).
  - **`routes/insights.js` 캐시 키는 클램프한 인자**(`originalUrl` 이면 `&_=난수` 로 single-flight 우회) + anomalies/forecast 는 `runHeavyExclusive`
    전역 1건. ⚠ `shared.js memoJson` 의 키 방식은 42개 엔드포인트 공용(`extraKey: scopeKey` 규약)이라 **바꾸지 않았다**.
  - **uagmon(Node)**: 핸들러 전체 try/catch(URL 400 · 그 밖 500) + `unhandledRejection` 로그 · `uncaughtException` 은 **로그 후 종료**(동기 핸들러가
    던진 자리의 미완 프라미스가 `polling=true` 를 영원히 남긴다 — systemd `Restart=always`·데스크톱 1회 재시작이 재기동). 루프백 모드는
    `lib/httpGuard.js`(Host 허용 목록 · 교차 출처 403 · JSON 필수 415 — pyportal `_cross_site` 와 같은 규칙, 데스크톱은 `http://127.0.0.1:<포트>` 로 열어 통과).
    Electron `requestSingleInstanceLock`(**실행 미확인**). 삭제·수정된 대상의 늦은 결과 폐기 · 저장 실패 시 메모리 되돌림 · 로그인 실패 Map 15분 만료.
  - **웹 — 선택(서버·기간)과 다른 응답은 그리지 않는다**(`horizonUsageText.usageRepFor` · `bmStorHistoryText.historyForPeriod`): 응답에 요청 키를 두고
    키가 다르면 null → Loading/오류만. CSV 는 **그려진 응답의 키**로. `CvpTool` 호스트명은 role=button + Enter/Space(행 onClick 과 이중 호출 방지).
  - **패키징**: `install.sh --port`(`^[0-9]{1,5}$`·1~65535)·`--prefix`(`^/[A-Za-z0-9._/-]+$`·`..` 금지) 검증 — `PORT='1/;d;s/x/'` 가 sed 로 들어가
    **portal.env 를 0바이트로 비웠다**(AUTH_SECRET 까지) · `uninstall.sh` 도 prefix 검증(`rm -rf "$PREFIX"` 앞) + otp 링크는 `$PREFIX/app/otp-enroll.sh` 를
    가리킬 때만 삭제 · `release.sh` 날짜 `TZ=Asia/Seoul` · CI 에 `node --test uagmon/test/*.test.js`(디렉터리 인자는 실패한다).
  - ⚠ **NoNewPrivileges — 유닛은 바꾸지 않았다(사용자 판단 사항)**: 본체 유닛 `NoNewPrivileges=true` 아래 `sudo -n firewall-cmd` 는 거부된다
    (컨테이너 `setpriv --no-new-privs` 재현: `sudo: The "no new privileges" flag is set…`). 그 문구는 `isSudoDenied` 에 걸리지 않아 화면은 `unavailable`
    원문만 보였다(분석 보고의 'sudoers 안내' 는 틀렸다) → `hostaccess/service.js NNP_NOTE` 안내만 추가. 실서버에서 유닛 밖 `sudo -u vmportal sudo -n
    /usr/bin/firewall-cmd --state` 와 포탈 화면을 비교해 가를 것. 근본 해결(NNP 해제 또는 헬퍼 분리)은 하드닝 약화라 별건.
  - **UAG Monitor 1.2**(`horizon-uag-monitor/CLAUDE.md` v1.2 절) — Windows 화면 미확인.
  - 남은 후보(다음 점검 첫 후보): prune 틱 카운터 · `install.sh --user` · hostAccess 변경 라우트 5개 전체 범위 게이트(정책 — v2.741 LEFT-12) · Electron 버전 고정(정책).
    ✅ 고친 것(v2.741 LEFT-10 정정): `capacity hosts` 표 영구 잔존·`Diagnostics.jsx` memtrack 403·uagmon scrypt(v2.740) · REST 폴백 `d.capacity||0`(v2.733 C2-06) · NDJSON 폴백 직접 쓰기(v2.741 LEFT-13 — 7곳 원자 쓰기).
- ⚠⚠ **v2.741 — 전체 소스 점검(10축 발견 → 발견마다 2인 반증 → 12그룹 병렬 수정) 확정분**(사용자 요청 "전체 소스 분석해서 버그 튜닝 개선해줘" · 선택 '10축 + 발견마다 2인 반증' ·
  '전체 검증'. 발견 54 = 확정 47 · SPLIT 3 · 가능성 4 · 반증 0, 고친 것 47건(중복 1 · 일부만 3 · 문서 정정 LEFT-10 포함) · 남긴 것 7건. 상세 `docs/AUDIT-2026-10-15b.md`, 회귀 `server/test/audit2741{a..l,lead}.test.js` +
  웹 `audit2741{c,g,j,lead}.test.js` — 그룹별 변이 검증(고친 파일을 감사 기준 커밋 2726851 판본으로 되돌리면 실패)):
  · ⚠⚠ **직전 릴리스 회귀 둘**: 자동 업그레이드 스캔 대기(v2.737)가 원격 확인 **실패** 한 번에 지워져 2시간 상한이 다시 시작됐다 — 대기를 지우는 조건은 '확인에 성공했고 새 버전 없음' 또는 자동 적용 꺼짐뿐이다(RECENT-01).
    v2.740.1 `hedgedFetch` 가 429·503 의 Retry-After 를 무시했다 — 그 응답을 받으면 `resilientFetch.retryDelayMs` 로 기다리고 그 뒤로는 함께 보내기를 멈춘다(RECENT-04 · v2.617 ARCH-2 규약).
  · **자동 업그레이드 대기**: 실행 중인 VM 복제 잡도 기다린다(`runningVmClones` — `runningScans` 와 나눴다) · 장비에서 분리 실행 중인(재개 가능한) 아이실론 du 는 기다리지 않는다(`resumable`) ·
    번들 push 동시 개수 `UPGRADE_PUSH_CONCURRENCY`(기본 4, 1~32 — 예전 Promise.all 무제한). ⚠ 업그레이드 대기 중 주기 틱이 새 장시간 스캔을 시작하는 것은 남았다(TIMING-03 일부).
  · **실행 중 스캔 기록**(`util/scanJournal.js`): 같은 키(iDRAC 'cycle' 등)의 대기 항목을 key+since 로 구분해 최근 4개까지 두고, 넘친 것은 이력 `superseded` · 재개는 자기 항목만 지운다(TIMING-04 — 예전엔 대역이 조용히 사라졌다).
  · **VM 복제 재시작 중단**(TIMING-01): 실행 중 상태를 잡의 `running` 에 동기로 기록하고, 다음 기동 때 `restart-interrupted` 로 남긴 뒤 그 실행이 만든 portal-clone 스냅샷 하나만 지우고 다시 돈다
    (재실행 2회·48시간 · 정리 실패는 10분 뒤 · 6시간이면 포기하고 수동 삭제 안내 — 화면 ⚠). 꺼진 잡은 수동 실행 때 정리한다.
  · **`adaptiveTimer` 재무장 기준은 '실행 끝'**(TIMING-05) — 같은 값의 변경 알림은 타이머를 건드리지 않는다. IP 스캔은 기동 즉시 전량 스캔하지 않고 마지막 완료 + 주기 뒤(최소 30초), 엣지는 마지막 스캔 시각을
    상태 파일 `ipscan-agent-state.json` 에 남긴다(TIMING-06 — 28곳이 함께 업그레이드되면 전체 스캔이 한꺼번에 나갔다).
  · **아이실론 du**: '지금 수집' 도 동시 상한(`ISIDU_CONCURRENCY` 2)을 지키고 나머지는 대기열(`queued`) · 30분 넘게 돈 실패는 1시간이 아니라 주기 뒤 재시도(DEV-05 — `failLongMs`) ·
    엣지 시계가 앞선 결과는 `edge_ts` 로 중복을 거르고 `clamped` 로 따로 밝힌다(거절 아님 — EDGE-01) · 잘못된 % 주소는 법인 현황으로(RECENT-02) · 보고서 기억 TTL 은 마지막 사용 기준(RECENT-03).
  · ⚠⚠ **인증 실패 판정에서 숫자 401/403 은 HTTP 문맥일 때만**(`util/authGuard.js isAuthFailureText`, DEV-01): 호스트명·경로·포트 속 '401' 이 주기 수집을 인증 정지시켰다. 낱말 규칙(인증 실패·
    authentication fail·permission denied)은 그대로다. 실패 분류는 **시한·출력 상한·이름 해석을 인증 문구보다 먼저** 본다(isidu). ✅ REST 수집기들의 `/401/.test(e.message)` 재던짐은 v2.742 DEV-03 `restCommon.isCredReject` 로 고쳤다(v2.744 LEFT-06 정정).
  · **SSH 세션 예산 — 두 수집기 더**(DEV-02, v2.528 Unity 규약): SAN `fosSsh` 100초(`SANSW_CLI_SESSION_BUDGET_MS`) · Isilon SSH 150초 — 예산 < 장비 시한 산수를 테스트가 고정한다.
    연결 테스트(60초)는 `timeoutMs − 10초` 를 넘긴다. ⚠ `sshExec` 의 exec 시한 하한이 1초라 1초 축척 테스트로는 시한 자르기가 보이지 않는다(정직 기록).
  · **nvidia-smi 가 CSV 대신 드라이버 실패 문장을 내면 그 첫 줄이 사유**다(DEV-04 — 예전엔 '출력이 비어 있음') · 로그 분석 규칙 `gpu-guest-nvsmi-driver` 추가.
  · **권한**: 사용자별 도구 재정의(`matrix.users`)도 목록과 같은 범위 경계(AUTHZ-01, `omittedOutOfScope`·`byHidden`) · VMware 구성 백업 다운로드(`?download=1`)는 `data.csv`(`csvPermIfDownload`, AUTHZ-02 —
    화면 버튼도 `canCsv()`) · VM 프로비저닝 배치 조회는 인증 정지 vCenter 에 로그인 0(AUTHZ-03) · 심층 검색 게스트 탐침은 `directCollectSkipReason` 으로 site·비활성·점검중을 건너뛴다(VC-05).
  · ⚠⚠ **vCenter 로그 뷰어 — 동작 변화**(DB-01·DB-03): 기본 '최근 7일'(24시간·7·30·90일·전체 선택) · 검색어·심각도 조회는 `logs/db.js searchAsync`(조각 + 시간 기준 양보 — 결과는 예전과 같다) ·
    **용량 상한은 '파일 크기' 가 아니라 '사용 중 크기'** 이고 폴러가 VACUUM 을 부르지 않는다(수 초 정지 대신 빈 자리를 새 로그가 다시 쓴다 — 상한을 낮춰도 디스크는 돌아오지 않는다).
    화면 헤더가 '사용 중 · 파일 · 빈 공간' 을 말한다. NDJSON 폴백 재기록 7곳은 원자 쓰기(LEFT-13).
  · **CVP**: 측정 장비 전부에서 못 읽은 방향의 트래픽 합은 0 이 아니라 null('—') · 일부만 못 읽었으면 KPI·법인 행이 부분 합이라 말한다(LEFT-04 — `trafficTotalsText`) · 장비 전력 계산은
    `parse.devicePower` 한 벌(전체 소비 전력과 같은 값 — 반올림은 표시 단계에서만, LEFT-05) · 슬롯 전원 항목은 PSU 로 세지 않는다(`powerSupplies` — 전력 탭 '못 읽음' 분류도 같은 목록, DEV-03).
    센서 상세 캐시 저장은 조각 직렬화 + 비동기 원자 쓰기(LEFT-08 — 60초마다 약 0.2초 정지).
  · ⚠⚠ **VM 스냅샷 크기가 실 vCenter 에서 늘 0 이었다**(VC-01): `layoutEx.file` 을 `<file>` 로만 잘랐는데 vim25 는 `<VirtualMachineFileLayoutExFileInfo>` ArrayOf 모양이다 — `soapParse.layoutFileBlocks` 하나가
    두 모양을 받는다. **업그레이드 직후 `vm_snap_gb`·`vm_snap_on_gb`·회수 가능 추이가 위로 뜬다**(이전의 0 이 틀린 값). 고아 VMDK 소유 집합도 이제 채워진다.
    REST 폴백 VM 의 사용률 결측은 할당·사용 계열에서 빼고 `vmUsageUnknown{cpu,mem}` 로 센다(VC-02 — 화면 문구 samplerWithheldText) · hostcfg 선택 묶음을 건너뛴 주기는 직전 값을 이월하고 10분 뒤 다시 묻는다(VC-04) ·
    스파크라인은 vCenter 당 로그인 1회(LEFT-03 — 20개 묶음 QueryPerf).
  · ⚠⚠ **수집기 라우터는 전역 JSON 파서보다 먼저 마운트한다**(EDGE-02, index.js '되돌리지 말 것' 주석): 그래야 라우트별 본문 한도(set-password·isidu-run 4KB · isidu-test 16KB)가 실제로 먹고, `tokenFirst` 가
    토큰을 본문 해석보다 먼저 본다(토큰 없는 깨진 본문은 400 이 아니라 403). idrac-scan·bmstor-collect 는 1MB 그대로(예전 선언 256KB/512KB 는 적용된 적이 없었다). **새 JSON POST 는 tokenFirst + 라우트 파서를 함께.**
  · **엣지 스토리지·PDU 설정 pull 은 '지금 수집' 결과를 기다리지 않는다**(LEFT-02 — v2.733 SAN C4-02 의 형제): 단일비행 작업(`collectJob`·`collectRun`) · bmstor-collect 는 객체 아닌 원소를 `dropped` 로(EDGE-03) ·
    svcmon `/state`·`/diag` 는 읽기 전용 목록(LEFT-06) · Horizon 기간 집계는 3일 조각 + 양보(DB-02 — 결과·순서 동일).
  · ⚠⚠ **IP 대장 엑셀 내보내기는 워커 스레드다**(LEFT-01, `ipam/excel.js renderIpamWorkbook` + `ipam/excelWorker.js`): 시트 조립은 생성기 `subnetSheetsGen` 하나를 동기판·양보판이 같이 돌고, 워크북 조립·직렬화는 워커에서 —
    결과 파일은 압축을 푼 항목 단위로 예전과 같다(테스트 고정). 실측 400시트 최장 정지 6.5초 → 38ms. 워커를 못 띄우면 인라인(콘솔에 남김) · 시한 10분(`IPAM_XLSX_TIMEOUT_MS`) · 끊기면 멈추고 가드를 푼다 ·
    `IPAM_XLSX_WORKER=0` 으로 끈다. ⚠ 형제 `/tools/waste/export` 는 v2.742 LEFT-05 에 압축만 비동기(`zipManyAsync`)로 바꿨고 워크북 `writeBuffer` 직렬화는 여전히 메인 스레드다(다음 후보 — v2.743 LEFT-05 정정).
  · **웹**: Platform 전체 호스트·VM KPI 와 개요 VM 분포·리전 파이는 미수집 vCenter 를 더하지 않고 '최소 · 미수집 N곳 제외'(WEB-01 — `corpSiteStatus.countable`) · 업그레이드·VM 성능 트래킹은 다시 읽기 실패가
    화면을 오류로 바꾸지 않는다(WEB-04) · 용량 어드바이저 '계산 N분 전'(LEFT-09 일부) · GPU 게스트 진단 vCenter 목록 실패 사유(LEFT-11).
  · ⚠⚠ **CSV 수식 가드 — 음수·순수 숫자는 가드하지 않는다**(WEB-02): 엑셀이 `'-12.5` 를 텍스트로 읽어 정렬·합계에서 뺐다. 규칙은 웹 `util/csv.js`·서버 `util/csv.js`·pyportal `hub/csvio.py` **세 벌이 같고**
    `audit2741j` 가 같은 입력으로 대조한다. **'+' 로 시작하는 값은 계속 가드**(`+82…` 전화번호가 숫자로 바뀌지 않게 — 리드 통합에서 조였다). OS 스캔 CSV 의 사본 `esc` 는 `csvLine` 으로 옮겼다.
  · **패키징**(INJPKG-01·03·05): root 로 부르는 래퍼(vmware-portal-otp·-users·-verify)는 앱 트리 밖 root 소유 사본(`/usr/local/libexec/vmware-portal<prefix>/`)이고 앱 트리는 서비스 계정 권한으로만 실행 ·
    root 로 도는 서명 확인은 uid 0 소유 정책·키 파일만 받는다 · `vp_check_prefix`(install·uninstall 같은 함수)가 시스템 폴더 prefix 를 거부 · 빌드의 config 정리는 허용 목록(`*.example.json`).
  · 남긴 것(다음 점검 후보): LEFT-07(hangLog 실패 경로 보고 — v2.560 수정의 위험 대비 이득이 작다) · ✅ LEFT-12(hostAccess 변경 라우트 전체 범위 게이트·Electron 버전 — v2.743 LEFT-09 에 fleetOnly · electron 33.4.11 로 고쳤다, v2.744 LEFT-06 정정) · VC-03 · DEV-06 · WEB-03 ·
    INJPKG-02(du 출력 4MB 상한) · DB-04(CVP·통신 점검 COUNT) · TIMING-03 주기 틱 보류 · 새 상태 필드 화면 표시(snapshotSave·keptCopy·staleCopy 등) · `/tools/waste/export` 워크북 직렬화(압축은 ✅ v2.742 비동기) · ✅ REST 수집기 `/401/` 재던짐(v2.742 DEV-03 `restCommon.isCredReject` 로 고쳤다 — v2.743 LEFT-05 정정).
  · ⚠ 작업 방식: 분석은 Workflow 5개(축 10개 × 2인 반증), 수정은 12그룹이 같은 작업 트리에서 겹치지 않는 파일만 고쳤다. stop hook 이 WIP 커밋을 요구해 **66e3bed 는 그룹 변이 도중의 `ping/db.js` 되돌린 판본**을 담았다 —
    그 뒤 커밋이 바로잡았다(그 커밋판으로 되돌리지 말 것). GJ 는 같은 이유로 server/src 를 격리 사본에 복사해 변이 검증했다(다른 그룹의 진행 중 변경과 겹치지 않게).
- ⚠⚠ **v2.742 — '세 번 반복' 1회차(10축 발견 → 발견마다 2인 반증 → 12그룹 수정) 확정분**(사용자 요청 "세번 반복" · 선택 '직전과 동일' · '회차마다 릴리스'.
  발견 52 = 확정 43 · 확정(약) 4 · SPLIT 1 · 가능성 4, 고친 것 51(일부만 6) · 남긴 것 1(VC-08 — v2.741 설계). 상세 `docs/AUDIT-2026-10-16.md`,
  회귀 `server/test/audit2742{a..k,lead,m}.test.js` + `uagmon/test/uag2742` + 웹 `audit2742{l,n}`·`tools/audit2742j` — 그룹별 변이 검증(고친 파일을 `89adbd1` 판본으로 되돌리면 실패)):
  · ⚠⚠ **iDRAC 스캔 '교체' 범위는 `idrac/registry.js makeScanReplaceScope` 하나**(DEV-01 high): 예전 replace-datacenter 는 법인 전체를 교체해 같은 법인의 다른 엔트리 등록·
    손 등록·OME 를 지웠다. 등록 항목에 `scanRangeId` 표지 — 지우는 것은 그 표지가 있거나 id 가 주소인 옛 스캔 등록뿐이다. **새 교체 호출부는 scanRangeId·scanRanges 를 넘길 것.**
  · ⚠⚠ **root 서명 확인: 회수는 어느 키 파일에서든, 키 추가는 root 소유 파일에서만**(RECENT-01·INJPKG-01 — v2.741 root 래퍼의 잔여): install.sh 가 root 전용 사본
    `<tools>/trust/release-signing-keys.conf` 를 남기고 root 확인 셋이 env `VP_ROOT_TRUST_COPY` 로 그 사본의 **회수만** 합친다. 서비스 계정 소유 portal.env 의 RMA 유닛·재부팅 요청은
    sudoers 를 넓히지 않는다(이미 설치된 같은 줄만 유지 — INJPKG-03). 상세는 server/CLAUDE.md 서명 절.
  · ⚠⚠ **알림은 발송 대기열 하나(`alerts.js enqueueNotify`)로 보낸다**(TIMING-01): await 없는 동시 발송이 SMTP 인증 정지 가드를 우회했다(첫 실패가 기록되기 전에 같은 계정으로
    여러 번 로그인). 같은 미대기 notify 루프가 relaycheck·loginMonitor·guestScanScheduler·rma testResults 에도 있었다. **새 알림 발송 경로는 이 대기열로.** 해소된 키의 발송 시각은
    쿨다운 동안 기억한다(TIMING-02 — 경계 떨림이 억제 창마다 재발송).
  · ⚠⚠ **주문형 vCenter 로그인 문은 `vcenter/dsBrowse.js onDemand*` 하나**(VC-03 — v2.732 B4-01 · v2.733 C3-01 의 형제 누락 4경로): 비활성·점검중·site·인증 정지면 로그인하지 않고
    409 + `onDemandErrorFields`(skipReason·authStopped). 게스트 계정 추가만 인증 정지에도 1회(관리자 수동 작업). **새 주문형 vCenter 경로도 이 문을 지날 것.**
  · **클러스터 식별은 `clusterGroupKeyOf`(vCenter + clusterRef, 없으면 이름) 한 벌**(VC-05): 같은 이름 다른 데이터센터 클러스터가 합쳐졌다. 수집기가 호스트·VM 에 `clusterRef`·
    `vcDatacenter` 를 싣고(중앙 정제도 받는다), ref 모드는 그 vCenter 호스트가 **전부** ref 를 실었을 때만. 화면 key·이름은 웹 `clusterCfgText.clusterRowKey`·`clusterNameLabel`.
    ⚠ 나머지 이름 키 소비처(드리프트·DS 분석·시계열 키·공개 API 클러스터 개수)는 남겼다 — 이력 연속성·대조 계약 판단 필요. ✅ 공개 API·/summary 클러스터 개수는 v2.743 LEFT-07 `clusterCountOf` 로, 드리프트·DS 분석·용량·비용·이전 준비도 판정은 v2.744 VC-02 로 고쳤다(시계열 키 temp_cluster·gpu_cluster 는 이력 연속성 때문에 그대로 — v2.744 LEFT-06 정정).
  · **라이선스·확장 조회 실패는 `[]` 가 아니라 null + 사유**(VC-06 — `corelicense/analyze.js vcListUnread` 한 벌) · 엣지가 보낸 licenses·solutions 는 배열·평범한 객체·아는 필드만(VC-07).
  · **스토리지 REST 자격증명 거부 판정은 `restCommon.isCredReject`·`credRejectError` 하나**(DEV-03): `/401/.test(e.message)` 는 호스트명(isi-401)·SID·본문 속 401 로 수집 전체를 끊었다.
    표지(authFailed·status 401)가 먼저이고, 표지 없는 옛 오류는 '인증 실패(401)' 접두만. 403 은 대상 아님. 리드가 `storage/areasCollector.js` 의 형제 누락도 고쳤다(`audit2742lead`).
  · **SAN**: 빈 슬롯(Absent·Not Present)은 장애가 아니다(`isAbsentWord` 한 벌 — 센서·팬·PSU·파트 장애 추출, 장착 0이면 확인 불가) · peer zone 속성 멤버(00: 접두 WWN)는 끝점이 아니다
    (REST 는 principal↔peer 만 잇는다 · ⚠ SSH cfgshow 에는 principal 이 없어 SSH 경로는 그대로) · 처리량 간격 상한은 max(2시간, 주기×3 + 실행 소요)(`rates.setRateCadence`) ·
    storage-summary 응답 객체 기억(agg WeakMap + 역할 키, TTL ≤ 60초).
  · **PDU SSH 세션 예산**(DEV-05 — v2.528·v2.741 규약의 형제): `PDU_SESSION_BUDGET_MS` 75초 < 장비 시한 − 여유. 장비 시한 `PDU_DEVICE_TIMEOUT_MS` 는 수집기가 소유하고 폴러·재수집 큐가 import 한다.
    Isilon SSH 부가 명령 순서는 계약이다(정확 용량 통계가 버전·계정 조회보다 먼저 — RECENT-04).
  · **엣지 계약**: export 센서 상세는 바뀐 서버만(`?sdSince=`·`sdCursor` — 구버전 양쪽은 예전처럼 전량, 중앙은 직전 상세로 채우고 시각을 다시 자른다, EDGE-01) ·
    중앙 지속형 503(registry/settings 손상·DB 불가)은 `Retry-After: 60` + no-store(`PERSISTENT_503_HEADERS` — central.js 의 503 전부가 거치는지 스윕) · 엣지 큰 본문 push 두 곳은 503 을
    호출 안에서 다시 보내지 않는다(`postNo503Retry`) · iDRAC 스캔 결과 회신은 retries 0 + 다음 주기 백오프 큐(`unsentResults`·`unsentDropped`, EDGE-03).
  · **아이실론 '지금 수집' 대기열은 `scan-journal.json` 의 queued 에 동기로 남는다**(RECENT-02·EDGE-02): 기동 때 원래 넣은 시각으로 돌아오고(6시간 시한), 재개를 기다리는 조사의 자리는 비워 둔다.
    자동 업그레이드는 기록이 남은 대기 요청은 기다리지 않고(재시작 뒤 돌아온다), 기록을 못 남긴 요청과 진행 중 에이전트 대량 배포(`bulkDeploy.runningBulkDeploys`, TIMING-04)는 기다린다.
  · **OS 인벤토리 prune 은 '읽은 vCenter 에서 사라진 VM' 만**(VC-04): 첫 수집 중·불통·낡음·점검중 vCenter 의 기록은 `keptUnread`, 등록부를 못 읽으면 vCenter 단위 삭제 안 함,
    스캔 실패는 직전 OS 를 남기고 `error`·`errorAt`·`okAt`(웹 '최근 실패 · 이전 값').
  · **끊긴 ESXi 호스트의 센서 온도는 `store.usageReadable` 로 적재·집계에서 뺀다**(VC-02 — v2.594 사용률 규칙의 온도판) · 유령 스냅샷 후보는 `consolidationNeeded` 근거일 때만 warn(RECENT-03).
  · **로그 DB**: 엣지 연합 조회·네트워크 로그 분석의 정확 COUNT 를 상한 있는 조각 세기로(엣지 연합 조회(검색어·심각도)는 `searchAsync` 기본 상한 `COUNT_CAP` 10,000 · 네트워크 로그 분석은 `ISSUE_COUNT_CAP` 100,000 · 필터 없는 엣지 조회는 정확 COUNT — v2.743 LEFT-04 정정. 넘으면 `totalCapped`·'N건 이상', 중앙 `logQueries` 가 그 필드를 보존한다) ·
    logs prune 적응 청크(목표 40ms) · 필터 CSV 조각 읽기.
  · **GPU 게스트 오버레이 TTL = max(30분, 폴 주기×3 + 30초)**(VC-01) · 이름으로 찾는 엣지 설정(GPU 게스트 배포·배포 사용자)은 쓰기도 `agentKeyOf`, 로드 때 대소문자 중복 병합(LEFT-01 — v2.604 규약의 쓰기 누락).
  · **웹**: 서비스 중단 화면의 확인 요청은 토큰을 싣고 401·403 도 '서버 응답' 으로 본다(WEB-01) · `sendJson/putJson/…` 반환값은 `requireChanged` 로 판정(WEB-02 — `audit2727e` ALLOW2 스윕) ·
    용량 모름 호스트는 `hostCapacityText`(LEFT-06) · 서버 `hostsCapacityUnknown` 을 쓰지 않던 세 화면.
  · ⚠ 작업 방식: 첫 실행 12그룹 중 9그룹이 세션 사용량 한도로 멈췄다 — v2.607 규칙대로 반쯤 고친 파일 69개를 기준판으로 되돌리고 8그룹을 처음부터 다시 돌렸다(결과 파일·변이 기록이
    있고 작업 트리가 수정본 백업과 바이트 동일했던 GF 만 완료로 인정). 변이 검증 중인 그룹의 파일은 WIP 커밋에서 뺐다(끝난 그룹 파일만 먼저 커밋).
- ⚠⚠ **v2.743 — '세 번 반복' 2회차(10축 발견 → 발견마다 2인 반증 → 12그룹 수정) 확정분**(같은 요청의 2회차 · 선택은 1회차와 같다.
  발견 39 = 확정 29 · 확정(약) 8 · 가능성 1 · 반증(약) 1, 고친 것 37 · 남긴 것 2(INJPKG-02 Windows ACL 가능성 · DEV-05). 상세 `docs/AUDIT-2026-10-16b.md`,
  회귀 `server/test/audit2743{a..l,lead}.test.js` + 웹 `audit2743j`·`tools/audit2743{d,k}`·`tools/vmCloneMountText`·`vmcfg/vmHygieneText` — 그룹별 변이 검증(고친 파일을 `46f5e5e` 판본으로 되돌리면 실패)):
  · ⚠⚠ **'관리자 판본' 판정은 `auth/demoGuest.js isAdminDetailUser` 하나**(AUTHZ-01): mock 데모 계정은 요청 문맥이 admin 이라 `role === 'admin'` 으로 가림을 정하던
    곳마다 관리자 판본(관리 IP·계정명·CONFIG_DIR 절대 경로·등록부 CSV)이 나갔다. addressMask `isAdminReq`·scopeDbStatus·scopeFilePaths·redactPushStatus·archScan
    `scopeArchPaths` 가 이 함수를 쓰고, data.csv 는 데모 계정에 주지 않으며 READ_DENY 에 5접두를 더했다. ⚠ **라우트에서 `req.user?.role === 'admin'` 으로
    가림을 정하지 말 것** — 그룹 수정 뒤에도 그 꼴 8곳(partFaults·bmUsage·xferSpeed·isilonDirUsage·bmstor·vmtrack·portalCheck)이 남아 리드가 고쳤다(GET 239경로 재조사 0건).
    memoJson 의 extraKey 에 역할을 넣는 곳은 `demoGuest` 도 넣는다(portalCheck arch).
  · **범위 관리자의 NFS 마운트 정보는 가린다**(AUTHZ-02 — `/tools/vm-clone` `mountsView`, 형제 `/admin/nfs-mounts` 는 403) · hostAccess 변경 5라우트 fleetOnly · uagmon Electron 33.4.11 고정(LEFT-09).
  · ⚠⚠ **엣지 iDRAC 등록부도 `registryLoadError`**(EDGE-01 — v2.612 LEFT2612-01 의 형제): 손상이면 엣지 export 503 `registryUnreadable` + Retry-After 60, 중앙 puller 는 직전 스냅샷을 유지하고
    `edgeReason`·통신 지도 `pull-edge-registry` 로 말한다. **등록부를 읽어 '전량' 을 보내는 엣지 응답은 이 판정을 먼저 볼 것.**
  · iDRAC replace 강등 판정은 교체와 같은 술어 `hasHpeInScanReplaceScope`(LEFT-01 — v2.742 DEV-01 이 교체를 엔트리 단위로 바꾼 뒤 강등만 법인 단위로 남았다).
  · ⚠ **대소문자 중복 접기는 키를 실제 엣지 이름으로, 값은 시간 순서로 '기본값 아닌 것' 만 얹는다**(RECENT-01 — v2.742 LEFT-01 회귀: 부분 사본이 최근 것으로 남아 수집 끔·계정 삭제).
    GPU 게스트 정리는 로컬만 폴러가, 엣지 항목은 그 엣지 push 주기 TTL 로(LEFT-02).
  · ⚠⚠ **'못 읽은 vCenter 의 빈 목록' 은 삭제가 아니다 — 판정은 `vmtrack/diff.js inventoryUnreadReason`**(VC-01): connected 면 읽음, VM 이 있으면 직전 값 서빙, 그 밖의 빈 목록은
    사유(disabled·maintenance·pending·unreachable)로 diff 하지 않는다. VM 생성/삭제 이력의 '지금 있는가' 도 같은 함수. 게스트 디스크 최신 행은 삭제된 vCenter 를 지우고(`pruneOrphanVcenters`),
    등록부를 못 읽으면 지우지 않는다(VC-02 — 오래된 행은 합계에 남기되 `stale` 표지).
  · 끊긴 호스트 사용률 0% 의 형제 4경로(관계 그래프·/metrics·iDRAC vcenter-host·ChatOps — VC-04, `store.usageReadable`) · 클러스터 개수는 `clustercfg/analyze.js clusterCountOf` 하나(LEFT-07 — 내부·공개 API).
  · **주문형 vCenter 로그인 문의 형제 — 쓰기·조회 4경로 + 배치 칸**(VC-03): VMware Tools 업그레이드·VM 사양 변경·프로비저닝(배치 전체가 로그인 1회 공유, 409 는 기억)·GPU 게스트 테스트가
    `onDemandLogin`, 리드가 `provision/placement.js` 도 `onDemandVcBlock` 으로(v2.741 '배치 칸은 건너뛰지 않는다' 는 생성이 직접 로그인하던 때의 판단 — 테스트 계약을 바꿨다).
  · ⚠⚠ **알림 발송은 채널별 줄**(TIMING-02 — v2.742 TIMING-01 회귀: 한 줄이라 응답 없는 웹훅이 모든 알림을 늦췄다): 웹훅류 동시 4 · 메일 1, 결과는 채널 순서대로. 메일 제목은 `util/smtp.js headerSafeText`
    (INJPKG-03 — 제어 문자 하나가 메일 전체를 실패시켰다). VM 구성 점검 알림은 목업 vCenter VM 제외(VC-05 — 화면 문구 `vmHygieneText.notifyNowMsg`).
    일일 보고 수동 발송은 `lastManualTs` 로 따로(TIMING-04). ⚠ **발송 성공 판정은 `reports/dailyReport.js anySendOk`(`/:(2\d\d|ok)\b/`)** — 예전 `/:(2\d\d)/` 는 메일 결과 'email:ok' 를 몰라
    메일만 쓰는 현장에서 정기 보고를 하루 내내 다시 보냈다(리드가 찾은 기존 결함 — alerts.js 테스트 발송은 v2.479 에 이미 그 규칙이었다. **sendText 결과를 판정하는 새 코드도 이 함수로**).
  · ⚠ **적응 타이머의 첫 실행 전 재무장은 `min(첫 실행 예정, 생성 + 새 주기)`**(TIMING-01): 첫 지연을 버리면 엣지 재시작 직후 스토리지 첫 수집이 약 1시간 밀렸다. 주기 변경 알림은 **실효 값이 바뀔 때만**.
  · 아이실론 대기 기록은 한 번에(`scanQueuedMany`, TIMING-03) · 엣지가 버린 '지금 수집' 요청은 push 의 `runDropped` 로 알리고 중앙이 `applyIsiduEdgeDrops` → `dropTaken` 으로 사유와 함께 정리(LEFT-08 — 웹 `EDGE_DROP_TEXT`).
  · 웹(GJ): 중계 '지금 점검' 응답 ok 덮어쓰기(WEB-01 — `okCount` 별도) · 권한 매트릭스 편집 유지(WEB-02 — `userAdmin/permReload.js`) · vCenter 로그 '지금 수집' busy·꺼짐 문구(WEB-04) ·
    중계 응답 agent 비문자열 TypeError(INJPKG-04) · CSV 이스케이프는 `csvCell` 한 벌(INJPKG-05 — 손 사본 4곳이 단독 CR 을 빠뜨렸다). 라이선스 사용량 결측은 0% 가 아니라 '—'(WEB-05).
  · CVP·SAN(GK): CVP·SAN 포트 사용량 push 는 `postNo503Retry`(LEFT-03 — 혼잡 503 도 다음 주기) · CVP 예산 소진 + 인터페이스 못 읽음 = 'budget'(`budgetTelemetry`, DEV-04) ·
    sensorshow 이상어 `SENSOR_BAD_WORD`(DEV-02 — v2.742 회귀 되돌림, 'High'·'Low' 정상 펌웨어면 오탐 — 실장비 미확인) · CVP '지금 수집' busy 는 주의 톤 + `directBusy`(WEB-03).
  · GL: svcmon LDAP 은 BER 단형·장형 길이를 읽는다(DEV-01 — AD 의 실패가 성공으로 보였다) · FC HBA 사용률 분모는 `bmusage/parse/fcRate.js` FC 표준 데이터율(DEV-03 — 표에 없는 속도는 명목 + `pctBasis`,
    데이터율 초과는 null + `pctOver` — ⚠ v2.744 RECENT-02 가 바꿨다: 110% 까지는 100 + `pctClamped`, 그 위는 null + `hba_over`) · 스토리지 합계 추이 시간 조각 + 양보(DB-01 — 결과 동일 대조) · `/overview/trend` 전력은 `?include=power` 일 때만(DB-02 — 없으면 `not-requested`).
  · Windows(INJPKG-01): start-portal.bat 이 `PORTAL_ENV_FILE` 로 자기가 call 하는 파일을 넘기고 토큰 저장이 그 파일에 `set "KEY=VAL"` CRLF 로 쓴다(cmd 메타문자 거부). 새 env `PORTAL_ENV_FILE`.
  · ⚠ 테스트 하니스: 자식 프로세스가 큰 응답을 `console.log` 직후 `process.exit` 하면 stdout 이 잘린다 — 결과는 파일로 넘길 것(audit2743a 가 이번에 그렇게 깨졌다).
  · 남긴 것: INJPKG-02(Windows SYSTEM 예약 작업 ACL — 환경 없음 · v2.744 LEFT-05 는 README 안내만 더했다) · ✅ `postNo503Retry` 본체 util/ 이동(v2.744 LEFT-09) · ✅ 화면 표시 `folded`(GPU 게스트 — v2.744 LEFT-08①)·BmUsage HBA 각주(v2.744 LEFT-08②) · ✅ 중앙 isidu `runDropped` 는 v2.743 에 이미 `collectDropNote`(EDGE_DROP_TEXT)로 화면이 말한다(v2.744 LEFT-08③ 정정).
  · ⚠ 작업 방식: 첫 수정 실행의 12개 에이전트가 시작 직후 세션 한도에 걸렸다(작업 트리 깨끗 — 그대로 다시 돌렸다). CPU 4개라 워크플로당 동시 2 — 6개 워크플로로 나눴다.
- ⚠⚠ **v2.744 — '세 번 반복' 3회차(10축 발견 → 발견마다 2인 반증 → 10그룹 수정 → 후속 3그룹 → 수정분 적대적 회귀 검토) 확정분**(같은 요청의 3회차·마지막 ·
  선택은 1회차와 같다. 발견 40 = 확정 35 · 확정(약) 3 · 가능성 2(중복 2쌍 — 고유 38), 고친 것 38(EDGE-03 일부). 상세 `docs/AUDIT-2026-10-19.md`,
  회귀 `server/test/audit2744{a..m}.test.js` + 웹 `audit2744{f,k,l,m}`·`tools/audit2744{a,b,d,g,i}` — 그룹별 변이 검증(고친 파일을 `9a2ef1c`·후속은 `3b7816a` 판본으로 되돌리면 실패)):
  · ⚠⚠ **'관리자 판본' 판정은 라우트에서도 `isAdminDetailUser` 하나 — 소스 스윕(`audit2744e`)이 `role === 'admin'` 직접 비교를 허용 목록(사유)과 개수까지 대조한다**(AUTHZ-01 = LEFT-01 — v2.743 의 남은 16파일:
    중계 토폴로지 haproxy.cfg 원문·SSH 계정 · HAProxy 점검 주소 · svcmon 엣지 출처 · ping 엣지 주소 · 서비스 점검 스택 · /perf/req-status · 프로비저닝 남의 작업 · 구성 점검 5종 memo 키). **새 라우트의 가림은 이 함수로**.
  · ⚠⚠ **설정 소유자 등급 라우트는 전체 범위 계정만**(AUTHZ-02, `routes/admin/shared.js requireSettingsOwner` — 범위 계정이면 소유자 목록에 있어도 403 `SETTINGS_OWNER_FULL_SCOPE_REASON`):
    공유 CENTRAL_TOKEN 평문·백업 생성/내려받기/복원·비밀 정책·세션 보안. 저장 응답·GET 이 `ownerWarnings`(범위 계정 소유자)를 싣고 세션 보안 화면이 말한다. `/auth/me` 는 `settingsOwnerTier`(실제 게이트를 돌린 값)를 더 싣는다 —
    `isSettingsOwner` 의 뜻은 그대로다(App 이 그 값으로 설정 탭 전체를 숨기므로 범위 소유자의 범위 안 설정까지 사라진다 — 후속 FB-3 판단). 남긴 것: 소유자 등급 서브메뉴를 settingsOwnerTier 로 잠그는 화면(지금은 눌렀을 때 403 안내).
  · ⚠⚠ **엣지 등록부 손상 → 빈 목록을 보내지 않는다 — push 와 자동 쓰기도**(EDGE-01·03, v2.743 export 503 의 형제): fleet push 는 중앙이 **2.744.0 이상**일 때만 상태 전용 보고
    (`FLEET_STATUS_ONLY_MIN_CENTRAL` — 이 릴리스 버전이 그 값 이상이어야 한다)이고 중앙은 `holdEdgeFleet` 으로 직전 목록 만료만 미룬다(`CENTRAL_FLEET_UNREADABLE_HOLD_MS` 기본 24시간 · 미검증 이름은 무변경) ·
    파트 장애는 `registryUnreadable` → 보류 사유 `registry-unreadable`(HOLD_REASON) · 자동 등록은 `util/registryCore.js autoWriteRefusal` + `registerScanned(…, {auto:true})`. 설정 pull 4종은 막지 않고 `registryRecovered` 로 기록한다.
  · **중앙 pull 은 엣지 export 503 을 호출 안에서 다시 묻지 않는다**(EDGE-02 = RECENT-03 — 약 75초 워커 점유) — `util/postNo503Retry.js`(onRetry · GET 별칭 `fetchNo503Retry`, LEFT-09 에 agent/ 에서 옮겼다) 한 벌.
    즉시 당김도 `pullOptionsFor` · 주기 경고는 거절(edgeReason)을 '응답 없음' 과 따로 센다 · 503 본문에 version·agent·hostname(EDGE-04 — 실패 분기가 그 정체만 반영).
  · **vmtrack 부분 합 = '다시 읽힐' 사유(pending·unreachable)만**(RECENT-01 — v2.743 회귀: 비활성·캐시 없는 점검중이 매 슬롯 skipped 로 세여 경영 보기 VM 추이가 영구 null). 비활성은 분모 밖 ·
    점검중은 `maint_excluded` 열·`maintExcluded`(추이를 비우지 않는다). ⚠ v2.743 기간에 쌓인 합계 행은 구분할 수 없어 보존 기간까지 부분 합으로 남는다(정직 기록).
    변경 이력은 슬롯 조각 + 양보(DB-01) · 정리는 청크·(ts,rowid) 커서(DB-04 — audit2603c 허용 목록에서 뺐다) · 결과 기억 키 = 세대 + 창 경계(DB-05).
  · **bmusage FC**: 데이터율의 110% 까지는 100 + `pctClamped`(측정 정의 차이 — 16GFC 선로/데이터율 1.0625), 그 위는 null + 서버 대표값도 null + `hba_over`(알림은 초과로 본다 — 다른 포트의 낮은 값으로 대표하지 않는다, RECENT-02) ·
    -1 표지(0xffffffffffffffff)·2^53 초과·물리 상한 초과는 처리량 null(DEV-01 — 491 PB/s 가 5년 롤업에 남던 것) · iDRAC 텔레메트리에 장비 시한·signal(DEV-04 — kind `timeout`, 인증 정지 대상 아님) ·
    redfish 인증 판정은 오류 표지(`redfishFailKind`)만(LEFT-02 — 호스트명 속 401) · `describeError` 는 DNS·연결·시한을 인증보다 먼저 · HBA 기준 각주(`hbaBasis`, LEFT-08②).
  · **같은 이름 클러스터는 (vCenter, moref) — 판정 `clustercfg/analyze.js clusterIndex` 한 벌**(VC-02): vSAN 분할·호스트 드리프트·/tools/capacity·비용·이전 준비도·토폴로지(노드 id `<vc>|cluster|r:<ref>`) +
    화면 key·이름 `clusterRowKey`·`clusterNameLabel`(consoleData.clusterRows 포함, 후속 FA-①). 이름 모드는 대소문자 무시. 시계열 키 temp_cluster·gpu_cluster 는 그대로.
  · **읽지 못한 vCenter 를 0 으로 섞지 않는다 — `corelicense/analyze.js notReadVcentersOf` 한 벌**(VC-03): 코어 라이선스·비용·이전 준비도 + 후속 FC 호스트·VM 구성 점검. 응답 `notReadVcenters`·`partial` + CSV 마지막 줄 · 문구 `bizreport/notReadText.js`.
  · **주문형 성능 조회도 '직접 수집 대상인가' 를 먼저**(VC-04, `authStopGate.vcSkipOf` — manual=1 도 막는다 · ⚠ 동작 변화: site vCenter 성능 창이 중앙에서 열리지 않는다) · 화면은 `vcAuthStopText` skipNote·skipCell·skipSingleText ·
    성능 창은 409 skipReason 이면 자동 갱신을 멈춘다(후속 FA-②③) · dsBrowse 사유 표는 authStopGate 것을 재수출(FA-④).
  · **IP 원장: FQDN ESXi 의 관리 IP**(VC-01, `ledger.js hostLedgerIp` — 동기·양보판 같은 생성기, 입력 지문에 mgmtIp · ⚠ ipam.db 호스트 행이 늘어난다(외부 리더 계약)) · /24 제안도 같은 판정을 주입(후속 FB-2) ·
    관리상태 일괄 적용은 무효 토큰이 하나라도 있으면 400 + invalid 로 전체 거부(WEB-02).
  · **svcmon**: NTP 응답 LI·stratum·mode·원본 타임스탬프 판정(DEV-03 — 미동기를 '정상 · 0ms' 로, KoD 를 −4조 ms 로 보고하던 것) · LDAP resultCode 8·53 은 정책 거부 = 서버는 응답 중(ok), 51·52 는 bad(RECENT-04) ·
    결과 로그 CSV 다운로드는 데모 계정 403(AUTHZ-03) · vCenter 로그 meta 는 재귀 CTE + vCenter 별 COUNT + 양보(DB-03 `metaAsync`).
  · **SAN 팬·PSU 장애 라벨에 '정상' 을 붙이지 않는다**(DEV-02 — 엣지 추출이라 엣지 업그레이드 필요, 중앙 알림은 옛 라벨의 '정상' 을 뗀다) · Unity spinfo 제목 정규식 선형화(INJPKG-02) · Intl.Collator 재사용(DB-02).
  · **install.sh 의 CONFIG_DIR 파일은 `vp_cfg_*` 로만 쓴다**(INJPKG-01 high — lstat 판정(링크·일반 파일 아님·하드 링크면 건너뜀) → root 전용 임시 폴더 → rename, 읽기는 cp -a 사본). 링크로 바꿔 둔 파일을 root 가 chown·쓰기 하던 로컬 권한 상승.
    Windows README 에 설치·설정 폴더 ACL 단계(LEFT-05 — 스크립트는 그대로). 다음 후보(코드로만 추론): systemd `EnvironmentFile=` 이 portal.env 링크를 root 로 따라 읽는다.
  · 그 밖: iDRAC 위임 결과 재전송 창은 나이 기준 30분(TIMING-01) · 아이실론 '지금 수집' 합침의 central 표지가 재시작 뒤에도 남는다(TIMING-02) · GPU 게스트 배포 대상 합침 표지 `foldReport`(LEFT-08①) ·
    게스트 디스크 0대 '—'(LEFT-03) · 라이선스 표 폭(LEFT-04) · 통신 점검 로그 요청 키(WEB-03) · VM 추이 선택 변경 시 비움(WEB-01) · 데모 계정 큰 본문 풀(FB-4) · fleet 직전 목록 표시(FC-②) · V4 Compare RAM 여유 미상 정렬(FA-EXTRA).
  · ⚠⚠ **수정분 적대적 회귀 검토(리뷰 기준 `3b7816a`·후속 `96f55a2`) — 이번에도 수정이 만든 결함이 있었다**(회귀 `server/test/audit2744{ra..rh,rx,ry,rz,rlead}` + 웹 `audit2744rx`·`tools/audit2744{ra,rb,rf,rh,ry}` — 그룹별 변이 검증.
    ⚠ 반증 단계는 사용 한도로 62개 중 8개만 끝나 **수정 그룹이 고치기 전에 현재 판본에서 먼저 재현**하는 것으로 대신했다 — 상세 `docs/AUDIT-2026-10-19.md` '회귀 검토' 절):
    · ⚠⚠ **보존 정리에 상관 서브쿼리를 쓰지 말 것**(RA — vmtrack DB-04 가 '남길 행' 을 행마다 다시 찾아 묶음 크기의 제곱이었다): 남길 행 표를 정리마다 한 번(`keepPages`). 범위 계정 VM 추이는 `snaps.skip_detail`(빠진 vCenter id·사유)로
      **범위 안만** 센다(`skipCategoryOf` 한 벌 · 옛 행 NULL = 예전 판정). 조회 실패에도 선택 도구 + '이 조건으로 다시 조회'(`VmTrackLoadFailed`). ⚠ 정리의 큰 최장 정지(0.7~7초)는 WAL 체크포인트 fsync 다(범위 밖 · 운영 DB 미측정).
    · **FC HBA**(RB): 명목 기준(표준 데이터율 표에 없는 속도) 포트의 100% 초과는 그 포트만 비고 대표값·알림은 나머지 포트(`nominalOver`) · 1 Gbit 미만 속도는 물리 상한 근거가 아니다 ·
      2^53 초과 카운터는 값이다(2^64 이상만 표지 — v2.744 DEV-01 이 과하게 잘랐다) · iDRAC 초과 노트는 대표값에 쓰였을 때만 · Sensors 404 판정은 상태 코드만.
    · **503 무재시도는 `resilientFetch({noRetryStatus:[503]})` 한 번**(RC — 래퍼가 두 번 부르면 기록이 둘이다) · 관리 화면 export 호출도 `fetchNo503Retry` · 거절 우세 경고가 실패 엣지·앞선 재시도 시간을 함께 말한다.
      ⚠ 동작 변화: 관리 화면 '연결 테스트'·'토큰 강제 동기화' 는 엣지 앞 HAProxy 의 일시 503 도 다시 묻지 않는다.
    · ⚠⚠ **로드 오류 원문(파일 조각 — 비밀번호가 들어 있을 수 있다)은 어디에도 싣지 않는다 — 요약은 `util/atomicWrite.js classifyLoadReason`·`summarizeLoadReason`·`safeLoadText` 한 벌**(RD·RY·리드):
      V8 의 JSON.parse 오류 문구는 그 파일의 앞뒤 조각을 담는다. 등록부 요약 `summarizeRegistryError` 도 이 분류를 쓰고(비-admin 은 분류 문구만), 엣지 export 503(`registryError{code,line,column,position,sysCode}` 추가) ·
      파트 장애 스캔 · 중앙 registryUnreadable·설정 손상 503(central `loadWhy`) · `pullRecoveryNote` · `preserveCorrupt` 콘솔 줄(130곳 공용) · `settingsLoadError.corrupt` 가 요약만 싣는다. 중앙 puller 는 2.743 엣지가 보낸 원문 detail 도 요약한다.
      `safeLoadText` 는 따옴표·백슬래시·제어 문자가 든 원문만 요약하고 사람 문장은 그대로 둔다(조치 단서 '손상 보존본' 유지 — 옛 테스트가 그 문구를 고정한다). **새 로드 오류 경로도 원문을 싣지 말고 이 함수로.**
      fleet 상태 보고는 중앙 응답을 읽는다(`fleetHoldOutcome`) · 사람이 누른 위임 등록은 `manualRemoteWriteRefusal`.
    · **응답에 객체를 통째로 싣지 않는다 — IP 대장 호스트 행 `slimHostRow`, 시트 VM 칸 `slimOwnerRow`**(RF·RY — 키 변경: owner → hasOwner·ownerId·ownerName, 상세는 클릭 때 `/vms/lookup`) · 호스트 행 원격 접속은 `ipRemoteItem` ·
      낭비 내보내기의 근거 리포트도 `createVcAuthGate`(건너뛴 vCenter 의 리포트는 만들지 않는다 — 로그인 0) · 위협 화면 rogue 판정도 `hostLedgerIp`.
    · **NTP stratum 0 은 refid 로 가른다**(RG): RATE·DENY·RSTR = 거부(`kod.refused`) · INIT·STEP·(빈 refid + LI 3) = 미동기 · 그 밖 = '시각을 주지 않음'. 파서 꼬리 정규식 O(n²) 9곳 선형화(PDU `codeLine`·`readingLine` · uemcli `recStart` ·
      FOS `tailMatch` 류 — 옛 결과와 대조). ⚠ 같은 꼴 10여 곳이 남았다(linuxProc·zoning·cliSsh·isilonSsh·capacity/collectors·guestNetScan·vmclone/vsphere·bulkText) · 줄 끝 규칙 LINE_TERM 이 4파일에 따로 있다.
    · **install.sh `vp_cfg_snap`**(RZ): 패키지 node 로 O_NOFOLLOW|O_NONBLOCK 단일 열기 → fstat(일반 파일·nlink 1·`VP_CFG_MAX_BYTES` 16MiB) → fd 에서 복사, node 가 없으면 lstat + 시한 있는 비재귀 `cp -P` ·
      `vp_cfg_set_line` 은 awk 한 번(LC_ALL=C · ENVIRON · 3MB 3초 → 0.1초). ⚠ `$PREFIX` 의 node 는 서비스 계정 소유라 root 로 실행하지 않는다(`$SCRIPT_DIR/runtime/node`). 남은 위험: `$BAK/server/config` 중간 디렉터리 링크.
    · 그 밖: vCenter 로그 상태 집계는 정리로 0건이 된 vCenter 를 싣지 않는다 · CSV 마지막 줄의 비활성/읽지 못함 구분(`notReadCsvLines`) · /24 제안의 관리 IP 거부는 `totals.hostMgmtRejected` 로 따로 ·
      구성 점검 배너는 `notReadJudgeNote`(비활성만이면 배너 없음) · 라이선스 표 칸 `LIC_WRAP_MINW` · GPU 게스트 합침 표지는 저장 성공 뒤(`resolveFoldOf`) · 테스트 임시 폴더는 `os.tmpdir()`.
    · 남긴 것: FX-R3 일부(VCenterDetail · SessionSecurity · BmUsage 화면 실행 테스트) · register-scanned 로컬 분기의 손상 등록부 저장 — 판단 필요.
      (설정 손상 원문 3곳은 최종 검토에서 정정 — svcmon·아이실론은 이미 `settingsLoadError.corrupt()` 가 요약하고 있었고 전송 속도는 고쳤다.)
  · ⚠⚠ **최종 검토(회귀 검토 수정분을 다시 본 것 — 기준 `44952f3`, FA~FH 8그룹 + 리드)** — 발견 22 = 확정 16 · 재현 확정·의도 가능성 1 · 가능성 3 · 반증 1 · 문서 결함 1,
    고친 것 20(+ RD-R3 조사). 회귀 `server/test/audit2744f{a,b,c,d,f,g,h,lead}` + 웹 `tools/audit2744f{a,e}`·`vmRemoteProbeText`·`tools/vmTrack403_2744` — 그룹별 변이 검증:
    · ⚠⚠ **로드 오류 원문은 콘솔 줄에도 싣지 않는다 — 호출부 자신의 `console.warn/error` 까지**(FC·리드 30곳): `preserveCorrupt` 의 줄만 요약하고 같은 catch 의 호출부 줄이
      `err.message`(V8 JSON.parse 조각 — 비밀번호 앞부분)를 찍었다. `safeLoadText(err)` 로 쓰고, 소스 스윕 `audit2744fc findRawLoadLogs` 가 0 을 고정한다 — **새 로드 catch 의 콘솔 줄도 이 함수로.**
      상주 상태(전송 속도 설정 로드 오류·실행 중 스캔 기록 load.error·중앙 `sanitizeRegistryUnreadable`)도 요약이고, 중앙은 엣지가 보낸 분류 코드를 `REGISTRY_ERROR_CODES` 로 거른다(리드 `audit2744flead`).
    · **등록부 오류 요약은 역할로 나눈다**(FB·FC): 베어메탈 사용률 상태(`bmUsageStatus({detail})`·`sourceErrorsView`)·파트 장애 `registryUnreadable`(`maskRegistryUnreadable` — 깊이 8까지)은
      관리자에게 위치 숫자, 그 밖에는 분류 문구 + `reasonDetailHidden`. 엣지 push 4종(SAN·CVP·PDU·스토리지)의 `_last`·콘솔도 요약 · 수집 서버 연결 테스트는 `edgeExportErrorText`(puller 와 같은 문구 상수).
    · **원격 접속 범위는 원장 관리 IP 도 인정한다**(FD — server/CLAUDE.md v2.320 항목). IP 대장이 보여 주는 호스트 관리 IP 로 범위 계정이 403 을 받던 것(v2.744 GG-R2 가 행 IP 를 원격 접속 대상으로 쓰기 시작해 드러났다).
      VM 원격 접속 버튼의 사전 점검 403·404 는 '도달 불가 · 방화벽 확인' 이 아니라 '범위 밖 대상(계정 권한)'(`components/vmRemoteProbeText.js` — 회색, 서버 사유 그대로).
    · **FC 명목 초과 노트는 대표값을 실제로 정한 경로로 말한다**(FA — `detail.hbaRepSrc`, 노트는 iDRAC 채움 **뒤에**, 웹 `fcNominalRestKind` 로 문구 선택, 각주 `hbaBasis.rep`·`osFallback`).
    · **VM 추이 정리의 묶음 기준은 후보가 나온 묶음만**(FF — `makeGroupResolver`·`keepChangesOne`·`keepDsOne` · 청크마다 40ms 예산 · `keepPages` → `keepLookups`). 남길 행 표를 정리마다 한 번 만드는
      v2.744 RA 방식은 경계 이전 행이 0개여도 묶음 인덱스 전체를 한 동기 구간으로 읽었다(100만 행 145~254ms → 2ms). **'표를 한 번 만든다' 는 수정도 그 표를 만드는 훑기의 크기를 볼 것.**
    · 판정 목록 CSV 의 '읽지 못한 vCenter' 줄은 `notReadCsvLines(…, {mode:'judge', noun})`(FG — 합계가 없는 목록에 '합계는 하한' 금지, 명사는 화면과 대조) ·
      라이선스 표 칸 하한은 칸 폭 880px 미만일 때만(FE — 컨테이너 단위 `clamp`, 1280·1024px 에서 상태 열이 잘리던 것) · VM 추이 '다시 조회' 는 `createRetryGate`(진행 표시·실패 횟수) ·
      VM 추이 403 은 권한 안내만(`errorBoxInput(error).perm` — 오류 객체를 그대로 넘긴다).
    · ⚠⚠ **root 가 서비스 계정 파일을 읽을 때는 '확인 → 다시 열기' 가 아니라 한 번 열기다 — 셸 둘 다**(FH·리드): install.sh 는 `vp_cfg_snap`(node 비정상 종료면 cp 폴백 ·
      `/dev/fd/3` 로 ACL·xattr 보존 · RMA 요청 값도 사본에서), release-verify-lib.sh 는 `vp_root_read`(node O_NOFOLLOW·O_NONBLOCK·O_NOCTTY → fd 로 일반 파일·nlink 1·크기 상한 →
      그 fd 에서 읽기 — root 래퍼도 `declare -f` 로 싣는다). `[[ -f && ! -L ]]` 뒤 `exec {fd}<` 는 그 사이에 FIFO 로 바꾸면 root 가 무기한 매달린다(DEBUG 트랩 재현 —
      `audit2744fh`·`audit2744flead2`). **root 로 도는 새 셸 코드가 CONFIG_DIR 파일을 읽으면 이 둘 중 하나로.**
    · 남긴 것: RV-4(명목 기준 포트가 100% 를 조금 넘으면 대표값·알림에서 빠진다 — v2.743 과 같은 설계, 판단 필요) · RD-R3(제품에서 나오지 않는 입력 — 조사만 고침) ·
      엣지 export 오류 요약 두 벌(문구 상수는 하나) · 큰 vmtrack 정리의 COMMIT 정지(WAL 체크포인트로 추정 · 미확인) · 880px 기준은 목 데이터로만 정했다.
  · ⚠⚠ **최종 수정분 적대적 검토(기준 `56fa133`, VA~VE 5그룹 + 리드) — 생존 12건 전부 고쳤다**(회귀 `server/test/audit2744{va,vb,vc,ve,vlead}` + 웹 `audit2744vd`·`tools/audit2744ve` — 그룹별 변이 검증):
    · ⚠⚠ **root 는 서비스 계정이 바꿀 수 있는 실행 파일을 실행하지 않는다 — '비밀 하나 만들기' 같은 작은 일도**(VA PKG-01): install.sh 가 AUTH_SECRET 을 만들려고 `$PREFIX/runtime/node` 를 root 로 돌렸다
      (같은 파일 주석이 금지한 바로 그 일). `vp_gen_secret` = 패키지 node → openssl → urandom, 셋 다 안 되면 portal.env 를 만들지 않고 멈춘다(빈 AUTH_SECRET 금지).
    · ⚠⚠ **'누구 권한으로 실행하나' 는 파일 소유자 하나가 아니라 길 전체로 정한다**(VB VERIFY-01·02, `release-verify-lib.sh vp_path_controllers`): 옛 설치본 확인 도구의 node·js 경로의 폴더·링크·링크 대상을
      lstat 으로 훑어 바꿀 수 있는 비-root 계정이 0명이면 root, 1명이면 그 계정으로 낮추고, 둘 이상·그룹/기타 쓰기·순환이면 **실행하지 않고 멈춘다**. 정책 한 줄을 읽으려고 그 node 를 root 로 돌리지 않는다
      (`vp_policy_reader` — 길 전체가 root 전용인 node 만. ⚠ 새 패키지 node(trust=package)는 거르지 않는다 — 곧 root 로 확인 실행하는 node 라 거부하면 정책 읽기만 더 약한 bash 폴백으로 떨어진다, VB 검토 재현). 열기 오류는 반환 12 + 실제 원인(VERIFY-04) · `& 022` portal.env 정책 거부(VERIFY-05) · node 없는 폴백은 시한 있는 한 번 열기 + inode 대조(`vp_safe_read`, VERIFY-03·06).
    · **로드 오류 원문 — 손상본을 보존하지 않는 catch 도**(VC + 리드 10곳): 자체 보존 로더 6곳 + `vcenters.json`(비밀번호 평문 — 수집 주기마다 반복되던 줄)·db-location·central-fleet·센서 상세 캐시.
      스윕은 둘이다 — `audit2744fc findRawLoadLogs`(보존 경로) · `audit2744vlead`(`try { JSON.parse } catch` 의 콘솔 줄 전수, 보존 여부와 무관).
    · **'점검하지 못함' 은 '닿지 않음' 이 아니다**(VD — `vmRemoteProbeText.js`): 거부는 종류별(데모·권한·OTP·범위·사유 미상), 점검 못 한 200 `{ok:false, method}` 는 회색 + 서버 사유, 방화벽 안내·빨강은 실제로 점검했고 닫혔을 때만.
    · **화면 문구 함수가 쓰는 데이터를 응답이 실제로 싣는지 볼 것**(VE WEB-03): `detailNotes` 의 FC 판정은 어떤 응답도 수집 상세를 싣지 않아 화면에 닿지 않았다(단위 테스트는 통과했다). 폴러가 서버별 최근 상세를 들고 `/history` 가 싣는다.
    · 남긴 것: install.sh 2)·3) 의 `rm -rf "$PREFIX/runtime/node"`·`cp -a … "$APP_DST"` 링크 추종(쓰기·삭제 계열 — VA 검토자 재현, 다음 점검 후보) · VB node 없는 폴백의 열기 순간 경쟁(수십 ms 창 — inode 대조로 버린다) · 스윕은 휴리스틱(중간 변수를 거치면 놓친다).
  · ⚠ 작업 방식: 10/16 첫 수정 실행 10그룹이 **조직 월 사용 한도**로 전부 중단됐다 — 그 사실을 바로 보고하지 않은 것은 리드의 실수다. 한도 해제(10/19 13:00 KST) 뒤 반쯤 고친 파일 8개를 기준판으로 되돌리고 처음부터 다시 돌렸다(v2.607 규칙).
    커밋 33be198 은 그때 아직 하지 않은 수정을 '✅ v2.744' 로 적었다 — 이번 수정이 끝난 뒤 문구를 실제 범위로 맞췄다(EDGE-03 은 '자동 등록만').
- ⚠⚠ **v2.719 — 데모 모드·데모 계정이 실제 장비·운영 동작에 닿던 경로를 막았다(코드 리뷰·안정화 1회차)**(6축 감사 → 반증 → 8그룹 수정, 확정 31 · 가능성 2, 회귀
  `server/test/audit2719{a1,a2,a3,b,c,d,e}.test.js` + 웹 `views/tools/audit2719f.test.js` — 고친 파일마다 변이 검증. 상세 `docs/AUDIT-2026-10-07.md`):
  · ⚠⚠ **'mock 모드' 와 '데모 항목' 은 다른 축이다 — 판정은 언제나 둘의 논리곱**: 합성 수집은 `isMockMode() && mock- id`(SAN 기본·사용량 · bmstor · Isilon 영역 DB ·
    bm-usage 대상 `isDemoBmTarget`)이고, 사람이 등록한 장비는 mock 모드에서도 실제로 수집한다(v2.708 규칙을 v2.709 이후 여러 폴러가 어기고 있었다 — 합성 값이 실장비 이력에 쌓였다).
    반대로 **live 에서는 데모 표지 항목을 실제로 점검·실행·선택하지 않는다**(svcmon 배치 `mock-demo` · vmclone `demo:true`(옛 시드는 clone ref `mock-demo-`) · 볼트 `isDemoCredential`) —
    건너뛴 개수는 상태(`demoSkipped`)와 콘솔에 남긴다. `demoOn` 으로 켜진 주기(저장 설정은 꺼짐)는 데모 대상만 돈다(PDU·CVP·HAProxy 경로·SAN).
  · ⚠⚠ **데모 계정의 GET 도 실제 접속을 할 수 있다** — `auth/demoGuest.js LIVE_GET_DENY`(relay-test · iDRAC gpu-probe · inventory?refresh=1 · sensors?live=1 등)와 보안 조회
    (secret-scan · portal-check/tokens)를 막는다. **새 실접속 GET 을 만들면 LIVE_GET_DENY 에 더할 것** — `audit2719b` 가 라우트 소스에서 실접속 함수(`LIVE_CALLEES`)를 부르는
    GET 을 훑어 전부 거부되는지 고정한다. 데모 계정 수동 수집(PDU·CVP)은 `demoOnly` 로 데모 장비만. 403 의 `demoGuest` 표지는 화면이 '데모 계정' 안내로 말한다.
  · 데모 알림 가드 둘 더: PDU 임계(`splitDemoAlerts`) · HAProxy 경로 데모 호스트 전이 — 상태는 기록하고 보내지 않는다(`demoAlertsSuppressed`).
  · **vCenter 부가 갱신 예산은 남은 수집 시한에서 뺀다**(`auxBudgetMs` — 하한 미만이면 건너뛰고 `auxSkipped`). 중단·시한 실패는 '읽음' 으로 캐시하지 않는다(태그는 `retryAt` 10분,
    호스트 구성은 put 하지 않음). 태그 연결이 잘린 vCenter 는 `partialTags` → 누락이 아니라 '확인 안 됨(부분)'(엣지 정제도 싣는다). VM `storageGB` 결측은 null.
  · 가용성: 이벤트 상한 절단은 잘린 시점부터만 잰다(`readCut`) · 생성 → 첫 켬은 정지가 아니다 · 마지막이 켬인데 지금 꺼짐은 `missedOff` · 측정 0 은 `clockSkew`(웹 문구 함께).
  · SAN 조회 감시 재시작은 사용 중인 핸들을 닫지 않는다(진행 중 prune 이 0 을 거짓 보고하던 것).
  · 남긴 것: 새 상태 필드(`demoSkipped`·`auxSkipped`·`partialTags`·`hostcfg transient`)의 화면 표시 · `edge-log-local` 데모 계정 조회(정책 판단) · 웹 10화면 vCenter 선택 Chromium 미확인 시 보고.
- ⚠⚠ **v2.720 — 2회차: 1회차 수정이 만든 회귀 4건이 먼저였다**(6축 감사 → 반증 → 5그룹 수정, 23건. 회귀 `server/test/audit2720g{1,2,3,4}.test.js` +
  웹 `views/audit2720g5.test.js` — 고친 파일마다 변이 검증. 상세 `docs/AUDIT-2026-10-07b.md`):
  · ⚠⚠ **예산은 '다음 대상을 시작할지' 만 정한다 — 시작한 대상의 일을 버리지 말 것**(hostcfg R1-01): v2.719 가 호스트 안 조회마다 예산을 보고 잘린 호스트를
    버리자, 사전 조회에 예산을 다 쓰는 고지연 vCenter 는 **매 주기 0대만 저장되는 정체**가 됐다(축소 재현 0/0/0 → 수정 후 4/8/12). 진짜 abort 만 일을 버린다.
  · **'다음 주기 재시도' 에는 백오프와 상한이 있어야 한다**(R1-02): 계속 시한에 걸리는 호스트를 캐시하지 않으면 30초마다 다시 묻는다 — 10분부터 지수 백오프,
    3회 연속이면 예전처럼 null 로 캐시. 태그는 부분 결과가 완전한 직전 연결을 덮지 않는다(R1-04). **'캐시하지 않는다' 를 고치는 수정은 재조회 빈도를 함께 볼 것.**
  · ⚠⚠ **mock 합성 범위를 좁히면 데모 계정의 '안전한 실행' 이 실장비 로그인으로 바뀐다**(R1-03 — v2.719 의 부작용): 수집형 SAFE_ACTIONS 는 전부
    `demoOnly: isDemoGuest(req.user)` 를 넘긴다 — `audit2720g2` 가 SAFE_ACTIONS 의 수집 경로를 라우트 소스에서 훑어 고정한다(curuser 는 mock 이면 전 vCenter 합성이라 예외로 적었다).
    엣지 위임 장비의 재수집 요청도 데모 계정이면 등록하지 않는다. 데모 계정은 엣지 로그·통신 점검·RMA·중계 렌더 조회를 볼 수 없다(B2-03 — 정책 판단으로 막았다).
  · 스토리지 폴러 합성 조건도 `isMockMode() && isDemoId` 다(R1-05 — v2.719 가 영역 DB 만 막았다).
  · **알림 해소는 '봤는데 없다' 일 때만**(B1-01): 목록 상한으로 잘린 꼬리와 읽지 못한 vCenter 의 키는 해소 판정 보류(HELD_MAX_MS).
  · 결측 → 0 세 곳 더: CVP KPI 의 확인 불가 장비 합산(B1-02 — Overview 와 같은 판정 재사용) · CVP 트래픽 방향 결측(`inUnread`·`outUnread`) · SAN 스토리지 사용량 null 계열 · 전력 보고 없는 vCenter.
  · vCenter 삭제·접속처 변경 시 구성 캐시 6종 비움(`syncVcConfigCaches`) · 증분 수집 세션 연속 실패 백오프.
  · ⚠ 작업 방식: mock 모드 + 사람 등록 장비에 기대던 기존 테스트 3개(storageMon·audit2600b·audit2599c)를 `.invalid` 주소·`SSH_READY_TIMEOUT_MS` 로 빨리 실패하게 바꿨다 —
    **실장비 수집으로 바뀐 경로의 테스트는 닿지 않는 주소에서 시한을 기다리지 않게** 할 것(audit2599c 가 120초 시한에 걸렸다).
- ⚠⚠ **v2.721 — 3회차: 이번에도 직전 수정이 만든 회귀가 절반이었다**(6축 감사 → 반증 → 6그룹 수정, 확정 18 · 가능성 1. 회귀 `server/test/audit2721{a..f}.test.js` +
  웹 `views/audit2721d.test.js`·`views/tools/sanStorageSum2721.test.js` — 고친 파일마다 변이 검증. 상세 `docs/AUDIT-2026-10-08.md`):
  · ⚠⚠ **'시작한 대상은 끝까지' 에는 상한이 짝이다**(R1-01 — v2.720 R1-01 의 반대편): 예산을 무시하고 끝까지 읽게 하자 느린 호스트 하나가 store 데드라인까지 달려
    vCenter 수집 전체를 끊었고, 데드라인 abort 는 시한 실패로 세지 않아 다음 주기에 같은 호스트를 다시 골랐다. 이제 시작한 호스트도 `예산 끝 + 10초`(AUX_RESERVE 15초보다 짧게)를
    넘기면 시한 실패로 백오프하고, 예산을 넘긴 채 abort 로 끊긴 호스트도 실패로 센다. **'버리지 않는다' 규칙을 만들 때 '그 일이 끝나지 않으면 무엇이 멈추는가' 를 함께 답할 것.**
  · **부가 갱신 4종(dscfg·clustercfg·vmcfg·contention)도 대상별 재시도 백오프**(S1-03, `dscfg/collect.js createRetryTracker` — hostcfg 와 같은 규칙, abort 제외).
    ⚠ 호출별 SOAP 시한을 남은 예산으로 줄이는 것은 `soapClient.js` 에 인자가 없어 남겼다.
  · **구성 캐시 정리는 수집 전**(S1-01·R1-04 — `store.js` loadVcenterConfig 직후 한 번): 수집 뒤에 하면 접속처를 바꾼 첫 주기에 옛 vCenter 값이 새 스냅샷에 붙는다.
  · **mock 모드에서 이미 합성만 하는 경로에 demoOnly 필터를 겹치지 말 것**(R1-03·S1-02): Horizon 은 mock 에서 비-데모 서버에 로그인하지 않는데 필터가 정리 기준을 좁혀
    등록 서버의 최신 행을 지웠다. 필터는 mock 이 아닐 때만, 정리 기준은 등록 전체, 거른 실행은 전체 추이를 적재하지 않는다. bmstor demoOnly 실행은 lastRunAt 을 갱신하지 않는다.
  · **null 을 만들었으면 그 값의 모든 보기를 따라갈 것**(R1-02·R2-01·R2-02 — v2.720 B1-05 의 나머지 절반): SAN 법인 소계 초기값 0 · 피크 보기 `|| 0` 이 '측정 없음' 을 0 bps 로 되돌렸다
    (`sanStorageDcSubtotals` · 웹 `sanStorageSumText.js`). Summary 기여도 안내는 조건을 따로 쓰지 말고 `contribNote` 문장 자체가 있을 때(R2-04).
  · CVP '스트리밍 아님' = `unconfirmedBy['not-streaming']` 만(R2-03 — 서버 `cvpTotals`·웹 `totalsFromDevices` 같은 규칙).
  · 판정 정직성: 비용 태그 부분 읽기 · 이전 준비도 그룹 분모(판정 불가 제외 — 전체와 같은 규칙) · vSAN 추가분 bound(upper·lower·unknown → `addonText`) · 재부팅 분류는 이벤트 읽기
    상한(limit+1)으로 절단을 보고 잘린 구간 부팅을 `readCut` 으로 둔다 · 범위 계정에 VM DNS 점검 요약·질의 이름, VM 구성 점검 예외 내용·수정자를 가린다.
  · 남긴 것: 새 상태 필드(capped·rested·backoffTargets 등)의 화면 표시 · 재시도 기록의 vCenter 삭제 시 즉시 정리 · 실장비 미확인(가짜 클라이언트·합성 입력).
- ⚠⚠ **v2.680 — 1회차 점검(버그·튜닝·개선·보안) 확정분**(사용자 요청 "버그 수정, 튜닝, 개선, 보안 취약점 점검 3회" 의 1회차. 6축 감사 → 4그룹 + 리드 수정 →
  수정마다 변이 검증. 상세 `docs/AUDIT-2026-10-02.md`, 회귀 `server/test/audit2680{a,b,c,e,f}` + 웹 `audit2680{b,c,d}`):
  · ⚠⚠ **두 출처가 같은 값을 줄 때는 '더 자주 읽는 쪽' 이 이긴다**(A-01 high): 센서 상세가 30분 주기 Sensors 컬렉션을 먼저 넣고 Thermal 은 빈 칸만 채워, Critical 흡기가
    OK 로 보였다. 컬렉션은 임계값·추가 센서만 채우고, 75분(`SENSOR_COLLECTION_FRESH_MS` — 판정 한 벌)이 지난 컬렉션 전용 센서는 판정 불가로 요약에서 뺀다.
  · **조회 실패 상태로 편집기를 열지 않는다**(D-01 high — v2.618 WEB-2 '조회 실패 → 저장' 의 재발): 특수 기능 이름·단계 편집기는 설정을 읽은 뒤에만 열리고 그 전엔 저장을 거부한다.
  · **확인 불가 장비의 남은 값은 합산하지 않는다**(B-01) · 부품 목록은 `faults.partsFresh`(부품 주기×3 + 장비 경계)를 넘으면 관측이 아니다(B-02 — v2.548 C2 거짓 신선) ·
    Overview 와 장애 판정은 같은 `TELEMETRY_OK` 를 쓴다(B-03). CVP 대소문자 병합(`ADOPT_PK`)은 agent 축을 가진 **모든** 표를 옮긴다(F-01 — 새 표를 더하면 여기도).
  · **요청 경로에서 등록부를 행마다 읽지 말 것**(A-04 — `loadIdracRegistry` 는 statSync + structuredClone) · 지표 기간 통계는 키별 seek(E-02 — `GROUP BY k` 는 파티션 전체).
  · **사용자 입력 일수는 함수 안에서도 자른다**(C-01 — Infinity 가 끝나지 않는 조각 루프) · super_admin 판정은 로컬 토큰 표지 `authSrc:'local'`(C-03 — 이름 조회는 같은 이름 AD 세션을 통과시켰다).
  · 정직 기록: 실장비 미확인(합성 재현) · B-06(브레이크아웃 트랜시버)·F-03(CVP 이벤트 워터마크) 미처리 · 센서 상세 캐시 동기 저장은 빈도만 줄였다.
- ⚠⚠ **v2.681 — 2회차 점검 확정분**(1회차 회귀 축 포함 6축 → 4그룹 + 리드 수정, 회귀 `server/test/audit2681{a,b,c,e}` + 웹 `views/audit2681d`(v2.747 에 옮김). 상세 `docs/AUDIT-2026-10-02b.md`):
  · ⚠⚠ **로컬 계정과 이름이 같은 AD 로그인은 받지 않는다**(R2B-01 HIGH): 설정 소유자·자격증명 가드가 이름으로 판정하므로 같은 이름 AD 세션이 그 로컬 계정 권한을 얻었다.
    `authenticate()` 는 로컬 이름(대소문자 무시)이면 AD 를 시도하지 않고, `resolveTokenUser` 는 그런 비-로컬 토큰을 null 로 본다. **이름으로 판정하는 새 가드를 만들 때 이 전제가 그 안전의 근거다.**
  · ⚠⚠ **1회차 수정이 만든 회귀 셋**(R2A-01~03): 엣지 위임 행은 push 의 60분 전량 갱신(`faults.EDGE_FULL_REFRESH_MS` — push.js 와 한 벌)만큼 부품 신선도가 넓다 ·
    export 상한에서 사용률·온도 센서 먼저 · 모르는 개수는 숫자로 지어내지 않는다(faultEventsMore). **신선도 경계를 새로 넣을 때는 데이터가 그 경로로 얼마나 자주 갱신되는지부터 볼 것.**
  · **'기대 장비' 는 버킷마다**(R2D-01 — 퇴역 장비 하나가 이후 구간 전부를 부분 합으로 만들었다) · 사용률 분모는 사용량을 읽은 장비만(R2D-02 — 서버 growth.totalsOf 와 웹 aggregateGrowth 둘 다) ·
    오래 미수집·퇴역 장비는 '지금 합계' 에서 빼고 센다(R2D-03, `GROWTH_STALE_DAYS` 7).
  · 엣지 헤더는 값도 ASCII 로(R2F-01 — `X-Agent-Hostname` 이 한글 호스트명에서 push 를 통째로 던졌다. `agentNameCarry.agentHostnameHeader`, audit2629c 가 스윕) ·
    DB 를 못 쓴 수신은 503(R2F-03 — 통신 점검이 200 + stored 로 거짓 성공) · 배포 대상을 중앙이 모르면 필드를 빼고 엣지는 직전 값 유지(R2F-04).
  · 요청 경로의 소스 트리 전량 스캔은 한 번만(R2E-01 — 아키텍처 점검 0.4초 정지) · 실행 버튼은 진행 중 실행을 공유한다.
- ⚠⚠ **v2.682 — 3회차 점검 확정분**(2회차 diff 회귀 축 포함 6축 → 4그룹 + 리드 수정, 회귀 `server/test/audit2682{a,b,c,d,lead}` + 웹 `audit2682{a,b,c}`. 상세 `docs/AUDIT-2026-10-02c.md`):
  · ⚠⚠ **'퇴역' 은 시간만으로 판정하지 않는다 — 등록부가 '아직 등록돼 있다' 고 하면 결측이다**(R3A-01·02): v2.681 이 넣은 퇴역 판정을 knownIds 없이
    쓰는 호출부(경영 보기 추이)가 수집이 멈춘 등록 장비를 하루 뒤 빼서 거짓 하락을 그렸다. SAN 트래픽도 같다 — 장비가 어느 포트로도 보고하지 않으면 시리즈를
    퇴역시키지 않고 '—'(재배선은 그 장비가 다른 포트로 계속 보고할 때만). 빼는 것은 `retiredSeries` 로 밝힌다. **퇴역 판정을 새로 쓰는 호출부는 등록부를 넘길 것.**
  · **영구 실패 VM 하나가 추이를 영원히 비우지 않게**(R3A-03): 같은 사유로 3주기 연속 실패한 VM 은 부분 합 판정에서 빼고 `persistentFailures` 로 센다(메모리 —
    재시작 뒤 3주기 동안은 예전처럼 보류). 진짜 일시 실패의 부분 합은 여전히 적재하지 않는다(v2.606·v2.622 규약).
  · ⚠⚠ **엣지가 보낸 시각은 수신 시각으로 자르고, 엣지 행은 그 서버의 담당 엣지 것만 쓴다**(R3S-01·02): 미래 ts 는 신선도 판정(now − ts)을 영원히 통과한다.
    원본은 별도 필드(`edgeT`·`edgeTimes`)로 남긴다. 사용률 키(서비스태그)가 같아도 담당 엣지가 아니면 다른 법인 값을 덮지 않는다.
  · ⚠⚠ **서비스태그가 양쪽 다 있고 다르면 이름·IP·MAC 이 맞아도 같은 장비가 아니다**(R3D-04): `hostMatch`·`serverForHost` 가 연결하지 않고
    `tagMismatch`·`rules.serviceTag.state='mismatch'` 로 밝힌다(호스트명 재사용). BMC IP(등록 host·인벤토리 network)는 OS IP 후보가 아니다(R3D-09).
    엣지 export 는 NIC `mac`·`hostName`·`hostNames` 를 싣고 중앙 정제가 받는다(R3E-01 — **새 export 필드는 정제 화이트리스트에도**, v2.611 규약).
  · **측정 0대는 '—', 일부만 읽었으면 그렇게 말한다**(R3D-01·02·03·05): 개요 소비 전력·GPU 카드가 `0.0 kW`·`0 장` 이었다(경영 보기에는 v2.678·v2.680 이
    고쳐 둔 판정이 있었는데 엔지니어 보기 카드에 없었다 — 형제 비대칭). 스토리지 전력은 전원 키가 있는데 값을 못 읽은 PSU 를 세어 `partial` 로 둔다.
  · **DB 오류를 '0건' 으로 삼키지 않는다**(R3E-02 — 로그인 실패 분석): `incomplete` + 증분 기준 전진 안 함 + 모니터는 lastSummary 를 덮지 않는다.
  · 보안: client-stall 문자열 `capStr`(R3S-03 — 0.9MB × 50건이 힙 43MB) · LLM 연결 테스트 fleetOnly(R3S-04) · CVP 포트 MAC·설명 비-admin 가림(R3S-06) ·
    개요 카드 원천 오류 원문은 admin + 전체 범위만(R3S-07, memo 키에 역할). ⚠ **R3S-05(범위 관리자의 메일 이력 조회)는 정책 판단이라 남겼다.**
  · 성능: 아키텍처 점검 import 그래프 비동기 빌드(최장 정지 354.9 → 25.5ms — 대신 첫 응답 총시간은 231 → 424ms) · iDRAC 통합 추이 서버 표 30초 memo.
  · ⚠ `routes/publicApi.js` 라우트 본문이 길어지면 `scripts/api-doc.mjs` 가 '인자 목록을 읽지 못한 라우트' 로 멈춘다 — 행·meta 조립을 헬퍼로 뺐다(이번에도 밟았다).

- **v2.760 — 단독 점검(덜 감사된 영역 우선) 확정 9건**(회귀 `server/test/audit2760{a,b}` · `uagmon/test/uag2760` · pyportal `test_history`·`test_backup_dc`·`test_api` · C# `AlarmEngineTests` — 전부 수정 전 코드로 되돌려 실패 확인):
  · ⚠⚠ **순차로 소비하는 큐의 미완료 TTL 을 '등록 시각' 부터 재지 말 것**(B-01 `rma/jobs.js prune`): 엣지는 TAKE_MAX=1 로 하나씩 돌고 그동안 폴하지 않는다 —
    대기 잡은 '그 법인이 마지막으로 움직인 시각' 부터, 실행 중 잡은 기한(claimDeadline)까지 둔다. 타임아웃이 TTL 과 같거나 긴 잡(du-top 900초)은 결과가 버려졌다.
  · '못 읽은 값은 0 이 아니다' 재발 3곳: 라이트사이징 RAM(B-04 — 정수 GB 반올림까지) · 심층 검색 RAM 필터(B-09) · uagmon `parseStats` 의 `Number(v)`(B-06).
  · '기준선 없음' ≠ '기준선 0대'(B-03 vmtrack — 직전 슬롯 total 0 이면 기준선이 있다) · 평균의 평균 금지(B-02 pyportal 기간 평균 지연 — 표본 가중).
  · 확인 창이 약속한 정리를 서버가 하지 않았다(B-07 pyportal 데이터센터 삭제 → 바로가기 '전체' 로) · 한 칸의 `int()` 가 설정 전체를 막았다(B-08).
  · ⚠ **horizon-uag-monitor 의 C# 테스트는 PR CI 에서 돌지 않는다**(릴리스 워크플로에서만) — 소스를 고쳤으면 `apt install dotnet-sdk-8.0` 후 직접 돌릴 것(B-05 이번에 그렇게 확인).
  · 남긴 것(기능개선 후보, 미착수): dirusage 실패 회차의 짧은 재시도 · pyportal 응답시간의 DNS 분리 · 웹훅 실패 시 알림 보존 · uagmon 주기 런타임 변경·이력 시간 기준 보존 ·
    vmclone '매일' 새 잡 즉시 실행(테스트가 고정한 설계 — 확인 필요) · 백업 파일명 초 단위 충돌 · 스냅샷 경과 보고서 `snapshotSizeGB || 0` · 남은 `text-transform: uppercase` 9곳.

- **v2.762 — 최근 변경 영역(v2.757~v2.761) 점검 확정 18건 + 개선 9건**(찾기 4축 E·F·G·H + 반증 1인 — 반증 0건 · 회귀 `server/test/veeam2762{a,b}`·`audit2762c` · `uagmon/test/uag2762` · pyportal `test_settings_2762` — 수정 전 코드로 되돌려 실패 확인, 위험 항목 변이 검증):
  · ⚠⚠ **'옮겼으면 지운다' 는 지운 뒤 다시 들어오는 경로까지 막아야 끝난다**(G1·G2): v2.761 B4 는 접속처를 바꾸면 결과를 지웠지만 ① 엣지 정기 push ② 진행 중이던 옛 접속처 수집 ③ lastOk 승계가 옛 결과를 되살렸다.
    결과에 접속처 지문(`registry.accessFingerprint` — host:port:username 해시)을 싣고 수신·저장·승계가 등록부 지문과 대조한다(지문 없는 옛 엣지 결과는 수용 — 호환). 수집은 시작할 때 사본+지문을 잡는다(등록부 원본 객체를 쥐면 도중 변경이 섞인다).
  · ⚠ **재발급 가능한 서명에 '등록 시각' 을 박고 큐에서 오래 기다리게 하지 말 것**(H1 RMA): 대기 수명을 늘린 v2.760 이 서명 법인에서는 ±10분 창에 걸려 전부 거부됐다 — 인출 때 재서명(비밀은 그때 조회, 잡에 보관 금지) + 서명 잡 대기 상한 1시간.
    '움직임' 은 실제 인출·실제 회신만(H2 — 하트비트·503 조기 반환·정리 종결은 아니다).
  · 메모리 무효화는 재시작에 사라진다(C5·E1) — 디스크 표지(`<db>.invalid`)로 남기고 다음 open 이 소비한다. 표지는 DB 이전 스크립트 사이드카에도 넣는다(`migrateScript` SFX).
  · 두 저장소에 쓰는 적재는 '덮음' 을 기록하는 쪽을 먼저(E2) · busy_timeout 동기 대기 × 재시도 × 주기 = 반복 정지(E3 — open 은 시도당 1회).
  · 등록부를 못 읽으면 '연결 없음' 이 아니다(F4 — 사용자 라우트도 503) · 그 상태의 주기 정리(pruneExcept([]))는 전부 지운다(F4b).
  · 가림은 개수도(F5 — 비관리자에게 otherVcenter 수 대신 불리언 · 캐시 키에 역할) · 고정 '오래됨' 한도는 사용자 주기 설정과 맞지 않는다(F6).
  · 남긴 것: 엣지 스냅샷 요약의 주기 필드(F6 엣지 — 수신 계약) · 옛 엣지(지문 없음)의 G1 · 지문 16hex 는 짧은 사용자명 대입으로 되찾을 수 있음(비밀 아님) ·
    H-S2(C#)는 dotnet 이 없어 컴파일 미확인(PR CI 에서 돌지 않음) · G-I1 실서버 판 거절은 미확인.

- **v2.763 — Veeam 3회차 전수 점검(전체 검증: 찾기 5축 V1~V5 + 반증 1인 + 수정본 재검토 1인) 확정 17건 + 개선 7건 + 재검토 후속 3건**(회귀 `server/test/veeam2763{a,b,c,d}` · 웹 `veeamBadge.test.js` — 수정 전 코드로 되돌려 실패 확인, 위험 항목 변이 검증 A 13/13 · B 22/23(남은 1은 등가) · C 32/32):
  · ⚠⚠ **데모·테스트가 실서버에 없는 모양만 쓰면 결함이 가려진다**(V4-1): 미보호 VM 보고서는 `VmSnapshotCreatedEvent` 만 근거로 봤고, 데모·`reports.test.js` 도 그 종류만 썼다 — 실서버 vCenter 는 `TaskEvent`('Task: Create virtual machine snapshot')로 남겨(snapEvents.js v2.755 기록)
    켜진 VM 이 전부 '미보호' 였다. 판정은 snapEvents 의 `isSnapshotCreateEvent`/`isSnapshotRemoveEvent` 를 공유하고, 데모는 세 모양(옛 종류·TaskEvent 영어·한국어)을 섞는다.
  · ⚠ **대량 가져오기는 '열이 없음' 과 '칸을 비움' 을 구분한다**(V1-1 — cvp `keep` 패턴): 이름만 고친 CSV 가 엣지 담당·수집 꺼짐·API 판·메모를 지웠다.
  · 엣지 시계 보정(sentAt — 결과·스냅샷 요약)은 **2분 미만을 보정하지 않는다**(R2-1 — 전송·재시도 지연을 시계로 오인하면 시계가 맞는 엣지의 결과가 새것처럼 보인다) · 30일 초과도 보정 안 함 · 옛 엣지 무보정.
  · 엣지에서 중앙 배정(pulled) 서버를 고치면 pull 이 되돌리지 않고 지문 대조가 결과를 버린다(V2-1) — 엣지 노드는 409 + '중앙에서 고치세요'. 형제 pull(스토리지·SAN·CVP·PDU·isidu)도 같은 `_lastSig` 구조(남긴 것).
  · 비밀번호가 없으면 로그인하지 않는다(V1-I1 — 주기·수동·연결 시험 모두. 빈 비밀번호 로그인이 AD 실패 로그온을 쌓았다) · 대기 중 삭제·끈 서버는 차례가 와도 건너뛴다(V3-1).
  · 진행 중 잠금은 그 버튼만(V5-1 — web.md v2.529 규칙 재발) · 사람이 고른 값을 자동 제안이 덮지 않는다(V5-2 agentTouched).
  · 남긴 것: V1-5(복원 지점 직렬 페이지 — 고RTT 중앙 직접 수집에서 시한 초과 가능, 권장 배치는 엣지) · V4-3(이벤트를 moref 로 대조 — 이름을 물려받은 새 VM) ·
    V4-4 의 '쪽 수 한도로 끝났는데 4만 건 미만' 경우(soapClient 가 끝난 이유를 돌려줘야 함) · V2-3 GET 쪽 거부 사유(pullStats) · R2-3(등록부 손상 시 스냅샷 요약도 보내지 않음) ·
    R2-5(옛 VmSnapshot*Event 일부를 예전보다 좁게 판정 — 거짓 경보 쪽, 실서버 영향 없음으로 추정) · 미보호 보고서의 계정 판정·Veeam 결과 미반영.

- **v2.765 — vCenter 이벤트 수집 지연(실서버 OC2 13일 정체) 진단·수정**(찾기 2묶음 + 반증 1인 + 후속 2묶음 · 회귀 `server/test/logs2764`·`veeam2764` · 웹 `vcLogCollect.test.js` — 수정 전 코드로 실패 확인):
  · ⚠⚠ **'주기마다 상한만큼' 은 생성 속도를 넘는 vCenter 에서 영영 못 따라잡는다**(OC2 — 실서버 콘솔은 매 10분 '23,000건 장기 보관' 만 찍고 실패 줄이 없었다 = 정상처럼 보이는 정체).
    따라잡기는 **한 세션 안의 묶음**(`collectVCenterEvents onBatch` 2,000건 · vCenter 별 시간 예산 = 주기의 80%)으로 — 회차마다 재로그인하면 RTT 800ms 에서 예산의 1/3 이 오버헤드이고 힙이 1.2GB 까지 갔다(반증 실측).
  · ⚠ **시한에 걸리면 읽은 것을 버리지 말 것**(`vcLogWithDeadline` — race 거부 → 부분 결과 수용, abort 뒤 정리는 5초 시한) · **커서를 메모리에만 두지 말 것**(재시작 8회/2일 → 매번 db.lastTs 로 회귀 — `vcenter-logs-cursor.json`).
  · ⚠ **'다음 since = 마지막 + 1ms' 는 같은 ms 의 나머지를 잃는다**(상한·묶음 경계마다) — 포함(≥)으로 읽고 중복은 키(번호@시각·해시)로 거른다.
  · ⚠ **필터 수집기의 '0건 완결' 은 완결이 아니다**(Veeam 전용 수집기 — 계정 표기 `svc-veeam` vs `CORP\svc-veeam` 이면 0건을 읽고 '지금까지 온전' 으로 기록해 13일 뒤처진 판정이 '0대' 로 뒤집혔다) — 이벤트를 1건이라도 읽은 뒤(`seen:<vc>`)부터만 완결 시각을 기록.
  · 진단 공백: 정상 경로는 vCenter 별 콘솔 줄이 없었다 — 설정 › Log 의 vCenter 별 수집 상태 표 + 지연 1일 경고 + 시한 힌트. `maxPerPoll` 은 화면에 없었는데 안내에서 '올리라' 고 했다(틀린 안내 — 이제 스트림 방식이라 값 자체가 수집을 자르지 않음, 입력 칸 제거).
  · 남긴 것: 같은 ms 에 상한을 넘게 몰리면 전용 수집기는 그 vCenter 를 stalled 로 멈춤(로그 폴러가 보완) · 첫 쪽도 시한 안에 못 읽는 vCenter 는 여전히 0 진행(힌트로 timeoutMs 상향 안내) ·
    심각도 필터 vCenter 가 따라잡는 중에도 '정체' 로 보임 · 커서 DB 식별은 inode 재사용을 못 잡음 · vCenter userList 매칭 규칙(대소문자·표기)은 실서버 미확인 · 전용 수집기 주기는 로그 설정 저장 때만 재무장.
- **v2.766 — 버그 점검 1회차(다중 에이전트 5축 → 반증 1인 → 수정 3그룹) 확정 13건**(회귀 `server/test/audit2766{a,b}` · 웹 `views/audit2766g3` · `veeamBadge.test`):
  · ⚠⚠ **'완결 시각' 은 그것을 만든 입력 집합과 함께 둔다**(R1-A1-1·A5-1 `veeam/snapCollector.js`): Veeam 전용 수집기의 okAt 이 계정 목록과 무관하게 vCenter 단위였다 —
    공용 계정만 읽혀도 서고, 목록이 바뀌어도 커서가 안 돌아갔다. userList 지문(fp:<vc>)이 바뀌면 커서·okAt 을 지우고 끝까지 읽은 뒤에만 기록, 판정 양성 계정 ⊆ 덮음일 때만 결합.
  · **인메모리 커서는 DB 식별과 함께 대조한다**(R1-A2-01 `logs/poller.js syncCursorDbKey`): 기동 때 1회 대조는 실행 중 저장 경로 변경을 놓친다 — 매 주기 대조.
  · **INSERT OR IGNORE 의 '저장 수' 는 changes 로 센다**(R1-A2-02) — 커서 포함 재읽기(2-b) 이후 경계 1건이 매 주기 '저장' 으로 세였다.
  · 비관리자 가림은 형제 필드 전부(R1-A4-2 unmatched — otherVcenter 만 가렸다) · stale 결과의 '실행 중' 은 jobs 까지(R1-A4-1) · 엣지 pull 상한 < 중앙 송신 상한 금지(R1-A5-2).
  · 자동 제안 값은 '사람이 고른 값' 과 구분해 입력이 바뀔 때마다 다시 계산(R1-A3-01 — 남은 제안이 자격증명을 엉뚱한 엣지로 보냈다).
  · 남긴 것: A3-02(점검 호스트 CPU 카드 포함)는 테스트가 고정한 설계라 문구만 · 상대 경로 storagePath 기준(cwd)이 문서와 다를 수 있음(반증 부수 관찰, 미확인).
