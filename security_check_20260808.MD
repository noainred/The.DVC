# 보안 점검 — 2026-08-08

VMware Global Monitoring Portal(The Davinci Virtual Platform) 보안 점검 결과입니다.
직전 릴리스 **v2.246.0** 기준(브랜치 `claude/vmware-global-monitoring-portal-nrnpnt`,
커밋 `61ade9b` 시점). 최근 추가된 성능점검(svcmon) CSV·템플릿·대량등록·엣지 위임(RMA)·
로그 분석이 새로 넓힌 공격면을 중심으로 보고, 코어 불변조건도 재확인했습니다.

## 점검 방법·범위

- 코드 정독: `server/src/auth/`, `routes/svcmon.js`, `routes/central.js`,
  `central/svcmon*`, `agent/svcmon*`, `svcmon/*`, `collector/registry.js`(SSRF),
  `util/atomicWrite.js`·`secureCompare.js`·`resilientFetch.js`, `pyportal/hub/`.
- **확인**: 코드를 직접 읽어 경로·가드를 확인한 것. **추론**: 읽되 실행 재현은 안 한 것.
- 이번 점검은 **정적 분석 + 코드 독해** 중심입니다. 동적 침투 테스트(실제 익스플로잇 실행)는
  하지 않았으므로, 아래 '확인' 항목도 런타임 재현까지 한 것은 아닙니다(구분해 표기).
- 심각도: **critical**=원격 무인증 자격증명 탈취/RCE, **high**=인증 우회·권한 상승·전체
  자격증명 유출, **medium**=제한적 정보 노출·DoS·조건부 우회, **low**=심층방어 약화,
  **info**=관측·권고.

## 요약

| 심각도 | 건수 | 항목 |
|---|---|---|
| critical | 0 | — |
| high | 0 | — |
| medium | 3 | 성능점검 조회 라우트 민감필드 미마스킹, 엣지 결과 조회 인벤토리 노출, 로그 경로/파일목록 노출 |
| low | 4 | svcmon 권한이 requirePerm 미편입, 중앙 수신 저장소 미persist(가용성), CSV 가드 비단사, 템플릿 동명 병합 |
| info | 2 | 로그 분석 정적분석만 수행, 다중 세션 미커밋 작업 혼재 |

**무단 접근·원격 코드실행·인증 우회에 해당하는 critical/high 취약점은 발견되지 않았습니다.**
발견된 것은 대부분 **로그인한 저비권한 사용자(viewer)에게 내부 구성 정보가 더 보이는**
정보 노출과, 이미 문서화된 설계상 절충(가용성 vs 정확성)입니다.

---

## 발견 상세

### [MEDIUM·확인] M1. 성능점검 조회 라우트가 민감 점검 필드를 마스킹하지 않는다
**위치**: `server/src/routes/svcmon.js:57` `GET /state`(권한 게이트 없음 — 로그인만),
`:390` `GET /templates`, `:722` `GET /edge-state`.
**내용**: `/state` 는 대상·점검을 그대로 스프레드해 내려주므로 `url`·`keyword`·`send`·
`body`·`soapAction`·`payload` 가 **로그인한 viewer 에게 노출**된다. 이 필드들은 내부 API
경로·SOAP 요청 본문·연결 후 보낼 명령을 담는다. 프런트 탭 게이트는 `dashboard` 권한이라
viewer 가 기본 보유한다.
**영향**: 내부 서비스 엔드포인트·인증 힌트가 저비권한 계정에 노출. 자격증명 자체는 아니다.
**근거**: `auth/permissions.js PERMISSION_CATALOG` 에 svcmon 키가 없어 `requirePerm` 로
세분화되지 않는다(확인). RMA 설계안(P0-3)이 `svcmon.view/edit` + 마스킹을 제안했으나 이번
릴리스에는 미포함(의도적 후속).
**CWE**: CWE-200(정보 노출).
**권고**: `svcmon.edit` 미보유 사용자에게 위 필드를 값 제거 + `has<Field>:true` 로 대체,
`url` 은 origin+pathname 만. `record`/`server`/`host` 는 화면 이해에 필요하므로 유지하되,
'내부 호스트 목록이 조회권자에게 보인다'는 한계는 남는다.

### [MEDIUM·확인] M2. 엣지 결과·배정 조회가 인벤토리를 노출한다
**위치**: `routes/svcmon.js:722` `GET /edge-state`(게이트 없음), `:709` `GET /edges`.
**내용**: 엣지가 보고한 메타(경로·대상 이름·호스트)가 그대로 조회된다 — 사실상 그 법인의
점검 대상 인벤토리다. `/edges` 요약도 마찬가지.
**영향**: M1 과 같은 계열(저비권한 정보 노출). 자격증명 아님.
**CWE**: CWE-200.
**권고**: M1 과 함께 `svcmon.view` 도입 시 이 라우트도 편입. 최소한 `canEdit` 로 올리는 것도
방법(다만 viewer 가 결과를 못 보게 되므로 권한 매트릭스가 정답).

### [MEDIUM·확인] M3. 로그 상태·보유 파일 목록이 게이트 없이 노출된다
**위치**: `routes/svcmon.js:765` `GET /log`(logStatus — 저장 경로·파일명·크기 포함),
`:795` `GET /log/windows`(파일명·기간).
**내용**: 로그인만 하면 로그 **저장 절대경로**와 파일 목록이 보인다. 경로는 서버 파일시스템
구조를 드러낸다(pyportal 규칙 '미인증 응답에 서버 경로 금지'와 같은 취지의 사각지대 —
다만 이쪽은 인증은 요구한다).
**영향**: 구조 정보 노출. 파일 **다운로드**(`/log/files/:name`, `:785`)와
**경로 변경**(`/log`, `:767`)은 각각 `canEdit`·`adminOnly` 로 제대로 보호됨(확인).
**CWE**: CWE-200.
**권고**: `/log`·`/log/windows` 를 `canEdit` 로 상향(다운로드가 이미 canEdit 이므로 상태
조회만 낮을 이유가 없다).

### [LOW·확인] L1. svcmon 전체가 requirePerm 매트릭스 밖이다
**위치**: `auth/permissions.js`(svcmon 키 없음), `routes/svcmon.js`(전부 `requireRole` 기반).
**내용**: CLAUDE.md '기능 권한은 서버가 진실의 원천(requirePerm)' 원칙과 달리 svcmon 15+개
라우트가 `requireRole('admin','operator')` 로만 보호된다. 기능 세분화(예: 조회는 viewer,
편집은 operator, 배정은 admin)가 불가능하고 M1~M3 의 근본 원인이다.
**영향**: 권한 상승은 아니다(admin/operator 경계는 유지). 세분화 부재·불일치.
**권고**: svcmon 모듈을 한 번에 `PERMISSION_CATALOG` 에 편입(`svcmon.view/edit/assign`).
이번 릴리스 범위 밖으로 명시된 부채다.

### [LOW·확인] L2. 중앙 수신 저장소가 디스크에 persist 되지 않는다(가용성)
**위치**: `central/svcmonEdge.js`(인메모리 Map, persist 없음).
**내용**: 중앙 재시작 후 다음 push(기본 60초)까지 전 엣지가 '무보고(unknown)'로 보인다.
자동 업그레이드가 상시 도는 제품이라 재시작은 정기 이벤트다.
**영향**: 기밀성·무결성 문제가 아니라 **가용성/관측 공백**. 설계상 '오래된 정상을 초록으로'
보다 unknown 이 안전하다는 의도적 절충(문서화됨).
**권고**: R3 의 `SVCMON_EDGE_PERSIST` 옵트인(agent 별 파일 분리). 현 상태는 허용 가능.

### [LOW·확인] L3. CSV 수식가드/역가드가 단사가 아니다
**위치**: `util/csv.js guardCell/unguardCell`, `svcmon/csvio.js`·`templatesCsv.js`.
**내용**: 실제 값이 `'=`·`'-` 로 시작하는 경우(작은따옴표가 데이터) 왕복 1회에 선행 `'` 가
벗겨져 값이 조용히 변한다. 엑셀 수식 인젝션 방어(`= + - @` 앞 `'` 삽입)는 정상 동작한다.
**영향**: 보안(인젝션)은 막힌다. **데이터 무결성**의 드문 왕복 변형이다.
**권고**: 방어 목적은 충족. 원본에 리터럴 선행 작은따옴표가 흔치 않으므로 우선순위 낮음.
문서에 한계로 기재(완료).

### [LOW·확인] L4. 동명 템플릿 CSV 병합 / body 경계 왕복 실패
**위치**: `svcmon/templatesCsv.js`.
**내용**: 같은 이름 템플릿 2개를 내보내면 가져오기가 1개로 병합. `body` 4000자가 수식문자로
시작하면 가드로 4001자가 되어 재가져오기 셀 상한에 걸릴 수 있다.
**영향**: 보안 아님(데이터 무결성·사용성). 문서에 한계로 기재(완료).
**권고**: 후속에서 addTemplate 이 동명 거부 or 병합 명시. 낮음.

### [INFO] I1. 로그 분석은 정적 분석만 수행
`svcmon/loganalyze.js` 의 미종결 인용부호 DoS 는 v2.246 에서 O(L²)→O(L) 로 수정하고
회귀 테스트로 고정했다고 코드·테스트에 기록돼 있으나, 이번 보안 점검에서 **실제 대용량
페이로드로 재현 확인은 하지 않았다**(정적 확인만). 운영 반영 전 부하 재현을 권장한다.

### [INFO] I2. 작업 트리에 다중 세션 미커밋 작업 혼재
점검 시점 작업 트리에 다른 세션의 미커밋 변경(`uagmon/`, `codexCheck.js`,
`CodexCheck.jsx`, `admin.js`, `App.jsx`, `package.json` 2.247.0)이 있었다. 이 점검은
**커밋된 v2.246.0 코드 기준**이며, 저 미커밋 파일들은 점검·평가 대상에서 제외했다(다른 세션
소유). 그 코드의 보안성은 별도 점검이 필요하다.

---

## 잘 지켜지고 있는 방어 (확인)

- **중앙 svcmon 라우트의 agent 바인딩**: `POST /svcmon-report`·`GET /svcmon-config`·
  `POST /svcmon-config-ack` 가 `req.centralAuth.mode !== 'agent'` 를 거부하고 저장 키를
  **토큰에서 해석한 이름**(`req.centralAuth.agent`)만 쓴다. 본문 agent 미사용 → 남의 이름
  위조 불가. 공유 CENTRAL_TOKEN 거부(`routes/central.js`). v2.245 실측 403 확인.
- **SSRF 가드가 해석된 주소 기반**: `collector/registry.js` 가 IPv4-mapped·10진수·8진수
  우회를 정규화 후 판정, 링크로컬/메타데이터(169.254.169.254)·루프백·미지정 차단, RFC1918
  사내망 허용. svcmon 의 신규 목적지 필드(`server`·`record`)와 **엣지 통신 진단(probe)의
  소스 IP** 도 `validateEndpoint` 를 통과시킨 뒤에만 사용(확인).
- **로그 다운로드 경로 탈출 차단**: `logFilePath` 가 `^results-[A-Za-z0-9-]+\.csv$` 정규식 +
  `path.dirname === base` 재확인으로 `../` 탈출을 이중 차단(확인).
- **로그 경로 설정의 파괴 방지**: `dirPath` 는 절대경로만, 저장 시 쓰기 시험 통과 필수,
  `pruneOld` 는 `results-*.csv` 패턴만 삭제 → 임의 디렉터리를 지정해도 남의 파일을 못 지운다.
  경로 변경은 adminOnly(확인).
- **원자적 쓰기 + 손상 보존 쌍**: 신규 저장소(`svcmonAssign.js`·`templates.js`·`batches.js`)가
  `atomicWriteFileSync` + 로드 catch `preserveCorrupt` 를 쌍으로 유지(파싱 실패·형식 불일치
  모두 `.corrupt.<ts>` 보존). CLAUDE.md 비대칭 규칙 준수(확인).
- **DoS 방어**: CSV 파서 행·셀 상한(`parseCsvRows maxRows/maxCell`), 대량 등록 all-or-nothing +
  1회 2,000행 상한, 템플릿 적용 2,000행마다 setImmediate 양보, 로그 분석 스트리밍+예산,
  엣지 수신 MAX_AGENTS/ROWS + 초과 카운터. 413 은 재시도 목록에 없어 엣지가 청크 축소(확인).
- **감사 로그**: svcmon 상태변경·probe·로그 다운로드·배정·CSV 가져오기가 `logAudit` 로
  작업당 1행 기록(행당 기록 금지 — AUDIT_MAX 밀어냄 방지)(확인).

---

## 조치 우선순위 (권고)

1. **M1~M3 묶어 해소** — svcmon 을 `PERMISSION_CATALOG` 에 편입(`svcmon.view/edit/assign`)하고
   조회 라우트에 `requirePerm('svcmon.view')` + 민감필드 마스킹. `/log`·`/log/windows`·
   `/edge-state`·`/state`·`/templates` 게이트 정비. (L1 도 동시 해소)
2. **I2** — 작업 트리의 다른 세션 코드(uagmon/codex)를 별도 보안 점검.
3. **L2~L4** — 후속 릴리스에서 처리(가용성 옵트인·CSV 무결성·동명 정책). 보안 위험 낮음.

## 결론

critical/high 없음. 최근 대규모 기능 추가(CSV·템플릿·대량등록·엣지 위임·로그 분석)에도
자격증명·SSRF·경로탈출·명령주입·원자적 쓰기 등 **코어 불변조건은 신규 코드에서도 유지**됐다.
남은 것은 성능점검 모듈의 **권한 세분화 부재로 인한 저비권한 정보 노출(M1~M3)** 이 핵심이며,
이미 알려진 후속 과제(svcmon requirePerm 편입)로 한 번에 해소된다.
