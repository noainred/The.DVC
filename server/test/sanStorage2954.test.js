/**
 * test/sanStorage2954.test.js — v2.954 'SAN 스토리지 성능' 3차(남은 작업 일괄 · 설계 README §8.4).
 *  ① storageCheckHistory(순수): shouldRecord(첫 · 바뀜 · 1시간 · 같음) · lastChangeOf(1시간 반복 기록 뒤에서도 실제 변화를 찾는다)
 *  ② PowerMax 포트 파서(순수): FEPort keys(중복 · 상한) · metrics(포트 이름 IOs/MBs/ResponseTime · 디렉터 이름으로 와도 · 마지막 점)
 *  ③ CSV nodeLoad 칸: 아이실론 · REST 어레이 true|false · SSH 변형 빈칸 · 모르는 타입 빈칸
 *  ④ 데모: 어레이 측 hbps 자릿수 · 수식 데모(demoPerfSynth)의 이상치 창 — 해시로 고른 어레이만 · 지금 기준 최근 24시간 · KST 10~12시 ×2.4 · 이틀 전 · 창 밖은 1
 *  ⑤ 실제 라우트(mock · 인증 끔 · node:sqlite): /array ports[].wwn · /check 가 이력을 적는다 · /check/history(목록 · 어레이별 · 전이 worse) · 알림 틱 → alerts.notify → 가짜 SMTP 메일 · 월간 보고서 '지금 보내기' → SMTP 메일 + HTML 첨부 파일명
 *  ⑥ edgelog spec — 알림 · 보고서 상태가 모두 등재되고 인자 없이 불린다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanstorage2954-'));
process.env.CONFIG_DIR = tmp;
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
process.env.SANSTORAGE_CHECK_DB_PATH = path.join(tmp, 'san-storage-check.db');
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000; const HOUR = 3_600_000; const DAY = 24 * HOUR;
const T0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR - 30 * MIN;   // 순수 시험용 고정 시각(정시 −30분)
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

/* ── 가짜 SMTP(audit2742g 방식) — DATA 본문을 모아 첨부 파일명 · 제목을 확인한다 ── */
const smtp = { mails: 0, bodies: [] };
const srv = net.createServer((s) => {
  s.on('error', () => {});
  s.write('220 fake ESMTP\r\n');
  let buf = ''; let inData = false; let body = '';
  s.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; smtp.mails += 1; smtp.bodies.push(body); body = ''; s.write('250 queued\r\n'); } else body += `${line}\n`;
        continue;
      }
      if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH/i.test(line)) s.write('235 2.7.0 ok\r\n');
      else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
      else s.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
fs.writeFileSync(path.join(tmp, 'mail.json'), JSON.stringify({
  enabled: true, smtp: { host: '127.0.0.1', port: PORT, secure: false, startTls: false, user: 'svc', password: 'pw', from: 'portal@x.local', timeoutMs: 5000 },
  defaultTo: ['ops@x.local'], rateLimitPerHour: 0,
  kinds: { alert: { enabled: true, to: ['ops@x.local'], cc: [] }, 'san-storage-report': { enabled: true, to: ['ops@x.local'], cc: [] } },
}));
fs.writeFileSync(path.join(tmp, 'alerts.json'), JSON.stringify({ channels: { email: { enabled: true } }, cooldownMin: 0, intervalSec: 60, suppressWindowMin: 0 }));

const waitMails = async (n, maxMs = 8000) => {
  const alerts = await import('../src/alerts.js');
  const t0 = Date.now();
  while (smtp.mails < n && Date.now() - t0 < maxMs) { await alerts._drainNotifyQueueForTest?.(); await new Promise((r) => setTimeout(r, 30)); }
  return smtp.mails;
};

let H; let AP; let CSV; let DS;
before(async () => {
  H = await import('../src/sanswitch/storageCheckHistory.js');
  AP = await import('../src/storage/collectors/arrayPerf.js');
  CSV = await import('../src/storage/csv.js');
  DS = await import('../src/mock/demo/storage.js');
});
after(() => { try { srv.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const items = (imb, sat = 'ok') => [{ key: 'imbalance', label: '디렉터 편중', status: imb, detail: '' }, { key: 'portSat', label: '회선 포화', status: sat, detail: '' }];

test('① 이력 규칙(순수) — 첫 · 바뀜 · 1시간 · 같음 · 마지막 실제 변화', () => {
  const cur = { at: T0, overall: 'ok', items: items('ok') };
  assert.deepEqual(H.shouldRecord(null, cur), { save: true, why: 'first' });
  assert.deepEqual(H.shouldRecord({ at: T0 - 5 * MIN, overall: 'ok', items: JSON.stringify(items('ok')) }, cur), { save: false, why: 'same' });
  assert.deepEqual(H.shouldRecord({ at: T0 - 61 * MIN, overall: 'ok', items: items('ok') }, cur), { save: true, why: 'gap' });
  assert.deepEqual(H.shouldRecord({ at: T0 - 5 * MIN, overall: 'warn', items: items('warn') }, cur), { save: true, why: 'changed' });
  assert.equal(H.MIN_GAP_MS, HOUR); assert.ok(H.MAX_RUNS >= 10);
  // 최신부터: [warn(gap 반복), warn(바뀜), ok, ok] — 마지막 두 건은 같아 compareRuns 는 변화 0 이지만 lastChangeOf 는 ok→warn 을 찾는다
  const run = (at, o, it) => ({ at, overall: o, items: it, counts: { ok: 0, warn: 0, bad: 0, unknown: 0 } });
  const runs = [run(T0, 'warn', items('warn')), run(T0 - HOUR, 'warn', items('warn')), run(T0 - 2 * HOUR, 'ok', items('ok')), run(T0 - 3 * HOUR, 'ok', items('ok'))];
  const lc = H.lastChangeOf(runs, 0);
  assert.equal(lc.at, T0 - HOUR); assert.deepEqual(lc.changes.map((c) => [c.key, c.from, c.to, c.dir]), [['imbalance', 'ok', 'warn', 'worse']]);
  assert.equal(H.lastChangeOf(runs, T0 - 30 * MIN), null, 'since 이전의 변화는 세지 않는다');
  assert.equal(H.lastChangeOf([runs[0]], 0), null);
  assert.deepEqual(H.slimCheckItems({ imbalance: { status: 'warn', text: 'x'.repeat(300) } })[0].detail.length, 200);
});

test('② PowerMax 포트 파서(순수) — keys 중복 · 상한 · metrics 이름 두 벌 · 마지막 점', () => {
  const keys = AP.parsePmaxPortKeys({ fePortInfo: [{ portId: '4' }, { portId: '4' }, { portId: '5' }, { portId: 6 }, { portId: '7' }, { portId: '8' }] });
  assert.deepEqual(keys, ['4', '5', '6', '7'], '중복 제거 · 디렉터당 4');
  assert.deepEqual(AP.parsePmaxPortKeys({ fePortInfo: [{ portId: '4' }, { portId: '5' }] }, { max: 1 }), ['4']);
  assert.deepEqual(AP.parsePmaxPortKeys(null), []);
  const m = AP.parsePmaxPortMetrics({ resultList: { result: [{ timestamp: 1, PercentBusy: 10, IOs: 100, MBs: 50, ResponseTime: 0.8 }, { timestamp: 2, PercentBusy: 20, IOs: 200, MBs: 60, ResponseTime: 1.2 }] } });
  assert.deepEqual([m.ts, m.busy, m.iops, m.hbps, m.lat, m.queue], [2, 20, 200, 60e6, 1.2, null]);
  const m2 = AP.parsePmaxPortMetrics({ resultList: { result: [{ timestamp: 3, PercentBusy: 120, HostIOs: 5, HostMBs: 1, ReadResponseTime: 0.5, WriteResponseTime: 0.9 }] } });
  assert.deepEqual([m2.busy, m2.iops, m2.hbps, m2.lat], [null, 5, 1e6, 0.9], '100 초과 % 는 null · 디렉터 이름(HostIOs · HostMBs)도 읽는다 · 응답 시간은 읽기/쓰기 중 큰 값');
  assert.equal(AP.parsePmaxPortMetrics({ resultList: { result: [] } }), null);
  assert.equal(AP.PMAX_PORTS_PER_DIR, 4); assert.equal(AP.PMAX_PORT_CALLS_MAX, 24);
  assert.deepEqual([...AP.PMAX_FE_PORT_METRICS], ['PercentBusy', 'IOs', 'MBs', 'ResponseTime']);
});

test('③ CSV nodeLoad 칸 — 표본을 낼 수 있는 장비만', () => {
  assert.equal(CSV.exportedNodeLoad({ type: 'isilon' }), 'true'); assert.equal(CSV.exportedNodeLoad({ type: 'isilon', nodeLoadEnabled: false }), 'false');
  assert.equal(CSV.exportedNodeLoad({ type: 'unity480' }), 'true', 'REST 기본');
  assert.equal(CSV.exportedNodeLoad({ type: 'powerstore', collectMethod: 'api', nodeLoadEnabled: false }), 'false');
  assert.equal(CSV.exportedNodeLoad({ type: 'powermax' }), 'true'); assert.equal(CSV.exportedNodeLoad({ type: 'vmax' }), 'true');
  assert.equal(CSV.exportedNodeLoad({ type: 'unity480', collectMethod: 'ssh' }), '', 'SSH 변형은 성능 경로가 없다 — 빈칸');
  assert.equal(CSV.exportedNodeLoad({ type: 'netapp' }), ''); assert.equal(CSV.exportedNodeLoad(null), '');
  assert.match(CSV.devicesToCsv([{ type: 'unity480', name: 'U', host: '10.0.0.9', username: 'u' }]), /,true,/);
});

test('④ 데모 — 어레이 측 hbps 자릿수 · 이상치 창(수식 데모 · 최근 24시간 KST 10~12시 ×2.4)', async () => {
  const smp = DS.demoArrayPerfSample({ type: 'powermax', k: 'demo-pmax' }, T0);
  const parents = (smp?.nodes || smp?.units || []).filter((u) => u.kind !== 'port');
  assert.ok(parents.length >= 2, JSON.stringify(smp).slice(0, 200));
  const hb = smp.nodes ? smp.nodes.filter((n) => n.kind !== 'port').map((n) => n.hbps ?? n.hostBytesPs) : [];
  for (const v of hb) assert.ok(v >= 110e6 && v <= 1e9, `hbps ${v}`);
  // 수식 데모(demoPerfSynth)의 이상치 창 — 해시로 고른 어레이(약 12%)만 · 지금 기준 최근 24시간 · KST 10~12시 ×2.4 · 그 밖은 1
  const SY = await import('../src/sanswitch/demoPerfSynth.js');
  const kst11 = (() => { const now = Date.now(); const d = new Date(now + 9 * HOUR); d.setUTCHours(11, 0, 0, 0); let t = d.getTime() - 9 * HOUR; if (t > now) t -= DAY; return t; })();
  const names = Array.from({ length: 400 }, (_, i) => `SYMMETRIX::0001979${String(i).padStart(5, '0')}::FA-1D 4`);
  const picked = names.filter((n) => SY.demoAnomalyFactor(n, kst11) === 2.4);
  assert.ok(picked.length >= 20 && picked.length <= 80, `고른 비율 약 12% — ${picked.length}/400`);
  const one = picked[0]; const other = names.find((n) => SY.demoAnomalyFactor(n, kst11) === 1);
  assert.equal(SY.demoAnomalyFactor(one, kst11 - 2 * DAY), 1, '이틀 전(기준선 쪽)은 없다');
  assert.equal(SY.demoAnomalyFactor(one, kst11 - 3 * HOUR), 1, 'KST 08시는 창 밖');
  assert.equal(SY.demoAnomalyFactor(`${one.split('::').slice(0, 2).join('::')}::FA-2D 5`, kst11), 2.4, '같은 어레이의 다른 포트도 같이(어레이 단위 키)');
  assert.equal(SY.demoAnomalyKey('PowerStore::PSAC4ACA8F::NodeA FC0'), 'PowerStore::PSAC4ACA8F'); assert.equal(SY.demoAnomalyKey('flat-name'), 'flat-name');
  assert.ok(other, '고르지 않은 어레이도 있다');
});

test('⑤ 실제 라우트 — wwn · 이력 · 전이 · 알림 메일 · 보고서 메일', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/sanswitch/registry.js');
  const { SAN_SWITCH_TYPES } = await import('../src/sanswitch/types.js');
  const { importSamples, invalidatePerfQueries } = await import('../src/sanswitch/perfDb.js');
  const NS = await import('../src/sanswitch/storagePerfNotifyStore.js');
  NS._resetNotifyForTest?.();
  const swType = SAN_SWITCH_TYPES.find((x) => x.implemented)?.type || SAN_SWITCH_TYPES[0].type;
  reg.saveDevice({ type: swType, name: 'SW-YA', host: '10.72.30.1', username: 'u', password: 'p', datacenterId: 'dcY' });
  reg.saveDevice({ type: swType, name: 'SW-YB', host: '10.72.30.2', username: 'u', password: 'p', datacenterId: 'dcY' });
  const devA = reg.listDevices().find((d) => d.name === 'SW-YA'); const devB = reg.listDevices().find((d) => d.name === 'SW-YB');
  const now = Date.now();
  const nm = (dir, p) => `SYMMETRIX::000197954954::${dir} ${p}::FC::5978`;
  const meta = [
    { d: devA.id, p: 1, ts: now, name: nm('FA-1D', 4), wwn: '50:00:09:73:00:00:54:01', speed: '32G', type: 'F' }, { d: devB.id, p: 1, ts: now, name: nm('FA-1D', 5), wwn: '50:00:09:73:00:00:54:02', speed: '32G', type: 'F' },
    { d: devA.id, p: 2, ts: now, name: nm('FA-2D', 4), wwn: '50:00:09:73:00:00:54:03', speed: '32G', type: 'F' }, { d: devB.id, p: 2, ts: now, name: nm('FA-2D', 5), wwn: '50:00:09:73:00:00:54:04', speed: '32G', type: 'F' },
  ];
  const rows = [];
  for (let k = 8 * 24; k >= 1; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * HOUR, p: m.p, b: 100e6 });
  for (let k = 60; k >= 0; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * MIN, p: m.p, b: 100e6 });
  await importSamples(rows, meta, 90);
  invalidatePerfQueries();
  const app = express(); app.use(express.json()); app.use('/api', api);
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}/api`;
  const get = async (p) => { const r = await fetch(base + p); return { s: r.status, j: await r.json().catch(() => null) }; };
  const send = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { s: r.status, j: await r.json().catch(() => null) }; };
  const S = await import('../src/sanswitch/storageCheckSettings.js');
  try {
    const key = encodeURIComponent('SYMMETRIX::000197954954');
    const a = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcY&hours=24`);
    assert.equal(a.s, 200, JSON.stringify(a.j).slice(0, 200));
    assert.ok(a.j.ports.length >= 4 && a.j.ports.every((p) => /^50:00:09:73/.test(p.wwn)), 'ports[].wwn(Flow Vision 타깃 인계용)');
    // 임의 구간(from/to) 도 같은 라우트
    const c = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcY&from=${now - 3 * HOUR}&to=${now}`);
    assert.equal(c.s, 200); assert.ok(c.j.buckets.length >= 1);
    // 7일 히트맵용 1시간 칸(points 168) — 기준선이 붙는다 · points 없이 168시간이면 2시간 칸이라 'bucket'
    const w1 = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcY&hours=168&points=168`);
    assert.equal(w1.j.bucketMs, HOUR, JSON.stringify([w1.j.bucketMs, w1.j.buckets?.length])); assert.equal(w1.j.baseline.applicable, true, JSON.stringify(w1.j.baseline).slice(0, 160));
    const w2 = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcY&hours=168`);
    assert.ok(w2.j.bucketMs > HOUR && w2.j.baseline.reason === 'bucket', '칸 수를 주지 않으면 예전처럼 2시간 칸 · 기준선 없음(화면은 points 를 준다)');
    assert.equal((await get(`/tools/san-storage/array?key=${key}&datacenterId=dcY&hours=24&points=999999`)).j.buckets.length <= 2000, true, 'points 상한 2000');
    // 이력 — /check 가 적는다(첫 기록)
    const k1 = await get('/tools/san-storage/check?datacenterId=dcY');
    assert.equal(k1.s, 200); assert.equal(k1.j.history?.available, true, JSON.stringify(k1.j.history)); assert.ok(k1.j.history.saved >= 1);
    const k2 = await get('/tools/san-storage/check?datacenterId=dcY');
    assert.equal(k2.j.history.saved, 0, '같은 판정 5분 안 — 다시 적지 않는다'); assert.ok(k2.j.history.skipped >= 1);
    const ov = await get('/tools/san-storage/check/history');
    assert.equal(ov.s, 200); assert.equal(ov.j.available, true); assert.ok(ov.j.arrays.some((x) => x.key === 'SYMMETRIX::000197954954' && x.dc === 'dcY'), JSON.stringify(ov.j.arrays).slice(0, 200));
    assert.equal(ov.j.changes.length, 0, '첫 기록뿐이면 변화 없음');
    // 전이 — 회선 포화 주의 기준을 1% 로(100 MB/s / 4 GB/s = 2.5% ≥ 1 → warn)
    const r0 = S.saveCheckSettings({ portSatWarnPct: 1 }, { by: 't' }); assert.ok(!r0.issue, r0.issue);
    const k3 = await get('/tools/san-storage/check?datacenterId=dcY');
    assert.equal(k3.j.results[0].items.portSat.status, 'warn', JSON.stringify(k3.j.results[0].items.portSat)); assert.ok(k3.j.history.saved >= 1, '판정이 바뀌면 바로 적는다');
    const ov2 = await get('/tools/san-storage/check/history?days=7');
    const ch = ov2.j.changes.find((x) => x.arrayKey === 'SYMMETRIX::000197954954' && x.item === 'portSat');
    assert.ok(ch, JSON.stringify(ov2.j.changes).slice(0, 300)); assert.deepEqual([ch.from, ch.to, ch.dir, ch.dc], ['ok', 'warn', 'worse', 'dcY']);
    const one = await get(`/tools/san-storage/check/history?key=${key}&datacenterId=dcY&limit=10`);
    assert.equal(one.j.available, true); assert.ok(one.j.runs.length >= 2); assert.equal(one.j.compare.compared, one.j.runs.length); assert.equal(one.j.lastChange?.changes?.[0]?.to, 'warn');
    // 알림 — 첫 실행은 기준 · 다음 전이(이상)에서 alerts.notify → 이메일 채널 → 가짜 SMTP
    assert.equal((await send('PUT', '/tools/san-storage/notify-settings', { enabled: true, minLevel: 'warn', recoveries: true })).s, 200);
    const n1 = await send('POST', '/tools/san-storage/notify/run-now', {}); assert.equal(n1.j.action, 'baseline', JSON.stringify(n1.j).slice(0, 200));
    assert.equal(n1.j.history?.available, true, '틱도 이력을 적는다(알림 설정과 무관)');
    const r1 = S.saveCheckSettings({ portSatWarnPct: 1, portSatBadPct: 2 }, { by: 't' }); assert.ok(!r1.issue, r1.issue);
    const before = smtp.mails;
    const n2 = await send('POST', '/tools/san-storage/notify/run-now', {});
    assert.equal(n2.j.action, 'sent', JSON.stringify(n2.j).slice(0, 300)); assert.ok(n2.j.alerts >= 1);
    assert.ok(await waitMails(before + 1) >= before + 1, '알림이 실제 SMTP 로 나갔다(이메일 채널)');
    assert.match(smtp.bodies[smtp.bodies.length - 1], /SAN 스토리지 성능|san-storage|=\?utf-8\?/i);
    // 월간 보고서 — 지금 보내기 → SMTP + HTML 첨부 파일명
    assert.equal((await send('PUT', '/tools/san-storage/report-settings', { enabled: true, dayOfMonth: 1, time: '09:00', to: 'ops@x.local' })).s, 200);
    const b2 = smtp.mails;
    const sn = await send('POST', '/tools/san-storage/report/send-now', {});
    assert.equal(sn.s, 200, JSON.stringify(sn.j).slice(0, 300)); assert.equal(sn.j.ok, true);
    assert.ok(await waitMails(b2 + 1) >= b2 + 1, '보고서 메일이 실제 SMTP 로 나갔다');
    const body = smtp.bodies[smtp.bodies.length - 1];
    assert.match(body, /san-storage-report_\d{4}-\d{2}\.html/, '첨부 파일명(HTML)'); assert.match(body, /text\/html/);
    const rp = await get('/tools/san-storage/report');
    assert.equal(rp.j.history[0].kind, 'manual'); assert.equal(rp.j.history[0].state, 'sent');
  } finally {
    S.saveCheckSettings({ portSatWarnPct: '', portSatBadPct: '' }, { by: 't' });
    await new Promise((r) => s.close(r));
  }
});

test('⑥ edgelog spec — 알림 · 보고서 상태가 등재되고 인자 없이 불린다', async () => {
  const spec = await import('../src/edgelog/spec.js');
  const list = Object.values(spec).find((v) => Array.isArray(v) && v.some((e) => e && e.fn));
  const n = list.find((e) => e.key === 'service.sanStorageNotify'); const r = list.find((e) => e.key === 'service.sanStorageReport');
  assert.ok(n && r, 'spec 항목 둘');
  const mod = await import('../src/sanswitch/storagePerfReportMail.js');
  const st = mod[r.fn]();
  assert.equal(typeof st, 'object'); assert.ok('nextSlot' in st || 'enabled' in st || 'lastTick' in st, JSON.stringify(st).slice(0, 200));
});
