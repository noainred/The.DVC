/**
 * v2.575 — v2.574 감사에서 남긴 🟡 확정 결함의 회귀 방지.
 *
 * 각 테스트는 '되돌리면 깨지는' 지점을 하나씩 고정한다. 소스를 문자열로 검사하는 것은
 * **주석을 먼저 제거**한 뒤에 한다(규칙을 설명하는 주석이 통과 근거가 되면 안 된다 — v2.535 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (p) => fs.readFileSync(p, 'utf8');
const code = (p) => stripComments(read(p));

/* ── BUG-22: 쿼리 정규화 ──────────────────────────────────────────────── */
const { normalizeQuery } = await import('../src/util/queryNormalize.js');

test('BUG-22 normalizeQuery — 객체는 버리고 배열은 마지막 문자열을 쓴다', () => {
  assert.deepEqual({ ...normalizeQuery({ id: 'x' }) }, { id: 'x' });
  assert.deepEqual({ ...normalizeQuery({ id: { a: '1' } }) }, {}, '객체는 버린다(문자열 변환 금지)');
  assert.deepEqual({ ...normalizeQuery({ id: ['a', 'b'] }) }, { id: 'b' }, '마지막 값(HTTP 관례)');
  assert.deepEqual({ ...normalizeQuery({ id: [{ a: 1 }, 'c'] }) }, { id: 'c' });
  assert.deepEqual({ ...normalizeQuery({ id: [{ a: 1 }] }) }, {}, '문자열 원소가 없으면 키가 없다');
  assert.deepEqual({ ...normalizeQuery(null) }, {});
});

test('BUG-22 normalizeQuery — 프로토타입 오염 키를 버리고 결과는 null 프로토타입이다', () => {
  const out = normalizeQuery(JSON.parse('{"__proto__":{"x":"1"},"ok":"1"}'));
  assert.equal(Object.getPrototypeOf(out), null);
  assert.equal({}.x, undefined, '전역 Object 가 오염되지 않았다');
  assert.equal(out.ok, '1');
});

test('BUG-22 미들웨어는 모든 라우터보다 먼저 마운트돼 있다', () => {
  const s = code(path.join(SRC, 'index.js'));
  const iQuery = s.indexOf('queryNormalizer()');
  assert.ok(iQuery > 0, 'index.js 가 queryNormalizer 를 마운트한다');
  const firstRouter = s.search(/app\.use\(\s*['"]\/api/);
  assert.ok(firstRouter > iQuery, '첫 /api 라우터 마운트보다 앞이어야 한다');
});

/* ── IMP-04: cmpVersion 단일 소스 ─────────────────────────────────────── */
const { cmpVersion } = await import('../src/util/cmpVersion.js');

test('IMP-04 cmpVersion — 숫자 비교, 모르는 것은 null, v 접두 허용', () => {
  assert.equal(cmpVersion('2.10.0', '2.9.0'), 1, '문자열 비교면 2.10 < 2.9 가 된다');
  assert.equal(cmpVersion('2.548.0', '2.548.0'), 0);
  assert.equal(cmpVersion('v2.5', '2.5.0'), 0, 'v 접두와 짧은 세그먼트를 같게 본다');
  assert.equal(cmpVersion('', '1.0.0'), null, '빈 값은 "낮은 버전" 이 아니라 "모름" 이다');
  assert.equal(cmpVersion('dev', '1.0.0'), null);
  assert.equal(cmpVersion('2.x', '1.0.0'), null);
});

test('IMP-04 세 소비 모듈이 같은 구현을 쓴다(사본 0)', async () => {
  const files = ['portalcheck/tokenScan.js', 'routes/api/partFaults.js', 'routes/api/edgeLog.js'];
  for (const f of files) {
    const s = code(path.join(SRC, f));
    assert.ok(/import \{ cmpVersion \} from '[^']*util\/cmpVersion\.js'/.test(s), `${f} 가 단일 소스를 import 한다`);
    assert.ok(!/(?:export )?function cmpVersion\s*\(/.test(s), `${f} 에 자체 구현이 남아 있으면 안 된다`);
  }
  // ⚠ 재수출(`export … from`)은 이 스코프에 이름을 만들지 않는다 — 실제 import 로 동작을 확인한다.
  const a = await import('../src/portalcheck/tokenScan.js');
  const b = await import('../src/routes/api/partFaults.js');
  const c = await import('../src/routes/api/edgeLog.js');
  for (const m of [a, b, c]) assert.equal(m.cmpVersion('2.10.0', '2.9.0'), 1);
});

/* ── IMP-10 / IMP-11: 중복 상수 ───────────────────────────────────────── */
test('IMP-10 REGIONS — 서버·웹 단일 소스가 같은 값이고 사본이 없다', async () => {
  const srv = (await import('../src/util/regions.js')).REGIONS;
  const webSrc = read(path.join(WEB, 'regions.js'));
  const webVals = [...webSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((v) => !v.includes('/'));
  assert.deepEqual(webVals, srv, '웹 사본과 서버 원본의 값이 같아야 한다(번들 경계라 복사가 불가피)');
  // 인라인 사본이 남아 있으면 안 된다.
  const sweep = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|jsx)$/.test(e.name)) continue;
        if (p.endsWith(`${path.sep}regions.js`)) continue;
        if (/\['아시아',\s*'중국'/.test(code(p))) out.push(p);
      }
    };
    walk(root); return out;
  };
  assert.deepEqual([...sweep(SRC), ...sweep(WEB)], [], '지역 목록 인라인 사본 0');
});

test('IMP-11 SITE_STALE_MS — store.js 가 소유하고 portalCheck 가 그것을 쓴다', async () => {
  const { SITE_STALE_MS } = await import('../src/store.js');
  assert.ok(Number.isFinite(SITE_STALE_MS) && SITE_STALE_MS > 0);
  const s = code(path.join(SRC, 'routes/api/portalCheck.js'));
  assert.ok(/import \{[^}]*SITE_STALE_MS[^}]*\} from '\.\.\/\.\.\/store\.js'/.test(s));
  assert.ok(!/const SITE_STALE_MS\s*=/.test(s), '자체 정의가 남아 있으면 기준이 조용히 갈린다');
});

/* ── IMP-08: 동시성 풀 코어 ───────────────────────────────────────────── */
test('IMP-08 poolSettled/poolRun — 오류 의미가 이름으로 갈린다', async () => {
  const { poolSettled, poolRun } = await import('../src/util/pool.js');
  const r = await poolSettled([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('b'); return x; });
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled'], '한 항목이 던져도 나머지는 끝까지 돈다');
  assert.equal(r[0].value, 1);
  assert.deepEqual(await poolSettled([], 4, async () => 1), [], '빈 배열이면 워커를 만들지 않는다');
  await assert.rejects(() => poolRun([1, 2], 2, async (x) => { if (x === 2) throw new Error('up'); }), /up/);
  let n = 0; await poolRun([1, 2, 3], 1, async () => { n += 1; });
  assert.equal(n, 3, 'limit 이 1이어도 전부 돈다');
});

/* ── BUG-13: 표 머리글 대문자 누출 ────────────────────────────────────── */
test('BUG-13 앱 텍스트를 담는 선택자에 text-transform: uppercase 가 없다', () => {
  // Chromium 전수 판독(1440px · 9화면)에서 실제로 샌 11건의 출처다 —
  // thead th(vCenter·Cores) · .kpi .label(ESXi·vCore·vCPU) · .sb-label(Uptime) ·
  // .section-title(vCenter별 …) · .collector-diag-path-label(수집 서버(edge)).
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const SELECTORS = ['thead th', '.kpi .label', '.statusbar .sb-label', '.section-title', '.collector-diag-path-label'];
  for (const sel of SELECTORS) {
    const re = new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'm');
    const m = css.match(re);
    assert.ok(m, `${sel} 규칙이 있어야 한다`);
    assert.ok(!/text-transform:\s*uppercase/.test(m[0]),
      `${sel} — 제품명·단위의 대소문자는 정보다. 개별 라벨을 한글로 바꾸는 우회로 되돌리지 말 것`);
  }
});

/* ── BUG-19 / BUG-23: STable limit·minWidth ───────────────────────────── */
test('BUG-19/23 STable 이 limit(정렬 뒤 자르기)과 minWidth(+스크롤 래퍼)를 갖는다', () => {
  const s = code(path.join(WEB, 'components/STable.jsx'));
  assert.ok(/limit = 0/.test(s) && /minWidth = 0/.test(s), 'props 선언');
  assert.ok(/overflowX: 'auto'/.test(s), 'minWidth 를 주면 래퍼도 함께 만든다(짝을 놓칠 수 없게)');
  // 정렬 결과에 상한을 적용해야 한다 — 호출부가 먼저 자르면 '앞 N 을 정렬한 것' 이 된다.
  const iSort = s.indexOf('sortedKids');
  const iCap = s.indexOf('capKids(bodyKids)');
  assert.ok(iSort > 0 && iCap > iSort);
});

test('BUG-19 tbody 안에서 먼저 자르는 호출부가 없다', () => {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsx')) continue;
      const lines = code(p).split('\n');
      lines.forEach((l, i) => {
        if (!/\.slice\(0,\s*\d+\s*\)\s*\.map\(/.test(l)) return;
        const ctx = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        if (ctx.includes('<tbody>') && !l.includes('<td')) bad.push(`${path.relative(WEB, p)}:${i + 1}`);
      });
    }
  };
  walk(WEB);
  assert.deepEqual(bad, [], 'STable 의 limit 을 쓸 것(정렬 뒤 자르기)');
});

test('IMP-05 웹에 raw <table> 이 남아 있지 않다(DataTable 자체 구현만 예외)', () => {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsx')) continue;
      // STable/DataTable 은 `<table>` 을 **만드는** 구현이므로 당연히 예외다.
      if (/[\\/](primitives|STable|STable\.test)\.jsx$/.test(p)) continue;
      if (/<table[\s>]/.test(code(p))) bad.push(path.relative(WEB, p));
    }
  };
  walk(WEB);
  assert.deepEqual(bad, [], '사용자 상시 요구: 모든 표는 제목 클릭 정렬(v2.422)');
});

/* ── BUG-20: 값 없는 칸에 단위 ────────────────────────────────────────── */
test('BUG-20 unitText — 값이 없으면 단위를 붙이지 않는다', async () => {
  const { unitText, isBlank } = await import('../../web/src/views/unitText.js');
  assert.equal(unitText(null, '℃'), '—');
  assert.equal(unitText('', ' MB'), '—');
  assert.equal(unitText(NaN, '%'), '—');
  assert.equal(unitText([], '%'), '—', 'Number([])===0 함정');
  assert.equal(unitText(0, '℃'), '0℃', '0 은 값이다');
  assert.equal(unitText(23, '℃'), '23℃');
  assert.equal(isBlank('—'), true, '이미 대시면 값이 없는 것');
});

test("BUG-20 `?? '—'` 뒤에 단위를 잇는 패턴이 없다", () => {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx)$/.test(e.name)) continue;
      code(p).split('\n').forEach((l, i) => {
        if (/'—'\s*\}\s*(?:℃|%|GB|TB|MB|ms|개|대|건)/.test(l)) bad.push(`${path.relative(WEB, p)}:${i + 1}`);
      });
    }
  };
  walk(WEB);
  assert.deepEqual(bad, [], 'unitText() 를 쓸 것 — `— ℃` 는 0℃ 처럼 읽힌다');
});

/* ── BUG-16: Ping 빈 상태 사유 ────────────────────────────────────────── */
test('BUG-16 pingEmptyReason — 기다려도 안 되는 경우를 기다리라고 말하지 않는다', async () => {
  const { pingEmptyReason } = await import('../../web/src/views/pingEmptyText.js');
  const off = pingEmptyReason({ monitorEnabled: false, target: { enabled: true } });
  assert.equal(off.kind, 'monitor-off'); assert.equal(off.waiting, false);
  const dis = pingEmptyReason({ monitorEnabled: true, target: { enabled: false } });
  assert.equal(dis.kind, 'target-disabled'); assert.equal(dis.waiting, false);
  const oor = pingEmptyReason({ monitorEnabled: true, target: { enabled: true }, lastTs: 1000, rangeMs: 3600_000, now: 9_000_000 });
  assert.equal(oor.kind, 'out-of-range'); assert.equal(oor.waiting, false);
  const first = pingEmptyReason({ monitorEnabled: true, target: { enabled: true }, intervalMs: 60_000 });
  assert.equal(first.kind, 'first'); assert.equal(first.waiting, true);
  assert.ok(first.text.includes('1분'), '주기는 서버 값으로 말한다(숫자 하드코딩 금지)');
  // 판정 순서 — 폴러가 꺼져 있으면 대상 활성 여부보다 먼저다.
  assert.equal(pingEmptyReason({ monitorEnabled: false, target: { enabled: false } }).kind, 'monitor-off');
  for (const k of ['monitor-off', 'target-disabled', 'out-of-range', 'first']) {
    const r = pingEmptyReason(k === 'monitor-off' ? { monitorEnabled: false } : { monitorEnabled: true, target: { enabled: k !== 'target-disabled' }, lastTs: k === 'out-of-range' ? 1000 : null, rangeMs: 3600_000, now: 9_000_000 });
    assert.ok(!r.text.includes('`'), '문구에 백틱 금지(BoldText 는 **강조** 만 해석한다)');
  }
});

test('BUG-16 서버가 monitorEnabled·intervalMs·rangeMs 를 싣고 scope 응답도 보존한다', () => {
  const svc = code(path.join(SRC, 'ping/service.js'));
  assert.ok(/monitorEnabled: !!config\.ping\.enabled/.test(svc));
  assert.ok(/intervalMs: config\.ping\.pollIntervalMs/.test(svc));
  assert.ok(/bucketMs, rangeMs, series/.test(svc), 'seriesOf 가 rangeMs 를 돌려준다');
  const rt = code(path.join(SRC, 'routes/ping.js'));
  assert.ok(/res\.json\(\{ \.\.\.r, targets, counts/.test(rt), '범위 계정 응답에서도 필드를 보존한다');
});

/* ── Phase② 전수 재감사 확정분 ───────────────────────────────────────── */

test('NEW-01 acquireExport — 동시 1건만 통과하고 409 사유를 준다(계정명은 본인일 때만)', async () => {
  const { acquireExport, exportBusyOf, _resetExportBusy } = await import('../src/util/exportBusy.js');
  _resetExportBusy();
  const a = acquireExport('x', { user: { username: 'alice' } });
  assert.equal(a.ok, true);
  const b = acquireExport('x', { user: { username: 'bob' } });
  assert.equal(b.ok, false); assert.equal(b.status, 409); assert.equal(b.body.error, 'export_busy');
  assert.ok(b.body.reason.includes('다른 사용자'), '남의 계정명을 밝히지 않는다(v2.500 감사 L-2)');
  const mine = acquireExport('x', { user: { username: 'alice' } });
  assert.ok(mine.body.reason.includes('내 요청'));
  assert.equal(acquireExport('y', {}).ok, true, '이름이 다르면 서로 막지 않는다');
  a.release();
  assert.equal(exportBusyOf('x'), null);
  assert.equal(acquireExport('x', {}).ok, true, 'release 후 다시 잡힌다');
  a.release(); // 두 번 불러도 남의 점유를 풀지 않는다
  assert.ok(exportBusyOf('x'), '이미 푼 토큰의 release 가 새 점유를 깨면 안 된다');
  _resetExportBusy();
});

test('NEW-01 무거운 내보내기 라우트는 예외 없이 acquireExport 를 쓴다', () => {
  // exceljs 는 워크북을 통째로 메모리에 만든다 — 가드 없는 라우트는 동시 요청으로 프로세스를 죽인다
  // (v2.575 실측: 동시 5개에 RSS 728MB→2.45GB, 퍼징 중 8GB 힙 한계에서 프로세스 사망).
  for (const f of ['routes/api/ipamExport.js', 'routes/api/toolsCapacity.js']) {
    const s = code(path.join(SRC, f));
    if (!/wb\.xlsx\.(write|writeBuffer)\(/.test(s)) continue;
    assert.ok(/acquireExport\(/.test(s), `${f} 가 동시 1건 가드를 쓴다`);
    assert.ok(/lock\.release\(\)/.test(s) && /finally/.test(s), `${f} 는 finally 에서 푼다`);
  }
  // 사본 금지 — 예전 인라인 구현(wasteExportBusy)이 되살아나면 안 된다.
  const tc = code(path.join(SRC, 'routes/api/toolsCapacity.js'));
  assert.ok(!/let wasteExportBusy/.test(tc));
});

test('NEW-02 웹 numOrNull — 서버 구현과 같은 판정이다', async () => {
  const srv = (await import('../src/util/numOrNull.js')).numOrNull;
  const web = (await import('../../web/src/numOrNull.js')).numOrNull;
  for (const v of [null, undefined, '', '  ', 0, '0', 5, '5', -1.5, NaN, Infinity, [], [5], {}, true, false, 'abc']) {
    assert.equal(web(v), srv(v), `입력 ${JSON.stringify(v)} 판정이 갈리면 안 된다`);
  }
  assert.equal(web(null), null); assert.equal(web(0), 0);
});

test('NEW-02 연결 끊긴 호스트는 vCenter 개요에서 0 이 아니라 null 이다', async () => {
  const { buildOverviewRows } = await import('../../web/src/views/vcdOverview.js');
  const hosts = [{ name: 'esx-disc', cluster: 'C1', connectionState: 'DISCONNECTED', cpuCores: 32, cpuThreads: 64, memTotalMB: 131072, cpuUsagePct: null, memUsagePct: null, vmCount: 0, powerWatts: null, tempC: null }];
  const h = buildOverviewRows({ site: { id: 'vc1', name: 'VC1' }, hosts, vms: [], metrics: {} }).find((r) => r.level === '호스트');
  assert.equal(h.tempC, null, '흡기온도 0℃ 라는 거짓을 만들지 않는다');
  assert.equal(h.cpuPct, null);
  assert.equal(h.memPct, null);
});

test('NEW-03 재지 않는 노드 처리량은 0 bps 가 아니라 —', async () => {
  const sn = await import('../../web/src/views/tools/storageNodeText.js');
  // Unity·VPLEX·PowerStore 수집기는 이 값을 재지 않아 **명시적으로 null** 을 보낸다.
  const r = sn.nodeRows({ nodes: { list: [{ id: 1, health: 'OK', inBps: null, outBps: null, hdd: null, ssd: null, name: 'SPA' }] } })[0];
  assert.equal(r.inBps, null); assert.equal(r.outBps, null);
  assert.equal(sn.bpsText(r.inBps), '—', "'트래픽 없음' 이라는 거짓 금지");
  assert.equal(sn.bpsText(0), '0 bps', '진짜 0 은 0 이다');
  assert.equal(sn.nodeRows({ nodes: { list: [{ id: 1, hdd: { pct: null } }] } })[0].hddPct, null);
});
