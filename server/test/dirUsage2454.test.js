// 폴더 사용량 Top-N 리포트 + 메일 발송 (v2.454) — 순수 로직 회귀 고정.
//
// 요구: "엣지 서버에 마운트된 특정 폴더의 하위 폴더 사용량을 설정한 기간마다 검색해 Top 10/20
// 사용자를 뽑고 지정한 사용자에게 주기적으로 메일 발송."
//
// 집계 기준은 **하위 폴더 이름 = 사용자**(파일 소유자 uid 가 아니다 — 사용자가 선택).
// 여기서는 I/O 없는 부분만 고정한다: du 파싱 · Top-N · 증감 · 경로 가드 · 설정 검증 · MIME 조립.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuOutput, topEntries, deltaMap, removedEntries, humanBytes, buildScanRecord, MAX_ENTRIES } from '../src/dirusage/scan.js';
import { renderReport, renderSubject } from '../src/dirusage/report.js';
import { targetIssue, mailIssue, validate, DEFAULTS } from '../src/dirusage/settings.js';
import { isDue, sameTop } from '../src/dirusage/scheduler.js';
import { buildMime, dotStuff, encodeHeaderWord, normalizeAddresses, parseReply, pickAuthMech, ehloCaps } from '../src/util/smtp.js';
import { fileRootIssue, buildCommand, PRESETS } from '../src/rma/commands.js';

/* ── du 출력 파싱 ─────────────────────────────────────────────────────── */

const DU = [
  '4096\t/mnt/share/hong',
  '10737418240\t/mnt/share/kim',
  '2147483648\t/mnt/share/lee 박',          // 공백·한글 폴더명
  'du: cannot read directory \'/mnt/share/secret\': Permission denied',
  '12884905984\t/mnt/share',                 // 마지막 줄 = 루트 합계
].join('\n');

test('du 출력 파싱 — 루트 행은 합계로 빼고 하위 폴더만 항목으로', () => {
  const r = parseDuOutput(DU, '/mnt/share');
  assert.equal(r.totalBytes, 12884905984);
  assert.deepEqual(r.entries.map((e) => e.name), ['hong', 'kim', 'lee 박']);
  assert.equal(r.entries[1].bytes, 10737418240);
  assert.equal(r.skipped, 0, "`du: cannot read` 경고는 skipped 로 세지 않는다");
});

test('du 출력 파싱 — 루트 끝 슬래시가 있어도 같은 결과', () => {
  const a = parseDuOutput(DU, '/mnt/share');
  const b = parseDuOutput(DU, '/mnt/share/');
  assert.deepEqual(b.entries, a.entries);
  assert.equal(b.totalBytes, a.totalBytes);
});

test('du 출력 파싱 — 깊은 경로·형식 오류는 항목에 넣지 않고 개수를 보고한다', () => {
  const r = parseDuOutput([
    '100\t/mnt/share/a/b',        // depth 2 — 방어적으로 제외
    'garbage line',
    '\t/mnt/share/c',             // 크기 없음
    '200\t/other/x',              // 루트 밖
    '300\t/mnt/share',
  ].join('\n'), '/mnt/share');
  assert.deepEqual(r.entries, []);
  assert.equal(r.totalBytes, 300);
  assert.ok(r.skipped >= 3, `해석 못한 줄을 보고해야 한다(skipped=${r.skipped})`);
});

test('du 출력 파싱 — 항목이 상한을 넘으면 truncated 로 알린다(조용히 자르지 않는다)', () => {
  const lines = [];
  for (let i = 0; i < MAX_ENTRIES + 5; i++) lines.push(`${i + 1}\t/r/u${i}`);
  lines.push('999\t/r');
  const r = parseDuOutput(lines.join('\n'), '/r');
  assert.equal(r.entries.length, MAX_ENTRIES);
  assert.equal(r.truncated, true);
});

/* ── Top-N ────────────────────────────────────────────────────────────── */

test('Top-N — 내림차순, 동률은 이름순으로 안정 정렬(메일이 회차마다 흔들리지 않게)', () => {
  const e = [{ name: 'b', bytes: 100 }, { name: 'a', bytes: 100 }, { name: 'c', bytes: 500 }];
  const t = topEntries(e, 3, 700);
  assert.deepEqual(t.top.map((x) => x.name), ['c', 'a', 'b']);
  assert.equal(t.top[0].pct, 71.4, '비율의 분모는 du 가 보고한 루트 합계');
});

test('Top-N — 나머지는 기타로 묶고 개수를 남긴다', () => {
  const e = Array.from({ length: 30 }, (_, i) => ({ name: `u${i}`, bytes: (i + 1) * 10 }));
  const t = topEntries(e, 10);
  assert.equal(t.top.length, 10);
  assert.equal(t.othersCount, 20);
  assert.equal(t.top[0].name, 'u29');
  assert.equal(t.othersBytes + t.top.reduce((s, x) => s + x.bytes, 0), t.sumBytes);
});

test('Top-N — 요청값이 범위를 벗어나면 클램프하고, 0 은 제한 없음이 아니다', () => {
  const e = Array.from({ length: 5 }, (_, i) => ({ name: `u${i}`, bytes: i }));
  assert.equal(topEntries(e, 1).top.length, 1);
  assert.equal(topEntries(e, 9999).top.length, 5, '항목 수를 넘지 않는다');
  // 0·NaN 은 무효값이라 기본 20 으로 수렴한다('0 = 전량'으로 해석하면 메일이 수천 줄이 된다).
  assert.equal(topEntries(e, 0).top.length, 5);
  assert.equal(topEntries(e, NaN).top.length, 5);
});

/* ── 증감(기준선 원칙) ──────────────────────────────────────────────── */

test('증감 — 직전 관측이 없으면 null(0 으로 채우지 않는다)', () => {
  const cur = [{ name: 'a', bytes: 100 }];
  const d = deltaMap(cur, null);
  assert.equal(d.get('a').deltaBytes, null);
  assert.equal(d.get('a').isNew, false, '기준선 자체는 신규가 아니다');
});

test('증감 — 신규 폴더는 전량을 증가로 보고하지 않고 신규로 표시', () => {
  const d = deltaMap([{ name: 'a', bytes: 100 }, { name: 'b', bytes: 50 }], [{ name: 'a', bytes: 60 }]);
  assert.equal(d.get('a').deltaBytes, 40);
  assert.equal(d.get('b').isNew, true);
  assert.equal(d.get('b').deltaBytes, null);
});

test('사라진 폴더를 찾아낸다(삭제·이동을 리포트에 남긴다)', () => {
  const r = removedEntries([{ name: 'a', bytes: 1 }], [{ name: 'a', bytes: 1 }, { name: 'z', bytes: 9 }]);
  assert.deepEqual(r, [{ name: 'z', bytes: 9 }]);
});

test('humanBytes — 단위·음수·null', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(1024), '1.00 KB');
  assert.equal(humanBytes(10 * 1024 ** 3), '10.0 GB');
  assert.equal(humanBytes(-1024), '-1.00 KB');
  assert.equal(humanBytes(null), '—');
});

/* ── 저장 레코드 ─────────────────────────────────────────────────────── */

test('저장 레코드 — Top-N 만 담고 나머지는 요약으로(전량 적재 금지)', () => {
  const parsed = parseDuOutput([
    ...Array.from({ length: 100 }, (_, i) => `${(i + 1) * 1000}\t/r/u${i}`),
    '9999999\t/r',
  ].join('\n'), '/r');
  const rec = buildScanRecord({ targetId: 't1', root: '/r', agent: 'KR', ts: 1_700_000_000_000, parsed, topN: 20 });
  assert.equal(rec.entries.length, 20, '저장은 Top-N 까지만');
  assert.equal(rec.count, 100, '전체 개수는 요약으로 남는다');
  assert.equal(rec.othersCount, 80);
  assert.equal(rec.totalBytes, 9999999);
});

/* ── 리포트 본문 ─────────────────────────────────────────────────────── */

const REC = {
  targetId: 't1', agent: 'KR', root: '/mnt/share', ts: 1_700_000_000_000,
  totalBytes: 12884905984, sumBytes: 12884905984, count: 3, othersBytes: 0, othersCount: 0,
  skipped: 0, truncated: false,
  entries: [{ name: 'kim', bytes: 10737418240 }, { name: 'lee', bytes: 2147483648 }],
};

test('리포트 — HTML 과 텍스트 둘 다 만들고 폴더명을 이스케이프한다', () => {
  const evil = { ...REC, entries: [{ name: '<script>x</script>', bytes: 1 }] };
  const { html, text } = renderReport(evil, null);
  assert.ok(!html.includes('<script>'), 'HTML 이스케이프가 안 되면 메일 클라이언트에서 스크립트가 산다');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(text.includes('<script>x</script>'), '텍스트 파트는 원문 그대로');
});

test('리포트 — 직전 기록이 없으면 그 사실을 본문에 밝힌다', () => {
  const { html } = renderReport(REC, null);
  assert.match(html, /증감을 표시하지 않았습니다/);
});

test('리포트 — 증감이 있으면 표시하고 감소는 다른 색으로', () => {
  const prev = { ...REC, ts: REC.ts - 86400000, entries: [{ name: 'kim', bytes: 20737418240 }, { name: 'lee', bytes: 1 }] };
  const { html, text } = renderReport(REC, prev);
  assert.match(text, /-9\.31 GB|-9\.3 GB/, '감소가 텍스트에 나와야 한다');
  assert.ok(html.includes('#039855'), '감소는 초록 계열');
});

test('리포트 — 메일 클라이언트 호환: style 블록·flex 를 쓰지 않는다', () => {
  const { html } = renderReport(REC, null);
  assert.ok(!/<style/i.test(html), '<style> 블록은 여러 클라이언트가 제거한다');
  assert.ok(!/display:\s*flex/i.test(html), 'flex 는 Outlook 에서 무너진다');
});

test('제목 치환 — {root}·{date}·{topN}·{agent}', () => {
  const s = renderSubject('{agent}/{root} Top {topN} {date}', { root: '/m/s', agent: 'KR', ts: 1_700_000_000_000, topN: 20 });
  assert.match(s, /^KR\/\/m\/s Top 20 \d{4}-\d{2}-\d{2}$/);
});

/* ── 설정 검증 ───────────────────────────────────────────────────────── */

const T = { id: 'a', agent: 'KR', path: '/mnt/share', topN: 20, intervalHours: 24, enabled: true };

test('대상 검증 — 경로·주기·TopN', () => {
  assert.equal(targetIssue(T), null);
  assert.match(targetIssue({ ...T, agent: '' }), /엣지/);
  assert.match(targetIssue({ ...T, path: 'mnt/share' }), /절대경로/);
  assert.match(targetIssue({ ...T, path: '/mnt/../etc' }), /\.\./);
  assert.match(targetIssue({ ...T, path: '/' }), /루트/);
  assert.match(targetIssue({ ...T, path: "/mnt/a'b" }), /따옴표/);
  assert.match(targetIssue({ ...T, topN: 0 }), /Top N/);
  assert.match(targetIssue({ ...T, intervalHours: 0 }), /주기/);
});

test('메일 검증 — 수신자를 비우는 것은 오류가 아니다(공용 설정의 수신자를 쓴다)', () => {
  assert.equal(mailIssue({ enabled: false }), null, '꺼져 있으면 검사하지 않는다');
  assert.equal(mailIssue({ enabled: true, to: [] }), null, '비우면 공용 수신자로 간다');
  assert.match(mailIssue({ enabled: true, to: ['not-an-email'] }), /형식 오류/);
  assert.equal(mailIssue({ enabled: true, to: ['a@b.com'] }), null);
});

test('이 기능 설정에는 SMTP 가 없다 — 공용 mail.json 이 소유한다', () => {
  // 기능마다 SMTP 를 두면 운영자가 같은 값을 여러 번 입력하고, 한쪽만 고쳐 놓고
  // "왜 이 메일만 안 오지" 를 겪는다. 이 계약을 되돌리지 말 것.
  assert.equal(DEFAULTS.smtp, undefined);
});

test('전체 검증 — 대상 id 중복을 잡는다', () => {
  const errs = validate({ targets: [T, { ...T }], mail: { enabled: false } });
  assert.ok(errs.some((e) => /중복/.test(e)));
});

test('기본값 — 스케줄·메일은 꺼진 상태로 시작한다(설치만으로 메일이 나가면 안 된다)', () => {
  assert.equal(DEFAULTS.enabled, false);
  assert.equal(DEFAULTS.mail.enabled, false);
});

/* ── 스케줄 판정 ─────────────────────────────────────────────────────── */

test('주기 도래 — 첫 실행은 즉시, 이후는 간격만큼 기다린다', () => {
  const now = 1_700_000_000_000;
  assert.equal(isDue(T, null, now), true);
  assert.equal(isDue(T, now - 23 * 3600_000, now), false);
  assert.equal(isDue(T, now - 24 * 3600_000, now), true);
  assert.equal(isDue({ ...T, enabled: false }, null, now), false);
});

test('변경 시에만 발송 — Top 목록이 같으면 같다고 판정', () => {
  const a = { entries: [{ name: 'x', bytes: 1 }, { name: 'y', bytes: 2 }] };
  assert.equal(sameTop(a, { entries: [{ name: 'x', bytes: 1 }, { name: 'y', bytes: 2 }] }), true);
  assert.equal(sameTop(a, { entries: [{ name: 'x', bytes: 1 }, { name: 'y', bytes: 3 }] }), false);
  assert.equal(sameTop(a, { entries: [{ name: 'x', bytes: 1 }] }), false);
});

/* ── RMA 프리셋 · 경로 가드 ─────────────────────────────────────────── */

test('du-top 프리셋 — 파일 내용을 읽지 않고 argv 로 실행한다', () => {
  const p = PRESETS.find((x) => x.id === 'du-top');
  assert.ok(p, 'du-top 프리셋이 있어야 한다');
  assert.deepEqual(p.argv({ path: '/mnt/share' }), ['du', '-x', '-b', '--max-depth=1', '/mnt/share']);
  assert.equal(p.sudo, undefined, 'sudo 가 필요 없다(읽기 권한만)');
  assert.equal(p.filePolicy, true, '엣지 RMA_FILE_ROOTS 안으로 제한되어야 한다');
  assert.ok(p.timeoutMs >= 600_000, 'du 는 대용량에서 수 분 걸린다');
});

test('경로 가드 — 경계를 포함해 비교한다(/var/log 허용이 /var/logs 를 통과시키면 안 된다)', () => {
  assert.equal(fileRootIssue('/var/log', ['/var/log']), null);
  assert.equal(fileRootIssue('/var/log/app/x', ['/var/log']), null);
  assert.match(fileRootIssue('/var/logs', ['/var/log']), /밖입니다/);
  assert.match(fileRootIssue('/etc/passwd', ['/var/log']), /밖입니다/);
  assert.match(fileRootIssue('/var/log/../../etc', ['/var/log']), /\.\./);
  assert.match(fileRootIssue('relative', ['/var/log']), /절대경로/);
  assert.match(fileRootIssue('/x', []), /허용 경로가 없습니다/);
});

test('buildCommand — 엣지 정책 밖 경로는 거부하고 안쪽은 filePolicy 표시를 단다', () => {
  const pol = { fileRoots: ['/mnt/share'], enabled: [], disabled: [] };
  const ok = buildCommand('du-top', { path: '/mnt/share/team' }, { policy: pol });
  assert.equal(ok.ok, true);
  assert.equal(ok.filePolicy, true, '엣지가 realpath 로 2차 검사하도록 표시해야 한다');
  const bad = buildCommand('du-top', { path: '/etc' }, { policy: pol });
  assert.equal(bad.ok, false);
  assert.match(bad.issue, /RMA_FILE_ROOTS/);
});

/* ── SMTP(순수 부분) ─────────────────────────────────────────────────── */

test('주소 정규화 — 중복 제거·형식 오류 분리·헤더 주입 차단', () => {
  const r = normalizeAddresses(['a@b.com', 'A@B.com', 'bad', 'c@d.com\r\nBcc: evil@x.com']);
  assert.deepEqual(r.ok, ['a@b.com']);
  assert.equal(r.bad.length, 2, '형식 오류와 CRLF 주입 모두 거부');
});

test('헤더 인코딩 — 한글 제목은 RFC 2047 base64, ASCII 는 그대로', () => {
  assert.equal(encodeHeaderWord('Report'), 'Report');
  const k = encodeHeaderWord('폴더 사용량');
  assert.match(k, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(k.slice(10, -2), 'base64').toString('utf8'), '폴더 사용량');
});

test('MIME — html+text 는 multipart/alternative, 본문은 base64', () => {
  const m = buildMime({ from: 'a@b.com', to: ['c@d.com'], subject: '제목', html: '<b>x</b>', text: 'x' });
  assert.match(m, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(m, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(m, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(m, /Content-Transfer-Encoding: base64/);
  assert.ok(!m.includes('<b>x</b>'), '본문은 base64 라 평문이 그대로 보이면 안 된다');
});

test('MIME — 제목에 개행을 넣어 헤더를 위조할 수 없다', () => {
  assert.throws(() => buildMime({ from: 'a@b.com', to: ['c@d.com'], subject: 'x\r\nBcc: evil@x.com', text: 'y' }), /제어문자/);
});

test('dot-stuffing — 줄 시작 마침표는 두 개로(본문 조기 종료 방지)', () => {
  assert.equal(dotStuff('.hidden\nnormal\n.'), '..hidden\r\nnormal\r\n..');
});

test('응답 파싱 — 멀티라인은 마지막 줄(공백 구분자)에서만 완성으로 본다', () => {
  assert.equal(parseReply('250-STARTTLS\r\n'), null, '아직 끝나지 않았다');
  const r = parseReply('250-mail.local\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
  assert.equal(r.code, 250);
  assert.ok(ehloCaps(r).has('STARTTLS'));
  assert.equal(pickAuthMech(r), 'PLAIN');
});

test('AUTH 선택 — 지원하지 않는 방식만 광고하면 null(조용히 평문 전송하지 않는다)', () => {
  assert.equal(pickAuthMech(parseReply('250 AUTH GSSAPI NTLM\r\n')), null);
  assert.equal(pickAuthMech(parseReply('250 SIZE 10240000\r\n')), null);
});
