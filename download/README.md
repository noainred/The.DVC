# 다운로드 — 오프라인 설치 패키지

Rocky Linux 9 air-gapped 설치용 미리 빌드된 패키지입니다.

- `vmware-portal-offline-1.0.0-el9-x64.tar.gz` — 자체 완결형 설치 패키지(Node 런타임 + 서버 의존성 + 웹 UI 포함)
- `*.sha256` — 무결성 검증 (`sha256sum -c <파일>.sha256`)
- `versions.json` — 버전 메타데이터(자동 업그레이드 원격 소스로도 사용 가능)

## 설치
```bash
tar -xzf vmware-portal-offline-1.0.0-el9-x64.tar.gz
cd vmware-portal-offline-1.0.0-el9-x64
sudo ./install.sh --port 4000
```
