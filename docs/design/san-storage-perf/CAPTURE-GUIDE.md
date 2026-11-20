# 캡처 가이드 — 어느 장비에서 무엇을 어떻게 받아 오면 되는가

> 설계 `README.md` §4.2 의 어레이 측 성능 수집은 **실장비 응답을 아직 보지 못한 채** 웹 문서로만 설계했다(2026-11-08). 아래 캡처가 있으면 파서를 그 모양에 맞춰 첫 운영 반영부터 빈 칸 없이 간다.
> 없이 가도 되지만(장비가 주는 지표 목록을 먼저 읽는 방어 구조), 그때는 첫 반영에서 일부 칸이 '—' 가 될 수 있다.
>
> ⚠ **이 저장소는 공개다.** 캡처 파일은 커밋하지 말고 대화에 첨부하거나 사내 경로로 전달한다. 비밀번호 · 토큰은 절대 넣지 않는다. IP 는 `<unisphere-ip>` 처럼 바꾸고, 시리얼 · WWN 은 그대로 둬도 되지만 공개가 꺼려지면 가운데를 `x` 로 가린다(끝 4자리는 남겨야 매칭을 검증할 수 있다).

## 0. 우선순위 — 가장 먼저 필요한 것

| 순위 | 무엇 | 왜 | 어디서 |
|---|---|---|---|
| 1 | **PowerStore · Unity 어레이 포트의 스위치 네임서버 심볼릭 이름** | 디렉터/컨트롤러(NodeA · SPA)를 이름에서 읽는 규칙이 **목 서버 형식**뿐이다 — 실제 형식이 다르면 '(구분 못 함)' 으로 떨어진다 | 포탈이 이미 저장한 `port_meta`(가장 쉬움) 또는 Brocade 스위치 `nsshow` |
| 2 | **PowerMax Unisphere** FEDirector keys · help · metrics 응답 각 1개 | 지표 키 · 날짜 형식 · V4(2500/8500) 지원 지표 차이 확인 | Unisphere for PowerMax 서버(:8443) |
| 3 | **PowerStore** `metrics/generate` 노드 · FC 포트 응답 각 1개 | 응답 **필드 이름이 미확인**(클러스터와 같은지) | PowerStore 클러스터 관리 IP |
| 4 | **Unity** `metric/instances` 목록 + `metricValue` 응답 2개 | FC 경로가 OE 버전마다 다를 수 있음 · 누적 카운터 확인 | Unity 관리 IP(Unisphere) |

## 1. 스위치 쪽 — 어레이 포트 심볼릭 이름(PowerStore · Unity · PowerMax 2500/8500)

### 1-a. 포탈에서(권장 · 스위치에 접속하지 않는다)
포탈 서버에서 SAN 포트 사용량 DB 의 `port_meta` 를 읽으면 된다(어레이 포트만 보려면 `attached_name` 에 `::` 가 있거나 이름이 있는 행).

```bash
# 포탈 서버(또는 그 법인 엣지)에서 — DB 경로는 설정의 dbDir/configDir(기본 CONFIG_DIR) 아래 sanswitch-perf.db
sqlite3 -header -csv /path/to/sanswitch-perf.db \
  "SELECT device_id, port, attached_name, attached_wwn, speed, port_type FROM port_meta WHERE attached_name <> '' ORDER BY device_id, port;" \
  > san-port-names.csv
```

구현에서는 이것을 **'분류 · 매핑' 탭의 '포트 이름 CSV 내보내기' 단추**로 넣는다(⑦ 보드) — 그 뒤로는 이 수동 절차가 필요 없다.

### 1-b. Brocade 스위치에서(포탈 DB 를 못 볼 때)
SSH 로 스위치에 들어가 네임서버를 본다. PowerStore · Unity · PowerMax 가 물린 **포트의 블록만** 복사하면 된다(한 벤더당 포트 2개면 충분).

```bash
nsshow            # 이 스위치에 로그인한 장비 — 'PortSymb' · 'NodeSymb' 줄이 핵심
nscamshow         # 같은 패브릭의 다른 스위치 장비까지(원격) — 어레이가 다른 스위치에 있을 때
switchshow        # 포트 번호 ↔ WWN 대조용
```

`nsshow` 블록에서 필요한 줄 예(형식 확인용 — 값은 가상):

```
 N    010a00;      3;20:00:00:60:16:xx:xx:xx;50:06:01:6x:xx:xx:xx:xx; na
    FC4s: FCP
    PortSymb: [31] "UNITY::APM00xxxxxxxx::SPA FC0 ..."     ← 이 줄이 있으면 이름 규칙으로 읽는다
    NodeSymb: [..] "..."
    Fabric Port Name: 20:0a:...
    Permanent Port Name: 50:06:01:6x:...
    Device type: Physical Target                            ← 역할 확정(nsRoles)
```

**PortSymb 줄이 없으면**(어레이가 등록하지 않음) 그 사실 자체가 중요한 결과다 — 이름 규칙 대신 조닝 별칭(`Unity_SPA0_p8` 꼴)과 수동 매핑으로 간다. 그 경우 `alishow`(별칭 목록)에서 그 어레이 포트 WWN 이 든 별칭 이름을 함께 보내 달라.

PowerMax **2500/8500**(PowerMaxOS 10)은 디렉터 ID 가 `OR-1C` 꼴로 나올 수 있다 — 그 어레이가 있으면 포트 블록 1개를 더.

## 2. PowerMax — Unisphere for PowerMax REST(포트 8443 · Basic 인증 · 읽기 전용 모니터 계정)

```bash
U="https://<unisphere-ip>:8443/univmax/restapi"; A="-u <monitor-user>:<password> -k -s -H 'Accept: application/json' -H 'Content-Type: application/json'"

# ① 버전(이미 포탈이 쓰는 호출 — 응답의 api_version · supported_api_versions)
eval curl $A "$U/version" > pmax-version.json

# ② 디렉터 키 — 어레이의 FE 디렉터 목록과 성능 데이터가 있는 기간(firstAvailableDate · lastAvailableDate)
eval curl $A -X POST "$U/performance/FEDirector/keys" -d "'{\"symmetrixId\":\"<12자리 시리얼>\"}'" > pmax-fedirector-keys.json

# ③ 이 어레이가 지원하는 FEDirector 지표 목록(Dell KB 000213922 — V4 는 일부 지표가 없다)
eval curl $A "$U/performance/FEDirector/help/<12자리 시리얼>/FEDirector/metrics/All" > pmax-fedirector-help.json

# ④ 디렉터 1개의 지표(최근 1시간 · 평균) — startDate/endDate 는 epoch 밀리초
NOW=$(date +%s000); AGO=$(( $(date +%s) - 3600 ))000
eval curl $A -X POST "$U/performance/FEDirector/metrics" -d "'{\"symmetrixId\":\"<시리얼>\",\"directorId\":\"<②의 directorId 예 FA-1D>\",\"metrics\":[\"PercentBusy\",\"HostIOs\",\"HostMBs\",\"ReadResponseTime\",\"WriteResponseTime\",\"QueueDepthUtilization\"],\"startDate\":$AGO,\"endDate\":$NOW,\"dataFormat\":\"Average\"}'" > pmax-fedirector-metrics.json
```

- 지표 이름이 거부되면(`No supported metrics passed …`) ③ 의 목록에 있는 이름으로 바꿔 다시 — 그 **오류 응답도** 같이 보내 달라.
- 포트 단위도 보고 싶으면 `performance/FEPort/keys`(본문에 `symmetrixId` · `directorId`) 1개를 더.
- 접속이 안 되면 Unisphere 의 `https://<unisphere-ip>:8443/univmax/restapi/docs` 에서 FEDirector 절 캡처(화면 사진이어도 된다).

## 3. PowerStore — REST(클러스터 관리 IP · 443 · Basic + DELL-EMC-TOKEN)

```bash
P="https://<powerstore-ip>/api/rest"; A="-u <monitor-user>:<password> -k -s -H 'Accept: application/json' -H 'Content-Type: application/json'"

# ① 세션 · CSRF 토큰(POST 에 필요) — 응답 헤더의 DELL-EMC-TOKEN 을 복사
eval curl $A -c ps.cookie -D ps.headers "$P/login_session" > /dev/null; TOKEN=$(grep -i 'DELL-EMC-TOKEN' ps.headers | awk '{print $2}' | tr -d '\r')

# ② 노드 · FC 포트 목록(id 가 필요)
eval curl $A -b ps.cookie "$P/node?select=id,slot,appliance_id" > ps-nodes.json
eval curl $A -b ps.cookie "$P/fc_port?select=id,name,node_id,appliance_id,wwn,current_speed,is_link_up" > ps-fc-ports.json

# ③ 노드 성능(최근 5분 간격) — 응답 필드 이름이 설계의 핵심 확인 대상
eval curl $A -b ps.cookie -H "'DELL-EMC-TOKEN: $TOKEN'" -X POST "$P/metrics/generate" -d "'{\"entity\":\"performance_metrics_by_node\",\"entity_id\":\"<②의 node id>\",\"interval\":\"Five_Mins\"}'" > ps-perf-node.json

# ④ FE FC 포트 성능
eval curl $A -b ps.cookie -H "'DELL-EMC-TOKEN: $TOKEN'" -X POST "$P/metrics/generate" -d "'{\"entity\":\"performance_metrics_by_fe_fc_port\",\"entity_id\":\"<②의 fc_port id>\",\"interval\":\"Five_Mins\"}'" > ps-perf-fcport.json
```

- 포탈의 기존 수집기(`storage/collectors/powerstore.js fetchSpaceMetrics`)와 같은 호출 방식이라, ③④ 응답의 **필드 이름**(예 `total_iops` · `avg_latency` · 노드 CPU 유무)만 확인하면 된다.
- 422/403 이 나면 그 응답 본문도 같이(토큰 요구 여부가 버전마다 다르다).

## 4. Unity — Unisphere REST(관리 IP · 443 · Basic + `X-EMC-REST-CLIENT: true`)

```bash
Y="https://<unity-ip>/api"; A="-u <monitor-user>:<password> -k -s -H 'Accept: application/json' -H 'X-EMC-REST-CLIENT: true'"

# ① 지표 경로 목록 — 'fibreChannel' · 'cpu' 가 든 경로가 설계의 확인 대상(응답이 길어도 그대로)
eval curl $A "'$Y/types/metric/instances?fields=id,path,description,type,unitDisplayString,isHistoricalAvailable,isRealtimeAvailable&per_page=2000&compact=true'" > unity-metric-paths.json

# ② SP CPU 이력(60초 간격 · 최근 10점)
eval curl $A "'$Y/types/metricValue/instances?filter=path%20EQ%20%22sp.*.cpu.summary.utilization%22&per_page=10'" > unity-sp-cpu.json

# ③ FC 포트 바이트(누적 카운터 — 경로 이름은 ① 에서 확인한 것으로; 후보 sp.*.fibreChannel.target.*.readBytes / writeBytes 또는 fePort 변형)
eval curl $A "'$Y/types/metricValue/instances?filter=path%20EQ%20%22<①에서 고른 FC 경로>%22&per_page=10'" > unity-fc-bytes.json

# ④ FC 포트 ↔ SP 대조표
eval curl $A "'$Y/types/fcPort/instances?fields=id,name,wwn,currentSpeed,storageProcessor,connectorType'" > unity-fc-ports.json
```

- ① 에서 `fibreChannel` 경로가 하나도 없으면 그 OE 는 SP 단위 FC 지표를 주지 않는 것이다 — 그 사실이 결과다(화면은 '—' + 사유).
- 실시간 조회(`metricRealTimeQuery`)는 세션을 상시로 붙잡으므로 쓰지 않는다 — 캡처도 필요 없다.

## 5. 보내 줄 파일 목록(이름 그대로)

`san-port-names.csv`(또는 `nsshow` 텍스트) · `pmax-version.json` · `pmax-fedirector-keys.json` · `pmax-fedirector-help.json` · `pmax-fedirector-metrics.json` · `ps-nodes.json` · `ps-fc-ports.json` · `ps-perf-node.json` · `ps-perf-fcport.json` · `unity-metric-paths.json` · `unity-sp-cpu.json` · `unity-fc-bytes.json` · `unity-fc-ports.json`

각 파일에서 확인하는 것: 지표 키 이름 · 단위(ms/µs · MB/s · 누적 여부) · 시각 형식(epoch ms / ISO) · 디렉터 · 노드 · SP 식별자가 스위치 쪽 이름(FA-1D · NodeA · SPA)과 어떻게 대응하는지.
