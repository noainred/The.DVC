/**
 * 전체 점검 65회차 — 엣지 위임 계열(1차): VM 복제(vmclone) · 전송 속도(xferspeed) · 통신 점검(linkcheck) · 포탈 점검(portalcheck).
 *
 *  - F1 통신 점검 메인(`GET /tools/link-check`)이 엣지 보고를 **등록부 이름 표기 그대로**(대소문자 구분) 찾았다. 엣지 보고는
 *       인증된 토큰의 agent 표기(발급할 때 적은 그대로)로 저장되고, 수신·링크 배정·버전 대조는 전부 대소문자를 무시한다
 *       (`putEdgeLinkReport` · `/link-check-config` · `versions`). 등록부 'Edge-KR' · 토큰 'edge-kr' 이면 보고가 와도 행의
 *       `edgeReport` 가 null 이라, 잴 링크가 0개라고 답한 엣지(note)를 화면이 '보고 없음(대기 초과)' 로 말했다.
 *  - F2 엣지 보고 한 건에 **같은 링크 id 가 여러 번** 오면 표본·일 롤업에 그만큼 쌓였다(ts 만 다르면 INSERT OR IGNORE 를 지난다).
 *       엣지 워커는 링크마다 한 번만 싣는다 — 같은 보고의 두 번째부터는 버리고 rejected 로 센다(엣지가 보낸 것은 정제).
 *
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-deleg-65-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
delete process.env.LINKCHECK_REPORT_STALE_MS;

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;   // 정시 −30분 고정

fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [
  { id: 'Edge-KR', name: 'Edge-KR', url: 'https://10.0.0.5:4000', token: 'tok-kr' },
] }));
fs.writeFileSync(path.join(DIR, 'linkcheck-settings.json'), JSON.stringify({ enabled: true, intervalMs: 5 * MIN }));

const LE = await import('../src/central/linkCheckEdge.js');
const dbm = await import('../src/linkcheck/db.js');
const { linkIdOf } = await import('../src/linkcheck/links.js');

after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

async function linkCheckMain() {
  const { registerLinkCheck } = await import('../src/routes/api/linkCheck.js');
  const handlers = {};
  const api = { get: (p, ...h) => { handlers[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { handlers[`POST ${p}`] = h.at(-1); }, put: () => {}, delete: () => {}, patch: () => {} };
  registerLinkCheck(api);
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res, set: () => res };
  await handlers['GET /tools/link-check']({ query: {}, user: { role: 'admin' } }, res);
  return body;
}

/* ── F1 ─────────────────────────────────────────────────────────── */
test('F1 엣지 보고는 등록부 이름과 대소문자만 달라도 그 엣지 링크 행에 붙는다(잴 링크 0개 note 가 화면까지 간다)', async () => {
  LE._resetEdgeLinkReportsForTest();
  // 토큰 agent 표기는 소문자('edge-kr'), 등록부 이름은 'Edge-KR' — 수신은 대소문자를 무시하고 받는다.
  const put = await LE.putEdgeLinkReport('edge-kr', { at: Date.now(), results: [], note: '이 엣지가 잴 링크가 없습니다.' });
  assert.equal(put.ok, true);
  const body = await linkCheckMain();
  assert.ok(body && body.ok, '응답');
  const edgeRows = body.links.filter((l) => l.by === 'edge' && String(l.from).toLowerCase() === 'edge-kr');
  assert.ok(edgeRows.length >= 1, `엣지 측정 링크가 있어야 한다(${edgeRows.length})`);
  for (const r of edgeRows) {
    assert.ok(r.edgeReport, `${r.id}: 보고가 왔는데 edgeReport 가 null 이다(대소문자 구분 조회)`);
    assert.equal(r.edgeReport.note, '이 엣지가 잴 링크가 없습니다.');
  }
});

test('F1 표기가 같은 엣지는 예전 그대로(회귀 없음) · 보고가 없는 엣지는 null', async () => {
  LE._resetEdgeLinkReportsForTest();
  let body = await linkCheckMain();
  for (const r of body.links.filter((l) => l.by === 'edge')) assert.equal(r.edgeReport, null, '보고 없음은 null');
  await LE.putEdgeLinkReport('Edge-KR', { at: Date.now(), results: [], note: 'n' });
  body = await linkCheckMain();
  for (const r of body.links.filter((l) => l.by === 'edge')) assert.equal(r.edgeReport?.note, 'n');
});

/* ── F2 ─────────────────────────────────────────────────────────── */
test('F2 한 보고 안의 같은 링크 id 는 한 번만 적재한다 — 두 번째부터 rejected(표본·일 롤업을 부풀리지 않는다)', async () => {
  dbm._resetForTest?.();
  LE._resetEdgeLinkReportsForTest();
  const id = linkIdOf('edge->central', 'Edge-KR', 'central');
  const one = (ts, ok) => ({ link: { id, kind: 'edge->central', from: 'Edge-KR', to: 'central' }, ts, verdict: { ok, phase: ok ? '' : 'tcp', totalMs: 40 } });
  const at = NOW;
  const out = await LE.putEdgeLinkReport('Edge-KR', { at, results: [one(at - 3 * MIN, true), one(at - 2 * MIN, true), one(at - MIN, false)] });
  assert.equal(out.ok, true);
  assert.equal(out.stored, 1, `같은 id 3개 중 1개만 적재해야 한다(stored=${out.stored})`);
  assert.equal(out.rejected, 2, '나머지는 rejected 로 센다(조용히 버리지 않는다)');
  const s = await dbm.samplesOf(id, { hours: 24 });
  const rows = s.rows || s.samples || [];
  assert.equal(rows.length, 1, `표본 1행(실제 ${rows.length})`);
  const daily = await dbm.dailyOf({ linkId: id, days: 3 });
  const n = daily.reduce((a, r) => a + Number(r.n || 0), 0);
  assert.equal(n, 1, `일 롤업 n=1(실제 ${n})`);
});

test('F2 서로 다른 링크 id 는 그대로 모두 받는다(정상 보고 회귀 없음)', async () => {
  dbm._resetForTest?.();
  LE._resetEdgeLinkReportsForTest();
  const a = linkIdOf('edge->central', 'Edge-KR', 'central');
  const b = linkIdOf('edge->central-pull', 'Edge-KR', 'central');
  const out = await LE.putEdgeLinkReport('Edge-KR', { at: NOW, results: [
    { link: { id: a, kind: 'edge->central', from: 'Edge-KR', to: 'central' }, ts: NOW - MIN, verdict: { ok: true } },
    { link: { id: b, kind: 'edge->central-pull', from: 'Edge-KR', to: 'central' }, ts: NOW - MIN, verdict: { ok: true } },
  ] });
  assert.equal(out.stored, 2);
  assert.equal(out.rejected, 0);
});

/* ── F3 ─────────────────────────────────────────────────────────── */
/*
 * F3 VM 백업 잡 저장(`POST /tools/vm-clone/jobs`)이 요청 본문의 `demo:true` 를 새 잡에 그대로 받았다. 데모 표지는 데모 시드
 *   (mock/demo/vmclone.js → store.saveJob 직접)만 세우는 내부 표지다 — live 에서 표지가 붙은 잡은 실행기가 'demo-job' 으로 건너뛰고,
 *   위임 동기화(syncPayloadFor)가 엣지에 내려보내지 않고, RPO 판정도 하지 않는다(rpo.js — 데모는 판정 안 함). 화면에는 켜진 잡으로
 *   보이는데 백업도 RPO 경보도 없는 잡이 API 한 번으로 생겼다. 라우트는 그 표지를 받지 않는다.
 */
async function vmCloneHandlers() {
  const { registerVmClone } = await import('../src/routes/api/vmClone.js');
  const h = {};
  const reg = (m) => (p, ...fns) => { h[`${m} ${p}`] = fns.at(-1); };
  registerVmClone({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), patch: reg('PATCH') });
  return h;
}
const callRoute = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; }, set: () => res };
  await fn(req, res);
  return { status, body };
};

test('F3 잡 저장 라우트는 요청 본문의 demo 표지를 받지 않는다(데모 시드만 세운다)', async () => {
  const h = await vmCloneHandlers();
  const user = { username: 'root', role: 'admin', scope: null };
  const r = await callRoute(h['POST /tools/vm-clone/jobs'], { user, body: { vcenterId: 'vc-65', vmId: 'vm-65', vmName: 'web65', dest: { type: 'datastore', datastoreName: 'ds65' }, schedule: { mode: 'interval', hours: 24 }, keep: 2, demo: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.notEqual(r.body.job.demo, true, '라우트로 만든 잡에 데모 표지가 붙으면 실행 · 위임 · RPO 판정에서 모두 빠진다');
  const { listJobs } = await import('../src/vmclone/store.js');
  assert.notEqual(listJobs().find((j) => j.id === r.body.job.id)?.demo, true, '저장본에도 없다');
  const { syncPayloadFor } = await import('../src/vmclone/dispatch.js');
  const targets = new Map([['vc-65', { where: 'edge', agent: 'Edge-KR' }]]);
  assert.equal(syncPayloadFor('edge-kr', listJobs(), targets).jobs.length, 1, '담당 엣지에 내려간다');
});

test('F3 데모 시드 경로(store.saveJob 직접)는 그대로 데모 표지를 세운다(회귀 없음)', async () => {
  const { saveJob } = await import('../src/vmclone/store.js');
  const j = saveJob({ vcenterId: 'vc-65d', vmId: 'vm-65d', vmName: 'demo65', dest: { type: 'datastore', datastoreName: 'ds' }, demo: true });
  assert.equal(j.demo, true);
});
