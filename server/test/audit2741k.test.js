// v2.741 점검 그룹 GJ — LEFT-01: IP 대장 엑셀 내보내기(/tools/ipam.xlsx)가 이벤트 루프를 수 초 멈추던 것.
//  재현(감사 기준 2726851): 원장만 양보판(v2.740 F-06)이고 시트 조립(buildSubnetSheets — 동기)과 워크북 직렬화(wb.xlsx.write — exceljs 동기
//  XML 생성)에는 양보 지점이 없었다. 합성 /24 100개에서 직렬화 1.6초, 200개 4초대 동안 포탈 전체가 멈췄다(scratchpad xlsx_stall.mjs).
//  고친 것: 시트는 양보판(buildSubnetSheetsAsync — 같은 생성기 · 결과 같음), 워크북 조립·직렬화는 워커 스레드(renderIpamWorkbook —
//  같은 buildWorkbook · 결과 파일 같음). 동시 1건 가드(exportBusy)는 그대로다.
//  ⚠ CONFIG_DIR 은 import 전에 고정한다(config.js 가 import 시점에 굳는다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741k-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
delete process.env.IPAM_XLSX_WORKER;

// JSZip 은 exceljs 의 의존성이다 — 그 위치에서 불러온다(util/xlsxChart.js 와 같은 방식).
const reqHere = createRequire(import.meta.url);
const JSZip = createRequire(reqHere.resolve('exceljs'))('jszip');

let st, led, xl, srv, baseUrl;
before(async () => {
  st = await import('../src/store.js');
  led = await import('../src/ipam/ledger.js');
  xl = await import('../src/ipam/excel.js');
});
/** 실제 api 라우터를 띄운다(⑤ 만 쓴다 — 라우터 전체를 불러오므로 다른 테스트가 그 적재에 묶이지 않게 따로 둔다). */
async function startApi() {
  if (srv) return;
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  baseUrl = `http://127.0.0.1:${srv.address().port}/api`;
}
after(async () => {
  if (srv) { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

/** 압축을 풀어 항목 이름 → 내용(문자열). */
async function entriesOf(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (zip.files[name].dir) continue;
    out[name] = await zip.files[name].async('string');
  }
  return out;
}

/** 이벤트 루프 정지 탐지기 — 2ms 타이머 사이 간격의 최댓값. */
function stallProbe() {
  let worst = 0; let last = performance.now(); let stop = false;
  // unref — 단언이 실패해 done() 을 부르지 못해도 이 타이머가 테스트 프로세스를 붙잡지 않게(측정 중에는 워커·소켓이 루프를 붙잡는다).
  const tick = () => { const n = performance.now(); const d = n - last; if (d > worst) worst = d; last = n; if (!stop) setTimeout(tick, 2).unref(); };
  setTimeout(tick, 2).unref();
  return { done: () => { stop = true; return Math.round(worst); } };
}

/** 원장 시트 모양(필요 없는 owner·tags 포함)의 합성 시트 — 상태·특수 문자·한글·빈 값·undefined 를 섞는다. */
function synthSheets(n) {
  const STATUS = ['used', 'multihomed', 'duplicate', 'empty', 'released', 'scanned'];
  const sheets = [];
  for (let s = 0; s < n; s++) {
    const base = `172.${16 + (s >> 8)}.${s & 255}`;
    const rows = [];
    for (let i = 0; i < 256; i++) {
      const st0 = i === 0 ? 'network' : STATUS[(s + i) % STATUS.length];
      rows.push({
        ip: `${base}.${i}`, last: i,
        purpose: st0 === 'empty' ? '' : `VM · 서울<&>"'${s} / cl-${i % 5}`,
        hostname: st0 === 'empty' ? '' : `vm-${s}-${i}.corp.local`,
        serverType: i % 7 === 0 ? '베어메탈' : 'VM', os: i % 3 ? 'Rocky Linux 9' : '',
        notes: i % 11 === 0 ? '메모 — 첫 줄' : '', power: i % 2 ? 'On' : 'Off', scope: i % 13 ? '사설' : '공인',
        status: st0, owner: { id: `vm-${i}`, cpu: 4, blob: 'x'.repeat(64) }, tags: ['a', 'b'], memo: '',
        ...(i === 5 ? { notes: undefined } : {}),
      });
    }
    sheets.push({ subnet: `${base}.0/24`, base, used: 200 + (s % 50), rows, policies: [] });
  }
  return sheets;
}

test('LEFT-01 ① 결과 동일성 — 워커가 만든 파일은 인라인(예전 경로)과 압축을 푼 항목이 모두 같다', { timeout: 240_000 }, async () => {
  const created = Date.UTC(2026, 9, 15, 1, 2, 3);
  for (const n of [0, 1, 9, 23]) {
    const sheets = synthSheets(n);
    const out = await xl.renderIpamWorkbook(sheets, { created });
    assert.equal(out.mode, 'worker', `n=${n} 워커로 만들어야 한다`);
    assert.equal(out.sheets, n);
    const wb = await xl.buildWorkbook(sheets, { created }); // 같은 생성 시각을 준 인라인 판
    const ref = Buffer.from(await wb.xlsx.writeBuffer());
    const a = await entriesOf(out.buffer); const b = await entriesOf(ref);
    assert.deepEqual(Object.keys(a), Object.keys(b), `n=${n} 항목 목록`);
    for (const k of Object.keys(b)) assert.ok(a[k] === b[k], `n=${n} 항목 ${k} 내용이 다르다`);
    // 예전 라우트 경로(생성 시각을 주지 않은 buildWorkbook + 원장 시트 그대로) — 문서 생성·수정 시각이 들어가는 core.xml 만 다르다.
    const legacy = await entriesOf(Buffer.from(await (await xl.buildWorkbook(sheets)).xlsx.writeBuffer()));
    assert.deepEqual(Object.keys(a), Object.keys(legacy));
    for (const k of Object.keys(legacy)) if (k !== 'docProps/core.xml') assert.ok(a[k] === legacy[k], `n=${n} 예전 경로와 항목 ${k} 가 다르다`);
    if (n) assert.ok(Object.keys(a).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length === n, `n=${n} 시트 수`);
  }
});

test('LEFT-01 ② 정지 측정 — 워커 판은 직렬화 동안 이벤트 루프를 멈추지 않는다(인라인과 비교)', { timeout: 240_000 }, async (t) => {
  const sheets = synthSheets(120);
  const p1 = stallProbe();
  const wb = await xl.buildWorkbook(sheets, { created: 1 });
  await wb.xlsx.writeBuffer();
  const inline = p1.done();
  const p2 = stallProbe();
  let out; let worker;
  try { out = await xl.renderIpamWorkbook(sheets, { created: 1 }); } finally { worker = p2.done(); }
  t.diagnostic(`시트 120개: 인라인 최장 정지 ${inline}ms · 워커 최장 정지 ${worker}ms · 파일 ${out.buffer.length}B`);
  assert.equal(out.mode, 'worker');
  assert.ok(worker < 600, `워커 판 최장 정지 ${worker}ms`);
  assert.ok(worker * 3 < inline, `워커 ${worker}ms 가 인라인 ${inline}ms 보다 충분히 짧아야 한다`);
});

test('LEFT-01 ③ 시트 양보판 — buildSubnetSheetsAsync 는 동기판과 같은 결과(범위·vCenter·단일 /24)이고 실제로 양보한다', { timeout: 240_000 }, async () => {
  let gen = 0;
  const mk = (seed, nVm) => {
    let a = seed >>> 0;
    const r = () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const vms = [];
    for (let i = 0; i < nVm; i++) {
      const vc = r() < 0.5 ? 'vc1' : 'vc2';
      const ips = []; for (let j = 0; j < (r() < 0.15 ? 0 : (r() < 0.8 ? 1 : 2)); j++) ips.push(`10.${Math.floor(r() * 3)}.${Math.floor(r() * 12)}.${1 + Math.floor(r() * 254)}`);
      vms.push({ id: `vm-${i}`, name: `vm${i}`, vcenterId: vc, ipAddresses: ips, ipAddress: ips[0] || '', powerState: r() < 0.7 ? 'POWERED_ON' : 'POWERED_OFF', guestOS: 'CentOS 7 (64-bit)', host: `esx${i % 4}`, cluster: 'C1', notes: `n${i}\nsecond` });
    }
    return { generatedAt: `g2741k-${++gen}`, vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }], vms, hosts: [{ id: 'h-1', name: '10.1.3.9', vcenterId: 'vc1', powerState: 'POWERED_ON' }], datastores: [], networks: [], alarms: [] };
  };
  let compared = 0;
  for (let k = 1; k <= 6; k++) {
    const snap = mk(700 + k, 150 + k * 40);
    for (const vc of ['', 'vc1']) {
      for (const allowed of [null, new Set(['vc2'])]) {
        for (const onlyBase of ['', '10.1.3']) {
          const ledger = await led.buildIpamRowsShared(snap, vc, allowed);
          const stats = {};
          const a = await led.buildSubnetSheetsAsync(snap, { vcenterId: vc, onlyBase, allowed, ledger, cache: false, sliceMs: 1, stats });
          const fresh = { ...snap, generatedAt: `${snap.generatedAt}-ref` }; // 캐시와 무관하게 비교
          const b = led.buildSubnetSheets(fresh, { vcenterId: vc, onlyBase, allowed, cache: false });
          assert.ok(isDeepStrictEqual(a, b), `seed ${k} vc=${vc} scope=${allowed ? 'vc2' : 'all'} base=${onlyBase}`);
          assert.ok(Number.isFinite(stats.yields));
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 48);
  // 큰 입력에서는 실제로 양보한다(시트마다 yield 지점 — sliceMs 1)
  const big = mk(999, 6000);
  const stats = {};
  await led.buildSubnetSheetsAsync(big, { ledger: await led.buildIpamRowsShared(big, '', null), cache: false, sliceMs: 1, stats });
  assert.ok(stats.yields > 0, `양보 ${stats.yields}회`);
});

test('LEFT-01 ④ 실패 경로 — 띄우지 못한 워커는 인라인(같은 결과) · 준비 뒤 실패는 오류 · 답이 없으면 시한 · 끊기면 멈춤', { timeout: 240_000 }, async () => {
  const sheets = synthSheets(3);
  const created = 12345;
  const fakeDir = fs.mkdtempSync(path.join(tmp, 'fake-'));
  const write = (name, src) => { const p = path.join(fakeDir, name); fs.writeFileSync(p, src); return pathToFileURL(p); };
  const warn = console.warn; const warns = []; console.warn = (m) => warns.push(String(m));
  try {
    // (a) 모듈이 없는 워커 — 'ready' 전에 죽는다 → 인라인으로 같은 파일
    xl._setXlsxWorkerUrlForTest(pathToFileURL(path.join(fakeDir, 'missing.mjs')));
    const a = await xl.renderIpamWorkbook(sheets, { created });
    assert.equal(a.mode, 'inline'); assert.equal(a.reason, 'spawn-failed');
    const ref = await entriesOf(Buffer.from(await (await xl.buildWorkbook(sheets, { created })).xlsx.writeBuffer()));
    assert.ok(isDeepStrictEqual(await entriesOf(a.buffer), ref), '인라인 폴백도 같은 파일');
    assert.ok(warns.some((w) => w.includes('엑셀 워커를 띄우지 못했습니다')), '폴백 사실을 콘솔에 남긴다(조용한 폴백 금지)');
    // (b) 준비 뒤 오류 — 인라인으로 다시 하지 않고 오류로 끝난다
    xl._setXlsxWorkerUrlForTest(write('err.mjs', "import { parentPort } from 'node:worker_threads'; parentPort.on('message', (m) => { if (m.type === 'end') parentPort.postMessage({ type: 'error', message: 'boom' }); }); parentPort.postMessage({ type: 'ready' });"));
    await assert.rejects(xl.renderIpamWorkbook(sheets, { created }), (e) => e.code === 'worker-error' && /boom/.test(e.message));
    // (c) 준비 뒤 죽음
    xl._setXlsxWorkerUrlForTest(write('crash.mjs', "import { parentPort } from 'node:worker_threads'; parentPort.on('message', (m) => { if (m.type === 'end') process.exit(3); }); parentPort.postMessage({ type: 'ready' });"));
    await assert.rejects(xl.renderIpamWorkbook(sheets, { created }), (e) => e.code === 'worker-exit');
    // (d) 답하지 않음 — 시한
    xl._setXlsxWorkerUrlForTest(write('silent.mjs', "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {}); parentPort.postMessage({ type: 'ready' });"));
    const t0 = Date.now();
    await assert.rejects(xl.renderIpamWorkbook(sheets, { created, timeoutMs: 1200 }), (e) => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 6000, '시한 뒤 곧 끝난다');
    // (e) 받을 사람이 떠남(abort) — 곧바로 멈춘다
    const ac = new AbortController();
    const p = xl.renderIpamWorkbook(sheets, { created, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const t1 = Date.now();
    await assert.rejects(p, (e) => e.code === 'aborted');
    assert.ok(Date.now() - t1 < 3000);
  } finally {
    console.warn = warn;
    xl._setXlsxWorkerUrlForTest(null);
  }
  // (f) env 로 끄면 인라인
  process.env.IPAM_XLSX_WORKER = '0';
  try {
    const f = await xl.renderIpamWorkbook(sheets, { created });
    assert.equal(f.mode, 'inline'); assert.equal(f.reason, 'disabled');
  } finally { delete process.env.IPAM_XLSX_WORKER; }
});

/** 원장 /24 수 n 개짜리 큰 스냅샷(/24 마다 VM 127대). */
function bigSnap(n, tag) {
  const vms = [];
  let k = 0;
  for (let s = 0; s < n; s++) {
    for (let i = 1; i < 255; i += 2) {
      const ip = `10.${s >> 8}.${s & 255}.${i}`;
      vms.push({ id: `vm-${k}`, name: `vm${k++}.corp.local`, vcenterId: s % 2 ? 'vc1' : 'vc2', ipAddresses: [ip], ipAddress: ip, powerState: 'POWERED_ON', guestOS: 'Rocky Linux 9 (64-bit)', host: 'esx1', cluster: 'C1', notes: 'note line\nsecond' });
    }
  }
  return { source: 'vcenter', generatedAt: `big-${tag}`, vcenters: [{ id: 'vc1', name: 'SEOUL', status: 'connected' }, { id: 'vc2', name: 'TOKYO', status: 'connected' }], vms, hosts: [], datastores: [], networks: [], alarms: [] };
}

test('LEFT-01 ⑤ 실제 라우트 — /tools/ipam.xlsx 는 워커로 만들고 그동안 포탈이 멈추지 않는다 · 동시 1건 가드 유지 · 끊기면 가드를 푼다', { timeout: 240_000 }, async (t) => {
  await startApi();
  const N = 180;
  st.store.snapshot = bigSnap(N, 'r1');
  const probe = stallProbe();
  const t0 = performance.now();
  const first = fetch(`${baseUrl}/tools/ipam.xlsx`);
  await new Promise((r) => setTimeout(r, 250));
  const second = await fetch(`${baseUrl}/tools/ipam.xlsx`);
  const secondBody = await second.json().catch(() => ({}));
  const res = await first;
  const buf = Buffer.from(await res.arrayBuffer());
  const stall = probe.done();
  t.diagnostic(`/24 ${N}개 내보내기 ${Math.round(performance.now() - t0)}ms · 최장 정지 ${stall}ms · ${buf.length}B · 모드 ${res.headers.get('x-ipam-xlsx-mode')}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /spreadsheetml/);
  assert.equal(res.headers.get('x-ipam-xlsx-mode'), 'worker');
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
  const names = Object.keys((await JSZip.loadAsync(buf)).files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  assert.equal(names.length, N, '시트 수 = /24 수');
  assert.equal(second.status, 409, '진행 중 두 번째 요청은 409(동시 1건 가드)');
  assert.equal(secondBody.error, 'export_busy');
  assert.ok(stall < 1000, `내보내기 동안 최장 정지 ${stall}ms(예전: 시트 조립 + 직렬화가 수 초)`);
  // 시트 조립의 동기 정지(/24 180개 약 150~250ms)는 위 상한으로 가르기 어렵다 — 라우트가 양보판을 쓰는지는 소스로 본다(③ 이 결과 동일성·양보를 본다).
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/ipamExport.js', import.meta.url), 'utf8'));
  const i = src.indexOf("api.get('/tools/ipam.xlsx'");
  const body = src.slice(i, src.indexOf('api.get(', i + 10));
  assert.match(body, /await buildSubnetSheetsAsync\(/, '엑셀 라우트는 시트를 양보판으로 만든다');
  assert.match(body, /renderIpamWorkbook\(/, '엑셀 라우트는 워커 판으로 파일을 만든다');
  assert.doesNotMatch(body, /\bbuildSubnetSheets\(|\.xlsx\.write\(/, '엑셀 라우트에 동기 시트 조립·메인 스레드 직렬화가 남아 있다');

  // 받을 사람이 떠나면 워커를 끝내고 가드를 곧 푼다 — 끝까지 만들었다면(약 수 초) 그동안 다음 요청이 409 였다.
  st.store.snapshot = bigSnap(N, 'r2');
  const ac = new AbortController();
  const gone = fetch(`${baseUrl}/tools/ipam.xlsx`, { signal: ac.signal }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 900));
  ac.abort();
  await gone;
  st.store.snapshot = bigSnap(3, 'r3'); // 다음 요청은 작게(가드가 풀렸는지만 본다)
  const tAbort = performance.now();
  let next = null;
  while (performance.now() - tAbort < 2000) {
    await new Promise((r) => setTimeout(r, 100));
    next = await fetch(`${baseUrl}/tools/ipam.xlsx`);
    if (next.status !== 409) break;
    await next.arrayBuffer().catch(() => null);
  }
  t.diagnostic(`끊은 뒤 가드가 풀리기까지 약 ${Math.round(performance.now() - tAbort)}ms`);
  assert.equal(next.status, 200, '끊긴 요청이 2초 안에 가드를 풀지 않았다(워커를 끝내지 않고 끝까지 만들었다)');
  const small = Buffer.from(await next.arrayBuffer());
  assert.equal(Object.keys((await JSZip.loadAsync(small)).files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length, 3);
});
