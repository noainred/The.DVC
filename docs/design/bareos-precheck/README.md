# 설계: Bareos 사전 점검 — ① FD→vCenter:443 매일 점검 · ② SD 디스크 여유 감시

작성 2026-11-05 (v2.885.0 기준) · 상태 **컨펌됨 2026-11-05 03:40(§8 결정 4가지) — 구현 대기(Opus)** · 시안 캔버스: https://claude.ai/artifact/Fg5jv3iqTwtVnh5YR8hDsp
(아트보드 6장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 법인명 · 주소(192.0.2.x 문서용 대역) · 수치는 가상이고 색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로.
계정의 'Design System' 아티팩트는 파일이 하나도 없어(빈 시스템) 쓰지 않았다.)

## 1. 요구 (사용자 2026-11-04 '백업 개선하면 좋은점 찾아줘' → '3, 1, 2 순서로 진행해줘' · '①② 시안 먼저')

- ① **FD → vCenter:443 연결을 매일 점검** — v2.877 사용자 로그(JobId 32)의 원인(FD 가 vcserver:443 에 접속 못 함)을 백업 **전에** 안다.
- ② **SD 저장소 디스크 여유 감시** — 지금은 법인별 설정 화면을 열 때만 SSH 로 읽는다(`manage/apply.js` @@disk). 가득 차서 'No space left on device' 로 실패한 뒤에야 보인다.
- 검증 수준 표준(관련 시험 + 엣지 계약 · 알림 변이 + 반증 1인 + 전량 verify + Chromium 1440/400 1회).

## 2. 지금 있는 것(코드 근거) — 새로 만들지 않아도 되는 부분

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| Director 작업 표 + 엣지 대행 — `onDirector(dirId, kind, args, { trigger:'timer', signal })` · 담당 엣지면 큐로(`relayToEdge`) · 회신 정제 `edgeResult.js` 화이트리스트 · `RESULT_MS` 시한 | `bareos/service.js:192` · `edgeOps.js:35` · `edgeResult.js` | 새 작업 종류 `health` 를 같은 자리에 등재(읽기 전용 · 비밀 없음). 엣지는 `runLocalOp` 로 자기 사본의 Director 세션을 연 채 실행(`service.js:180`) |
| 인증 정지 — `trigger:'timer'` 면 정지된 Director 에 닿지 않는다(직접 `sessionOn:114` · 대행 `relayToEdge:164`) | `bareos/service.js` | 점검은 timer — 자동 재시도 금지 규칙 그대로 |
| FD 에서 vCenter 인증서 지문 읽기(SSH · openssl) — 설치 · 설정 화면 단추로만 | `autoSetup.js readFdThumbprint:558` | 주기 점검에는 쓰지 않는다(root SSH 를 매일 열지 않음) — 엣지 프로세스가 TLS 로 직접 지문을 읽는다 |
| 사이트 매핑 `sites[].vcserver`(FD 가 붙는 vCenter 주소) | `bareos/settings.js:11` | 점검 대상 주소. 매핑이 없는 법인은 점검 항목 '모름' |
| 완전 설치 기록 `plan.volumeDir`(`lastJobFor(vcenterId)`) · 법인별 설정 스캔 Archive Device(`manage/apply.js:185` disks) | `install/job.js:83` · `manage/service.js readConfig` | 볼륨 경로 출처(① 설치 기록 → ② 스캔 기억값 → ③ 기본 `/var/lib/bareos/storage`) |
| 하루 한 번 중앙 스케줄러 모양(정한 시각 · 상태 파일 · `_busy` · 첫 폴러 대기) | `bareos/digest.js` | `health.js` 가 같은 모양(설정 `bareos-health.json` · 상태 `bareos-health-state.json`) |
| 메일 종류 카탈로그 · 일일 요약 본문 | `mail/kinds.js` · `bareos/digest.js renderDigest` | 종류 `bareos-precheck` 한 줄 · 요약에 '사전 점검' 절 |
| 설정 › 공통 기본값 · 수집 아코디언(일일 요약 메일 행 `BareosDigestSettings`) | `web/.../BareosSettings.jsx:4` · `BareosRehearsal.jsx:196` | 같은 자리에 '사전 점검' 행 |
| 현황 법인별 표 · 법인 화면 머리 카드(스냅샷 남음 칩) | `BareosSummaryTool.jsx:143` · `BareosDetailTool.jsx:139` | 표에 열 2개('사전 점검' · 'SD 디스크 여유') · 경고 띠 · 법인 화면에 '사전 점검' 카드 |
| 판정 모양(정상 · 경고 · 불가 · 모름 — 못 읽음은 0 이 아니다) | `install/precheck.js judgePrecheck` · `drPlan.js drCheckView` | 같은 4단계 · 같은 배지 글자 |
| Node 22(`fs.statfs` · `tls.connect`) | 번들 Node | SSH 없이 엣지 프로세스가 디스크 · TLS 를 읽는다 |

## 3. 어디서 무엇을 보나 (시안 ⑤ Flow)

```
중앙 스케줄러(매일 20:00 · '지금 점검')
 └ 법인(Director)마다 작업 'health' 한 건 — trigger timer · 인증 정지면 건너뜀 · 시한 90초
    ├ 담당 엣지 있음 → 엣지 대행 큐 → 엣지 노드 안(= 포탈 설치 Bareos 의 FD 서버)에서
    │    ① Director 콘솔 version   ② TLS 접속 vcserver:443 + SHA1 지문   ③ statfs(볼륨 경로)   — SSH 없음 · 읽기만
    └ 담당 엣지 없음 → 중앙 포탈에서  ① 콘솔  ② vcserver:443 — 'FD 시점 아님(참고)'  ③ 디스크 모름
 → 회신 정제(아는 칸만 · 상한) → 상태 파일 bareos-health.json(법인별 최근 결과 · 이력 7회 · 디스크 일별 표본 30일 · 지문 기준값)
 → 화면(현황 표 열 · 경고 띠 · 법인 카드) · 메일(나빠질 때 1통 · 회복 1통 · 일일 요약 절)
```

- **SSH 를 쓰지 않는 까닭**: 저장된 SSH 계정은 Director 가 그 엣지 노드에 있을 때만 쓸 수 있고(`manage/service.js sshSourceFor` — F1), 그 경우 엣지 프로세스가 같은 서버에 있어 SSH 없이 같은 것을 읽는다. 다른 서버의 Bareos 는 매번 비밀번호 입력이라 주기 작업이 될 수 없다.
- **엣지 시점 = FD 시점** 은 포탈 완전 설치(FD 가 엣지 노드 안) 전제다. 사람이 FD 를 다른 서버에 둔 설치는 엣지 시점이 FD 시점과 다를 수 있다 — 화면은 '엣지 노드에서 본 것' 이라고 적는다(§9).

## 4. 판정 규칙(서버 하나 — `bareos/health.js judgeHealth(result, policy, prev)`)

| 항목 | 어떻게 | 정상 | 경고 | 불가 | 모름 |
|---|---|---|---|---|---|
| vCenter 접속 | 엣지에서 `tls.connect(vcserver, 443, { rejectUnauthorized:false })` 시한 10초 — 이름 풀이 · TCP · TLS 핸드셰이크 | 접속됨 | — | ECONNREFUSED · ETIMEDOUT · EHOSTUNREACH · ENOTFOUND(각각 다른 조치 문구) | 중앙 직접(결과는 '참고' 로 보이되 판정에는 넣지 않음) · 매핑 vcserver 없음 |
| 인증서 지문 | 접속한 인증서 SHA1 · 상태 파일의 기준값과 비교 | 같음 · 첫 관측(기준으로 기록) | 바뀜(기준값 · 관측 시각 둘 다 표시) | — | 접속 실패 |
| Director 콘솔 | 세션 열기 + `version`(폴러와 같은 접속값) | 응답 | — | 접속 · 인증 실패(인증 실패는 기존 정지 기록 경로) | 인증 정지 중(보내지 않음) |
| SD 디스크 여유 | `fs.statfs(path)` — path 는 §2 의 출처 순 · 경로마다 | 기준 밖 | 여유 ≤ 15% 또는 가득 찰 때까지 ≤ 14일 | 여유 ≤ 5% 또는 ≤ 3일 | 중앙 직접 · 경로 모름 · 경로 없음(ENOENT) · statfs 실패 |

- 법인 판정 = 항목 중 가장 나쁜 것(불가 > 경고 > 정상), 단 **모름은 수에 넣지 않는다**(법인에 모름 항목이 있으면 '정상' 대신 '정상(일부 모름)').
- '가득 찰 때까지 n일' = 최근 7일 일별 표본(used bytes)의 선형 기울기. 표본 3개 미만 · 기울기 ≤ 0 이면 '—' 이고 기준에 쓰지 않는다(여유 % 만).
- 지문 기준값은 **포탈이 처음 본 값**이다(FD INI 의 `vcthumbprint` 는 0600 bareos 소유라 읽지 않는다). 설정 › 법인별 설정 › FD INI 에서 지문을 새로 쓰면 기준값도 그 값으로 바꾼다.
- '정상' 은 백업 성공을 보장하지 않는다(vCenter 계정 · 권한 · 스냅샷 · 플러그인 오류는 보지 않는다) — 모든 화면 · 메일 문구에 붙인다.

## 5. 서버에 더하는 것

- `bareos/ops.js health(s, { vcserver, volumeDirs, knownThumbprint }, { signal })` — ① `version` ② `tls.connect` + 지문 ③ `statfs` · 결과 `{ dir:{ok,version,ms}, vc:{ok,code,ms,thumbprint,resolved}, disks:[{path,availBytes,sizeBytes,usedBytes,fsType,code}], from:'edge'|'central', at }`. 읽기 전용(`MUTATING` 아님). 엣지 대행이면 `from:'edge'`.
- `edgeOps.js RESULT_MS.health: 90_000` · `edgeResult.js health` 정제(숫자 · 코드 문자열 화이트리스트 · 지문 `^[0-9A-F:]{59}$`) · `edgelog/spec.js` 등재.
- `bareos/health.js` — 설정 `bareos-health.json`(`enabled` 기본 **켬** · `time` 기본 20:00 · `disk:{warnPct:15,warnDays:14,badPct:5,badDays:3}` · `mail:{onWorse:true,onRecover:true,inDigest:true}`) · 상태 `bareos-health-state.json`(법인별 `last` · `history[7]` · `samples[30]` · `thumbprint`) · 틱(1분 · 정한 시각 하루 한 번 · 기동 뒤 첫 폴러 대기 `FIRST_POLL_WAIT_MS` 재사용) · `runAll()` / `runOne(dirId)` · 회신 때 반영(엣지는 기다리지 않음 — poll 과 같은 모양) · **메일은 판정이 나빠진 법인만**(prev 대비 전이: 정상→경고/불가 · 경고→불가 · 모름→불가) · 회복(불가/경고→정상) 1통 · 보내지 못하면 다음 틱 재시도(커서는 상태 파일 `notified`).
- 라우트(`routes/api/bareosBackup.js`): `GET /tools/bareos-backup/health`(관리자 · 범위 계정은 자기 법인만 · 데모는 `readDirector demoOnly` 와 같은 규칙으로 합성) · `POST /health/run`(`{ directorId? }` — 전체는 전체 범위 관리자 · 한 법인은 그 법인 쓰기 범위 · 동시 1건) · `GET/PUT /health/settings`(관리자 + `fullScopeOnly` + `fullWriteOnly` — 일일 요약 설정과 같은 문지기).
- `mail/kinds.js` `bareos-precheck` · `digest.js` 에 '사전 점검' 절(상태 파일만 읽는다 — Director 에 묻지 않음).
- 데모(`bareos/demo`): 법인 6곳 합성(불가 1 · 위험 1 · 경고 1 · 정상 2 · 모름 1 — Chromium 으로 모든 배지를 본다).

## 6. 화면(웹)

- 현황(`BareosSummaryTool.jsx`): 경고 띠(불가 법인이 있을 때만 — 법인 · 항목 · 다음 백업 · 법인 화면 링크) · KPI 4번째 '확인 필요' 옆이 아니라 **4번째 칸을 '사전 점검' 으로 바꾸지 않고** 띠 + 표 열로(시안 ① 은 KPI 4번째를 '사전 점검' 으로 그렸다 — §8 결정) · 표에 '사전 점검' · 'SD 디스크 여유' 열 · 필터 칩 '점검 경고 N'. 1440 에서 열 9개가 `overflow-x:auto` 박스에 들어가는지 구현 때 Chromium 으로 확인.
- 법인(`BareosDetailTool.jsx`): 머리 카드 아래 '사전 점검' 카드 — 항목 4행(결과 배지 · 상세 · 조치) · 백업 예측 띠 · 디스크 추이(14일 스파크라인) · 최근 7회 · '지금 점검'(해당 법인만) · 중앙 직접이면 '참고 · 모름' 문구.
- 설정(`BareosSettings.jsx` defaults): '사전 점검' 아코디언 행 — 켬 · 시각 · 디스크 기준 4칸 · 알림 3칸 · 저장 · '지금 전 법인 점검' · 마지막 실행 요약 · 항목 설명표.
- 400px: 표 대신 법인 카드(시안 ⑥) — `BareosSummaryTool` 의 좁은 폭 처리 방식을 따른다(구현 때 확인).
- 문구 헬퍼 `bareosHealthText.js`(배지 · 조치 문구 · 'n일' · 'FD 시점 아님') — 서버 `health.js` 와 같은 입력으로 시험이 대조.

## 7. 구현 계획과 추정 (컨펌 뒤 · Opus)

| 단계 | 내용 | 예상 |
|---|---|---|
| 1 | `ops.health` · `edgeOps` · `edgeResult` · `edgelog/spec` · 엣지 워커 통과 확인 | 40분 |
| 2 | `health.js`(설정 · 상태 · 판정 · 스케줄 · 메일 전이) · 라우트 · 데모 | 60분 |
| 3 | 웹 3화면 + 문구 헬퍼 | 60분 |
| 4 | 시험(판정 · 전이 · 엣지 정제 · 라우트 범위) · 변이(엣지 계약 · 메일 전이 · 범위) · 반증 1인 | 50분 |
| 5 | verify · Chromium 1440/400 · PR · CI · 머지 · 릴리스 | 45분(Sonnet) |

합계 약 4시간 15분(대기 포함). 버전 v2.890.0(v2.886~889 는 다른 세션이 먼저 게시).

## 8. 사용자 결정 — 2026-11-05 03:40 KST 답변(구현은 이대로)

1. 점검 시각 **20:00(포탈 시각) · 기본 켬** — 업그레이드 뒤 바로 전 법인에서 돈다(읽기만 · 10초 시한).
2. 디스크 기준 **경고 15% / 14일 · 위험 5% / 3일**(설정에서 바꿀 수 있음).
3. 메일 **나빠질 때 1통 + 회복 1통 + 일일 요약 절** — 메일 종류 'Bareos 사전 점검' 신설.
4. 현황 KPI 4번째 칸은 **'확인 필요' 그대로** 두고 경고 띠 + 표 열('사전 점검' · 'SD 디스크 여유')만 더한다 — 시안 ① 의 '사전 점검' KPI 칸은 구현하지 않는다.

(질문 원문)

1. **점검 시각** — 기본 20:00(포탈 시각)으로 할까요? 완전 설치 기본 백업 창(02:00)보다 6시간 앞입니다. 법인 그룹 스케줄이 더 이른 곳이 있으면 그 전으로 옮겨야 합니다.
2. **디스크 기준** — 경고 15% / 14일 · 위험 5% / 3일 을 기본값으로 할까요?
3. **메일** — 나빠질 때 1통 + 회복 1통 + 일일 요약 절(시안대로)로 할까요, 아니면 일일 요약 절만으로 할까요?
4. **현황 KPI 4번째 칸** — 시안은 '확인 필요' 칸을 '사전 점검' 칸으로 바꿔 그렸습니다. 기존 '확인 필요' 를 남기고 띠 + 표 열만 더할 수도 있습니다(열을 바꾸지 않는 쪽이 회귀 위험이 작습니다).
5. **기본 켬** — 업그레이드만으로 28개 법인 엣지가 매일 20:00 에 vCenter:443 접속 · statfs 를 합니다(읽기만 · 10초 시한). 기본 켬으로 할까요?

## 9. 남긴 것(정직 기록 — 시안 단계)

- FD 가 엣지 노드가 아닌 설치(사람이 다른 서버에 FD 를 둔 경우)는 '엣지 노드에서 본 것' 이 FD 시점과 다르다 — 화면 문구로만 알린다. FD 호스트를 따로 적는 칸은 두지 않았다.
- 인증서 지문이 바뀌었을 때 플러그인이 실제로 내는 오류 문구는 **실환경 미확인**(추정) — 메일 조치 문구에 '추정' 을 적었다.
- 'n일' 추정은 선형이다 — Full 주기(35일)에 따라 사용량이 계단으로 오르면 과소 · 과대가 생긴다. 표본 7일로 평균 내지만 한계를 문구로 둔다.
- Veeam 은 범위 밖(Bareos 만).
- 데모 Director 의 vCenter 접속 · 디스크는 합성값이다(장비에 닿지 않는다).
