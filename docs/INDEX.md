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
| [CAPACITY-ADVISOR.md](CAPACITY-ADVISOR.md) | 리소스 적정성 진단 — 중앙/엣지 서버 자체의 증설·감축 판단 기능 설명 |

## 4. 기능별 상세 문서

| 문서 | 용도 |
|---|---|
| [SERVICE-HUB.md](SERVICE-HUB.md) | 서비스 허브(pyportal) 운영 가이드 — 서비스 포탈 바로가기 허브 사용법 |
| [SVCMON-ARCHITECTURE.md](SVCMON-ARCHITECTURE.md) | 성능점검(svcmon) 아키텍처 — 1만 대·일 2GB 로그 전제의 용량 산정·튜닝 |
| [SVCMON-TESTS.md](SVCMON-TESTS.md) | 성능점검 테스트 유형 15종 — 프로토콜·판정 기준·파라미터 |
| [SVCMON-BULK.md](SVCMON-BULK.md) | 성능점검 대량 등록 — CSV 가져오기/내보내기·대량 자동등록 |

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
| [2026-08-29-fable.MD](2026-08-29-fable.MD) | 2026-08-29 소스 버그 감사(**Fable 5**) — 121건(높음 6·중간 39·낮음 76) + 반복 패턴 5종 |
| [2026-08-29-opus.MD](2026-08-29-opus.MD) | 2026-08-29 소스 버그 감사(**Opus**) — 신규 20건(높음 3·중간 9·낮음 8) + '버그 아님' 7건 역기록 |
| [2026-08-29-sonnet.md](2026-08-29-sonnet.md) | 2026-08-29 소스 버그 감사(**Sonnet**) — 36건(높음 6·중간 22·낮음 8) + 기존 불변조건 회귀 없음 확인 |

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
