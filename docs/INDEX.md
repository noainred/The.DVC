# 문서 목차 (INDEX)

저장소의 모든 문서를 한눈에 찾을 수 있는 목차입니다. **파일명 + 한 줄 용도**로 정리했으며,
새 문서를 추가할 때 이 목차에도 한 줄을 추가해 주세요. (경로는 이 파일 기준 상대 경로)

---

## 1. 시작하기 · 사용자 가이드

| 문서 | 용도 |
|---|---|
| [../README.md](../README.md) | 프로젝트 소개 + 전체 기능·아키텍처·빠른 시작 — **가장 먼저 읽는 문서** |
| [INSTALL.md](INSTALL.md) | 설치 가이드(중앙/엣지/수집기 역할, 토큰, 방화벽, git 소스 설치 부록) |
| [GUIDE-BEGINNER.md](GUIDE-BEGINNER.md) | 처음 사용자 가이드 — 조회 위주 기본 사용법(화면 캡처 포함) |
| [GUIDE-INTERMEDIATE.md](GUIDE-INTERMEDIATE.md) | 중급 사용자 가이드 — 운영 리포트·특수 기능 등 실무 기능 활용 |
| [GUIDE-ADMIN.md](GUIDE-ADMIN.md) | 관리자 가이드 — 설치·구성·계정/권한·보안 운영 |
| [SETTINGS.md](SETTINGS.md) | **설정 화면 탭별 안내** — 각 탭의 기능·저장 파일·환경변수·권한·주의사항(화면 목록의 진실의 원천은 `web/src/views/Settings.jsx` 의 `SUB`) |
| [API.md](API.md) | **API 레퍼런스 — 전 엔드포인트**(자동 생성, 개수는 생성 문서 머리말 참조). 그룹·게이트·권한·소스 위치 |
| [API-PUBLIC.md](API-PUBLIC.md) | **외부 포탈 연동 가이드** — 공개 조회 API(`/api/v1`) 인증·계약·필드·오류·예제 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **코드 지도와 데이터 흐름** — 모듈 배치, 중앙↔엣지 6방향, 시계열 DB 20종, 폴러 규약 |
| [ENV.md](ENV.md) | **환경변수 레퍼런스**(자동 생성, 개수는 생성 문서 머리말 참조) — 분류·기본값·정의 위치 |
| [CONFIG-FILES.md](CONFIG-FILES.md) | **설정·데이터 파일 레퍼런스**(자동 생성, 개수는 생성 문서 머리말 참조) — 용도·원자적 쓰기·권한·지우면 생기는 일 |

## 2. 설치 · 배포 · 패키징

| 문서 | 용도 |
|---|---|
| [../packaging/offline/OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md) | 에어갭(Rocky Linux 9) 오프라인 설치 패키지의 구성·설치·업그레이드 상세 |
| [../packaging/README.md](../packaging/README.md) | 패키징 개요 — 오프라인 패키지 빌드 방법(`build-package.sh`) |
| [../packaging/windows/README-WINDOWS.md](../packaging/windows/README-WINDOWS.md) | Windows 수집 에이전트/포탈 오프라인 설치 |
| [../packaging/DISTRIBUTED-COLLECTION.md](../packaging/DISTRIBUTED-COLLECTION.md) | 분산 수집 아키텍처 — DC별 수집 에이전트 + 중앙 병합(전력 iDRAC/OME) |
| [RELEASES.md](RELEASES.md) | GitHub Releases(롤링 `downloads` 태그) 게시 구조 — 자동 업그레이드의 원천 |
| [../download/README.md](../download/README.md) | 다운로드 안내 — 바이너리는 git이 아닌 GitHub Releases에서 받음 |

## 3. 아키텍처 · 운영 구성

| 문서 | 용도 |
|---|---|
| [EDGE-SETUP.md](EDGE-SETUP.md) | 엣지(원격 DC) 포탈 설정 — 중앙↔엣지 구조·토큰·수집 모드 |
| [AIRGAP-LLM-SETUP-GUIDE.md](AIRGAP-LLM-SETUP-GUIDE.md) | 에어갭 LLM 서버 구축 — Rocky9 + A40 vGPU + Ollama + Qwen(자연어 검색 백엔드) |
| [EDGE-COLLECTOR-MERGE.md](EDGE-COLLECTOR-MERGE.md) | 이전 절차서 — 별도 수집서버(전력 전용 VM)를 엣지 노드로 통합·폐기 |
| [NETWORK-COMMS-FIREWALL.md](NETWORK-COMMS-FIREWALL.md) | 전 프로세스 통신 경로 82종 — 방화벽(ACL) 오픈 가이드(포트·방향·근거 코드) |
| [MAINTENANCE-PAGE.md](MAINTENANCE-PAGE.md) | 업데이트·재시작 다운타임 안내 — 앱 내 자동 재연결(v2.462) + 새 탭 접속용 프록시 유지보수 페이지(nginx/HAProxy) |
| [CAPACITY-ADVISOR.md](CAPACITY-ADVISOR.md) | 리소스 적정성 진단 — 중앙/엣지 서버 자체의 증설·감축 판단 기능 설명 |
| [ARCH-HEAVY-JOB-ISOLATION.md](ARCH-HEAVY-JOB-ISOLATION.md) | 대용량 작업 격리 아키텍처 — vCenter 수집 프로세스 분리 vs worker_threads 설계 검토·비교('불러오는 중' 정지 방지) |

## 4. 기능별 상세 문서

| 문서 | 용도 |
|---|---|
| [SERVICE-HUB.md](SERVICE-HUB.md) | 서비스 허브(pyportal) 운영 가이드 — 서비스 포탈 바로가기 허브 사용법 |
| [HUB-PASSWORD-RECOVERY.md](HUB-PASSWORD-RECOVERY.md) | **비밀번호 분실·잠금 복구** — 다빈치(OTP 재등록)·pyportal(콘솔 초기화) 관리자 계정 복구 절차 |
| [SVCMON-ARCHITECTURE.md](SVCMON-ARCHITECTURE.md) | 성능점검(svcmon) 아키텍처 — 1만 대·일 2GB 로그 전제의 용량 산정·튜닝 |
| [SVCMON-TESTS.md](SVCMON-TESTS.md) | 성능점검 테스트 유형 15종 — 프로토콜·판정 기준·파라미터 |
| [SVCMON-BULK.md](SVCMON-BULK.md) | 성능점검 대량 등록 — CSV 가져오기/내보내기·대량 자동등록 |
| [DEVICE-BULK-IMPORT.md](DEVICE-BULK-IMPORT.md) | **SAN 스위치·스토리지 대량 등록** — CSV·자유텍스트 열/표기, 선택 항목 비우는 방법(vfId 등), 3단계(검증→연결 테스트→선택 등록), 오류별 조치 |

## 5. 보안 감사 · 점검 기록 (시간순)

| 문서 | 용도 |
|---|---|
| [../SECURITY-AUDIT.md](../SECURITY-AUDIT.md) | 최초(1차) 전체 소스 보안 감사 보고서 — 대부분 조치 완료, 이력 문서 |
| [AUDIT-2026-06-27.md](AUDIT-2026-06-27.md) | 2026-06-27 전체 소스 보안·버그 감사 + v2.190/191/195 하드닝 이력 |
| [../security_check_20260808.MD](../security_check_20260808.MD) | 2026-08-08 전역 보안 점검(v2.246) + M1 IPAM scope 등 조치 경과 |
| [../codex_check_20260808.MD](../codex_check_20260808.MD) | 2026-08-08 Codex 정적 점검 보고 — 보안·완성도 종합 판정 |
| [../security_check_20260809.MD](../security_check_20260809.MD) | 2026-08-09 적대적 검증 방식 보안 점검(v2.257) |
| [../M3_UAGMON_HANDOFF.md](../M3_UAGMON_HANDOFF.md) | uagmon M3(자격증명 유출) 결함의 타 세션 인계 문서 |
| [AUDIT-2026-08-13.md](AUDIT-2026-08-13.md) | 2026-08-13 전수 감사(v2.272) — 신규 CRITICAL/HIGH 0건 확인 |
| [AUDIT-2026-08-17.md](AUDIT-2026-08-17.md) | 2026-08-17 7차원 전수 감사(v2.322 조치 11건 + 회귀 방지 테스트) |
| [AUDIT-2026-09-09.md](AUDIT-2026-09-09.md) | 전체 소스 감사(v2.446 기준) — 버그 16·보안 17·개선 12·튜닝 17, v2.448 에서 20건 적용 |
| [AUDIT-2026-09-11.md](AUDIT-2026-09-11.md) | 직전 감사 미적용 22건 재판정(v2.477 기준) — 17건 v2.478 조치·수정됨 5·보류 2, 의존성 실측(jspdf critical 해소)·CI critical 차단·문서 정합성 |
| [AUDIT-2026-09-11b.md](AUDIT-2026-09-11b.md) | 전체 소스 감사 2차(v2.478 기준) — 보안 16·버그 28·개선 22·튜닝 24, v2.479 에서 15건 조치 + 직전 문서 오판 2건 정정 |
| [AUDIT-2026-09-11c.md](AUDIT-2026-09-11c.md) | 전체 소스 감사 3차(v2.479 기준, 미완독 영역) — 보안 24·버그 30·개선 21·튜닝 19, v2.480 에서 17건 조치(번들 sha256 양쪽 검증 불변조건 실제화) |
| [AUDIT-2026-09-13.md](AUDIT-2026-09-13.md) | 보안 전수 감사(v2.499 기준, 8도메인 병렬 · 라우트 701건 전수) — critical 1·high 4 실행 재현 후 v2.500 조치, 미해결 9건 명시, 의존성 웹 dev 11→6 |
| [PERF-AUDIT-2026-09-13.md](PERF-AUDIT-2026-09-13.md) | 성능·보안 전수조사(v2.503) — 성능 5도메인 + 보안 2도메인 병렬, 실측/추정을 구분해 조치·미해결 기록 |
| [AUDIT-2026-09-16.md](AUDIT-2026-09-16.md) | 보안 감사 1차(v2.535) — 자격증명·비밀 추적. medium 1·low 3 전부 조치 |
| [AUDIT-2026-09-16b.md](AUDIT-2026-09-16b.md) | 보안 감사 2차(v2.536) — 인증·인가 게이트 전수(라우트 미들웨어 체인·별칭 해석). high 1·low 1 수정 |
| [AUDIT-2026-09-16c.md](AUDIT-2026-09-16c.md) | 보안 감사 3차(v2.537) — 외부 입력 → 장비 접속·명령 경로. medium 2·low 2 수정(DNS 리바인딩 훅 없는 dispatcher) |
| [AUDIT-2026-09-16d.md](AUDIT-2026-09-16d.md) | 보안 감사 4차(v2.538) — 저장 파일·저장 데이터·외부 공격면(목 서버 무인증 실측). medium 2·low 2 수정 |
| [AUDIT-2026-09-21.md](AUDIT-2026-09-21.md) | 전체 소스 감사(v2.573 기준, 확정분만) — 버그 24·보안 18·개선 12, v2.574~2.575 조치 |
| [AUDIT-2026-09-22.md](AUDIT-2026-09-22.md) | 전수 감사(v2.576) — 확정 결함 9건·개선 2건 + 오픈소스 라이선스 점검(F1~F5) 조치 |
| [AUDIT-2026-09-22b.md](AUDIT-2026-09-22b.md) | 전수 보안·튜닝 감사(v2.577) — CSP 기본 적용 등 확정 조치 3건 + 운영 규모(`MOCK_SCALE=3`) 실측 |
| [AUDIT-2026-09-22c.md](AUDIT-2026-09-22c.md) | v2.578 — 기간이 값을 바꾸는 이유를 화면이 말하게(v2.510 이 미뤄 둔 결함 4건) |
| [AUDIT-2026-09-23.md](AUDIT-2026-09-23.md) | 아키텍처 점검 1차(v2.579) — 서버 의존 그래프(순환 7→5)·동시성 풀 사본 통합·운영 규모 튜닝 실측 |
| [AUDIT-2026-09-23b.md](AUDIT-2026-09-23b.md) | 아키텍처 점검 2차(v2.580) — 웹 의존 그래프·SQLite 동시 open·세대 키 캐시 상주·손상 파일 처리 |
| [AUDIT-2026-09-23c.md](AUDIT-2026-09-23c.md) | 아키텍처 점검 3차(v2.581) — 런타임 계측(SQL 실행 계획·동기 fs)·vmperf 핸들 스래싱·storage push 0대·플래키 원인 |
| [AUDIT-2026-09-23d.md](AUDIT-2026-09-23d.md) | 아키텍처 점검 4차(v2.582) — 아키텍처·버그·튜닝 각 5건(파일 스토어 규약·날짜 코어·워커 무음 실패 등) |
| [HOST-ACCESS.md](HOST-ACCESS.md) | 호스트 접근 제어(v2.485) — SSH/웹 클라이언트 제어·OS 방화벽을 포탈에서(firewalld, commit-confirm), 한계, 함께 쓰면 좋은 오픈소스 비교 |
| [2026-08-29-fable.MD](2026-08-29-fable.MD) | 2026-08-29 소스 버그 감사(**Fable 5**) — 121건(높음 6·중간 39·낮음 76) + 반복 패턴 5종 |
| [2026-08-29-opus.MD](2026-08-29-opus.MD) | 2026-08-29 소스 버그 감사(**Opus**) — 신규 20건(높음 3·중간 9·낮음 8) + '버그 아님' 7건 역기록 |
| [2026-08-29-sonnet.md](2026-08-29-sonnet.md) | 2026-08-29 소스 버그 감사(**Sonnet**) — 36건(높음 6·중간 22·낮음 8) + 기존 불변조건 회귀 없음 확인 |
| [REVIEW-2026-09-07.md](REVIEW-2026-09-07.md) | 2026-09-07 전체 소스 리뷰(v2.409~2.415 신규 모듈 중심) — v2.416 수정 항목과 남은 개선 포인트 |

### 2026-08-29 3중 감사 — 모델별 분석 결과

같은 코드베이스를 세 모델이 각각 독립 감사한 결과입니다. 발견 건수는 감사 방식(분할 폭·심각도
기준·중복 제거 정도)에 좌우되므로 **모델 성능의 직접 비교로 읽으면 안 됩니다.**

| 모델 | 감사 대상 | 감사 방식 | 발견 | 높음 | 분석 결과의 특징 |
|---|---|---|---|---|---|
| Fable 5 | v2.391.0 (`1e0a10b`) | 14개 영역 분할 병렬 → 취합·중복 제거, 읽기 전용 | **121건** | 6 | 최다 발견. 개별 결함을 **반복 패턴 5종**(응답 경합 가드 누락 · 조회 scope 누락 · 손상 스토어 조용한 리셋 · claim→ack 미적용 위임 큐 · 모지바케 유입)으로 구조화해 일괄 수정이 가능하게 정리 |
| Opus | v2.391.0 (`1e0a10b`) | 정적 분석 + **순수 함수 실제 실행으로 재현 검증** | **신규 20건** | 3 | 항목마다 확신도(확정/높음/추정)를 분리 표기하고, 재검증에서 **'버그 아님' 7건을 역기록**해 다음 감사가 같은 항목을 다시 올리지 않게 함 |
| Sonnet | 저장소 전체(`server/src`·`web/src`·`pyportal`) | 8개 전문 서브에이전트 영역 병렬 | **36건** | 6 | 신규 버그와 함께 **문서화된 기존 불변조건의 회귀 여부를 전수 확인**(트랜잭션·재진입 가드·ETag/304·WAL·claim→ack·preserveCorrupt 등 — 회귀 없음) |

- 세 보고서는 경쟁이 아니라 **중복·상호보완** 관계입니다(같은 결함을 다른 심각도로 잡은 항목 다수).
- 공통으로 지목된 축: **조회 라우트 scope 누락**, **손상 스토어의 조용한 리셋(`preserveCorrupt` 누락)**,
  **SSH/외부 호출 타임아웃 부재**, **프론트 폴링 뷰의 `error && !data` 누락**, **이중 UTF-8 인코딩 유입**.
- 조치 현황은 이 문서들이 아니라 별도 백로그로 추적합니다(감사 시점 v2.391 이후 릴리스에서 일부가
  이미 수정됐을 수 있으므로, 착수 전 해당 파일:라인의 현재 코드를 반드시 재확인할 것).

## 6. 작업 기록 (WORKLOG)

| 문서 | 용도 |
|---|---|
| [WORKLOG-2026-07-31.md](WORKLOG-2026-07-31.md) | 작업 기록 v2.182~v2.195 — 무엇을·왜·어떻게(초보자용 설명) |
| [WORKLOG-2026-08-01.md](WORKLOG-2026-08-01.md) | 작업 기록 v2.196~v2.210 — 권한 세분화·로그인 테마·계정 정책 |

## 7. 서브 프로젝트 README

| 문서 | 용도 |
|---|---|
| [../pyportal/README.md](../pyportal/README.md) | 서비스 허브(Python) 기술 문서 — 환경변수·REST API·테스트 |
| [../uagmon/README.md](../uagmon/README.md) | UAG Monitor — Horizon UAG 상태/세션 경량 모니터(서버·CLI·단일 파일) |
| [../horizon-uag-monitor/README.md](../horizon-uag-monitor/README.md) | Horizon UAG Monitor — Windows 11 트레이 상주 점검 프로그램(C#) |

## 8. 개발 규칙 (AI 협업 지침 — 사람이 읽어도 유효)

| 문서 | 용도 |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | 프로젝트 공통 개발 규칙 — 운영 환경 전제·성능 메커니즘·릴리스 절차 |
| [../server/CLAUDE.md](../server/CLAUDE.md) | 서버 보안 불변조건 — TLS·RBAC·scope·OTP 등 회귀 금지 규칙 |
| [../pyportal/CLAUDE.md](../pyportal/CLAUDE.md) | 서비스 허브(pyportal) 불변조건 — 감사로 확립된 규칙 |

## 9. 전체 문서 목록 (생성 — `scripts/arch-doc.mjs`)

> 위 1~8 절은 손으로 분류한 목록이라 새 문서를 빠뜨릴 수 있습니다(v2.613 시점에 감사 보고서 17개·`CVP.md` 가
> 빠져 있었습니다). 이 절은 `docs/*.md` 전부를 **생성**하며 CI 가 `--check` 로 최신 여부를 봅니다 — 손으로 고치지 마세요.

<!-- arch-doc:docs:start -->
| 문서 | 제목(첫 줄) |
|---|---|
| [2026-08-29-fable.MD](2026-08-29-fable.MD) | 소스 버그 감사 보고서 — 2026-08-29 (Fable 5) |
| [2026-08-29-opus.MD](2026-08-29-opus.MD) | 소스 버그 감사 — 2026-08-29 (Opus) |
| [2026-08-29-sonnet.md](2026-08-29-sonnet.md) | 2026-08-29 소스 전체 버그 감사 (Sonnet) |
| [AIRGAP-LLM-SETUP-GUIDE.md](AIRGAP-LLM-SETUP-GUIDE.md) | 에어갭 LLM 서버 구축 가이드 — Rocky Linux 9 + NVIDIA A40(24GB vGPU) + Ollama + Qwen |
| [API-PUBLIC.md](API-PUBLIC.md) | 공개 조회 API (`/api/v1`) — 외부 포탈 연동 가이드 |
| [API.md](API.md) | API 레퍼런스 (전 엔드포인트) |
| [ARCH-CHECK.md](ARCH-CHECK.md) | 아키텍처 점검(특수 기능 › 포탈 점검) — 판정 계약 (v2.614) |
| [ARCH-HEAVY-JOB-ISOLATION.md](ARCH-HEAVY-JOB-ISOLATION.md) | 대용량 작업 격리 아키텍처 — vCenter 수집 프로세스 분리 vs worker_threads |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 아키텍처 — 코드 지도와 데이터 흐름 |
| [AUDIT-2026-06-27.md](AUDIT-2026-06-27.md) | 전체 소스 보안·버그 감사 (2026-06-27) |
| [AUDIT-2026-08-13.md](AUDIT-2026-08-13.md) | 전체 소스 보안·버그 감사 (2026-08-13) |
| [AUDIT-2026-08-17.md](AUDIT-2026-08-17.md) | 전체 소스 보안·취약점 감사 (2026-08-17) |
| [AUDIT-2026-09-09.md](AUDIT-2026-09-09.md) | 전체 소스 감사 — 2026-09-09 (v2.446.0 기준) |
| [AUDIT-2026-09-11.md](AUDIT-2026-09-11.md) | 전체 소스 감사 — 2026-09-11 (v2.477.0 기준 → v2.478.0 조치) |
| [AUDIT-2026-09-11b.md](AUDIT-2026-09-11b.md) | 전체 소스 감사(2차) — 2026-09-11 (v2.478.0 기준 → v2.479.0 조치) |
| [AUDIT-2026-09-11c.md](AUDIT-2026-09-11c.md) | 전체 소스 감사(3차) — 2026-09-11 (v2.479.0 기준 → v2.480.0 조치) |
| [AUDIT-2026-09-13.md](AUDIT-2026-09-13.md) | 보안 전수 감사 — 2026-09-13 (v2.499.0 기준 → v2.500.0 조치) |
| [AUDIT-2026-09-16.md](AUDIT-2026-09-16.md) | 보안 감사 2026-09-16 — 자격증명·비밀 추적 (v2.535) |
| [AUDIT-2026-09-16b.md](AUDIT-2026-09-16b.md) | 보안 감사 — 인증·인가 게이트 전수 (v2.536, 2026-09-16) |
| [AUDIT-2026-09-16c.md](AUDIT-2026-09-16c.md) | 보안 감사 — 외부 입력 → 장비 접속·명령 경로 (v2.537, 2026-09-16) |
| [AUDIT-2026-09-16d.md](AUDIT-2026-09-16d.md) | 보안 감사 — 저장 파일 · 저장 데이터 · 외부 공격면 (v2.538, 2026-09-16) |
| [AUDIT-2026-09-21.md](AUDIT-2026-09-21.md) | 전체 소스 감사 — 버그 · 개선 · 보안 (2026-09-21, v2.573.0 기준) |
| [AUDIT-2026-09-22.md](AUDIT-2026-09-22.md) | 전수 감사 — 2026-09-22 (v2.576.0) |
| [AUDIT-2026-09-22b.md](AUDIT-2026-09-22b.md) | 전수 보안·튜닝 감사 — 2026-09-22 (v2.577.0) |
| [AUDIT-2026-09-22c.md](AUDIT-2026-09-22c.md) | v2.578 — 기간이 값을 바꾸는 이유를 화면이 말하게 (2026-09-22) |
| [AUDIT-2026-09-23.md](AUDIT-2026-09-23.md) | v2.579 — 아키텍처 점검·버그 수정·튜닝 (2026-09-23) |
| [AUDIT-2026-09-23b.md](AUDIT-2026-09-23b.md) | v2.580 — 아키텍처 점검·버그 수정·튜닝 2차 (2026-09-23) |
| [AUDIT-2026-09-23c.md](AUDIT-2026-09-23c.md) | v2.581 — 아키텍처 점검·버그 수정·튜닝 3차 (2026-09-23) |
| [AUDIT-2026-09-23d.md](AUDIT-2026-09-23d.md) | v2.582 — 아키텍처 점검·버그 수정·튜닝 4차 (2026-09-23) |
| [AUDIT-2026-09-24.md](AUDIT-2026-09-24.md) | 4차 점검 — 7축 병렬 감사 (v2.593, 2026-09-24) |
| [AUDIT-2026-09-24b.md](AUDIT-2026-09-24b.md) | 5차 점검 — 7축 병렬 감사 (v2.594, 2026-09-24) |
| [AUDIT-2026-09-24c.md](AUDIT-2026-09-24c.md) | 6차 점검 — 7축 병렬 감사 (v2.595, 2026-09-24) |
| [AUDIT-2026-09-24d.md](AUDIT-2026-09-24d.md) | 7차 점검 — 7축 병렬 감사 (v2.596, 2026-09-24) |
| [AUDIT-2026-09-24e.md](AUDIT-2026-09-24e.md) | 8차 점검 — 7축 병렬 감사 (v2.597, 2026-09-24) |
| [AUDIT-2026-09-24f.md](AUDIT-2026-09-24f.md) | 9차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.598, 2026-09-24) |
| [AUDIT-2026-09-24g.md](AUDIT-2026-09-24g.md) | 10차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.599, 2026-09-24) |
| [AUDIT-2026-09-24h.md](AUDIT-2026-09-24h.md) | 11차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.600, 2026-09-24) |
| [AUDIT-2026-09-24i.md](AUDIT-2026-09-24i.md) | 12차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.601, 2026-09-24) |
| [AUDIT-2026-09-24j.md](AUDIT-2026-09-24j.md) | 13차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.602, 2026-09-24) |
| [AUDIT-2026-09-24k.md](AUDIT-2026-09-24k.md) | 14차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.603, 2026-09-24) |
| [AUDIT-2026-09-24l.md](AUDIT-2026-09-24l.md) | 15차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.604, 2026-09-24) |
| [AUDIT-2026-09-24m.md](AUDIT-2026-09-24m.md) | 16차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.605, 2026-09-24) |
| [AUDIT-2026-09-24n.md](AUDIT-2026-09-24n.md) | 17차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.606, 2026-09-24) |
| [AUDIT-2026-09-24o.md](AUDIT-2026-09-24o.md) | 18차 점검 — 10축 병렬 감사 + 발견별 2인 반증 (v2.607, 2026-09-24) |
| [AUDIT-2026-09-25.md](AUDIT-2026-09-25.md) | 19차 점검 (v2.611) — 2026-09-25 |
| [AUDIT-2026-09-25b.md](AUDIT-2026-09-25b.md) | 20차 점검 (v2.612) — 2026-09-25 |
| [AUDIT-2026-09-25c.md](AUDIT-2026-09-25c.md) | 아키텍처 점검(특수 기능·신규 기능) — v2.613 — 2026-09-25 |
| [AUDIT-2026-09-26.md](AUDIT-2026-09-26.md) | 2026-09-26 전면 점검 (v2.617 게시 전 + v2.618) |
| [AUDIT-2026-09-26b.md](AUDIT-2026-09-26b.md) | 감사 2026-09-26(b) — v2.620 버그·코드 개선 |
| [CAPACITY-ADVISOR.md](CAPACITY-ADVISOR.md) | 리소스 적정성 진단 (Capacity Advisor) |
| [CONFIG-FILES.md](CONFIG-FILES.md) | 설정·데이터 파일 레퍼런스 (자동 생성) |
| [CVP.md](CVP.md) | Arista CloudVision(CVP) 네트워크 스위치 수집 (v2.608) |
| [DEVICE-BULK-IMPORT.md](DEVICE-BULK-IMPORT.md) | 장비 대량 등록(CSV · 자유텍스트) — SAN 스위치 / 스토리지 / Horizon |
| [EDGE-COLLECTOR-MERGE.md](EDGE-COLLECTOR-MERGE.md) | 이전 절차서 — 별도 수집서버(원격)를 엣지 노드 포탈로 통합 |
| [EDGE-SETUP.md](EDGE-SETUP.md) | 엣지(Edge) 설정 방법 |
| [ENV.md](ENV.md) | 환경변수 레퍼런스 (자동 생성) |
| [GUIDE-ADMIN.md](GUIDE-ADMIN.md) | 관리자 가이드 — 설치·구성·보안 운영 |
| [GUIDE-BEGINNER.md](GUIDE-BEGINNER.md) | 처음 사용자 가이드 — VMware Global Monitoring Portal |
| [GUIDE-INTERMEDIATE.md](GUIDE-INTERMEDIATE.md) | 중급 사용자 가이드 — 운영 실무 기능 활용 |
| [HOST-ACCESS.md](HOST-ACCESS.md) | 호스트 접근 제어 (설정 › Security › 호스트 접근 제어, v2.485) |
| [HUB-PASSWORD-RECOVERY.md](HUB-PASSWORD-RECOVERY.md) | 비밀번호 분실·잠금 복구 (관리자 비밀번호 초기화) |
| [INDEX.md](INDEX.md) | 문서 목차 (INDEX) |
| [INSTALL.md](INSTALL.md) | 설치 가이드 (The Davinci Virtual Platform) |
| [MAINTENANCE-PAGE.md](MAINTENANCE-PAGE.md) | 업데이트·재시작 안내 페이지 (다운타임 안내) |
| [NETWORK-COMMS-FIREWALL.md](NETWORK-COMMS-FIREWALL.md) | 네트워크 통신 · 방화벽 오픈 가이드 (The DVC Portal) |
| [PERF-AUDIT-2026-09-13.md](PERF-AUDIT-2026-09-13.md) | 성능·보안 전수조사 (2026-09-13, v2.503.0) |
| [RELEASES.md](RELEASES.md) | 릴리스/다운로드 — GitHub Releases 가이드 |
| [REVIEW-2026-09-07.md](REVIEW-2026-09-07.md) | 전체 소스 리뷰 (2026-09-07, v2.409 ~ v2.415 신규 모듈 중심) — 결과와 남은 개선 포인트 |
| [SERVICE-HUB.md](SERVICE-HUB.md) | 글로벌 데이터센터 서비스 허브 (pyportal) — 운영 가이드 |
| [SETTINGS.md](SETTINGS.md) | 설정 화면 안내 — 모든 탭·모든 설정 (v2.583) |
| [SVCMON-ARCHITECTURE.md](SVCMON-ARCHITECTURE.md) | 성능점검 — 아키텍처 / 용량 산정 / 튜닝 |
| [SVCMON-BULK.md](SVCMON-BULK.md) | 성능점검 — 가져오기 / 내보내기 · 대량 자동등록 |
| [SVCMON-TESTS.md](SVCMON-TESTS.md) | 성능점검 — 테스트 유형 상세 |
| [WORKLOG-2026-07-31.md](WORKLOG-2026-07-31.md) | 작업 기록 — VMware Global Monitoring Portal (The.DVC) |
| [WORKLOG-2026-08-01.md](WORKLOG-2026-08-01.md) | 작업 기록 — 권한 세분화 · 로그인 테마 · 계정 정책 · 보안 감사 (2026-08-01) |

`docs/*.md` 75개(이름순). 위 분류 절에 없는 문서도 여기에는 반드시 있다 — 분류 절은 손으로 쓰고 이 절은 생성한다.
<!-- arch-doc:docs:end -->
