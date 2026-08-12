import fs from 'node:fs';
import path from 'node:path';
import { config, currentVersion } from '../config.js';

const SECURITY = [
  { level: '높음', title: 'TLS 검증 기본값 재확인 필요', detail: 'vCenter/iDRAC 연결 설정에서 인증서 검증과 레거시 TLS 허용 여부를 운영 환경별로 명시해야 합니다.', evidence: 'server/src/config.js' },
  { level: '높음', title: 'SSRF DNS 재검증 필요', detail: 'DNS 검사 후 실제 연결 시 hostname을 다시 해석하는 경로가 있어 검증된 IP 직접 연결이 필요합니다.', evidence: 'pyportal/hub/health.py' },
  { level: '높음', title: 'RDP 자격증명 URL fallback 제거 필요', detail: '티켓이 없을 때 query parameter로 자격증명을 받는 호환 경로는 로그·브라우저 기록에 남을 수 있습니다.', evidence: 'server/src/proxy/guacdTunnel.js' },
  { level: '높음', title: 'Python Hub 외부 노출 방지', detail: 'HUB_TOKEN 미설정 시 API가 공개될 수 있으므로 바인드 주소와 토큰을 배포 단계에서 강제해야 합니다.', evidence: 'pyportal/hub/server.py' },
  { level: '중간', title: 'CSP 기본 활성화', detail: 'Node 서버 CSP가 환경변수 opt-in 방식이므로 운영 기본 정책으로 승격하는 것이 안전합니다.', evidence: 'server/src/index.js' },
  { level: '중간', title: '대용량 업그레이드 요청 제한', detail: '256MB raw body를 메모리로 받을 수 있어 스트리밍 업로드와 압축 해제 후 용량 검증이 필요합니다.', evidence: 'server/src/routes/upgrade.js' },
  { level: '중간', title: '백업 자격증명 암호화', detail: 'JSON/.env 설정이 백업에 포함될 수 있으므로 백업 파일 암호화와 키 분리가 필요합니다.', evidence: 'server/src/backup/service.js' },
  { level: '중간', title: '원격 오류 메시지 최소화', detail: 'SSH/RDP 원격 시스템의 오류·배너가 브라우저로 전달되는 범위를 줄여야 합니다.', evidence: 'server/src/proxy/sshGateway.js' },
  { level: '중간', title: '공개 다운로드 엔드포인트 점검', detail: '/dl의 공개 노출은 의도된 정책인지 확인하고 내부 미러·번들 접근통제를 분리해야 합니다.', evidence: 'server/src/index.js' },
  { level: '중간', title: '예외 후 프로세스 지속 정책 점검', detail: 'uncaughtException 후 계속 실행하면 손상된 상태가 장기화될 수 있어 워커 재기동 또는 graceful restart 정책이 필요합니다.', evidence: 'server/src/index.js' },
];

const COMPLETENESS = [
  { level: '경고', title: '테스트 완전 통과 필요', detail: '최근 전체 테스트 결과는 543 pass, 4 fail, 3 cancelled로 배포 기준상 미완료입니다.', evidence: 'server/test' },
  { level: '경고', title: 'CI 네트워크 테스트 격리', detail: 'svcmon 테스트가 로컬 리스너 권한에 의존해 환경에 따라 재현되지 않습니다.', evidence: 'server/test/svcmon.test.js' },
  { level: '중간', title: '동기 DatabaseSync 분리', detail: 'SQLite 쿼리가 Node 이벤트 루프를 직접 블로킹할 수 있어 Worker Thread 또는 writer queue가 필요합니다.', evidence: 'server/src/*/db.js' },
  { level: '중간', title: 'SQL 실행시간 계측', detail: '쿼리별 p95/p99, SQLITE_BUSY, WAL 크기, event-loop lag 지표가 부족합니다.', evidence: 'server/src/insights/portalDb.js' },
  { level: '중간', title: '설정 스키마 통합', detail: '환경변수·JSON·UI 검증을 단일 스키마로 통합하면 잘못된 배포 설정을 조기에 차단할 수 있습니다.', evidence: 'server/src/config.js' },
  { level: '중간', title: '백업 복구 범위 확장', detail: '설정 중심 백업이므로 SQLite 시계열과 로그까지 포함한 복구 정책을 별도로 정의해야 합니다.', evidence: 'server/src/backup/service.js' },
  { level: '중간', title: 'C# 클라이언트 검증 자동화', detail: '루트 verify에 C# 빌드·패키징 검증이 포함되어 있지 않습니다.', evidence: 'package.json' },
  { level: '중간', title: '웹 번들 최적화', detail: '3D 그래프와 일부 청크가 크므로 초기 로딩 비용과 캐시 전략을 추가 개선할 수 있습니다.', evidence: 'web build output' },
  { level: '낮음', title: 'UI 빌드 경고 제거', detail: 'VmRemote.jsx의 중복 title 속성을 정리해야 합니다.', evidence: 'web/src/components/VmRemote.jsx' },
  { level: '낮음', title: 'Node/Python 정책 통합', detail: '서비스 허브와 Node 포탈의 인증·SSRF 정책이 분리되어 회귀 테스트와 공통 문서가 필요합니다.', evidence: 'server/src, pyportal/hub' },
];

const RECOMMENDATIONS = [
  '운영 기본 TLS 인증서 검증을 활성화하고 예외는 명시적 opt-in으로 제한',
  'SSRF 검증 주소를 직접 연결하고 HTTP 리다이렉트마다 재검증',
  'RDP/SSH 자격증명은 일회용 티켓과 헤더 기반 전달만 허용',
  'DatabaseSync를 Worker Thread로 이동하고 단일 writer queue 적용',
  'SQLite SQL p95/p99와 event-loop lag을 Prometheus 지표로 노출',
  '테스트를 CI에서 Green 기준으로 강제하고 네트워크 의존 테스트를 mock 처리',
  '백업 암호화·키 분리·복구 리허설을 운영 절차에 포함',
  'CSP, Permissions-Policy, 보안 쿠키 정책을 기본값으로 활성화',
  '시계열이 수억 행으로 증가하면 PostgreSQL + TimescaleDB로 이전',
  '현재 규모에서는 SQLite를 유지하되 메모리 캐시와 영속 저장을 분리',
];

// 점검일은 열람일이 아니라 이 스냅샷이 만들어진 실제 점검 날짜로 고정한다.
// 위 SECURITY/COMPLETENESS 는 2026-08-08 외부 점검(Codex) 결과를 상수로 보존한 것이라,
// 열람일을 점검일로 표시하면 이미 수정된 지적이 '오늘' 발견된 것처럼 보인다(사실 왜곡).
// 재점검을 반영하려면 상수 배열을 갱신하고 이 날짜도 함께 갱신할 것.
const AUDIT_DATE = '20260808';

function today() { return AUDIT_DATE; }

function fileName() { return `codex_check_${today()}.MD`; }

export function renderCodexCheckMarkdown() {
  const lines = [
    '# Codex 프로그램 보안·완성도 점검 보고서',
    '',
    `- 점검일: ${today().replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')} (Asia/Seoul)`,
    `- 버전: ${currentVersion()}`,
    '- 범위: Node.js 서버, React/Vite 웹, Python Hub, C# 모니터, 테스트·배포 구성',
    '- 성격: 정적 코드 점검 및 기존 테스트·빌드 결과 요약. 침투테스트 결과가 아님.',
    '',
    '## 종합 판정',
    '',
    '보안은 운영 전제조건을 명시적으로 강화해야 하는 **주의** 상태이며, 완성도는 핵심 기능이 넓지만 테스트와 운영 검증이 남아 있는 **부분 완료** 상태입니다.',
    '',
    '## 보안 점검 결과',
    '',
    '| 수준 | 항목 | 판단 | 근거 |',
    '|---|---|---|---|',
    ...SECURITY.map((x) => `| ${x.level} | ${x.title} | ${x.detail} | ${x.evidence} |`),
    '',
    '## 완성도 점검 결과',
    '',
    '| 상태 | 항목 | 판단 | 근거 |',
    '|---|---|---|---|',
    ...COMPLETENESS.map((x) => `| ${x.level} | ${x.title} | ${x.detail} | ${x.evidence} |`),
    '',
    '## 권장 개선 순서',
    '',
    ...RECOMMENDATIONS.map((x, i) => `${i + 1}. ${x}`),
    '',
    '## DB/성능 판단',
    '',
    '현재 SQLite는 WAL·배치 트랜잭션·인덱스·롤업을 사용하므로 단일 서버·중간 규모에서는 즉시 교체할 필요가 없습니다. 다만 DatabaseSync가 이벤트 루프를 블로킹할 수 있어 Worker Thread 분리가 우선입니다. 동시 writer·수평확장·대규모 시계열이 필요해지면 PostgreSQL, 시계열 중심이면 TimescaleDB를 권장합니다.',
    '',
    '## 검증 상태',
    '',
    '- 웹 빌드: 성공(대형 청크 및 JSX 중복 속성 경고 존재)',
    '- Node 테스트: 543 pass / 4 fail / 3 cancelled 기준으로 재검증 필요',
    '',
  ];
  return lines.join('\n');
}

export function getCodexCheckReport() {
  return {
    fileName: fileName(),
    generatedAt: new Date().toISOString(),
    version: currentVersion(),
    verdict: { security: '주의', completeness: '부분 완료', test: '재검증 필요' },
    security: SECURITY,
    completeness: COMPLETENESS,
    recommendations: RECOMMENDATIONS,
    markdown: renderCodexCheckMarkdown(),
  };
}

export function writeCodexCheckReport() {
  const name = fileName();
  const target = path.join(config.appRoot, name);
  const markdown = renderCodexCheckMarkdown();
  fs.writeFileSync(target, markdown, { encoding: 'utf8', mode: 0o640 });
  try { fs.chmodSync(target, 0o640); } catch { /* best effort */ }
  return { ok: true, fileName: name, path: target, bytes: Buffer.byteLength(markdown) };
}
