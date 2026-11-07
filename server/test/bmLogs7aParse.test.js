/**
 * 7a단계 로그 분석 — 파서(순수) 고정 표본: journald JSON(한 줄 = 한 항목 · 잘린 JSON · 바이트 배열) · dmesg -x · secure · audit · GPDB csv · Airflow ·
 *   잘림(##END 미도착 → 마지막 구획 버림 · 위치 유지 · 줄 세지 않음) · 권한 없음 · 없음 · 파일 없음 · 출력의 위치 값 화이트리스트.
 *   표본(test/fixtures/bmlogs)은 업스트림 형식으로 만든 합성 줄이다(실장비 출력 아님 — dmesg -x 줄 머리만 이 컨테이너 실측 형식).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bmlogs');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8').split('\n').filter(Boolean);
const P = await import('../src/bmusage/logs/parse.js');
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-06T15:00:00+09:00');
const CUR = `s=${'a'.repeat(32)};i=9;b=${'b'.repeat(32)};m=1;t=1;x=1`;
const wrap = (o) => ['##JOURNAL', ...(o.J || ['J#absent']), '##JSEC', ...(o.Q || ['Q#absent']), '##DMESG', ...(o.K || ['K#absent']), '##SECURE', ...(o.S || ['S#absent']), '##AUDIT', ...(o.A || ['A#absent']), '##APPLOG', ...(o.G || ['G#absent']), ...(o.F || ['F#absent']), ...(o.end === false ? [] : ['##END'])].join('\n');
const fileMeta = (p, n, extra = []) => [`${p}#ino=7`, `${p}#size=900`, `${p}#mode=inc`, ...extra, `${p}#n=${n}`, `${p}#off=900`];

test('journald JSON — 시각(µs) · 식별자 · 여러 줄 메시지 · 바이트 배열 · 잘린 JSON(앞부분만) · 주 저널의 sshd 줄은 JSEC 쪽', () => {
  const lines = fx('journal.jsonl');
  const shift = (l) => { const o = JSON.parse(l); o.__REALTIME_TIMESTAMP = String(Number(o.__REALTIME_TIMESTAMP)); return JSON.stringify(o); };
  const r = P.parseLogOutput(wrap({ J: [...lines.map((l) => `J|${shift(l)}`), `J#cur=${CUR}`, `J#n=${lines.length}`, `J#e=${lines.length}`, 'J#rc=0'] }), { now: NOW });
  const a = r.items.find((x) => x.msg.startsWith('postgresql.service'));
  assert.equal(a.ts, Date.parse('2026-11-06T13:02:41+09:00')); assert.equal(a.unit, 'systemd'); assert.equal(a.src, 'journal');
  assert.equal(r.sources.journal.authSkipped, 1);
  assert.equal(r.items.filter((x) => x.src === 'journal').length, lines.length - 1);
  assert.equal(r.next.journal.cursor, CUR);
  // 잘린 JSON(JSON_WIDTH) — 정규식으로 MESSAGE 앞부분 · 시각 · 식별자
  const cut = JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.parse('2026-11-06T14:00:00+09:00') * 1000), SYSLOG_IDENTIFIER: 'kernel-ish', MESSAGE: `Out of memory: \"x\" ${'y'.repeat(2000)}` }).slice(0, 1200);
  const j = P.parseJournalJson(cut);
  assert.equal(j.cut, true); assert.equal(j.ts, Date.parse('2026-11-06T14:00:00+09:00')); assert.equal(j.ident, 'kernel-ish'); assert.ok(j.msg.startsWith('Out of memory: "x" yyy'));
  assert.equal(P.parseJournalJson('not json'), null);
  assert.equal(P.parseJournalJson(JSON.stringify({ MESSAGE: [104, 105] })).msg, 'hi');
  assert.equal(P.parseJournalJson(JSON.stringify({ MESSAGE: 'a', SYSLOG_IDENTIFIER: ['x', 'y'] })).ident, 'x', '같은 필드 여러 값이면 첫 값');
});

test('시각 판정(반증 F6) — 범위 밖을 지금으로 지어내지 않는다: 30일보다 오래됨 · 시각 없음 = null · 하루 안쪽 미래 = 받은 시각(skew)', () => {
  assert.deepEqual(P.dateOf(NOW - HOUR, NOW), { ts: NOW - HOUR });
  assert.deepEqual(P.dateOf(NOW - 31 * 24 * HOUR, NOW), { ts: null, why: 'old' });
  assert.deepEqual(P.dateOf(null, NOW), { ts: null, why: 'none' });
  assert.deepEqual(P.dateOf(NOW + 2 * HOUR, NOW), { ts: NOW, why: 'skew' });
  assert.deepEqual(P.dateOf(NOW + 2 * 24 * HOUR, NOW), { ts: null, why: 'future' });
  const old = JSON.stringify({ __REALTIME_TIMESTAMP: String((NOW - 40 * 24 * HOUR) * 1000), SYSLOG_IDENTIFIER: 'x', MESSAGE: 'I/O error, dev sdb, sector 1' });
  const fut = JSON.stringify({ __REALTIME_TIMESTAMP: String((NOW + HOUR) * 1000), SYSLOG_IDENTIFIER: 'x', MESSAGE: 'later' });
  const r = P.parseLogOutput(wrap({ J: [`J|${old}`, `J|${fut}`, `J#cur=${CUR}`, 'J#n=2', 'J#rc=0'] }), { now: NOW });
  assert.equal(r.sources.journal.undated, 1); assert.equal(r.sources.journal.skew, 1);
  assert.equal(r.items[0].ts, null); assert.equal(r.items[1].ts, NOW);
});

test('dmesg -x · secure(syslog) · audit(msg=audit 초) · GPDB csv(수준 · 메시지 열 · "" 이스케이프) · Airflow', () => {
  const out = wrap({
    K: [...fx('dmesg.txt').map((l) => `K|${l}`), 'K#boot=3818fa4e-dde8-4491-a53a-a696101a21ab', 'K#last=5100.000005', 'K#up=6000.00', `K#now=${Math.floor(NOW / 1000)}`, 'K#n=6', 'K#rc=0'],
    S: [...fx('secure.txt').map((l) => `S|${l}`), ...fileMeta('S', 9)],
    A: ['A#svc=active', ...fx('audit.txt').map((l) => `A|${l}`), ...fileMeta('A', 2)],
    G: ['G#dir=0', ...fx('gpdb.csv').map((l) => `G|${l}`), ...fileMeta('G', 2)],
    F: ['F#dir=1', ...fx('airflow.log').map((l) => `F|${l}`), ...fileMeta('F', 2)],
  });
  const r = P.parseLogOutput(out, { now: NOW });
  const k = r.items.filter((x) => x.src === 'kernel');
  assert.equal(k.length, 6); assert.equal(k[0].msg, 'nvme nvme1: I/O 1024 QID 7 timeout, completion polled');
  assert.equal(k[0].ts, Math.round(NOW - 6000 * 1000 + 4812438.614), '커널 [초] + (서버 now − uptime)');
  assert.equal(r.items.filter((x) => x.src === 'secure').length, 9);
  assert.equal(r.items.find((x) => x.src === 'secure').unit, 'sshd');
  const au = r.items.filter((x) => x.src === 'audit');
  assert.equal(au[0].ts, 1793937600123); assert.equal(r.sources.audit.svc, 'active');
  const gp = r.items.filter((x) => x.src === 'gpdb');
  assert.equal(gp[0].msg, 'FATAL: the database system is in recovery mode');
  assert.ok(gp[1].msg.startsWith('LOG: checkpoint complete: wrote 48112 buffers'));
  assert.equal(P.parseGpdbLine('2026-11-06 13:43:20.1 KST,,,p1,th1,,,,0,,,seg-1,,,,,"ERROR","42P01","relation ""x"" does not exist",,').msg, 'ERROR: relation "x" does not exist');
  const af = r.items.filter((x) => x.src === 'airflow');
  assert.equal(af[0].ts, Date.parse('2026-11-06T13:43:20.123+09:00')); assert.ok(af[0].msg.startsWith('ERROR - Scheduler heartbeat'));
  assert.deepEqual(r.next.apps.gpdb, { ino: '7', off: '900', dir: 0 });
});

test('잘림(##END 미도착) — 마지막 구획을 통째로 버린다(줄을 세지 않고 위치를 넘기지 않는다) · 그 뒤는 missing', () => {
  const prev = { secure: { ino: '7', off: '100' }, journal: { cursor: CUR } };
  const out = wrap({ J: [`J|${JSON.stringify({ __REALTIME_TIMESTAMP: String((NOW - HOUR) * 1000), SYSLOG_IDENTIFIER: 'app', MESSAGE: 'one' })}`, `J#cur=${CUR.replace('i=9', 'i=a')}`, 'J#n=1', 'J#rc=0'], S: ['S|Nov  6 10:00:00 h sshd[1]: Failed password for root from 203.0.113.4', 'S|Nov  6 10:00:01 h sshd[1]: Failed pass'], end: false });
  const cut = out.slice(0, out.indexOf('##AUDIT'));
  const r = P.parseLogOutput(cut, { prev, now: NOW });
  assert.equal(r.ended, false); assert.equal(r.cut, 'SECURE');
  assert.equal(r.sources.secure.status, 'cut'); assert.equal(r.sources.secure.n, null);
  assert.deepEqual(r.next.secure, prev.secure, '잘린 구획의 위치는 넘기지 않는다(다음 주기에 다시 읽는다)');
  assert.equal(r.items.filter((x) => x.src === 'secure').length, 0, '잘린 구획의 줄은 세지 않는다(두 번 세지 않게)');
  assert.equal(r.sources.journal.status, 'ok', '앞 구획은 온전하다');
  for (const s of ['audit', 'gpdb', 'airflow']) assert.equal(r.sources[s].status, 'missing');
});

test('권한 없음 · 없음 · 파일 없음 · 실패 — 0 이 아니라 상태 · 위치 유지 · 출력의 위치 값도 화이트리스트', () => {
  const prev = { secure: { ino: '7', off: '100' }, audit: { ino: '8', off: '5' }, apps: { gpdb: { ino: '3', off: '9', dir: 0 } } };
  const r = P.parseLogOutput(wrap({ J: ['J#perm=none', 'J#n=0', 'J#rc=1'], Q: ['Q#uid=1001', 'Q#grp=', 'Q#perm=own', 'Q#n=0', 'Q#rc=0'], K: ['K#perm', 'K#n=0', 'K#rc=1'], S: ['S#perm=file'], A: ['A#svc=', 'A#perm=dir'], G: ['G#dir=0', 'G#nofile'], F: ['F#dir=0', 'F#ino=1;rm', 'F#size=1', 'F#mode=inc', 'F#n=1', 'F#off=1'] }), { prev, now: NOW });
  assert.equal(r.sources.journal.status, 'perm'); assert.equal(r.sources.journal.scope, 'none'); assert.equal(r.sources.kernel.status, 'perm'); assert.equal(r.sources.secure.status, 'perm');
  assert.equal(r.sources.jsec.status, 'perm'); assert.equal(r.sources.jsec.scope, 'own'); assert.equal(r.sources.jsec.uid, 1001); assert.deepEqual(r.sources.jsec.groups, []);
  assert.equal(r.sources.audit.scope, 'dir'); assert.equal(r.sources.secure.scope, 'file');
  assert.equal(r.authSrc, null, '보안 줄을 담는 출처를 하나도 못 읽었다');
  assert.equal(r.sources.audit.status, 'perm'); assert.equal(r.sources.gpdb.status, 'nofile'); assert.equal(r.sources.airflow.status, 'failed', '출력의 inode 가 숫자가 아니면 읽지 않은 것');
  for (const s of Object.values(r.sources)) assert.equal(s.n, null, '못 읽은 출처의 줄 수는 null(0 아님)');
  assert.deepEqual(r.next.secure, prev.secure); assert.deepEqual(r.next.audit, prev.audit); assert.deepEqual(r.next.apps.gpdb, prev.apps.gpdb);
  // 커서 꼴이 아닌 J#cur 는 커서가 되지 않는다
  const j = P.parseLogOutput(wrap({ J: ["J#cur=s=1';id", 'J#n=0', 'J#rc=0'] }), { prev: { journal: { cursor: CUR } } });
  assert.equal(j.next.journal.cursor, CUR);
  // 접두 없는 줄은 버리고 센다
  const s = P.parseLogOutput(wrap({ J: ['stray line', 'J#n=0', 'J#rc=0'] }));
  assert.equal(s.stray, 1);
});
