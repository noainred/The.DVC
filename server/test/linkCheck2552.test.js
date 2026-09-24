/**
 * 통신 점검(v2.552) 회귀 — 사용자 요청 "main 포탈과 edge 포탈의 모든 통신이 정상인지 측정".
 *
 * 고정하는 것(되돌리면 이 테스트가 깨진다):
 *  · 링크 자동 발견 — 설정 문제를 **조용히 빼지 않는다**
 *  · 엣지↔엣지는 **전량 자동 생성 금지**(짝만)
 *  · 단계 판정 — 미시도를 실패로 세지 않고, 실패 단계와 도달 단계를 구분
 *  · 첫 점검은 `first`(복구가 아니다) · 상세는 실패·상태변화만
 *  · 엣지 보고는 **자기 것만**(남의 법인·중앙 측정분 거부)
 *  · 토큰 없음은 '인증 실패' 가 아니라 `skip`
 *  · DB 파일 권한 0600 · prune 스로틀 `(++tick % N)`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * ⚠ 저장소 `server/config` 오염 방지 — **모듈 import 전에** CONFIG_DIR 을 고정한다.
 *   `config.js` 의 `dbDir` 은 모듈 로드 시 확정되므로 정적 import 로는 늦다(v2.552 자체 검증에서
 *   실제로 `config/link-check.db` 가 생기고 이전 실행의 행이 남아 테스트가 깨졌다).
 */
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcheck-test-'));

const { buildLinks, edgePairs, parseTarget, linkIdOf, publicLink, LINK_KINDS, CENTRAL_KINDS, EDGE_KINDS } = await import('../src/linkcheck/links.js');
const { judge, failKindOfCode, summaryText, fixHint, slowestPhase, PHASES, FAIL_KINDS } = await import('../src/linkcheck/phases.js');
const { specFor } = await import('../src/linkcheck/run.js');
const { normalizeSettings, DEFAULTS } = await import('../src/linkcheck/settings.js');

const SRC = (p) => fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
/** 주석을 지운 뒤 소스를 검사한다 — 주석에 규칙을 적어 둔 것이 통과 근거가 되면 안 된다(v2.535 규약). */
// v2.574: 지역 정규식 판본은 **줄 주석 안의 슬래시+별 조합**에 걸려 코드를 통째로 지운다
// (실제 사례 `agent/configPush.js:34`). 공용 상태기계 코어를 쓴다 — `_stripComments.js` 머리말.
import { stripComments } from './_stripComments.js';

test('링크 자동 발견 — 종류별로 나오고 설정 문제를 조용히 빼지 않는다', () => {
  const out = buildLinks({
    collectors: [
      { id: 'GM1', name: 'GM1', url: 'https://10.1.1.1:4000', token: 'x' },
      { id: 'HB', name: 'HB', url: 'nonsense://', token: 'y' },
    ],
    vcenters: [
      { id: 'vc-a', name: 'A', host: 'https://vca.example', collectMode: 'direct' },
      { id: 'vc-b', name: 'B', host: 'vcb.example', collectMode: 'site', remoteAgent: 'GM1' },
      { id: 'vc-c', name: 'C', host: 'vcc.example', collectMode: 'site' },     // 담당 엣지 없음
    ],
    pairs: [{ from: 'GM1', to: 'HB' }],
    settings: {},
  });
  const kinds = new Set(out.links.map((l) => l.kind));
  assert.ok(kinds.has('central->edge'));
  assert.ok(kinds.has('central->vcenter'));
  assert.ok(kinds.has('edge->central'));
  assert.ok(kinds.has('edge->central-pull'));
  assert.ok(kinds.has('edge->vcenter'));
  assert.ok(kinds.has('edge->edge'));
  // 잘못된 url · 담당 엣지 미지정이 **problems 로 드러난다**
  assert.ok(out.problems.length >= 2, `problems=${out.problems.length}`);
  assert.ok(out.problems.some((p) => /url|host/.test(p.reason)));
  assert.ok(out.problems.some((p) => /remoteAgent/.test(p.reason)));
  assert.equal(out.counts.total, out.links.length);
});

test('엣지↔엣지는 전량 자동 생성하지 않는다 — 짝이 없으면 0개', () => {
  assert.equal(edgePairs([], ['a', 'b', 'c']).length, 0);
  const p = edgePairs([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'a', to: 'a' }, { from: 'a', to: 'zz' }], ['a', 'b']);
  assert.equal(p.length, 2);                       // 중복·자기참조 제거
  assert.equal(p[1].unknownTo, true);              // 등록부에 없는 이름은 버리지 않고 표시
  // 소스에도 전량 생성이 없어야 한다
  const src = stripComments(SRC('linkcheck/links.js'));
  assert.ok(!/for \(const a of agents\)[\s\S]{0,200}for \(const b of agents\)/.test(src), '전 조합(full mesh) 생성 금지');
});

test('parseTarget — 포트 기본값과 실패 사유', () => {
  assert.deepEqual(parseTarget('https://h').port, 443);
  assert.deepEqual(parseTarget('http://h').port, 80);
  assert.equal(parseTarget('h:9443').port, 9443);
  assert.ok(parseTarget('').bad);
  assert.ok(parseTarget('https://h:99999').bad);
  assert.equal(linkIdOf('k', 'a', 'b'), 'k|a|b');
});

test('링크에는 자격증명이 담기지 않는다(publicLink 화이트리스트)', () => {
  const l = publicLink({ id: 'x', token: 'SECRET', password: 'p', host: 'h', kind: 'central->edge' });
  assert.equal(l.token, undefined);
  assert.equal(l.password, undefined);
  assert.equal(l.host, 'h');
  // 링크 생성 자체가 token 을 싣지 않는다
  const out = buildLinks({ collectors: [{ id: 'A', name: 'A', url: 'https://a', token: 'SECRET' }], settings: {} });
  assert.ok(!JSON.stringify(out.links).includes('SECRET'));
});

test('judge — 미시도를 실패로 세지 않고 도달 단계를 구분한다', () => {
  const okAll = judge({ dns: { ok: true, ms: 1 }, tcp: { ok: true, ms: 2 }, tls: { ok: true, ms: 9 }, http: { ok: true, ms: 20 }, auth: { ok: true, ms: 0 }, identity: { ok: true, ms: 0 } });
  assert.equal(okAll.ok, true);
  assert.equal(okAll.reached, 'identity');
  assert.equal(okAll.totalMs, 32);

  const failTcp = judge({ dns: { ok: true, ms: 1 }, tcp: { ok: false, ms: 5, failKind: 'refused' } });
  assert.equal(failTcp.ok, false);
  assert.equal(failTcp.phase, 'tcp');
  assert.equal(failTcp.reached, 'tcp');
  assert.equal(failTcp.failKind, 'refused');

  // 아무 단계도 없으면 '정상' 이 아니다
  assert.equal(judge({}).ok, false);
  // 미시도 단계는 0ms 로 합산되지 않는다
  assert.equal(slowestPhase({ dns: { ok: true, ms: 3 }, tcp: { ok: true } }).phase, 'dns');
});

test('failKindOfCode — 코드와 문구 양쪽을 본다', () => {
  assert.equal(failKindOfCode('ECONNREFUSED'), 'refused');
  assert.equal(failKindOfCode('ETIMEDOUT'), 'timeout');
  assert.equal(failKindOfCode('ENOTFOUND'), 'dns-fail');
  // 코드가 비어도 문구로 가른다(undici 는 code 를 안 주는 경우가 있다)
  assert.equal(failKindOfCode('', 'socket hang up'), 'reset');
  // 전 종류에 조치 안내가 있다
  for (const k of Object.keys(FAIL_KINDS)) assert.ok(fixHint(k).length > 0, `${k} 에 조치 안내 없음`);
  // 실패 종류는 모두 PHASES 중 하나에 매여 있다
  for (const [k, v] of Object.entries(FAIL_KINDS)) assert.ok(PHASES.includes(v.phase), `${k}.phase=${v.phase}`);
});

test('summaryText 는 `**` 를 쓰지 않는다(알림·로그로도 나간다)', () => {
  const s = summaryText({ from: 'GM1', to: 'central' }, { ok: false, phase: 'tcp', failKind: 'refused' }, {});
  assert.ok(!s.includes('**'), s);
  const s2 = summaryText({ from: 'a', to: 'b' }, { ok: true }, { dns: { ok: true, ms: 1 } });
  assert.ok(!s2.includes('**'));
});

test('specFor — 토큰 없음은 인증 실패가 아니라 skip 이고, vCenter 에 로그인하지 않는다', () => {
  const noTok = specFor({ kind: 'central->edge', to: 'X', origin: 'https://x' }, { collectors: new Map() });
  assert.ok(noTok.skip);
  assert.ok(/토큰/.test(noTok.skip));

  const vc = specFor({ kind: 'central->vcenter', origin: 'https://vc' }, {});
  assert.ok(vc.url.endsWith('/sdk/vimServiceVersions.xml'));
  assert.equal(vc.headers.Authorization, undefined);
  assert.equal(vc.identifyRaw('<versionId>vim25</versionId>'), null);
  assert.ok(vc.identifyRaw('<html>login page</html>'));
  // 소스에 로그인 호출이 없어야 한다
  const src = stripComments(SRC('linkcheck/run.js'));
  assert.ok(!/RetrieveServiceContent|Login|password/i.test(src), 'vCenter 로그인 금지');

  // 엣지→중앙 은 링크에 주소가 없는 것이 **정상**이다 — '등록 url 을 확인하세요' 로 오안내하지 않는다
  const ec = specFor({ kind: 'edge->central' }, {});
  assert.ok(/CENTRAL_URL/.test(ec.skip), ec.skip);
});

test('중앙/엣지 측정 주체가 갈린다 — 종류 목록이 계약', () => {
  assert.deepEqual([...CENTRAL_KINDS].sort(), ['central->edge', 'central->vcenter']);
  assert.deepEqual([...EDGE_KINDS].sort(), ['edge->central', 'edge->central-pull', 'edge->edge', 'edge->vcenter']);
  for (const k of Object.keys(LINK_KINDS)) assert.ok(['central', 'edge'].includes(LINK_KINDS[k].by));
});

test('설정 — 기본 꺼짐 · 하한/상한 · 짝 정리', () => {
  assert.equal(DEFAULTS.enabled, false);
  assert.equal(normalizeSettings({ enabled: 'true' }).enabled, false, '문자열 truthy 는 켜짐이 아니다');
  assert.equal(normalizeSettings({ intervalMs: 1 }).intervalMs, 60_000, '주기 하한');
  assert.equal(normalizeSettings({ concurrency: 999 }).concurrency, 32);
  assert.deepEqual(normalizeSettings({ pairs: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'x', to: 'x' }] }).pairs, [{ from: 'a', to: 'b' }]);
  assert.deepEqual(normalizeSettings({ kinds: { 'edge->edge': false, 'central->edge': true } }).kinds, { 'edge->edge': false }, '끈 것만 남긴다');
});

test('DB — 첫 점검은 first(복구가 아니다) · 상세는 실패·상태변화만 · 0600', async () => {
  const db = await import('../src/linkcheck/db.js');
  db._resetForTest();
  if (!(await db.available())) { console.warn('node:sqlite 없음 — DB 검사 생략'); return; }

  const link = { id: 'central->edge|central|GM1', kind: 'central->edge', from: 'central', to: 'GM1' };
  const mk = (ts, ok, phase) => ({
    link, ts, verdict: { ok, phase: ok ? 'ok' : phase, failKind: ok ? null : 'refused', reached: phase, totalMs: 10 },
    steps: { dns: { ok: true, ms: 1 }, tcp: { ok, ms: 9 } }, summary: ok ? '정상' : '실패', detail: { x: 1 },
  });
  const t0 = Date.now() - 600_000;
  await db.insertResults([mk(t0, true, 'tcp')], { byNode: 'central' });
  let ev = await db.eventsOf({ limit: 10 });
  assert.equal(ev.rows.length, 1);
  assert.equal(ev.rows[0].event, 'first', '첫 점검을 recovered 라 하지 않는다');

  // 정상이 이어지면 상세를 남기지 않는다
  await db.insertResults([mk(t0 + 1000, true, 'tcp')], { byNode: 'central' });
  ev = await db.eventsOf({ limit: 10 });
  assert.equal(ev.rows.length, 1, '정상 지속은 이벤트를 만들지 않는다');

  await db.insertResults([mk(t0 + 2000, false, 'tcp')], { byNode: 'central' });
  await db.insertResults([mk(t0 + 3000, true, 'tcp')], { byNode: 'central' });
  ev = await db.eventsOf({ limit: 10 });
  const names = ev.rows.map((r) => r.event);
  assert.ok(names.includes('fail-start'));
  assert.ok(names.includes('recovered'));

  // 같은 ts 재적재는 중복으로 세지 않는다(롤업 이중 계산 금지)
  const again = await db.insertResults([mk(t0 + 3000, true, 'tcp')], { byNode: 'central' });
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 1);

  const latest = await db.latestAll();
  assert.equal(latest.length, 1);
  assert.equal(latest[0].ok, 1);
  assert.ok(latest[0].streak >= 1);

  const daily = await db.dailyOf({});
  assert.ok(daily.length >= 1);
  assert.ok(daily[0].n >= 4);
  assert.ok(daily[0].ok_pct != null);

  const st = await db.dbStatus();
  const mode = fs.statSync(st.path).mode & 0o777;
  assert.equal(mode, 0o600, `DB 권한 ${mode.toString(8)}`);
  db._resetForTest();
});

test('엣지 보고는 자기 것만 받는다(남의 법인·중앙 측정분 거부)', async () => {
  const dbm = await import('../src/linkcheck/db.js');
  dbm._resetForTest();
  const { putEdgeLinkReport, edgeLinkReport, _resetEdgeLinkReportsForTest } = await import('../src/central/linkCheckEdge.js');
  _resetEdgeLinkReportsForTest();
  // v2.607(LEFT2607-01): 수신은 '중앙이 그 엣지에 내려준 링크 집합' 도 본다 — 근거인 수집 서버 등록부를 이 테스트 동안만 둔다.
  const colFile = path.join(process.env.CONFIG_DIR, 'collectors.json');
  fs.writeFileSync(colFile, JSON.stringify({ collectors: [{ id: 'GM1', name: 'GM1', url: 'https://10.1.1.1:4000', token: 'x' }, { id: 'HB', name: 'HB', url: 'https://10.1.1.2:4000', token: 'y' }] }));
  try {
  const mk = (id, kind, from) => ({ link: { id, kind, from, to: 'central', host: 'c', port: 443 }, verdict: { ok: true, phase: 'ok', totalMs: 5 }, steps: { tcp: { ok: true, ms: 2 } }, summary: 'x' });
  const out = await putEdgeLinkReport('GM1', { results: [
    mk('edge->central|GM1|central', 'edge->central', 'GM1'),
    mk('edge->central|HB|central', 'edge->central', 'HB'),           // 남의 법인
    mk('central->edge|central|GM1', 'central->edge', 'GM1'),         // 중앙 측정분
    null, 'oops', { link: { id: 'z', kind: 'edge->edge', from: 'GM1', to: 'HB' }, skipped: '짝 없음' },
  ] });
  assert.equal(out.rejected, 4);
  assert.equal(out.skipped, 1);
  assert.ok(out.stored <= 1);
  const rep = edgeLinkReport('GM1');
  assert.equal(rep.stale, false);
  assert.equal(rep.rejected, 4);
  assert.equal(edgeLinkReport('없는엣지'), null);
  // agent 를 본문에서 읽지 않는다(v2.548 F5)
  const src = stripComments(SRC('central/linkCheckEdge.js'));
  assert.ok(!/body\.agent|body\?\.agent/.test(src), '본문 agent 를 쓰지 말 것');
  } finally { fs.rmSync(colFile, { force: true }); }
  dbm._resetForTest();
});

test('폴러 규약 — 재진입 가드 · 동시성 · adaptiveTimer · prune 스로틀', () => {
  const src = stripComments(SRC('linkcheck/poller.js'));
  assert.ok(/let running = false/.test(src), '재진입 가드');
  assert.ok(/if \(running\) return/.test(src));
  assert.ok(/startAdaptiveTimer\(/.test(src));
  assert.ok(!/setInterval\(/.test(src), 'setInterval 금지(주기 변경이 안 먹는다)');
  assert.ok(/\(\+\+tick % 12\) === 0/.test(src), 'prune 스로틀은 (++tick % N) === 0 (기동 첫 틱 즉발 금지)');
  assert.ok(/s\.concurrency/.test(src), '동시성 제한');
  /*
   * ⚠ 측정자 이름을 `'central'` 로 굳히지 말 것 — 이 폴러는 중계 엣지에서도 돈다(자기 하위
   *   수집 서버를 갖는다). 엣지의 측정을 '중앙' 이라 적으면 로그를 보는 사람이 어느 노드에서
   *   안 닿았는지 잘못 판단한다.
   */
  assert.ok(/selfNode\(\)/.test(src), '측정자 이름은 노드 정체로 정한다');
  assert.ok(!/byNode: 'central'/.test(src), "byNode 를 'central' 로 굳히지 말 것");
});

test('엣지 워커는 무음 실패를 만들지 않는다', () => {
  const src = stripComments(SRC('agent/linkCheckWorker.js'));
  assert.ok(/console\.warn/.test(src), '실패를 콘솔에 남긴다');
  assert.ok(/linkCheckWorkerStatus/.test(src), '상태 객체를 남긴다');
  assert.ok(!/catch\s*\{\s*return null;\s*\}/.test(src), 'catch { return null } 금지(v2.549 규약)');
  assert.ok(/startAdaptiveTimer\(/.test(src));
  assert.ok(/status === 413/.test(src), '413 을 로그로 남긴다(조용한 소실 금지)');
});

test('중앙 수신 경로는 BIG_JSON 에 등록돼 있다(413 = 조용한 소실)', () => {
  const src = SRC('index.js');
  assert.ok(src.includes("app.use('/api/central/link-check', BIG_JSON);"), 'link-check 가 BIG_JSON 에 없다');
});

test('점검 API 는 adminOnly + 전체범위만(내부 주소가 담긴다)', () => {
  const src = stripComments(SRC('routes/api/linkCheck.js'));
  const routes = [...src.matchAll(/api\.(get|post|put)\('([^']+)'([^)]*)/g)];
  assert.ok(routes.length >= 6, `라우트 ${routes.length}개`);
  for (const m of routes) {
    assert.ok(/adminOnly/.test(m[3]), `${m[2]} 에 adminOnly 없음`);
    assert.ok(/fullScopeOnly/.test(m[3]), `${m[2]} 에 fullScopeOnly 없음`);
  }
  assert.ok(/logAudit/.test(src), '설정 변경·수동 실행은 감사에 남긴다');
});

test('메인 응답의 settings 에 enabled 가 있고 agents 는 등록부 이름이다', () => {
  /*
   * 둘 다 v2.552 스크린샷 판독으로 잡은 결함이다:
   *  · `enabled` 누락 → 설정 폼이 항상 '꺼짐' 으로 열리고 저장하면 **점검이 조용히 꺼진다**
   *  · agents 를 '보고된 버전 맵' 에서 뽑으면 export 를 준 적 없는 법인이 빠져 **"엣지 0곳"** 이 된다
   */
  const src = stripComments(SRC('routes/api/linkCheck.js'));
  assert.ok(/settings: \{[\s\S]{0,200}enabled: s\.enabled/.test(src), 'settings 에 enabled 가 없다');
  assert.ok(/agents: collectors\.map/.test(src), 'agents 를 등록부에서 뽑아야 한다');
  assert.ok(!/agents: Object\.keys\(versions\)/.test(src));
});

test('undici Agent 에 SSRF lookup 이 핀돼 있다(DNS 리바인딩 — v2.506·v2.537 규약)', () => {
  const src = SRC('linkcheck/checks.js');
  assert.ok(/new Agent\(/.test(src));
  // 이 모듈은 **DNS 단계가 검사한 IP** 로 고정한다(ssrfLookup 과 동등한 효과 — 검사한 주소로 접속)
  // v2.552: 공용 `pinnedLookup(ip)` 로 옮겼다(훅을 파일마다 복제하지 말 것 — v2.537 스윕 규약).
  assert.ok(/lookup: pinnedLookup\(ip\)/.test(src), '검사한 IP 로 접속해야 한다');
  assert.ok(/from '\.\.\/util\/ssrfLookup\.js'/.test(src), '판정은 util/ssrfLookup.js 하나가 소유한다');
  assert.ok(/ipBlockReason/.test(src), '차단 대역 검사');
});

test('도구 등록 — 키·권한·트리·카탈로그가 모두 있다', async () => {
  const { toolCoverage } = await import('../src/auth/toolAccess.js');
  const cov = toolCoverage();
  const undeclared = Array.isArray(cov.undeclared) ? cov.undeclared : [];
  assert.equal(undeclared.length, 0, `미선언 도구: ${undeclared.join(', ')}`);
  const ta = SRC('auth/toolAccess.js');
  assert.ok(ta.includes("'link-check': 'link-check'"), 'toolAccess 매핑 없음');
  const cat = SRC('toolcats/catalog.js');
  assert.ok(cat.includes("'link-check'"), 'toolcats PRESET 없음');
  const loc = SRC('insights/dbLocation.js');
  assert.ok(loc.includes('link-check.db'), 'dbLocation MIGRATABLE 없음');
});
