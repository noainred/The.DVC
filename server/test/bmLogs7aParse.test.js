/**
 * 7a단계 로그 분석 — 파서(순수) 고정 표본: RHEL/Rocky 8(+0900) · 9(+09:00) journald · dmesg -x · secure · audit · GPDB csv · Airflow ·
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
const wrap = (o) => ['##JOURNAL', ...(o.J || ['J#absent']), '##DMESG', ...(o.K || ['K#absent']), '##SECURE', ...(o.S || ['S#absent']), '##AUDIT', ...(o.A || ['A#absent']), '##APPLOG', ...(o.G || ['G#absent']), ...(o.F || ['F#absent']), ...(o.end === false ? [] : ['##END'])].join('\n');
const fileMeta = (p, n, extra = []) => [`${p}#ino=7`, `${p}#size=900`, `${p}#mode=inc`, ...extra, `${p}#n=${n}`, `${p}#off=900`];

test('Rocky 8(+0900) · 9(+09:00) journald 시각 · 유닛 · 메시지 — 같은 순간이 같은 ms', () => {
  const r9 = P.parseLogOutput(wrap({ J: [...fx('journal-rocky9.txt').map((l) => `J|${l}`), `J#cur=${CUR}`, 'J#n=6', 'J#rc=0'] }), { now: NOW });
  const r8 = P.parseLogOutput(wrap({ J: [...fx('journal-rocky8.txt').map((l) => `J|${l}`), `J#cur=${CUR}`, 'J#n=2', 'J#rc=0'] }), { now: NOW });
  const a = r9.items.find((x) => x.msg.startsWith('postgresql.service'));
  const b = r8.items.find((x) => x.msg.startsWith('postgresql.service'));
  assert.equal(a.ts, Date.parse('2026-11-06T13:02:41+09:00')); assert.equal(a.ts, b.ts);
  assert.equal(a.unit, 'systemd'); assert.equal(a.src, 'journal');
  assert.equal(r9.sources.journal.cont, 1, '들여쓴 다음 줄은 이어진 줄');
  assert.equal(r9.next.journal.cursor, CUR);
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
  const out = wrap({ J: [`J|2026-11-06T13:00:00+09:00 h app[1]: one`, `J#cur=${CUR.replace('i=9', 'i=a')}`, 'J#n=1', 'J#rc=0'], S: ['S|Nov  6 10:00:00 h sshd[1]: Failed password for root from 203.0.113.4', 'S|Nov  6 10:00:01 h sshd[1]: Failed pass'], end: false });
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
  const r = P.parseLogOutput(wrap({ J: ['J#perm'], K: ['K#perm', 'K#n=0', 'K#rc=1'], S: ['S#perm'], A: ['A#svc=', 'A#absent'], G: ['G#dir=0', 'G#nofile'], F: ['F#dir=0', 'F#ino=1;rm', 'F#size=1', 'F#mode=inc', 'F#n=1', 'F#off=1'] }), { prev, now: NOW });
  assert.equal(r.sources.journal.status, 'perm'); assert.equal(r.sources.kernel.status, 'perm'); assert.equal(r.sources.secure.status, 'perm');
  assert.equal(r.sources.audit.status, 'absent'); assert.equal(r.sources.gpdb.status, 'nofile'); assert.equal(r.sources.airflow.status, 'failed', '출력의 inode 가 숫자가 아니면 읽지 않은 것');
  for (const s of Object.values(r.sources)) assert.equal(s.n, null, '못 읽은 출처의 줄 수는 null(0 아님)');
  assert.deepEqual(r.next.secure, prev.secure); assert.deepEqual(r.next.audit, prev.audit); assert.deepEqual(r.next.apps.gpdb, prev.apps.gpdb);
  // 커서 꼴이 아닌 J#cur 는 커서가 되지 않는다
  const j = P.parseLogOutput(wrap({ J: ["J#cur=s=1';id", 'J#n=0', 'J#rc=0'] }), { prev: { journal: { cursor: CUR } } });
  assert.equal(j.next.journal.cursor, CUR);
  // 접두 없는 줄은 버리고 센다
  const s = P.parseLogOutput(wrap({ J: ['stray line', 'J#n=0', 'J#rc=0'] }));
  assert.equal(s.stray, 1);
});
