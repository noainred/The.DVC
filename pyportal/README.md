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
| 프런트엔드 | 순수 HTML/CSS/JS (빌드 도구·CDN·차트 라이브러리 없음 → **오프라인 동작**) |
| 저장 | 설정 JSON 4종 + 점검 이력 **SQLite**(WAL) |
| 실행 | `python3 app.py` 한 줄 |

### 화면

| 탭 | 내용 |
|---|---|
| **서비스 바로가기** | 즐겨찾기 고정 · 카테고리 필터 · 통합 검색 · 카드에서 열기/즐겨찾기/수정/삭제 · 최근 점검 상태 배지 |
| **센터 현황** | 리전 필터 · 좌표 기반 사이트 지도 · 센터 상세 + 그 센터 전용 링크 (**표시 개수는 설정에서 지정**) |
| **링크 상태 점검** | 기간(5분~한달)별 **가용률·응답지연 추이 차트** + 최근 상태 표 |
| **⚙ 설정**(비밀번호 필요) | ① 바로가기 관리 ② 데이터센터 구성 ③ 사용자 구성 및 설정 ④ 현재 설정 백업 |

---

## 2. 실행

```bash
cd pyportal
python3 app.py                  # http://<서버>:8095
```

기동 로그에 **설정 화면 초기 비밀번호 파일 경로**가 표시됩니다.

```
★ 설정 화면 초기 비밀번호가 아래 파일에 있습니다(최초 1회):
   /etc/dc-service-hub/initial-settings-password.txt
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `HUB_HOST` | `0.0.0.0` | 바인드 주소. 로컬만 열려면 `127.0.0.1` |
| `HUB_PORT` | `8095` | 포트 |
| `HUB_DATA_DIR` | `pyportal/data` | 설정·이력 저장 위치 |
| `HUB_TOKEN` | (없음) | 설정하면 **모든 `/api` 요청에 토큰 필요**(포탈 전체 비공개화) |
| `HUB_SESSION_TTL_MIN` | `480` | 설정 로그인 세션 유지(분) |
| `HUB_LOGIN_MAX_FAILS` / `HUB_LOGIN_LOCKOUT_SEC` | `8` / `300` | 로그인 실패 잠금 |
| `HUB_HISTORY_RETENTION_DAYS` | `40` | 점검 이력 보관 기간(한 달 차트를 위해 31일 이상 권장) |
| `HUB_HEALTH_TIMEOUT` | `4.0` | 링크 점검 1건 타임아웃(초) |
| `HUB_HEALTH_CONCURRENCY` | `8` | 링크 점검 동시 실행 수 |
| `HUB_HEALTH_TLS_VERIFY` | `true` | 점검 시 TLS 검증(자체서명 때문에 끄려면 `false` — 그 요청에만 적용) |
| `HUB_HEALTH_ALLOW_PRIVATE` | `true` | 사설 대역(10/172.16/192.168) 점검 허용 |
| `HUB_MAX_BODY` | `1048576` | 요청 본문 상한(바이트) |

---

## 3. 설정 화면 (비밀번호 보호)

상단 우측 **[🔒 설정]** 버튼 → 비밀번호 입력 → 4개 하위 메뉴가 열립니다.

- **최초 비밀번호**는 첫 기동 때 임의로 생성되어 `$HUB_DATA_DIR/initial-settings-password.txt`
  (**0600**)에 저장됩니다. 서버에 들어갈 수 있는 사람만 읽을 수 있습니다.
- 설정 › 사용자 구성에서 **비밀번호를 바꾸면 이 파일은 자동 삭제**됩니다.
- 로그인은 **비밀번호만** 입력받고, 입력값과 일치하는 계정으로 로그인됩니다. 그래서 계정끼리
  같은 비밀번호는 등록할 수 없습니다.
- 로그인 실패가 누적되면 일정 시간 잠깁니다.

| 하위 메뉴 | 할 수 있는 일 |
|---|---|
| 🔗 바로가기 관리 | 생성/수정/삭제 · JSON 내보내기·가져오기 · 기본값 복원 |
| 🏢 데이터센터 구성 | 사이트 추가/수정/삭제, 좌표·랙 수·PUE·상태 편집, **화면에 표시할 개수 지정**(0=전체), 기본 목록 복원 |
| 👤 사용자 구성 및 설정 | 계정 추가/삭제, 역할(admin/viewer), 사용 중지, 비밀번호 변경 |
| 💾 현재 설정 백업 | 즉시 백업 · **자동 백업 주기**(30분~1주) · **보관 수량** · 받기/복원/삭제 |

역할은 두 가지입니다.

| 역할 | 권한 |
|---|---|
| `admin` | 모든 설정(사용자·데이터센터·백업·주기) 변경 |
| `viewer` | 바로가기 관리까지만 |

> 조회(대시보드·센터 현황·점검 차트)는 로그인 없이 열립니다. **상태를 바꾸는 모든 API**는
> 설정 로그인이 필요합니다(바로가기 생성·수정·삭제 포함).

### 표시할 데이터센터 수

설정 › 데이터센터 구성의 **'화면에 표시할 데이터센터 수'** 로 조절합니다.

- `0` = 전체 표시(기본값). `1~300` 이면 **등록 순서대로 앞에서 N개만** 상단 배지·센터 현황·지도·통계에 나옵니다.
- **설정의 편집 목록에는 항상 전부** 보이고, 표시에서 빠진 항목은 `미표시` 배지로 구분됩니다
  (표시 개수를 줄였다고 등록된 사이트를 수정할 수 없게 되면 안 되기 때문입니다).
- 상단 배지는 `표시개수 DC / 등록수` 형태로 함께 알려줍니다(예: `13개 DC / 28`).

---

## 4. 링크 상태 점검 + 추이 차트

- 서버가 **자동 점검 주기**(기본 5분, 설정에서 변경)마다 등록된 링크에 요청을 보내고 결과를
  `health-history.db`(SQLite)에 적재합니다.
- 상단 기간 버튼 **5분 / 10분 / 30분 / 1시간 / 6시간 / 24시간 / 일주일 / 한달** 중 하나를 고르면
  **선택 즉시** 해당 구간의 차트가 다시 그려집니다. 우측 드롭다운으로 개별 링크만 볼 수도 있습니다.
- 차트 2종: **가용률(%)** — 실패 구간이 세로 띠로 표시 / **평균 응답 지연(ms)**.
  값이 없는 구간은 선을 잇지 않습니다(데이터 없음 ≠ 0).
- 기간별 버킷 크기는 서버가 정합니다(예: 24시간 → 30분, 한달 → 12시간).

성능 규칙(유지할 것):

- `ts` 단독 인덱스 — 보관기간 정리(`DELETE WHERE ts < ?`)가 풀스캔이 되지 않게. 복합 인덱스
  `(shortcut_id, ts)` 만으로는 이 조건을 못 탑니다.
- 삽입은 **한 트랜잭션 일괄 처리**, 정리는 **20회에 1번**만(매 점검마다 DELETE 금지).
- 자동 점검과 수동 점검은 **같은 재진입 가드**를 공유해 겹쳐 돌지 않습니다.

---

## 5. systemd 로 상시 구동 (Rocky Linux 9)

```bash
sudo mkdir -p /opt/dc-service-hub /etc/dc-service-hub
sudo cp -r pyportal/* /opt/dc-service-hub/
sudo useradd -r -s /sbin/nologin dchub 2>/dev/null || true
sudo chown -R dchub:dchub /etc/dc-service-hub

sudo cp /opt/dc-service-hub/systemd/dc-service-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dc-service-hub
sudo journalctl -u dc-service-hub -n 30      # 초기 비밀번호 파일 경로 확인

sudo firewall-cmd --permanent --add-port=8095/tcp && sudo firewall-cmd --reload
sudo cat /etc/dc-service-hub/initial-settings-password.txt
```

---

## 6. REST API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/api/meta` | - | 버전·카테고리·리전·기간 목록·현재 세션 |
| GET | `/api/shortcuts` | - | 바로가기 전체 |
| GET | `/api/datacenters` | - | 데이터센터 + 집계 |
| GET | `/api/health/latest` | - | 바로가기별 최신 점검 결과 |
| GET | `/api/health/history?range=&id=` | - | 기간별 버킷 집계(차트 데이터) |
| POST | `/api/health/check` | - | 지금 점검(진행 중이면 `skipped: true`) |
| POST | `/api/settings/session` | - | 로그인 → 토큰 |
| DELETE | `/api/settings/session` | 세션 | 로그아웃 |
| POST/PUT/DELETE | `/api/shortcuts…` | 세션 | 생성·수정·삭제·복원·가져오기 |
| GET | `/api/settings` | 세션 | 설정 상태 전체 |
| PUT | `/api/settings/{backup,health}` | admin | 백업/점검 주기·보관 수량 |
| GET/POST/PUT/DELETE | `/api/settings/users…` | 세션(변경은 admin) | 계정 관리 |
| POST/PUT/DELETE | `/api/settings/datacenters…` | admin | 데이터센터 구성 |
| GET/POST/DELETE | `/api/settings/backups…` | admin | 백업 목록·생성·받기·삭제 |
| POST | `/api/settings/backups/<name>/restore` | admin | 복원 |

```bash
# 로그인 → 토큰으로 바로가기 생성
TOKEN=$(curl -s -X POST localhost:8095/api/settings/session \
  -H 'Content-Type: application/json' -d '{"password":"<초기비밀번호>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s -X POST localhost:8095/api/shortcuts -H "X-Settings-Token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"사내 위키","url":"wiki.internal.dc/home"}'
```

---

## 7. 보안 설계

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
  CSP 때문에 **인라인 style/script 를 쓰면 안 됩니다**(색상은 CSS 클래스로).
- **경로 탈출 차단** — 정적 서빙은 `static/` 밖으로 나가지 못하며 확장자도 제한합니다.
  백업 파일명은 정규식 화이트리스트 + `basename` 으로 이중 검사합니다.
- **비밀번호** — pbkdf2_hmac(sha256) 21만 회 + 계정별 임의 salt. 비밀번호를 바꾸면 그 계정의
  기존 세션이 모두 끊깁니다. 로그인 실패 잠금은 **출발지(IP)별**입니다 — 전역 하나면 아무나
  몇 번 틀리는 것으로 정상 관리자까지 설정 화면에서 밀어낼 수 있습니다(v2.214).
- **CSRF 차단 (v2.214)** — 세션 쿠키를 **조회(GET/HEAD)에서만** 인정하고 상태변경에는 커스텀
  헤더(`X-Settings-Token`)를 요구합니다. 교차출처 POST 는 `text/plain` 본문이면 프리플라이트 없이
  전송되어 그대로 JSON 으로 파싱되므로, 쿠키만으로 인증되면 CSRF 가 성립합니다.
  추가로 `Origin`/`Sec-Fetch-Site` 기준 **교차출처 상태변경은 403** 입니다.
- **임의 URL 점검은 로그인 필수 (v2.214)** — 서버가 대신 요청을 보내 주는 기능이라 미인증으로
  열어 두면 사내망 포트 스캐너가 됩니다. 미인증은 **등록된 바로가기 재점검만**(30초 쿨다운).
- **미인증 응답 최소화 (v2.214)** — 초기 비밀번호 파일 **경로는 로그인 후에만** 내려갑니다.
- **가용성** — 핸들러 소켓 타임아웃 20초(slowloris 방지) + 동시 연결 상한 64.
- **저장 파일 보호** — 전부 `0600`, 원자적 쓰기(tmp+fsync+rename), 파싱 실패 시
  `<파일>.corrupt.<ts>` 로 보존(조용한 전량 유실 방지).
- ⚠ **백업 파일은 자격증명 사본** — `users.json`(비밀번호 해시)이 들어갑니다. 목록·다운로드·복원은
  admin 세션만 가능하고 파일은 0600 입니다. 내려받은 파일은 자격증명과 동급으로 보관하세요.

---

## 8. 테스트

```bash
cd pyportal
python3 -m unittest discover -s tests -v
```

| 파일 | 대상 |
|---|---|
| `test_store.py` | 바로가기 정규화·필수값·손상 파일 보존·가져오기 |
| `test_ssrf.py` | 스킴/우회 표기/루프백·메타데이터 차단, 사설 대역 허용 |
| `test_health.py` | 차단 분류, 실제 서버 대상 2xx/4xx/5xx/리다이렉트, 동시 실행 |
| `test_auth.py` | 해시·초기 비밀번호 파일·중복 비밀번호 거부·마지막 admin 보호·세션/잠금 |
| `test_history.py` | 이력 적재·기간별 버킷 집계·보관기간 정리 |
| `test_backup_dc.py` | 백업 생성/보관수량/복원/경로탈출, 데이터센터 CRUD·검증 |
| `test_api.py` | REST 계약·세션 가드·역할 분리·keep-alive·보안 헤더·경로 탈출 |
