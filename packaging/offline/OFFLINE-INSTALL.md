# VMware Global Monitoring Portal — 오프라인 설치 (Rocky Linux 9)

이 패키지는 **인터넷이 없는(air-gapped) Rocky Linux 9** 서버에 그대로 설치할 수 있는
자체 완결형 번들입니다. Node.js 런타임, 서버 의존성, 미리 빌드된 웹 UI가 모두 포함되어
있어 **인터넷·npm·컴파일러가 필요 없습니다.**

## 패키지 구성

```
vmware-portal-offline-<버전>-el9-x64/
├── runtime/node/           # 번들된 Node.js 런타임 (linux-x64)
├── app/                    # 포탈 (server + 벤더링된 node_modules + web/dist)
├── install.sh              # 설치 스크립트
├── uninstall.sh            # 제거 스크립트
├── vmware-portal.service   # systemd 유닛 템플릿
├── portal.env.example      # 환경설정 예시
├── VERSION
└── README.md               # (이 문서)
```

## 패키지 만들기

설치는 항상 오프라인입니다. 패키지(tarball)를 만드는 방법은 두 가지입니다.

### A. 인터넷 되는 곳에서 빌드 (가장 간단)

```bash
packaging/offline/build-package.sh
# → dist-offline/vmware-portal-offline-<버전>-el9-x64.tar.gz
```

### B. 인터넷이 전혀 없는 곳에서 빌드 (air-gapped 빌드 호스트)

미리 두 가지만 준비하면 네트워크 없이도 패키지를 만들 수 있습니다:

1. Node.js 런타임 압축본을 미리 받아 복사:
   `https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz`
2. 의존성이 포함된 저장소(온라인에서 `npm run install:all` 1회 실행 → `node_modules` 포함).

그런 다음 네트워크 없이:

```bash
packaging/offline/build-package.sh --offline \
  --node-tarball /경로/node-v22.20.0-linux-x64.tar.xz
```

> 인터넷이 어디에도 없다면 빌드 과정 없이 **미리 빌드된 tarball을 받아** 바로 설치하면 됩니다.

## 설치

1. tarball을 USB/내부망으로 Rocky 9 서버에 복사합니다.
2. 압축을 풀고 설치 스크립트를 실행합니다(root 필요):

```bash
tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz
cd vmware-portal-offline-<버전>-el9-x64
sudo ./install.sh --port 4000
```

설치가 끝나면:

- 서비스: `vmware-portal` (systemd, 부팅 시 자동 시작)
- URL: `http://<서버 IP>:4000`
- 기본 로그인: **admin / admin123** (운영 시 반드시 변경)

## 설치 후 설정

환경설정은 `/etc/vmware-portal/portal.env` 에 있습니다. 수정 후 재시작:

```bash
sudo vi /etc/vmware-portal/portal.env      # DATA_SOURCE, vCenter, 비밀번호 등
sudo systemctl restart vmware-portal
```

실제 vCenter 연결: `DATA_SOURCE=live` 로 바꾸고
`/opt/vmware-portal/app/server/config/vcenters.json` 을 작성하세요
(예시: `vcenters.example.json`).

사용자 관리: `/opt/vmware-portal/app/server/config/users.json` 작성
(비밀번호 해시 생성):

```bash
cd /opt/vmware-portal/app/server
sudo -u vmportal /opt/vmware-portal/runtime/node/bin/node \
  -e "import('./src/auth/auth.js').then(m=>console.log(m.hashPassword(process.argv[1])))" 'YourPassword'
```

## 운영 명령

```bash
systemctl status vmware-portal       # 상태
journalctl -u vmware-portal -f       # 실시간 로그
systemctl restart vmware-portal      # 재시작
```

## 업그레이드 (오프라인)

새 버전도 같은 방식으로 오프라인 설치할 수 있습니다. 새 tarball을 풀고 `sudo ./install.sh`
를 다시 실행하면 기존 앱이 `app.bak.<timestamp>` 로 백업된 뒤 교체되고 서비스가 재시작됩니다.

또는 포탈 내장 **자동 업그레이드**(관리자 → 업그레이드 탭)를 쓰려면 `portal.env` 에서
`UPGRADE_ENABLED=true`, `UPGRADE_WATCH_DIR=/opt/vmware-portal/incoming`,
`UPGRADE_INSTALL_DIR=/opt/vmware-portal/app` 를 설정하고 새 번들
(`vmware-portal-<버전>.tar.gz`)을 감시 폴더에 넣으세요.

## 제거

```bash
sudo ./uninstall.sh            # 앱/런타임/서비스 제거 (설정 유지)
sudo ./uninstall.sh --purge    # 설정과 사용자까지 완전 제거
```
