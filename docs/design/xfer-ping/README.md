# 설계: 법인 간 전송 속도 › 법인 상세 — Ping 을 함께 보는 추이 + 보기 선택 메뉴

작성 2026-11-05 (v2.889.0 기준 · 브랜치 `claude/admiring-edison-89unbf`) · 상태 **구현됨 v2.899.0**(컨펌 2026-11-05 '좋아 기본값대로 구현해줘' · 표준 검증 — 아래 §10) · 시안 캔버스: https://claude.ai/artifact/2ivHWY9M8SK58FjrogPKdY
(아트보드 6장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 법인명(PL-WRO)·수치는 가상이고 결정적 난수로 만든 것이다. 색·글자는 `web/src/styles.css` `:root` 토큰과
`web/src/views/tools/xferSpeed.css` 그대로. 계정의 ‘Design System’ 아티팩트는 비어 있어 쓰지 않았다 — bareos-cancel 과 같다.)

## 1. 요구 (사용자 요청 2026-11-05)

- "이 화면에 ping 도 찍는 기능을 추가하고 ping 과 같이 볼것인지 선택하는 메뉴도 만들어줘, 일단 설계해서 보여줘" — 첨부 화면은 법인 상세의 '24시간 추이' 차트(`XferSpeedTool.jsx Detail`).
- 규칙(2026-11-03 '기억해'): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현.

## 2. 지금 있는 것(코드 근거) — 새로 재지 않아도 된다

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| Ping 모니터가 **엣지 노드를 자동 대상으로 등록**한다 — id `edge_<수집서버 id 소문자>` · `kind:'tcp'` · 엣지 URL 의 호스트:포트(기본 443) · source `'edge'` | `server/src/ping/store.js:176 seedEdgeTargets` · `ping/monitor.js:72`(모니터 시작 때) · `routes/ping.js:233 POST /api/ping/edge/sync` | **그 기록을 그대로 읽는다.** 회선에 트래픽을 더 싣지 않는다 |
| 1분 주기(`PING_MON_INTERVAL_MS` 기본 60초) · 시한 2.5초 · 보관 365일 · 동시 8 | `server/src/config.js:214~226` | 24시간 = 1,440 표본 · 화면은 6분 칸(240점)으로 줄인다 |
| 원시 `samples(target, ts, rtt, ok)` + 시간 롤업 `samples_hourly` + `history(target, since, bucketMs, limit)` · `historyHourly` | `server/src/ping/db.js:30~` · `:198~206` | 7일 이상은 롤업 · **끝 시각(`until`) 인자가 없다** → 추가(§4.1) |
| `seriesOf(id, {rangeMs, points})` — '지금부터 거꾸로' 만 | `server/src/ping/service.js:98` | 과거 창(◀ 이전)을 못 준다 → 창 조회 함수를 따로 둔다(§4.1) |
| 전송 속도 상세 조회 `GET /tools/xfer-speed/history?agent&days&end` — adminOnly + fullScopeOnly · `end` 로 과거 창 · 응답 `start·end·past·offsetMin` | `server/src/routes/api/xferSpeed.js:231` | **바꾸지 않는다.** Ping 은 별도 엔드포인트(§4.2) — 속도 조회가 Ping 실패에 묶이지 않게 |
| 차트 `Chart({hist})` — `chartModel`·`hoverAt`·`cadenceOf` · 마우스 오버 상자 `.xs-tip` · `WindowScroll` | `web/src/views/tools/XferSpeedTool.jsx:514~610` · `xferSpeedText.js` | 그대로 두고 아래에 Ping 패널을 붙인다. 오버 x 좌표를 공유 |
| 데모(mock): 데모 엣지를 Ping 대상으로 등록하고 24시간 백필 | `server/src/mock/demo/edgeSeed.js:352` | 데모 계정·Chromium 검증에서 Ping 패널이 비지 않는다 |
| 네트워크 › 체크(엣지 노드) 화면 — 같은 기록의 전용 화면 | `web/src/views/NetworkCheck.jsx` · `routes/ping.js:223 /edge/overview` | 패널 문구가 '같은 기록' 임을 밝힌다. 1분 표는 거기서 본다 |

## 3. 정직하게 밝혀야 하는 것 (시안 문구에 반영)

1. **ICMP 가 아니다.** 엣지 대상은 `kind:'tcp'` — 엣지 포탈 포트(기본 443)에 TCP 연결이 맺어지기까지의 시간이다(`ping/monitor.js:28 tcpConnect`). 화면은 'Ping' 뒤에 반드시
   '엣지 포탈 TCP 연결(443)' 을 붙인다. 진짜 ICMP 를 원하면 측정을 새로 만들어야 하고, ICMP 를 막는 법인은 빈다(컨펌 질문 ②).
2. **툴팁의 '지연' 과 다른 값이다.** '지연 498ms' 는 전송 측정의 응답 머리까지(`probe.js ttfbMs` · `analyze.latencyMsOf`)이고 Ping RTT 가 아니다 — 두 이름을 같은 상자에서 구분한다.
3. **점 밀도가 30배 다르다.** 24시간에 속도 48점 · Ping 1,440점 → Ping 은 칸 평균선 + 최저~최고 띠, 손실은 빨간 눈금. 결측 칸(모두 실패)은 선을 끊는다. 0 으로 쓰지 않는다.
4. **Ping 기록이 없는 엣지가 생긴다.** 자동 등록은 모니터 시작 때만이라, 그 뒤 추가한 엣지·사용자가 지운 엣지는 기록이 없다 → 사유 코드로 보인다(§5 상태).
5. **보관 기간이 다르다.** Ping 원시 365일(시간 롤업은 같은 prune) vs 전송 원시 180일 + 일 요약 5년 → 과거 창에서 한쪽만 비는 구간이 생긴다 → `before-retention`.

## 4. 데이터 · 서버

### 4.1 `ping/db.js` · `ping/service.js` — 끝 시각이 있는 창 조회

- `history(target, sinceTs, bucketMs, limit, untilTs = null)` · `historyHourly(..., untilTs)` — `ts < ?` 조건 하나 추가(인덱스 `(target, ts)` 그대로). 기본값 null = 지금 동작.
- `service.js` 에 **`windowOf(id, { start, end, points })`** 를 새로 둔다(순수 계산은 `planBuckets` 재사용): `bucketMs = planBuckets(end − start, points)` · 1시간 이상이면 롤업.
  반환 `{ bucketMs, source:'raw'|'hourly', series:[{ts, avg, min, max, loss, n}] }`. **`seriesOf` 는 바꾸지 않는다**(네트워크 › 체크·vCenter 포트가 쓴다).
- 칸 `avg` 는 ok=1 표본만의 평균(기존 `AVG(CASE WHEN ok=1 THEN rtt END)` 와 같은 뜻) · 전부 실패인 칸은 `avg:null, loss:1`.

### 4.2 새 라우트 `GET /tools/xfer-speed/ping?agent=&days=&end=` (`routes/api/xferSpeed.js`)

- 게이트 **adminOnly + fullScopeOnly**(형제 `/history` 와 같다 — 엣지 주소를 싣지 않더라도 전 법인 회선 상태다) · `memoJson` 은 쓰지 않는다(법인·창마다 다르고 1분 폴링은 한 화면뿐).
- 창은 `/history` 와 **같은 식**으로 만든다(`daysArg` · `end` · `past` — 함수로 빼서 두 라우트가 공유). `points` 는 `Math.min(480, 요청 points || 240)`.
- 대상 id = `edge_${idOf(col.id || col.name)}`(`ping/store.js` 의 `idOf` 를 export 해서 **같은 함수**로 만든다 — 사본 금지).
- 응답:
  ```json
  { "ok": true, "agent": "pl-wro", "target": { "id": "edge_pl-wro", "kind": "tcp", "enabled": true },
    "method": "tcp-connect", "intervalMs": 60000, "timeoutMs": 2500, "retentionDays": 365,
    "start": 1793756160000, "end": 1793842560000, "past": false, "bucketMs": 360000, "source": "raw",
    "series": [ { "ts": 1793756340000, "avg": 246.8, "min": 242.8, "max": 250.2, "loss": 0, "n": 6 } ],
    "stats": { "n": 1440, "ok": 1436, "lossPct": 0.28, "avg": 251.3, "median": 246.2, "max": 592.1, "last": { "ts": 1793842500000, "rtt": 244.1, "ok": true } },
    "oldest": { "sampleTs": 1762220400000 }, "offsetMin": 540 }
  ```
  - **주소·포트는 싣지 않는다**(id·kind·enabled 만). `method` 는 `util/ping.js pingProbeMode()` 가 아니라 대상 kind 로 — tcp 대상이니 항상 `'tcp-connect'`(icmp 대상을 나중에 붙이면 그때 값이 늘어난다).
  - 값이 없으면 `ok:true` 에 **`reason`** 을 싣는다: `no-target`(대상 없음 — 등록 버튼) · `monitor-off`(`config.ping.enabled` false — 과거 기록이 있으면 series 도 같이) ·
    `before-retention`(창이 `oldest.sampleTs` 보다 앞) · `disabled`(대상이 비활성). 저장소를 못 열면 **503** `{ok:false, reason}`(`registryUnreadable` 류와 같은 규약).
  - `stats.median` 은 원시 창(≤ 31일)에서만 — 롤업 창은 `median:null`(일 요약 분위수를 지어내지 않는 기존 규칙과 같다).
- 테스트(`server/test/xferPing<ver>.test.js`): 실제 api 라우터로 ① 창 계산이 `/history` 와 같은 `start·end·past` ② 과거 창 `until` 이 실제로 잘린다(이웃 창이 같은 표본을 두 번 세지 않는다)
  ③ 응답에 host/port 문자열 0 ④ 4가지 reason ⑤ 롤업 전환 경계(7일) ⑥ 범위 계정 403 · 데모 계정은 데모 엣지만.

### 4.3 바꾸지 않는 것

- 수집·DB 적재·prune·엣지 코드 — 없음. 엣지(`routes/collector.js`)는 손대지 않는다(중앙이 자기 Ping 저장소를 읽을 뿐이다).
- 측정 기록 표·CSV — Ping 을 싣지 않는다(1,440행 — 네트워크 › 체크가 담당). 컨펌에서 원하면 CSV 에 'ping.csv' 를 따로 둔다(동시 1건 규칙).

## 5. 화면(IA)

```
법인 상세 (#/tools/xfer-speed/<agent>)
 ├ 머리 · 기간 세그먼트 · CSV · 지금 측정                 (그대로)
 ├ 통계 칸 6개(↓ ↑)                                      (그대로)
 ├ 카드 '24시간 추이'
 │   ├ 제목 줄: h3 + [보기] 세그먼트 ‹전송 속도 | 전송 속도 + Ping | Ping만›  ← 새 메뉴
 │   ├ 범례(↓ ↑ 중앙값 | Ping 평균 · 최저~최고 · 손실)
 │   ├ 속도 차트(그대로) + 마우스 오버 상자(Ping 줄 추가)   ← '전송 속도' · '+ Ping'
 │   ├ Ping 패널(새): 작은 머리(제목 · 측정 방식 · 통계 알약) + svg 170(‘+ Ping’) / 280(‘Ping만’)
 │   ├ 각주: ICMP 아님 · 지연과 다른 값
 │   └ WindowScroll(그대로 — Ping 도 같은 창)
 └ 측정 기록 표                                           (그대로)
```

- **보기 메뉴**: 세그먼트 3칸(`xs-seg` 재사용). 값 `'speed' | 'both' | 'ping'`. **기본 `'speed'`**(지금 화면과 같음 — 컨펌 질문 ①). `localStorage` 키 `xs.detail.view`
  (per-viewer 편의 — try/catch · 못 읽으면 기본값). 이 키는 **법인과 무관**(한 번 고르면 모든 법인 상세에 적용).
- **Ping 패널**(B안 — 권장): 속도 차트 아래 같은 `padL/padR`(46/16 · 400px 에서 40/10)로 x 축을 맞춘다. 칸 평균선 `#a78bfa`(1.6px) · 최저~최고 띠 같은 색 22% · 기간 중앙값 점선 ·
  손실 칸은 상단에 빨간 눈금(3×9) · 전부 실패 칸은 선이 끊긴다. y 상한 = 칸 최고값들의 최대를 150 단위로 올림(`niceMax`) — 0 에서 시작. **오버 세로선·점은 두 svg 에 같은 x 로 그린다**
  (hoverPx 상태를 카드가 소유하고 두 svg 에 내려준다 — 각자 가지면 어긋난다).
- **마우스 오버 상자**: 기존 `hoverAt` 결과 + `pingAt(series, ts)`(허용 = bucketMs/2) 한 줄 — `Ping 247ms 평균 · 243~250 · 손실 0% (6회)`. 전송 회차가 없는 시각에 오버하면
  속도 줄은 '이 시각엔 전송 측정 없음'(회색 · 0 아님). Ping 칸이 없으면 Ping 줄은 '—'.
- **'Ping만'**: 속도 svg 를 숨기고 Ping svg 높이 280 · 범례는 Ping 것만 · 통계 칸·측정 기록은 그대로(차트의 보기일 뿐이다).
- **상태**(`States.dc.html`): `no-target`(등록 버튼 → 기존 `POST /api/ping/edge/sync`, 관리자) · `monitor-off` · `before-retention` · 조회 실패 배너(다시 시도) —
  **속도 차트는 그대로 보인다**(요청을 따로 보낸다 · 늦게 온 이전 응답은 버린다 · 403/404 는 `shouldStopPolling` 규칙대로 다음 틱을 걸지 않는다).
- **폴링**: 보기가 `'speed'` 면 Ping 을 **아예 조회하지 않는다**. 최근 창만 60초 갱신(속도와 같은 루프에 붙이되 요청은 따로) · 과거 창은 갱신 없음.
- **400px**(`Narrow.dc.html`): 세그먼트가 제목 아래로 내려오고 범례가 줄바꿈 · 통계 칸 2열 · WindowScroll 버튼 줄과 슬라이더 분리 · 오버 상자 `max-width: 80vw`.

### 색 · 접근성

- Ping 보라 `#a78bfa`(배경 `#141b2d` 대비 약 7.6:1 · 제목 `#c4b5fd`) — ↓ 청록 `#22d3ee` · ↑ 호박 `#f59e0b` 과 색상뿐 아니라 명도도 다르다. 손실 `#ef4444` 는 값이 아니라 눈금이라 선과 겹치지 않는다.
- 새 hex 는 `#a78bfa`·`#c4b5fd` 둘 — `xferSpeedText.js` 에 `PING_COLOR`·`PING_TEXT_COLOR` 상수로 두고 svg·범례·알약이 같은 값을 쓴다(서버 응답에 색 없음).

## 6. A안(한 차트 두 축)을 권하지 않는 이유 — `AltA.dc.html`

1. 단위가 다른 두 값(Mbps·ms)이 같은 세로 공간에서 교차한다 — 02:50 의 Ping 급등이 ↑ 속도 상승처럼 읽힌다.
2. 왼쪽·오른쪽 축을 번갈아 읽어야 하고 400px 에서 오른쪽 축 글자만큼(약 20%) 그리는 폭이 준다.
3. 최저~최고 띠를 같이 그리면 ↓ 선(평소 1~3 Mbps → 차트 바닥)을 덮는다. 띠를 빼면 1분 지터를 잃는다. B안은 패널을 나눠 둘 다 유지한다.

## 7. 컨펌 받을 기본값 (답이 없으면 괄호 값으로 구현)

| # | 질문 | 선택지 | 기본 |
|---|---|---|---|
| ① | 처음 열 때 보기 | 전송 속도만 / 전송 속도 + Ping | **전송 속도만**(지금과 같음 · 선택은 브라우저가 기억) |
| ② | 측정 방식 | 기존 TCP 443 연결 기록 그대로 / ICMP 측정을 새로 추가(엣지 방화벽이 막으면 빈다 · 폴러·DB 추가) | **기존 TCP 기록** |
| ③ | Ping 칸 수 | 240(6분) / 480(3분) | **240**(점 밀도 — 1440px 에서 5.4px 간격) |
| ④ | 손실 표시 | 상단 눈금만 / 눈금 + 칸 배경 붉은 띠 | **상단 눈금만** |
| ⑤ | 측정 기록 표에 Ping 손실 행 | 넣지 않음 / 손실 칸만 행으로 | **넣지 않음**(네트워크 › 체크가 담당) |
| ⑥ | 'Ping만' 보기 | 둔다 / 뺀다(두 칸 토글) | **둔다** |

## 8. 구현 규모 (추정 — Opus)

- 서버: `ping/db.js` until 인자 · `ping/service.js windowOf` · `routes/api/xferSpeed.js` 라우트 1 + 창 함수 공유 · 테스트 1파일(6항목) — 약 250줄.
- 웹: `XferSpeedTool.jsx` Detail/Chart(보기 상태 · Ping 패널 · 공유 오버) · `xferSpeedText.js`(`PING_*` 상수 · `pingAt` · `niceMax` · 문구) · `xferSpeed.css`(세그먼트 재사용 · 알약 · 패널 머리) ·
  웹 테스트(`xferSpeedText.test.js` — pingAt 허용 폭 · niceMax · 문구) — 약 350줄.
- 검증: 관련 테스트 + `npm run verify` + Chromium 1440/400(데모 엣지 — 보기 3가지 · 상태 1가지 이상). 예상 60~80분(검증 포함). 보안·범위에 닿는 변경(새 조회 라우트)이라
  범위 계정 403 · 데모 계정 가림 테스트는 반드시 둔다 — 변이 검증은 라우트 게이트 2건만.

## 9. 아트보드 목록

| 파일 | 폭 | 내용 |
|---|---|---|
| `Main.dc.html` | 1440 | 법인 상세 · 보기 '전송 속도 + Ping' · 공유 오버(10:41) · Ping 패널 170 · WindowScroll — **구현 기준** |
| `PingOnly.dc.html` | 1440 | 보기 'Ping만' · 패널 280 · 02:50 스파이크·손실 오버 |
| `Narrow.dc.html` | 400 | 좁은 폭 — 세그먼트 줄바꿈 · 통계 2열 · 버튼/슬라이더 분리 |
| `Menu.dc.html` | 880 | 보기 메뉴 3상태 · 오버 상자 3경우(정상 · ↑ 실패 + Ping 급등 · 전송 측정 없는 시각) |
| `AltA.dc.html` | 1440 | A안 비교(두 축) — 권하지 않는 이유 3가지 |
| `States.dc.html` | 1440 | Ping 패널 상태 4가지(no-target · monitor-off · before-retention · 조회 실패) |

## 10. 구현 기록 (v2.899.0) — 시안과 다르게 한 점

- **포트는 싣는다**(§4.2 는 '주소·포트 미포함' 이었다): 대상 필드는 `id·kind·port·enabled` — 포트는 화면 문구 'TCP 연결(443)' 에 쓴다. 호스트는 싣지 않는다
  (상세 머리에 이미 origin 이 보이지만 이 응답이 새로 실을 이유는 없다). 테스트 ④ 가 응답에 엣지 주소가 없음을 본다.
- **사유는 5종**: 시안 4종에 `no-samples`(대상은 있으나 창에 표본 없음)를 더했다. 원인을 단정하지 않는 문구다.
- **'엣지 노드 다시 등록'** = 기존 `POST /api/ping/edge/sync`. ⚠ 지운 엣지는 tombstone 이라 자동 등록이 되살리지 않는다 — 결과가 0 이면 화면이 'Ping 모니터링에서 직접 추가' 를 말한다.
- **중앙값**은 원시 칸 창(planBuckets 가 시간 롤업을 고르지 않는 창 — 약 10일 이하)에서만. 7일은 원시, 30일부터 시간 요약이다(시안의 '≤31일' 이 아니다).
- **오버 상자 위치**: 시안은 카드 위 고정이었는데 'Ping만'·속도 측정이 없는 창에서 Ping 알약을 덮었다(Chromium 확인) — 보이는 첫 차트 위에 붙인다.
- **선 끊는 간격**: 칸 × 1.5 와 표본 간격(아래쪽 중앙값) × 1.6 중 큰 쪽. 칸 크기만 보면 표본이 칸보다 성긴 대상(데모 백필 15분)에서 점만 남았다.
- **맨 위 눈금 'NNNms'**: 따로 쓴 'ms' 가 맨 위 숫자와 겹쳤다(Chromium 확인).
