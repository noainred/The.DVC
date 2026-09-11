# 호스트 접근 제어 (설정 › Security › 호스트 접근 제어, v2.485)

포탈 **호스트 자체**에 누가 접근할 수 있는지를 포탈 화면에서 통제한다.
요구: "중요한 정보를 많이 저장한 서버 — ① SSH 클라이언트 제어(완전 차단 포함) ② 80/443 클라이언트 제어 ③ OS 방화벽을 포탈에서 설정".

## 1. 엔진과 권한

| 항목 | 내용 |
|---|---|
| 엔진 | **firewalld**(Rocky 9 기본, nftables 백엔드). `install.sh` 가 이미 `firewall-cmd --add-port=PORT` 로 포탈 포트를 여는 같은 도구 |
| 실행 계정 | 포탈 서비스 계정(`vmportal`, 비root). `sudo -n /usr/bin/firewall-cmd`, `sudo -n /usr/bin/systemctl {stop,start,disable,enable} sshd.service` 만 허용 |
| sudoers | `install.sh`(v2.485+)가 `/etc/sudoers.d/vmware-portal-hostaccess` 설치. **업그레이드로 올라온 서버는 root 가 한 번 추가**해야 한다 — 화면의 '엔진 상태' 가 정확한 줄을 보여준다 |
| 화면 권한 | 조회 admin · 초안 저장/계획 admin + 설정 소유자 · **적용/확정 admin + 설정 소유자 + 본인 OTP**(세션 탈취만으로는 서버 접근 경로를 못 바꾸게) |
| 저장 | `host-access.json`(초안·확정본·확정 대기) — 비밀 값 없음 |
| 감사 | 초안 저장·적용·확정·되돌림 전부 감사 로그 |

## 2. 무엇을 제어하나

1. **SSH**: 열림 / 허용목록(IP·CIDR) / 완전 차단. 완전 차단은 방화벽에서 `ssh` 서비스와 `22/tcp` 포트 규칙을 제거하고, 선택하면 **sshd 서비스도 중지·비활성**(확정 단계에서만 실행, 모드를 바꿔 확정하면 다시 시작).
2. **웹(포탈 포트 + 선택한 80/443)**: 열림 / 허용목록. **'완전 차단' 은 없다** — 포탈 자체가 잠긴다. 허용목록에는 **요청자(관리자 본인) IP 가 반드시 포함**돼야 적용된다(자기 잠금 방지). 중계(HAProxy) 뒤라면 중계 서버 IP 를 넣는다(그 경우 실제 클라이언트 제어는 중계에서).
3. **OS 방화벽 추가 규칙**: 포트(a 또는 a-b)/프로토콜/동작(accept·drop·reject)/출발지. 기본 존의 rich rule 로 적용. 포탈 포트를 전체 drop/reject 하거나 요청자 IP 를 막는 규칙은 오류로 거부.

포탈이 **관리 대상으로 보고 추가·삭제하는 규칙**: `ssh` 서비스·`service name="ssh"` rich rule·22/tcp, 웹 포트의 `port port="P" protocol="tcp"` rich rule·`P/tcp`·http/https 서비스, 추가 규칙이 만든 rich rule, 직전 확정 때 포탈이 추가한 rich rule. **그 밖의 존 설정(다른 서비스·포트·인터페이스)은 건드리지 않는다.**

## 3. 잠금 사고 방지 — commit-confirm

```
[계획 보기]  현재 존(--list-all) 과 초안을 비교 → 실행할 firewall-cmd 목록 + 경고/오류. 아무것도 실행하지 않음.
[적용]       오류가 하나라도 있으면 실행하지 않음. 런타임에만 적용(--permanent 없음). 확정 대기 시작(1~30분, 기본 5분).
             중간 명령이 실패하면 즉시 --reload 로 되돌려 반쯤 적용된 상태를 남기지 않음.
[확정]       새 창에서 SSH/포탈 접속을 확인한 뒤 누른다 → --runtime-to-permanent. sshd 중지/재개는 여기서만.
[되돌리기]   --reload(영구 설정 = 직전 확정본 복원). 기한 안에 확정하지 않으면 자동. 포탈이 재시작돼도 기한을 이어받는다.
```

추가 검사: 존 target 이 `ACCEPT` 면 허용목록/차단이 효력이 없으므로 오류(수동으로 `--set-target=default` 후 재시도).
IPv6 주소도 받는다(`family="ipv6"` rich rule). 이벤트/추적과 달리 이 기능은 vCenter 와 무관하다.

## 4. 한계(정직 표기)

- **엔진이 firewalld 뿐**이다. iptables-services/ufw 로 바꾼 서버, firewalld 가 꺼진 서버에서는 '엔진 사용 불가' 로 표시되고 아무것도 바꾸지 않는다.
- 웹 허용목록은 **IP 기준**이다. NAT 뒤 사용자들은 같은 IP 로 보인다. 중계(HAProxy) 뒤에서는 중계 IP 만 보이므로(TRUST_PROXY 미설정 시) 클라이언트 제어는 중계에서 해야 한다.
- 이미 열린 SSH 세션은 방화벽 규칙을 바꿔도 conntrack 상태에 따라 유지될 수 있다. 확정 후 새 접속으로 확인할 것.
- 포탈 화면에서 sshd 를 중지하면, 포탈 접근까지 잃었을 때 남는 경로는 **콘솔(iDRAC/IPMI/vSphere 콘솔)** 뿐이다. 차단 전에 콘솔 경로를 확보하라.
- 다른 존에 인터페이스가 바인딩돼 있으면(예: `internal`) 그 존은 관리하지 않는다. 기본 존만 다룬다.

## 5. 함께 쓰면 좋은 오픈소스 (사실 기반, 권고 순)

Rocky Linux 9 오프라인 설치를 전제로 **RPM 으로 넣을 수 있고 인터넷 없이도 동작하는 것**을 우선했다.
아래는 각 도구가 해결하는 문제와 이 포탈과의 관계이며, "적용하면 좋다" 는 판단은 운영 환경(인터넷 유무·인력)에 따라 달라진다.

| 도구 | 해결하는 문제 | 이 포탈과의 관계 / 비고 |
|---|---|---|
| **firewalld / nftables** (기본 탑재) | 호스트 방화벽 | 이 기능의 엔진. 별도 설치 없음 |
| **SELinux enforcing** (기본 탑재) | 프로세스 격리·권한 상승 완화 | Rocky 9 기본 enforcing 유지. 포탈은 사용자 홈 밖(`/opt`, `CONFIG_DIR`)에서 동작하므로 기본 정책과 충돌 보고 없음(확인 필요 시 `ausearch -m avc`) |
| **auditd** (기본 탑재) | 시스템 콜·파일 접근 감사 | `CONFIG_DIR`(비밀 봉인 파일·DB) 에 `-w` 감시 규칙 추가 권장. 포탈 감사 로그(설정 › 감사 로그)와 상호 보완 |
| **fail2ban** (EPEL) | SSH 브루트포스 IP 자동 차단 | sshd 필터는 기본 제공. 포탈 로그인 실패는 이미 설정 › 세션 보안(잠금)이 처리하며, 필요하면 포탈 로그를 fail2ban 필터로 붙일 수 있다(포탈 로그 포맷 고정 필요 — 미구현). firewalld 액션(`firewallcmd-rich-rules`) 사용 |
| **sshguard** (EPEL) | fail2ban 의 경량 대안 | 설정이 단순. firewalld/nftables 백엔드 지원 |
| **CrowdSec** (자체 리포지토리) | 공격 패턴 탐지 + 커뮤니티 차단 목록 | 강력하지만 **커뮤니티 차단 목록은 인터넷 필요**(오프라인에서는 로컬 시나리오만). firewall bouncer 가 nftables/firewalld 를 쓰므로 이 기능과 같은 존을 건드린다 — 함께 쓰면 rich rule 충돌 여부를 먼저 확인 |
| **OpenSCAP + scap-security-guide** (기본 리포지토리) | CIS/STIG 기준 하드닝 점검·교정 | `oscap xccdf eval --profile xccdf_org.ssgproject.content_profile_cis` 로 점검. sshd 설정(PermitRootLogin·암호 인증 금지·MaxAuthTries 등)을 여기서 교정 |
| **Lynis** (EPEL) | 하드닝 감사 리포트 | 스캔만 하고 바꾸지 않아 안전. 정기 점검용 |
| **Wazuh** (자체 리포지토리) | HIDS(파일 무결성·로그 분석·룰 기반 경보) | 관리 서버가 별도 필요(무거움). 다수 서버를 함께 감시할 때 |
| **WireGuard** (기본 탑재, `wireguard-tools`) | 관리자 접근을 VPN 으로 한정 | 이 기능의 SSH/웹 허용목록에 **VPN 대역만** 넣으면 외부에서 관리 경로가 사라진다. 가장 효과 큰 조합 |
| **PAM google-authenticator** (EPEL) | SSH 로그인에 OTP | 포탈 OTP 와는 별개(SSH 용). `sshd_config` 의 `AuthenticationMethods publickey,keyboard-interactive` 와 함께 |
| **Teleport** (오픈소스 에디션) | 신원 기반 SSH 접근·세션 녹화·감사 | 강력하지만 인증 서버·프록시 등 구성 요소가 많다. 이 포탈은 이미 브라우저 SSH/RDP 중계(Apache Guacamole 계열 guacd)를 갖고 있어 소규모라면 중복 |

**권고 조합(간단 → 강함)**  
1) 이 기능으로 SSH 허용목록 + 웹 허용목록(관리 대역만) → 2) OpenSCAP CIS 프로파일로 sshd 하드닝(암호 인증 금지·키만) + fail2ban 또는 sshguard → 3) WireGuard 로 관리 경로를 VPN 대역으로 한정하고 허용목록을 VPN 대역만으로 좁힘 → 4) auditd 로 `CONFIG_DIR` 감시. 이 순서면 인터넷 없이도 전부 가능하다.

## 6. 관련 파일

- `server/src/hostaccess/render.js` — 순수 계산(검증·파싱·계획), `service.js` — 실행/commit-confirm, `exec.js` — spawn, `settings.js` — 저장
- `server/src/routes/admin/hostAccess.js` — API(`/api/admin/host-access`, `/draft`, `/plan`, `/apply`, `/confirm`, `/revert`)
- `web/src/views/HostAccessSettings.jsx` — 화면
- `packaging/offline/install.sh` — sudoers 설치, `uninstall.sh` — 제거
- `server/test/hostAccess2485.test.js` — 검증·계획·상태 기계(가짜 실행기)
