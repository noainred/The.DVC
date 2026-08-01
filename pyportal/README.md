# Global DC Service Hub (Python)

전세계 데이터센터 운영에 쓰는 **여러 서비스 포탈을 한 화면에 모아 두는 바로가기 허브**입니다.
설정 화면에서 **이름과 URL** 두 가지만 입력하면 대시보드에 바로가기 카드가 즉시 생성됩니다.

> 기존 VMware Global Monitoring Portal(Node/React)과 **완전히 분리된 별도 페이지·별도 프로세스**입니다.
> 포트만 다르게 띄우면 되고, 서로의 데이터·인증에 영향을 주지 않습니다.

---

## 1. 특징

| 항목 | 내용 |
|---|---|
| 언어 | **Python 3.9+** (표준 라이브러리만 — pip 설치 불필요) |
| 프런트엔드 | 순수 HTML/CSS/JS (빌드 도구·CDN·외부 폰트 없음 → **오프라인 동작**) |
| 저장 | JSON 파일 1개 (`data/shortcuts.json`), 원자적 쓰기 + 손상 파일 보존 |
| 실행 | `python3 app.py` 한 줄 |

### 화면 4개

1. **서비스 바로가기** — 즐겨찾기 · 카테고리 필터 · 검색 · 카드 그리드(열기/즐겨찾기/수정/삭제)
2. **28개 센터 현황** — 리전 필터, 좌표 기반 사이트 지도, 센터 상세 + 그 센터 전용 링크
3. **링크 상태 점검** — 서버가 각 URL 에 실제 요청을 보내 응답 코드·지연 측정(동시 실행)
4. **설정** — 바로가기 생성/수정/삭제, JSON 내보내기·가져오기, 기본값 복원

---

## 2. 실행

```bash
cd pyportal
python3 app.py                  # http://<서버>:8095
```

옵션(환경변수 또는 인자):

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `HUB_HOST` | `0.0.0.0` | 바인드 주소. 로컬만 열려면 `127.0.0.1` |
| `HUB_PORT` | `8095` | 포트 |
| `HUB_DATA_DIR` | `pyportal/data` | `shortcuts.json` 저장 위치 |
| `HUB_TOKEN` | (없음) | 설정하면 **모든 `/api` 요청에 토큰 필요**. 화면은 최초 1회 토큰을 물어보고 브라우저에 보관 |
| `HUB_HEALTH_TIMEOUT` | `4.0` | 링크 점검 1건 타임아웃(초) |
| `HUB_HEALTH_CONCURRENCY` | `8` | 링크 점검 동시 실행 수 |
| `HUB_HEALTH_TLS_VERIFY` | `true` | 링크 점검 시 TLS 인증서 검증. 사내 자체서명 때문에 끄려면 `false`(이 요청에만 적용, 전역 설정은 건드리지 않음) |
| `HUB_HEALTH_ALLOW_PRIVATE` | `true` | 사설 대역(10/172.16/192.168) 점검 허용 |
| `HUB_MAX_BODY` | `1048576` | 요청 본문 상한(바이트) |

```bash
# 예: 9000 포트 + 토큰 보호 + 설정을 /etc 아래 보관
HUB_PORT=9000 HUB_TOKEN=change-me HUB_DATA_DIR=/etc/dc-service-hub python3 app.py
```

---

## 3. systemd 로 상시 구동 (Rocky Linux 9)

```bash
sudo mkdir -p /opt/dc-service-hub /etc/dc-service-hub
sudo cp -r pyportal/* /opt/dc-service-hub/
sudo useradd -r -s /sbin/nologin dchub 2>/dev/null || true
sudo chown -R dchub:dchub /etc/dc-service-hub

sudo cp /opt/dc-service-hub/systemd/dc-service-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dc-service-hub
sudo systemctl status dc-service-hub

# 방화벽
sudo firewall-cmd --permanent --add-port=8095/tcp && sudo firewall-cmd --reload
```

`/etc/systemd/system/dc-service-hub.service` 의 `Environment=` 줄에서 포트·토큰을 조정합니다.

---

## 4. REST API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/meta` | 버전·카테고리 목록·리전·개수 |
| GET | `/api/shortcuts` | 바로가기 전체 |
| POST | `/api/shortcuts` | 생성 (`name`, `url` 필수) |
| PUT | `/api/shortcuts/<id>` | 부분 수정 |
| DELETE | `/api/shortcuts/<id>` | 삭제 |
| POST | `/api/shortcuts/reset` | 기본값 복원 |
| GET | `/api/datacenters` | 28개 센터 + 집계 |
| POST | `/api/health/check` | 링크 점검(`{}` 전체 / `{"ids":[…]}` / `{"urls":[…]}`) |
| GET | `/api/export` | 바로가기 JSON 다운로드 |
| POST | `/api/import` | JSON 통째로 교체 |

```bash
curl -s localhost:8095/api/shortcuts | head
curl -s -X POST localhost:8095/api/shortcuts \
  -H 'Content-Type: application/json' \
  -d '{"name":"사내 위키","url":"wiki.internal.dc/home"}'
```

---

## 5. 보안 설계

이 포탈은 **사용자가 입력한 URL 을 서버가 대신 호출**하는 기능(링크 점검)을 가지므로,
아래 가드를 유지해야 합니다. 되돌리면 내부망 스캐너로 악용될 수 있습니다.

- **URL 스킴 화이트리스트** — `http`/`https` 만 저장. `javascript:`·`data:` 를 허용하면
  대시보드의 '바로가기' 클릭이 스크립트 실행 경로가 됩니다.
- **SSRF 가드**(`hub/ssrf.py`) — 점검 전 호스트를 실제로 해석해 **루프백·링크로컬
  (169.254.169.254 클라우드 메타데이터 포함)·멀티캐스트·미지정** 주소를 차단합니다.
  사내 서비스가 대상이므로 RFC1918 사설 대역은 허용합니다. 10진수·8진수·IPv4-mapped 같은
  우회 표기는 '해석된 주소'를 검사하므로 자동으로 걸립니다.
- **리다이렉트 미추적** — 3xx 를 따라가면 가드를 통과한 요청이 루프백으로 되돌려질 수 있어
  따라가지 않고 3xx 자체를 결과로 보고합니다.
- **전역 TLS 설정 미변경** — 자체서명 허용이 필요하면 그 요청에만 컨텍스트를 주입합니다.
- **XSS 차단** — 화면은 사용자 입력을 `textContent` 로만 넣습니다(innerHTML 조립 금지).
  응답에는 `default-src 'self'` CSP + `X-Frame-Options: DENY` + `nosniff` 가 붙습니다.
- **경로 탈출 차단** — 정적 서빙은 `static/` 밖으로 나가지 못하며 확장자도 제한합니다.
- **저장 파일 보호** — `0600`, 원자적 쓰기(tmp+fsync+rename), 파싱 실패 시
  `shortcuts.json.corrupt.<ts>` 로 보존(조용한 전량 유실 방지).

> 사내망 공개로 쓰다가 접근을 좁히려면 `HUB_TOKEN` 을 설정하거나, 리버스 프록시(nginx)에서
> TLS + 인증을 앞단에 두세요.

---

## 6. 테스트

```bash
cd pyportal
python3 -m unittest discover -s tests -v
```

- `test_store.py` — 정규화·필수값·손상 파일 보존·가져오기 검증
- `test_ssrf.py` — 스킴/우회 표기/루프백·메타데이터 차단, 사설 대역 허용
- `test_health.py` — 차단 분류, 실제 서버 대상 2xx/4xx/5xx/리다이렉트 처리, 동시 실행
- `test_api.py` — REST 계약, 보안 헤더, 경로 탈출, 토큰 인증
