/**
 * 2026-08-09 보안 재점검(21건) 조치 회귀 방지.
 * 단위 테스트(순수 로직) + 정적 소스 단언(라우트/렌더 경로)으로 각 수정이 유지되는지 고정한다.
 *  - L-R3 로그인 계정 전역(분산) 잠금 레이어
 *  - L-R4 위임잡 reqId 소유권(idrac/capture agentOfReq)
 *  - L-R5 ping-result 결과 맵 상한 축출
 *  - M-R1 vclogs scope · L-R1 GPU export scope · M-R3 ipam ip 소유권 · L-R2 CSV guardCell
 *  - M-R2 RDP 자격증명 티켓 전용(쿼리 폴백 제거) · M-R4 self-register 해석형 SSRF
 *  - L-R6 웹훅 전송 직전 SSRF+redirect · L-R7 fetchPackage fname basename · L-R8 pyportal 0600 tmp
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

/* ------------------------------- 단위 ------------------------------- */

test('L-R3: 로그인 계정 전역 잠금 — per-IP 임계 미만이라도 분산 실패 누적 시 계정 잠금', async () => {
  const m = await import('../src/security/loginRateLimit.js');
  // per-IP: 같은 IP 로 반복 실패하면 per-IP 키가 잠긴다.
  const ip = '203.0.113.7'; const u1 = 'reaudit-perip';
  for (let i = 0; i < 8; i++) m.recordLoginFailure(ip, u1);
  assert.equal(m.checkLoginAllowed(ip, u1).blocked, true, 'per-IP 반복 실패 → 잠금');

  // 계정 전역: 서로 다른 IP 로 1회씩(per-IP 미잠금) 실패를 누적하면 계정 전역 키가 잠긴다.
  const u2 = 'reaudit-acct';
  let blockedByAcct = false;
  for (let i = 0; i < 90 && !blockedByAcct; i++) {
    m.recordLoginFailure(`198.51.100.${i}`, u2); // 매번 다른 IP → per-IP 는 1회뿐
    if (m.checkLoginAllowed('192.0.2.250', u2).blocked) blockedByAcct = true; // 새 IP 인데도 막히면 계정 전역
  }
  assert.equal(blockedByAcct, true, '분산 실패 누적 → 계정 전역 잠금(IP 로테이션 우회 차단)');
  // 다른 계정은 영향 없음.
  assert.equal(m.checkLoginAllowed('192.0.2.250', 'reaudit-unrelated').blocked, false);
  // 성공 로그인은 계정 전역 잠금까지 해제.
  m.recordLoginSuccess('192.0.2.251', u2);
  assert.equal(m.checkLoginAllowed('192.0.2.252', u2).blocked, false, '성공 시 계정 전역 카운터 리셋');
});

test('L-R4: 위임잡 reqId → 배정 agent 매핑(소유권 판정용)', async () => {
  const cap = await import('../src/central/captureJobs.js');
  const rid = cap.enqueueCapture('edge-A', { iface: 'eth0' });
  assert.equal(cap.captureAgentOfReq(rid), 'edge-A');
  assert.equal(cap.captureAgentOfReq('cap_nope'), '', '미상 reqId 는 빈 문자열');

  const scan = await import('../src/central/idracScanJobs.js');
  const rid2 = scan.enqueueIdracScan('edge-B', { ips: '10.0.0.1', username: 'u', password: 'p' });
  assert.equal(scan.agentOfReq(rid2), 'edge-B');
  assert.equal(scan.agentOfReq('idscan_nope'), '');
});

test('L-R5: ping-result 결과 맵 상한 초과 시 가장 오래된 IP 축출', async () => {
  const p = await import('../src/central/pingJobs.js');
  const vc = 'vc-cap-test';
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push({ ip: `10.7.0.${i}`, alive: true, rttMs: 1 });
  p.setPingResults(vc, rows); // 600 > MAX_RESULT_IPS(512) → 앞선 88개 축출
  const first = p.getPingResults(vc, ['10.7.0.0']);
  const last = p.getPingResults(vc, ['10.7.0.599']);
  assert.equal(first['10.7.0.0'].state, 'unknown', '가장 먼저 넣은 IP 는 축출됨');
  assert.equal(last['10.7.0.599'].state, 'up', '최근 IP 는 보존됨');
});

/* ----------------------------- 정적 소스 ----------------------------- */

test('M-R1: /tools/vclogs·export.csv 가 scopeLogFilter 로 사용자 scope 강제', () => {
  const src = read('../src/routes/api.js');
  assert.match(src, /function scopeLogFilter\(req, f\)/);
  // 두 라우트 모두 scopeLogFilter 호출.
  const vclogs = src.slice(src.indexOf("api.get('/tools/vclogs'"), src.indexOf("api.get('/tools/vclogs'") + 700);
  assert.match(vclogs, /scopeLogFilter\(req, f\)/);
  const exp = src.slice(src.indexOf("api.get('/tools/vclogs/export.csv'"), src.indexOf("api.get('/tools/vclogs/export.csv'") + 700);
  assert.match(exp, /scopeLogFilter\(req, f\)/);
  // federate POST 는 inUserScope 로 범위 밖 404.
  const fed = src.slice(src.indexOf("api.post('/tools/vclogs/federate'"), src.indexOf("api.post('/tools/vclogs/federate'") + 600);
  assert.match(fed, /inUserScope\(req\.user, store\.get\(\), vcenterId\)/);
});

test('logs/db.js: vcenterIds 화이트리스트 IN 절 + 빈 배열=결과 없음(1=0)', () => {
  const src = read('../src/logs/db.js');
  assert.match(src, /vcenterId IN \(/);
  assert.match(src, /1=0/);
  assert.match(src, /f\.vcenterIds\.includes\(r\.vcenterId\)/); // json 폴백도 동일
});

test('L-R1: GPU 시계열 export 가 scopedVcenterIds 로 범위 밖 제외', () => {
  const src = read('../src/routes/api.js');
  // gpuSeriesExport 내부의 scope 필터(유니크 문자열).
  assert.match(src, /const allowed = scopedVcenterIds\(req\.user, snap\); \/\/ null=무제한/);
  assert.match(src, /if \(allowed && !allowed\.has\(h\?\.vcenterId \|\| ''\)\) continue;/);
});

test('M-R3: PUT /tools/ipam/ip/:ip 가 기존 레코드 소유권을 body 값보다 먼저 판정', () => {
  const src = read('../src/routes/api.js');
  const put = src.slice(src.indexOf("api.put('/tools/ipam/ip/:ip'"), src.indexOf("api.put('/tools/ipam/ip/:ip'") + 900);
  assert.match(put, /const existing = getOverride\(req\.params\.ip\)/);
  // 기존 레코드의 claimedVcenterId 로 접근 가부를 먼저 검사(body 값 아님).
  assert.match(put, /existing && !ipInWriteScope\(allowed, owners, req\.params\.ip, existing\.claimedVcenterId/);
});

test('L-R2: CSV export 가 guardCell(수식 인젝션 방어)을 적용', () => {
  const src = read('../src/routes/api.js');
  assert.match(src, /import \{ guardCell \} from '\.\.\/util\/csv\.js'/);
  // 인라인 esc 들이 guardCell 을 통과.
  assert.ok(!/const esc = \(v\) => \{ const s = String\(v \?\? ''\)/.test(src), '가드 없는 esc(String 직접)가 남아있으면 안 됨');
  assert.match(src, /const esc = \(v\) => \{ const s = guardCell\(v\)/);
  assert.match(src, /guardCell\(v\)\.replace\(\/"\/g/); // vclogs export.csv
});

test('M-R2: RDP 게이트웨이가 자격증명을 티켓에서만 읽고 쿼리 폴백을 제거', () => {
  const src = read('../src/proxy/guacdTunnel.js');
  assert.match(src, /const tk = consumeRdpTicket\(params\.get\('ticket'\)\)/);
  assert.match(src, /if \(!tk\)/); // 티켓 없으면 거부(fail-closed)
  // cred 는 tk 에서만 — params.get(k) 쿼리 폴백이 없어야 한다.
  assert.ok(!/params\.get\(k\)/.test(src), '쿼리스트링 자격증명 폴백(params.get(k)) 제거');
});

test('M-R2: RDP 클라이언트가 티켓 실패 시 중단(쿼리 자격증명 폴백 제거)', () => {
  const src = read('../../web/src/remote/RemoteConsole.jsx');
  assert.match(src, /if \(!ticket\) \{ setStatus/); // 티켓 없으면 접속 중단
  assert.ok(!/URLSearchParams\(ticket/.test(src), '티켓 유무 분기(쿼리 자격증명 폴백) 제거');
  assert.match(src, /height: String\(h\), ticket \}\)\.toString\(\)/); // 쿼리 객체에 ticket만(자격증명 없음)
});

test('M-R4: /register-collector 가 해석형 SSRF 가드로 저장 전 검증', () => {
  const src = read('../src/routes/central.js');
  assert.match(src, /ssrfBlockReasonResolved/);
  const h = src.slice(src.indexOf("centralRouter.post('/register-collector'"), src.indexOf("centralRouter.post('/register-collector'") + 2400);
  assert.match(h, /await ssrfBlockReasonResolved\(String\(url\)\)/);
});

test('L-R4: central 위임잡 결과 라우트가 reqAgentDenied 로 소유권 검사', () => {
  const src = read('../src/routes/central.js');
  assert.match(src, /function reqAgentDenied\(req, assignedAgent\)/);
  for (const [anchor, fn] of [
    ["centralRouter.post('/idrac-scan-progress'", 'agentOfReq'],
    ["centralRouter.post('/idrac-scan-result'", 'agentOfReq'],
    ["centralRouter.post('/capture-result'", 'captureAgentOfReq'],
  ]) {
    const body = src.slice(src.indexOf(anchor), src.indexOf(anchor) + 700);
    assert.match(body, new RegExp(`reqAgentDenied\\(req, ${fn}\\(`), `${anchor} → ${fn} 소유권 검사`);
  }
});

test('L-R6: 웹훅 전송이 SSRF 재검증 + redirect:manual', () => {
  const src = read('../src/alerts.js');
  assert.match(src, /import \{ ssrfBlockReasonResolved \} from '\.\/collector\/registry\.js'/);
  const post = src.slice(src.indexOf('async function post(url, payload)'), src.indexOf('async function post(url, payload)') + 1100);
  assert.match(post, /await ssrfBlockReasonResolved\(String\(url/);
  assert.match(post, /redirect: 'manual'/);
});

test('L-R7: downloadPackage 가 fname 을 basename + 확장자 화이트리스트로 강제', () => {
  const src = read('../src/upgrade/fetchPackage.js');
  assert.match(src, /const safeName = path\.basename\(String\(fname\)\)/);
  assert.match(src, /safeName !== String\(fname\) \|\| !\/\\\.\(tar\\\.gz\|zip\)\$\/\.test\(safeName\)/);
  assert.match(src, /path\.join\(dir, safeName\)/); // 저장도 safeName
});

test('L-R8: pyportal 원자적 쓰기가 임시파일을 0600 + O_EXCL 로 생성', () => {
  const src = fs.readFileSync(new URL('../../pyportal/hub/jsonfile.py', import.meta.url), 'utf8');
  assert.match(src, /def _open_private\(tmp: Path\)/);
  assert.match(src, /os\.open\(tmp, os\.O_WRONLY \| os\.O_CREAT \| os\.O_EXCL, FILE_MODE\)/);
  assert.ok(!/with open\(tmp, "w", encoding="utf-8"\) as handle:/.test(src), '기본 open(월드리더블) 잔존 금지');
});
