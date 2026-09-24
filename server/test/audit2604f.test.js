/**
 * v2.604 감사 그룹 f — 웹·지도·로그 분석 회귀.
 *  · WEB2604-01 통신 지도: 한 번도 성공하지 못한 엣지(at:null · neverOk)의 pull 시각이 0(1970년)·ageMs=now 가 되던 것.
 *  · WEB2604-02 로그 분석 누적: 추적 시작을 정시(버킷 시작)로 말하고, 같은 시간 안에서 시작한 추적의 1시간 창을 '완전' 으로 표시하던 것.
 * 기준 시각은 고정값(정시에서 떨어뜨린 값)이다 — Date.now() 를 쓰지 않는다(v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604f-'));
process.env.CONFIG_DIR = tmp;

const { buildCommMap } = await import('../src/commmap/build.js');
const L = await import('../src/loganalysis/live.js');
const IDX = await import('../src/loganalysis/index.js');

const H = 3_600_000;
const NOW = Date.parse('2026-01-05T03:45:00Z');

test('WEB2604-01 통신 지도 — 성공한 적 없는 엣지의 pull 시각은 0 이 아니라 null', () => {
  const m = buildCommMap({
    now: NOW,
    collectors: [{ id: 'edge-a', name: 'edge-a', url: 'https://10.0.0.1:4000' }, { id: 'edge-b', name: 'edge-b', url: 'https://10.0.0.2:4000' }],
    status: {
      'edge-a': { ok: false, degraded: false, error: 'fetch failed', fails: 1, at: null, neverOk: true },
      'edge-b': { ok: false, degraded: false, error: 'timeout', fails: 3, at: NOW - 5 * 60_000, hosts: 12 },
    },
  });
  const a = m.edges.find((e) => e.id === 'edge-a');
  const b = m.edges.find((e) => e.id === 'edge-b');
  assert.equal(a.pull.state, 'fail');
  assert.equal(a.pull.at, null, 'at:null 이 0(1970년)이 되면 안 된다');
  assert.equal(a.pull.ageMs, null, 'ageMs 가 now(약 56년)가 되면 안 된다');
  assert.equal(a.pull.neverOk, true, '화면이 성공한 적 없음을 말할 수 있게 싣는다');
  assert.equal(a.pull.hosts, null);
  // 성공한 적 있는 실패 엣지는 마지막 정상 pull 시각을 그대로 싣는다
  assert.equal(b.pull.at, NOW - 5 * 60_000);
  assert.equal(b.pull.ageMs, 5 * 60_000);
  assert.equal(b.pull.neverOk, undefined);
  assert.equal(b.pull.hosts, 12);
  // 빈 문자열·0 도 시각이 아니다
  const c = buildCommMap({ now: NOW, collectors: [{ id: 'e', name: 'e' }], status: { e: { ok: true, at: '' } } }).edges[0];
  assert.equal(c.pull.at, null); assert.equal(c.pull.ageMs, null);
  const d = buildCommMap({ now: NOW, collectors: [{ id: 'e', name: 'e' }], status: { e: { ok: true, at: 0 } } }).edges[0];
  assert.equal(d.pull.at, null);
});

test('WEB2604-02 로그 분석 — 추적 시작은 실제 첫 수신 시각이고 같은 시간 안에서 시작했으면 1시간 창도 일부다', () => {
  L._resetLiveForTest();
  L.startLiveAnalysis(IDX.activeRules());
  const first = NOW - 16 * 60_000; // 03:29
  L.ingest({ ts: first, level: 'warn', msg: '[collector] edge-x pull 실패(3): fetch failed' });
  L.ingest({ ts: NOW - 60_000, level: 'warn', msg: '[collector] edge-x pull 실패(4): fetch failed' });
  const cov = L.liveState(1, NOW).coverage;
  assert.equal(cov.windowFrom, Date.parse('2026-01-05T03:00:00Z'));
  assert.equal(cov.trackingSince, first, '정시(03:00)가 아니라 실제 첫 수신(03:29)');
  assert.equal(cov.partial, true, '03:00~03:29 는 수집하지 않았다 — 1시간 창도 일부다');
  // 앞 시간부터 누적돼 있으면 완전하다
  const cov2 = L.liveState(1, NOW + H).coverage;
  assert.equal(cov2.partial, false);
  L._resetLiveForTest();
});

test('WEB2604-02 — 필드가 없는 옛 저장분은 그 버킷의 첫 줄 시각으로 판단한다', () => {
  L._resetLiveForTest();
  const h = Math.floor(NOW / H);
  const firstLine = NOW - 10 * 60_000;
  fs.writeFileSync(path.join(tmp, 'log-analysis-stats.json'), JSON.stringify({ v: 1, savedAt: NOW, buckets: [{ h, state: { lines: 1, levels: { info: 1, warn: 0, error: 0, unknown: 0 }, first: firstLine, last: firstLine, tags: {}, tmpl: {}, rules: {}, http: {}, prob: {}, overflow: { tmpl: 0, prob: 0, ent: 0, http: 0 } } }] }));
  L.startLiveAnalysis(IDX.activeRules());
  const cov = L.liveState(1, NOW).coverage;
  assert.equal(cov.trackingSince, firstLine);
  assert.equal(cov.partial, true);
  L._resetLiveForTest();
  fs.rmSync(path.join(tmp, 'log-analysis-stats.json'), { force: true });
});
