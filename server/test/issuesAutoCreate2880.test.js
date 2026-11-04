/**
 * issuesAutoCreate2880.test.js — 하드웨어 파트 장애 → 이슈 자동 등록(v2.880 · 시안 docs/design/wiki-issues ⑪).
 *
 * ① 순수 판정(planPartFault · eligibility · titleOf) — 같은 함수가 시험 실행과 실제 실행에 쓰인다.
 * ② 실제 저장소 경로 — 자식 프로세스에서 CONFIG_DIR 을 갈아 끼우고 applyPartFaultIssues 를 실제로 부른다(진입 함수를 실제로 호출 — common.md).
 * ③ 라우트 문지기 — 실제 api 라우터(관리자 + 전체 범위 · 저장은 쓰기 범위 무제한).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planPartFault, eligibility, titleOf, defaultAutoCreate, normalizeAutoCreate, AUTO_SUPPORTED } from '../src/issues/autoCreate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const HOUR = 3600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR + 30 * 60_000;

const cfgOn = (patch = {}) => ({ ...defaultAutoCreate().partfault, enabled: true, ...patch });
const part = (o = {}) => ({ agent: 'kr-seoul', scope: 'idrac', deviceId: '10.0.0.5', deviceName: 'esx-01', kind: 'disk', partKey: `idrac:SVC1:disk:${o.id || 'Bay5'}`, label: `Disk ${o.id || 'Bay5'}`, state: 'fault', firstSeenAt: NOW, ...o });

test('① 대상 판정 — unknown · absent · ok 는 장애가 아니다 · 끈 칸 · warn 은 fault+warn 칸에서만 · 추출기 없는 칸 · 법인 예외', () => {
  const cfg = cfgOn({ agentsOff: ['kr-busan'] });
  assert.equal(eligibility(part({ state: 'fault' }), cfg).ok, true);
  for (const s of ['unknown', 'absent', 'ok']) assert.deepEqual(eligibility(part({ state: s }), cfg), { ok: false, why: 'not-fault' }, s);
  assert.equal(eligibility(part({ kind: 'disk', state: 'warn' }), cfg).ok, true, '기본값: iDRAC 디스크는 fault + warn');
  assert.deepEqual(eligibility(part({ kind: 'psu', state: 'warn' }), cfg), { ok: false, why: 'warn-off' });
  assert.deepEqual(eligibility(part({ kind: 'pcie' }), cfg), { ok: false, why: 'kind-off' }, '기본값: PCIe 는 끔');
  assert.deepEqual(eligibility(part({ kind: 'nic' }), cfg), { ok: false, why: 'unsupported' }, 'NIC 추출기는 없다');
  assert.deepEqual(eligibility(part({ scope: 'esxi' }), cfg), { ok: false, why: 'unsupported' }, 'ESXi 추출기는 없다');
  assert.deepEqual(eligibility(part({ agent: 'KR-Busan' }), cfg), { ok: false, why: 'agent-off' }, '법인 예외는 대소문자 무시');
  // 지원 칸은 추출기 파일과 맞는다(새 종류가 추출기에 생기면 여기도 고친다)
  for (const [scope, file] of [['idrac', 'idrac.js'], ['storage', 'storage.js'], ['sanswitch', 'sanswitch.js']]) {
    const src = fs.readFileSync(path.join(SRC, 'partfault/extract', file), 'utf8');
    for (const k of AUTO_SUPPORTED[scope]) assert.ok(src.includes(`'${k}'`), `${scope}.${k} 가 추출기에 있다`);
  }
});

test('② 계획 — 열린 이슈가 있으면 댓글(다시 열림) · 장비 폭주는 1건 · 창 안 이슈에 붙임 · 하루 상한 · 키 변경 · 해소 · 보류는 사유가 바뀔 때만', () => {
  const cfg = cfgOn({ burstMax: 3, burstWindowMin: 5, dailyMax: 2 });
  const ex = [{ key: 'ISS-9', status: 'todo', createdAt: NOW - 2 * HOUR, origin: { kind: 'partfault', agent: 'kr-seoul', scope: 'idrac', deviceId: '10.0.0.5', partKeys: ['kr-seoul|idrac:SVC1:disk:Bay5'], resolved: [], hold: 'unknown' } }];
  const p = planPartFault({ opened: [part()], updated: [], closed: [], held: [] }, cfg, { existing: ex, now: NOW });
  assert.deepEqual(p.actions.map((a) => [a.type, a.key]), [['reopen', 'ISS-9']], '같은 파트 키 → 새 이슈가 아니라 댓글');

  const four = ['A', 'B', 'C', 'D'].map((id) => part({ id, deviceId: '10.0.0.7', deviceName: 'esx-07' }));
  const b = planPartFault({ opened: four }, cfg, { existing: [], now: NOW });
  assert.equal(b.actions.length, 1); assert.equal(b.actions[0].type, 'create'); assert.equal(b.actions[0].device, true); assert.equal(b.actions[0].parts.length, 4);

  const recent = [{ key: 'ISS-11', status: 'backlog', createdAt: NOW - 60_000, origin: { kind: 'partfault', agent: 'kr-seoul', scope: 'idrac', deviceId: '10.0.0.7', partKeys: ['kr-seoul|x'], resolved: [] } }];
  const at = planPartFault({ opened: four.slice(0, 3) }, cfg, { existing: recent, now: NOW });
  assert.deepEqual(at.actions.map((a) => [a.type, a.key, a.parts?.length]), [['attach', 'ISS-11', 3]], '창 안 장비 이슈가 있으면 붙인다');

  const three = ['10.1', '10.2', '10.3'].map((d) => part({ deviceId: d, id: d }));
  const cap = planPartFault({ opened: three }, cfg, { existing: [], now: NOW, createdToday: 1 });
  assert.equal(cap.actions.filter((a) => a.type === 'create').length, 1, '하루 상한 2 · 오늘 1 → 1건만');
  assert.equal(cap.capped, 2);

  const mig = planPartFault({ opened: [part({ partKey: 'idrac:NEWTAG:disk:Bay5', migratedFrom: 'idrac:SVC1:disk:Bay5' })], closed: [part({ closeReason: 'key-migrated' })] }, cfg, { existing: ex, now: NOW });
  assert.deepEqual(mig.actions.map((a) => a.type), ['migrate'], '키 변경은 같은 장애 — 새 이슈도 해소 댓글도 없다');

  const res = planPartFault({ closed: [part({ closeReason: 'removed' })] }, cfg, { existing: ex, now: NOW });
  assert.deepEqual(res.actions.map((a) => [a.type, a.reason]), [['resolve', 'removed']]);

  const held1 = planPartFault({ held: [part({ holdReason: 'unknown' })] }, cfg, { existing: ex, now: NOW });
  assert.equal(held1.actions.length, 0, '같은 보류 사유는 다시 댓글을 달지 않는다');
  const held2 = planPartFault({ held: [part({ holdReason: 'device-failed' })] }, cfg, { existing: ex, now: NOW });
  assert.deepEqual(held2.actions.map((a) => a.type), ['hold']);

  const unk = planPartFault({ opened: [part({ state: 'unknown' }), part({ state: 'absent', id: 'Z' })] }, cfg, { existing: [], now: NOW });
  assert.equal(unk.actions.length, 0); assert.equal(unk.skipped['not-fault'], 2);
  const off = planPartFault({ opened: [part()] }, { ...cfg, matrix: { ...cfg.matrix, idrac: { ...cfg.matrix.idrac, disk: 'off' } } }, { existing: [], now: NOW });
  assert.equal(off.actions.length, 0); assert.equal(off.skipped['kind-off'], 1);
});

test('② 제목 틀 · 설정 정제(저장은 400 · 파일은 버리고 센다)', () => {
  assert.equal(titleOf('[파트 장애] {법인} · {장비} · {부품종류} {부품} {상태}', part(), { corp: '서울' }), '[파트 장애] 서울 · esx-01 · 디스크 Disk Bay5 이상');
  assert.match(titleOf('{장비} {부품}', part(), { parts: 4 }), /esx-01 4개/);
  assert.throws(() => normalizeAutoCreate({ matrix: { idrac: { disk: 'maybe' } } }), /matrix\.idrac\.disk/);
  assert.throws(() => normalizeAutoCreate({ dailyMax: 0 }), /dailyMax/);
  assert.throws(() => normalizeAutoCreate({ agentsOff: ['bad name'] }), /agentsOff/);
  const loose = normalizeAutoCreate({ matrix: { idrac: { disk: 'maybe', nic: 'fault' } }, priority: { disk: 'p9' } }, { strict: false });
  assert.equal(loose.value.partfault.matrix.idrac.disk, 'warn');
  assert.equal(loose.value.partfault.matrix.idrac.nic, undefined, '지원하지 않는 칸은 받지 않는다');
  assert.equal(loose.dropped, 2);
  assert.equal(normalizeAutoCreate({}).value.partfault.enabled, false, '기본값은 꺼짐');
});

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuesAuto2880-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const ac = await import(${JSON.stringify(path.join(SRC, 'issues/autoCreate.js'))});
    const app = express();
    app.use(express.json());
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const NOW = ${NOW};
    const part = (o = {}) => ({ agent: 'kr-seoul', scope: 'idrac', deviceId: '10.0.0.5', deviceName: 'esx-01', kind: 'disk', partKey: 'idrac:SVC1:disk:' + (o.id || 'Bay5'), label: 'Disk ' + (o.id || 'Bay5'), state: 'fault', firstSeenAt: NOW, ...o });
    const out = {};
    ${body}
    st.flushIssuesNow();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}

test('③ 실제 실행 — 꺼져 있으면 아무것도 · 켜면 장애 이슈(법인 · 우선순위 · 라벨 · 컴포넌트 · 자동 할당 · 출처) · 다시 열림은 댓글 · 해소되면 검토', () => {
  const { out } = run(`
    ac._setVcResolverForTest((agent, p) => agent === 'kr-seoul' && p.partKey ? { id: 'vc-seoul', name: '서울' } : { id: '', name: '' });
    out.off = await ac.applyPartFaultIssues({ opened: [part()] });
    out.offCount = st.listIssues({ done: 'all' }).total;
    await call('PUT', '/issues/settings', { autoAssign: { enabled: true, components: [{ name: '디스크', assignee: 'park' }], pool: [] } });
    out.put = await call('PUT', '/issues/autocreate', { enabled: true });
    out.r1 = await ac.applyPartFaultIssues({ opened: [part(), part({ id: 'U', state: 'unknown' })] });
    const row = st.listIssues({ done: 'all' }).rows[0];
    out.issue = st.getIssue(row.key);
    out.r2 = await ac.applyPartFaultIssues({ opened: [part()] });
    out.count2 = st.listIssues({ done: 'all' }).total;
    out.r3 = await ac.applyPartFaultIssues({ closed: [part({ closeReason: 'ok' })] });
    out.after = st.getIssue(row.key);
    out.status = ac.autoCreateStatus();
    out.get = await call('GET', '/issues/autocreate');
    out.sim = await call('POST', '/issues/autocreate/simulate', { hours: 24 });
    as({ username: 'sa', role: 'admin', scope: { vcenters: ['vc-seoul'] } });
    out.scopedGet = await call('GET', '/issues/autocreate');
    as({ username: 'wa', role: 'admin', scope: { writeVcenters: ['vc-seoul'] } });
    out.writeScopedPut = await call('PUT', '/issues/autocreate', { enabled: false });
    as({ username: 'op', role: 'operator', scope: null });
    out.opGet = await call('GET', '/issues/autocreate');
    out.forge = await call('POST', '/issues', { title: '위조', origin: { kind: 'partfault', partKeys: ['kr-seoul|x'] } });
    out.forgeIssue = st.getIssue(out.forge.j.issue.key);
  `);
  assert.equal(out.off.enabled, false); assert.equal(out.offCount, 0, '꺼져 있으면 만들지 않는다(기본값)');
  assert.equal(out.put.s, 200);
  assert.equal(out.r1.created, 1);
  assert.equal(out.r1.skipped['not-fault'], 1, 'unknown 은 만들지 않고 센다');
  const it = out.issue;
  assert.equal(it.type, 'incident'); assert.equal(it.priority, 'p1'); assert.equal(it.vcenterId, 'vc-seoul');
  assert.deepEqual(it.labels, ['partfault', 'auto']); assert.equal(it.component, '디스크');
  assert.equal(it.assignee, 'park', '자동 할당 규칙(컴포넌트 디스크)이 담당자를 정한다');
  assert.equal(it.reporter, 'partfault');
  assert.equal(it.origin.kind, 'partfault'); assert.equal(it.origin.parts, 1);
  assert.match(it.title, /^\[파트 장애\] 서울 · esx-01 · 디스크 Disk Bay5 이상$/);
  assert.match(it.body, /파트 장애 화면/);
  assert.equal(out.r2.created, 0); assert.equal(out.r2.commented, 1); assert.equal(out.count2, 1, '같은 파트가 다시 열리면 댓글');
  assert.equal(out.r3.review, 1);
  assert.equal(out.after.status, 'review', '덮는 키가 모두 해소되면 검토(완료는 사람이)');
  assert.ok(out.after.comments.some((c) => /다시 열렸습니다\(1회째\)/.test(c.body)));
  assert.ok(out.after.comments.some((c) => /해소:/.test(c.body)));
  assert.equal(out.status.created, 1);
  assert.equal(out.get.s, 200); assert.ok(out.get.j.supported.idrac.includes('disk')); assert.equal(out.get.j.settings.partfault.enabled, true);
  assert.equal(out.sim.s, 200); assert.equal(typeof out.sim.j.create, 'number');
  assert.equal(out.scopedGet.s, 403, '범위 관리자는 전 법인 공용 설정을 보지 못한다');
  assert.equal(out.writeScopedPut.s, 403, '쓰기 범위가 지정된 관리자는 저장하지 못한다');
  assert.equal(out.opGet.s, 403, '운영자는 설정을 보지 못한다');
  assert.equal(out.forge.s, 200); assert.equal(out.forgeIssue.origin, undefined, '라우트 본문의 origin 은 받지 않는다(위조 금지)');
});

test('③ 손상 설정 — 보존하고 기본값(꺼짐) · 화면이 loadError 로 말한다', () => {
  const { out, dir } = run(`
    out.get = await call('GET', '/issues/autocreate');
    out.r = await ac.applyPartFaultIssues({ opened: [part()] });
  `, { pre: (d) => fs.writeFileSync(path.join(d, 'issue-autocreate.json'), '{"partfault": {') });
  assert.ok(out.get.j.loadError);
  assert.equal(out.get.j.settings.partfault.enabled, false);
  assert.equal(out.r.created, 0);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('issue-autocreate.json.corrupt')).length, 1);
});

test('④ 법인 판정 — iDRAC 서비스 태그 → 그 호스트의 vCenter · 아니면 공용(지어내지 않는다)', () => {
  const { out } = run(`
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    store.snapshot = { ...store.snapshot, hosts: [{ name: 'esx-01', serviceTag: 'SVC1', vcenterId: 'vc-tag' }], vcenters: [{ id: 'vc-tag', name: '태그법인' }, { id: 'vc-b', name: 'B' }] };
    await call('PUT', '/issues/autocreate', { enabled: true });
    out.r = await ac.applyPartFaultIssues({ opened: [
      part({ agent: '', deviceKey: 'svc1', deviceKeyKind: 'serviceTag' }),
      part({ agent: '', id: 'X', deviceId: '10.9.9.9', deviceName: 'bm-01', deviceKey: 'NOPE', deviceKeyKind: 'serviceTag' }),
    ] });
    out.rows = st.listIssues({ done: 'all' }).rows.map((r) => [r.title, r.vcenterId]);
  `);
  assert.equal(out.r.created, 2);
  const byTitle = Object.fromEntries(out.rows);
  const tagged = out.rows.find(([tt]) => /esx-01/.test(tt));
  const other = out.rows.find(([tt]) => /bm-01/.test(tt));
  assert.equal(tagged[1], 'vc-tag', '서비스 태그(대소문자 무시)로 찾은 호스트의 vCenter');
  assert.match(tagged[0], /태그법인/, '제목의 법인은 vCenter 이름');
  assert.equal(other[1], '', '태그가 호스트에 없고 수집 서버가 여러 vCenter 를 맡으면 공용');
  void byTitle;
});
