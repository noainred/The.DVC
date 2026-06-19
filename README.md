# VMware Global Monitoring Portal

전 세계 데이터센터에 분산 운영 중인 다수의 **VMware vCenter** 인프라를 하나의 포탈에서
통합 모니터링하는 대시보드입니다. 각 사이트의 **VM · ESXi 호스트 · 스토리지(데이터스토어)
· 네트워크 · 알람** 정보를 수집·집계하여 글로벌 단일 화면에서 보여줍니다.

> 실제 vCenter 자격증명이 없어도 **현실적인 목(mock) 데이터로 즉시 실행**됩니다.
> 실 환경에서는 `config/vcenters.json`에 vCenter 목록만 등록하면 됩니다.

## 주요 기능

- **로그인 인증** — 사용자 로그인 후에만 포탈/대시보드 접근 가능. 외부 패키지 없이
  Node 내장 `crypto`로 scrypt 비밀번호 해싱 + HS256 JWT 세션 토큰을 구현.
  모든 데이터 API는 토큰이 있어야 접근 가능(401 차단). 역할(admin/operator/viewer) 지원.
- **vCenter 대시보드** — 등록된 **모든 vCenter를 카드 형태로 한눈에** 표시(상태·위치·버전,
  호스트/VM 수, CPU/메모리/스토리지 사용률, 알람). 카드 클릭 시 해당 vCenter로 드릴다운.
- **통합 서머리** — 분산된 모든 vCenter 자원을 **하나로 SUM** 한 페이지. 전체 VM/호스트/
  클러스터/데이터스토어/네트워크 개수, 물리 CPU·메모리·스토리지 용량과 사용량, VM 할당
  합계(vCPU·RAM·프로비저닝 스토리지)와 **오버커밋 비율**, Guest OS 분포, vCenter별 기여도
  합계 표(총합 행 포함). 리전/vCenter 스코프 적용 가능.
- **시작 화면 설정** — 로그인 후 처음 보여줄 페이지를 사용자가 선택(브라우저에 저장).
- **진단·로그(관리자)** — vCenter **연결 실패 원인**(DNS/연결거부/타임아웃/인증서/인증 등
  원인별 한국어 힌트)과 **실시간 서버 로그 뷰어**를 포탈 안에서 확인. vCenter 대시보드 카드와
  vCenter 관리 화면에도 실패 이유가 표시됩니다.
- **자동 업그레이드(옵트인)** — **GitHub `download/versions.json` 을 주기적으로 모니터링**
  하다가 새 버전이 올라오면 받아서 적용하고 프로세스를 재시작(re-exec). 로컬 감시 폴더의
  번들(`vmware-portal-<버전>.tar.gz`)도 지원. 현재보다 새 버전만 검증 후 적용, 기존 코드는
  백업(롤백 가능), 경로 탈출·아카이브 폭탄 방지. 표준 라이브러리만 사용(내장 `zlib` + 자체
  tar/zip 파서). 자가 업그레이드 후 등록된 엣지에도 번들 푸시. 관리자 전용 UI/API로 제어.
  - 감시 경로(기본값): `https://raw.githubusercontent.com/noainred/The.DVC/<branch>/download/versions.json`
    (`UPGRADE_REMOTE_BASE` 로 변경, 사설 레포는 `UPGRADE_TOKEN`)
- **글로벌 개요 대시보드** — 전세계 KPI(vCenter/호스트/VM/CPU/메모리/스토리지/알람),
  세계지도 위 데이터센터 위치 및 상태 마커, 리전(Americas/EMEA/APAC)별 롤업, 차트.
- **세계 지도** — 사이트별 마커 색상으로 정상/경고/위험 상태 표시, 호버 시 상세 요약,
  클릭 시 해당 vCenter로 드릴다운.
- **리소스 탐색** — 호스트 / 가상머신 / 스토리지 / 네트워크 / 알람을 정렬·검색·필터
  (리전, vCenter, 텍스트)로 탐색.
- **탐색·랭킹(Find)** — 자원을 가장 많이 사용하는 VM·호스트·데이터스토어 **Top N 랭킹**
  (CPU/메모리 사용률, vCPU/RAM/디스크 할당량, VM 수, 데이터스토어 사용률)과
  **VM 사양별 검색**(최소 vCPU·RAM·디스크, CPU/메모리 사용률 임계값, Guest OS, 전원 상태).
- **실시간 갱신** — 백엔드가 주기적으로 모든 vCenter를 폴링해 스냅샷을 집계하고,
  프론트엔드는 일정 주기로 자동 새로고침.
- **장애 내성** — 한 vCenter가 응답하지 않아도 포탈 전체는 정상 동작(해당 사이트만
  `unreachable` 표시 + 알람).

## 아키텍처

```
┌──────────────┐    REST(폴링)   ┌─────────────────────┐
│  vCenter A   │◀───────────────│                     │
│  vCenter B   │◀───────────────│  Aggregation API    │   집계 스냅샷   ┌──────────────┐
│  vCenter C   │◀───────────────│  (Node/Express)     │──────────────▶│  React 대시보드 │
│   ...전세계   │                │  in-memory store    │   /api/*      │  (Vite)      │
└──────────────┘                └─────────────────────┘               └──────────────┘
```

- **server/** — Express API. `store.js`가 모든 vCenter를 `POLL_INTERVAL_MS`마다 폴링하여
  정규화된 글로벌 스냅샷을 메모리에 유지. HTTP 요청은 느린/장애 vCenter에 블로킹되지 않음.
  - `vcenter/restClient.js` — vSphere Automation REST API(7.0/8.0) 클라이언트
    (`/api/session`, `/api/vcenter/host|vm|datastore|network|cluster`).
  - `mock/generator.js` — 9개 글로벌 사이트 규모의 현실적 목 데이터 생성기.
- **web/** — React + Vite 대시보드. 다크 NOC 테마, 세계지도(react-simple-maps), 차트(recharts).

## 빠른 시작

```bash
# 1) 의존성 설치 (루트 + server + web)
npm run install:all

# 2) 개발 모드 (API :4000, 웹 :5173 동시 실행, 핫리로드)
npm run dev
#    → 브라우저에서 http://localhost:5173

# 또는 단일 포트(프로덕션) 모드
npm run build      # 웹 빌드 → web/dist
npm start          # API가 web/dist를 함께 서빙 → http://localhost:4000
```

## 오프라인 설치 (Rocky Linux 9, air-gapped)

인터넷이 없는 Rocky 9 서버에는 Node 런타임·서버 의존성·빌드된 웹 UI를 모두 포함한
자체 완결형 패키지를 만들어 설치합니다(타깃에 인터넷·npm·컴파일러 불필요).

```bash
# 인터넷 되는 곳에서 패키지 빌드
packaging/offline/build-package.sh           # → dist-offline/vmware-portal-offline-<버전>-el9-x64.tar.gz

# 오프라인 Rocky 9 서버에서 설치 (systemd 서비스 등록)
tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz && cd vmware-portal-offline-*
sudo ./install.sh --port 4000
```

자세한 내용은 `packaging/README.md` 및 `packaging/offline/OFFLINE-INSTALL.md` 참고.

## vCenter 등록 · 관리

포탈에서 직접(관리자 전용) vCenter를 등록/수정/삭제하고 연결을 테스트할 수 있습니다:

- 웹 UI: 상단 **vCenter 관리** 탭(admin 역할) → “+ vCenter 추가” → 호스트/계정/위치 입력 →
  **연결 테스트** 후 저장. 저장 시 즉시 재수집됩니다.
- 저장 위치: `server/config/vcenters.json` (0600, gitignore). 비밀번호는 API 응답에서 마스킹됩니다.
- API(admin): `GET/POST /api/admin/vcenters`, `PUT/DELETE /api/admin/vcenters/:id`,
  `POST /api/admin/vcenters/test`.

> 등록한 vCenter의 실제 수집은 서버가 `DATA_SOURCE=live`(또는 `auto`)일 때 반영됩니다.
> `mock` 모드에서는 대시보드에 데모 데이터가 표시됩니다.

직접 파일로 등록하려면(또는 대량 등록):

## 실제 vCenter 연결

기본은 목 데이터(`DATA_SOURCE=mock`)입니다. 실 환경 연결:

1. 모니터링할 vCenter 목록 작성:
   ```bash
   cp server/config/vcenters.example.json server/config/vcenters.json
   # host / username / password / location(region 포함) 편집
   ```
   > `vcenters.json`은 `.gitignore`에 포함되어 커밋되지 않습니다. 운영 환경에서는
   > 환경변수나 시크릿 매니저 사용을 권장합니다. 읽기 전용 모니터링 계정 사용 권장.

2. 데이터 소스 지정 후 실행:
   ```bash
   DATA_SOURCE=live  npm start     # 등록된 실제 vCenter만 조회
   DATA_SOURCE=auto  npm start     # 실패한 vCenter는 목 데이터로 대체(데모/혼합용)
   ```

> **메트릭 수집 방식**: 호스트/VM의 CPU·메모리 **용량과 실시간 사용률**, 데이터스토어
> 사용량은 vSphere **REST 목록 API로는 제공되지 않으므로**, 기본적으로 vim25 **SOAP API**
> (`/sdk`, PropertyCollector)로 수집합니다. vCenter의 SOAP 포트(443)와 모니터링 계정의
> 읽기 권한이 필요합니다. SOAP 연결 실패 시 자동으로 REST 목록 API로 폴백합니다
> (이 경우 호스트 CPU/메모리 사용률은 표시되지 않을 수 있습니다). `VC_SOAP_METRICS=false`
> 로 끌 수 있습니다.

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4000` | API 포트 |
| `CONFIG_DIR` | `server/config` | 사용자 설정(vcenters.json/users.json/upgrade.json) 저장 위치. 오프라인 설치 시 `/etc/vmware-portal` 로 설정되어 **업그레이드해도 보존**됨 |
| `DATA_SOURCE` | `mock` | `mock` / `live` / `auto` |
| `POLL_INTERVAL_MS` | `30000` | vCenter 폴링 주기(ms) |
| `VC_TLS_REJECT_UNAUTHORIZED` | `false` | 사설 vCenter 자체서명 인증서 거부 여부 (`true`면 검증) |
| `VC_SOAP_METRICS` | `true` | 호스트/VM 실측 메트릭을 vim25 SOAP로 수집(끄면 REST만 사용 — CPU/메모리 사용률 미수집) |
| `AUTH_ENABLED` | `true` | 로그인 인증 사용 여부 (`false`면 인증 없이 접근) |
| `AUTH_SECRET` | (랜덤) | JWT 서명 시크릿. **운영 환경에서는 반드시 지정** (미지정 시 재시작마다 토큰 무효화) |
| `AUTH_TOKEN_TTL` | `8h` | 세션 토큰 유효기간 (`30m`, `8h`, `7d`, 또는 초) |
| `DEFAULT_ADMIN_PASSWORD` | `admin123` | `users.json` 미존재 시 시드되는 기본 admin 비밀번호 |

### 로그인 / 사용자 관리

기본 데모 계정은 **`admin` / `admin123`** 입니다(`users.json`이 없으면 자동 시드).
운영 환경에서는 사용자 파일을 만들어 관리하세요:

```bash
cp server/config/users.example.json server/config/users.json
# 비밀번호 해시 생성 (server/ 디렉터리에서 실행)
cd server && node -e "import('./src/auth/auth.js').then(m=>console.log(m.hashPassword(process.argv[1])))" 'YourPassword'
# 출력된 scrypt$... 값을 users.json의 passwordHash에 붙여넣기
```

> `users.json`은 `.gitignore` 처리되어 커밋되지 않습니다. 운영 시 `AUTH_SECRET`도 반드시 설정하세요.

## API 엔드포인트

| 메서드 · 경로 | 설명 |
|---------------|------|
| `POST /api/auth/login` | 로그인 → JWT 토큰 발급 (`{username, password}`) |
| `GET /api/auth/me` | 현재 사용자(토큰 필요) |
| `GET /api/auth/config` | 인증 활성화 여부 (공개) |
| `GET /api/health` | 상태 · 데이터 소스 · 갱신시각 |
| `GET /api/overview` | 글로벌 KPI + 리전별 + 사이트별 롤업 |
| `GET /api/vcenters` | vCenter(사이트) 목록 + 사이트별 메트릭 |
| `GET /api/summary` | 모든 vCenter 자원 통합 합계(개수·물리용량·할당·오버커밋·OS분포·사이트별 기여도). `?vcenterId=&region=` |
| `GET /api/hosts` | ESXi 호스트 (`?vcenterId=&region=&state=&q=`) |
| `GET /api/vms` | 가상머신. 사양 검색: `?vcpuMin=&vcpuMax=&ramMinGB=&ramMaxGB=&diskMinGB=&diskMaxGB=&cpuUsageMin=&memUsageMin=&os=&powerState=&sortBy=&order=&limit=` |
| `GET /api/top` | 자원 최다 사용 Top N (VM/호스트/데이터스토어). `?vcenterId=&region=&limit=` |
| `GET /api/datastores` | 데이터스토어 |
| `GET /api/networks` | 네트워크(포트그룹/분산스위치) |
| `GET /api/alarms` | 알람 (`?severity=critical|warning|info`) |

공통 필터: `vcenterId`, `region`, `q`(이름/IP/OS 등 텍스트 검색).

> `/api/auth/*`를 제외한 모든 엔드포인트는 `Authorization: Bearer <token>` 헤더가 필요합니다
> (`AUTH_ENABLED=false`인 경우 제외).

### 자동 업그레이드 (관리자 전용)

옵트인 기능으로, 기본은 꺼져 있습니다. 환경변수로 활성화합니다:

| 변수 | 설명 |
|------|------|
| `UPGRADE_ENABLED` | `true` 면 기능 활성화 |
| `UPGRADE_WATCH_DIR` | 새 번들(`vmware-portal-<ver>.tar.gz/.zip`)을 감시할 로컬 폴더 |
| `UPGRADE_INSTALL_DIR` | 교체 대상(실행 중 코드) 경로 — 적용하려면 필수 |
| `UPGRADE_PACKAGE_NAME` | 번들 내 최상위 패키지 디렉터리명 (기본 `vmware-portal`) |
| `UPGRADE_REMOTE_BASE` | 원격 소스 base(`versions.json` 포함 디렉터리) |
| `UPGRADE_TOKEN` | 사설 원격 소스용 PAT |
| `UPGRADE_POLL_INTERVAL_MS` | 백그라운드 확인 주기(ms), `0`이면 끔 |
| `UPGRADE_AUTO_APPLY` | `true` 면 새 버전 발견 시 자동 적용+재시작 |
| `UPGRADE_EDGES` | 자가 업그레이드 후 번들을 푸시할 엣지 목록 JSON `[{"url","token"}]` |

관리자 API (모두 admin 역할 필요): `GET/PUT /api/upgrade/settings`,
`GET /api/upgrade/status`, `POST /api/upgrade/check`,
`POST /api/upgrade/apply` (`{source,restart}`), `POST /api/upgrade/restart`,
`POST /api/upgrade/bundle` (엣지가 받는 번들 푸시 엔드포인트).

**포탈에서 직접 설정**: 관리자 **업그레이드** 탭에서 인터넷 업그레이드(원격 소스 URL·토큰·
확인 주기·자동 적용)와 수동 업그레이드(감시 폴더)를 GUI로 편집·저장하고, 확인·적용·재시작까지
할 수 있습니다. 편집한 설정은 `config/upgrade.json`(gitignore)에 저장되어 재시작 후에도 유지되며,
환경변수는 초기 기본값으로 사용됩니다. 실행 중 버전은 상단 바에 배지로 표시됩니다.

> 안전장치: 더 새 버전만 적용, 아카이브 패키지·버전 검증, 경로 탈출 방지, zip/tar 폭탄 상한,
> 기존 코드 백업(원자적 스왑·롤백). 재시작은 같은 인자로 프로세스를 re-exec 합니다.

## 확장 아이디어

- 시계열 메트릭 저장(예: InfluxDB/Prometheus) 및 추세 차트
- 알람 인입 시 Slack/이메일 알림 연동
- 인증/RBAC, 멀티 테넌시
- vROps / NSX / vSAN 상세 메트릭 통합
- 용량 예측 및 이상 탐지
