# 대용량 작업 격리 아키텍처 — vCenter 수집 프로세스 분리 vs worker_threads

> 목적: **특정 대용량 작업(예: 28개 vCenter 조회·수집)이 돌 때 포탈 전체가 멈추는(hang) 것을 방지**한다.
> 큰 작업은 백그라운드에서 제 페이스로 돌고, 새 HTTP 요청은 항상 즉시 처리되게 한다.
>
> ⚠️ 이 문서는 **설계 검토·비교**다. 구현 전 반드시 §10-0 계측으로 실제 병목을 숫자로 확정할 것.

---

## 1. 문제 정의 (증상 → 메커니즘)

- 증상: "불러오는 중…"과 함께 포탈이 죽은 듯 멈춤. 인사이트 이상탐지 등에서 `오류: signal timed out`.
- 메커니즘: 포탈 서버는 **단일 스레드 Node 프로세스**이고 metrics/insights/수집 집계가 **`node:sqlite`(동기 API)** 로 돈다. 어떤 동기 작업이 수 초 걸리면 그동안 **이벤트 루프 전체가 멈춰** 모든 사용자의 모든 요청이 정지한다. 프론트 GET은 20초 타임아웃(`AbortSignal.timeout`, `web/src/api.js:53`)이라 그 정지가 20초를 넘긴 요청이 "signal timed out"으로 표시된다 — **원인이 아니라 결과**.

## 2. 진단 — 무엇이 이벤트 루프를 막는가

**중요 정정**: 28개 vCenter에서 데이터를 **네트워크로 가져오는 것 자체는 이벤트 루프를 막지 않는다**(async I/O). 막는 것은 **받은 데이터의 동기 CPU 처리**다.

| 대용량 작업 | 막는 부분(동기 CPU) | 현재 방어 | 근거 |
|---|---|---|---|
| 28 vCenter 수집 | SOAP/XML 파싱, 스냅샷 재구성(O(N)), 동기 SQLite 쓰기 | 동시성 8+데드라인(I/O만) | `store.js:239` `collectPool`, `:226` 재구성, `metrics/db.js:75` `insertMany` 동기 루프 |
| 이상탐지/예측 집계 | 원본 samples `GROUP BY`(동기) | single-flight + 60s 캐시 | `routes/insights.js:191`, `insights/anomaly.js`, `metrics/db.js:68` |
| IPAM 레저 동기화 | 수천 행 bulk write | **워커 오프로드** | `ipam/writeWorker.js` (v2.215) — ✅ 해결됨 |
| 대량 export | 1M행 dump | chunk+setImmediate+행상한 | `routes/api.js gpuSeriesExport` — ✅ |
| 시계열 prune | DELETE 스캔 | N틱 스로틀+ts 인덱스 | `metrics/db.js:59` — ✅ |

→ 남은 큰 구멍은 **(1) 수집의 파싱·재구성·쓰기, (2) 인사이트 집계** — 둘 다 "N에 비례하는 동기 CPU를 메인 스레드에서 실행".

## 3. 설계 목표 (불변조건 3줄)

1. **HOT PATH**: HTTP 요청 경로는 N(vCenter·호스트·VM·행)에 비례하는 동기 작업을 **절대 실행하지 않는다**(읽기는 스냅샷/캐시 참조, 무거운 건 "제출만").
2. **격리**: N-비례 CPU 작업은 **메인 루프 밖**(worker_threads 또는 별도 프로세스)에서 돈다.
3. **논블로킹 제출**: 새 작업 요청은 **enqueue = O(1)** 로 즉시 반환(결과는 캐시/폴링).

## 4. 분리 대상 — 무엇을 "수집 프로세스"로 옮기나

| 구분 | 수집 프로세스로 이동 | 포탈 프로세스에 잔류 |
|---|---|---|
| 작업 | 28개 vCenter 라이브 조회 전부 — 주기 수집(`store.refresh`/`collectPool`), SOAP 파싱, 라이브 on-demand(콘솔·DS 브라우즈·프로비저닝 배치·metrics 샘플링) | HTTP/UI, 인증·RBAC·OTP, 스냅샷 캐시 읽기, IPAM 원장, 알림, WS 게이트웨이 |
| 자원 | vCenter 자격증명·SOAP 세션·XML 파서 CPU | 웹 서빙(경량·O(1)) |

## 5. 프로세스 간 핸드오프(IPC) 방식 비교

| 방식 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **loopback HTTP (엣지 push/pull)** ★ | 기존 `/api/collector/export`·사이트 인벤토리 push 재사용 | 신규 코드 최소, 이미 stale·자동등록 처리 | JSON 직렬화 비용(수신 시 포탈 루프 잠깐 점유) |
| child_process fork + IPC | Node `fork()` 메시지 채널 | 부모-자식 수명 관리 쉬움 | IPC 프로토콜 직접 설계, 큰 객체 clone 비용 |
| 공유 SQLite / 파일 스냅샷 | 수집기가 DB에 쓰고 포탈이 읽음 | 직렬화 왕복 없음, 대용량 유리 | 스키마·동시성(WAL) 설계, 지연 |
| Unix socket / named pipe | 저수준 스트림 | 빠름 | 프로토콜·프레이밍 직접 구현 |

## 6. 아키텍처 옵션 비교 매트릭스

| 기준 | A. 별도 프로세스<br>(엣지/사이트 재사용) | B. 별도 프로세스<br>(커스텀 IPC/fork) | C. worker_threads<br>(인프로세스) | D. cluster<br>(동일 프로세스 N개) |
|---|---|---|---|---|
| 격리(장애·GC·메모리) | ◎ 최강(별도 힙·GC·루프) | ◎ 최강 | △ 중(힙/GC **공유**) | ○ 강 |
| 참 CPU 병렬 | ○ | ○ | ○ | ○ |
| 자격증명 격리(보안) | ◎ 웹 프로세스가 SOAP 세션 미보유 | ◎ | △ 같은 프로세스 공유 | △ |
| 신규 코드량 | ◎ 적음(substrate 재사용) | ✗ 많음(IPC 직접) | ○ 중(워커풀 일반화) | ✗ 많음+재설계 |
| IPC/직렬화 비용 | △ 중(HTTP JSON) | △ 중~높 | ○ 낮~중(인프로세스 clone) | ✗ 높 |
| 배포·운영 복잡도 | △ 프로세스 2개(같은 바이너리·자동등록) | △ 프로세스 2개 | ◎ 프로세스 1개 | ✗ 높음 |
| 상태 일관성 | ○ stale 처리 이미 있음 | △ 직접 구현 | ◎ 같은 메모리 | ✗ 캐시/폴러 중복→붕괴 |
| 에어갭·단일배포 적합 | ◎ 같은 프로그램 | ○ | ◎ | ✗ |
| **이 목표 적합도** | **◎** | ○ | ○(격리 약) | ✗ |

## 7. 멀티프로세스(별도 프로세스) 자체의 장단

| 장점 | 단점 |
|---|---|
| **최강 격리** — 수집기 CPU 버스트·GC 정지·메모리 폭증·크래시가 포탈에 전혀 전파 안 됨(worker는 힙/GC 공유라 대량 할당 시 프로세스 전역 GC pause 가능) | **IPC 직렬화 비용** — 스냅샷(수천 VM)이 프로세스 경계를 넘어야 함. 수신·파싱 시점에 포탈 루프를 잠깐 점유 |
| **자격증명 격리(보안)** — 웹 마주하는 포탈이 라이브 vCenter 세션/평문 크리덴셜 미보유 → 블래스트 반경↓ | **운영 복잡도↑** — 프로세스 2개(systemd 유닛·헬스체크·재시작·포트/토큰) |
| **독립 재시작** — 수집기만 죽어도 포탈은 계속 서빙, 자동 재기동 | **메모리 총량↑** — Node 런타임 2벌 |
| **참 병렬** — 별도 OS 프로세스라 코어 활용 | **상태 일관성** — 포탈이 "수집기 다운/스냅샷 stale"을 UX로 처리(이미 site-mode에 stale 표시 존재) |

## 8. 권고 — A: 엣지/사이트 substrate 재사용

이 저장소는 이미 **분산 수집 구조**를 갖는다(`packaging/DISTRIBUTED-COLLECTION.md`):
- `collectMode: 'site'` vCenter는 **원격 엣지가 수집해 중앙으로 push**, 중앙은 병합만 한다(`store.js:295-307`, `central/inventory.js`). stale 표시도 있다(`store.js:300`).
- `EDGE_MODE=all` 인스턴스는 수집기 export + 위임 워커 + **사이트 인벤토리 push(live 수집)** + 자동 업그레이드 + 자동 등록을 켠다.

→ "vCenter 조회를 별도 프로세스로"는 곧 **로컬에 두 번째 인스턴스를 엣지(수집 역할)로 띄우고, 28개 vCenter를 `collectMode='site'`로 그 로컬 엣지에 할당**하는 것. 포탈 프로세스는 vCenter를 직접 안 건드리고 **병합 스냅샷만 소비**한다. 격리는 최강이면서 **신규 코드는 최소**(테스트된 경로 재사용).

개요:
```
[포탈 프로세스 :4000]  ── HTTP/UI/RBAC/스냅샷 캐시 (vCenter 직결 X)
        ▲  loopback push/pull (사이트 인벤토리 병합)
[로컬 엣지 프로세스]    ── 28 vCenter 라이브 수집·SOAP 파싱·metrics 쓰기 (동기 CPU 여기 격리)
```

## 9. 정직한 미결 & 리스크

1. **라이브 on-demand 조회 미커버**: 주기 수집은 site-mode로 오늘 바로 커버되지만, 콘솔 티켓·DS 브라우즈·프로비저닝 배치 SOAP 등 **일부 라이브 조회는 아직 포탈-직결**이다. "모든 vCenter 조회" 완전 분리는 이들을 수집 프로세스로 라우팅하는 추가 설계가 필요(현재 위임 워커는 스캔/핑/캡처류만 처리).
2. **핸드오프 수신 비용**: 사이트 인벤토리 push를 포탈이 받을 때의 병합/역직렬화가 포탈 루프를 얼마나 점유하는지 **실측 필요**. 크면 증분 전송/압축/공유 SQLite로 완화.
3. **개별 작업은 빨라지지 않는다**: 격리는 "포탈이 안 멈춤"을 보장할 뿐, 큰 작업 자체의 소요는 그대로(백그라운드로 이동).

## 10. 도입 로드맵 (점진적)

- **0. 계측 (필수 선행)**: 이벤트-루프 lag + 작업별 실행시간 로깅 → 실제 주범을 숫자로 확정(수집 재구성 vs 이상탐지 vs 쓰기). 엉뚱한 곳을 갈아엎지 않기 위함.
- **1. 로컬 엣지 PoC**: 두 번째 인스턴스를 엣지로 띄우고 일부 vCenter를 site-mode로 → 포탈 루프 lag 개선 실측.
- **2. 핸드오프 최적화**: 수신 병합 비용이 크면 증분/공유 SQLite 적용.
- **3. 라이브 on-demand 라우팅**: 콘솔·브라우즈·배치 SOAP을 수집 프로세스 경유로.
- **4. 대안 병행**: 인사이트 집계는 worker_threads 오프로드 또는 롤업(`samples_hourly`)로 별도 처리(수집 분리와 독립).

## 11. 회귀 방지 불변조건 (채택 시 CLAUDE.md 성능 규칙에 추가)

> "N(vCenter·호스트·VM·행)에 비례하는 동기 작업은 반드시 chunk-yield 하거나 worker/별도 프로세스에서 돌린다. 네트워크 fan-out은 동시성 제한 + per-target 타임아웃. HTTP 요청 경로는 O(1)/유계만."

## 부록 — 거부한 대안

- **cluster(동일 포탈 N개)**: `store`·인메모리 캐시·폴러가 in-process 공유라, 분할 시 캐시가 프로세스마다 따로 놀고 폴러가 28 vCenter를 N배 중복 수집 → 대규모 재설계 필요. 부적합.
- **외부 브로커(Redis/BullMQ)**: 에어갭·단일바이너리 배포 전제를 깸. 부적합.

## 부록 — 근거 파일

- `server/src/store.js` (`collectPool`, 스냅샷 재구성, site-mode 병합)
- `server/src/metrics/db.js` (`insertMany` 동기 루프, `historyAll` GROUP BY, `samples_hourly` 롤업)
- `server/src/routes/insights.js` · `server/src/insights/anomaly.js` (이상탐지 single-flight)
- `server/src/ipam/writeWorker.js` (worker 오프로드 선례)
- `packaging/DISTRIBUTED-COLLECTION.md` · `docs/EDGE-COLLECTOR-MERGE.md` (엣지/사이트 분산 수집)
- `web/src/api.js` (GET 20s 타임아웃 = "signal timed out" 출처)
