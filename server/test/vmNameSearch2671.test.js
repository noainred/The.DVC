/**
 * v2.671 — /vms?nameOnly=1: VM 이름만 검색(Platform 화면 전체 vCenter VM 조회). 범위(scope)는 그대로 강제된다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2671-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

test('nameOnly=1 은 이름만 보고, 범위 계정은 허용 vCenter 만 받는다', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  await store.refresh();
  const snap = store.get();
  const app = express(); app.use(express.json());
  let asUser = null;
  app.use((req, _res, next) => { if (asUser) req.user = asUser; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    // 게스트 OS 에만 있는 낱말 — 이름 검색에서는 걸리지 않아야 한다
    const osWord = String(snap.vms.find((v) => v.guestOS)?.guestOS || '').split(/\s+/)[0].toLowerCase();
    const inName = snap.vms.filter((v) => String(v.name).toLowerCase().includes(osWord)).length;
    const r1 = await (await fetch(`${base}/vms?q=${encodeURIComponent(osWord)}&nameOnly=1&limit=5000`)).json();
    const r2 = await (await fetch(`${base}/vms?q=${encodeURIComponent(osWord)}&limit=5000`)).json();
    assert.equal(r1.total, inName, '이름 전용 — 게스트 OS 일치는 세지 않는다');
    assert.ok(r2.total > r1.total, '기본 검색은 예전처럼 게스트 OS 도 본다');
    const name = snap.vms[0].name;
    const r3 = await (await fetch(`${base}/vms?q=${encodeURIComponent(name.slice(0, 6))}&nameOnly=1&limit=50&sortBy=name&order=asc`)).json();
    assert.ok(r3.items.every((v) => v.name.toLowerCase().includes(name.slice(0, 6).toLowerCase())));
    assert.ok(r3.items.length <= 50);
    const vc = snap.vcenters[0].id;
    asUser = { username: 'r', role: 'viewer', scope: { vcenters: [vc] } };
    const r4 = await (await fetch(`${base}/vms?q=${encodeURIComponent(name.slice(0, 2))}&nameOnly=1&limit=5000`)).json();
    assert.ok(r4.items.every((v) => v.vcenterId === vc), '범위 밖 vCenter 의 VM 은 나오지 않는다');
  } finally { srv.close(); }
});
