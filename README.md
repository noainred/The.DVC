# VMware Global Monitoring Portal

전 세계 데이터센터에 분산 운영 중인 다수의 **VMware vCenter** 인프라를 하나의 포탈에서
통합 모니터링하는 대시보드입니다. 각 사이트의 **VM · ESXi 호스트 · 스토리지(데이터스토어)
· 네트워크 · 알람** 정보를 수집·집계하여 글로벌 단일 화면에서 보여줍니다.

> 실제 vCenter 자격증명이 없어도 **현실적인 목(mock) 데이터로 즉시 실행**됩니다.
> 실 환경에서는 `config/vcenters.json`에 vCenter 목록만 등록하면 됩니다.

## 주요 기능

- **글로벌 개요 대시보드** — 전세계 KPI(vCenter/호스트/VM/CPU/메모리/스토리지/알람),
  세계지도 위 데이터센터 위치 및 상태 마커, 리전(Americas/EMEA/APAC)별 롤업, 차트.
- **세계 지도** — 사이트별 마커 색상으로 정상/경고/위험 상태 표시, 호버 시 상세 요약,
  클릭 시 해당 vCenter로 드릴다운.
- **리소스 탐색** — 호스트 / 가상머신 / 스토리지 / 네트워크 / 알람을 정렬·검색·필터
  (리전, vCenter, 텍스트)로 탐색.
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

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4000` | API 포트 |
| `DATA_SOURCE` | `mock` | `mock` / `live` / `auto` |
| `POLL_INTERVAL_MS` | `30000` | vCenter 폴링 주기(ms) |
| `VC_TLS_REJECT_UNAUTHORIZED` | `false` | 사설 vCenter 자체서명 인증서 거부 여부 (`true`면 검증) |

## API 엔드포인트

| 메서드 · 경로 | 설명 |
|---------------|------|
| `GET /api/health` | 상태 · 데이터 소스 · 갱신시각 |
| `GET /api/overview` | 글로벌 KPI + 리전별 + 사이트별 롤업 |
| `GET /api/vcenters` | vCenter(사이트) 목록 + 사이트별 메트릭 |
| `GET /api/hosts` | ESXi 호스트 (`?vcenterId=&region=&state=&q=`) |
| `GET /api/vms` | 가상머신 (`?powerState=&limit=` 등) |
| `GET /api/datastores` | 데이터스토어 |
| `GET /api/networks` | 네트워크(포트그룹/분산스위치) |
| `GET /api/alarms` | 알람 (`?severity=critical|warning|info`) |

공통 필터: `vcenterId`, `region`, `q`(이름/IP/OS 등 텍스트 검색).

## 확장 아이디어

- 시계열 메트릭 저장(예: InfluxDB/Prometheus) 및 추세 차트
- 알람 인입 시 Slack/이메일 알림 연동
- 인증/RBAC, 멀티 테넌시
- vROps / NSX / vSAN 상세 메트릭 통합
- 용량 예측 및 이상 탐지
