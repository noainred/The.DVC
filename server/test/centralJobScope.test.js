/**
 * 2026-08-09 감사 후속 회귀 방지 — 중앙 조회/보고 잡 라우트의 agent↔vCenter 소유권.
 *  - log-queries·ping-jobs(?vcenters= 키잉)는 미들웨어 바인딩을 우회하므로 라우트가 소유권 필터.
 *  - log-query-result 는 reqId 의 진짜 vCenter(vcenterOfReq)로 소유권 판정(body 값 위조 무시).
 *  - ip-scan-result 는 agent 배정 ranges 안의 IP 만 병합.
 * 소유권 모델은 agent 모드에서만 강제(공유 토큰은 기존 신뢰 유지), TOFU(소유주 없으면 통과).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('logQueries: vcenterOfReq 가 reqId 의 발급 vCenter 를 유지(take 이후에도 소유권 검증 가능)', async () => {
  const m = await import('../src/central/logQueries.js');
  const reqId = m.enqueueLogQuery('vc-korea', { q: 'admin' });
  assert.equal(m.vcenterOfReq(reqId), 'vc-korea');
  m.takeLogQueries(['vc-korea']);                 // pending 은 비워지지만
  assert.equal(m.vcenterOfReq(reqId), 'vc-korea', 'take 후에도 reqId→vCenter 매핑은 유지');
  assert.equal(m.vcenterOfReq('lq_nope'), '', '미상 reqId 는 빈 문자열');
});

test('정적: log-queries·ping-jobs GET 이 agent 모드에서 소유권 필터', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  for (const anchor of ["centralRouter.get('/log-queries'", "centralRouter.get('/ping-jobs'"]) {
    const i = src.indexOf(anchor);
    assert.ok(i >= 0, `${anchor} 존재`);
    const body = src.slice(i, i + 700);
    assert.match(body, /req\.centralAuth\.mode === 'agent'/, `${anchor} agent 모드 검사`);
    assert.match(body, /agentOwnsVcenter\(req\.centralAuth\.agent/, `${anchor} 소유권 필터`);
  }
});

test('정적: log-query-result 는 vcenterOfReq 로, ping-result 는 vcenterId 로 소유권 검사', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  const lq = src.slice(src.indexOf("centralRouter.post('/log-query-result'"), src.indexOf("centralRouter.post('/log-query-result'") + 600);
  assert.match(lq, /vcenterOfReq\(b\.reqId\)/);
  assert.match(lq, /agentOwnsVcenter/);
  const pr = src.slice(src.indexOf("centralRouter.post('/ping-result'"), src.indexOf("centralRouter.post('/ping-result'") + 600);
  assert.match(pr, /agentOwnsVcenter\(req\.centralAuth\.agent, b\.vcenterId\)/);
});

test('정적: ip-scan-result 가 배정 ranges 밖 IP 를 드롭(agent 모드) — ranges 는 필터 전 1회 컴파일(논블로킹)', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("centralRouter.post('/ip-scan-result'"), src.indexOf("centralRouter.post('/ip-scan-result'") + 1200);
  assert.match(body, /req\.centralAuth\.mode === 'agent'/);
  // ranges 를 필터 진입 전 1회 로드·컴파일해야 한다(IP마다 loadScanSettings 무캐시 read 금지 — 감사 회귀).
  assert.match(body, /loadScanSettings\(agent\)/);
  assert.match(body, /\.map\(specToRange\)/);
  assert.match(body, /bounds\.some/);
  // loadScanSettings 가 filter 콜백 안에서 호출되면 안 된다(IP당 파일 읽기).
  assert.ok(!/filter\(\(h\) => [^)]*loadScanSettings/.test(body), 'filter 콜백 안에서 loadScanSettings 호출 금지');
});

test('정적: svcmon 점검기 http/soap 가 해석형 SSRF 재검증 사용(DNS 우회 차단)', () => {
  const src = fs.readFileSync(new URL('../src/svcmon/checker.js', import.meta.url), 'utf8');
  assert.match(src, /await ssrfBlockReasonResolved\(test\.url\)/);
  assert.ok(!/ssrfBlockReason\(test\.url\)/.test(src.replace(/ssrfBlockReasonResolved/g, '')), '동기 ssrfBlockReason(test.url) 은 제거되어야 함');
});

test('정적: XLSX 가져오기 디코딩 크기 상한 + 행 상한 가드', () => {
  // v2.291: routes/svcmon.js 분할 — XLSX 상한(XLSX_MAX_BYTES 정의는 svcmon/shared.js)을
  // 실제로 검사·413 응답하는 가져오기 경로는 routes/svcmon/transfer.js 로 이동.
  const routes = fs.readFileSync(new URL('../src/routes/svcmon/transfer.js', import.meta.url), 'utf8');
  assert.match(routes, /XLSX_MAX_BYTES/);
  assert.match(routes, /413/);
  const fmt = fs.readFileSync(new URL('../src/svcmon/formats.js', import.meta.url), 'utf8');
  assert.match(fmt, /XLSX_MAX_ROWS/);
});
