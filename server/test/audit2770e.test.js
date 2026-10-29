/**
 * v2.770 점검 5회차 수정 그룹 G5(통신 점검 낡음 기준·인시던트·DB 이전) 회귀 고정.
 *
 *  - E1-3  엣지 링크 보고 낡음 경계가 고정 3시간 — 점검 주기는 6시간까지 허용되므로 주기 > 3h 인 정상 엣지의 링크가 매 주기 후반
 *          '보고 오래됨'(no-data) 이었다. 경계 = max(3시간, 3×주기 + 여유), 서버 stale·응답 reportStaleMs 는 같은 값.
 *          엣지 결과 ts(엣지 시계)는 수신 시각 기준으로 환산(엣지 시계 지연에 '오래된 측정' 으로 흔들리지 않게).
 *  - E1-4  vc:<id> 합성 이벤트 생략이 '같은 key 의 fired 가 하나라도 있으면' 이라 발생→해소→재발이 1회로 셌고,
 *          vcenterDown 규칙을 끈 뒤의 재발은 인시던트 어디에도 없었다. 생략은 'key 의 가장 최근 사건이 fired' 일 때만.
 *  - E1-6  DB 를 CONFIG_DIR 로 되돌리는 이전 스크립트가 chown -R CONFIG_DIR — install.sh 가 root 소유로 둔
 *          release-signing-keys.conf 가 서비스 계정 소유가 됐다(서명 확인이 키 추가를 버린다). chmod 700 이 install 의 0750 도 바꿨다.
 *
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2770e-'));
const SRCDB = fs.mkdtempSync(path.join(os.tmpdir(), 'a2770e-src-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
delete process.env.LINKCHECK_REPORT_STALE_MS;

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;   // 정시 −30분 고정

const LE = await import('../src/central/linkCheckEdge.js');
const { buildIncidents } = await import('../src/insights/incidents.js');

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(SRCDB, { recursive: true, force: true });
});

const SETTINGS = path.join(DIR, 'linkcheck-settings.json');
const setInterval = (ms) => fs.writeFileSync(SETTINGS, JSON.stringify({ enabled: true, intervalMs: ms }));

/* ── E1-3 ─────────────────────────────────────────────────────────── */
test('E1-3 ① 낡음 경계 = max(3시간, 주기×3 + 여유) — 주기를 모르면 고정값(넓히지 않는다)', () => {
  assert.equal(LE.REPORT_STALE_MS, 3 * HOUR);
  assert.equal(LE.reportStaleLimitMs(6 * HOUR), 18 * HOUR + LE.REPORT_STALE_SLACK_MS);
  assert.equal(LE.reportStaleLimitMs(5 * MIN), 3 * HOUR, '짧은 주기는 고정 하한');
  for (const v of [null, undefined, '', 'abc', 0, -1]) assert.equal(LE.reportStaleLimitMs(v), 3 * HOUR, `주기 ${String(v)}`);
  assert.ok(LE.reportStaleLimitMs(6 * HOUR) > 6 * HOUR * 3, '여유가 붙는다');
});

test('E1-3 ② 6시간 주기의 정상 엣지 — 3.5시간 전 보고는 stale 이 아니고 경계를 넘으면 stale(보고에 경계를 함께 싣는다)', async (t) => {
  LE._resetEdgeLinkReportsForTest();
  setInterval(6 * HOUR);
  await LE.putEdgeLinkReport('GM1', { at: Date.now(), results: [], note: '잴 링크 없음' });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const base = realNow();
  Date.now = () => base + 3.5 * HOUR;
  const r = LE.edgeLinkReport('GM1');
  assert.equal(r.stale, false, '6h 주기의 3.5h 전 보고는 정상(예전에는 고정 3h 로 stale)');
  assert.equal(r.staleMs, LE.reportStaleLimitMs(6 * HOUR));
  Date.now = () => base + 18 * HOUR + LE.REPORT_STALE_SLACK_MS + MIN;
  assert.equal(LE.edgeLinkReport('GM1').stale, true, '경계를 넘으면 stale');
  assert.equal(LE.allEdgeLinkReports().GM1.stale, true);
  // 기본 5분 주기는 예전 판정 그대로(3h)
  setInterval(5 * MIN);
  Date.now = () => base + 3.5 * HOUR;
  assert.equal(LE.edgeLinkReport('GM1').stale, true, '짧은 주기는 고정 3h 그대로');
  // 넘겨준 경계를 쓴다(라우트가 한 번 계산한 값)
  assert.equal(LE.allEdgeLinkReports({ staleMs: 4 * HOUR }).GM1.stale, false);
  assert.equal(LE.allEdgeLinkReports({ staleMs: 4 * HOUR }).GM1.staleMs, 4 * HOUR);
});

test('E1-3 ③ 라우트 — 응답 reportStaleMs 와 각 엣지 보고의 stale 경계가 같은 값(주기 기반)', async () => {
  LE._resetEdgeLinkReportsForTest();
  setInterval(6 * HOUR);
  await LE.putEdgeLinkReport('GM1', { at: Date.now(), results: [] });
  const { registerLinkCheck } = await import('../src/routes/api/linkCheck.js');
  const handlers = {};
  const api = { get: (p, ...h) => { handlers[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { handlers[`POST ${p}`] = h.at(-1); }, put: () => {}, delete: () => {}, patch: () => {} };
  registerLinkCheck(api);
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await handlers['GET /tools/link-check']({ query: {}, user: { role: 'admin' } }, res);
  assert.ok(body && body.ok, '응답');
  assert.equal(body.reportStaleMs, LE.reportStaleLimitMs(6 * HOUR), '화면에 내려가는 경계 = 주기 기반 값');
  assert.equal(body.edgeReports.GM1.staleMs, body.reportStaleMs, '보고의 stale 판정 경계와 같은 값 하나');
});

test('E1-3 ④ 엣지 ts 는 수신 시각 기준으로 환산 — 엣지 시계가 늦어도/빨라도 측정 나이는 엣지가 잰 그대로', () => {
  const at = NOW;
  // 엣지 시계 20분 늦음: 엣지가 보고 1분 전에 잼
  assert.equal(LE.edgeTsToCentral(at - 20 * MIN - MIN, at - 20 * MIN, at), at - MIN);
  // 엣지 시계 10분 빠름
  assert.equal(LE.edgeTsToCentral(at + 10 * MIN - 2 * MIN, at + 10 * MIN, at), at - 2 * MIN);
  // 측정이 보고 시각보다 뒤(엣지 오류) → 나이 0(미래로 가지 않는다)
  assert.equal(LE.edgeTsToCentral(at + 5 * MIN, at, at), at);
  // 보고 시각이 없는 옛 본문 → 예전 규칙(5분 넘는 미래만 자름)
  assert.equal(LE.edgeTsToCentral(at - 7 * MIN, undefined, at), at - 7 * MIN);
  assert.equal(LE.edgeTsToCentral(at + 6 * MIN, null, at), at);
  // ts 를 못 읽으면 수신 시각
  for (const v of [null, '', 'x', 0, -5]) assert.equal(LE.edgeTsToCentral(v, at, at), at, `ts ${String(v)}`);
  assert.ok(LE.edgeTsToCentral(1, at, at) >= 1, '양수 유지');
});

test('E1-3 ⑤ 실제 수신 경로 — 엣지 시계가 30분 늦은 엣지의 갓 잰 링크가 DB 에 수신 시각 기준 ts 로 적재된다(원본은 detail.edgeTs)', async () => {
  const dbm = await import('../src/linkcheck/db.js');
  dbm._resetForTest();
  LE._resetEdgeLinkReportsForTest();
  setInterval(5 * MIN);
  const colFile = path.join(DIR, 'collectors.json');
  fs.writeFileSync(colFile, JSON.stringify({ collectors: [{ id: 'GM1', name: 'GM1', url: 'https://10.1.1.1:4000', token: 'x' }] }));
  try {
    const skew = -30 * MIN;
    const edgeNow = Date.now() + skew;
    const id = 'edge->central|GM1|central';
    const out = await LE.putEdgeLinkReport('GM1', { at: edgeNow, results: [
      { link: { id, kind: 'edge->central', from: 'GM1', to: 'central', host: 'c', port: 443 }, ts: edgeNow - MIN, verdict: { ok: true, phase: 'ok', totalMs: 5 }, steps: { tcp: { ok: true, ms: 2 } }, summary: 'ok' },
    ] });
    assert.equal(out.ok, true);
    assert.equal(out.stored, 1, JSON.stringify(out));
    const row = (await dbm.latestAll()).find((r) => r.link_id === id);
    assert.ok(row, '적재');
    const age = Date.now() - Number(row.ts);
    assert.ok(age >= MIN - 5_000 && age < MIN + 5 * MIN, `수신 시각 기준 나이 ≈ 1분(실측 ${age}ms) — 엣지 시계 그대로면 31분`);
    assert.ok(age < 3 * 5 * MIN, '주기 3배(15분) 안 — 오래된 측정이 아니다');
  } finally { fs.rmSync(colFile, { force: true }); dbm._resetForTest(); }
});

/* ── E1-4 ─────────────────────────────────────────────────────────── */
const iso = (t) => new Date(t).toISOString();
const vcSnap = { vcenters: [{ id: 'vc1', name: 'vc1', status: 'unreachable', staleSince: NOW - 10 * MIN }] };
const recurRecent = [
  { at: iso(NOW - 20 * MIN), key: 'vc:vc1', vcenterId: 'vc1', severity: 'resolved', title: '해소: vCenter 수집 실패: vc1' },
  { at: iso(NOW - 30 * MIN), key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'vCenter 수집 실패: vc1' },
];

test('E1-4 ① 발생→해소→재발(쿨다운 안이라 재발송 없음) — 재발이 합성돼 2회로 센다', () => {
  const st = { firing: [{ key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'vCenter 수집 실패: vc1', since: iso(NOW - 10 * MIN) }], recent: recurRecent, config: { channels: {} } };
  const r = buildIncidents(st, vcSnap, { now: NOW });
  assert.equal(r.summary.recent24h, 2, '실제 발생 2회');
  const fired = r.timeline.filter((e) => e.key === 'vc:vc1' && e.kind === 'fired').map((e) => e.ts);
  assert.deepEqual(fired, [NOW - 10 * MIN, NOW - 30 * MIN], '재발(10분 전) + 첫 발생(30분 전)');
});

test('E1-4 ② 규칙을 끈 뒤(firing 없음) 재발 — 이번 장애가 타임라인에 있다', () => {
  const r = buildIncidents({ firing: [], recent: recurRecent, config: { channels: {} } }, vcSnap, { now: NOW });
  assert.equal(r.timeline.filter((e) => e.key === 'vc:vc1' && e.kind === 'fired' && e.ts === NOW - 10 * MIN).length, 1);
  assert.equal(r.summary.recent24h, 2);
});

test('E1-4 ③ 가장 최근 사건이 fired 면 생략 — receivedAt 폴백 시각이 fired 보다 늦어도 중복을 되살리지 않는다(R4-D2-05 유지)', () => {
  // 엣지 위임 vCenter: staleSince 없음 → vcFailureStartTs 가 receivedAt(fired 보다 늦은 보고 시각)으로 폴백
  const snap = { vcenters: [{ id: 'vc1', name: 'vc1', status: 'unreachable', receivedAt: NOW - 2 * MIN }] };
  const st = { firing: [], recent: [{ at: iso(NOW - 15 * MIN), key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'vCenter 수집 실패: vc1' }], config: { channels: {} } };
  const r = buildIncidents(st, snap, { now: NOW });
  assert.equal(r.timeline.filter((e) => e.key === 'vc:vc1' && e.kind === 'fired').length, 1, '한 장애는 한 번');
  assert.equal(r.summary.recent24h, 1);
  // 해소 뒤 재발송된 fired 가 최신이면 역시 생략
  const st2 = { firing: [], recent: [{ at: iso(NOW - 5 * MIN), key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'x' }, ...recurRecent], config: { channels: {} } };
  assert.equal(buildIncidents(st2, vcSnap, { now: NOW }).summary.recent24h, 2, 'fired 2건 그대로(합성 없음)');
  // 같은 ts 면 recent 의 앞(최신)이 이긴다 — 해소가 앞이면 합성
  const same = iso(NOW - 20 * MIN);
  const st3 = { firing: [], recent: [{ at: same, key: 'vc:vc1', vcenterId: 'vc1', severity: 'resolved', title: '해소' }, { at: same, key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'x' }], config: { channels: {} } };
  assert.equal(buildIncidents(st3, vcSnap, { now: NOW }).summary.recent24h, 2);
});

/* ── E1-6 ─────────────────────────────────────────────────────────── */
function stubBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'a2770e-bin-'));
  const log = path.join(bin, 'chown.log');
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); };
  w('systemctl', 'case "$1" in is-active) exit 3;; *) exit 0;; esac');
  w('sleep', 'exit 0');
  w('chown', `printf '%s\\n' "$*" >> '${log}'; exit 0`);   // 실제 소유자는 바꾸지 않는다 — 무엇을 넘기려 했는지만 기록
  return { bin, log };
}

async function runMigration(targetDir) {
  const MS = await import('../src/insights/migrateScript.js');
  const r = MS.writeMigrationScript({ targetDir, user: os.userInfo().username, now: NOW });
  const syn = spawnSync('bash', ['-n', r.scriptPath], { encoding: 'utf8' });
  assert.equal(syn.status, 0, `bash -n: ${syn.stderr}`);
  const { bin, log } = stubBin();
  try {
    const p = spawnSync('bash', [r.scriptPath], { input: 'yes\n', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 });
    const chowns = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { status: p.status, out: `${p.stdout}\n${p.stderr}`, chowns, script: fs.readFileSync(r.scriptPath, 'utf8') };
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
}

function seedSource() {
  fs.writeFileSync(path.join(SRCDB, 'host-temp.db'), 'H'.repeat(4096));
  fs.writeFileSync(path.join(SRCDB, 'host-temp.db-wal'), 'W');
  fs.mkdirSync(path.join(SRCDB, 'vmperf'), { recursive: true });
  fs.writeFileSync(path.join(SRCDB, 'vmperf', 'vc1.db'), 'P'.repeat(1024));
  fs.writeFileSync(path.join(DIR, 'db-location.json'), JSON.stringify({ dbDir: SRCDB }));
}

test('E1-6 ① CONFIG_DIR 복귀 — root 소유 호스트 키 파일·ipam.db·CONFIG_DIR 권한을 건드리지 않고 복사한 DB 항목만 넘긴다', async () => {
  seedSource();
  const keys = path.join(DIR, 'release-signing-keys.conf');
  fs.writeFileSync(keys, '# host keys\n', { mode: 0o644 });
  fs.chmodSync(keys, 0o644);
  const ipam = path.join(DIR, 'ipam.db');
  fs.writeFileSync(ipam, 'I', { mode: 0o644 });
  fs.chmodSync(ipam, 0o644);
  fs.chmodSync(DIR, 0o750);

  const r = await runMigration(DIR);
  assert.equal(r.status, 0, r.out);
  // 호스트 키 파일·CONFIG_DIR 재귀 chown 이 없다
  assert.ok(!r.chowns.some((l) => l.includes('release-signing-keys.conf')), `키 파일 chown 금지: ${r.chowns.join(' | ')}`);
  assert.ok(!r.chowns.some((l) => /(^|\s)-R(\s|$)/.test(l) && (l.endsWith(` ${DIR}`) || l.endsWith(` ${DIR}/`))), 'CONFIG_DIR 재귀 chown 금지');
  assert.ok(!r.chowns.some((l) => l.includes('ipam.db')), 'ipam.db chown 금지');
  // 복사한 항목은 넘긴다
  assert.ok(r.chowns.some((l) => l.endsWith(path.join(DIR, 'host-temp.db'))), 'DB 파일 chown');
  assert.ok(r.chowns.some((l) => l.endsWith(path.join(DIR, 'host-temp.db-wal'))), '사이드카 chown');
  assert.ok(r.chowns.some((l) => /(^|\s)-R(\s|$)/.test(l) && l.endsWith(path.join(DIR, 'vmperf'))), 'DB 디렉터리 chown -R');
  // 권한 — CONFIG_DIR 0750 유지 · ipam.db 0644 유지 · 복사한 DB 600
  assert.equal(fs.statSync(DIR).mode & 0o777, 0o750, 'CONFIG_DIR 권한 유지(install.sh 0750)');
  assert.equal(fs.statSync(ipam).mode & 0o777, 0o644, 'ipam.db 권한 유지');
  assert.equal(fs.statSync(keys).mode & 0o777, 0o644, '키 파일 권한 유지');
  assert.equal(fs.statSync(path.join(DIR, 'host-temp.db')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(DIR, 'vmperf', 'vc1.db')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'db-location.json'), 'utf8')).dbDir, DIR, '복귀 자체는 진행된다');
});

test('E1-6 ② 별도 볼륨으로 이전 — 대상 디렉터리는 700, 복사한 항목만 넘긴다(기존 대상 파일은 건드리지 않는다)', async () => {
  seedSource();
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'a2770e-dst-'));
  try {
    fs.chmodSync(dst, 0o755);
    fs.writeFileSync(path.join(dst, 'other.txt'), 'o');
    const r = await runMigration(dst);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.statSync(dst).mode & 0o777, 0o700);
    assert.ok(!r.chowns.some((l) => l.includes('other.txt')), '복사하지 않은 파일은 넘기지 않는다');
    assert.ok(r.chowns.some((l) => !/(^|\s)-R(\s|$)/.test(l) && l.endsWith(` ${dst}`)), '대상 디렉터리 자체는 비재귀 chown');
    assert.ok(r.chowns.some((l) => l.endsWith(path.join(dst, 'host-temp.db'))));
  } finally { fs.rmSync(dst, { recursive: true, force: true }); }
});

test('E1-6 ③ 생성 스크립트 — 대상 전체 chown -R·*.db* 일괄 chmod 가 없다', async () => {
  const MS = await import('../src/insights/migrateScript.js');
  const r = MS.writeMigrationScript({ targetDir: path.join(DIR, 'newdb'), now: NOW + 1000 });
  const sh = fs.readFileSync(r.scriptPath, 'utf8');
  assert.ok(!/chown -R[^\n]*"\$DST"\s*(\|\||$)/m.test(sh), 'chown -R "$DST" 금지');
  assert.ok(!/find "\$DST" -maxdepth 2/.test(sh), 'DST 전체 *.db* chmod 금지');
  assert.ok(/same_dir "\$DST" "\$CONFIG_DIR"/.test(sh), 'CONFIG_DIR 이면 chmod 700 생략');
});
