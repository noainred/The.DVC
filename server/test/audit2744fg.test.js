/**
 * v2.744 최종 검토 수정 그룹 FG — RV-3 · RX-CSV-01(같은 결함).
 *
 * 호스트·VM 구성 점검 CSV 는 판정 목록이다(호스트·VM 한 대당 한 줄 — 합계 행이 없다). 그런데 마지막 줄을 만드는
 * corelicense/analyze.js notReadCsvLines 가 합계 화면(코어 라이선스·비용 배분·이전 준비도)용 꼬리 ' · 합계는 하한' 을 언제나 붙여,
 * 파일에 없는 '합계' 를 가리켰다. 같은 릴리스의 화면 배너(web notReadJudgeNote — 회귀 검토 FX-R2)는 '그 화면에는 합계가 없다' 며
 * 판정 목록 문장('그 vCenter 의 호스트 판정 결과는 이 목록과 개수에 들어 있지 않습니다(문제가 없다는 뜻이 아닙니다)')으로 바꿨으므로
 * 화면과 파일이 다르게 말했다.
 *   → notReadCsvLines 에 mode 'judge'(+ noun) 를 두고 두 판정 목록 CSV 가 그것을 쓴다. 합계 화면 CSV 는 그대로 '합계는 하한'.
 *
 * 실제 api 라우터(express 마운트)로 CSV 를 받아 마지막 줄을 본다(audit2744m 와 같은 하니스). 임시 파일은 os.tmpdir() 아래에만.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fg-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

// 기준 시각은 경계에서 떨어뜨려 고정한다(Date.now() 를 기준으로 쓰지 않는다 — 루트 CLAUDE.md 규약).
const T0 = Date.UTC(2026, 9, 19, 3, 30, 0);

// vc-a 만 읽었다. vc-u 불통(인벤토리 비움), vc-p 첫 수집 중, vc-o 비활성.
const hosts = [1, 2].map((i) => ({
  id: `vc-a:host-${i}`, vcenterId: 'vc-a', name: `esx-a${i}`, cluster: 'C1', connectionState: 'CONNECTED', version: '8.0.2', build: '1',
  cpuCores: 16, cpuSockets: 2, cpuTotalMhz: 40000, memTotalMB: 65536,
  hcfg: { at: T0, ntpServers: [], syslogHost: '', ssh: { running: true, policy: 'on' } },
}));
const vms = [1, 2, 3].map((i) => ({
  id: `vc-a:vm-${i}`, vcenterId: 'vc-a', name: `app-a${i}`, powerState: 'POWERED_ON', host: 'esx-a1', cluster: 'C1',
  cpuCount: 2, memMB: 4096, storageGB: 50,
  snapshotCount: 0, toolsVersionStatus: 'guestToolsNotInstalled', cfg: { at: T0 }, dev: { at: T0 },
}));
const VCS = [
  { id: 'vc-a', name: 'VC-A', status: 'connected' },
  { id: 'vc-u', name: 'VC-U', status: 'unreachable' },
  { id: 'vc-p', name: 'VC-P', status: 'pending' },
  { id: 'vc-o', name: 'VC-O', status: 'disabled' },
];

let base;
let store;
const setVcs = (vcenters, gen) => {
  store.snapshot = { ...(store.get() || {}), source: 'live', generatedAt: gen, vcenters, hosts, vms, datastores: [], networks: [], alarms: [] };
};
before(async () => {
  ({ store } = await import('../src/store.js'));
  setVcs(VCS, '2026-10-19T03:30:00.000Z');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const getText = (p) => fetch(base + p).then((x) => x.text());
const getJson = (p) => fetch(base + p).then((x) => x.json());
/** CSV 의 마지막 줄들 — 본문 행 뒤에 붙는 '(…)' 안내 줄(따옴표로 싸였을 수 있다). */
const noteLines = (csv) => csv.split(/\r\n/).filter((l) => /^"?\(/.test(l));

// 판정 목록 화면과 그 화면이 notReadJudgeNote 에 넘기는 명사(HostHygieneTool.jsx · VmHygieneTool.jsx 와 같은 값 — 아래 ④ 가 대조한다).
const JUDGE = [
  { path: '/api/tools/host-hygiene', noun: '호스트', jsx: 'tools/HostHygieneTool.jsx' },
  { path: '/api/tools/vm-hygiene', noun: 'VM', jsx: 'tools/VmHygieneTool.jsx' },
];
const TOTAL = ['/api/tools/core-license', '/api/tools/cost-showback', '/api/tools/migration-readiness'];

test('① notReadCsvLines mode judge — 합계를 말하지 않고 판정 목록 문장으로 · 기본(합계 화면)은 그대로 \'합계는 하한\'', async () => {
  const { notReadCsvLines } = await import('../src/corelicense/analyze.js');
  const list = [{ vcenterId: 'vc-u', name: 'VC-U', why: 'unreachable' }, { vcenterId: 'vc-p', why: 'pending' }, { vcenterId: 'vc-o', name: 'VC-O', why: 'disabled' }];
  const j = notReadCsvLines(list, { mode: 'judge', noun: '호스트' });
  assert.equal(j.length, 2, JSON.stringify(j));
  assert.doesNotMatch(j.join('\n'), /합계/, `판정 목록 CSV 가 '합계' 를 말했다: ${j}`);
  assert.match(j[0], /^\(읽지 못한 vCenter 2곳 — 판정하지 않음/);
  assert.match(j[0], /그 vCenter 의 호스트 판정 결과는 이 목록에 없음/);
  assert.match(j[0], /문제가 없다는 뜻이 아님/);
  assert.match(j[0], /VC-U\(연결 실패\)/);
  assert.match(j[0], /vc-p\(첫 수집 중\)/, '이름이 없으면 id');
  assert.match(j[1], /비활성 vCenter 1곳\(수집하지 않음\): VC-O/, '비활성은 따로(원래 수집하지 않는다)');
  // 비활성만이면 '읽지 못한' 을 말하지 않는다(화면 notReadJudgeNote 가 빈 문자열인 것과 같은 기준)
  const off = notReadCsvLines([{ vcenterId: 'vc-o', name: 'VC-O', why: 'disabled' }], { mode: 'judge', noun: 'VM' });
  assert.equal(off.length, 1);
  assert.doesNotMatch(off[0], /읽지 못한|합계/);
  // 합계 화면(기본·mode 'total')은 예전 그대로
  const t = notReadCsvLines(list, { what: '호스트가 이 목록에 없음' });
  assert.match(t[0], /^\(읽지 못한 vCenter 2곳 — 호스트가 이 목록에 없음 · 합계는 하한: VC-U\(연결 실패\), vc-p\(첫 수집 중\)\)$/);
  assert.deepEqual(notReadCsvLines(list, { mode: 'total', what: '호스트가 이 목록에 없음' }), t);
  // 모르는 mode 는 합계 문장(예전 동작)으로 — 조용히 다른 뜻이 되지 않게
  assert.deepEqual(notReadCsvLines(list, { mode: '??', what: '호스트가 이 목록에 없음' }), t);
  assert.deepEqual(notReadCsvLines([], { mode: 'judge', noun: '호스트' }), []);
});

test('② 실제 라우터 — 호스트·VM 구성 점검 CSV 의 마지막 줄은 \'합계\' 를 말하지 않고 화면 배너(notReadJudgeNote)와 같은 뜻 · 개수·이름이 같다', async () => {
  const { notReadJudgeNote } = await import('../../web/src/views/bizreport/notReadText.js');
  setVcs(VCS, '2026-10-19T03:31:00.000Z');
  for (const { path: p, noun } of JUDGE) {
    const j = await getJson(p);
    const banner = notReadJudgeNote(j.notReadVcenters, noun);
    assert.ok(banner, `${p} 화면 배너가 비었다`);
    assert.doesNotMatch(banner, /합계/);
    const csv = await getText(p + '.csv');
    assert.doesNotMatch(csv, /합계/, `${p}.csv 가 파일에 없는 '합계' 를 말했다:\n${noteLines(csv).join('\n')}`);
    const notes = noteLines(csv);
    assert.equal(notes.length, 2, `${p}.csv 안내 줄: ${notes.join(' | ')}`);
    // 같은 개수
    const webN = Number(banner.match(/읽지 못한 vCenter (\d+)곳/)[1]);
    assert.match(notes[0], new RegExp(`읽지 못한 vCenter ${webN}곳 — 판정하지 않음`), `${p}: 화면과 개수가 다르다`);
    // 같은 뜻 — 그 vCenter 의 <명사> 판정 결과가 이 목록에 없다 · 문제가 없다는 뜻이 아니다
    assert.ok(banner.includes(`그 vCenter 의 ${noun} 판정 결과는 이 목록`), banner);
    assert.match(notes[0], new RegExp(`그 vCenter 의 ${noun} 판정 결과는 이 목록에 없음`), `${p}: ${notes[0]}`);
    assert.match(banner, /문제가 없다는 뜻이 아닙니다/);
    assert.match(notes[0], /문제가 없다는 뜻이 아님/, `${p}: ${notes[0]}`);
    // 같은 이름·사유(화면은 따옴표로 감싼다)
    for (const x of j.notReadVcenters.filter((v) => v.why !== 'disabled')) {
      const why = { pending: '첫 수집 중', unreachable: '연결 실패' }[x.why];
      assert.ok(banner.includes(`‘${x.name}’(${why})`), banner);
      assert.ok(notes[0].includes(`${x.name}(${why})`), notes[0]);
    }
    // 비활성은 따로 — 화면 '비활성 1곳은 원래 수집하지 않습니다' ↔ 파일 '비활성 vCenter 1곳(수집하지 않음)'
    assert.match(banner, /비활성 1곳은 원래 수집하지 않습니다/);
    assert.match(notes[1], /비활성 vCenter 1곳\(수집하지 않음\): VC-O/);
    assert.doesNotMatch(csv, /\((unreachable|pending|disabled)\)/, `${p} 영문 사유 코드`);
  }
  // 비활성만 빠졌으면 '읽지 못한' 을 말하지 않는다(화면 배너가 빈 것과 같은 기준)
  setVcs(VCS.filter((v) => v.id === 'vc-a' || v.id === 'vc-o'), '2026-10-19T03:32:00.000Z');
  for (const { path: p, noun } of JUDGE) {
    const j = await getJson(p);
    assert.equal(notReadJudgeNote(j.notReadVcenters, noun), '');
    const csv = await getText(p + '.csv');
    assert.doesNotMatch(csv, /읽지 못한|합계/, `${p}.csv`);
    assert.match(csv, /비활성 vCenter 1곳\(수집하지 않음\): VC-O/);
  }
});

test('③ 실제 라우터 — 합계 화면 CSV(코어 라이선스·비용 배분·이전 준비도)는 그대로 \'합계는 하한\'(과잉 수정 방지)', async () => {
  setVcs(VCS, '2026-10-19T03:33:00.000Z');
  for (const p of TOTAL) {
    const csv = await getText(p + '.csv');
    const notes = noteLines(csv);
    assert.ok(notes.some((l) => /읽지 못한 vCenter 2곳 — .* · 합계는 하한: /.test(l)), `${p}.csv: ${notes.join(' | ')}`);
    assert.doesNotMatch(csv, /판정 결과는 이 목록에 없음/, `${p}.csv 가 판정 목록 문장을 썼다`);
  }
});

test('④ 소스 — 두 판정 목록 라우트는 mode judge 와 화면이 notReadJudgeNote 에 넘기는 명사를 쓴다 · 합계 화면 라우트는 judge 를 쓰지 않는다', () => {
  const SRC = path.resolve(HERE, '../src/routes/api');
  const WEB = path.resolve(HERE, '../../web/src/views');
  for (const { noun, jsx } of JUDGE) {
    const web = fs.readFileSync(path.join(WEB, jsx), 'utf8');
    assert.ok(web.includes(`notReadJudgeNote(data.notReadVcenters, '${noun}')`), `${jsx} 가 명사 '${noun}' 를 쓰지 않는다 — 서버 CSV 와 맞출 것`);
  }
  for (const [f, noun] of [['hostHygiene.js', '호스트'], ['vmHygiene.js', 'VM']]) {
    const src = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.match(src, new RegExp(`notReadCsvLines\\(r\\.notReadVcenters, \\{ mode: 'judge', noun: '${noun}' \\}\\)`), `${f}`);
  }
  for (const f of ['coreLicense.js', 'costShowback.js', 'migrationReadiness.js']) {
    const src = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.doesNotMatch(src, /mode: 'judge'/, `${f} 는 합계 화면이다`);
  }
});
