# 규칙 — 아이실론 디렉터리 사용량·메일

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/isidu/ · web/src/views/tools/Isidu*·isidu*

## 목차

- (원래 3603행) 아이실론 디렉터리 사용량(v2.736) — du 출력은 반올림 값이고, 엣지 원격 실행은 '알림' 이지 '명령 전달' 이 아니다
- (원래 3646행) v2.738 — 아이실론 디렉터리 사용량 결과 메일. 규칙은 `isidu/mailRules.js`(순수), 발송·기록은 `isidu/notify.js` 하나
- (원래 3663행) v2.742 — 아이실론 종합 메일(정한 요일·시각에 전 법인 결과 한 통). 규칙은 `isidu/digestRules.js`(순수), 발송·일정·기록은 `isidu/digest.
- (원래 3690행) v2.745 — 아이실론 대상별 결과 메일 '보내는 때'(조사마다 | 정한 요일·시각) + 종합 메일 Top N/M 개수. 일정 규칙은 `isidu/mailRules.js`(대상)
- (원래 3737행) v2.739 — 아이실론 디렉터리 사용량 서브메뉴 4개(v2.740 에 서머리를 지워 지금은 3개 — 옛 summary 주소는 법인 현황으로 열린다) · 수집 대상 일괄 변경 · 
- (원래 5205행) v2.740 — 아이실론: 서머리 삭제(탭 = 법인 현황 → 전 법인 Top 10 → 수집 상태) · 수집 대상 설정은 설정 › 수집 서버 › 아이실론 디렉터리 사용량(슈퍼 관리자

## 본문

- ⚠⚠ **아이실론 디렉터리 사용량(v2.736) — du 출력은 반올림 값이고, 엣지 원격 실행은 '알림' 이지 '명령 전달' 이 아니다**
  (`server/src/isidu/`{parse,settings,targets,collect,collectRequests,db,report,poller,push,sshKey,edgeOps}.js + `central/isiduRemote.js` + `agent/isiduConfigPull.js` +
  `routes/api/isilonDirUsage.js` + `routes/collector.js /isidu-run·/isidu-test` + 웹 `views/tools/IsilonDirUsageTool.jsx`·`IsiduSettings.jsx`·`isiduText.js`, 도구 키 `isilon-dirusage`.
  사용자 요청: 지정 디렉터리 하위 폴더 크기 Top 10 · `du -A -h -d 1` · 비밀번호 없는 SSH · 각 엣지가 자기 법인 아이실론 · DB 추이 + "명령어를 특정 엣지에서, iDRAC 처럼 원격 실행" + "10분이 넘게 걸릴 때도 있어".
  회귀 `server/test/isidu2736.test.js`(실제 centralRouter·collectorRouter·가짜 아이실론 SSH — 변이 8/8) + 웹 `isiduText.test.js`(서버 판정과 대조)):
  · `-h` 값은 1024 단위 반올림 — 행마다 해상도(`res`)를 싣고 두 관측 차이가 해상도 안이면 `withinRes`(변화라 단정하지 않는다). 루트 합계 줄은 순위에서 빼고 '전체' 로, `du:` 줄은 `errLines`(그 스캔 크기는 하한).
    7일 변화는 7일 이전 성공 스캔이 있을 때만(관측 부족이면 null + 사유).
  · 이력 키 `agent` 는 언제나 `''`(HISTORY_AGENT) — 대상 id 는 중앙이 발급해 함대에서 하나이고 담당 노드가 바뀌어도 추이가 이어진다. 누가 조사했는지는 `node` 열.
  · 실행 노드: 등록부 아이실론은 기본 장비 담당 노드를 따르고 `runVia:'node'` 로 메인·특정 엣지를 지정한다. ⚠ 장비 계정 인증(`auth:'device'`)은 장비 담당 노드나 메인에서만 —
    다른 엣지의 스토리지 등록부에는 그 계정이 없다(서버 `normalizeTarget` 400 + 웹 `deviceAuthIssue` 경고, 문구 한 벌).
  · 원격 실행: 메인 → `POST {엣지}/api/collector/isidu-run`(같은 url·`COLLECTOR_TOKEN` — 새 네트워크 허용 없음). **본문에 대상·명령을 싣지 않는다** — 엣지는 중앙 설정 pull 을 지금 다시 하고
    claim→ack 큐의 요청만 시작한다(진행 중 pull 이 있으면 끝난 뒤 한 번 더). 전달 실패해도 요청은 큐에 남아 다음 pull(5분)이 가져간다. 판정 사다리는 `central/edgePull.js pullFromEdge` 하나
    (POST·jsonBody·`missing401`=401 은 구버전) · **재시도 0** · 데모 엣지는 `demo-edge`(collector 꺼짐과 구분). 연결 시험은 `isidu-test` 로 비밀 없는 대상 사본을 보내 엣지가 `cleanEdgeTarget` 으로
    다시 검증하고 `ls -d` 만 한다(동시 2, 429). 웹 `EDGE_CALL_TEXT` 키 = 서버 `EDGE_PULL_KINDS` + edge-pull·demo-edge(테스트 대조) — 종류를 늘리면 둘 다.
  · 시한: 대상당 1~180분(기본 120 — v2.739 에 30→120, 상한 120→180). SSH exec 상한은 30분이 기본이고 `{long:true}` 일 때만 3시간(`EXEC_LONG_MAX_MS`) — 다른 수집기에 long 을 붙이지 말 것. 세션 시한 = min(3시간, 명령 + 30초),
    명령 = min(명령, 세션 − 15초)(`sessionPlanOf` — 세션이 명령보다 먼저 끊으면 결과가 버려진다). 큐 시한은 대상 최대 시한 + 60초(`perItemMs`).
  · 키는 `CONFIG_DIR/ssh`(서비스 계정은 홈이 없다) · 없으면 ECDSA P-256 SEC1 PEM 생성(ed25519 생성기 금지 — v2.590) · 개인키는 응답에 싣지 않는다 · 인증 거부는 주기 수집 정지(`isidu-auth-stops.json`).
  · 권한 adminOnly + fullScopeOnly(CSV + data.csv) · 데모는 `mock-` 대상만 합성(장비·엣지 접속 0). 엣지 원격 요청 상태는 엣지 로그 표 `pull.isiduRemote`.
  · ⚠ 정직 기록: 실제 OneFS 출력은 사용자 스크린샷 형식만 봤다(파서는 그 형식 + -k). 실제 원격 엣지·아이실론으로는 확인하지 못했다(같은 프로세스의 엣지 라우트·가짜 SSH 서버).
- ⚠⚠ **v2.738 — 아이실론 디렉터리 사용량 결과 메일. 규칙은 `isidu/mailRules.js`(순수), 발송·기록은 `isidu/notify.js` 하나**
  (사용자 요청 "결과가 나오면 이메일로 · 1개의 결과에 다수개의 이메일 · 전체 공통으로". 선택: 공통 + 대상별 여러 명 · 조사가 끝날 때마다(대상별
  '변화 없으면 생략') · 수신자 합집합(대상별 '공통 빼기') · 같은 주소 한 번 · 실패 알림 선택(기본 꺼짐 · 6시간에 한 번). 회귀 `server/test/isiduMail2738.test.js`
  (가짜 SMTP · 실제 api·central 라우터 — 변이 11종 중 10종, 남은 1종은 중앙 수신 중복 판정 제거 = 발송 쪽 중복 방어가 같은 결과인 이중 방어) + 웹 `isiduText.test.js`):
  · **메일은 중앙만 보낸다** — 중앙 직접 조사는 `poller.js` 적재 직후, 엣지 조사는 `/api/central/isidu-data` 가 **새로 적재한 것만**(재전송 중복 제외) `notifyScanStored` 를 부른다.
    기다리지 않는다(발송이 조사·수신 응답을 막지 않게 — notify 는 던지지 않는다). 엣지 노드는 즉시 'edge' 로 끝난다. 메일 설정은 `edgeTargetView`·`cleanEdgeTarget` 에 싣지 않는다
    (주소를 28곳에 퍼뜨리지 않는다 — 테스트 고정).
  · 같은 결과를 두 번 보내지 않는다 — 대상별 마지막으로 다룬 조사 id·시각을 `isidu-mail-state.json`(상태 파일 · 세 등록부 등재)에 남기고, 그보다 오래된 결과(엣지가 밀린 결과를 늦게 보냄)는
    'older' 로 건너뛴다. 최신 성공 조사가 아니면 'not-latest'. 받는 사람이 없는 대상은 기록도 남기지 않는다. 데모(`mock-`) 대상은 어떤 모드에서도 보내지 않는다.
  · '변화 없음' = 메일에 보이는 것(상위 N 구성·크기, 전체 합계)이 직전 **성공** 조사와 du -h 해상도 안에서 같음(`changeSummary`). 첫 결과는 언제나 보낸다. 사람이 누른 '지금 보내기' 는 이것을 보지 않는다.
  · 형식이 틀린 주소는 **저장하지 않고 400**(field `mail.to`·`mail.commonTo`, index) — 조용히 빼면 그 사람이 영영 못 받는다. 요청에 mail 이 없으면 이전 값 유지(옛 화면이 지우지 않게).
    웹 `parseMailInput`·`recipientPreview` 는 서버 규칙의 사본이고 테스트가 같은 입력으로 대조한다(번들 경계라 두 벌).
  · 발송은 `sendPortalMail({kind:'isidu', to})` — 명시 수신자라 메일 설정의 기본·종류별 수신자로 새지 않는다(설정 › 메일 발송의 'isidu' 종류는 켜기·끄기만 뜻이 있다).
    자동 발송은 `by:'system'`(SMTP 인증 정지 대상), '지금 보내기' 는 사람 이름(수동 — 정지 중에도 시도). '보낼 수 있는 상태' 는 `isiduMailReady` 가 공용 `resolveRecipients` 로 판정한다.
  · 메인 목록 응답(`targetRows`)은 주소를 싣지 않는다(개수·선택·마지막 결과만 — 테스트 고정). 주소는 설정 조회에만. 상태 파일에도 주소를 적지 않는다(개수만).
  · `mail-now` 실패는 409(본문 사유) — 5xx 로 주면 재시도하는 호출부가 같은 메일을 두 번 보낼 수 있다.
  · ⚠ 정직 기록: 실제 사내 메일 서버로는 보내 보지 못했다(가짜 SMTP). Chromium 은 목업(메일 꺼짐 상태)으로 설정 창·대상 화면 1440/400 을 봤다(넘침 0).
- ⚠⚠ **v2.742 — 아이실론 종합 메일(정한 요일·시각에 전 법인 결과 한 통). 규칙은 `isidu/digestRules.js`(순수), 발송·일정·기록은 `isidu/digest.js`, 본문은 `isidu/mailHtml.js` 하나**
  (사용자 요청 + Claude Design 시안 ① 본문 · ② 설정 · ③④ 대상별 결과·실패 메일 새 템플릿 승인. 선택: v2.742 에 함께 · 전체 검증 · 시안 그대로.
  회귀 `server/test/isiduDigest2742.test.js`(가짜 SMTP · 실제 api 라우터 · 틱·재시작·놓침 — 변이 12종 중 11종, 남은 1종은 개요 조회 대상 필터 = 결과가 같은 동등 변이) +
  웹 `isiduDigestText.test.js`(서버 모듈과 같은 입력 대조)):
  · **중앙만 보낸다** — 엣지는 틱도 돌지 않는다(`digestTick`·`sendDigest` 가 'edge'). 장비에 접속하지 않고 DB 의 마지막 성공 조사로 만든다(조사를 새로 돌리지 않는다).
    목록 행은 메인 목록 응답과 **같은** `isidu/rows.js targetRows`(라우트에서 옮겼다 — 두 벌이면 화면과 메일의 상태가 갈라진다), 법인 이름은 `isidu/corpName.js`.
  · 일정은 `xferspeed/schedule.js` 의 매주 일정 계산을 그대로 쓴다(포탈 시각 KST). '지금 이전의 가장 최근 회차' 하나만 본다 — 처리 기록(lastSlot)·since 보다 뒤이고
    30분(`GRACE_MS`) 안이면 보내고, 넘으면 **몰아서 보내지 않고** 놓침(down 포탈 꺼짐 · late · clock 시계 되감김 → 기록을 지금으로)으로 남긴다.
    ⚠⚠ **lastSlot 은 보내기 전에 상태 파일에 남긴다** — 보내는 중 재시작해도 같은 회차를 두 번 보내지 않는다(대신 그 회차는 못 보냈을 수 있다 — 정직 기록).
    `since` 는 서버가 정한다(켜거나 요일·시각을 바꾼 시각) — 저장하자마자 오늘 지난 회차를 소급 발송하지 않는다.
  · 받는 사람 = 통합 관리자(메일 설정 `defaultTo`, includeAdmin) ∪ 추가 주소, 대소문자 무시 한 번. 발송은 `sendPortalMail({kind:'isidu', to, by})` — 정기는 'system',
    '지금 한 번 보내기' 는 사람 이름(수동 — SMTP 인증 정지 중에도 시도)이고 '새 조사 없으면 생략' 을 보지 않으며 회차 기록을 건드리지 않는다.
  · 본문 모델(`buildDigestModel`): 대상 상태는 웹 `isiduText.targetStatus` 와 **같은 key·tone**(`statusOfRow` — 웹 테스트가 16개 입력으로 대조) · 합계는 성공한 수집이 있는 대상만 ·
    7일 변화는 7일 이전 기준이 있는 대상만, 반올림 범위 안은 0 · 실패·보고 늦음은 '직전 성공 값' 표지 · 데모(mock-)는 실제 메일에서 빼고 미리보기에만 넣는다.
    실패 종류 제목(`FAIL_TITLE`)은 웹 `FAIL_TEXT[].title` 과 같은 글자 — **실패 종류를 늘리면 둘 다**. 생략·놓침 코드(`DIGEST_SKIP_CODES`·`DIGEST_MISSED_REASONS`)는 웹
    `isiduDigestText.SKIP_TEXT`·`MISSED_TEXT` 와 1:1(웹 테스트가 서버 소스의 code 리터럴까지 대조).
  · 설정은 `isidu-settings.json` 의 `mail.digest` 이고 **전용 저장**(`saveDigestSettings` · `PUT /tools/isilon-dirusage/digest`)이다 — 대상 목록 저장(`saveSettings`)은 그 값을
    그대로 옮기고, 종합 메일 저장은 대상 목록을 건드리지 않는다(서로 지우지 않는다 — 테스트 고정). 설정 파일을 못 읽으면 저장 409. 형식 오류는 400(field digest.days·time·topN·to).
  · 라우트 4개(GET·PUT digest · POST send-now(실패 409 — 재시도로 두 번 보내지 않게) · POST preview(보내지 않음))는 adminOnly + fullScopeOnly + **requireSuperAdmin**(수집 대상 설정과 같은 기준).
    조회 응답의 `adminTo` 는 화면이 저장 전 입력으로 받는 사람 수(겹침 포함)를 세는 데 쓴다 — **상태(status)·기록·상태 파일에는 주소를 싣지 않는다**(개수만, 테스트 고정).
  · 상태 파일 `isidu-digest-state.json`(registerStateFile · 원자 0600 · 손상 보존 · 기록 20건). `startIsiduDigest` 30초 틱(index.js). edgeSweep `EXCLUDED` 에 '중앙 전용' 사유.
  · 화면: 설정 › 수집 서버 › 아이실론 디렉터리 사용량 › **종합 메일** 탭(`#/settings/isilon-dirusage/digest` · `IsiduDigestSettings.jsx` · 판정·문구 `isiduDigestText.js`). 탭을 처음 열 때
    만들고 오가도 유지한다(저장하지 않은 입력이 탭 전환으로 사라지지 않게). '지금 한 번 보내기' 는 바뀐 칸이 있으면 잠근다(저장된 설정으로 보낸다). 미리보기는 `sandbox` iframe(srcDoc).
  · 메일 HTML 은 표 레이아웃 · 인라인 스타일 · 모든 값 이스케이프(`mailHtml.esc`) · 포탈 링크 없음(주소 설정이 없다 — 메뉴 경로를 글로 적는다). **메뉴 이름을 바꾸면 본문 안내도**(웹 테스트가 '› 종합 메일' 을 대조).
    ⚠ 카드 묶음은 `font-size:0;line-height:0` 래퍼 안의 inline-block 이다 — **안쪽 카드가 글자 크기·줄 높이를 되돌리지 않으면 라벨과 값이 겹친다**(Chromium 판독에서 발견).
    좁은 폭은 `<style>` @media(520px 이하 여백 축소 — Outlook 데스크톱은 무시한다)로 400·360px 넘침 0. 테스트 ⑤ 가 두 규칙을 고정한다(변이 2/2).
  · ⚠ 정직 기록: 실제 사내 메일 서버·Outlook 등 메일 클라이언트에서의 모양은 확인하지 못했다(가짜 SMTP · Chromium 미리보기).
- ⚠⚠ **v2.745 — 아이실론 대상별 결과 메일 '보내는 때'(조사마다 | 정한 요일·시각) + 종합 메일 Top N/M 개수. 일정 규칙은 `isidu/mailRules.js`(대상)·`digestRules.js`(종합) 순수, 정기 발송은 `isidu/notify.js targetMailTick`**
  (사용자 요청 + 선택: 대상마다 각각 · '새 조사 없으면 보내지 않기' 대상별 선택(기본 켬) · 종합 메일 전 법인 Top N 1~50 · 법인별 Top M 0~20 · 열 '사용자(폴더)' ·
  같은 이름 폴더는 대상별로 따로 셈 · 전체 검증. 회귀 `server/test/isiduSchedMail2745`·`isiduSchedReview2745`·`isiduDigestTop2745`·`isiduTopReview2745`·`isiduLead2745` +
  웹 `views/tools/isiduSchedMail2745`·`isiduDigestTop2745`·`isiduMailReview2745`·`isiduLead2745` — 그룹별 변이 검증):
  · 대상 메일 저장 모양 `{…기존, when:'scan'|'schedule', days, time, skipIfNoNew(기본 true), since}` — **옛 저장값(필드 없음) = scan**(업그레이드만으로 메일이 바뀌지 않는다).
    since 는 서버가 정한다(schedule 로 바꾸거나 요일·시각을 바꾼 시각 — 소급 발송 금지). 요청에 빠진 필드는 **이전 값 유지**(⚠ 동작 변화 — 예전에는 기본값으로 덮었다).
    요일·시각 판정은 `xferspeed/schedule.js` 를 그대로 쓰고 종합 메일 판정과 같은 결과다(테스트 대조 — digestRules 를 import 하면 순환이라 사본 정규식을 두지 않았다).
  · 정기 발송: 30초 틱(`startIsiduTargetMail` — ⚠ 시작 줄은 테스트가 부르지 않는다) · 지금 이전 가장 최근 회차 하나만 · 30분 넘게 늦거나 포탈이 꺼져 있던 회차는
    몰아서 보내지 않고 `missed-late`·`missed-down` · 서버 시계가 since 보다 앞서 있으면(미래 since) 설정 파일을 고치지 않고 기록에 `sinceFrom`·`sinceCap` 을 남겨 지금으로 잡고
    막힌 회차는 `missed-clock`. 코드 `TARGET_MAIL_CODES` ↔ 웹 `TARGET_MAIL_CODE_TEXT` 1:1(웹 테스트가 서버 소스와 대조 — 코드를 늘리면 둘 다).
  · ⚠⚠ **'변화 없으면 생략' 의 기준은 마지막으로 실제 보낸 정기 발송 조사다**(검토 SCHED-01) — 직전 조사와 비교하면 조사마다 반올림 해상도보다 조금씩 자라는 폴더가
    영원히 '변화 없음' 이었다(재현 8회차 0통). 보낸 기록이 없거나 그 조사가 DB 에 없으면 비교 없이 보낸다.
  · 받는 사람 0명 대상은 회차를 판정하되 메일 기록(last)·경고 없이 `lastSlot` 만 넘긴다(SCHED-02 — 판정하지 않으면 수신자를 넣는 순간 '놓침 N번' 이 한꺼번에 찍혔다).
    화면 미리보기도 0명이면 '다음 발송: —'(서버 rows 의 next 와 같다). 정기 발송 대상의 **늦게 온 옛 결과(성공·실패)는 마지막 기록을 덮지 않는다**(SCHED-05·F4).
  · 조사 실패 알림은 정한 시각과 무관하게 조사 직후(onFailure) · '지금 보내기' 메일 바닥글은 그 대상의 보내는 때를 말한다(F3 — `buildResultMail(…, {manual:true})`).
  · 포탈 시각 오프셋: 메인 목록·설정 조회 응답이 `offsetMin`(= `DAY_OFFSET_MIN`)을 싣고 화면이 그것으로 다음 발송·회차를 그린다. 540 이 아니면 '한국 시각' 이라 적지 않는다
    (`isiduText.portalTimeLabel`). 종합 메일 설정 화면의 'KST' 표지는 아직 고정이다(v2.742 부터 — 남은 일).
  · 종합 메일 순위: `DIGEST_RANGES`(topN 1~50 · corpTopM 0~20 — **옛 파일 corpTopM 없음 = 0**, 범위 밖은 자르지 않고 400) · 순위 후보는 대상별 상위 `digestPoolOf` = max(N, M, 10)개의
    합집합(k ≥ max(N, M) 일 때만 정확하다는 산수가 근거). 법인 안 비중의 분모는 max(법인 사용량, 그 법인 대상들의 폴더 크기 합, 읽은 상위 M 합)이고 올렸으면
    `shareDenomRaised` + 각주(TOPNM-02 — du -h 반올림으로 100% 를 넘었다). 폴더 목록을 못 읽은 대상이 있는 법인은 'N개라' 단정하지 않는다(TOPNM-04).
  · ⚠ **동작 변화(TOPNM-03)**: '직전 성공 값' 표지가 더 많이 붙는다 — 표시 상태(statusOfRow, 웹 targetStatus 와 대조)는 그대로 두고 `lastValueWhyOf` 가 상태 key ·
    직전 시도 실패(`failed-before`) · 값 신선도(`old` — 보고 늦음과 같은 경계 `valueStaleMsOf`)를 본다. 꺼짐·조사 중·요청 대기 대상의 몇 달 전 값이 표지 없이 순위에 실리던 것.
  · 설정 탭은 대상 목록을 종합 메일 탭에도 넘긴다(TOPNM-01 — 넘기지 않아 '메일에 싣는 사용자 행' 수와 120줄 경고가 늘 꺼져 있었다). 감사 로그에 corpTopM, 조회 응답에 `ranges`.
  · ⚠ 정직 기록: 실제 사내 메일 서버·Outlook 렌더·실제 OneFS 출력·`PORTAL_TZ_OFFSET_MIN≠540` 현장은 확인하지 못했다(가짜 SMTP·주입한 now·합성 입력).
- ⚠⚠ **v2.739 — 아이실론 디렉터리 사용량 서브메뉴 4개(v2.740 에 서머리를 지워 지금은 3개 — 옛 summary 주소는 법인 현황으로 열린다) · 수집 대상 일괄 변경 · 시한 기본 2시간/최대 3시간**
  (사용자 요청 "법인 상황이 세로로 나와서 불편 · 서브 메뉴 — 서머리 · 법인 현황 · 수집 상태 · 모든 법인 사용량 Top 10"(승인된 Claude Design 시안) ·
  "스캔 대기 시간 기본 2시간" · "설정에서 바꿀 수 있는 모든 기능을 등록된 아이템에서 일괄로(일괄 수집·일괄 대기 시간 …)" · "대기 시간 최대 3시간".
  서버 `isidu/bulk.js`·`report.js overviewOf/buildOverview`·`db.js topEntriesOf` + `GET /tools/isilon-dirusage/overview`·`POST /tools/isilon-dirusage/bulk` +
  웹 `IsiduViews.jsx`·`IsiduBulk.jsx`·`isiduOverviewText.js`·`isiduBulkText.js`. 회귀 `server/test/isiduOverview2739.test.js`(변이 9/9) + 웹 `isiduOverview2739.test.js`(변이 8/8)):
  · 주소 `#/tools/isilon-dirusage/<summary|corps|status|top10>` · 대상 화면은 `t/<id>` 그대로. 판정은 `isiduText.targetStatus` 하나(서브메뉴가 다시 판정하지 않는다).
  · 개요 응답은 대상마다 최신 성공 스캔 · 7일 전 기준 · 30일 점 · 상위 10(`OVERVIEW_POOL`)이다. **전 법인 Top 10 은 대상별 상위 10 의 합집합**에서 고른다(고른 법인들의
    상위 10 은 언제나 그 안에 있다). 순서는 `parse.sortBySize` 와 같고 `topEntriesOf` 는 컷 크기와 같은 행을 전부 읽는다(동률 순서가 DB 순서에 기대지 않게).
    대상마다 수집 시각이 다르다는 사실을 화면이 말한다.
  · ⚠ **7일 변화 합은 -h 해상도 판정을 따른다** — 대상의 `totalDelta7.withinRes` 가 참이면 합계에서 0 으로 센다(카드는 '변화 없음' 인데 서머리가 반올림 한 칸 −102 GB 를
    변화로 말하던 것을 Chromium 판독에서 잡았다). 전부 해상도 안이면 합도 '변화 없음'. 7일 전 기준이 없는 대상은 더하지 않는다.
  · 일괄 변경: 판정은 서버(`applyBulk` — 대상마다 저장값 위에 바꿀 항목만 얹고 **`normalizeTarget` 그대로**). 화면은 미리보기(dryRun) → 확인 → 저장. 판(rev = targets JSON sha1 앞 16자)이
    다르면 409 `rev-changed`. 대상에 맞지 않는 항목은 그 대상에서만 빼고 사유 코드(`NOT_APPLIED_CODES` ↔ 웹 `NOT_APPLIED_TEXT`, 테스트 대조), 정규화가 거절한 대상은 바꾸지 않는다(skipped).
    **범위 밖 숫자는 400(자르지 않는다)** · 빈 값 = '그대로' · 바뀐 것이 없으면 저장하지 않는다. 항목 키는 서버 `BULK_KEYS` ↔ 웹 `BULK_FIELD_KEYS`(테스트 대조) — **설정 항목을 늘리면 둘 다**.
    일괄 수집은 `/run` ids, 연결 시험·메일은 **차례로 하나씩**(동시 접속·재시도 없음). 개별 편집 창에 저장 안 한 변경이 있으면 일괄 탭이 막는다(덮어쓰지 않게).
  · 시한: `RANGES.timeoutMin` 1~180 · 기본 120. 3시간은 **du 경로만** 쓰는 `deadlineMs/withDeadline(…, {long:true})`(`DEADLINE_LONG_MAX_MS`) — 다른 호출부의 2시간 상한은 그대로다.
    옛 기본값 이전: 파일에 표지(`timeoutDefaultMin`)가 없을 때 **정확히 30분인 대상만** 120분으로(한 번). 저장할 때마다 표지를 쓰므로 그 뒤 사람이 고른 30분은 다시 옮기지 않는다.
  · ⚠ 정직 기록: Chromium 은 목업(데모 대상 3개 · 전부 정상)으로 네 페이지·대상 화면·일괄 변경(미리보기→저장)을 1440/400 에서 봤다. 실패·진행 중 대상이 섞인 화면과
    엣지 담당 대상의 일괄 변경은 단위 테스트로만 확인했다. 실제 아이실론에서 3시간 du 는 돌려 보지 못했다.
- ⚠⚠ **v2.740 — 아이실론: 서머리 삭제(탭 = 법인 현황 → 전 법인 Top 10 → 수집 상태) · 수집 대상 설정은 설정 › 수집 서버 › 아이실론 디렉터리 사용량(슈퍼 관리자 전용)**
  (사용자 요청. 웹 `isiduSettingsLink.js`(주소·안내 문구 한 벌)·`IsiduSettingsPage.jsx`(IsiduSettings 를 `page` 로) · `Settings.jsx superOnly`+`visibleSubs` · 서버 `auth/roles.js requireSuperAdmin`.
  회귀 `server/test/isiduSuper2740.test.js`(실제 api 라우터·인증 켬) + 웹 `isiduSettingsMove2740.test.js`):
  · 메뉴 숨김은 표시 게이팅이다 — **서버 설정 API 6경로(settings GET/PUT·bulk·test·mail-now·key)가 `requireSuperAdmin`** 이고 결과 화면·`/run`·보고서·CSV 는 관리자 그대로.
    거부는 403 `super-admin-only` + `requiredRole: ['super_admin']`(**배열** — api.js HttpError 가 배열만 읽어 권한 안내를 만든다). 판정은 roles.js 하나(userMenu 사본은 지웠다).
  · 인증을 끈 목 서버의 익명 사용자는 슈퍼 관리자가 아니다 — 아이실론 설정이 필요한 실제 프로세스 테스트는 settings 모듈로 미리 써 둔다(`scanRestart2737`).
  · 같은 릴리스의 점검(6축 → 6그룹)은 `docs/AUDIT-2026-10-15.md`. 동작 변화: 전송 속도 설정 범위 밖 숫자 400 · 키 파일 형식 오류만 있으면 서명 필수 · 전체 소비 전력 `network.noTime` 제거(`staleBy`).

