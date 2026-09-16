/**
 * test/horizonBulk2525.test.js — Horizon 서버 CSV/자유텍스트 대량 등록(v2.525) 회귀 고정.
 *
 * 사용자 요청: "호라이즌 서비스에 호라이즌 서버 등록이 필요하면 csv/text import/export 기능 추가해줘".
 *
 * 이 기능의 위험 두 가지:
 *  ① **식별 키를 틀리는 것** — Horizon 은 `id` 단독이다(스토리지 `host+type`, SAN `host` 와 다르다).
 *     틀리면 '드라이런 통과 → 저장에서 덮어쓰기/예외' 가 되고 export→편집→import 왕복이
 *     서버를 복제하거나 지운다.
 *  ② **비밀번호가 내보내기에 섞이는 것** — 공개 저장소·메일로 오가는 파일이다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const bulk = await import('../src/horizon/bulk.js');

const SERVERS = [
  { id: 'hz-seoul', name: 'Seoul', host: 'https://hz.seoul.example.com', username: 'svc', domain: 'CORP', password: 'secret-1', timeoutMs: 15_000, enabled: true },
  { id: 'hz-wa', name: 'Warsaw', host: 'https://hz.wa.example.com', username: 'svc', domain: 'CORP', password: 'secret-2', timeoutMs: 30_000, enabled: false },
];

/* ─── 내보내기 ─────────────────────────────────────────────────────────────── */

test('내보내기: 비밀번호를 절대 담지 않는다', () => {
  const csv = bulk.serversToCsv(SERVERS);
  const txt = bulk.serversToText(SERVERS);
  for (const [what, body] of [['CSV', csv], ['자유텍스트', txt]]) {
    assert.ok(!body.includes('secret-1') && !body.includes('secret-2'),
      `${what} 내보내기에 비밀번호가 섞였다 — 이 파일은 메일·티켓으로 오간다`);
  }
  assert.match(csv, /hz-seoul/);
  assert.match(csv, /false/, 'enabled=false 가 보존돼야 왕복이 멱등이다');
});

test('내보내기 → 가져오기 왕복이 멱등이다(전부 update 로 판정)', () => {
  const csv = bulk.serversToCsv(SERVERS);
  const p = bulk.parseServersCsv(csv);
  assert.equal(p.error, undefined);
  assert.equal(p.rows.length, 2);
  const existing = new Map(SERVERS.map((s) => [s.id, s]));
  const { report, summary } = bulk.analyzeImport(p.rows, {
    existingId: (id) => existing.get(String(id).trim().toLowerCase()),
    validate: () => null,       // 저장 검증은 horizon.js 가 진실의 원천 — 여기서는 키 판정만 본다
  });
  assert.equal(summary.update, 2, '같은 id 는 add 가 아니라 update 여야 한다(안 그러면 서버가 복제된다)');
  assert.equal(summary.add, 0);
  assert.equal(summary.error, 0);
  assert.equal(report.every((r) => r.hasPassword === false), true, '내보낸 파일에는 비밀번호가 없다');
});

/* ─── 샘플 ─────────────────────────────────────────────────────────────────── */

test('샘플: 그대로 가져와도 주석 행이 오류가 되지 않는다', () => {
  const p = bulk.parseServersCsv(bulk.sampleCsv());
  assert.equal(p.error, undefined);
  assert.equal(p.rows.length, 2, '주석 행(#...)은 걸러지고 예시 2행만 남아야 한다');
  assert.equal(p.rows[0].id, 'hz-seoul');
  const t = bulk.parseServersText(bulk.sampleText());
  assert.equal(t.error, undefined);
  assert.ok(t.rows.length >= 4, `자유텍스트 샘플의 세 표기 모두 읽혀야 한다(읽힌 줄 ${t.rows.length})`);
});

/* ─── 식별 키 = id 단독 ───────────────────────────────────────────────────── */

test('식별 키: 파일 내 id 중복은 막고, host 중복은 막지 않는다', () => {
  const csv = [
    'id,name,host,username,domain,password',
    'hz-a,A,https://a.example.com,svc,CORP,pw1',
    'hz-a,A2,https://a2.example.com,svc,CORP,pw2',
    'hz-b,B,https://a.example.com,svc,CORP,pw3',
  ].join('\n');
  const p = bulk.parseServersCsv(csv);
  const { report } = bulk.analyzeImport(p.rows, { existingId: () => undefined, validate: () => null });
  assert.equal(report[0].action, 'add');
  assert.equal(report[1].action, 'error', 'id 중복을 통과시키면 조용히 덮어써진다');
  assert.match(report[1].reason, /파일 내 중복/);
  assert.match(report[1].reason, /id/);
  assert.equal(report[2].action, 'add',
    'host 가 같아도 id 가 다르면 정상 구성이다 — upsertHorizon 은 host 중복을 거부하지 않는다');
});

test('빠른 검증: id·host 누락은 명확한 사유를 준다', () => {
  assert.match(bulk.rowIssue({ id: '', host: 'https://x' }), /id 누락/);
  assert.match(bulk.rowIssue({ id: 'a', host: '' }), /host 누락/);
  assert.equal(bulk.rowIssue({ id: 'a', host: 'https://x' }), null);
});

/* ─── 파싱 세부 ───────────────────────────────────────────────────────────── */

test('파싱: 필수 헤더가 없으면 사유를 말한다', () => {
  const p = bulk.parseServersCsv('name,username\nA,svc');
  assert.match(p.error, /'id' 와 'host'/);
});

test("파싱: `-` 는 CSV 에서도 '비움' 이다(자유텍스트와 같은 규칙 — v2.516)", () => {
  const p = bulk.parseServersCsv('id,name,host,timeoutMs\nhz-a,A,https://a.example.com,-');
  assert.equal(p.rows[0].timeoutMs, '', '형식만 바꿨을 때 규칙이 달라지면 사용자가 원인을 찾지 못한다');
  assert.equal(bulk.toSaveInput(p.rows[0]).timeoutMs, undefined, '빈 값은 저장 입력에서 빠져 기본값이 쓰인다');
});

test('파싱: 한글 별칭 키=값형을 읽는다', () => {
  const t = bulk.parseServersText('id=hz-a 표시명=서울 host=https://a.example.com 계정=svc 도메인=CORP 비밀번호=pw');
  assert.equal(t.error, undefined);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].name, '서울');
  assert.equal(t.rows[0].username, 'svc');
  assert.equal(t.rows[0]._hasPassword, true);
});

test('파싱: `https://` 의 콜론을 키 경계로 읽어 줄을 삼키지 않는다(v2.513 실제 결함)', () => {
  const t = bulk.parseServersText([
    'id name host username domain',
    'hz-a A https://10.30.0.14/ svc CORP',
    'hz-b B https://10.30.0.15/ svc CORP',
  ].join('\n'));
  assert.equal(t.error, undefined);
  assert.equal(t.rows.length, 2, '`https:` 를 키로 읽으면 그 줄이 경고 없이 사라진다');
  assert.match(t.rows[0].host, /10\.30\.0\.14/);
});

test('toSaveInput: 비밀번호를 비운 행은 password 키 자체를 넣지 않는다(기존 유지)', () => {
  const row = { id: 'a', name: 'A', host: 'https://a', username: 'u', domain: 'D', enabled: true, password: '', _hasPassword: false };
  const input = bulk.toSaveInput(row);
  assert.ok(!('password' in input), 'password:"" 를 보내면 normalize 가 신규로 보고 필수 오류를 낸다');
  const row2 = { ...row, password: 'pw', _hasPassword: true };
  assert.equal(bulk.toSaveInput(row2).password, 'pw');
});

/* ─── 코어를 복제하지 않았다 ──────────────────────────────────────────────── */

test('구조: 판정 코어를 복제하지 않고 util/bulkImport.js 에 위임한다', () => {
  const src = read('horizon/bulk.js');
  assert.match(src, /analyzeBulkImport/, '20줄을 복사하면 세 도구의 판정이 갈라진다(v2.513 규약)');
  assert.ok(!/seenInFile/.test(src), '중복 판정을 다시 구현하면 코어와 갈라진다');
  // 검증의 진실의 원천은 horizon.js normalize 다(라우트가 규칙을 새로 만들지 않는다)
  assert.match(read('horizon/horizon.js'), /export function horizonInputIssue/);
  assert.match(read('routes/admin/horizonAssign.js'), /validate: horizonInputIssue/);
});

test('구조: 웹 공용 모달 하나를 세 화면이 쓴다(경로 조각만 주입)', () => {
  const WEB = path.join(HERE, '..', '..', 'web', 'src');
  const modal = fs.readFileSync(path.join(WEB, 'views/tools/BulkDeviceIo.jsx'), 'utf8');
  assert.match(modal, /resource = 'devices'/, '기본값이 바뀌면 기존 두 화면의 라우트가 깨진다');
  assert.match(modal, /\$\{base\}\/\$\{resource\}\/import/);
  const lic = fs.readFileSync(path.join(WEB, 'views/tools/LicenseTools.jsx'), 'utf8');
  assert.match(lic, /base="\/admin\/horizon" resource="servers"/);
  assert.match(lic, /keyLabel="id"/, '화면이 host 라고 안내하면 사용자가 잘못된 파일을 만든다');
});

/* ─── 라우트 보안 ─────────────────────────────────────────────────────────── */

test('라우트: 전부 adminOnly 이고 접속처 변경 시 비밀 폐기를 사용자에게 알린다', () => {
  const src = read('routes/admin/horizonAssign.js');
  const lines = src.split('\n').filter((l) => /adminRouter\.(get|post)\('\/horizon\/servers/.test(l));
  assert.equal(lines.length, 7, `Horizon 대량등록 라우트 7개가 있어야 한다(현재 ${lines.length})`);
  assert.equal(lines.every((l) => l.includes('adminOnly')), true, 'adminOnly 가 빠진 라우트가 있다');
  assert.match(src, /droppedSecrets/, '접속처가 바뀌어 비밀번호가 폐기된 행을 조용히 넘기면 다음 수집이 실패한다');
  assert.match(src, /kind: 'horizon'/, 'bulkRun 재진입 가드 키 — 연타가 AD 로그인 시도를 곱하지 않게');
});

test('라우트: 자동 재시도를 만들지 않았다(AD 계정 잠금 방지)', () => {
  const src = read('routes/admin/horizonAssign.js');
  assert.ok(!/retry|재시도\s*\d/.test(src.replace(/재시도하지 않습니다|자동 재시도 없음/g, '')),
    '잘못된 비밀번호 반복은 AD 계정을 잠근다 — bulkRun 이 재시도를 금지한다');
});

/* ─── 조언이 틀리면 무음 실패보다 나쁘다 ─────────────────────────────────────── */

const { preflightHints } = await import('../src/util/bulkAdvice.js');

test("조언: Horizon 의 host 는 URL 이 정답이므로 '주소만 남기세요' 를 말하지 않는다", () => {
  const rows = [{ _line: 2, host: 'https://horizon.seoul.example.com' }, { _line: 3, host: 'https://hz.example.com:8443/' }];
  const url = preflightHints(rows, bulk.COLUMNS, { hostForm: 'url' });
  assert.deepEqual(url, [], 'URL 형식이 필수인 도구에 URL 을 지우라고 하면 등록이 실패한다(v2.525 Chromium 판독에서 실제로 떴다)');
  // 기본(주소 형식) 도구에서는 기존 조언이 그대로 나와야 한다 — 스토리지·SAN 회귀 방지
  const addr = preflightHints(rows, bulk.COLUMNS);
  assert.ok(addr.length >= 2 && addr.every((h) => h.field === 'host'));
});

test("조언: URL 형식 도구에서 https:// 가 없으면 붙이라고 말한다", () => {
  const h = preflightHints([{ _line: 2, host: 'horizon.example.com' }], bulk.COLUMNS, { hostForm: 'url' });
  assert.equal(h.length, 1);
  assert.match(h[0].advice, /https:\/\//);
});

test("조언: 라우트가 hostForm:'url' 을 넘긴다", () => {
  assert.match(read('routes/admin/horizonAssign.js'), /hostForm: 'url'/);
});
