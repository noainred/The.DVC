# 영역별 규칙 문서 색인

> 루트 `CLAUDE.md` 가 6,209줄·902KB 까지 자라 매 턴·매 하위 에이전트에 실리던 것을 2026-10-20 에 나눴다.
> 루트에는 요약·사용자 선호·색인만 남고, 영역별 '되돌리지 말 것' 규칙과 버전 기록은 이 폴더에 **원문 그대로** 있다.
> 각 파일 첫머리의 '언제 읽나' 와 목차(원래 루트 행 번호)를 보고 필요한 항목만 읽으면 된다.

| 파일 | 항목 | 다루는 것 | 언제 읽나 |
|---|---:|---|---|
| [perf-db.md](perf-db.md) | 24 | 성능·DB·폴러 규약 | 폴러·DB 모듈·캐시·대량 쓰기·응답 캐시를 새로 만들거나 고칠 때 |
| [common.md](common.md) | 11 | 공통 코드·테스트·문서 규약(numOrNull·주석 제거·TDZ·생성기·의존 방향·릴리스 워크플로) | 테스트·스윕·문서 생성기·릴리스 워크플로를 만질 때 |
| [security-api.md](security-api.md) | 16 | 보안·라우트·외부 API·감사 로그·라이선스 | server/src/routes/ · publicapi · auth · 압축 해제 · CSP |
| [web.md](web.md) | 22 | 웹 화면·메뉴·표·문구 규약 | web/src/ 전반(메뉴·사이드바·표·문구·드롭다운·게시판) |
| [edge.md](edge.md) | 17 | 중앙↔엣지 통신·엣지 로그·통신 점검·토큰 점검·지도·전송 속도·스캔 재개 | server/src/{agent,central,collector,linkcheck,edgelog,portalcheck,commmap,dataflow,devflow,xferspeed}/ |
| [storage.md](storage.md) | 31 | 스토리지 모니터링·증가량·Unity/PowerMax·전력·시리얼 | server/src/storage/ · web/src/views/tools/Storage* · bmstor |
| [sanswitch.md](sanswitch.md) | 15 | SAN 스위치(수집·조닝·사용량·월간 점검) | server/src/sanswitch/ · web/src/views/tools/SanSwitch*·san* |
| [idrac-server.md](idrac-server.md) | 24 | iDRAC·베어메탈 사용률·파트 장애·서버 온도·전력·Overview 서버 수량 | server/src/{idrac,bmusage,partfault,corpusage,power}/ · Overview |
| [vcenter.md](vcenter.md) | 19 | vCenter 점검 기능(VM 구성·호스트·DS·클러스터·라이선스·태그·이벤트·증분 수집·스파이크) | server/src/{vcenter,vmcfg,vmhygiene,hostcfg,dscfg,clustercfg,corelicense,tags,vmchanges,vmlife,contention,availability,cost,migration,vmseries,vmtrack}/ |
| [gpu.md](gpu.md) | 6 | GPU 모니터링(할당·메모리·온도·수집 점검) | server/src/gpu/ · web/src/views/tools/Gpu* |
| [cvp.md](cvp.md) | 11 | Arista CVP 수집·장애·GBIC·Overview | server/src/cvp/ · web/src/views/tools/Cvp*·cvp* |
| [isilon.md](isilon.md) | 6 | 아이실론 디렉터리 사용량·메일 | server/src/isidu/ · web/src/views/tools/Isidu*·isidu* |
| [ipam.md](ipam.md) | 11 | IP 관리(IPMS·대역·스캔·원장·VM DNS) | server/src/{ipam,vmdns}/ · web/src/views/tools/Ipam*·Ipms*·IpScan*·VmDns* |
| [horizon-curuser.md](horizon-curuser.md) | 6 | Horizon 세션·앱 사용·현재 사용자(Windows) | server/src/{horizon,curuser}/ · web/src/views/tools/Horizon*·CurrentUsers* |
| [demo.md](demo.md) | 6 | 데모(mock) 모드·데모 계정 | server/src/mock/ · auth/demoGuest.js |
| [audits.md](audits.md) | 48 | 회차별 점검(감사) 기록 v2.583~v2.744 | 같은 영역을 다시 점검할 때 — 확정분·남긴 것·작업 방식 교훈 |
| [server-security-history.md](server-security-history.md) | 20절 | 서버 보안 감사 조치 기록 | 서버 인증·권한·SSRF·비밀·엣지 수신 코드를 고칠 때 |

## 남기는 방법

1. 교훈은 먼저 **테스트**로 고정한다(소스 스윕·실제 라우터·변이 검증).
2. 한 폴더에만 해당하면 그 폴더의 `CLAUDE.md`(자동 로드), 여러 폴더에 걸치면 이 폴더의 영역 파일 끝에 덧붙인다.
3. 루트 `CLAUDE.md` 에는 버전별 단락을 쌓지 않는다. 같은 실수가 여러 영역에서 재발할 때만 '반복된 교훈' 에 한 줄로.
