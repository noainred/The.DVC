/**
 * v2.744(세 번 반복 3회차) 회귀 검토 수정 그룹 RE — v2.744 수정분(커밋 3b7816a)에서 회귀 검토가 찾은 발견.
 *
 * GE-R1 logs/db.js metaAsync: vCenter 를 하나씩 세며 양보하는 사이 정리(prune)가 끼어 아직 세지 않은 vCenter 의 행이 전부 지워지면,
 *   그 vCenter 가 {count:0, lastTs:0} 행으로 응답에 실렸다(Number(null)===0). 예전 한 문장 GROUP BY 에서는 생길 수 없던 값이다.
 *   → 0건 vCenter 는 결과에서 빼고, lastTs 는 numOrNull(못 읽으면 null — 0 으로 바꾸지 않는다).
 *   ⚠ vCenter 하나의 COUNT·MAX 는 한 문장으로 합치지 않았다 — EXPLAIN 은 둘 다 SEARCH(선행열 vcenterId=?)지만 합친 문장은
 *     COUNT 전용 경로·MAX 끝점 조회를 잃어 합성 150만 행에서 vCenter 당 약 2배 느렸다(scratchpad 실측). 두 문장은 같은 동기 단계 안에서
 *     연달아 돌아 그 사이에 정리가 끼지 않는다(같은 연결 · JS 단일 스레드).
 * GF-R2 코어 라이선스·비용 배분·이전 준비도 CSV 마지막 줄: 비활성 vCenter 를 '읽지 못한 vCenter' 로 세고 사유를 영문 코드로 적어,
 *   같은 데이터의 화면(partial=false · 하한 표지 없음)과 숫자·뜻이 어긋났다.
 *   → corelicense/analyze.js notReadCsvLines 하나(읽지 못한 것 · 비활성 두 줄, 사유는 웹 NOT_READ_WHY_TEXT 와 같은 한글 표의 서버 사본).
 *
 * 임시 파일은 os.tmpdir() 아래에만 만든다(저장소 안에 CONFIG_DIR 를 만들지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744re-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-a', name: 'VC-A', host: 'https://10.0.0.1', username: 'u', password: 'p', enabled: true },
  { id: 'vc-p', name: 'VC-P', host: 'https://10.0.0.3', username: 'u', password: 'p', enabled: true },
  { id: 'vc-u', name: 'VC-U', host: 'https://10.0.0.4', username: 'u', password: 'p', enabled: true },
  { id: 'vc-old', name: 'VC-OLD', host: 'https://10.0.0.2', username: 'u', password: 'p', enabled: false },
] }));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ } });

/** Date.now 를 앞당겨 메타 캐시 TTL 이 지난 것처럼 — 끝나면 되돌린다. */
function withClock(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  return Promise.resolve().then(fn).finally(() => { Date.now = real; });
}

// ─────────────────────────────── GE-R1 ───────────────────────────────
test('GE-R1 metaAsync 진행 중 정리가 한 vCenter 를 통째로 지워도 결과에 0건 행·lastTs 0 이 없다 · 정리가 없으면 예전 GROUP BY 와 같다', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  assert.equal(db.kind, 'sqlite');
  // 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md — Date.now 를 기준으로 쓰지 않는다)
  const base = Date.UTC(2026, 0, 10, 3, 30);
  const recs = [];
  for (let i = 0; i < 5; i++) recs.push({ vcenterId: 'vc-a', key: `a${i}`, ts: base + 100_000 + i, severity: 'info', type: 't', user: '', entity: 'e', message: 'm' });
  for (let i = 0; i < 5; i++) recs.push({ vcenterId: 'vc-b', key: `b${i}`, ts: base + i, severity: 'info', type: 't', user: '', entity: 'e', message: 'm' });
  for (let i = 0; i < 3; i++) recs.push({ vcenterId: 'vc-c', key: `c${i}`, ts: base + 200_000 + i, severity: 'info', type: 't', user: '', entity: 'e', message: 'm' });
  db.insertMany(recs);

  // 정리가 끼지 않을 때 — 예전 한 문장 GROUP BY 와 같은 결과(순서 포함)
  const { DatabaseSync } = await import('node:sqlite');
  const ref = new DatabaseSync(db.path);
  const oldRows = () => ref.prepare('SELECT vcenterId, COUNT(*) n, MAX(ts) mx FROM events GROUP BY vcenterId').all().map((x) => ({ vcenterId: x.vcenterId, count: Number(x.n), lastTs: Number(x.mx) }));
  await withClock(301_000, async () => {
    const m = await db.metaAsync({ yieldMs: 0.0001 });
    assert.deepEqual(m.vcenters, oldRows(), '정리가 없으면 예전 GROUP BY 와 같다');
    assert.equal(m.count, 13);
  });

  // 진행 중 정리 — 첫 vCenter(vc-a)를 센 직후 vc-b 를 통째로 지운다(재현: scratchpad review/ge-scripts/meta.mjs)
  await withClock(602_000, async () => {
    const p = db.metaAsync({ yieldMs: 0.0001 });
    const removed = db.prune(base + 50_000);
    assert.equal(removed, 5, 'vc-b 5행을 지웠다');
    const m = await p;
    const zero = m.vcenters.filter((v) => !(v.count > 0));
    assert.deepEqual(zero, [], `진행 중 지워진 vCenter 가 0건 행으로 실렸다: ${JSON.stringify(m.vcenters)}`);
    const badTs = m.vcenters.filter((v) => !(Number.isFinite(v.lastTs) && v.lastTs > 0));
    assert.deepEqual(badTs, [], `lastTs 가 0(1970)·null 인 행: ${JSON.stringify(m.vcenters)}`);
    assert.deepEqual(m.vcenters.map((v) => v.vcenterId), ['vc-a', 'vc-c']);
    assert.equal(m.count, m.vcenters.reduce((s, v) => s + v.count, 0), '합계는 실린 vCenter 의 합');
    // 다음 호출(정리 뒤)도 예전 GROUP BY 와 같다
    const after = await db.metaAsync();
    assert.deepEqual(after.vcenters, oldRows());
  });
  ref.close();
});

test('GE-R1 소스 — 마지막 시각을 Number() 로 감싸 null 을 0 으로 바꾸지 않는다 · 0건 vCenter 를 싣지 않는다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'logs/db.js'), 'utf8'));
  const gen = src.match(/function\* metaCountSteps\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(gen, 'metaCountSteps 를 찾지 못했다');
  assert.doesNotMatch(gen[0], /Number\(lastTsStmt/, 'lastTs 를 Number() 로 감싸면 행이 없을 때 0(1970)이 된다');
  assert.match(gen[0], /numOrNull\(lastTsStmt/);
});

// ─────────────────────────────── GF-R2 ───────────────────────────────
test('GF-R2 사유 표 — 서버 NOT_READ_WHY_TEXT 는 웹 bizreport/notReadText.js 와 같은 키·값(번들 경계 대조) · 판정 사유 전부를 덮는다', async () => {
  const srv = await import('../src/corelicense/analyze.js');
  const web = await import('../../web/src/views/bizreport/notReadText.js');
  assert.deepEqual({ ...srv.NOT_READ_WHY_TEXT }, { ...web.NOT_READ_WHY_TEXT }, '서버·웹 사유 표가 다르다');
  // 웹 소스를 문자 그대로도 대조한다(웹 모듈이 다른 값을 재수출로 덮지 않았는지)
  const webSrc = fs.readFileSync(path.resolve(HERE, '../../web/src/views/bizreport/notReadText.js'), 'utf8');
  for (const [k, v] of Object.entries(srv.NOT_READ_WHY_TEXT)) assert.ok(webSrc.includes(`${k}: '${v}'`), `웹 소스에 ${k}: '${v}' 가 없다`);
  // notReadVcentersOf 가 낼 수 있는 사유 전부 — unreadVcenterReasons(maintenance·unreachable·stale) + pending·disabled
  for (const w of ['pending', 'unreachable', 'maintenance', 'stale', 'disabled']) assert.ok(srv.NOT_READ_WHY_TEXT[w], `사유 ${w} 의 한글이 없다`);
  assert.equal(srv.notReadWhyText('???'), '읽지 못함');
});

test('GF-R2 notReadCsvLines — 읽지 못한 것과 비활성을 나눠 적고 사유는 한글 · 개수는 화면(notReadKpiSub·partial)과 같은 기준', async () => {
  const { notReadCsvLines, notReadPartialOf } = await import('../src/corelicense/analyze.js');
  const { notReadKpiSub } = await import('../../web/src/views/bizreport/notReadText.js');
  // 비활성만 — '읽지 못한' 이 나오지 않는다(화면 partial=false · 하한 표지 없음)
  const off = [{ vcenterId: 'vc-old', name: 'VC-OLD', why: 'disabled' }];
  const l1 = notReadCsvLines(off, { what: '호스트가 이 목록에 없음' });
  assert.equal(notReadPartialOf(off), false);
  assert.equal(notReadKpiSub(off), '');
  assert.equal(l1.length, 1);
  assert.doesNotMatch(l1.join('\n'), /읽지 못한/, `비활성만인데 '읽지 못한' 이라 적었다: ${l1}`);
  assert.match(l1[0], /비활성 vCenter 1곳/);
  assert.match(l1[0], /수집하지 않음/);
  assert.match(l1[0], /VC-OLD/);
  assert.doesNotMatch(l1[0], /disabled/, '영문 코드');
  // 섞임 — 읽지 못한 2곳(하한) + 비활성 1곳, 사유는 한글
  const mix = [{ vcenterId: 'vc-p', name: 'VC-P', why: 'pending' }, { vcenterId: 'vc-u', why: 'unreachable' }, ...off];
  const l2 = notReadCsvLines(mix, { what: '합계에 없음' });
  assert.equal(notReadPartialOf(mix), true);
  const webCount = Number(notReadKpiSub(mix).match(/(\d+)곳/)[1]);
  assert.equal(l2.length, 2);
  assert.match(l2[0], new RegExp(`읽지 못한 vCenter ${webCount}곳`), '화면과 CSV 의 읽지 못한 개수가 다르다');
  assert.match(l2[0], /하한/);
  assert.match(l2[0], /VC-P\(첫 수집 중\)/);
  assert.match(l2[0], /vc-u\(연결 실패\)/, '이름이 없으면 id');
  assert.match(l2[1], /비활성 vCenter 1곳/);
  assert.doesNotMatch(l2.join('\n'), /\((pending|unreachable|disabled|maintenance|stale)\)/, '영문 사유 코드');
  // 없으면 빈 배열
  assert.deepEqual(notReadCsvLines([], { what: 'x' }), []);
  assert.deepEqual(notReadCsvLines(null, { what: 'x' }), []);
});

/** 실제 api 라우터를 띄운다(인증 없음 · 관리자). */
async function startApi() {
  const { store } = await import('../src/store.js');
  const hosts = [1, 2].map((i) => ({ id: `vc-a:host-${i}`, vcenterId: 'vc-a', name: `h${i}`, cluster: 'C1', connectionState: 'CONNECTED', cpuCores: 16, cpuSockets: 2, cpuTotalMhz: 40000, memTotalMB: 65536 }));
  const vms = [1, 2].map((i) => ({ id: `vc-a:vm-${i}`, vcenterId: 'vc-a', name: `v${i}`, cluster: 'C1', host: 'h1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, storageGB: 50 }));
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'adm', role: 'admin', scope: null }; n(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const setVcs = (vcenters) => { store.snapshot = { ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(), vcenters, hosts, vms, datastores: [], alarms: [], networks: [] }; };
  return { base: `http://127.0.0.1:${srv.address().port}`, setVcs, close: () => new Promise((r) => srv.close(r)) };
}

const CSV_ROUTES = ['/api/tools/core-license', '/api/tools/cost-showback', '/api/tools/migration-readiness'];

test('GF-R2 실제 라우터 — 비활성만 빠진 현장의 CSV 는 \'읽지 못한\' 을 말하지 않는다 · 섞이면 개수가 화면과 같다 · 사유는 한글', async () => {
  const s = await startApi();
  try {
    const { notReadKpiSub } = await import('../../web/src/views/bizreport/notReadText.js');
    // ① 비활성만
    s.setVcs([{ id: 'vc-a', name: 'VC-A', status: 'connected' }, { id: 'vc-old', name: 'VC-OLD', status: 'disabled' }]);
    for (const p of CSV_ROUTES) {
      const j = await fetch(s.base + p).then((x) => x.json());
      assert.equal(j.partial ?? j.totals?.partial, false, `${p} partial`);
      const csv = await fetch(s.base + p + '.csv').then((x) => x.text());
      assert.doesNotMatch(csv, /읽지 못한 vCenter/, `${p}: 비활성만 빠졌는데 CSV 가 '읽지 못한 vCenter' 라 적었다`);
      assert.match(csv, /비활성 vCenter 1곳/, `${p}: 비활성 vCenter 를 밝히지 않았다`);
      assert.doesNotMatch(csv, /\(disabled\)/, `${p}: 영문 사유 코드`);
    }
    // ② 읽지 못한 2곳 + 비활성 1곳
    s.setVcs([{ id: 'vc-a', name: 'VC-A', status: 'connected' }, { id: 'vc-p', name: 'VC-P', status: 'pending' },
      { id: 'vc-u', name: 'VC-U', status: 'unreachable' }, { id: 'vc-old', name: 'VC-OLD', status: 'disabled' }]);
    for (const p of CSV_ROUTES) {
      const j = await fetch(s.base + p).then((x) => x.json());
      assert.equal(j.partial ?? j.totals?.partial, true, `${p} partial`);
      const webN = Number(notReadKpiSub(j.notReadVcenters).match(/(\d+)곳/)[1]);
      assert.equal(webN, 2);
      const csv = await fetch(s.base + p + '.csv').then((x) => x.text());
      assert.match(csv, new RegExp(`읽지 못한 vCenter ${webN}곳`), `${p}: CSV 와 화면의 개수가 다르다`);
      assert.match(csv, /VC-P\(첫 수집 중\)/, `${p}: 사유가 한글이 아니다`);
      assert.match(csv, /VC-U\(연결 실패\)/);
      assert.match(csv, /비활성 vCenter 1곳/);
      assert.doesNotMatch(csv, /\((pending|unreachable|disabled)\)/, `${p}: 영문 사유 코드`);
    }
  } finally { await s.close(); }
});

test('GF-R2 소스 — 다섯 라우트(코어 라이선스·비용·이전 준비도·호스트/VM 구성 점검)는 CSV 줄을 notReadCsvLines 하나로 만든다(문구·사유 표를 라우트에 복제하지 않는다)', () => {
  for (const f of ['routes/api/coreLicense.js', 'routes/api/costShowback.js', 'routes/api/migrationReadiness.js', 'routes/api/hostHygiene.js', 'routes/api/vmHygiene.js']) {
    const src = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.match(src, /notReadCsvLines\(/, `${f} 가 공용 함수를 쓰지 않는다`);
    assert.doesNotMatch(src, /x\.why\}\)/, `${f} 에 사유 코드를 그대로 적는 사본이 남았다`);
  }
});
