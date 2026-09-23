/**
 * v2.583 — 설정 › Log › 로그 분석(개선점 도출). 사용자 요청: "지금 분석하고 있는 로그를 분석해서 개선점
 * 도출할 수 있는 메뉴와 기능을 설정에 만들어줘" — 그 로그는 폐쇄망 중앙 서버의 서비스 저널이었다.
 * 고정하는 것:
 *  ① 형식 해석(저널 기본·short-iso·원문·스택 연속 줄) ② 규칙 카탈로그의 정직성(샘플이 맞고, 문구가 소스에 있다)
 *  ③ 개선점(규칙·HTTP·미분류·잡음) ④ 누적 집계(시간 버킷·합치기·유계·영속·손상 시 상태에 밝힘)
 *  ⑤ 저널 읽기 실패를 '로그 없음' 으로 말하지 않는다 ⑥ 라우트 권한·8MB 상한·BIG_JSON 등록
 *  ⑦ 로그 탭이 재귀·예외로 로그 경로를 막지 않는다.
 * 샘플의 이름은 전부 합성값이다(공개 저장소).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loga-'));
process.env.CONFIG_DIR = tmp;

const P = await import('../src/loganalysis/parse.js');
const T = await import('../src/loganalysis/template.js');
const E = await import('../src/loganalysis/engine.js');
const RL = await import('../src/loganalysis/rules.js');
const L = await import('../src/loganalysis/live.js');
const J = await import('../src/loganalysis/journal.js');
const IDX = await import('../src/loganalysis/index.js');
const SRC = new URL('../src/', import.meta.url);
const ROOT = new URL('../../', import.meta.url);

test('① 저널 기본·short-iso·원문을 읽고, 스택 줄은 연속으로 붙인다(오류 1건이 수십 건이 되지 않게)', () => {
  const text = [
    '-- Logs begin at Mon 2026-09-21 --',
    'Sep 23 11:15:13 host-a node[2372]: [gpu-guest]   ✗ vm-a01: SSH 수집 실패: SSH 타임아웃(IP 미도달/방화벽)',
    '2026-09-23T11:15:14+0900 host-a node[2372]: [collector] edge-a pull 실패(1): fetch failed',
    'Sep 23 11:15:15 host-a node[2372]: [fatal] uncaughtException (계속 실행): TypeError: x',
    'Sep 23 11:15:15 host-a node[2372]:     at foo (/opt/x.js:1:1)',
    '    at bar (/opt/y.js:2:2)',
    '[central] agent-config 수신: agent=edge-b (14개)',
    '',
  ].join('\n');
  const p = P.parseText(text);
  assert.equal(p.items.length, 4);
  assert.equal(p.continuation, 2);
  assert.equal(p.items[0].tsRaw, 'Sep 23 11:15:13');
  assert.equal(p.items[0].host, 'host-a');
  assert.equal(p.items[1].ts, Date.parse('2026-09-23T11:15:14+09:00'));
  assert.equal(p.items[3].tsRaw, '', '원문은 시각이 없다 — 지어내지 않는다');
  assert.ok(p.items.every((x) => x.level === 'unknown'), '저널에는 수준이 없다 — 지어내지 않는다');
  const cut = P.parseText('a\nb\nc\nd', { maxLines: 2 });
  assert.equal(cut.dropped, 2);
  assert.deepEqual(cut.items.map((x) => x.msg), ['c', 'd'], '상한이면 최근(뒤쪽)을 남긴다');
});

test('② 템플릿 — 값만 가리고 문장 뼈대는 남긴다 · HTTP 줄은 라우트로', () => {
  assert.equal(T.tagOf('[gpu-guest] x'), 'gpu-guest');
  assert.equal(T.templateOf('[gpu-guest]   ✗ vm-a01: SSH 수집 실패: SSH 타임아웃(IP 미도달/방화벽)'), T.templateOf('[gpu-guest]   ✗ other-vm-77: SSH 수집 실패: SSH 타임아웃(IP 미도달/방화벽)'));
  assert.equal(T.templateOf('[central] gpu-guest-data 수신: agent=A hosts=11 vms=40'), T.templateOf('[central] gpu-guest-data 수신: agent=B hosts=0 vms=0'));
  assert.deepEqual(T.parseHttp('GET /api/vms/123 500 12ms #wab-1'), { method: 'GET', route: '/api/vms/:id', status: 500, ms: 12, rid: 'wab-1' });
  assert.equal(T.parseHttp('[x] GET /api/x 200 5ms'), null, '태그 붙은 줄은 요청 줄이 아니다');
  assert.equal(T.parseHttp('GET /api/x 200 5ms').rid, '', '구버전 줄(#ID 없음)도 읽는다');
});

test('② 규칙 카탈로그 — 샘플이 자기 규칙에 맞고, 문구가 실제 소스에 있다(문구가 바뀌어 규칙이 조용히 죽지 않게)', () => {
  const rules = IDX.activeRules();
  assert.ok(rules.length >= RL.CORE_RULES.length);
  const idx = E.indexRules(rules);
  for (const r of rules) {
    assert.ok(r.sample, `${r.id}: sample 필요`);
    assert.ok(r.re.test(r.sample), `${r.id}: 샘플이 정규식에 맞지 않는다`);
    // 한 줄은 첫 번째로 맞는 규칙 하나 — 샘플은 자기 규칙에 떨어져야 한다
    const st = E.newState();
    E.addItem(st, { msg: r.sample, level: 'unknown' }, idx);
    assert.ok(st.rules[r.id], `${r.id}: 샘플이 다른 규칙(${Object.keys(st.rules).join(',')})에 먼저 잡힌다 — 순서를 고칠 것`);
    assert.ok(r.src && r.probe, `${r.id}: src·probe 필요`);
    const src = fs.readFileSync(new URL(r.src, ROOT), 'utf8');
    assert.ok(src.includes(r.probe), `${r.id}: ${r.src} 에 '${r.probe}' 가 없다 — 로그 문구가 바뀌었다`);
    assert.ok(RL.SEVERITY_RANK[r.severity], `${r.id}: 심각도`);
    assert.ok(!/`/.test(`${r.title}${r.meaning}${r.action}`), `${r.id}: 화면 문구에 백틱 금지(BoldText 가 글자로 샌다)`);
    if (r.link) assert.match(r.link, /^#\/(settings|tools)\/[a-z0-9-]+$/, `${r.id}: link 형식`);
  }
});

test('② 규칙 link 가 실제 화면 키를 가리킨다(설정 SUB · 특수기능 카탈로그)', () => {
  const settings = fs.readFileSync(new URL('web/src/views/Settings.jsx', ROOT), 'utf8');
  const tools = fs.readFileSync(new URL('web/src/views/specialToolsList.js', ROOT), 'utf8');
  for (const r of IDX.activeRules().filter((x) => x.link)) {
    const [, kind, key] = /^#\/(settings|tools)\/(.+)$/.exec(r.link);
    const ok = kind === 'settings' ? settings.includes(`k: '${key}'`) : tools.includes(`'${key}'`);
    assert.ok(ok, `${r.id}: ${r.link} 는 없는 화면이다`);
  }
});

test('③ 개선점 — 규칙(대상별 개수)·HTTP 5xx/413·미분류(키워드 추정 밝힘)·잡음', async () => {
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`[central] gpu-guest-data 수신: agent=edge-${i % 5} hosts=0 vms=0`);
  lines.push("[collector] edge-old 정체 불일치: 이 URL 에 응답한 엣지는 'EDGE-A'(h) 인데 등록 항목은 'edge-old' 입니다");
  lines.push("[collector] edge-old 정체 불일치: 이 URL 에 응답한 엣지는 'EDGE-A'(h) 인데 등록 항목은 'edge-old' 입니다");
  lines.push('[gpu-guest]   ✗ vm-01: SSH 수집 실패: SSH 인증 실패(계정/비번 또는 비밀번호 로그인 비활성)');
  lines.push('GET /api/tools/x/12 500 30ms #wq-1');
  lines.push('POST /api/central/inventory 413 5ms');
  lines.push('[newthing] 무엇이든 실패했습니다: 이유');
  const r = await IDX.analyzePaste(lines.join('\n'));
  const f = Object.fromEntries(r.findings.map((x) => [x.id, x]));
  assert.equal(f['collector-identity-mismatch'].count, 2);
  assert.deepEqual(f['collector-identity-mismatch'].entities, [{ name: 'edge-old', count: 2 }]);
  assert.equal(f['gpu-guest-ssh-auth'].entities[0].name, 'vm-01');
  assert.equal(f['http-5xx'].entities[0].name, 'GET /api/tools/x/:id → 500');
  assert.equal(f['http-5xx'].entities[0].rid, 'wq-1', '최대 지연 요청의 ID 로 서버 기록을 찾게');
  assert.equal(f['http-413'].severity, 'high');
  assert.ok(f.unclassified.entities.some((e) => e.tag === 'newthing' && e.guessed), '수준 없는 원천은 추정임을 밝힌다');
  assert.match(f.unclassified.meaning, /추정/);
  assert.equal(f['central-gpu-empty'].severity, 'info');
  assert.ok(f.noise && f.noise.entities[0].sharePct > 50, '반복 정상 기록은 잡음으로 밝힌다');
  assert.equal(r.findings[0].severity, 'high', '심각도 순');
  assert.equal(r.coverage.lines, lines.length);
});

test('③ 수준이 있는 원천(링 버퍼)은 추정하지 않는다 — info 의 실패 문구는 미분류 문제가 아니다', async () => {
  const r = await IDX.analyzeBuffer([
    { id: 1, time: Date.now(), level: 'info', msg: '[x] 실패 횟수 0' },
    { id: 2, time: Date.now(), level: 'warn', msg: '[y] 뭔가 이상' },
  ]);
  const u = r.findings.find((x) => x.id === 'unclassified');
  assert.equal(u.count, 1);
  assert.equal(u.entities[0].guessed, false);
  assert.doesNotMatch(u.meaning, /추정/);
});

test('④ 누적 — 시간 버킷에 쌓고 합치며, 탭이 로그 경로를 막지 않는다 · 영속·복원', async () => {
  L._resetLiveForTest();
  const st = L.startLiveAnalysis(IDX.activeRules());
  assert.equal(st.enabled, true);
  const H = 3_600_000;
  const now = Date.now();
  L.ingest({ ts: now - 3 * H, level: 'warn', msg: "[collector] edge-x 정체 불일치: 이 URL 에 응답한 엣지는 'E'(h) 인데 등록 항목은 'edge-x' 입니다" });
  L.ingest({ ts: now, level: 'warn', msg: "[collector] edge-x 정체 불일치: 이 URL 에 응답한 엣지는 'E'(h) 인데 등록 항목은 'edge-x' 입니다" });
  // 실제 로그 경로(console.warn → 링 버퍼 탭)로도 들어온다
  console.warn('[collector] edge-y pull 실패(3): fetch failed');
  const r1 = IDX.analyzeLive(1);
  const r6 = IDX.analyzeLive(6);
  const id1 = r1.findings.find((x) => x.id === 'collector-identity-mismatch');
  assert.equal(id1.count, 1, '1시간 구간에는 최근 것만');
  assert.equal(r6.findings.find((x) => x.id === 'collector-identity-mismatch').count, 2);
  assert.ok(r6.findings.find((x) => x.id === 'collector-pull-fail'), 'console.warn 이 탭으로 들어왔다');
  assert.equal(r6.coverage.source, 'live');
  assert.ok(L.saveLive(), '저장');
  assert.ok(fs.existsSync(path.join(tmp, 'log-analysis-stats.json')));
  L._resetLiveForTest();
  L.startLiveAnalysis(IDX.activeRules());
  assert.equal(IDX.analyzeLive(6).findings.find((x) => x.id === 'collector-identity-mismatch').count, 2, '재시작 뒤 복원');
  L._resetLiveForTest();
});

test('④ 손상 파일은 새로 시작하되 상태에 밝힌다(재생성 가능한 통계 — 조용히 넘기지 않는다)', () => {
  L._resetLiveForTest();
  fs.writeFileSync(path.join(tmp, 'log-analysis-stats.json'), '{bad json');
  const st = L.startLiveAnalysis(IDX.activeRules());
  assert.ok(st.loadError, '손상 사실이 상태에 남는다');
  L._resetLiveForTest();
  fs.rmSync(path.join(tmp, 'log-analysis-stats.json'), { force: true });
});

test('④ 유계 — 지난 버킷은 줄이고, 템플릿·대상 상한을 넘은 것은 개수로 밝힌다', () => {
  const st = E.newState();
  const idx = E.indexRules(IDX.activeRules());
  for (let i = 0; i < E.CAPS.tmpl + 50; i++) E.addItem(st, { msg: `[t${i}] x`, level: 'info' }, idx);
  assert.equal(Object.keys(st.tmpl).length, E.CAPS.tmpl);
  assert.equal(st.overflow.tmpl, 50);
  E.compactState(st, { tmpl: 10 });
  assert.equal(Object.keys(st.tmpl).length, 10);
  assert.equal(st.overflow.tmpl, 50 + E.CAPS.tmpl - 10, '버린 줄 수를 잃지 않는다');
});

test('⑤ 저널 — journalctl 이 없거나 권한이 없으면 사유를 준다(빈 결과를 로그 없음이라 말하지 않는다)', async () => {
  const none = await J.readJournal({ hours: 1, bin: '/nonexistent/journalctl-x', onItem: () => {} });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-journalctl');
  // 권한 없음 흉내 — 종료코드 0 · 빈 출력 · 경고 한 줄
  const fake = path.join(tmp, 'fake-journalctl.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "No journal files were opened due to insufficient permissions." 1>&2\nexit 0\n', { mode: 0o755 });
  const perm = await J.readJournal({ hours: 1, bin: fake, onItem: () => {} });
  assert.equal(perm.ok, false);
  assert.equal(perm.reason, 'permission');
  const nof = path.join(tmp, 'fake-journalctl-nofiles.sh');
  fs.writeFileSync(nof, '#!/bin/sh\necho "No journal files were found." 1>&2\necho "-- No entries --"\nexit 0\n', { mode: 0o755 });
  const nofR = await J.readJournal({ hours: 1, bin: nof, onItem: () => {} });
  assert.equal(nofR.reason, 'no-journal', "'파일 없음' 을 '권한 없음' 으로 말하지 않는다(조치가 다르다)");
  const ok = path.join(tmp, 'fake-journalctl-ok.sh');
  fs.writeFileSync(ok, '#!/bin/sh\necho "2026-09-23T11:15:13+0900 h node[1]: [collector] edge-a pull 실패(1): x"\necho "2026-09-23T11:15:14+0900 h node[1]:     at foo (x.js:1:1)"\n', { mode: 0o755 });
  const got = [];
  const r = await J.readJournal({ hours: 1, bin: ok, onItem: (x) => got.push(x) });
  assert.equal(r.ok, true);
  assert.equal(r.lines, 1);
  assert.equal(r.continuation, 1);
  assert.equal(got[0].msg, '[collector] edge-a pull 실패(1): x');
  assert.match(J.journalUnit(), /^[A-Za-z0-9@._:-]+$/);
});

test('⑥ 라우트 — adminOnly + 전체 범위 · 붙여넣기 BIG_JSON 등록 · 8MB 상한 · 비동기 throw 가 매달리지 않게 감싼 라우터', () => {
  const route = fs.readFileSync(new URL('routes/admin/logAnalysis.js', SRC), 'utf8');
  for (const m of route.matchAll(/adminRouter\.(get|post)\('([^']+)',\s*([^,]+),\s*([^,]+),/g)) {
    assert.equal(m[3].trim(), 'adminOnly', `${m[2]}: adminOnly`);
    assert.equal(m[4].trim(), 'fullScopeOnly', `${m[2]}: 전체 범위`);
  }
  assert.match(route, /PASTE_MAX_BYTES = 8 \* 1048576/);
  const idx = fs.readFileSync(new URL('index.js', SRC), 'utf8');
  assert.ok(idx.includes("app.use('/api/admin/log-analysis/paste', BIG_JSON);"));
  assert.ok(idx.indexOf("app.use('/api/admin/log-analysis/paste', BIG_JSON);") < idx.indexOf("app.use(express.json({ limit: '1mb' }));"), '기본 1mb 파서보다 앞');
  const admin = fs.readFileSync(new URL('routes/admin.js', SRC), 'utf8');
  assert.ok(admin.indexOf('wrapAsyncRouter(adminRouter)') < admin.indexOf('registerLogAnalysis(adminRouter)'));
});

test('⑦ 로그 탭 — 탭이 던져도, 탭 안에서 로그를 찍어도 로그 경로가 멈추지 않는다', async () => {
  const LB = await import('../src/logbuffer.js');
  let calls = 0;
  const off1 = LB.addLogTap(() => { calls += 1; throw new Error('boom'); });
  const off2 = LB.addLogTap(() => { calls += 1; LB.pushLog('info', 'nested'); });   // 재귀는 막힌다
  const before = LB.getLogs({ since: 0 }).lastId;
  LB.pushLog('warn', 'outer');
  off1(); off2();
  const after = LB.getLogs({ since: before });
  assert.equal(calls, 2, '탭은 바깥 줄에만 한 번씩');
  assert.deepEqual(after.items.map((x) => x.msg), ['outer', 'nested'], '줄은 모두 기록된다');
});

test('⑧ 반복 수신 로그 조절 — 값이 바뀌거나 1시간이 지나야 다시 찍는다(중앙 저널을 덮던 gpu-guest-data 수신)', async () => {
  const { createChangeLogger } = await import('../src/util/logThrottle.js');
  const log = createChangeLogger({ windowMs: 3_600_000, maxKeys: 2 });
  assert.equal(log('edge-a', '0/0', 0), true);
  assert.equal(log('edge-a', '0/0', 60_000), false, '같은 값 · 1분 뒤 — 찍지 않는다');
  assert.equal(log('edge-a', '11/40', 120_000), true, '값이 바뀌면 바로 찍는다');
  assert.equal(log('edge-a', '11/40', 120_000 + 3_600_000), true, '1시간이 지나면 다시 한 번');
  log('edge-b', 'x', 0); log('edge-c', 'x', 0);
  assert.equal(log('edge-a', '11/40', 120_000 + 3_600_001), true, '상한으로 밀려난 키는 새로 찍는다(유계)');
  const src = fs.readFileSync(new URL('routes/central.js', SRC), 'utf8');
  assert.match(src, /if \(gpuRecvLog\(agent, `\$\{hosts\.length\}\/\$\{vms\.length\}`\)\) console\.log\(`\[central\] gpu-guest-data 수신: agent=\$\{agent\} hosts=\$\{hosts\.length\} vms=\$\{vms\.length\}`\)/, '문구 형식은 그대로(규칙이 읽는다)');
});

test('② 카탈로그 규칙(코드 전수 스캔 118개) — 태그·대상 라벨·순서', async () => {
  const { CATALOG_RULES } = await import('../src/loganalysis/catalog.js');
  const T2 = await import('../src/loganalysis/template.js');
  assert.ok(CATALOG_RULES.length >= 100, `카탈로그 ${CATALOG_RULES.length}개`);
  for (const r of CATALOG_RULES) {
    assert.equal(T2.tagOf(r.sample), r.tag, `${r.id}: 표본의 태그와 규칙 태그가 같아야 엔진이 찾는다`);
    if (r.entity) assert.ok(r.entityLabel, `${r.id}: 대상 캡처가 무엇인지(entityLabel)`);
  }
  // GPU 게스트 세부 분류가 코어 일반 규칙보다 앞 — auto 방식 줄은 게스트 쪽 근본 원인으로 분류된다
  const rules = IDX.activeRules();
  const pos = (id) => rules.findIndex((x) => x.id === id);
  assert.ok(pos('gpu-guest-guest-login') >= 0 && pos('gpu-guest-guest-login') < pos('gpu-guest-ssh-refused'));
  assert.ok(pos('gpu-guest-fail-other') === Math.max(...rules.filter((x) => x.tag === 'gpu-guest').map((x) => pos(x.id))), 'fail-other 는 gpu-guest 규칙 중 마지막');
  const idx = E.indexRules(rules);
  const st = E.newState();
  E.addItem(st, { msg: '[gpu-guest]   ✗ vm-synth-01: 게스트작업: StartProgramInGuest SOAP 실패: 게스트 로그인 실패 — 계정/비밀번호 확인 / SSH: SSH 수집 실패: SSH 연결 거부(sshd 미동작/포트 차단)', level: 'unknown' }, idx);
  assert.deepEqual(Object.keys(st.rules), ['gpu-guest-guest-login']);
});
