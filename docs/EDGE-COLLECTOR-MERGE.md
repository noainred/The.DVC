# 이전 절차서 — 별도 수집서버(원격)를 엣지 노드 포탈로 통합

같은 DC에 **엣지 노드 포탈**과 **별도 수집서버(전력 수집 전용 VM)** 가 각각 있을 때,
수집서버 역할을 엣지 노드에 합치고 수집서버 VM을 폐기하는 절차입니다.
모든 근거는 코드 위치로 표기했습니다(버전 v2.232.0 기준).

## 0. 가능 근거 (코드 사실)

| 확인 항목 | 사실 | 근거 |
|---|---|---|
| 역할 공존 | `/api/collector` 라우터는 항상 mount, **토큰이 있으면 활성** | `index.js:121`, `routes/collector.js:55-62` |
| 엣지의 수집기 토큰 | **`EDGE_MODE=all`이면 `EDGE_TOKEN`이 자동으로 수집기 토큰** — `COLLECTOR_TOKEN` 별도 설정 불필요 | `config.js:145` |
| iDRAC 폴러 | 어떤 역할이든 `idrac.json`에 대상이 있으면 폴링(기본 enabled) | `idrac/poller.js:107-115`, `config.js:73` |
| 포트 충돌 | 없음 — 단일 Express 앱/단일 포트 | `index.js:176` |
| 중앙의 과거 전력 이력 | **유실되지 않음** — 중앙이 pull 시 최신값을 자기 DB에 `rmt:<호스트>` 키로 적재해 옴(60초 해상도) | `collector/puller.js:53-58`, `idrac/service.js:432` |
| 수집기 로컬 원시 이력 | 수집서버 로컬 `idrac-power.db`에 서버ID(=IP) 키로 존재 — 옮기려면 파일 복사 | `config.js:83-85`, `idrac/db.js:29-35` |
| iDRAC 등록 목록 | `CONFIG_DIR/idrac.json` (비밀번호 **평문** 포함 — API로는 안 나옴) | `idrac/registry.js:34`, `:52-55` |
| 중앙 수집 서버 등록 | `CONFIG_DIR/collectors.json` — **URL·토큰만 엣지 것으로 수정**하면 됨(UI 수정 시 `managed:true`로 고정) | `collector/registry.js:265-276` |
| 위임(PUSH) 스캔 결과 | 수집 대상과 **같은 파일**(`idrac.json`)에 등록 | `agent/idracScanWorker.js:62`, `idrac/localScan.js:24` |

## 1. 사전 준비

1. 엣지 노드가 `EDGE_MODE=all` + `EDGE_TOKEN`으로 동작 중인지 확인:
   ```bash
   grep -E "EDGE_MODE|EDGE_TOKEN" /etc/vmware-portal/portal.env
   curl -s -H "X-Collector-Token: <EDGE_TOKEN>" http://<엣지IP>:4000/api/collector/ping
   # → 200 이면 수집기 역할 이미 활성
   ```
2. 구 수집서버의 `CONFIG_DIR` 백업(스냅샷 또는 tar) — 롤백 지점.

## 2. 이전 절차

```bash
# ① 구 수집서버: 서비스 중지(파일 정지 상태 확보 + 이중 폴링 예방)
sudo systemctl stop vmware-portal        # 구 수집서버에서

# ② 등록 목록 + 원시 전력 이력을 엣지로 복사 (idrac.json 은 iDRAC 비밀번호 평문 포함 — scp 후 임시본 파기)
scp /etc/vmware-portal/idrac.json /etc/vmware-portal/idrac-power.db* <엣지>:/tmp/
# 엣지에서:
sudo systemctl stop vmware-portal
sudo mv /tmp/idrac.json /tmp/idrac-power.db* /etc/vmware-portal/
sudo chown vmportal:vmportal /etc/vmware-portal/idrac.json /etc/vmware-portal/idrac-power.db*
sudo chmod 0600 /etc/vmware-portal/idrac.json
# ⚠ 엣지에 기존 idrac.json 이 이미 있으면 덮어쓰지 말고 병합(id=IP 중복 확인) — UI CSV 가져오기로도 가능(비번 재입력 필요)
sudo systemctl start vmware-portal

# ③ 확인 (엣지)
journalctl -u vmware-portal | grep -i idrac | tail -5     # 폴러 기동·대상 수
# 포탈 UI: 설정 → 수집 서버 → iDRAC 서버 등록 → 대상 목록·전력값 표시 확인
```

④ **중앙 포탈 UI**: 설정 → 수집 서버(원격) → 해당 항목의 **URL을 엣지 주소로, 토큰을 엣지 `EDGE_TOKEN`으로 수정** 후 저장 → [연결 테스트] → hosts>0 확인.
(UI에서 저장하면 `managed:true`로 고정되어 자기등록이 되돌리지 않음 — `collector/registry.js:274-276`)

⑤ 위임 iDRAC/IP 스캔을 구 수집서버 이름으로 할당해 두었다면 **에이전트 이름을 엣지로 재지정**(설정 → IP 스캔/에이전트 작업).

⑥ 엣지의 `/etc/vmware-portal/collectors.json`이 비어 있는지 확인 — 항목이 있으면 엣지가 남의 수집기를 pull하는 중복 루프가 생김(`collector/puller.js:126-133`은 모든 인스턴스에서 기동).

⑦ **24시간 관찰** 후 이상 없으면 구 수집서버 VM 폐기(스냅샷은 보관 기간 유지).

## 3. 주의점

- **이력 키 이원화**: 중앙에 있는 과거 이력은 `rmt:<호스트명>` 키, 복사해 온 원시 이력은 서버ID(=IP) 키 —
  병합되지 않고 공존합니다. `idrac-power.db`만 복사하고 `idrac.json`을 빠뜨리면 이력이 고아가 됩니다.
- **retention**: 전력 이력은 기본 90일 prune(`config.js:87`) — 복사해 온 90일 초과 이력은 첫 폴링 후 정리됩니다.
- **토큰 2종 혼동 금지**: `collectors.json.token` = 중앙→엣지(`/api/collector/*`) 인증,
  v2.191 엣지별 개별 토큰 = 엣지→중앙(`/api/central/*`) 인증. 엣지 **이름**을 바꾸는 경우에만 개별 토큰 재발급 필요.
  403이 나면 중앙 설정 → 수집 서버의 인증 거부 카운터로 확인.
- **이중 폴링 금지**: 중앙(또는 다른 노드)의 `idrac.json`에 같은 iDRAC이 남아 있으면 두 곳에서 동시 폴링
  (iDRAC 세션 제한·계정 잠금 위험). KPI 합산은 서비스태그 dedupe로 흡수되지만(`idrac/service.js:110-127`)
  부하는 그대로입니다.
- **롤백**: 중앙 `collectors.json`의 URL/토큰 원복 + 구 VM 서비스 재기동이면 즉시 복귀.
  단, 전환 기간에 엣지에 쌓인 샘플은 구 VM에 없습니다.
