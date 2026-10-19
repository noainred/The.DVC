/**
 * v2.743 감사 GL 회귀 — DEV-01 · DEV-03 · DB-01 · DB-02.
 *
 *  DEV-01 svcmon LDAP 점검이 BindResponse 의 resultCode 를 '0x61 위치 + 4' 고정 오프셋으로 읽었다. 그것은 BER 길이가 **단형일 때만**
 *         맞다 — AD 처럼 장형(0x84 + 4바이트)으로 보내면 그 자리는 길이 셋째 바이트(늘 0x00)라 resultCode 53 같은 실패가
 *         'bind 성공 (resultCode 0)' 으로 보고됐다. 실제 runCheck 를 가짜 LDAP 서버(단형·장형·조각·잘림)에 붙여 고정한다.
 *  DEV-03 FC HBA 사용률 분모가 명목 Gbit(16 Gbit = 16e9 bit/s)라, 표준 데이터율(16GFC 1,600MB/s)로 포화해도 80% 에서 멈췄다.
 *         속도별 표준 데이터율 표로 분모를 바꾸고, 표에 없는 속도는 예전 명목 계산 + 사유 표지. 이더넷 NIC 는 그대로.
 *  DB-01  스토리지 전체 합계 용량 추이(capacityHistoryAll)가 기간 전체를 GROUP BY 한 문장으로 동기 실행했다 — 버킷 정배수 시간
 *         조각 + 시간 기준 양보로 나누고, 결과가 예전 한 문장 판과 같음을 실제 SQLite 로 대조한다.
 *  DB-02  /overview/trend 가 화면이 더 쓰지 않는 서버 전력 추이(fleetHourSums)를 매번 계산했다 — ?include=power 일 때만.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743l-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_WORKER = '0';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

// ───────────────────────────── DEV-01 LDAP ─────────────────────────────

// ⚠ 동적 import 는 전부 첫 test() 등록 **앞에** 둔다 — test 를 등록한 뒤 top-level await 가 남아 있으면 이름 필터 실행에서
//   루트 after(임시 폴더 삭제)가 먼저 돌아 뒤 테스트의 DB 가 열리지 않는다(이 파일 초판에서 실제로 그랬다).
const { runCheck } = await import('../src/svcmon/checker.js');
const { buildUsage } = await import('../src/bmusage/usage.js');
const { fcUtilization, fcDataBytesPerSec, FC_DATA_RATE_MBPS } = await import('../src/bmusage/parse/fcRate.js');
const { parseFcHosts } = await import('../src/bmusage/parse/linuxProc.js');
const sdb = await import('../src/storage/db.js');
const { config } = await import('../src/config.js');
const { DatabaseSync } = await import('node:sqlite');

/** 가짜 LDAP 서버 — 요청을 받으면 chunks 를 차례로 보낸다(간격 gapMs). closeAfter 면 다 보낸 뒤 끊는다. */
function ldapServer(chunks, { gapMs = 15, closeAfter = false } = {}) {
  return new Promise((resolve) => {
    const s = net.createServer((c) => {
      c.on('error', () => {});
      c.once('data', async () => {
        for (const ch of chunks) {
          if (c.destroyed) return;
          c.write(ch);
          await new Promise((r) => setTimeout(r, gapMs));
        }
        if (closeAfter && !c.destroyed) c.end();
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const closeSrv = (s) => new Promise((r) => s.close(() => r()));
async function ldapCheck(chunks, opts) {
  const s = await ldapServer(chunks, opts);
  try { return await runCheck({ type: 'ldap', port: s.address().port }, '127.0.0.1'); }
  finally { await closeSrv(s); }
}

// 단형(1바이트 길이) BindResponse — resultCode rc
const shortForm = (rc) => Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x61, 0x07, 0x0a, 0x01, rc, 0x04, 0x00, 0x04, 0x00]);
// AD 식 장형(0x84 + 4바이트) — 같은 내용
const longForm = (rc) => Buffer.from([0x30, 0x84, 0, 0, 0, 0x10, 0x02, 0x01, 0x01, 0x61, 0x84, 0, 0, 0, 0x07, 0x0a, 0x01, rc, 0x04, 0x00, 0x04, 0x00]);
// AD 가 실제로 내는 모양 — 진단 메시지가 길어 BindResponse 길이가 단형(127) 범위를 넘는다(0x81 장형) + 오류 문구
function adDiagForm(rc) {
  const diag = Buffer.from('80090308: LdapErr: DSID-0C09041C, comment: AcceptSecurityContext error, data 52e, v4563'.padEnd(140, ' '));
  const inner = Buffer.concat([Buffer.from([0x0a, 0x01, rc, 0x04, 0x00, 0x04, 0x81, diag.length]), diag]);
  const op = Buffer.concat([Buffer.from([0x61, 0x81, inner.length]), inner]);
  const body = Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), op]);
  return Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
}

test('DEV-01 ① 단형 길이 응답 — 성공(0)·정책 거부(53)·실패(1) 판정', async () => {
  const ok0 = await ldapCheck([shortForm(0)]);
  assert.equal(ok0.status, 'ok', JSON.stringify(ok0));
  assert.match(ok0.reply, /resultCode 0/);
  // v2.744(감사 RECENT-04): 53(unwillingToPerform — 익명 bind 금지 정책)은 정책 거부 응답 — 서버는 살아 있다.
  const pol53 = await ldapCheck([shortForm(53)]);
  assert.equal(pol53.status, 'ok', JSON.stringify(pol53));
  assert.match(pol53.reply, /bind 거부\(정책\).*resultCode 53/);
  // 그 밖의 코드(예: 1 operationsError)는 실패다.
  const bad1 = await ldapCheck([shortForm(1)]);
  assert.equal(bad1.status, 'bad', JSON.stringify(bad1));
  assert.match(bad1.reply, /bind 실패 \(resultCode 1\)/);
});

test('DEV-01 ② AD 식 장형 길이(0x84) 응답의 resultCode 를 정확히 읽는다(예전: 길이 바이트 0x00 → "성공 0")', async () => {
  // v2.744(감사 RECENT-04): 53 은 정책 거부(살아 있음)로 판정이 바뀌었다 — 장형 해석 검증은 실패 코드 52 로 한다.
  const r = await ldapCheck([longForm(52)]);
  assert.equal(r.status, 'bad', JSON.stringify(r));
  assert.match(r.reply, /resultCode 52/);
  assert.doesNotMatch(r.reply, /resultCode 0\b/);
  const pol = await ldapCheck([longForm(53)]);
  assert.equal(pol.status, 'ok', JSON.stringify(pol));
  assert.match(pol.reply, /bind 거부\(정책\).*resultCode 53/);
  assert.doesNotMatch(pol.reply, /resultCode 0\b/);
  const ok = await ldapCheck([longForm(0)]);
  assert.equal(ok.status, 'ok', JSON.stringify(ok));
  const inv = await ldapCheck([longForm(49)]);           // 49(invalidCredentials)는 원래 설계대로 '살아있음'
  assert.equal(inv.status, 'ok', JSON.stringify(inv));
  assert.match(inv.reply, /resultCode 49/);
});

test('DEV-01 ③ 진단 메시지가 긴 AD 응답(0x81 장형 + 140자 오류 문구)도 resultCode 를 정확히 읽는다', async () => {
  // v2.744(감사 RECENT-04): 8(strongerAuthRequired — 서명 필수 DC 의 익명 simple bind 거부)은 서버가 BindResponse 로 정책 거부를
  //   돌려준 것이라 liveness 점검에서는 '살아 있음' 이다(48·49 와 같은 성격). 문구가 거부 사실과 코드를 함께 말한다.
  const r = await ldapCheck([adDiagForm(8)]);              // 8 = strongerAuthRequired
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(r.reply, /bind 거부\(정책\) — 서버는 응답 중 \(resultCode 8\)/);
  // 51(busy)·52(unavailable)는 서버가 요청을 처리하지 못하는 상태 — 실패다.
  for (const rc of [51, 52]) {
    const b = await ldapCheck([adDiagForm(rc)]);
    assert.equal(b.status, 'bad', JSON.stringify(b));
    assert.match(b.reply, new RegExp(`bind 실패 \\(resultCode ${rc}\\)`));
  }
});

test('DEV-01 ④ 응답이 여러 조각으로 와도 끝까지 모아 판정한다', async () => {
  const whole = adDiagForm(52);                             // v2.744: 53 은 정책 거부(살아 있음)라 실패 코드 52 로 본다
  const r = await ldapCheck([whole.subarray(0, 3), whole.subarray(3, 12), whole.subarray(12)], { gapMs: 30 });
  assert.equal(r.status, 'bad', JSON.stringify(r));
  assert.match(r.reply, /resultCode 52/);
  const ok = longForm(0);
  const r2 = await ldapCheck([ok.subarray(0, 4), ok.subarray(4)], { gapMs: 30 });
  assert.equal(r2.status, 'ok', JSON.stringify(r2));
});

test('DEV-01 ⑤ 잘린 응답(길이만큼 오기 전에 끊김)은 실패이고 성공으로 보지 않는다', async () => {
  const whole = longForm(0);
  const r = await ldapCheck([whole.subarray(0, 14)], { closeAfter: true });
  assert.equal(r.status, 'bad', JSON.stringify(r));
  assert.match(r.reply, /잘렸/);
  // 0x61 없이 다른 연산(SearchResultDone 0x65)만 오면 bind 응답이 아니다
  const other = Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x65, 0x07, 0x0a, 0x01, 0x00, 0x04, 0x00, 0x04, 0x00]);
  const r2 = await ldapCheck([other]);
  assert.equal(r2.status, 'bad', JSON.stringify(r2));
});

test('DEV-01 ⑥ 연결 종료 통지(ExtendedResponse 0x78)는 bind 성공이 아니다', async () => {
  const notice = Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x00, 0x78, 0x07, 0x0a, 0x01, 52, 0x04, 0x00, 0x04, 0x00]);
  const r = await ldapCheck([notice]);
  assert.equal(r.status, 'bad', JSON.stringify(r));
  assert.match(r.reply, /resultCode 52/);
});

// ───────────────────────────── DEV-03 FC HBA 분모 ─────────────────────────────


const TGB = { key: 'GL1', name: 'bm-gl', vcenterId: 'vc1' };
/** Linux 두 주기 — 1초 동안 HBA 가 방향마다 bytesPerSec 를 싣는다. 이더넷 NIC 도 같이 둔다. */
function twoCycles({ fcSpeedRaw = '16 Gbit', fcBps = 1.6e9, nicBps = 1.25e9, nicBits = 10e9 } = {}) {
  const fc1 = parseFcHosts([`host5|Online|${fcSpeedRaw}|0|0`])[0];
  const fc2 = parseFcHosts([`host5|Online|${fcSpeedRaw}|${Math.round(fcBps / 4)}|${Math.round(fcBps / 4)}`])[0];
  const C1 = { cpu: { total: 1_000, idle: 900 }, disks: [], nets: [{ iface: 'eth0', rxBytes: 0, txBytes: 0, bitsPerSec: nicBits, state: 'up' }], hbas: [fc1] };
  const C2 = { cpu: { total: 2_000, idle: 1_700 }, disks: [], nets: [{ iface: 'eth0', rxBytes: nicBps, txBytes: nicBps, bitsPerSec: nicBits, state: 'up' }], hbas: [fc2] };
  const os = (c) => ({ ok: true, osKind: 'linux', counters: c, mem: { usedPct: 10 }, mounts: [], read: [], missing: [], absent: [] });
  const a = buildUsage({ target: TGB, os: os(C1), prev: null, now: 1_000 });
  return buildUsage({ target: TGB, os: os(C2), prev: a.next, now: 2_000 });
}

test('DEV-03 ① 16GFC 가 표준 데이터율(1,600MB/s)로 포화하면 HBA 사용률은 100%(예전: 명목 16Gbit 분모라 80%)', () => {
  const b = twoCycles({ fcBps: 1.6e9 });
  assert.equal(b.row.hba_pct, 100, JSON.stringify(b.detail.fc));
  assert.equal(b.detail.fc[0].pctBasis, 'fc-data-rate');
  // 기본 알림 임계(90%)에 닿는 부하 — 1,450MB/s 는 90.6%(예전 72.5%)
  const c = twoCycles({ fcBps: 1.45e9 });
  assert.ok(c.row.hba_pct >= 90, String(c.row.hba_pct));
});

test('DEV-03 ② 표의 모든 등급이 포화 = 100% · 표에 없는 속도(10 Gbit)는 명목 계산 + 사유 표지', () => {
  for (const [g, mb] of Object.entries(FC_DATA_RATE_MBPS)) {
    assert.equal(fcDataBytesPerSec(Number(g) * 1e9), mb * 1e6, g);
    const u = fcUtilization(mb * 1e6, Number(g) * 1e9);
    assert.equal(u.pct, 100, g); assert.equal(u.basis, 'fc-data-rate', g);
  }
  const u10 = fcUtilization(1e9, 10e9);                // 10 Gbit(표에 없음) — 예전 명목: 1e9×8 / 10e9 = 80%
  assert.equal(u10.basis, 'nominal'); assert.equal(u10.pct, 80);
  const b = twoCycles({ fcSpeedRaw: '10 Gbit', fcBps: 1e9 });
  assert.equal(b.row.hba_pct, 80);
  assert.equal(b.detail.fc[0].pctBasis, 'nominal');
  assert.ok(b.notes.some((x) => x.includes('명목 속도')), JSON.stringify(b.notes));
  // 속도를 모르면 사용률을 내지 않는다(지어내지 않는다)
  const unk = fcUtilization(1e9, null);
  assert.equal(unk.pct, null); assert.equal(unk.basis, null); assert.equal(unk.over, false);
});

// v2.744 RECENT-02: 데이터율을 조금(≤110%) 넘는 값은 측정 정의 차이(프레임 헤더)라 100% + 표지, 크게 넘으면 비우고 hba_over 로 알린다.
test('DEV-03 ③ 데이터율을 넘는 처리량 — 조금 넘으면 100% + 표지, 크게 넘으면 null + hba_over(처리량은 그대로)', () => {
  const b = twoCycles({ fcBps: 1.7e9 });   // 106%
  assert.equal(b.row.hba_pct, 100);
  assert.equal(b.detail.fc[0].pctOver, true);
  assert.equal(b.detail.fc[0].pctClamped, true);
  assert.ok(b.row.hba_bps > 0);
  const c = twoCycles({ fcBps: 2.0e9 });   // 125%
  assert.equal(c.row.hba_pct, null);
  assert.equal(c.row.hba_over, true);
  assert.ok(c.row.hba_bps > 0);
  assert.ok(c.notes.some((x) => x.includes('크게')), JSON.stringify(c.notes));
});

test('DEV-03 ④ 이더넷 NIC 는 바꾸지 않는다(링크 속도 그대로 — 10Gb 에서 1.25GB/s = 100%)', () => {
  const b = twoCycles({ nicBps: 1.25e9, nicBits: 10e9 });
  assert.equal(b.row.net_pct, 100);
  const h = twoCycles({ nicBps: 0.625e9, nicBits: 10e9 });
  assert.equal(h.row.net_pct, 50);
});

test('DEV-03 ⑤ iDRAC FC 카운터도 같은 분모 — 16Gbit 에서 방향당 1,600MB/s 는 100%', () => {
  const mk = (rx, tx) => ({ ok: true, full: true, cpuPct: 10, memPct: 20, nics: [],
    fcs: [{ host: 'FC.1', rxBytes: rx, txBytes: tx, bitsPerSec: 16e9 }], disks: [], read: ['cpumem', 'hba'], absent: [], usedReports: [], seenReports: [] });
  const a = buildUsage({ target: TGB, idrac: mk(0, 0), prev: null, now: 1_000 });
  const b = buildUsage({ target: TGB, idrac: mk(1.6e9, 0.4e9), prev: a.next, now: 2_000 });
  assert.equal(b.row.hba_pct, 100);
  assert.equal(b.srcOf.hba, 'idrac');
  assert.equal(b.detail.idracFc[0].pctBasis, 'fc-data-rate');
});

test('DEV-03 ⑥ 화면 상세 문구 — 사용률 0% 는 "속도 못 읽음" 이 아니고, 데이터율 초과는 따로 말한다', async () => {
  const { detailNotes } = await import('../../web/src/views/tools/bmUsageText.js');
  const idle = detailNotes({ fc: [{ host: 'h1', bps: 0, pct: 0, pctBasis: 'fc-data-rate' }] });
  assert.ok(!idle.some((x) => x.includes('속도를 읽지 못한 FC')), JSON.stringify(idle));
  const over = detailNotes({ fc: [{ host: 'h1', bps: 3.4e9, pct: null, pctBasis: 'fc-data-rate', pctOver: true }] });
  assert.ok(over.some((x) => x.includes('데이터율을 넘는')), JSON.stringify(over));
  assert.ok(!over.some((x) => x.includes('속도를 읽지 못한 FC')), JSON.stringify(over));
  const unk = detailNotes({ fc: [{ host: 'h1', bps: 1e6, pct: null, pctBasis: null }] });
  assert.ok(unk.some((x) => x.includes('속도를 읽지 못한 FC 포트 1개')), JSON.stringify(unk));
});

// ───────────────────────────── DB-01 스토리지 합계 추이 조각 ─────────────────────────────

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨린다 — v2.517 규약)

/** 예전(46f5e5e) 한 문장 판 — 결과 대조용으로 글자 그대로 옮겼다. */
const OLD_SQL = `SELECT CAST(CAST(ts/? AS INTEGER)*? AS INTEGER) AS ts, device_id,
            AVG(total_bytes) AS total_bytes, AVG(used_bytes) AS used_bytes,
            AVG(hdd_total) AS hdd_total, AVG(hdd_used) AS hdd_used,
            AVG(ssd_total) AS ssd_total, AVG(ssd_used) AS ssd_used
          FROM capacity_history WHERE ts >= ?
          GROUP BY CAST(ts/? AS INTEGER), device_id
          ORDER BY 1 LIMIT 400000`;
let raw = null;
async function seedCapacity() {
  assert.ok(await sdb.dbAvailable(), 'node:sqlite 필요');
  raw = new DatabaseSync(path.join(config.dbDir || config.configDir, 'storage-history.db'));
  raw.exec('PRAGMA busy_timeout=3000');
  const ins = raw.prepare('INSERT INTO capacity_history (device_id, ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used) VALUES (?,?,?,?,?,?,?,?)');
  raw.exec('BEGIN');
  // 장비 6대 · 20일 · 장비마다 다른 간격(7·23·37·61·90분 · 엣지 시계가 앞선 장비) — 같은 버킷에 표본이 여럿인 장비도 있다(AVG 가 정수가 아니다).
  const devs = [['d-a', 7], ['d-b', 23], ['d-c', 37], ['d-d', 61], ['d-e', 90], ['d-f', 41]];
  let k = 0;
  for (const [id, stepMin] of devs) {
    for (let t = NOW - 20 * 24 * HOUR + k * 97_000; t <= NOW + 2 * HOUR; t += stepMin * 60_000) {
      const i = Math.floor(t / 60_000);
      const total = 1e15 + (i % 1013) * 7_777;
      const used = id === 'd-c' && i % 11 === 0 ? null : 3e14 + (i % 997) * 13_331;   // 사용량을 못 읽은 표본도 섞는다
      const hdd = id === 'd-b' || id === 'd-e';
      ins.run(id, t, total, used, hdd ? total / 2 : null, hdd ? (used == null ? null : used / 3) : null, hdd ? null : total / 4, hdd ? null : (used == null ? null : used / 5));
    }
    k += 1;
  }
  // 엣지 시계가 앞선 표본(지금 이후) — 예전 문장도 읽던 것이다
  ins.run('d-f', NOW + 3 * HOUR + 12_345, 2e15, 5e14, null, null, null, null);
  raw.exec('COMMIT');
}
function oldPoints(sinceMs, bucketMs, opts = {}) {
  const b = Math.max(60_000, Number(bucketMs) || HOUR);
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : sdb.CAPACITY_CARRY_DEFAULT_MS;
  const sb = opts.staleByDevice;
  const maxStale = Math.max(staleMs, ...(sb instanceof Map ? [...sb.values()] : Object.values(sb || {})).filter((v) => Number.isFinite(v)));
  const rows = raw.prepare(OLD_SQL).all(b, b, Number(sinceMs) - maxStale, b);
  const r = sdb.sumCapacityBuckets(rows, { sinceMs: Number(sinceMs), nowMs: opts.nowMs, bucketMs: b, staleMs, staleByDevice: sb, knownIds: opts.knownIds ?? null });
  return { points: r.points, expectedDevices: r.expectedDevices, retiredDevices: r.retiredDevices, truncated: rows.length >= 400000, rows: rows.length };
}
after(() => { try { raw?.close(); } catch { /* noop */ } });

test('DB-01 ① 조각으로 나눈 합계 추이가 예전 한 문장 판과 같다(버킷 9가지 × 구간 · 신선도 맵 · 등록부 · 미래 표본)', async () => {
  await seedCapacity();
  const cases = [
    [NOW - 12 * HOUR, 10 * 60_000], [NOW - 24 * HOUR, 10 * 60_000], [NOW - 24 * HOUR, 15 * 60_000],
    [NOW - 7 * 24 * HOUR, HOUR], [NOW - 7 * 24 * HOUR + 17 * 60_000, HOUR], [NOW - 3 * 24 * HOUR, 2 * HOUR],
    [NOW - 20 * 24 * HOUR, 12 * HOUR], [NOW - 30 * 24 * HOUR, 24 * HOUR], [NOW - 7 * 24 * HOUR, 7 * 60_000],
  ];
  const optsList = [
    { nowMs: NOW },
    { nowMs: NOW, staleMs: 3 * HOUR, staleByDevice: new Map([['d-e', 5 * HOUR], ['d-a', 30 * 60_000]]), knownIds: ['d-a', 'd-b', 'd-c', 'd-d', 'd-e'] },
  ];
  let compared = 0;
  for (const [since, b] of cases) {
    for (const o of optsList) {
      const want = oldPoints(since, b, o);
      const got = await sdb.capacityHistoryAll(since, b, o);
      assert.ok(want.points.length > 0, `표본이 있어야 대조가 뜻이 있다 ${since} ${b}`);
      assert.ok(isDeepStrictEqual([...got], want.points), `점이 다르다 since=${since} b=${b} got=${got.length} want=${want.points.length}`);
      assert.equal(got.expectedDevices, want.expectedDevices);
      assert.equal(got.retiredDevices, want.retiredDevices);
      assert.equal(got.truncated, want.truncated);
      compared += 1;
    }
  }
  assert.equal(compared, cases.length * optsList.length);
});

test('DB-01 ② 조각 사이에 이벤트 루프로 양보한다(예전: 호출 전체가 한 동기 구간)', async () => {
  if (!raw) await seedCapacity();
  let ticks = 0; let stop = false;
  const spin = () => { if (stop) return; ticks += 1; setImmediate(spin); };
  setImmediate(spin);
  const pts = await sdb.capacityHistoryAll(NOW - 7 * 24 * HOUR, HOUR, { nowMs: NOW, yieldMs: 0.0001 });
  stop = true;
  assert.ok(pts.length > 100, String(pts.length));
  assert.ok(ticks >= 5, `양보 횟수 ${ticks}`);
});

test('DB-01 ③ 표본이 없는 구간·아주 이른 시작도 같은 결과(빈 조각을 수만 번 묻지 않는다)', async () => {
  if (!raw) await seedCapacity();
  const t0 = performance.now();
  const got = await sdb.capacityHistoryAll(0, HOUR, { nowMs: NOW });   // 1970년부터 — 예전 문장과 같은 행
  const ms = performance.now() - t0;
  const want = oldPoints(0, HOUR, { nowMs: NOW });
  assert.ok(isDeepStrictEqual([...got], want.points));
  assert.ok(ms < 5_000, `${ms}ms`);
  const future = await sdb.capacityHistoryAll(NOW + 30 * 24 * HOUR, HOUR, { nowMs: NOW + 31 * 24 * HOUR });
  assert.ok(isDeepStrictEqual([...future], oldPoints(NOW + 30 * 24 * HOUR, HOUR, { nowMs: NOW + 31 * 24 * HOUR }).points));
});

// ───────────────────────────── DB-02 /overview/trend 전력 계열 ─────────────────────────────

test('DB-02 ① 전력 추이는 ?include=power 일 때만 계산한다 — 아니면 power:{series:null, reason:"not-requested"}(키 유지)', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  const { getDb } = await import('../src/idrac/db.js');
  const { _resetTrendCacheForTest } = await import('../src/routes/api/overviewCards.js');
  await store.refresh();
  const pdb = await getDb();
  let calls = 0;
  const orig = pdb.fleetHourSums;
  pdb.fleetHourSums = (...a) => { calls += 1; return typeof orig === 'function' ? orig.apply(pdb, a) : []; };
  _resetTrendCacheForTest();
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const plain = await (await fetch(`${base}/overview/trend?days=7`)).json();
    assert.equal(plain.ok, true);
    assert.ok('power' in plain, '응답 키는 남긴다(계약)');
    assert.equal(plain.power.series, null);
    assert.equal(plain.power.reason, 'not-requested');
    assert.ok('virtual' in plain && 'storage' in plain && 'physical' in plain);
    assert.equal(calls, 0, '요청하지 않은 전력 계열을 계산하지 않는다');
    // 같은 기간을 전력과 함께 — 캐시가 섞이지 않고 계산한다
    const withP = await (await fetch(`${base}/overview/trend?days=7&include=power`)).json();
    assert.ok(Array.isArray(withP.power.series), JSON.stringify(withP.power));
    assert.equal(withP.power.scope, 'servers');
    assert.ok(calls >= 1);
    // 그 뒤 전력 없는 호출도 전력 결과를 받지 않는다(캐시 키 분리)
    const again = await (await fetch(`${base}/overview/trend?days=7`)).json();
    assert.equal(again.power.reason, 'not-requested');
  } finally { srv.close(); pdb.fleetHourSums = orig; }
});

test('DB-02 ② 경영 보기 화면은 전력 추이를 쓰지 않는다(KPI 키에 power 가 없다) · 문구는 not-requested 를 범위 탓으로 말하지 않는다', async () => {
  const src = fs.readFileSync(new URL('../../web/src/views/ExecOverview.jsx', import.meta.url), 'utf8');
  assert.ok(!/t\?\.power\b|trend\?\.power\b|\bt\.power\b/.test(src), 'ExecOverview 가 trend.power 를 읽기 시작하면 include=power 를 함께 보낼 것');
  const { trendNote } = await import('../../web/src/views/execOverviewText.js');
  assert.doesNotMatch(trendNote('power', { series: null, reason: 'not-requested' }), /전체 범위/);
});
