/**
 * v2.762(H3 — 재현) — 서비스 세션 합 대체는 모든 서비스 세션을 읽었을 때만.
 *  v2.760 은 전체 세션 칸이 비면 서비스 합으로 대체하면서 못 읽은 서비스(null)를 0 으로 더했다 — 전부 못 읽으면 0,
 *  일부만 읽으면 부분 합(120)이 '전체 세션' 으로 보이고 추이 링(store.js)에 적재됐다. 서비스 칸 대체 체인은 XML 빈 요소('')에서
 *  `??` 가 멈춰 sessionCount 로 넘어가지 못했다.
 *
 * 실행: node --test uagmon/test/uag2762.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStats } from '../lib/uag.js';

const svc = (id, total) => `<edgeServiceSessionStats><identifier>${id}</identifier><edgeServiceStatus>RUNNING</edgeServiceStatus><totalSessionCount>${total}</totalSessionCount></edgeServiceSessionStats>`;
const xml = (...s) => `<accessPointStatusAndStats><totalSessionCount></totalSessionCount>${s.join('')}</accessPointStatusAndStats>`;

test('전체 칸이 비고 서비스 세션도 전부 못 읽었으면 0 이 아니라 null', () => {
  const r = parseStats(xml(svc('VIEW', '')));
  assert.equal(r.ok, true);
  assert.equal(r.totalSessions, null);
  assert.equal(r.services[0].sessions, null);
});

test('일부 서비스만 읽었으면 부분 합을 전체 세션으로 내지 않는다', () => {
  const r = parseStats(xml(svc('VIEW', '120'), svc('TUNNEL', '')));
  assert.equal(r.totalSessions, null, '부분 합(120)은 추이에 적재되면 안 된다');
  assert.equal(r.services[0].sessions, 120);
  assert.equal(r.services[1].sessions, null);
});

test('모든 서비스를 읽었으면 합계로 대체(보고된 0 포함)', () => {
  const r = parseStats(xml(svc('VIEW', '120'), svc('TUNNEL', '0')));
  assert.equal(r.totalSessions, 120);
});

test('서비스 칸 대체 — 빈 totalSessionCount 뒤의 sessionCount 를 읽는다', () => {
  const r = parseStats(JSON.stringify({ totalSessionCount: '', edgeServiceSessionStats: [{ identifier: 'VIEW', totalSessionCount: '', activeSessionCount: '', sessionCount: 7 }] }));
  assert.equal(r.services[0].sessions, 7);
  assert.equal(r.totalSessions, 7);
});

test('전체 칸이 있으면 서비스 결측과 무관하게 그 값', () => {
  const r = parseStats(JSON.stringify({ totalSessionCount: 9, edgeServiceSessionStats: [{ identifier: 'VIEW', totalSessionCount: null }] }));
  assert.equal(r.totalSessions, 9);
});

test('v2.762 H3 후속 — 요약 총 세션은 못 읽은 UAG 를 0 으로 더하지 않는다(읽은 것만 + 미확인 대수)', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal(/totalSessions\s*\|\|\s*0/.test(src), false, '못 읽은 세션 수(null)를 0 으로 더하면 부분 합이 전체처럼 보인다');
  assert.match(src, /sessionsUnread/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /sessionsUnread/, '화면이 미확인 대수를 알린다');
});
