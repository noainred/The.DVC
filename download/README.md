# 다운로드 — 오프라인 설치/업그레이드 패키지

Rocky Linux 9 air-gapped 설치/업그레이드용 미리 빌드된 패키지입니다.
**최신 버전: 1.8.0**

| 파일 | 용도 |
|------|------|
| `vmware-portal-offline-<버전>-el9-x64.tar.gz` | **Rocky 9 설치 패키지**(Node 런타임+앱) — 최초 설치 / 수동 재설치 |
| `vmware-portal-win-<버전>-x64.zip` | **Windows 설치 패키지**(Node 런타임+앱) — 수집 에이전트/포탈 (예약 작업 서비스) |
| `vmware-portal-<버전>.tar.gz` | **업그레이드 번들**(앱만, ~1MB) — 자동/수동 업그레이드 |
| `*.sha256` | 무결성 검증 (`sha256sum -c <파일>.sha256`) |
| `versions.json` | 최신 버전 메타데이터 (자동 업그레이드 원격 소스로 사용) |

> 분산 수집(서버 1천대+/DC 13개) 구성: `packaging/DISTRIBUTED-COLLECTION.md`,
> Windows 설치: `packaging/windows/README-WINDOWS.md` 참고.

## 설치 (최초)
```bash
tar -xzf vmware-portal-offline-1.8.0-el9-x64.tar.gz
cd vmware-portal-offline-1.8.0-el9-x64
sudo ./install.sh --port 4000
```

## 업그레이드
- 수동: 새 `vmware-portal-<버전>.tar.gz` 를 감시 폴더에 넣고 관리자 → 업그레이드 탭에서 적용
- 자동(원격): `UPGRADE_REMOTE_BASE` 를 이 `download/` 디렉터리의 raw URL로 지정하면
  `versions.json` 을 보고 최신 버전을 받아 적용합니다.
