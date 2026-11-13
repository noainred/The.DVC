# 설계: IP 스캔 — 사용 중 IP 의 호스트명 확인(역DNS → mDNS → NetBIOS) + 대장 목록 ‘호스트명’ 열

작성 2026-11-13 (main v2.989.0 기준 · 브랜치 `claude/eloquent-lovelace-mcs6my`) · 상태 **구현됨 v2.991.0**(컨펌 2026-11-13 08:06 KST — §6 답: ① 3가지(기본) ② **기본 켜짐**(시안 기본값 '꺼짐'에서 바꿈) ③④⑤ 기본 ⑥ **MAC 수집** ⑦ 표준 + 변이 1회 · 구현 §8) ·
⚠ 정정(2026-11-13 07:22 KST): 조사와 ⓪ 캡처는 이 세션의 처음 체크아웃(**v2.914.0** — main 보다 75개 버전 뒤)에서 했다. 푸시 직전에 알고 main(v2.989.0) 위로 다시 올린 뒤
`git diff` 로 대조했다 — `scan.js` · `scanStore.js` · `ledger.js` · `scanWorker.js` · `agent/ipScanWorker.js` · `IpamCore.jsx` · `IpamEditors.jsx` · `IpamScanStatus.jsx` 는 **차이 0줄**,
`ipam/scanDatacenter.js` 는 데이터센터 귀속 순서 6줄, `IpScanSettings.jsx` · `IpamNet.jsx` 는 eslint 주석뿐, 배정 라우트는 `routes/central.js` 에서 `routes/central/opsRoutes.js` 로 옮겨졌다(본문 같음).
아래 위치는 v2.989.0 에서 다시 확인한 것이다. `styles.css` 는 기능별 규칙만 늘었고 `:root` 토큰 · `.badge` · `.tab` · 표 규칙은 같다. ⓪ 캡처는 v2.914.0 빌드 그대로다(v2.989.0 으로 다시 찍지 않았다).
시안 캔버스: https://claude.ai/artifact/Pf48uY3zo4bzgYny5CGqeE (아트보드 6장 — ⓪ 지금 · ① 대장 목록 1440 · ② 스캔 IP 상세 · ③ 스캔 설정 · ④ 상태 9종 · ⑤ 400px).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **주소 · 호스트명 · 에이전트 이름 · 수치는 전부 가상**이고, ⓪ 의 캡처는 목 서버에 스캔 결과 12건을 심어 찍은 것이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰과 `.badge` · `.tab` · `.card` · 표 규칙 그대로(새 hex 없음 — 청록 점선은 ‘새로 생기는 것’ 을 가리키는 시안 표시일 뿐 화면에 넣지 않는다).
계정의 ‘Design System’ 아티팩트는 지금도 타입 파일뿐이라(`project/README.md` · `tokens.json` 없음 — 파일 목록으로 확인) 쓰지 않았다.
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현.

## 1. 요구(사용자 2026-11-13 06:57 · 07:02 KST)

> "ip scan 기능에서 사용중인 ip 식별하는 기능에 추가해서 hostname 추가하는 기능 추가해줘" → "시안으로 만들어서 보여줘"
> "angry ip scanner 라는 프로그램 보면 ip scan 기능에 hostname 도 보이는 기능이 있던데, 구현할 수 있어?"

첨부: Angry IP Scanner 결과 표(IP · Ping · Hostname · Ports) — 4개 중 1개만 이름이 있고(`JunHoui-MacBookPro.`) 나머지는 `[n/a]`.

답: **구현할 수 있다.** Angry IP Scanner 의 Hostname 칸이 쓰는 세 가지 방법은 계정 · 관리자 권한 없이 Node 의 `dns` · `dgram` 만으로 만들 수 있고, 그중 첫째(역DNS)는 이미 있다.

## 2. 지금 코드에서 확인한 것(2026-11-13 06:57~07:15 KST)

| 사실 | 위치 |
|---|---|
| 스캔은 2단계(전 IP TCP 프로브 → 포트가 모두 닫힌 IP 만 ping) 뒤 **응답한 IP 에 대해 `dns.reverse()` 만** 부른다(동시 16). 다른 이름 확인 방법은 없다 | `server/src/ipam/scan.js` `reverseMany` · `scanRanges` |
| 설정은 에이전트별 `reverseDns`(기본 켬) · `ping`(기본 **끔** — v2.359 장애 뒤 opt-in). 엣지는 `/api/central/ip-scan-assignment` 가 내려준 설정(`...cfg`)을 그대로 `runScan` 에 넘긴다 | `ipam/scanStore.js normalizeCfg` · `routes/central/opsRoutes.js:380` · `agent/ipScanWorker.js:181` |
| 스캔은 별도 자식 프로세스에서 돈다(포탈 이벤트 루프 · FD 와 분리). 시한을 넘기면 부모가 죽이고 1단계 부분 결과만 남는다(이름 없음) | `ipam/scanWorker.js` · `scanRunner.js` |
| 엣지가 보낸 결과에서 중앙이 받는 칸은 **`ip` · `openPorts` · `services` · `hostname` 넷뿐**(아는 칸만 · 길이 상한 · 제어문자 제거) | `ipam/scanStore.js cleanAliveHost` |
| 결과 저장 `ipam-scan-results.json` = `{ ip → {ip, openPorts, services, hostname, lastSeen, agent} }` · 이력 이벤트는 up/down 전이만(`hostname` 은 그때 값) | `scanStore.js mergeScanResults` · `recordSeen` |
| 대장의 스캔 행: `ownerName = hostname ‖ ip` · `hostName = hostname`. vCenter 가 아는 IP 는 스캔 결과가 있어도 스캔 행을 만들지 않는다(그 IP 의 스캔 이름은 버려진다) · 범위 계정에는 스캔 행을 주지 않는다 | `ipam/ledger.js:300~340` |
| 목록의 열: IP 주소 · 분류 · 센터 · 서버종류 · 확인 방식 · 관리상태 · 소유 자원 · 전원 · OS 종류 · OS 버전 · **‘ESXi 호스트’(= `hostName`)** — 스캔 행의 이름이 ‘소유 자원’ 과 ‘ESXi 호스트’ 두 칸에 들어간다. 표는 1440 에서 이미 가로로 넘긴다(표 폭 1,314px) | `web/src/views/tools/IpamCore.jsx:232~274` · 캡처 ⓪ |
| 목록에서 스캔 IP 를 누르면 `IpOwnerDetail` — "이 IP에 연결된 자원 상세를 열 수 없습니다" 안내뿐. `IpHistoryModal`(확인된 호스트명 · 최초/마지막 확인 · 사용 이력)은 **서브넷 대장에서만** 열린다 | `IpamCore.jsx:402·421(setHistIp)` · `:540~` · 캡처 ⓪ |
| 직접 넣는 이름은 이미 있다 — 관리상태 편집의 `hostnameOverride`(‘자동 수집 호스트명을 덮어쓸 이름’) · 관리상태 CSV 의 hostname 열 | `IpamEditors.jsx:165` · `ipam/overrides.js` · `manageCsv.js` |
| VM 의 게스트 호스트명(`guest.hostName`)은 수집하지 않는다(grep 0건) | `server/src/vcenter/soapClient.js` |
| **Angry IP Scanner**(공개 소스 `angryip/ipscan` master, 2026-11-13 WebFetch 로 읽음): `HostnameFetcher.scan()` = ① 역DNS(+ 정방향 재확인) → ② 이름이 없고 대상이 ‘로컬’ 이면 mDNS → ③ 그래도 없으면 NetBIOS. `MDNSResolver` 는 역이름(`d.c.b.a.in-addr.arpa`) PTR 질의를 **224.0.0.251:5353 멀티캐스트(TTL 1)** 로 보낸다. `NetBIOSResolver` 는 대상 IP 의 **UDP 137** 로 50바이트 노드 상태(NBSTAT, 와일드카드 `*`) 질의를 보내 컴퓨터 이름 · 사용자 · 그룹 · MAC 을 읽는다. ‘로컬’ 은 `ScanningSubject.isLocal()`(`ifAddr != null`)인데 그 판정의 세부(같은 서브넷인지)는 읽은 파일에서 확인하지 못했다 | `HostnameFetcher.java` · `util/MDNSResolver.java` · `util/NetBIOSResolver.java` · `core/ScanningSubject.java` |

## 3. 정직하게 밝혀야 하는 것

1. **효과는 네트워크에 달려 있고 실측하지 못했다.** 이 환경에는 Windows · mDNS 응답 장비가 없어 NetBIOS · mDNS 의 실제 응답은 확인하지 못했다(프로토콜 규격과 Angry IP Scanner 소스 기준 설계). 운영 법인에서 이름이 몇 % 채워질지는 모른다 — 그래서 스캔마다 ‘방식별로 몇 개 찾았는지’ 를 화면에 낸다(③).
2. **mDNS 는 스캐너와 같은 네트워크 구간(L2)만** 답한다(멀티캐스트 TTL 1). 포탈 스캔은 대부분 라우터 너머 대역이라 mDNS 로 채워지는 이름은 에이전트 자신의 구간뿐이다. 첨부 화면의 MacBook 이름이 mDNS 로 나온 것으로 **추정**한다(확인 불가). 서버 대역에서 mDNS 응답 장비는 드물 것으로 추정한다. Windows 가 역방향(PTR) mDNS 질의에 답하는지도 확인하지 못했다.
3. **NetBIOS 는 Windows · Samba 만** 답하고, ‘NetBIOS over TCP/IP’ 를 끈 서버나 방화벽이 UDP 137 을 막는 구간에서는 답이 없다. 이름은 15자까지다(더 긴 컴퓨터 이름은 잘린 값).
4. **iDRAC · 스위치 · 스토리지 · Linux 서버는 세 방식 모두 답하지 않는 것이 보통이다**(역DNS 레코드가 없으면 ‘—’). 이 시안은 그것을 ‘—’ 로 두고 직접 입력(+ 이름)으로 메운다. SMB(445) · TLS 인증서 이름으로 더 찾는 안은 질문 ①.
5. **새 방식은 대상 장비로 패킷을 보낸다**(역DNS 는 DNS 서버에만 묻는다). NetBIOS 노드 상태 질의를 대역 단위로 보내면 IDS 가 정찰로 볼 수 있다 → 기본 꺼짐 · 에이전트별로 켬 · 응답한 IP 에만 · IP 당 1회(질문 ②).
6. 장비가 답한 이름은 **신뢰할 수 없는 입력**이다(아무 문자열이나 답할 수 있다) — 길이 상한 · 제어문자 제거 · 화면은 텍스트로만 · 포탈은 그 이름으로 어떤 동작도 하지 않는다.
7. 엣지 법인은 **엣지가 새 버전으로 올라온 뒤부터** 새 방식이 돈다. 그 전에는 역DNS 이름만 오고 화면은 ‘방식 보고 없음’ 이라고 말한다.
8. ⓪ 의 12건(이름 있는 것 3건)은 시안을 위해 심은 값이다 — 운영의 실제 비율이 아니다. 목 서버에서 스캔을 켜 두면 이 샌드박스의 프록시가 모든 주소의 80 포트에 응답해 172건이 ‘사용 중’ 으로 잡혔다(환경 때문 — 스캔을 끄고 다시 심었다).

## 4. 설계

### 4.1 스캔 3단계 — ‘호스트명 확인’(`scan.js scanRanges`, 자식 프로세스 안)
응답한 IP(1 · 2단계 생존)에만, 켜 둔 방식을 **모두** 묻는다(Angry IP 는 앞 방식이 실패했을 때만 다음을 묻지만, 여기는 ‘방식마다 이름이 다름’ 을 알기 위해 전부 묻는다 — 비용은 IP 당 UDP 1~2개).

| 방식 | 보내는 것 | 대상 | 얻는 것 |
|---|---|---|---|
| 역DNS `dns` | DNS 서버에 PTR 조회(지금 그대로) | 응답한 IP 전부 | FQDN |
| mDNS `mdns` | `d.c.b.a.in-addr.arpa` PTR 질의 1개를 224.0.0.251:5353 으로(임시 포트에서 — ‘legacy unicast’ 라 응답이 우리 포트로 직접 온다 · TTL 1) | **에이전트 인터페이스와 같은 서브넷의 IP 만**(`os.networkInterfaces()` 의 주소 · 넷마스크로 판정) | `이름.local` |
| NetBIOS `netbios` | UDP 137 로 노드 상태(NBSTAT `*`) 질의 1개(50바이트) | 응답한 IP 전부 | 컴퓨터 이름(접미 `0x00` · unique) · 작업 그룹(접미 `0x00` · group) |

- 소켓은 방식당 UDP 1개로 전 대상을 처리한다(IP 마다 소켓 · 프로세스를 만들지 않는다 — v2.359 FD 폭주 교훈). 전송은 속도 제한을 둔 묶음, 대기는 마지막 전송 뒤 `timeoutMs` 한 번.
- 응답은 **물어본 IP 에서 온 것만** 받는다(NetBIOS: 발신 주소 ∈ 대기 집합 · 발신 포트 137 · 거래 ID 일치 / mDNS: 발신 주소 = 대상 IP). Angry IP 는 발신 주소를 보지 않는다 — 여기서는 본다.
- 파서는 오프셋 기반(정규식 없음) · 길이 검사 후 읽기 · DNS 이름 압축 포인터는 점프 횟수 상한 · 이름은 인쇄 가능한 문자만(제어문자 제거) · NetBIOS 15자 / DNS 255자 상한.
- 표시 이름(`hostname`) = 역DNS > mDNS > NetBIOS 중 먼저 있는 것(Angry IP 와 같은 순서). 직접 넣은 이름(`hostnameOverride`)은 대장에서 그 위에 선다(지금 그대로).
- 스캔 시한(`SCAN_DEADLINE`) 예산 안에서 돈다: 3단계 소요 ≈ 전송 묶음 수 × 간격 + `timeoutMs`(응답 IP 4,096개 · 초당 500개면 약 9초 — 추정, 구현 때 실측).

### 4.2 결과 한 건의 모양(엣지 → 중앙 · 저장)
```
{ ip, openPorts, services,
  hostname: 'fs-old.corp.example',          // 표시 이름 — 옛 중앙도 이 칸은 받는다
  hostSrc: 'dns',                            // 'dns' | 'mdns' | 'netbios'
  names: { dns: 'fs-old.corp.example', netbios: 'NAS-BACKUP' },   // 방식별 이름(있는 것만)
  nbGroup: 'CORP',                           // NetBIOS 작업 그룹(있을 때)
  tried: ['dns', 'mdns', 'netbios'] }        // 이 IP 에 실제로 물어본 방식(mDNS 는 같은 구간일 때만 들어간다)
```
- 보고 본문에 스캔 단위 요약 `nameStats: { tried:{dns,mdns,netbios}, found:{dns,mdns,netbios} }` — 없으면 ‘방식 보고 없음’(이전 버전 엣지).
- **중앙 정제**(`cleanAliveHost`)에 새 칸을 화이트리스트로 더한다: `hostSrc` 는 세 값 중 하나만 · `names` 는 아는 키 3개만 각각 `cleanHostname` · `nbGroup` 15자 · `tried` 는 아는 값 최대 3개. 모르는 모양은 버린다(v2.601 규약 — 디스크에서 읽은 옛 파일도 같은 정제).
- 호환: 새 중앙 + 옛 엣지 = `hostname` 만 온다 → 출처는 역DNS(옛 판본은 역DNS 만 한다 — 코드로 확정) · 에이전트 표에 ‘방식 보고 없음’. 옛 중앙 + 새 엣지 = 배정에 새 설정이 없어 꺼진 채로 돌고, 더 보낸 칸은 옛 정제가 버린다.

### 4.3 저장 규칙(`scanStore.mergeScanResults`)
- 방식별로 `{ v: 이름, at: 확인 시각, miss: 연속 무응답 횟수 }` 를 둔다. 이번 스캔이 그 방식을 물었고 답이 있으면 갱신(miss 0), 물었는데 답이 없으면 **이름은 두고 miss+1**, 묻지 않았으면 그대로.
- miss 가 기준(기본 3회 — 설정 가능한 상수, 화면에 숫자를 박지 않는다)에 닿으면 그 방식의 이름을 지운다(UDP 유실 한 번으로 이름이 깜박이지 않게 + 사라진 이름이 영원히 남지 않게). 그 사이에는 상태 ⑤ ‘지난 스캔에서는 답이 없었음’.
- 시한 초과 · 실패 스캔(부분 결과)은 이름을 건드리지 않는다(상태 ⑧) — 못 본 것을 ‘없어졌다’ 로 세지 않는다(v2.733 규약과 같은 방향).
- 같은 방식이 전과 **다른 이름**을 답하면 이력에 `{type:'rename', src, from, to}` 한 줄(상태 ⑥). 방식이 달라서 생기는 차이는 이름 변경이 아니다(→ ‘이름 다름’).
- 이름 · 출처가 바뀌면 `scanRev` 를 올린다(대장 캐시 키) — 확인 시각만 바뀐 것은 올리지 않는다(매 스캔 대장 재계산 금지 규약).

### 4.4 대장(`ledger.js`)
- 스캔 행: `hostName` · `ownerName` 의 뜻은 그대로(= 표시 이름 — ipam.db 열 · 외부 리더 계약 불변). 새 칸 `netName` · `netNameSrc`(`manual`·`dns`·`mdns`·`netbios`) · `netNameAt` · `names` · `nameMismatch` 를 더한다.
- VM · ESXi 호스트 행: 그 IP 의 스캔 결과가 있으면 `netName…` 만 붙인다(`hostName` 은 ESXi 호스트 이름이라 건드리지 않는다) — 상태 ⑨.
- 범위 계정: 스캔 행은 지금처럼 주지 않고, **스캔이 찾은 이름도 붙이지 않는다**(스캔 결과는 vCenter 귀속이 없다 — 기존 정책과 같은 판정).
- 요약에 `scanNames: { total, bySrc:{manual,dns,mdns,netbios}, none }` — 목록 위 요약 줄 · ‘호스트명 없음’ 칩의 수.
- v2.619 입력 지문 · `_ipamKey` · `/tools/ipam` memo 키가 새 칸의 변화를 반영하는지 구현 때 확인한다(스캔 쪽은 `scanRev` 가 키에 들어 있다).

### 4.5 화면
| 보드 | 파일 | 내용 |
|---|---|---|
| ⓪ | `Current.dc.html` | 지금 — 대장 목록 · 스캔 IP 클릭 창 · 스캔 설정 캡처 + 부족한 것 6가지 + 코드 근거 |
| ① | `Main.dc.html` | **대장 목록(1440)** — IP 옆 ‘호스트명’ 열(이름 + 출처 배지 역DNS · mDNS · NetBIOS · 수동) · 없으면 ‘—’ + ‘+ 이름’(기존 관리상태 편집 › 호스트명 칸을 연다) · 요약 줄(호스트명 9/12 · 방식별) · 칩 ‘호스트명 없음’ · ‘이름 다름’ 배지 · 스캔 행의 ‘소유 자원’ 칸은 열린 서비스만 · ‘ESXi 호스트’ 칸은 ‘—’ |
| ② | `Detail.dc.html` | **스캔 IP 를 눌렀을 때** — 지금의 ‘IP 사용 이력’ 창에 호스트명 묶음(표시 이름 · 방식별 결과 표 · ‘이름 다름’ 안내 · ‘이름 직접 지정’)과 이력의 ‘이름 변경’ 줄을 더한다. 목록의 스캔 행 클릭이 이 창을 연다(지금은 빈 안내 창) |
| ③ | `Settings.dc.html` | **스캔 설정** — ‘역DNS 호스트명’ 한 칸을 ‘호스트명 확인’ 묶음(역DNS · mDNS · NetBIOS 체크 + 방식마다 한 줄 설명)으로 · 상태 카드에 ‘호스트명 8개 확인(방식별)’ · 에이전트 표에 ‘이름 확인’ 열(이전 버전은 ‘방식 보고 없음’) · 스캔 한 번의 순서 4단계 |
| ④ | `States.dc.html` | 상태 9종 — 찾음 · 응답 없음 · 확인 안 함 · 방식마다 이름이 다름 · 지난 스캔에서는 답이 없었음 · 이름이 바뀜 · 이전 버전 에이전트 · 스캔이 끝까지 못 감 · VM/호스트 행 + 범위 계정 규칙 |
| ⑤ | `Narrow.dc.html` | 400px — 목록(표는 상자 안 가로 넘김 · IP 와 호스트명이 첫 화면) · 상세 창(방식별 결과를 줄로) · 설정 묶음(체크 줄바꿈) |

- 정렬: 호스트명 열은 이름순, ‘—’ 는 항상 뒤(`STable` 규칙). 검색은 `netName` 도 본다.
- 스캔 결과 CSV(‘⬇ 스캔 결과(CSV)’)에 `hostname_source` · `name_dns` · `name_mdns` · `name_netbios` 열을 더한다. 서브넷 대장 · 엑셀의 Hostname 칸은 구조를 바꾸지 않는다(이름이 더 채워질 뿐).
- 문구에 주기 · 상한 숫자를 박지 않는다 · 값이 없으면 ‘—’ · 안 물어본 것(확인 안 함)과 답이 없는 것(응답 없음)을 구분한다.

## 5. 범위 밖(이번 시안에 넣지 않은 것 — 후보)

- **SMB(445) NTLM 이름 · TLS 인증서 이름**: NetBIOS 를 끈 Windows, iDRAC · ESXi · 장비류의 이름을 더 찾을 수 있다(Angry IP 에는 없는 방식). 질문 ①.
- **VMware Tools 게스트 호스트명**(`guest.hostName`)으로 VM 행 채우기: vCenter 수집 · 엣지 수신 계약이 바뀌는 별도 작업.
- NetBIOS 가 함께 주는 **MAC 주소 · 로그인 사용자 이름**: 수집하지 않는다(질문 ⑥ — MAC 만 후보, 사용자 이름은 개인정보라 제외).
- 포탈 등록 장비(iDRAC · 스위치 · 스토리지 등록부)와 스캔 IP 대조: 대장이 다른 등록부를 끌어오지 않게 나눈 기존 결정(v2.638 `scanSuggestSource`)과 닿아 별도 설계가 필요하다.
- 응답 시간(Angry IP 의 Ping 칸) · 역DNS 의 정방향 재확인.

## 6. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

1. **방식 범위** — 기본: Angry IP Scanner 와 같은 3가지(역DNS · mDNS · NetBIOS). 대안: SMB(445) · TLS 인증서 이름까지(작업량 약 1.5배 추정 · 보드 추가).
2. **새 방식의 기본값** — 기본: **꺼짐**, 에이전트별로 켠다(대상 장비로 패킷을 새로 보내는 동작이라 ping 과 같은 규칙). 대안: 켬(업그레이드 직후 전 에이전트가 수행).
3. **VM · ESXi 호스트 행에도 스캔 이름 표시**(스캔 대역 안일 때) — 기본: 표시. 대안: 스캔으로만 확인한 IP 행에만.
4. **목록에서 스캔 IP 클릭 → ② 창** — 기본: 포함(지금의 빈 안내 창을 대체). 대안: 클릭 동작은 그대로 두고 열만 추가.
5. **‘호스트명 없음’ 칩 · 요약 줄 · 에이전트 표 ‘이름 확인’ 열** — 기본: 포함.
6. **NetBIOS 의 MAC 주소** — 기본: 수집하지 않음. 대안: ② 창에만 표시.
7. **검증 수준** — 기본: 표준(관련 테스트 + Chromium 1440/400 + 전량 verify) + **엣지 수신 정제 · 패킷 파서 변이 검증 1회**(엣지 수신 계약 · 외부 입력 파서라 위험 수정에 해당). ‘전체 검증’ 이면 반증 1인 추가.

## 7. 구현 메모(컨펌 뒤 · Opus)

- 서버: `ipam/nameProbe.js`(새 — NBSTAT 요청/응답 파서 · mDNS 질의/응답 파서 · on-link 판정 · UDP 묶음 전송, 전부 순수 함수 + 얇은 소켓 래퍼) · `ipam/scan.js`(3단계 · `onProgress` 불변 · 반환 모양에 칸 추가) · `scanWorker.js`/`scanRunner.js`/`scanPoller.js`/`agent/ipScanWorker.js`(잡 · 보고에 `mdns`·`netbios`·`nameStats`) · `scanStore.js`(`normalizeCfg`·`saveScanSettings` 두 칸 · `cleanAliveHost` 화이트리스트 · 방식별 저장 · rename 이벤트 · `scanRev`) · `ledger.js`(4.4) · 스캔 결과 CSV · `scanLog`(이름 확인 수) · `edgelog/spec.js`(엣지 상태에 방식별 수).
- 웹: `IpamCore.jsx`(열 · 칩 · 요약 · 스캔 행 클릭 → 이력 창) · `IpHistoryModal`(호스트명 묶음 · 이름 변경 줄) · `IpScanSettings.jsx`(묶음) · 에이전트 표 · `IpamScanStatus.jsx`(실행 이력에 이름 확인 수) · 순수 문구 모듈 `ipamHostText.js`(출처 라벨 · 상태 9종 판정 → vitest).
- 테스트: `server/test/ipScanHostname29xx.test.js` — NBSTAT/mDNS 파서(정상 · 잘린 패킷 · 압축 포인터 순환 · 제어문자 · 15자/255자 상한 · 물어보지 않은 주소의 응답 버림) · 가짜 UDP 응답기로 `scanRanges` 3단계 실제 호출 · `cleanAliveHost` 가 모르는 칸을 버림 · miss 3회 삭제 · rename 이벤트 · 부분 결과가 이름을 지우지 않음 · 범위 계정 응답에 스캔 이름 없음 · 옛 엣지 본문(`hostname` 만) 호환. 웹 `ipamHostText.test.js`.
- 문서: `docs/rules/ipam.md` 에 항목 추가 · 이 README §8 에 ‘시안과 달리 한 것’.
- 릴리스: 포탈 동작이 바뀌므로 버전업 + GitHub 릴리스 게시(`versions.json` latest 확인).

## 8. 구현(v2.991.0 · 2026-11-13 · Opus) — 시안과 달리 한 것 · 남긴 것

- 파일: 서버 `ipam/hostNames.js`(새 — 표시 순서 · 이름 다름 · 대장 칸) · `ipam/nameProbe.js`(새 — NBSTAT · PTR 패킷 · UDP 묶음 질의 · 같은 서브넷) · `ipam/scan.js`(`resolveNames` · 3단계) ·
  `scanWorker.js` · `scanRunner.js` · `scanPoller.js` · `agent/ipScanWorker.js`(설정 · 요약 전달) · `scanStore.js`(설정 2칸 · 정제 · `mergeNames` · `renames` · `cleanNameStats` · `scanDetailOf`) ·
  `ledger.js`(호스트명 칸) · `routes/central/opsRoutes.js`(요약 저장) · `routes/api/ipamExport.js`(이력 `scan` · CSV 열) ·
  웹 `IpamHostName.jsx`(새) · `ipamHostText.js`(새) · `IpamCore.jsx` · `IpScanSettings.jsx` · `IpamScanStatus.jsx` · `scanRangeImportText.js`.
- 테스트: `server/test/ipScanHostname2991.test.js` 21건(파서 무작위 4,000회 · 루프백 실제 UDP 왕복 · 위조 응답 · 실제 엣지 워커 + 목 중앙 · 대장/이력/CSV 라우트) ·
  `audit2611e` 의 기준 판본 대조에 새 칸을 '추가된 칸' 목록으로 더함 · 웹 `ipamHostText.test.js` 7건. 변이 15종 — 13종 검출, 2종(M7 names 아는 키 · M8 표시 이름 재선택)은
  바깥 층(`mergeNames` 가 아는 키만 읽고 표시 이름을 다시 고른다)이 같은 일을 해 관찰 결과가 같은 동등 변이. M2(응답 주소 확인)는 첫 실행에서 살아남아 테스트를 보강했다.
- 시안과 달리 한 것:
  1. **mDNS 는 대상 IP 로 직접**(UDP 5353 유니캐스트) 보낸다 — 시안 · Angry IP 는 224.0.0.251 멀티캐스트. 그 구간의 다른 장비에 질의를 뿌리지 않고, 응답 발신 주소가 곧 대상이라
     위조 확인이 단순하다(RFC 6762 5.5 — 응답자는 같은 링크의 직접 질의에 답한다). 실제 장비에서 멀티캐스트보다 덜 답하는지는 **확인하지 못했다**.
  2. **묻지 않은 방식의 이름은 지운다**(시안 §4.3 은 '그대로') — 방식을 끈 에이전트의 이름을 지금 이름처럼 두지 않게(v2.990 까지 역DNS 를 끄면 hostname 이 바로 비었다).
  3. 상태 ⑨ 의 '스캔 대역 밖' 문구는 넣지 않았다 — 스캔 결과가 없는 이유(대역 밖 · 무응답 · 보존 기간 지남)를 대장이 가를 수 없어 '—' 만 둔다(IP 상세 창은 세 가능성을 함께 말한다).
  4. 칩 이름은 '호스트명 없음(스캔 IP)' — VM 행은 대부분 스캔 이름이 없어 세면 뜻이 흐려진다. '+ 이름' 도 스캔 행에만.
  5. 보드 ③ 의 '스캔 한 번의 순서 4단계' 그림은 화면에 넣지 않았다(설정 묶음 아래 한 줄 설명으로).
  6. 기본값 켜짐(컨펌) — 업그레이드 뒤 중앙과 엣지(업그레이드 후)가 응답한 IP 마다 UDP 137 질의를 보낸다. 옛 중앙 + 새 엣지는 엣지가 켜진 채로 돌고, 옛 중앙은 표시 이름(hostname)만 받는다.
  7. 스캔 실행 이력(스캔 상태 페이지) 표에도 '이름 확인' 열을 더했다(시안에 없음).
- 남긴 것: SMB(445) · TLS 인증서 이름(질문 ①의 대안) · VMware Tools 게스트 호스트명 · 포탈 등록 장비 대조(§5). NetBIOS 사용자 이름은 읽지 않는다.
- 확인 못 한 것: NetBIOS · mDNS 의 **실제 장비 응답**(이 환경에 Windows · mDNS 장비 없음 — 루프백 응답자 · 규격 · Angry IP Scanner 소스로 확인).

### 8.1 Chromium 확인(목 서버 · 스캔 결과 12건 심음 · 1440 / 400 · pageerror · console error 0 · 가로 넘침 0)
- 대장 목록(호스트명 열 · 출처 배지 · '지난 스캔 무응답' 확인 시각 · '확인 안 함' · '+ 이름' · '이름 다름') · '호스트명 없음(스캔 IP)' 칩(3행) · 요약 줄 · IP 상세 창(방식별 결과 · 이름 다름 안내 · MAC ·
  이력의 '이름 변경' 줄) · 스캔 설정 '호스트명 확인' 묶음 · 에이전트 표 '이름 확인'(이 포탈 8 / 12 · 옛 엣지 '방식 보고 없음') · 스캔 상태 이력 '이름 확인' 열.
- 찾아 고친 것(400px): ① IP 상세 창의 방식별 결과 3열 표(최소 폭 420)가 창보다 넓어 이름이 글자 단위로 끊기고 시각 열이 잘렸다 → 줄바꿈 행(flex).
  ② 스캔 설정 폼이 400px 에서도 '라벨 | 입력' 2열이라 '호스트명 확인' 설명이 약 120px 폭으로 세로로 늘어졌다 → `styles.css .ipscan-form`(640px 이하 1열 — 폼 전체에 적용).
- 남긴 것(기존): IP 상세 창의 '총 미사용 기간' 이 해제 이력이 없는 IP 에 '0ms' 로 보인다(`fmtDur(0)` — 이번 변경 전부터의 표시로 코드상 판단, A/B 캡처는 하지 않음).

