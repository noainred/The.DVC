# 설계: 실제 설치 OS 인벤토리 — VM 에 설치된 OS 의 종류 · 버전 전수

작성 2026-11-27 · 상태 **시안(컨펌 대기) — 구현 전** · 시안 캔버스: https://claude.ai/artifact/YKugB6tw11xShCVV4B9QxA
(아트보드 3장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 수치는 그림용 가상값이고, 합계 행(910 VM · 9,748 vCPU · 65,531 GB · 1,484,986 GB)만
사용자가 보낸 OC2 화면의 값이다. 색 · 글자는 `web/src/styles.css` 토큰.)

## 1. 요구(사용자 2026-11-26 ~ 27)

> "왜 ROCKY 리눅스는 없어?" → "나는 VM 에 실제로 설치된 OS 의 모든 종류와 버전을 보고 싶어, 임시로 하는 작업 방법 말고, 제대로 수행하는 방법을 찾아서 제안해줘"

## 2. 지금 코드에서 확인한 것

| 사실 | 위치 |
|---|---|
| Summary ‘OS별 합계’ 는 `osFamily()` 로 분류 — Windows · RHEL · Ubuntu · CentOS · SUSE · Debian 6종 + Other. Rocky · Alma 분기가 없다 | `server/src/routes/api/shared.js:93` · `routes/api/inventory.js:219` |
| 분류 입력 `vm.guestOS` 는 `summary.config.guestFullName` — **사람이 VM 에 설정한 게스트 OS 유형**이고 게스트 안에서 확인한 값이 아니다 | `server/src/vcenter/soapClient.js:2253` · `inventory/osKind.js` 머리말 |
| VM 구성 수집(vmcfg)이 Tools 가 보고한 `guest.guestId` · `guest.guestFullName` 을 이미 읽는다(`cfg.guestIdTools` · `guestNameTools`) — 합계 표는 쓰지 않는다 | `server/src/vmcfg/parse.js:22,75` |
| ‘실제 OS 스캔’ 이 이미 있다 — 게스트 계정으로 `/etc/os-release` · `Win32_OperatingSystem` 을 읽는다. 기본 **꺼짐** · 12시간 주기 · 회당 200대 · 계정 필요 · JSON 파일 저장 · 중앙 직접 수집 대상만 | `server/src/inventory/{osScanner,osDetect,osStore}.js` |
| 실제 OS 분류기(`classifyOs`)에는 Rocky · AlmaLinux · Oracle · Amazon · Fedora 가 있다 — `osFamily()` 와 **판정이 두 벌** | `server/src/inventory/osDetect.js:30` |
| 없는 속성 경로를 요청하면 요청 전체가 InvalidProperty 가 된다 | `server/src/vmcfg/parse.js:19` 주석 |
| 엣지가 올린 인벤토리 글자 필드는 중앙 화이트리스트(`INV_TEXT_KEYS`)로 정제한다 — 새 필드는 여기에도 넣어야 한다 | `server/src/routes/central.js:659` |

## 3. 외부 사실(2026-11-27 Broadcom API 문서 · William Lam 글로 확인)

- `GuestInfo.guestDetailedData` — **vSphere API 8.0.2.0(8.0 U2)부터**. 공백으로 나눈 `name='value'` 목록: `architecture` · `bitness` · `distroName` · `distroVersion` ·
  `distroAddlVersion` · `familyName` · `kernelVersion`(Windows 는 빌드/패치 번호) · `prettyName`. VMware Tools **11.2.0 이상**(일부 필드는 12.2.0 이상).
- 한 번 기록되면 **VM 이 꺼져 있어도 읽힌다**(VM 고급 설정 `guestinfo.detailed.data` 에 마지막 값이 남는다). 한 번도 켜지지 않은 VM 에는 없다.
- 게스트 계정이 필요 없다(Tools 가 스스로 보고) — 속성 수집기(PropertyCollector)로 읽는다.
- **확인하지 못한 것**: ① Windows Server 의 실제 `prettyName` 예시 ② 8.0 U2 미만 vCenter 에서 `config.extraConfig` 의 `guestinfo.detailed.data` 로 같은 값을 읽을 수 있는지
  ③ 28개 vCenter 의 버전 분포와 Tools 11.2 이상 비율. 셋 다 현장 실측이 필요하다(§7 1단계).

## 4. 설계 — 출처 3단 + 판정 코어 하나

```
① Tools 보고(주 출처)   vCenter 8.0 U2+ : guest.guestDetailedData  — 계정 불필요 · 전 VM · 꺼진 VM 은 마지막 값
② 게스트 조회(보완)      ①이 없는 VM 만 : 기존 osScanner(os-release · Win32_OperatingSystem) — 계정 필요 · 법인 로컬 실행
③ 확인 안 됨            ① ②가 모두 없음 : vCenter 설정값은 ‘참고’ 로만 — 다른 종류에 섞지 않고 따로 센다(사유별 개수)
```

- **판정 코어 하나** `inventory/osIdentity.js`(신규 · 순수): 입력(상세 문자열 · os-release · Windows 캡션/빌드) → `{ distro, version, major, kernel, build, arch, source, observedAt }`.
  `osFamily()` · `classifyOs()` 두 벌을 이 모듈로 합친다. Windows 는 빌드 번호 → 릴리스(14393=2016 · 17763=2019 · 20348=2022 · 26100=2025) 표로 읽는다.
  모르는 배포판은 ‘Other’ 로 뭉치지 않고 **보고된 이름 그대로**(distroName) 한 종류로 센다 — ‘모든 종류’ 요구.
- **수집**: vCenter 버전이 8.0.2 이상일 때만 속성 경로를 요청한다(미만에 요청하면 수집 전체가 깨진다). 매 폴링이 아니라 **VM 구성 수집(vmcfg) 주기**에 싣는다 —
  OS 는 자주 바뀌지 않고, 문자열이 VM 당 약 150~250바이트(추정)라 5,850대 기준 주 폴링 응답에 약 1MB 가 더해지는 것을 피한다.
- **엣지(법인 로컬)**: 수집은 그 법인 엣지가 로컬 vCenter 에서 하고 결과만 올린다. 새 필드는 중앙 정제 화이트리스트에 추가하고 길이 상한 · 아는 키만 받는다.
  ② 게스트 조회도 엣지가 로컬에서 묶어 돌리고 요약만 올리도록 옮긴다(지금은 중앙 직접 수집 대상만 — WAN 800ms 구간을 VM 수만큼 왕복하지 않게).
- **저장**: SQLite ‘VM 별 최신 1행’ 표(`vm_os_latest` — 키 `vcenterId + instanceUuid`) + 변경 이력 표(`vm_os_change` — OS 가 바뀐 때만 1행). 트랜잭션으로 묶어 쓴다.
  지금의 `os-inventory.json`(전체를 통째로 다시 쓰는 맵)은 이 표로 옮긴다. 꺼진 VM 은 마지막 확인값 + 확인 시각을 유지한다.
- **표시**: 종류 → 버전 2단(펼침) · 확인 출처 막대(Tools 보고 · 게스트 조회 · 확인 안 됨 + 사유) · ‘설정값과 다름’ · 기준 전환(실제 설치 OS ↔ vCenter 설정값).
  못 읽은 값은 0 도 ‘Other’ 도 아니다 — 따로 센다.

## 4-1. 사용자 결정(2026-11-27)

- **전 vCenter 가 8.0.3 이상**(사용자 확인) → vCenter 버전 게이트 · 8.0 U2 미만 대체 경로(§3 ②)는 **필요 없다**. 남는 조건은 VM 의 Tools 11.2 이상뿐.
- **OS 종류와 VM 성격은 다른 축**: Photon OS 는 ‘Other’ 로 뭉치지 않고 독립 종류(버전도 그대로). 성격은 일반 VM / 어플라이언스 / 시스템 VM —
  시스템 VM 은 `config.managedBy`(vmcfg 가 이미 읽는다), 어플라이언스는 `config.vAppConfig.product`(제품명 · 제조사 · 버전 — 수집 추가 필요)로 판정한다. 이름으로 추측하지 않는다.
- **합계 표 기본값 = 전체 VM**(성격 필터: 전체 VM / 일반 VM 만 / 어플라이언스 · 시스템 VM 만).
- **수동 ‘어플라이언스’ 지정 기능을 넣는다** — 제품 정보가 없는 어플라이언스(ISO 설치 · 제품 정보가 지워진 복제본)용. 자동 판정과 구분해 ‘수동 지정’ 으로 표시하고,
  키는 `vcenterId + instanceUuid`, 쓰기는 쓰기 범위(writeVcenters) 검사 + 감사 로그, 법인 범위 밖 VM 은 404.

## 5. 화면 — 아트보드 3장

```
① Main    Summary ‘OS 종류 · 버전별 합계’ 1440 — 기준 전환 · 확인 출처 막대 · 종류/버전 펼침 표 · ‘확인 안 됨’ 행 분리
② VmList  Guest OS 도구의 VM 목록 1440 — 실제 OS · 버전 · 커널/빌드 · vCenter 설정값(다르면 강조) · 확인 출처 · 확인 시각
③ Narrow  400px — 표 대신 종류 카드(버전은 카드 안 행)
```

## 6. 하지 않는 것 · 한계

- Tools 가 없거나 11.2 미만이고 게스트 계정도 없는 VM 은 **확인할 방법이 없다** — ‘확인 안 됨’ 으로 남는다(설정값으로 채워 넣지 않는다).
- Tools 보고값은 게스트가 스스로 말한 값이다(게스트 관리자가 os-release 를 바꾸면 그대로 보고된다) — 자산 대장용으로는 충분하나 보안 증빙은 아니다.
- 지원 종료(EOL) 표시는 날짜 표를 유지보수해야 해 이번 범위에 넣지 않았다(별도 결정).

## 7. 단계(컨펌 뒤)

1. **실측(읽기 전용 점검 스크립트)** — 법인별 vCenter 버전 · `guestDetailedData` 채움 비율 · Windows 샘플 문자열 · 8.0 U2 미만에서의 대체 경로. 결과로 ① 의 실제 적용 범위를 확정.
2. 판정 코어(`osIdentity.js`) + 테스트(실측 문자열을 고정 입력으로) · `osFamily`/`classifyOs` 합치기.
3. 수집(vmcfg 경로 · 버전 게이트) + 엣지 정제 + SQLite 표 + 기존 JSON 이전.
4. 집계 API(`/summary` OS 합계 · `/tools/guest-os`) + 화면 3장 · Chromium 1440/400.
5. ② 게스트 조회를 ‘①이 없는 VM 만’ 으로 좁히고 엣지 로컬 실행으로 이전.
