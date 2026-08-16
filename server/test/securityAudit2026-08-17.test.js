import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.322 전체 소스 보안 감사 — 확정 12건 조치 회귀 방지(순수 판정·소스 계약 검사).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'secaudit-2026-test-'));
process.env.CONFIG_DIR = TMP;

const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');

/* ── [HIGH] /tools/vmware-config scope — buildVmwareConfigExport allowed 필터 ── */
test('vmwareExport: allowed(Set) 로 사이트·NSX 매니저를 교집합 필터(무귀속 매니저 숨김)', async () => {
  const mod = await import('../src/backup/vmwareExport.js');
  // store/nsxStore 를 직접 못 바꾸므로 소스 계약을 검사(핵심: allowed 파라미터가 vcs·mgrs 필터에 쓰임).
  const s = read('backup/vmwareExport.js');
  assert.match(s, /allowed = null/); // 시그니처에 allowed 옵션
  assert.match(s, /!allowed \|\| allowed\.has\(v\.id\)/); // 사이트 필터
  assert.match(s, /allowed && \(m\.vcenterId && allowed\.has\(m\.vcenterId\)\)|!allowed \|\| \(m\.vcenterId && allowed\.has/); // NSX 귀속 필터(무귀속 숨김)
  assert.equal(typeof mod.buildVmwareConfigExport, 'function');
});

test('checksLogs: vmware-config·network-check 라우트가 scopedVcenterIds 를 적용', () => {
  const s = read('routes/api/checksLogs.js');
  // vmware-config: allowed 계산 + 범위 밖 vcenterId 404 + export 에 allowed 전달
  assert.match(s, /const allowed = scopedVcenterIds\(req\.user, store\.get\(\)\)/);
  assert.match(s, /buildVmwareConfigExport\(\{ vcenterId: reqVc, allowed \}\)/);
  assert.match(s, /reqVc && allowed && !allowed\.has\(reqVc\)\) return res\.status\(404\)/);
  // network-check: scope 전달
  assert.match(s, /getNetworkCheck\(scopedVcenterIds\(req\.user, store\.get\(\)\)\)/);
});

/* ── [MEDIUM] ip-ping scope + GET requirePerm ── */
test('hardwareGpu: ip-ping POST/GET 에 inUserScope 404 + GET requirePerm', () => {
  const s = read('routes/api/hardwareGpu.js');
  assert.match(s, /api\.get\('\/tools\/ip-ping', requirePerm\('tools'\)/);
  const seg = s.slice(s.indexOf("api.post('/tools/ip-ping'"), s.indexOf("api.get('/tools/gpu/vms'"));
  assert.equal((seg.match(/inUserScope\(req\.user, store\.get\(\), vcenterId\)/g) || []).length, 2, 'POST·GET 양쪽 inUserScope');
});

/* ── [MEDIUM] AD 라우트 requireEnrolled ── */
test('auth: adminOnly 에 requireEnrolled 포함(부트스트랩 세션 AD 설정 변경 차단)', () => {
  const s = read('routes/auth.js');
  assert.match(s, /const adminOnly = \[authMiddleware, requireEnrolled, requireRole\('admin'\)\]/);
  assert.match(s, /import \{[^}]*requireEnrolled[^}]*\} from '\.\.\/auth\/auth\.js'/);
});

/* ── [LOW] idrac host-power serviceTag scope ── */
test('vmMetrics: 범위 계정은 요청 serviceTag 무시하고 스냅샷 host.serviceTag 로만 폴백', () => {
  const s = read('routes/api/vmMetrics.js');
  assert.match(s, /const scoped = !!scopedVcenterIds\(req\.user, snap\)/);
  assert.match(s, /scoped \? \(host\?\.serviceTag/);
});

/* ── [MEDIUM] gpu/settings.js 원자적 쓰기 + preserveCorrupt ── */
test('gpu/settings: atomicWriteFileSync 사용 + 로드 catch preserveCorrupt', () => {
  const s = read('gpu/settings.js');
  assert.match(s, /import \{ atomicWriteFileSync, preserveCorrupt \}/);
  assert.match(s, /atomicWriteFileSync\(FILE,/);
  assert.match(s, /catch \(e\) \{ preserveCorrupt\(FILE, e\.message\); return \{\}; \}/);
  assert.doesNotMatch(s, /fs\.writeFileSync\(FILE/, 'writeFileSync 직접 쓰기 잔존 금지');
});

/* ── [LOW] 자격증명 스토어 6종 preserveCorrupt ── */
test('자격증명 스토어 6종: 로드 catch 에 preserveCorrupt(FILE) 존재', () => {
  for (const f of ['idrac/registry.js', 'idrac/scanRanges.js', 'gpu/physicalRegistry.js', 'horizon/horizon.js', 'proxy/registry.js', 'agent/deployRegistry.js']) {
    const s = read(f);
    assert.match(s, /preserveCorrupt/, `${f}: preserveCorrupt import/호출`);
    assert.match(s, /import \{ atomicWriteFileSync, preserveCorrupt \}/, `${f}: import`);
  }
});

/* ── [LOW] secretVault 정책 손상 시 평문 다운그레이드 금지 ── */
test('secretVault: 정책 파일 손상 시 직전 유효 정책 유지(plain 무음 폴백 금지)', () => {
  const s = read('security/secretVault.js');
  assert.match(s, /_lastGoodPolicy/);
  assert.match(s, /return _lastGoodPolicy/);
  assert.match(s, /암호화가 조용히 해제되지 않도록/);
});

/* ── [MEDIUM] WS FD 누수 catch-all + [LOW] 매핑 소유/scope 재검사 ── */
test('index: 미일치 upgrade catch-all 로 소켓 파기(FD 누수 차단)', () => {
  const s = read('index.js');
  assert.match(s, /server\.on\('upgrade', \(req, socket\) =>/);
  assert.match(s, /socket\.destroy\(\)/);
});
test('sshGateway: mappingAccessIssue 소유·scope 재검사 + handleConnection(user) 전달', () => {
  const s = read('proxy/sshGateway.js');
  assert.match(s, /export function mappingAccessIssue\(user, m\)/);
  assert.match(s, /m\.owner !== user\.username/);       // 소유자 없는 매핑도 admin 전용
  assert.match(s, /targetHostScopeIssue\(store\.get\(\)/); // scope 재검사
  assert.match(s, /handleConnection\(ws, user\)/);
  const g = read('proxy/guacdTunnel.js');
  assert.match(g, /mappingAccessIssue\(user, m\)/);
});

/* ── [LOW·보류] svcmon 비-HTTP SSRF 재검증 — 타임아웃 없는 DNS 재조회가 폴러를 지연시켜
   되돌림. http/soap 의 실행시점 재검증은 유지되어야 한다(회귀 방지). ── */
test('svcmon/checker: http/soap 실행시점 SSRF 재검증 유지 + 비-HTTP 는 보류 표기', () => {
  const s = read('svcmon/checker.js');
  assert.match(s, /const reason = await ssrfBlockReasonResolved\(test\.url\)/, 'http/soap 재검증 유지');
  assert.doesNotMatch(s, /SSRF_RECHECK_TYPES/, '비-HTTP 재검증(타임아웃 없는 DNS)은 되돌림');
  assert.match(s, /보류\(v2\.322 보안 감사 LOW/, '보류 사유 주석 존재');
});
