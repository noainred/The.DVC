---
name: actions-cost
description: GitHub Actions 사용량·비용 점검 — 워크플로 실행을 이벤트·브랜치별로 전수 집계하고 잡 단위 실측 시간을 OS 배수·단가로 환산해 '어디서 분이 새는가'를 짚는다. "Actions 비용", "CI 비용", "러너 분", "청구서가 왜 이렇게", "빌드 시간 줄여줘" 요청에 사용. 읽기 전용(워크플로를 고치지는 않는다).
---

# GitHub Actions 사용량·비용 점검

## ⚠⚠ 먼저 — `Gross` 와 `Billed` 를 구분한다

**이것을 틀리면 나머지 분석이 전부 무의미하다.** GitHub 청구 화면(Settings → Billing → Metered usage)
의 큰 숫자는 대개 **`Gross amount`**(과금된다면 얼마인가)이고, **공개 저장소는 표준 러너가 전부 무료**라
그 옆의 **`Billed amount` 가 `$0`** 이다(macOS 포함).

2026-09-18 이 저장소 실측 — Gross **$47.17**, Billed **$0**. 사용자가 "$47 나온다"고 신고한 것이
실제로는 0원이었다. **`Billed` 열을 보지 않고 "비용이 나온다"고 말하지 말 것.**

API 로 단건 확인:
```
GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing
→ {"billable":{"UBUNTU":{"total_ms":0},"MACOS":{"total_ms":0}}, "run_duration_ms":368000}
```
`total_ms: 0` 이면 그 실행은 과금 대상이 아니다.

저장소 공개 여부도 함께 확인한다(`"private": false` / `"visibility": "public"`).

## 절차

### 1. 실행 수를 **전수 집계**한다 (추정 금지)

⚠⚠ **`server/src/release-notes.json` 항목 수나 커밋 수로 릴리스 빈도를 추정하지 말 것.**
2026-09-18 에 그렇게 했다가 **월 사용량을 3.2배 과소평가**했다(추정 4,080분 vs 실측 12,885분).
원인은 둘 — 릴리스 빈도를 120/월로 봤는데 실제 275/월, ci 를 '릴리스당 3회'로 봤는데 실제 3.9회.

```bash
python3 - <<'EOF'
import json,urllib.request,collections
def g(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'x'})))
base="https://api.github.com/repos/<owner>/<repo>/actions"
for wf in ['ci.yml','release.yml']:
    ev=collections.Counter(); n=0; page=1
    while page<=10:
        d=g(f"{base}/workflows/{wf}/runs?created=%3E%3D2026-09-01&per_page=100&page={page}")
        runs=d.get('workflow_runs',[])
        if not runs: break
        for r in runs: ev[r['event']]+=1; n+=1
        if len(runs)<100: break
        page+=1
    print(wf, n, dict(ev))
EOF
```
push 는 **브랜치까지 갈라서** 센다(`?event=push` + `head_branch=='main'` 비교) — '기능 브랜치 push
중복'이 흔한 낭비이고, 그 규모를 알아야 조치를 정할 수 있다.

### 2. 잡·스텝 단위 실측 시간을 뽑는다

```
GET /repos/{o}/{r}/actions/runs/{run_id}/jobs
→ jobs[].labels(러너 OS) · started_at/completed_at · steps[].started_at/completed_at
```
스텝 시간을 보면 **어느 스텝이 잡을 먹는지**가 바로 나온다(이 저장소는 `서버 단위테스트`가
잡 189초 중 141초 = 75%).

### 3. 환산 — ⚠ 배수와 단가를 **이중 적용하지 말 것**

두 계산은 **목적이 다르고 섞으면 10배 틀린다.**

| 무엇을 알고 싶은가 | 계산 |
|---|---|
| **포함 분(Free 2,000 / Team 3,000) 소진** | raw 분 × **OS 배수**(Linux ×1 · Windows ×2 · macOS ×10) |
| **달러 금액** | raw 분 × **OS 단가**(배수를 또 곱하지 않는다) |

단가(2026-01-01 인하 후): Linux `$0.006` · Windows `$0.010` · macOS `$0.062` /분
※ 요금은 바뀐다 — 인용할 때 **확인 시점**을 함께 적을 것.

**과금은 잡마다 분 단위 올림**이다. 46초짜리 macOS 잡이 1분 → 배수 적용 시 **10분**을 먹는다.

## 이 저장소의 기준선 (2026-09-01 ~ 09-18, 18일 실측 — **v2.558 변경 전**)

⚠ 아래는 **낭비를 걷어내기 전** 수치다. 지금 다시 집계하면 이보다 크게 나오는데(오늘의 PR·릴리스가
더해지므로) 그것은 개선 실패가 아니라 **관측 구간이 다른 것**이다. 비교하려면 v2.559 머지 시점
이후로 구간을 잘라 다시 집계할 것.


| | 값 |
|---|---|
| ci.yml 실행 | 644회 (기능 브랜치 push 280 · main push 162 · PR 202) |
| release.yml 실행 | 165회 (전부 `workflow_dispatch`) |
| Linux | 4,941분 / macOS | 279분 |
| Gross · Billed | $47.17 · **$0** |

잡 1회 소요: ci `6.13분`(v2.559 이후 PR 은 5.13분) · release ubuntu `6분` · release macOS `1분`

이 표로 검산이 맞는지 먼저 확인하고(합계가 청구서와 일치해야 한다) 분석을 시작한다.

## 자주 나오는 낭비 네 가지 (이 저장소에서 실제로 발견된 것)

1. **같은 커밋에 CI 2회** — `on.push.branches:['**']` + `pull_request` 조합. ⚠ **concurrency 로는
   못 막는다**(push 는 `refs/heads/<브랜치>`, PR 은 `refs/pull/<n>/merge` 라 그룹이 갈린다).
   `push.branches:[main]` 로 좁힌다.
2. **안 바뀐 것을 매번 재빌드** — macOS 잡이 ×10 인데 `uagmon/` 은 295 커밋 동안 무변경이었다.
   소스 내용 해시를 릴리스 자산(마커)에 남겨 비교한다. ⚠ 태그 기준 git diff 는 이 저장소에서
   성립하지 않는다(태그 1개, 릴리스는 전부 workflow_dispatch).
3. **매트릭스 레그를 PR 마다 전부** — 운영 대상만 PR 에, 상위 버전은 main push 에.
4. **같은 테스트를 여러 워크플로에서** — `release.yml:58 npm test` 는 main CI 가 같은 SHA 에서
   이미 통과시킨 것을 다시 돈다. ⚠ 다만 이것은 **배포 직전 안전망**이므로 제거는 trade-off 다.

## 변경 후에는 **실제 실행으로 실증**한다

문자열·설정만 보고 "고쳤다"고 말하지 않는다. 다음 실행에서 직접 확인한다:
- 실행 수가 줄었는가 (`head_sha` 로 같은 커밋의 실행을 세어 본다)
- 조건부로 만든 잡이 `conclusion: "skipped"` 로 뜨는가
- 매트릭스 갈래가 이벤트별로 다르게 뜨는가(PR n개 / main push m개)

## 정직성

- **추정과 실측을 섞지 않는다.** 집계하지 않은 수는 '추정'이라고 쓴다 — 위의 3.2배 오차가 그 결과다.
- **`Billed` 가 0 이면 "비용 절감"이라고 말하지 않는다.** 줄어든 것은 Gross 이고, 실익은
  Private 전환 같은 조건이 붙을 때만 생긴다. 그 조건을 함께 밝힌다.
- 요금 단가는 공식 문서(`docs.github.com`)가 이 환경에서 차단될 수 있다 — 웹검색으로 얻었으면
  **출처와 미검증 사실**을 적는다.
- larger runner(4-core 등)는 공개 저장소에서도 과금된다고 알려져 있으나 **이 저장소에서 확인한
  바 없다**(표준 러너만 사용). 단정하지 말 것.
- 이 스킬은 **읽기 전용**이다. 워크플로 수정은 사용자가 지시할 때만 하고, 조치마다 **무엇을 잃는지**
  (검증 공백·안전망 제거·기능 손실)를 함께 적는다.
