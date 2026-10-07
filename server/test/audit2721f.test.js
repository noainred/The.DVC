/**
 * audit2721f — v2.721 감사 그룹 F 회귀(실제 api 라우터를 express 에 마운트해 범위 계정 응답을 본다).
 *  · B2-01: VM DNS 도달성 점검 결과의 qname(전 함대 VM 도메인 최빈값)·전 함대 summary 가 범위 계정 응답에 실리지 않는다.
 *  · B2-02: VM 구성 점검 설정 GET 이 범위 계정에 exceptions 원문·updatedBy 를 주지 않는다(개수만 · exceptionsHidden).
 * 전체 범위 관리자 응답은 그대로다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('B2-01·B2-02 범위 계정 가림 — 실제 라우터', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2721f-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
    operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    await store.refresh?.();
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const { runVmDnsProbe } = await import(${JSON.stringify(path.join(SRC, 'vmdns/probe.js'))});
    const { saveVmHygieneSettings } = await import(${JSON.stringify(path.join(SRC, 'vmhygiene/settings.js'))});
    const snap = store.get();
    const first = (snap.vcenters || [])[0].id;
    const users = {
      admin: { username: 'a', role: 'admin', scope: null },
      scopedViewer: { username: 'sv', role: 'viewer', scope: { vcenters: [first] } },
    };
    const app = express(); app.use(express.json());
    let who = 'admin';
    app.use((req, _r, n) => { req.user = users[who]; n(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const call = async (u, p) => { who = u; const r = await fetch(base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; };
    const out = {};
    // 범위 계정이 보는 DNS 서버 하나를 골라, 다른 법인 도메인을 qname 으로 한 점검 결과를 심는다(닫힌 루프백 포트 · 짧은 시한).
    const pre = await call('scopedViewer', '/tools/vm-dns');
    const ip = pre.j?.servers?.[0]?.ip;
    out.ip = ip;
    // 루프백(127.0.0.1)이 아니라 실제 서버 주소를 그대로 쓰되 시한을 짧게 — 결과 모양만 필요하다.
    const pr = await runVmDnsProbe([{ ip, qname: 'secret-corpb.internal', skip: null }], { port: 9, timeoutMs: 80 });
    out.probeOk = pr.ok;
    const ad = await call('admin', '/tools/vm-dns/server?ip=' + ip);
    out.adminQname = ad.j?.server?.probe?.qname ?? null;
    const adTop = await call('admin', '/tools/vm-dns');
    out.adminSummary = adTop.j?.probe?.summary || null;
    const sd = await call('scopedViewer', '/tools/vm-dns/server?ip=' + ip);
    out.scopedServer = { s: sd.s, qname: sd.j?.server?.probe?.qname ?? null, hidden: sd.j?.server?.probe?.qnameHidden ?? null, leak: sd.t.includes('secret-corpb.internal') };
    const st = await call('scopedViewer', '/tools/vm-dns');
    out.scopedTop = { summary: (st.j?.probe && 'summary' in st.j.probe) ? st.j.probe.summary : 'missing', hidden: st.j?.probe?.summaryHidden ?? null, leak: st.t.includes('secret-corpb.internal') };
    // B2-02
    saveVmHygieneSettings({ exceptions: ['corpB-erp-db', 'other-corp-x'] }, 'fleet-admin-name');
    const ah = await call('admin', '/tools/vm-hygiene/settings');
    out.adminHyg = { ex: ah.j?.settings?.exceptions, by: ah.j?.settings?.updatedBy, hidden: ah.j?.settings?.exceptionsHidden ?? null };
    const sh = await call('scopedViewer', '/tools/vm-hygiene/settings');
    out.scopedHyg = { s: sh.s, ex: sh.j?.settings?.exceptions, n: sh.j?.settings?.exceptionsCount, hidden: sh.j?.settings?.exceptionsHidden, by: sh.j?.settings?.updatedBy,
      leak: sh.t.includes('corpB-erp-db') || sh.t.includes('fleet-admin-name'), snapAgeDays: sh.j?.settings?.snapAgeDays };
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800));
  const o = JSON.parse(line.slice(2));
  assert.ok(o.ip, '범위 계정이 보는 DNS 서버가 있어야 한다');
  assert.equal(o.probeOk, true);
  // 전체 범위 관리자 — 그대로
  assert.equal(o.adminQname, 'secret-corpb.internal');
  assert.ok(o.adminSummary && o.adminSummary.targets === 1, JSON.stringify(o.adminSummary));
  // 범위 계정 — qname 없음 + 표지, summary null + 표지
  assert.equal(o.scopedServer.s, 200);
  assert.equal(o.scopedServer.qname, null);
  assert.equal(o.scopedServer.hidden, true);
  assert.equal(o.scopedServer.leak, false, '다른 법인 도메인이 범위 계정 응답에 실리지 않는다');
  assert.equal(o.scopedTop.summary, null, '전 함대 점검 요약은 범위 계정에 null');
  assert.equal(o.scopedTop.hidden, true);
  assert.equal(o.scopedTop.leak, false);
  // B2-02
  assert.deepEqual(o.adminHyg.ex, ['corpB-erp-db', 'other-corp-x']);
  assert.equal(o.adminHyg.by, 'fleet-admin-name');
  assert.equal(o.adminHyg.hidden, null);
  assert.equal(o.scopedHyg.s, 200);
  assert.deepEqual(o.scopedHyg.ex, []);
  assert.equal(o.scopedHyg.n, 2, '뺀 개수는 밝힌다');
  assert.equal(o.scopedHyg.hidden, true);
  assert.equal(o.scopedHyg.by, null);
  assert.equal(o.scopedHyg.leak, false);
  assert.equal(o.scopedHyg.snapAgeDays, 7, '임계값 등 나머지 설정은 그대로');
});
