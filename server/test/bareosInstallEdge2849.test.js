/**
 * test/bareosInstallEdge2849.test.js — v2.849 완전 설치 대상의 '엣지 응답'(사용자 화면: 엣지가 등록돼 있는데 모든 행이
 *   '불가 — 엣지 응답 없음(마지막 수신 55153분 전)' 이라 고를 수 없었다).
 *  ① central/agentContact — 인증된 요청 시각 · 대소문자 무시 · 상한(가장 오래된 것부터)
 *  ② buildTargets — 인벤토리 수신이 오래됐어도 그 엣지의 최근 인증 요청이 있으면 고를 수 있다 · 둘 다 오래면 그대로 막는다
 *  ③ 중앙 인증 미들웨어가 기록한다(개별 토큰 = 그 이름 · 공유 토큰 = 아는 이름만)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const AC = await import('../src/central/agentContact.js');
const { buildTargets, EDGE_STALE_MS } = await import('../src/bareos/install/targets.js');

test('① agentContact — 이름 · 시각 · 대소문자 · 상한', () => {
  AC._resetAgentContactForTest();
  assert.equal(AC.agentLastContact('NB'), null);
  AC.noteAgentContact('NB', 1000);
  assert.equal(AC.agentLastContact('nb'), 1000);
  AC.noteAgentContact('', 2000); AC.noteAgentContact(null, 2000); AC.noteAgentContact({ toString: () => 'x' }, 2000);
  assert.equal(AC.agentLastContact(''), null, '빈 이름 · 글자가 아닌 값은 기록하지 않는다');
  for (let i = 0; i < 2_100; i += 1) AC.noteAgentContact(`e${i}`, i);
  assert.equal(AC.agentLastContact('NB'), null, '상한을 넘으면 가장 오래된 것부터');
  assert.equal(AC.agentLastContact('e2099'), 2099);
  AC._resetAgentContactForTest();
});

test('② buildTargets — 최근 인증 요청이 있으면 엣지 응답으로 본다(중앙이 직접 수집하는 vCenter 의 엣지)', () => {
  const now = Date.UTC(2026, 10, 2, 0, 0, 0);
  const base = {
    vcenters: [{ id: 'vc-nb', name: 'NB', host: 'vc-nb.corp' }],
    inventory: [{ vcenterId: 'vc-nb', agent: 'NB', at: now - 55_153 * 60_000 }],   // 사용자 화면: 마지막 인벤토리 수신 55153분 전
    deployTargets: [{ id: 't1', agentName: 'NB', host: '192.168.48.221', port: 22, username: 'root', password: 'x', enabled: true }],
    settings: { directors: [], sites: [] }, now,
  };
  const stale = buildTargets(base)[0];
  assert.equal(stale.can, false);
  assert.match(stale.why, /엣지 응답 없음\(마지막 수신 55153분 전\)/);
  const live = buildTargets({ ...base, contactOf: (a) => (a === 'NB' ? now - 2 * 60_000 : null) })[0];
  assert.equal(live.can, true, live.why);
  assert.equal(live.edgeAgeMs, 2 * 60_000, '두 시각 중 최근 값');
  const old = buildTargets({ ...base, contactOf: () => now - EDGE_STALE_MS - 1 })[0];
  assert.equal(old.can, false, '인증 요청도 오래됐으면 그대로 막는다');
  // 인벤토리를 올린 적이 없는 vCenter 는 엣지를 모른다 — 지금처럼 '엣지 노드 없음'(이름 없이 추측하지 않는다)
  const none = buildTargets({ ...base, inventory: [], contactOf: () => now })[0];
  assert.match(none.why, /엣지 노드 없음/);
});

test('③ 중앙 인증 미들웨어가 기록한다 — 개별 토큰은 그 이름 · 공유 토큰은 아는 이름만', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(src, /noteAgentContact\(auth\.mode === 'agent' \? String\(auth\.agent \|\| ''\) : \(want && edgeNameKnown\(want\) \? want : ''\)\)/);
  const i = src.indexOf('noteAgentContact(auth.mode');
  assert.ok(i > src.indexOf("return res.status(403).json({ ok: false, reason: `이 토큰은 '${auth.agent}' 전용입니다"), '토큰 ↔ 이름 대조(거부) 뒤에만 기록한다');
  const route = fs.readFileSync(new URL('../src/bareos/install/targets.js', import.meta.url), 'utf8');
  assert.match(route, /contactOf: agentLastContact/);
});
