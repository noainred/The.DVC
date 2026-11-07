/**
 * fieldCheck2938.test.js — 포탈 점검 › 법인별 실환경 확인(v2.938 · 제안 8번 '법인별로 적용').
 *  ① 항목별 판정 — 확인됨 · 실패 · 근거 없음(실패 아님) · 해당 없음 · 판정 불가(목 데이터 — 확인됨에 넣지 않는다)
 *  ② 법인 표 — 위임 vCenter 의 엣지를 수집 서버와 대소문자 무시로 잇는다 · 한 항목의 원본 오류는 그 칸만 판정 불가 · KPI 항등식
 *  ③ 실제 라우터 — 관리자 + 전체 범위만(범위 관리자·운영자 403) · 응답 모양 · 목 vCenter 는 판정 불가
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldcheck2938-'));
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const J = await import('../src/fieldcheck/judge.js');
const NOW = Date.UTC(2026, 10, 7, 9, 40, 0);

test('① 항목별 판정', () => {
  // 엣지 업그레이드 push
  assert.equal(J.judgeUpgradePush({ site: false }).state, 'na');
  assert.equal(J.judgeUpgradePush({ site: true, agent: '' }).state, 'pending');
  assert.equal(J.judgeUpgradePush({ site: true, agent: 'edge-pl', collector: null }).state, 'unknown');
  const col = { id: 'c1', name: 'edge-pl' };
  assert.deepEqual(J.judgeUpgradePush({ site: true, agent: 'edge-pl', collector: col, status: { upgrade: { at: NOW, ok: true, version: '2.938.0', auto: true } } }), { state: 'confirmed', detail: 'v2.938.0 받음 (자동)', at: NOW });
  assert.equal(J.judgeUpgradePush({ site: true, agent: 'edge-pl', collector: col, status: { upgrade: { at: NOW, ok: false, upToDate: true } } }).state, 'confirmed', "'이미 최신' 도 push 가 닿았다는 근거");
  const f = J.judgeUpgradePush({ site: true, agent: 'edge-pl', collector: col, status: { upgrade: { at: NOW, ok: false, reason: 'HTTP 403 · 토큰' } } });
  assert.equal(f.state, 'failed'); assert.match(f.detail, /403/);
  assert.match(J.judgeUpgradePush({ site: true, agent: 'edge-pl', collector: col, status: { version: '2.930.0' }, centralVersion: '2.938.0' }).detail, /엣지 v2\.930\.0 · 중앙 v2\.938\.0/);
  // vAPI 태그
  assert.equal(J.judgeVapiTags({ mock: true, vc: { tagInv: { categories: [], tagsAt: NOW } } }).state, 'unknown', '목 데이터는 확인됨이 아니다');
  assert.equal(J.judgeVapiTags({ vc: {} }).state, 'pending');
  assert.equal(J.judgeVapiTags({ vc: { tagInv: { tagsUnsupported: true } } }).state, 'na');
  assert.equal(J.judgeVapiTags({ vc: { tagInv: { tagsError: '401 Unauthorized', tagsAt: NOW } } }).state, 'failed');
  assert.deepEqual(J.judgeVapiTags({ vc: { tagInv: { categories: [{}, {}], tags: [{}], tagsAt: NOW } } }), { state: 'confirmed', detail: '카테고리 2 · 태그 1', at: NOW });
  // LACP
  assert.equal(J.judgeLacpPath({ vcInfo: null }).state, 'pending');
  assert.equal(J.judgeLacpPath({ vcInfo: { dvpg: { at: NOW, lagError: 'InvalidProperty config.lacpGroupConfig', items: [] } } }).state, 'failed');
  assert.equal(J.judgeLacpPath({ vcInfo: { dvpg: { at: NOW, items: [] } } }).state, 'na');
  assert.deepEqual(J.judgeLacpPath({ vcInfo: { dvpg: { at: NOW, items: [{ lacp: { enabled: true } }, { lacp: null }] } } }), { state: 'confirmed', detail: '포트그룹 2 읽음 · LACP 사용 1', at: NOW });
  // Bareos
  assert.equal(J.judgeBareosDir({ corp: null }).state, 'na');
  assert.equal(J.judgeBareosDir({ corp: { at: NOW, from: 'edge', items: [{ key: 'dir', status: 'ok', detail: '응답 · 24.0.1' }] } }).detail, '응답 · 24.0.1 · 엣지 대행');
  assert.equal(J.judgeBareosDir({ corp: { at: NOW, items: [{ key: 'dir', status: 'bad', detail: '접속 실패(tls)' }] } }).state, 'failed');
  assert.equal(J.judgeBareosDir({ corp: { at: NOW, items: [{ key: 'dir', status: 'unknown', detail: '아직 점검하지 않았습니다' }] } }).state, 'pending');
});

test('② 법인 표 — 엣지 ↔ 수집 서버 연결 · 원본 오류는 그 칸만 · KPI 항등식', () => {
  const out = J.buildFieldChecks({
    registry: [{ id: 'vc-pl', name: '폴란드', collectMode: 'site' }, { id: 'vc-kr', name: '서울', collectMode: 'direct' }, { id: 'vc-off', name: '꺼짐', enabled: false }, null],
    vcOf: (id) => (id === 'vc-pl' ? { tagInv: { categories: [], tagsAt: NOW } } : null),
    agentOf: (id) => (id === 'vc-pl' ? 'EDGE-PL' : ''),
    collectors: [{ id: 'c-pl', name: 'edge-pl' }],
    statusById: { 'c-pl': { upgrade: { at: NOW, ok: true, version: '2.938.0' } } },
    vcInfoOf: (id) => { if (id === 'vc-kr') throw new Error('cache broken'); return null; },
    corpOf: () => null,
  });
  assert.equal(out.corps, 2, '꺼진 vCenter · 형식 오류 행은 빼고');
  const pl = out.rows.find((r) => r.id === 'vc-pl'); const kr = out.rows.find((r) => r.id === 'vc-kr');
  assert.equal(pl.agent, 'EDGE-PL'); assert.equal(pl.cells['upgrade-push'].state, 'confirmed', '대소문자만 다른 엣지 이름도 잇는다');
  assert.equal(pl.cells['vapi-tags'].state, 'confirmed');
  assert.equal(kr.cells['upgrade-push'].state, 'na'); assert.equal(kr.mode, 'direct');
  assert.equal(kr.cells['lacp-path'].state, 'unknown'); assert.match(kr.cells['lacp-path'].detail, /cache broken/);
  const sum = J.FIELD_STATES.reduce((a, s) => a + out.counts[s], 0);
  assert.equal(sum, out.total); assert.equal(out.total, 2 * J.FIELD_CHECKS.length);
  for (const k of J.FIELD_CHECKS) assert.equal(J.FIELD_STATES.reduce((a, s) => a + out.byCheck[k][s], 0), out.corps);
});

let srv; let base;
const USERS = { full: { username: 'full', role: 'admin', scope: null }, sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-x'] } }, op: { username: 'op', role: 'operator', scope: null } };
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => srv?.close());

test('③ 실제 라우터 — 관리자 + 전체 범위만 · 응답 모양 · 목 vCenter 는 판정 불가', async () => {
  const { store } = await import('../src/store.js');
  await store.refresh?.().catch?.(() => {});
  const get = (u) => fetch(`${base}/tools/portal-check/field`, { headers: { 'x-u': u } });
  assert.equal((await get('op')).status, 403);
  assert.equal((await get('sadm')).status, 403);
  const r = await get('full');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true); assert.deepEqual(j.checks, J.FIELD_CHECKS); assert.deepEqual(j.vocab.states, J.FIELD_STATES);
  assert.equal(J.FIELD_STATES.reduce((a, s) => a + j.counts[s], 0), j.total);
  for (const row of j.rows) {
    for (const k of ['vapi-tags', 'lacp-path']) assert.notEqual(row.cells[k].state, 'confirmed', `${row.id} ${k}: 목 데이터를 실환경 확인으로 세면 안 된다`);
  }
});
