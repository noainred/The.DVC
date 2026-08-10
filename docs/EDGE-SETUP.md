# 엣지(Edge) 설정 방법

원격 법인/데이터센터(DC)에 **엣지 포탈**을 두고, 한국의 **중앙 포탈**에서 통합 모니터링하는 구성의 설정 가이드입니다.
이 문서의 모든 값·경로는 코드(`server/src/config.js` 등)에서 확인한 것입니다.

---

## 1. 엣지란 — 중앙 ↔ 엣지 구조

- **중앙(central) 포탈**: 사용자가 접속하는 포탈. 대상·점검 정의를 관리하고, 엣지가 보고한 결과를 통합해서 본다.
  고RTT 사이트(폴란드·미국동부 800ms+)를 중앙에서 직접 찌르지 않으려고 `SVCMON_ROLE=central` 로 두면 **점검을 직접
  실행하지 않고** 엣지에 배포·수신만 한다.
- **엣지(edge) 포탈**: 각 원격 DC에서 이 앱을 그대로 돌리는 **또 하나의 인스턴스**. 자기 사이트의 vCenter·iDRAC·성능점검을
  **현장에서** 수집/실행하고 결과를 중앙으로 **push**, 배정·정의는 중앙에서 **pull** 한다. 중앙발 **자동 업그레이드**도 받는다.

엣지가 중앙에 하는 일(요약):
- 성능점검 정의 pull → 적용 → 결과 push (`agent/svcmonConfigPull.js`, `agent/svcmonPush.js`)
- 사이트 vCenter 인벤토리 push (`AGENT_PUSH_INVENTORY`)
- 리소스 실측(capacity) push (`config.capacity.push`)
- 전력수집 export 제공(중앙이 pull), 위임 iDRAC 스캔/핑/캡처/로그 대행
- 부팅 시 **수집 서버 목록에 자동 등록**(`POST /api/central/register-collector`)

---

## 2. 가장 빠른 길 — `EDGE_MODE=all` (권장)

엣지에는 **3개 값만** 주면 전 기능이 켜집니다(`server/src/config.js:23-30`).

```ini
# 엣지 호스트의 /etc/vmware-portal/portal.env
EDGE_MODE=all
CENTRAL_URL=http://<중앙포탈주소>:4000
EDGE_TOKEN=<중앙에서 받은 토큰>
# 권장: 이 엣지의 고유 이름(중앙 배정 매칭 키). 없으면 hostname 을 씀 → 이름 충돌·오배정 위험.
AGENT_NAME=OC2-Agent
```

`EDGE_MODE=all` 이 자동으로 켜는 것:
- `DATA_SOURCE=live` (실제 vCenter 수집), `COLLECTOR_TOKEN=EDGE_TOKEN` (전력 export),
- 위임 스캔/핑/캡처/로그 워커, 사이트 인벤토리 push, capacity push,
- 부팅 시 중앙 자동 등록(수집 서버 수동 추가 불필요),
- 중앙발 자동 업그레이드(`CENTRAL_URL/dl` 소스, 1시간 주기, 자동 적용).

> **`EDGE_TOKEN` vs `CENTRAL_TOKEN`** (`config.js:29-30`, `196-204`): 엣지에서는 **`EDGE_TOKEN` 을 쓰세요.**
> `CENTRAL_TOKEN` 을 엣지에 주면 그 인스턴스의 `/api/central` 엔드포인트까지 열려 "엣지가 또 다른 중앙"이 되는
> 부작용이 있습니다. 값 자체는 중앙의 토큰과 같아야 인증됩니다(`X-Central-Token` 헤더로 제시).

개별 env 를 명시하면 `EDGE_MODE=all` 의 자동값보다 **그 값이 우선**합니다.

---

## 3. 중앙 포탈 준비

엣지를 붙이려면 중앙이 `/api/central` 엔드포인트를 열어야 하고, 그러려면 **중앙 토큰**이 있어야 합니다.

1. **중앙 토큰 설정** — 중앙 `portal.env`:
   ```ini
   CENTRAL_TOKEN=<충분히 긴 랜덤 문자열>
   AUTH_SECRET=<재시작해도 로그인 유지되는 서명키>   # 운영 필수
   SVCMON_ROLE=central   # 중앙이 점검을 직접 실행하지 않게(엣지에 배포만). 단일 사이트면 both(기본).
   ```
   `CENTRAL_TOKEN` 이 비어 있으면 `/api/central` 이 **비활성**이라 어떤 엣지도 붙지 못합니다(`config.js:174-178`).
   토큰은 UI에서 만들 수도 있습니다: **설정 → 원격 법인(DC)에 Edge 노드 포탈 설치 → 중앙 토큰 [생성]**
   (`POST /api/admin/central-token/generate`, `portal.env` 에 원자적으로 저장).

2. **엣지별 개별 토큰(권장, 보안)** — 공유 `CENTRAL_TOKEN` 하나만 쓰면 엣지 1대가 침해될 때 **다른 모든 사이트**의
   토큰이 함께 유출됩니다. 엣지마다 개별 토큰을 발급하세요:
   - **설정 → 수집 서버(원격)** 화면 하단 "엣지별 개별 central 토큰" → **엣지 이름 입력 → [토큰 발급]**
     (`POST /api/admin/central/agent-tokens`, admin 전용).
   - 발급된 **평문 토큰은 그때 한 번만** 표시됩니다. 그 값을 해당 엣지의 `EDGE_TOKEN`(또는 `CENTRAL_TOKEN`)에 넣고
     엣지를 재시작하세요.
   - 개별 토큰은 **회수(revoke)** 가능하고, 그 엣지만 무력화됩니다(다른 엣지 영향 없음).

---

## 4. 엣지 설치 — 두 가지 방법

### 4-A. SSH 자동 설치 (권장) — "원격 법인(DC)에 Edge 노드 포탈 설치"

중앙 UI에서 새 Rocky Linux 9 호스트에 SSH로 자동 설치합니다(`web/src/views/AgentDeploy.jsx`).

1. **설정 → 원격 법인(DC)에 Edge 노드 포탈 설치 → "설치 패키지"** 탭에서 설치 패키지를 먼저 내려받습니다
   (없으면 설치가 안 됩니다. `installer_cent9` = CentOS/Rocky 9 오프라인 설치본).
2. **"에이전트 추가"** 탭에서 입력:
   - **SSH 접속**: 호스트/포트(22)/사용자(root)/비밀번호 또는 개인키
   - **에이전트 이름(AGENT_NAME)**: 사이트가 드러나게(예: `OC2-Agent`, `Seoul-DC1`). 중앙 배정 매칭 키.
   - **중앙 URL(CENTRAL_URL)**: `http://<중앙주소>:4000`
   - **중앙 토큰(CENTRAL_TOKEN/EDGE_TOKEN)**: [생성] 버튼 또는 위 3절에서 발급한 값
   - 선택: 포탈 포트(4000), 자동 업그레이드, 인벤토리 위임 수집, 수집 서버 자동 등록, GPU 게스트 수집 등
3. **설치 실행** → SSH로 포탈을 설치하고 `portal.env` 를 쓰고 서비스를 기동합니다. 이후 **에이전트 현황** 탭에서 상태를 봅니다.

### 4-B. 수동/오프라인 설치

폐쇄망이면 오프라인 패키지(`packaging/offline/build-package.sh`, Rocky Linux 9)로 설치한 뒤,
엣지 호스트의 `/etc/vmware-portal/portal.env` 에 2절의 env 를 적고 서비스를 재시작합니다:

```bash
# 리눅스 예시
sudoedit /etc/vmware-portal/portal.env      # EDGE_MODE/CENTRAL_URL/EDGE_TOKEN/AGENT_NAME 기입
systemctl restart vmware-portal
```

---

## 5. 성능점검(svcmon)에서 엣지 쓰기

엣지가 중앙에 붙으면 성능점검에서 그 엣지가 대상을 점검하도록 **배정**할 수 있습니다.

- 엣지 후보 목록 = **발급된 개별 토큰이 있는 엣지 ∪ 현재 보고 중인 엣지** 의 합집합(`GET /api/svcmon/assign` 의 `candidates`).
  → 즉 엣지가 목록에 뜨려면 **① 개별 토큰을 발급**했거나 **② 엣지가 이미 보고 중**이어야 합니다.
- **배정 방법 2가지**:
  1. **성능점검 트리 → ＋ 등록** 마법사에서 줄마다 **엣지**를 지정해 등록하면, 그 대상은 "그 엣지 전용"이 되고
     등록 직후 **엣지 배정 동기화** 한 번으로 배포됩니다(대상별 agent 필드).
  2. **설정 → 엣지 배정** 탭에서 트리 경로 범위를 잘라 엣지에 배정합니다(경로 스코프).
- 엣지는 배정을 pull(`GET /api/central/svcmon-config?agent=<이름>`)해서 자기 저장소에 적용하고, **적용 수가 배포 수와
  정확히 일치**하면 상태가 `활성`이 됩니다(ack 기반 — 배포만으로 성공을 단정하지 않음). 결과는 중앙으로 push 됩니다.

> 대상에 엣지를 지정하지 않으면(빈 값) 경로 스코프 배정을 따르거나, 단일 사이트(`SVCMON_ROLE=both`)에서는 그 포탈이
> 직접 점검합니다. 엣지가 아예 없는 설치라면 엣지 지정 없이 그대로 등록하면 됩니다.

---

## 6. 연결 확인 · 문제 해결

**정상 연결 확인**
- 중앙: **설정 → 수집 서버(원격)** 에 엣지가 나타나고 통신 진단(probe)이 정상.
- 엣지 로그(`journalctl -u vmware-portal`): `[svcmon-pull] 정의 적용 …`, `[idrac-scan-agent] started (central=…, name=<AGENT_NAME>)` 등이 보임.

**엣지가 목록에 안 뜨거나 배정이 `배포 대기`에서 안 넘어갈 때**
| 증상 | 원인 | 조치 |
|---|---|---|
| 엣지가 후보에 없음 | 개별 토큰 미발급 + 아직 미보고 | 3절처럼 개별 토큰 발급, 또는 엣지가 보고를 시작하도록 `CENTRAL_URL`/`EDGE_TOKEN` 확인 후 재시작 |
| 403 (denyReason) | `EDGE_TOKEN`(엣지) ≠ `CENTRAL_TOKEN`(중앙) 또는 개별 토큰 불일치 | 값 재확인. 개별 토큰을 회전(재발급)했으면 엣지 토큰도 새 값으로 교체 |
| 배정이 `수 불일치(mismatch)` | 엣지 적용 수 ≠ 배포 수(상한/검증 실패로 일부 누락) | 엣지 로그의 `[svcmon-pull] 적용 문제…` 확인, 대상/점검 상한 초과 여부 |
| 폴링 기록 없음 | `AGENT_NAME` 불일치(대소문자 무관하나 이름 자체가 다름), `CENTRAL_URL` 미설정 | 엣지 `AGENT_NAME` 이 중앙 배정 이름과 같은지 확인. 현재 폴링 중인 다른 이름이 있으면 그 이름과 대조 |

**흔한 실수**
- `AGENT_NAME` 을 안 정해 hostname 이 이름이 됨 → 호스트명이 바뀌면 배정이 끊긴다. **항상 명시**하세요.
- 중앙에 `CENTRAL_TOKEN` 미설정 → `/api/central` 비활성이라 엣지가 못 붙음.
- 엣지에 `CENTRAL_TOKEN`(대신 `EDGE_TOKEN`) 을 써서 엣지의 central 엔드포인트가 열림 → `EDGE_TOKEN` 사용 권장.

---

## 7. 업그레이드

- `EDGE_MODE=all` + `CENTRAL_URL` 이면 엣지는 **중앙 포탈의 `/dl`** 을 소스로 1시간 주기 자동 업그레이드하고 자동 적용합니다
  (`config.upgrade`, 폐쇄망에서도 중앙만 최신이면 됨). 끄려면 `UPGRADE_AUTO_APPLY=false`.
- 중앙에서 특정 엣지로 번들을 **푸시**하려면 `UPGRADE_EDGES='[{"url":"https://edge1","token":"…"}]'`.
- 업그레이드 번들은 **sha256 검증**을 통과해야 적용됩니다(미검증 거부).

---

## 부록 — 엣지 `portal.env` 최소/권장 예시

```ini
# 최소 (EDGE_MODE=all 자동 구성)
EDGE_MODE=all
CENTRAL_URL=http://central.example.local:4000
EDGE_TOKEN=<중앙 발급 토큰(개별 권장)>
AGENT_NAME=OC2-Agent

# 권장 추가
SVCMON_ROLE=edge                 # 점검을 이 엣지가 직접 실행(정의는 중앙 pull)
CONFIG_DIR=/etc/vmware-portal    # 데이터/설정을 앱 밖에 둬 업그레이드가 건드리지 않게
COLLECTOR_DATACENTER=OC2         # 전력 export 에 표시할 DC 라벨(선택)
# EDGE_ADVERTISE_URL=http://10.9.1.5:4000   # 중앙이 자동 등록 시 쓸 URL(NAT/프록시 뒤면 명시)
```

중앙 `portal.env` 최소:
```ini
CENTRAL_TOKEN=<충분히 긴 랜덤>
AUTH_SECRET=<서명키>
SVCMON_ROLE=central
```

> 참고: 이 문서는 코드(`server/src/config.js`, `server/src/routes/central.js`, `web/src/views/AgentDeploy.jsx`,
> `web/src/views/Collectors.jsx`, `server/src/agent/*`)에서 확인한 동작 기준입니다. 서비스 유닛명(`vmware-portal`)·
> 설정 경로(`/etc/vmware-portal/portal.env`)는 설치 패키지 관례이며, 환경에 따라 다를 수 있으니 실제 설치 스크립트를 확인하세요.
