/**
 * v2.440 — 위임 스캔이 '대기'에서 멈췄을 때의 **구체적 해결 절차**.
 *
 * 현장 화면(사용자 스크린샷): 잡 idscan_… · 에이전트 'nb-irs' · 대기(에이전트 인출 전) · 경과 101초.
 * 진단은 "AGENT_NAME 불일치일 수 있습니다 / CENTRAL_URL·CENTRAL_TOKEN 이 설정·재시작됐는지 확인하세요"
 * 까지만 말하고 **어느 파일의 어느 값을 무엇으로 바꾸고 무엇으로 검증하는지**가 없었다.
 * 그 화면의 폴링 목록에는 'nb' 는 있고 'nb-irs' 만 없었다 — 이 좁히기가 조치의 출발점이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAgentName, buildPendingRemedy, editDistance } from '../src/central/scanRemedy.js';

// 사용자 화면의 실제 폴링 목록.
const POLLING = ['hm', 'oc2', 'nb', 'mil-irs', 'gm2-irs', 'agent-mi', 'wa-irs', 'az-irs', 'hg-irs',
  'na-irs', 'gm1', 'az', 'st', 'hd-irs', 'gm1-irs', 'nj', 'gm2', 'mil', 'agent-wa', 'hd', 'hg', 'oc1', 'nj-irs'];

test('editDistance', () => {
  assert.equal(editDistance('nb-irs', 'nb-irs'), 0);
  assert.equal(editDistance('nb-irs', 'nj-irs'), 1);
  assert.equal(editDistance('nb', ''), 2);
  assert.equal(editDistance('', 'ab'), 2);
});

test('이름 분석 — 중계 엣지는 폴링 중이고 IRS 만 빠진 것을 짚는다(현장 사례)', () => {
  const a = analyzeAgentName('nb-irs', POLLING);
  assert.equal(a.polling, false);
  assert.equal(a.base, 'nb');
  assert.equal(a.suffix, 'irs');
  assert.equal(a.baseIsPolling, true);                    // 'nb' 는 폴링 중 → 네트워크는 살아 있다
  assert.ok(a.peers.includes('mil-irs'));                 // 다른 사이트의 '-irs' 는 정상 → 규약이 통용됨
  assert.ok(a.peers.length > 0);
});

test('이름 분석 — 폴링 중이면 그렇게 보고한다(오탐 금지)', () => {
  const a = analyzeAgentName('nj-irs', POLLING);
  assert.equal(a.polling, true);
});

test('이름 분석 — 오타 후보(편집거리 ≤2)를 제시한다', () => {
  const a = analyzeAgentName('gm3-irs', POLLING);
  assert.equal(a.baseIsPolling, false);                   // 'gm3' 는 없다
  assert.ok(a.near.includes('gm2-irs') || a.near.includes('gm1-irs'));
});

test('해결 절차 — 확인 명령·수정·재시작·검증이 순서대로 들어간다', () => {
  const r = buildPendingRemedy({
    agent: 'nb-irs', pollingAgents: POLLING, isRegisteredCollector: true,
    deployTarget: { host: '192.168.105.221', port: 22, username: 'root' },
  });
  const all = JSON.stringify(r);
  assert.match(r.title, /nb-irs/);
  assert.match(r.why, /'nb'\(중계 엣지\)는 폴링 중인데/);   // 원인을 한 줄로 좁힌다
  // 절차에 실제로 실행할 수 있는 명령이 들어 있어야 한다.
  assert.match(all, /ssh root@192\.168\.105\.221/);        // 배포 대상에서 접속 주소를 채운다
  assert.match(all, /grep -E '\^\(AGENT_NAME\|CENTRAL_URL\|CENTRAL_TOKEN\)=' \/etc\/vmware-portal\/portal\.env/);
  assert.match(all, /AGENT_NAME=nb-irs/);                  // 넣어야 할 값이 잡 이름으로 채워진다
  assert.match(all, /systemctl restart vmware-portal/);
  assert.match(all, /journalctl -u vmware-portal/);
  assert.match(all, /idrac-scan-agent\] started/);         // 검증 기준
  // 즉시 우회(PUSH)가 첫 단계 — 설정을 못 고쳐도 지금 스캔을 돌릴 수 있어야 한다.
  assert.match(r.steps[0].text, /PUSH/);
  assert.equal(r.steps[0].when, 'now');                    // 수집 서버로 등록돼 있으므로 바로 쓸 수 있다
  // 바로 갈 화면 링크(v2.438 해시 규약)
  assert.ok(r.links.some((l) => l.hash === '#/settings/idrac-admin'));
  assert.ok(r.links.some((l) => l.hash.startsWith('#/settings/agent-deploy')));
});

test('배포 대상이 없으면 접속 명령을 자리표시자로 둔다(거짓 주소를 지어내지 않는다)', () => {
  const r = buildPendingRemedy({ agent: 'zz-irs', pollingAgents: POLLING, isRegisteredCollector: false });
  const all = JSON.stringify(r);
  assert.match(all, /ssh <엣지 호스트>/);
  assert.ok(!/ssh root@\d/.test(all));
  assert.equal(r.steps[0].when, 'maybe');                  // 수집 서버 미등록이면 PUSH 도 확실치 않다
});

test('폴링하는 에이전트가 하나도 없으면 개별 엣지가 아니라 중앙 쪽을 먼저 의심하게 한다', () => {
  const r = buildPendingRemedy({ agent: 'nb-irs', pollingAgents: [], isRegisteredCollector: false });
  assert.match(r.why, /하나도 없습니다/);
  assert.match(r.why, /중앙 쪽 수신 경로/);
});

test('대소문자만 다른 이름이 폴링 중이면 그것을 짚는다', () => {
  const r = buildPendingRemedy({ agent: 'nb-irs', pollingAgents: ['NB-IRS'], isRegisteredCollector: false });
  assert.match(r.why, /대소문자만 다른/);
});

/* ── PUSH(중앙→엣지 직접) 실패 조치 — 상태코드별 원인은 실측으로 확정했다 ──────────────
 * 로컬 엣지에 직접 요청해 확인: 경로 있음+틀린 토큰 → 403 / 경로 없음(구버전) → 401
 * (경로가 없으면 collector 라우터를 지나 일반 인증 미들웨어가 401 을 낸다).
 * 그래서 401 을 '토큰 문제'로 안내하면 사용자가 엉뚱한 곳을 뒤진다. */
import { buildPushErrorRemedy } from '../src/central/scanRemedy.js';

test('401 = 구버전 엣지(경로 없음) — 토큰 문제로 오인하게 하지 않는다', () => {
  const r = buildPushErrorRemedy({ agent: 'nb-irs', httpStatus: 401, error: '엣지 응답 HTTP 401', collectorUrl: 'http://192.168.105.221:4000' });
  assert.match(r.title, /PUSH 스캔 기능이 없습니다 \(HTTP 401\)/);
  assert.match(r.why, /토큰이 틀린 것이 아니라/);
  assert.match(r.why, /403 이 옵니다/);          // 구분 근거를 명시
  assert.match(JSON.stringify(r.steps), /업그레이드/);
  assert.ok(r.links.some((l) => l.hash === '#/settings/collectors'));
  assert.match(JSON.stringify(r.where), /192\.168\.105\.221:4000\/api\/collector\/idrac-scan/);
});

test('403 = 토큰 불일치 — 진단(실측) 경로로 보낸다', () => {
  const r = buildPushErrorRemedy({ agent: 'nb-irs', httpStatus: 403, error: '엣지 응답 HTTP 403' });
  assert.match(r.title, /수집 토큰을 거부/);
  assert.match(r.why, /경로가 없으면 401/);
  assert.match(JSON.stringify(r.steps), /진단/);
  assert.ok(r.links.some((l) => l.hash.startsWith('#/settings/agent-deploy')));
});

test('404 = collector 비활성', () => {
  const r = buildPushErrorRemedy({ agent: 'x', httpStatus: 404 });
  assert.match(r.title, /collector 기능이 꺼져/);
  assert.match(JSON.stringify(r.steps), /COLLECTOR_TOKEN=/);
});

test('상태코드는 오류 문자열에서도 뽑는다(구버전 잡 호환)', () => {
  const r = buildPushErrorRemedy({ agent: 'x', error: '엣지 응답 HTTP 401. 수집 서버 URL/토큰/버전을 확인하세요.' });
  assert.match(r.title, /HTTP 401/);
});

test('알 수 없는 실패는 지어내지 않고 원문을 보여준다', () => {
  const r = buildPushErrorRemedy({ agent: 'x', httpStatus: 500, error: '엣지 응답 HTTP 500' });
  assert.match(r.title, /PUSH 스캔 실패/);
  assert.match(r.why, /예상치 못한 응답/);
  assert.match(JSON.stringify(r.steps), /journalctl/);
});
