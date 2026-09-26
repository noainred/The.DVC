# 아키텍처 — 코드 지도와 데이터 흐름

> **소스를 처음 여는 사람**을 위한 문서입니다. 어디에 무엇이 있고, 데이터가 어디서 와서
> 어디로 가는지만 다룹니다.
> 설치는 [INSTALL.md](INSTALL.md), 설정 화면은 [SETTINGS.md](SETTINGS.md),
> API 는 [API.md](API.md)·[API-PUBLIC.md](API-PUBLIC.md),
> **"왜 이렇게 만들었는가"** 와 되돌리면 안 되는 규칙은 루트 `CLAUDE.md`·`server/CLAUDE.md` 에 있습니다.

---

## 1. 한 장 요약

```
                    ┌──────────────── 중앙 포탈 (Central) ────────────────┐
  브라우저 ──HTTPS──▶│  express  ─ routes/ ─ 도메인 모듈 ─ store(스냅샷)   │
  외부 포탈 ─X-Api-Key▶│                     └ SQLite 20종 (시계열·이력)    │
                    └───▲───────────────────────────────▲────────────────┘
                        │ push (엣지 → 중앙)             │ pull (중앙 → 엣지)
                        │ /api/central/*                │ /api/collector/*
                    ┌───┴───────────────────────────────┴────────────────┐
                    │           엣지 포탈 (Edge, 법인마다 1대)             │
                    │  같은 코드 · 역할만 다름 · 자기 법인만 수집           │
                    └───┬────────────────────────────────────────────────┘
                        │ SOAP/REST/SSH/Redfish/SNMP
        vCenter · ESXi · 스토리지 · SAN 스위치 · iDRAC · PDU · NSX · Horizon
```

**핵심 성질 넷**

1. **중앙과 엣지는 같은 바이너리**입니다. 역할은 환경변수(`CENTRAL_URL`·`COLLECTOR_TOKEN` 등)로 갈립니다.
2. **중앙은 엣지에 명령을 밀어넣을 수 없습니다.** 엣지는 NAT·폐쇄망 뒤에 있어 **아웃바운드만**
   가능합니다. 그래서 설정 배포는 전부 "엣지가 주기적으로 당겨 간다(pull)" 이고, 즉시 실행이
   필요한 것은 **잡 큐**(중앙이 쌓고 엣지가 인출)입니다.
3. **조회 화면은 메모리 스냅샷을 읽습니다.** vCenter 왕복은 폴러만 합니다.
4. **읽지 못한 값은 `null`** 입니다. 0 으로 채우지 않는 것이 전 기능의 규약입니다.

---

## 2. 규모 (v2.562 실측)

| | 파일 | 줄 |
|---|---:|---:|
| 서버 `server/src` | 636 | 107,571 |
| 웹 `web/src` | 376 | 76,675 |
| 서버 테스트 `server/test` | — | 2,673건 통과 |
| 웹 테스트(vitest) | — | 1,370건 통과 |

| 항목 | 수 |
|---|---:|
| API 엔드포인트 | **820** (GET 426 · POST 261 · PUT 85 · DELETE 46 · PATCH 2) |
| 라우트 파일 | 81 |
| 주기 실행 모듈(폴러·워커) | **80** |
| SQLite DB 파일 | **20종** |
| 설정·상태 파일 | 130여 개([CONFIG-FILES.md](CONFIG-FILES.md)) |
| 환경변수 | 329개([ENV.md](ENV.md)) |

---

## 3. 서버 코드 지도 (`server/src`)

### 3-1. 진입점과 공용 코어

| 경로 | 책임 |
|---|---|
| `index.js` | express 조립 · 라우터 마운트 · 폴러 기동(스태거) · WS 업그레이드 라우팅 |
| `config.js` | 환경변수 → 설정 객체(**핵심 키**). 도메인 전용 키는 각 모듈이 직접 읽습니다 — 전체 목록과 정의 위치는 [ENV.md](ENV.md) |
| `store.js` | **vCenter 인벤토리 메모리 스냅샷** + 폴링 루프. 조회 API 는 거의 전부 이것을 읽습니다 |
| `audit.js` `alerts.js` `logbuffer.js` | 감사 로그 · 알림 발송 · 콘솔 링버퍼(1,000줄 — `addLogTap` 으로 줄을 받아 가는 구독자가 있다: `loganalysis/live.js`) |

### 3-2. 도메인 모듈 (생성 — `scripts/arch-doc.mjs`)

> 이 표는 **생성물**입니다(v2.613). `node scripts/arch-doc.mjs` 가 `server/src` 의 디렉터리를 전부 훑어 만들고
> CI 가 `--check` 로 최신 여부를 봅니다 — 손으로 고치지 마세요(다음 실행에 덮입니다). 예전 손 목록은 v2.583 이후
> 새 디렉터리 42개(`commmap`·`dataflow`·`devflow`·`cvp`·`portalcheck` …)를 싣지 못했습니다.

<!-- arch-doc:modules:start -->
| 디렉터리 | 파일 | 줄 | 대표 파일(밖에서 import 수) | 머리말 첫 줄 |
|---|---:|---:|---|---|
| `agent/` | 40 | 5,048 | `agent/envTimeout.js` (18) | 호환 재수출(v2.613 DEPS2613-01) — 본체는 `util/envTimeout.js` 로 옮겼다. |
| `auth/` | 10 | 2,878 | `auth/scope.js` (39) | 사용자 데이터 범위(scope) 해석 — "이 사용자가 볼 수 있는 vCenter"를 계산한다. |
| `backup/` | 3 | 503 | `backup/service.js` (3) | 포탈 백업 코어 — 중앙 포탈의 모든 설정(CONFIG_DIR의 *.json / *.env)과, 엣지 포탈(에이전트)이 |
| `bmstor/` | 6 | 843 | `bmstor/poller.js` (4) | bmstor/poller.js — 베어메탈 스토리지 주기 수집(v2.340). |
| `bmusage/` | 18 | 3,474 | `bmusage/poller.js` (3) | bmusage/poller.js — 베어메탈 사용률 주기 수집(v2.550). |
| `capacity/` | 4 | 767 | `capacity/sampler.js` (4) | Capacity Advisor 샘플러 — 운영 중인 포탈 프로세스 안에서 30초마다 자기 호스트를 실측한다 |
| `central/` | 38 | 6,438 | `central/inventory.js` (10) | 사이트 위임 수집 — 중앙(OC2) 측 인벤토리 캐시. |
| `collector/` | 9 | 1,345 | `collector/registry.js` (58) | Collector registry — the list of remote collector agents (one per datacenter) |
| `commmap/` | 1 | 353 | `commmap/build.js` (2) | commmap/build.js — 통신 지도(중앙 ↔ 엣지 통신 시각화)의 **순수 조립 모듈**(v2.584). |
| `curuser/` | 12 | 1,817 | `curuser/settings.js` (4) | curuser/settings.js — '현재 사용자' 수집 설정(v2.520). |
| `cvp/` | 10 | 2,305 | `cvp/poller.js` (4) | cvp/poller.js — CloudVision(CVP) 주기 수집(v2.608). |
| `datacenter/` | 1 | 192 | `datacenter/store.js` (15) | DataCenter(법인) 레지스트리 — vCenter의 '상위 개념'. |
| `dataflow/` | 1 | 299 | `dataflow/build.js` (3) | dataflow/build.js — '데이터 흐름 지도' 의 판정(v2.587, 순수 함수). |
| `devflow/` | 1 | 204 | `devflow/build.js` (1) | devflow/build.js — 특수기능 '3단 지도(장비 → 엣지 → 메인)' 조립기(v2.588, 순수). |
| `dirusage/` | 5 | 892 | `dirusage/scheduler.js` (3) | dirusage/scheduler.js — 폴더 사용량 스캔 주기 실행 + 메일 발송 (v2.454). |
| `edgelog/` | 3 | 368 | `edgelog/spec.js` (4) | edgelog/spec.js — 엣지 포탈의 **진행상태**를 어디서 읽는지 적은 표(순수 데이터, v2.549). |
| `gpu/` | 8 | 1,649 | `gpu/guestops.js` (8) | VMware Tools 게스트 작업으로 게스트 OS 안에서 nvidia-smi를 실행해 GPU 사용률을 |
| `guest/` | 1 | 51 | `guest/accountService.js` (1) | 게스트 계정 추가 오케스트레이션 — vCenter에 로그인해 선택된 VM들의 게스트 OS에 sudo 계정을 |
| `guestdisk/` | 5 | 953 | `guestdisk/poller.js` (3) | guestdisk/poller.js — 게스트 디스크 회수 리포트 주기 수집(v2.459). |
| `health/` | 2 | 404 | `health/network.js` (1) | 글로벌 네트워크 점검 — 전세계 제어플레인 엔드포인트(vCenter·NSX 매니저)의 중앙에서의 |
| `horizon/` | 8 | 1,481 | `horizon/horizon.js` (3) | Horizon Connection Server 연동 — 라이선스 만료일 확인 전용(가벼운 통합). |
| `hostaccess/` | 4 | 485 | `hostaccess/service.js` (2) | hostaccess/service.js — 호스트 접근 제어 실행 계층(v2.485): 상태 조회 · 계획 · 적용(런타임) · 확정 · 되돌림. |
| `idrac/` | 29 | 5,951 | `idrac/registry.js` (15) | iDRAC registry — the managed list of Dell servers whose power draw we collect |
| `insights/` | 19 | 3,033 | `insights/analysisServers.js` (4) | 서버 분석 공용 — iDRAC 등록부(중앙) + 위임 법인의 원격 인벤토리 병합·법인 귀속·필터(v2.579 에 |
| `intro/` | 5 | 1,967 | `intro/support.js` (0) | GENERATED from dc-runtime/src/*.ts — do not edit. Rebuild with `cd dc-runtime && bun run build`. |
| `inventory/` | 4 | 472 | `inventory/osScanner.js` (3) | 실제 OS 인벤토리 스캐너 — 주기적으로 'DB에 없는(또는 오래된) VM'을 찾아 게스트에서 실제 OS를 읽어 저장. |
| `ipam/` | 18 | 2,808 | `ipam/scanStore.js` (5) | IP 스캔 설정(에이전트별) + 결과 저장소. |
| `linkcheck/` | 12 | 2,547 | `linkcheck/links.js` (4) | linkcheck/links.js — **설정에서 통신 링크를 자동으로 뽑는다**(순수, v2.552). |
| `llm/` | 5 | 546 | `llm/config.js` (2) | Local LLM (Ollama) settings for natural-language search. Stored in |
| `loganalysis/` | 8 | 2,018 | `loganalysis/index.js` (2) | loganalysis/index.js — 설정 › Log › 로그 분석 파사드(v2.583). |
| `logs/` | 3 | 485 | `logs/db.js` (7) | vCenter 이벤트 로그 장기 보관 DB. vCenter는 이벤트를 단기간만 보관하므로, 포탈이 주기적으로 |
| `mail/` | 3 | 416 | `mail/service.js` (3) | mail/service.js — 포탈 공용 메일 발송 진입점 (v2.454). |
| `metrics/` | 6 | 1,157 | `metrics/db.js` (8) | Generic metrics time-series store (host temperature, datastore usage, GPU |
| `mock/` | 2 | 666 | `mock/generator.js` (7) | Deterministic-ish mock data generator that simulates a large, globally |
| `net/` | 4 | 628 | `net/captureHistory.js` (3) | 네트워크 캡처 이력 저장소 — 캡처 결과의 메타·요약·진단을 CONFIG_DIR/capture-history.json에 |
| `nsx/` | 6 | 1,041 | `nsx/store.js` (9) | In-memory NSX aggregator + poller. Mirrors the vCenter store design: each |
| `partfault/` | 13 | 2,246 | `partfault/poller.js` (3) | partfault/poller.js — **중앙 전용**: 스캔 → 전이 → DB → 알림(v2.548). |
| `pdu/` | 11 | 1,687 | `pdu/poller.js` (4) | pdu/poller.js — PDU 주기 수집. |
| `perf/` | 6 | 1,211 | `perf/monitor.js` (13) | perf/monitor.js — 서버 성능 측정기(v2.498). 요청 지연·이벤트 루프 정체·진행 중 요청을 **상시 O(1)** |
| `ping/` | 4 | 762 | `ping/db.js` (2) | Ping 모니터링 시계열 저장소 — 등록 대상별 RTT/도달성 샘플을 별도 SQLite에 보관한다. |
| `portalcheck/` | 7 | 2,221 | `portalcheck/archScan.js` (2) | portalcheck/archScan.js — 특수 기능 › 포탈 점검 › **아키텍처 점검**(v2.614) 판정 코어. |
| `provision/` | 6 | 853 | `provision/jobs.js` (2) | VM provisioning job engine. Holds deployment jobs in memory and runs them |
| `proxy/` | 10 | 1,747 | `proxy/sshExec.js` (23) | Small SSH helper built on ssh2: connect, run commands, and upload files via |
| `publicapi/` | 5 | 747 | `publicapi/allowlist.js` (2) | 외부 공개 API 의 허용 목록 카탈로그 (v2.562) — **순수 모듈**. 판정은 이 파일 하나가 소유한다. |
| `relaycheck/` | 5 | 462 | `relaycheck/poller.js` (3) | relaycheck/poller.js — HAProxy 경로 주기 점검(v2.429). CLAUDE.md 폴러 규약: 재진입 가드 + 동시 점검 제한 + 대상당 타임아웃 + |
| `relaytopo/` | 4 | 672 | `relaytopo/store.js` (3) | relaytopo/store.js — 중계 토폴로지(Main – Edge DVC – IRS) 저장(v2.431, 사용자 요구 '첨부한 표처럼 Main-Edge1-Edge2 구조의 |
| `reports/` | 8 | 741 | `reports/dailyReport.js` (3) | 일일 헬스체크 리포트 발송 스케줄러 — 매일 지정 시각(HH:MM)에 computeHealthReport 결과를 |
| `rma/` | 14 | 2,553 | `rma/jobs.js` (6) | RMA 원격 명령 잡 큐(중앙, 인메모리) — claim→ack 2단계 확인응답(captureJobs.js 패턴 이식) |
| `routes/` | 86 | 21,703 | `routes/capacity.js` (1) | Capacity Advisor API — 포탈/엣지 호스트 리소스 실측·평가·권고 조회. |
| `sanswitch/` | 26 | 5,847 | `sanswitch/registry.js` (7) | sanswitch/registry.js — SAN 스위치 등록부(v2.410). |
| `search/` | 1 | 140 | `search/deepSearch.js` (2) | 심층 검색 — 다조건으로 VM을 검색한다. 1차는 스냅샷 기반(즉시): 게이트웨이·IP/서브넷·OS·전원· |
| `security/` | 16 | 2,833 | `security/secretVault.js` (28) | secretVault.js — 설정 파일 자격증명(비밀번호·SSH 키·토큰)의 저장 방식(평문/암호화) 중앙 모듈(v2.296). |
| `storage/` | 38 | 7,167 | `storage/registry.js` (9) | storage/registry.js — 스토리지 장비 등록부(v2.302). |
| `svcmon/` | 17 | 5,385 | `svcmon/store.js` (10) | 성능점검 대상/폴더 저장소 — `CONFIG_DIR/svcmon.json` 전용 파일(포탈 코어와 분리). |
| `system/` | 2 | 298 | `system/nfsMounts.js` (3) | system/nfsMounts.js — Edge 노드 NFS 마운트 관리(v2.299). |
| `toolcats/` | 2 | 215 | `toolcats/catalog.js` (2) | toolcats/catalog.js — 특수 기능 카테고리 분류 (순수 모듈, v2.455). |
| `tools/` | 12 | 2,082 | `tools/powerOffPoller.js` (3) | tools/powerOffPoller.js — 전원 꺼짐 점검기(v2.484). 설정 주기(기본 6시간)마다 스냅샷의 꺼진 VM 을 |
| `upgrade/` | 9 | 1,292 | `upgrade/manager.js` (6) | Orchestrates the auto-upgrade feature for the running portal: tracks the last |
| `util/` | 65 | 5,448 | `util/numOrNull.js` (75) | `numOrNull` — '읽지 못한 수치' 를 0 으로 둔갑시키지 않는 단일 판정 (v2.561). |
| `vcenter/` | 11 | 3,572 | `vcenter/registry.js` (20) | vCenter registry — read/write the managed list of vCenters in |
| `vmclone/` | 4 | 632 | `vmclone/scheduler.js` (3) | vmclone/scheduler.js — 복제 잡 스케줄러(v2.299). |
| `vmseries/` | 9 | 1,235 | `vmseries/poller.js` (3) | vmseries/poller.js — 실시간 스파이크 주기 수집(v2.510). 기본 50분(사용자 결정), 설정에서 변경. |
| `vmtrack/` | 4 | 1,323 | `vmtrack/db.js` (3) | vmtrack/db.js — VM 수량 추이 전용 시계열 DB(v2.345, 사용자 요구: "별도의 DB 를 만들어서 트래킹"). |

디렉터리 63개 · 파일 709개 · 131,558줄. 대표 파일은 `index.js` 가 있으면 그것, 없으면 그 디렉터리 밖에서 가장 많이 import 되는 파일이고, 설명은 그 파일 머리말의 첫 줄을 그대로 옮긴 것이다(따라서 머리말이 곧 문서다 — 첫 줄을 잘 쓸 것).
<!-- arch-doc:modules:end -->

### 3-3. 라우트 그룹 → 게이트

| 마운트 | 엔드포인트 | 인증 |
|---|---:|---|
| `/api` | 321 | 세션 + OTP 등록 완료. `/tools/*` 는 사용자별 도구 권한 게이트 |
| `/api/admin` | 303 | 세션 + 감사. 대부분 admin, 비밀을 다루면 **설정 소유자** 추가 |
| `/api/svcmon` | 56 | 세션 + `requirePerm('svcmon')` |
| `/api/central` | 49 | **중앙 토큰**(엣지→중앙). 사용자 세션 없음 |
| `/api/remote` | 19 | 세션 + `remote.access` |
| `/api/insights` | 16 | 세션 + `insights` |
| `/api/ping` | 14 | 세션 |
| `/api/v1` | 10 | **API 키**(외부 포탈). 조회 전용 |
| `/api/collector` | 9 | **수집 토큰**(중앙→엣지). 사용자 세션 없음 |
| `/api/auth` | 9 | 공개(로그인 전) |
| `/api/upgrade` | 8 | 세션 + admin |
| `/api/capacity` | 3 | 세션 + admin(라우터가 스스로) |
| `/dl` | 2 | **공개**(업그레이드 소스) |
| `/metrics` | 1 | 선택 토큰 |

전체 목록은 [API.md](API.md).

---

## 4. 데이터 흐름

### 4-1. vCenter 인벤토리 (모든 조회 화면의 뿌리)

```
store.refresh()  ──▶ vcenter/soapClient  ──▶ 28개 vCenter 동시 수집(상한 8)
      │                                        · per-vCenter 타임아웃
      │                                        · 느린 1개가 전체를 막지 않음
      ▼
withRollups()  ─ vCenter별 1회 그룹핑 ─▶  store.snapshot (메모리)
      │
      ├─▶ /api/summary · /api/vms · /api/hosts …  (ETag/304)
      ├─▶ ipam 레저 동기화(워커 스레드 — 메인 루프 블로킹 방지)
      └─▶ 엣지라면 agent/inventoryPush → 중앙 /api/central/inventory
```

- **폴링 주기**는 `POLL_INTERVAL_MS`(기본 30초). 재진입 가드가 있어 이전 주기가 안 끝나면
  이번 틱을 건너뜁니다.
- **응답 캐시**: `util/snapCache.js` LRU(vCenter 수보다 커야 합니다) + 본문 SHA-1 약한 ETag →
  변동 없으면 **304(본문 0바이트)**.

### 4-2. 중앙 ↔ 엣지 (여섯 방향)

| 방향 | 경로 | 인증 | 누가 시작하나 |
|---|---|---|---|
| 엣지 → 중앙 **push** | `POST /api/central/*` (49개) | 중앙 토큰 | 엣지 워커(주기) |
| 엣지 → 중앙 **설정 pull** | `GET /api/central/*-config` | 중앙 토큰 | 엣지(주기) |
| 중앙 → 엣지 **데이터 pull** | `GET /api/collector/*` (9개) | 수집 토큰 | 중앙 `collector/puller.js`(60초) |
| 중앙 → 엣지 **잡 큐** | `/api/central/*-jobs` → `*-result` | 중앙 토큰 | 중앙이 쌓고 **엣지가 인출** |
| 엣지 ↔ 엣지 | 통신 점검만 | 수집 토큰 | 엣지 워커 |
| 중앙 → vCenter/장비 | 직접 | 장비 자격증명 | 중앙 폴러(위임 안 된 것만) |

**왜 pull 인가**: 엣지는 NAT·폐쇄망 뒤에 있습니다. 중앙이 접속하려면 방화벽을 열어야 하고,
법인 28곳이면 28개의 인바운드 규칙이 됩니다. 그래서 **설정은 엣지가 당겨 가고**, 즉시성이
필요한 작업은 **잡 큐**로 만들었습니다(엣지가 인출 → 실행 → 결과 회신).

**잡 큐의 2단계 확인응답(claim → ack)**: 인출 즉시 큐에서 지우면 엣지가 인출 직후 재시작했을
때 요청이 영영 사라집니다(사용자는 버튼을 눌렀는데 아무 일도 안 일어난 것으로 보입니다).
그래서 인출은 `claim`(기한 있음)이고 완료 회신이 와야 `ack` 합니다. 기한이 지나면 재수확합니다.
⚠ 예외는 **RMA(원격 명령)** 로, 재시도하면 서비스 재시작이 두 번 실행되므로 **재인출하지
않고 오류로 종결**합니다.

**push 의 3대 규약**(하나라도 빠지면 데이터가 조용히 사라집니다)

1. **gzip + 청크** — 요청당 700KB 단위.
2. **중앙에 `BIG_JSON` 등록** — `express.json` 기본 1MB 는 **압축 해제 후 길이** 기준이라
   gzip 만으로는 413 이 해결되지 않습니다. 413 은 재시도 대상이 아니라 **그 법인 데이터의
   조용한 전량 소실**입니다.
3. **0건이어도 상태를 보낸다** — 보낼 것이 없다고 조기 반환하면 중앙은 '보고가 없다' 와
   '보고할 것이 없다' 를 구분할 수 없어 화면이 "기다리면 됩니다" 라는 거짓을 말합니다.

### 4-3. 시계열 (SQLite 20종)

| DB | 무엇 | 크기 특징 |
|---|---|---|
| `host-temp.db` · `idrac-power.db` | ESXi 호스트 온도 · iDRAC 전력 | **가장 큽니다**(수십 GB) |
| `storage-history.db` | 스토리지 용량 — 원시 90일 + **일 롤업 5년** | 2단 보존 |
| `bm-usage.db` | 베어메탈 사용률 — 지표를 **열로** 둠 | 행 단위로 두면 9배 |
| `link-check.db` | 통신 점검 — 표본 + 상세(실패·변화만) + 일 롤업 | 3단 |
| `part-faults.db` | 부품 장애 — **전이만** 적재 | 전량이면 연 10억 행 |
| `vm-track.db` | VM 수량·DS 사용량 — **변경분만** | |
| `ipam.db` | IP 대장 — **외부 프로그램이 직접 읽습니다** | ⚠ WAL 전환 금지 |
| 그 외 | `capacity` `curuser` `dirusage` `guest-disk` `horizon-sessions` `pdu` `ping-monitor` `rma-history` `rma-tests` `san-health` `sanswitch-perf` `vcenter-logs` | |

**공통 규약**

- `WAL + synchronous=NORMAL + busy_timeout=3000` (단건 insert 5ms → 0.01ms 실측).
  **`ipam.db` 만 예외** — 외부 리더 호환 때문에 저널 기본값 유지.
- 파일 권한 **0600**, 열자마자 `chmodSync`.
- **prune 스로틀**: 매 샘플 DELETE 스캔 금지 — N틱마다 1회이고 `(++tick % N) === 0` 형태여야
  합니다(`% N === 1` 은 **기동 첫 틱에 즉시 참**이라 보존기간을 줄이고 재시작하면 차액을
  한 번에 지웁니다).
- **`ts` 단독 인덱스** — `DELETE WHERE ts<?` 는 복합 인덱스로는 탈 수 없습니다.
- ⚠ **aggregate 를 한 쿼리에 둘 이상 쓰지 마세요.** 518만 행 실측: `MIN(ts)` 단독 0.01ms,
  `MIN(ts), MAX(ts)` **377ms**(인덱스 전체 스캔). '최신 1건씩' 은 `GROUP BY + MAX(ts)`(702ms)
  대신 **최신값 전용 테이블**(0.53ms)로 만듭니다.

### 4-4. 주기 실행(폴러·워커) 80개

전부 같은 네 가지 규약을 따릅니다. **새 폴러를 만들면 이 넷을 반드시 갖추세요.**

1. **재진입 가드** — 이전 주기가 간격을 넘기면 이번 틱을 건너뜁니다. 같은 작업의
   **수동 실행 API 도 같은 가드를 공유**합니다(연타가 장비 부하를 곱하지 않게).
2. **동시성 상한** — 28개 vCenter·수백 장비를 한꺼번에 치면 CPU 가 순간 100% 가 됩니다.
3. **장비당 시한이 세션을 실제로 끊는다** — `Promise.race` 로 결과만 포기하면 SSH 세션이
   남은 명령을 끝까지 돌려(최대 ~8.5분) 동시성 상한이 실효를 잃습니다.
4. **주기는 중앙 배포값** — 모듈 로드 시 `const INTERVAL = env` 로 굳히면 중앙에서 바꿔도
   **엣지를 재시작해야** 먹습니다. `startAdaptiveTimer` 로 매 틱 재조회·재무장합니다.

**인증 실패(401/403)는 주기 수집을 멈춥니다**(`util/authGuard.js`). 틀린 비밀번호를 5분마다
반복하면 **계정이 잠깁니다.** 멈추는 것은 자격증명 거부뿐이고(타임아웃으로 멈추면 일시 장애가
수집을 영구 정지시킵니다), 자격증명이 바뀌면 자동 재개하며 **수동 실행은 막지 않습니다.**

### 4-5. 요청 추적과 로그 분석 (v2.583)

**요청 ID — '불러오는 중…' 을 누가 지연시키는가**

```
브라우저 api.js ── X-Request-Id: <ID> ──▶ index.js 요청 계측 미들웨어
  (perfClient.js 가 ID 생성)                 · 형식 검사(perf/requestId.js sanitizeRid) — 안 맞으면 서버가 새로 만든다
                                              · 응답 헤더 X-Request-Id 로 되돌려 준다
                                              · perf/monitor.js 진행 중 목록·최근 완료 기록·느린 요청·hang 기록에 ID
                                              · 라이브 로그 줄 끝에 `#<ID>`
화면(Loading·GlobalProgress → components/TaskWho.jsx)
  └ 오래 기다리는 요청만 GET /api/perf/req-status?ids= (5초에 1번)
       → monitor.requestStatus: processing(서버 처리 중) / done(이미 응답) / unknown(서버에 기록 없음)
```

- ID 는 **식별용이지 권한 근거가 아닙니다** — 상태 조회는 그 요청을 보낸 계정만(관리자는 전부) 봅니다.
- `unknown` 은 '서버에 도달하지 않음 · 서버 재시작 · 최근 완료 기록에서 밀려남' 을 구분할 수 없어 **단정하지 않습니다.**
- 같은 ID 를 설정 › Log › 서버 성능 측정의 '요청 ID 찾기' 와 진단·로그의 라이브 로그에서 찾을 수 있습니다.

**로그 분석 — `loganalysis/`**

```
logbuffer.js ── addLogTap ──▶ loganalysis/live.js  시간 버킷 누적(최대 7일) → log-analysis-stats.json(10분·종료 시)
링버퍼 1,000줄 / journalctl -u <PORTAL_SYSTEMD_UNIT> / 붙여넣기 / 엣지 로그 보관분(central/edgeLogStore)
        └──────────────▶ parse.js → engine.js(rules.js 규칙 · template.js 문장 틀) → 보고서
                                  └─▶ GET·POST /api/admin/log-analysis* (adminOnly + 전체 범위)
```

- 원천 5가지를 **같은 엔진**으로 분석합니다(누적 · 최근 로그 · 서비스 저널 · 붙여넣기 · 엣지 로그).
- 저널은 셸을 거치지 않고 고정 인자로 읽으며, 서비스 계정이 `systemd-journal` 그룹이 아니면 읽지 못한다는 사실을 화면이 말합니다.
- 붙여넣기 경로(`/api/admin/log-analysis/paste`)는 `BIG_JSON` 에 등록돼 있습니다(8MB 한도).

---

## 5. 인증·인가 (네 층)

```
① 세션 토큰   authMiddleware → resolveTokenUser (tokenVersion·최신 역할 반영)
② OTP 등록    requireEnrolled — 강제 등록 미완료 세션 차단
③ 역할·권한   requireRole / requirePerm  (auth/permissions.js 매트릭스)
④ 데이터 범위 scopedVcenterIds — 사용자의 vCenter 집합과 교집합
```

- **`null` 은 '제한 없음'** 입니다. 빈 집합으로 읽으면 전체 범위 계정이 아무것도 못 봅니다.
- **범위 밖 단건은 403 이 아니라 404**(존재 은닉). 조회는 되지만 **쓰기 범위** 밖이면 403.
- **기계 인증은 별도 층**입니다 — 수집 토큰 / 중앙 토큰(엣지별 개별 토큰은 해시만 보관) /
  공개 API 키. 세션과 섞지 않습니다.

비밀은 `security/secretVault.js` 가 봉인하고(`SECRET_FILES` 25종 — v2.583 기준, 목록이 진실의 원천), 파일은 **원자적 쓰기 +
손상 시 `.corrupt.<ts>` 보존** 입니다. 로드 catch 가 조용히 빈 값을 돌려주면 **다음 저장이
온전했던 원본을 덮어씁니다.**

되돌리면 안 되는 보안 규칙 전체는 `server/CLAUDE.md` 에 있습니다.

---

## 6. 웹 (`web/src`)

| | |
|---|---|
| 스택 | React 18 + Vite · 해시 라우팅 · `styles.css` 변수 |
| 규모 | 376 파일 · 76,675줄 |
| 셸 | **V4 하나**(`version_4/`). 셸을 더 만들지 않습니다 — 과거 두 벌이 58~87% 동일해 같은 버그를 두 곳에 고쳐야 했습니다 |
| 데이터 | `usePolling` (기본 15초, 304 지원). 무거운 API 는 **폴링 금지**(버튼 실행) |
| 표 | 전부 공용 `STable`(헤더 클릭 정렬) |

**프론트 회귀 방지 4대 규칙**

1. **훅은 조기 return 위에** — 뒤에 추가하면 렌더 간 훅 개수가 달라져 React #310 으로
   화면 전체가 크래시합니다(실제 사고).
2. **403 은 오류로 표시하지 않습니다** — 정책대로 동작한 접근 제어입니다. 공용 `ErrorBox` 가
   `AccessDenied` 로 자동 전환합니다.
3. **판정·문구는 순수 모듈에** — 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가
   불가합니다. 그래서 `*Text.js` 순수 모듈 + vitest 로 고정합니다.
4. **긴 설명은 배너·각주에 한 번만** — 행마다 반복하면 같은 문단이 화면을 덮습니다.

---

## 7. 문서가 자기 자신을 지키는 방법

이 저장소는 문서 네 개를 **소스에서 생성**합니다. 개수는 릴리스마다 바뀌므로 여기 적지 않습니다 — 각 생성 문서의 머리말이 최신 값입니다.

| 문서 | 생성기 | 항목 |
|---|---|---|
| [ENV.md](ENV.md) | `scripts/env-doc.mjs` | `server/src` 가 읽는 환경변수 |
| [CONFIG-FILES.md](CONFIG-FILES.md) | `scripts/config-doc.mjs` | 설정·데이터 파일 |
| [API.md](API.md) | `scripts/api-doc.mjs` | 엔드포인트 |
| `web/public/THIRD-PARTY-NOTICES.txt` | `scripts/third-party-notices.mjs` | 번들·패키지에 실리는 오픈소스 고지(v2.576) |

⚠ **왜 생성인가**: 손으로 적은 목록은 조용히 낡습니다. 실제로 겪은 사고가 있습니다 —
정규식이 못 잡는 형태가 생겨 **환경변수 28개와 가장 큰 DB 2개가 문서에서 사라졌는데,
생성은 성공했으므로 CI 도 통과**했습니다. 그래서 지금 생성기들은 **못 읽은 것이 있으면
문서를 쓰지 않고 종료코드 1** 로 실패하고, 스캐너가 인식해야 할 형태는 회귀 테스트가
고정합니다(`server/test/docsGen2452.test.js` · `apiDoc2563.test.js`).

CI 는 `--check` 로 문서가 최신인지 검사합니다(경고만 — 릴리스를 막지는 않습니다). **라우트·환경변수·설정 파일·의존성을
바꾸면 생성기를 다시 돌리세요.**

---

## 8. 더 읽을 것

| 문서 | 언제 |
|---|---|
| `CLAUDE.md`(루트) | **"왜 이렇게 만들었나"** · 되돌리면 안 되는 규칙 · 실제 사고 기록 |
| `server/CLAUDE.md` | 보안 불변조건 전부(TLS·RBAC·토큰·scope·OTP·WS) |
| [NETWORK-COMMS-FIREWALL.md](NETWORK-COMMS-FIREWALL.md) | 통신 경로 82종 · 방화벽 오픈 |
| [EDGE-SETUP.md](EDGE-SETUP.md) | 엣지 구성 실무 |
| [SVCMON-ARCHITECTURE.md](SVCMON-ARCHITECTURE.md) | 1만 대 규모 점검의 용량 산정 |
| [ARCH-HEAVY-JOB-ISOLATION.md](ARCH-HEAVY-JOB-ISOLATION.md) | 무거운 작업 격리 |
