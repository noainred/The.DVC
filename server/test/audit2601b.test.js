/**
 * v2.601 감사 — 권한·가림 그룹(b) 회귀 고정.
 *
 *  - AUTHZ-2601-01  bm-usage: addressHidden:true 인데 IP 로 등록한 iDRAC 의 serverId·fleetId·name·key,
 *                   작업 로그 deviceId·name, 스킴 붙은 host 의 오류 문구가 비-admin 에 그대로 나갔다
 *  - AUTHZ-2601-02  파트 장애 open·events 가 비-admin 에 deviceId·deviceName·partKey(= IP)를 줬다
 *  - AUTHZ-2601-03  insights finops·power-breakdown·fleet 이 IP 이름 iDRAC 서버를 viewer 에 줬다
 *  - AUTHZ-2601-04  esxi-temp 의 iDRAC 행이 ip 필드와 IP 폴백 name/id 를 비-admin 에 줬다
 *  - WEB2601-04     존재하지 않는 vCenter 로 범위를 둔 연동 키에 공개 API 가 전부 0 을 ok:true 로 줬다
 *
 * ⚠ 검증 방식: 순수 함수는 직접, 라우트는 **실제 라우터를 express 에 띄워 역할별 응답으로** 본다.
 *   admin 응답에 같은 IP 가 **실제로 있는지**도 확인한다(가릴 것이 없어서 통과하는 공허한 테스트 방지).
 *   기준 시각은 고정값(정시 경계에서 떨어뜨린 값)이다(CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addressMatcher, maskedIdToken, resolveMaskedToken, maskActivityEvents } from '../src/auth/addressMask.js';
import { maskTargetAddress } from '../src/bmusage/targets.js';
import { maskPartRow } from '../src/routes/api/partFaults.js';
import { maskIdracTempRows } from '../src/tools/serverTemp.js';
import { normalizeKeyInput } from '../src/publicapi/keys.js';
import { maskFinopsPayload, maskPowerBreakdownPayload, maskFleetPayload } from '../src/routes/insights.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (p) => JSON.stringify(path.join(SRC, p));
const IP = '10.99.1.14';
const IP_RE = /10\.99\.1\.\d+/;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % 3_600_000) - 30 * 60_000; // 정시 −30분 고정

/* ── 순수 ─────────────────────────────────────────────────────────────────── */

test('addressMatcher·토큰 — IP·합성 id·등록부 주소(스킴 무시)는 주소, 서비스태그·ESXi 이름은 아님 · 토큰은 결정적이고 되찾을 수 있다', () => {
  const m = addressMatcher(['https://idrac-a.corp:443/']);
  for (const v of [IP, `host:vc-a:${IP}`, 'IDRAC-A.corp', 'fe80::1']) assert.equal(m(v), true, v);
  for (const v of ['ABC1234', 'host:vc-a:esx01', '', null, 12]) assert.equal(m(v), false, String(v));
  const tk = maskedIdToken(IP);
  assert.equal(tk, maskedIdToken(IP)); assert.notEqual(tk, maskedIdToken('10.99.1.15'));
  assert.ok(!tk.includes(IP));
  assert.equal(resolveMaskedToken(tk, ['x', IP]), IP);
  assert.equal(resolveMaskedToken('masked-zzz', [IP]), null);
});

test('AUTHZ-2601-01: maskTargetAddress 는 식별자·이름이 주소인 대상을 토큰으로 · 작업 로그는 스킴 붙은 host 도 가린다', () => {
  const pt = { serverId: IP, fleetId: IP, key: IP, name: IP, serviceTag: '', idracHost: `https://${IP}`, osHostName: null };
  const m = maskTargetAddress(pt);
  assert.ok(!IP_RE.test(JSON.stringify(m)), JSON.stringify(m));
  assert.equal(m.key, maskedIdToken(IP));
  assert.equal(m.osHostName, null, '경로 없음(null)과 가림(\'\')을 구분한다');
  assert.equal(pt.key, IP, '원본을 바꾸지 않는다');
  // 서비스태그 키 대상은 그대로(불필요하게 식별을 깨지 않는다)
  assert.equal(maskTargetAddress({ key: 'SVC1', name: 'db01', idracHost: `https://${IP}` }).name, 'db01');
  const ev = maskActivityEvents([{ deviceId: IP, name: IP, host: `https://${IP}`, error: `connect ETIMEDOUT ${IP}:443` }])[0];
  assert.ok(!IP_RE.test(JSON.stringify(ev)), JSON.stringify(ev));
  assert.equal(ev.deviceId, maskedIdToken(IP));
});

test('AUTHZ-2601-02: maskPartRow — deviceId·deviceKey·deviceName·partKey 를 같은 토큰으로 · 같은 장비는 같은 접두', () => {
  const m = addressMatcher([]);
  const r = { scope: 'idrac', deviceId: IP, deviceKey: IP, deviceName: IP, partKey: `idrac:${IP}:psu:PSU.Slot.1`, label: 'PSU 1', detail: `seen via ${IP}`, state: 'fault' };
  const a = maskPartRow(r, m); const b = maskPartRow({ ...r, partKey: `idrac:${IP}:fan:Fan.1` }, m);
  assert.ok(!IP_RE.test(JSON.stringify(a)), JSON.stringify(a));
  assert.equal(a.partKey, `idrac:${maskedIdToken(IP)}:psu:PSU.Slot.1`);
  assert.equal(a.partKey.split(':')[1], b.partKey.split(':')[1]);
  assert.equal(a.state, 'fault'); assert.equal(r.deviceId, IP);
  // 서비스태그 키 장비는 그대로
  const c = maskPartRow({ scope: 'idrac', deviceId: 'srv-1', deviceKey: 'SVC1', deviceName: 'db01', partKey: 'idrac:SVC1:psu:1' }, m);
  assert.equal(c.partKey, 'idrac:SVC1:psu:1'); assert.equal(c.deviceName, 'db01');
});

test('AUTHZ-2601-04: maskIdracTempRows — ip 칸을 비우고 IP 인 id·name 을 가린다 · ESXi 행은 그대로', () => {
  const idrac = { rows: [
    { id: IP, source: 'idrac', name: IP, ip: IP, curC: 22 },
    { id: 'srv-x', source: 'idrac', name: 'db01', ip: '10.99.1.20', curC: 21 },
    { id: 'host-1', source: 'esxi', name: 'esx01', ip: '', curC: 30 },
  ] };
  const m = maskIdracTempRows(idrac, [{ host: `https://${IP}` }]);
  assert.ok(!IP_RE.test(JSON.stringify(m)), JSON.stringify(m));
  assert.equal(m.rows[0].id, maskedIdToken(IP)); assert.equal(m.rows[1].name, 'db01');
  assert.equal(m.rows[2].name, 'esx01'); assert.equal(m.addressHidden, true);
  assert.equal(idrac.rows[0].ip, IP, '원본 불변(memo 캐시 공유)');
});

test('WEB2601-04: 등록되지 않은 vCenter 범위는 발급 경고를 싣는다 · 모르면 경고하지 않는다', () => {
  const all = normalizeKeyInput({ name: 'k', groups: ['inventory'], vcenters: ['vc-ghost'] }, { knownVcenters: new Set(['vc-a']) });
  assert.ok(all.issues.some((s) => s.includes('전부 등록돼 있지 않') && s.includes('scope-empty')), all.issues.join('|'));
  const part = normalizeKeyInput({ name: 'k', groups: ['inventory'], vcenters: ['vc-a', 'vc-ghost'] }, { knownVcenters: new Set(['vc-a']) });
  assert.ok(part.issues.some((s) => s.includes('1곳이 등록돼 있지 않')), part.issues.join('|'));
  const unknown = normalizeKeyInput({ name: 'k', groups: ['inventory'], vcenters: ['vc-ghost'] }, { knownVcenters: null });
  assert.ok(!unknown.issues.some((s) => s.includes('등록돼 있지 않')), '모르는 것을 삭제됐다고 말하지 않는다');
});


test('AUTHZ-2601-03: 인사이트 finops·power-breakdown·fleet 은 IP 이름 iDRAC 서버를 가리고 ESXi 호스트 이름은 그대로(인벤토리로 이미 보인다)', () => {
  const esxi = new Set(['10.99.1.50']);
  const isAddr = addressMatcher([]);
  const match = (v) => isAddr(v) && !esxi.has(String(v));
  const fin = { totals: {}, topHosts: [{ host: IP, watts: 300 }, { host: '10.99.1.50', watts: 200 }, { host: 'db01', watts: 100 }] };
  const fm = maskFinopsPayload(fin, match);
  assert.ok(!fm.topHosts[0].host.includes(IP)); assert.equal(fm.topHosts[1].host, '10.99.1.50'); assert.equal(fm.topHosts[2].host, 'db01');
  assert.equal(fm.addressHidden, true); assert.equal(fin.topHosts[0].host, IP, '캐시 원본 불변');
  const pb = maskPowerBreakdownPayload({ servers: [{ name: IP, watts: 1 }] }, match);
  assert.ok(!IP_RE.test(JSON.stringify(pb)));
  const fl = maskFleetPayload({ bareMetal: [{ serverId: IP, fleetId: IP, tagKey: IP, name: IP }], virtualizationHosts: [{ name: 'esx01', fleetId: 'svc1' }] }, match);
  assert.ok(!IP_RE.test(JSON.stringify(fl)), JSON.stringify(fl));
  assert.equal(fl.bareMetal[0].tagKey, fl.bareMetal[0].fleetId, '같은 원문은 같은 토큰');
});

/* ── 실제 라우터 ─────────────────────────────────────────────────────────── */

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2601b-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const { insightsRouter } = await import(${J('routes/insights.js')});
    const idracReg = await import(${J('idrac/registry.js')});
    const bmSet = await import(${J('bmusage/settings.js')});
    const bmDb = await import(${J('bmusage/db.js')});
    const { recordBmUsage } = await import(${J('bmusage/activityLog.js')});
    const pfDb = await import(${J('partfault/db.js')});
    const { pushSensorSample } = await import(${J('idrac/sensorStore.js')});
    const keys = await import(${J('publicapi/keys.js')});
    const publicApi = (await import(${J('routes/publicApi.js')})).default;
    await store.refresh({ force: true });
    const snap = store.get();
    const vcs = snap.vcenters.map((v) => v.id);
    const mk = (user) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api/insights', insightsRouter);
      app.use('/api', api);
      return app;
    };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p, init) => {
      const r = await fetch(base + p, init);
      const text = await r.text();
      let b = null; try { b = JSON.parse(text); } catch {}
      return { status: r.status, body: b, text };
    };
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)} ${r.stderr?.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

test('실제 라우터 — admin 은 원문, 비-admin 은 가림(bm-usage·파트 장애·인사이트·서버 온도) + 공개 API scope-empty', () => {
  const r = runLive(`
    const [A] = vcs;
    const IP = ${JSON.stringify(IP)};
    const add = idracReg.addServer({ id: IP, name: IP, host: 'https://' + IP, username: 'root', password: 'pw', vcenterId: A, hostNames: [IP], enabled: true });
    bmSet.saveBmUsageSettings({ enabled: true, corps: { [A]: true } });
    await bmDb.insertUsage([{ key: IP, ts: ${T0}, name: IP, vcenterId: A, src: 'idrac', cpu_pct: 12, mem_pct: 34 }], '');
    recordBmUsage({ deviceId: IP, name: IP, host: 'https://' + IP, source: 'central', ok: false, error: 'connect ETIMEDOUT ' + IP + ':443' });
    await pfDb.applyTransition({ opened: [{ scope: 'idrac', agent: '', deviceId: IP, deviceKey: IP, deviceKeyKind: 'localId', deviceName: IP,
      partKey: 'idrac:' + IP + ':psu:PSU.Slot.1', kind: 'psu', partId: 'PSU.Slot.1', keyKind: 'fqdd', label: 'PSU 1', detail: '', state: 'fault', rawState: 'Critical' }] }, { now: ${T0} });

    // 서버 온도: IP 로 등록한 iDRAC 의 센서 표본 — 그러면 목 합성 행 대신 실제 행(id·name = IP)이 생긴다
    pushSensorSample(IP, { t: Date.now(), temps: [{ name: 'System Board Inlet Temp', celsius: 22 }, { name: 'System Board Exhaust Temp', celsius: 35 }] });
    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
    const sop = await start(mk({ username: 'sop', role: 'operator', scope: { vcenters: [A] } }));
    const P = ['/api/tools/bm-usage', '/api/tools/bm-usage/activity', '/api/tools/part-faults', '/api/tools/part-faults/events',
      '/api/insights/fleet', '/api/insights/finops', '/api/insights/power-breakdown', '/api/tools/esxi-temp'];
    const res = {};
    for (const [who, b] of [['admin', admin], ['oper', oper]]) {
      res[who] = {};
      for (const p of P) { const x = await req(b, p); res[who][p] = { status: x.status, ip: /10\\.99\\.1\\.\\d+/.test(x.text), hidden: x.body?.addressHidden === true || x.body?.idrac?.addressHidden === true }; }
    }
    // 비-admin 화면 기능: 가린 key 로 추이를 연다 · 대상의 key 와 최신값 행의 key 가 짝을 이룬다
    const bmO = (await req(oper, '/api/tools/bm-usage')).body;
    const tk = bmO.targets.find((x) => String(x.key).startsWith('masked-'))?.key || '';
    const hist = await req(oper, '/api/tools/bm-usage/history?key=' + encodeURIComponent(tk));
    const rowPaired = (bmO.rows || []).some((x) => x.key === tk);
    const bmA = (await req(admin, '/api/tools/bm-usage')).body;
    // 가린 partKey 로 이벤트 필터
    const pfO = (await req(oper, '/api/tools/part-faults')).body;
    const pk = pfO.open?.[0]?.partKey || '';
    const evF = (await req(oper, '/api/tools/part-faults/events?partKey=' + encodeURIComponent(pk) + '&agent=')).body;

    // 서버 온도 스파크: 비-admin 은 가린 id 로 조회해도 같은 행의 추이를 받는다.
    //   범위 계정으로 본다 — 전체 범위 계정은 소유 검사가 없고 목 데이터가 추이를 합성해 되찾기 실패가 드러나지 않는다.
    const etO = (await req(oper, '/api/tools/esxi-temp')).body;
    const etRow = (etO.idrac?.rows || []).find((x) => String(x.id).startsWith('masked-'));
    const spark = etRow ? (await req(sop, '/api/tools/esxi-temp/spark', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ key: etRow.id, source: 'idrac' }] }) })).body : null;
    const etA = (await req(admin, '/api/tools/esxi-temp')).body;

    // 공개 API — 존재하지 않는 vCenter 로만 범위를 둔 키 / 일부만 없는 키
    const papp = express(); papp.use('/api/v1', publicApi); const pub = await start(papp);
    const ghost = keys.issueApiKey({ name: 'g', groups: ['inventory'], vcenters: ['vc-ghost'] });
    const mixed = keys.issueApiKey({ name: 'm', groups: ['inventory'], vcenters: [A, 'vc-ghost'] });
    const H = (k) => ({ headers: { 'X-Api-Key': k } });
    const g = await req(pub, '/api/v1/inventory/summary', H(ghost.plaintext));
    const mx = await req(pub, '/api/v1/inventory/summary', H(mixed.plaintext));
    return { add: add.ok, res, tk, hist: { status: hist.status, ip: /10\\.99\\.1\\.\\d+/.test(hist.text) }, rowPaired,
      adminHasTarget: (bmA.targets || []).some((x) => x.key === IP), pk, evCount: (evF.events || []).length,
      etRowId: etRow?.id || '', etIpsO: (etO.idrac?.rows || []).filter((x) => x.source === 'idrac').map((x) => x.ip),
      etAdminHasIp: (etA.idrac?.rows || []).some((x) => x.id === IP), sparkOk: !!(spark && spark.series && spark.series[etRow?.id]),
      ghostIssues: ghost.issues, g: { status: g.status, code: g.body?.code }, mx: { status: mx.status, meta: mx.body?.meta } };
  `);
  assert.ok(r.add, 'iDRAC 등록 실패');
  assert.ok(r.adminHasTarget, 'IP 등록 iDRAC 이 베어메탈 대상이 되지 않아 테스트가 공허하다');
  for (const [p, a] of Object.entries(r.res.admin)) assert.equal(a.status, 200, `admin ${p} ${a.status}`);
  for (const [p, o] of Object.entries(r.res.oper)) {
    assert.equal(o.status, 200, `oper ${p} ${o.status}`);
    assert.equal(o.ip, false, `비-admin 응답에 IP 가 남았다: ${p}`);
  }
  // admin 은 원문을 받는다 — 가릴 것이 실제로 있던 경로(공허 방지)
  for (const p of ['/api/tools/bm-usage', '/api/tools/bm-usage/activity', '/api/tools/part-faults', '/api/tools/part-faults/events', '/api/insights/fleet', '/api/tools/esxi-temp']) {
    assert.equal(r.res.admin[p].ip, true, `admin 은 원문을 받아야 한다(가릴 대상이 없으면 공허): ${p}`);
  }
  for (const p of ['/api/tools/bm-usage', '/api/tools/part-faults', '/api/tools/part-faults/events', '/api/insights/fleet']) {
    assert.equal(r.res.oper[p].hidden, true, `addressHidden 이 없다: ${p}`);
  }
  // 화면 기능이 깨지지 않는다
  assert.match(r.tk, /^masked-/);
  assert.equal(r.hist.status, 200, '가린 key 로 추이를 열 수 있어야 한다');
  assert.equal(r.hist.ip, false);
  assert.ok(r.rowPaired, '대상의 가린 key 와 최신값 행의 key 가 같아야 한다(표의 값 칸이 빈다)');
  assert.match(r.pk, /masked-/); assert.ok(r.evCount >= 1, '가린 partKey 로 이벤트를 찾아야 한다');
  // AUTHZ-2601-04 — 서버 온도: admin 은 IP 행, 비-admin 은 토큰 행 · ip 칸 빈 값 · 토큰으로 스파크 조회
  assert.ok(r.etAdminHasIp, '서버 온도에 IP 등록 iDRAC 행이 없어 테스트가 공허하다');
  assert.match(r.etRowId, /^masked-/);
  assert.ok(r.etIpsO.length && r.etIpsO.every((v) => v === ''), JSON.stringify(r.etIpsO));
  assert.ok(r.sparkOk, '가린 id 로 스파크를 조회할 수 있어야 한다');
  // WEB2601-04
  assert.ok(r.ghostIssues.some((s) => s.includes('scope-empty')), r.ghostIssues.join('|'));
  assert.equal(r.g.status, 403); assert.equal(r.g.code, 'scope-empty');
  assert.equal(r.mx.status, 200); assert.equal(r.mx.meta?.scopeUnknownVcenters, 1);
});
