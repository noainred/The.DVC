# Packaging

## 오프라인 설치 (Rocky Linux 9, air-gapped)

인터넷이 없는 Rocky Linux 9 서버용 자체 완결형 설치 패키지를 만듭니다. Node.js 런타임,
서버 의존성, 미리 빌드된 웹 UI를 모두 포함하므로 타깃에서는 **인터넷·npm·컴파일러가
필요 없습니다.**

### 1) 빌드

**A. 인터넷 되는 곳에서 (가장 간단)**

```bash
packaging/offline/build-package.sh --node-version 22.20.0
# 결과: dist-offline/vmware-portal-offline-<버전>-el9-x64.tar.gz  (+ .sha256)
```

**B. 인터넷이 전혀 없는 빌드 호스트에서**

Node 런타임 압축본(`node-v22.20.0-linux-x64.tar.xz`)을 미리 받아두고, 저장소에
`node_modules`가 있는 상태(온라인에서 `npm run install:all` 1회)에서:

```bash
packaging/offline/build-package.sh --offline \
  --node-tarball /경로/node-v22.20.0-linux-x64.tar.xz
```

빌드 과정: Node.js 런타임(다운로드 또는 로컬 압축본) → 웹 클라이언트 빌드(web/dist) →
서버 프로덕션 의존성 벤더링(node_modules) → 설치 스크립트·systemd 유닛과 함께 tar.gz 패킹.

> 인터넷이 어디에도 없으면 빌드 없이 **미리 빌드된 tarball**을 받아 바로 2)로 설치하세요.

### 2) 설치 (오프라인 Rocky 9 서버에서)

```bash
tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz
cd vmware-portal-offline-<버전>-el9-x64
sudo ./install.sh --port 4000
```

자세한 절차·운영·업그레이드·제거는 `packaging/offline/OFFLINE-INSTALL.md` 를 참고하세요.

> 빌드 산출물(`dist-offline/`)은 용량이 크므로 git에 커밋하지 않습니다(`.gitignore`).
