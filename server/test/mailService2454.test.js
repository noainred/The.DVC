// 공용 메일 발송(v2.454) — 순수 판정 회귀 고정.
//
// 요구: "메일 발송 기능을 별도 기능으로 만들어서 다른 기능에서도 메일 발송하게".
// SMTP 설정은 `mail.json` 한 곳에만 두고, 기능은 `sendPortalMail({ kind })` 하나만 부른다.
// 여기서는 I/O 없는 부분(수신자 결정·속도 제한·설정 검증·종류 카탈로그)을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, isKind, kindLabel, resolveRecipients, withinRateLimit } from '../src/mail/kinds.js';
import { smtpIssue, validate, unknownKinds, DEFAULTS } from '../src/mail/settings.js';
import { alertSubject, alertHtml } from '../src/alerts.js';

const CFG = {
  enabled: true,
  smtp: { host: 'relay.local', port: 25, from: 'portal@corp.local' },
  defaultTo: ['ops@corp.local'],
  kinds: {
    alert: { enabled: true, to: [], cc: [] },
    daily: { enabled: true, to: ['boss@corp.local'], cc: ['cc@corp.local'] },
    dirusage: { enabled: false, to: [], cc: [] },
    test: { enabled: true, to: [], cc: [] },
  },
  rateLimitPerHour: 60,
};

/* ── 종류 카탈로그 ───────────────────────────────────────────────────── */

test('종류 카탈로그 — 기존 기능이 전부 등록돼 있다', () => {
  const ids = KINDS.map((k) => k.id);
  for (const id of ['alert', 'daily', 'dirusage', 'test']) assert.ok(ids.includes(id), `${id} 누락`);
  assert.equal(isKind('alert'), true);
  assert.equal(isKind('nope'), false);
  assert.equal(kindLabel('daily'), '일일 리포트');
  for (const k of KINDS) assert.ok(k.label && k.desc, `${k.id} 에 설명이 없다(설정 화면이 이 값으로 만들어진다)`);
});

/* ── 수신자 결정 ─────────────────────────────────────────────────────── */

test('수신자 우선순위 — 명시 > 종류별 > 기본', () => {
  assert.deepEqual(resolveRecipients(CFG, 'alert').to, ['ops@corp.local'], '종류별이 비면 기본으로');
  assert.deepEqual(resolveRecipients(CFG, 'daily').to, ['boss@corp.local'], '종류별이 있으면 그것으로');
  assert.deepEqual(resolveRecipients(CFG, 'daily').cc, ['cc@corp.local']);
  const ex = resolveRecipients(CFG, 'daily', ['one@x.com']);
  assert.deepEqual(ex.to, ['one@x.com'], '호출부가 지정하면 최우선');
  assert.deepEqual(ex.cc, [], '명시 수신자를 준 호출부는 참조까지 스스로 정한다');
});

test('전역 스위치가 꺼져 있으면 어떤 종류도 나가지 않는다', () => {
  const r = resolveRecipients({ ...CFG, enabled: false }, 'alert');
  assert.equal(r.ok, false);
  assert.match(r.reason, /꺼져 있습니다/);
});

test('SMTP 서버가 없으면 발송하지 않고 이유를 알린다(조용히 삼키지 않는다)', () => {
  const r = resolveRecipients({ ...CFG, smtp: { host: '' } }, 'alert');
  assert.equal(r.ok, false);
  assert.match(r.reason, /SMTP/);
});

test('종류별 토글 — 꺼진 종류는 건너뛴다', () => {
  const r = resolveRecipients(CFG, 'dirusage');
  assert.equal(r.ok, false);
  assert.match(r.reason, /폴더 사용량/);
});

test("'test' 종류는 종류별 토글을 보지 않는다(테스트하려고 토글을 켰다 끄는 것은 번거롭다)", () => {
  const cfg = { ...CFG, kinds: { ...CFG.kinds, test: { enabled: false, to: [], cc: [] } } };
  assert.equal(resolveRecipients(cfg, 'test').ok, true);
  // 다만 전역 스위치는 여전히 상위다.
  assert.equal(resolveRecipients({ ...cfg, enabled: false }, 'test').ok, false);
});

test('받는 사람이 어디에도 없으면 이유와 함께 거절한다', () => {
  const r = resolveRecipients({ ...CFG, defaultTo: [] }, 'alert');
  assert.equal(r.ok, false);
  assert.match(r.reason, /받는 사람이 없습니다/);
});

/* ── 속도 제한 ───────────────────────────────────────────────────────── */

test('속도 제한 — 최근 1시간 기준이며 0 은 제한 없음', () => {
  const now = 1_700_000_000_000;
  const recent = Array.from({ length: 59 }, (_, i) => now - i * 1000);
  assert.equal(withinRateLimit(recent, 60, now), true);
  assert.equal(withinRateLimit([...recent, now], 60, now), false, '한도에 도달하면 막는다');
  assert.equal(withinRateLimit([...recent, now], 0, now), true, '0 = 제한 없음');
  // 1시간이 지난 기록은 세지 않는다.
  const old = Array.from({ length: 100 }, (_, i) => now - 3600_000 - i * 1000);
  assert.equal(withinRateLimit(old, 10, now), true);
});

/* ── 설정 검증 ───────────────────────────────────────────────────────── */

test('SMTP 검증 — 계정만 있고 비밀번호가 없으면 오류(이미 저장됐으면 비워 둔다)', () => {
  const base = { host: 'r', port: 25, from: 'a@b.com' };
  assert.equal(smtpIssue(base), null);
  assert.match(smtpIssue({ ...base, user: 'u' }), /비밀번호/);
  assert.equal(smtpIssue({ ...base, user: 'u', password: 'p' }), null);
  assert.match(smtpIssue({ ...base, host: '' }), /서버 주소/);
  assert.match(smtpIssue({ ...base, from: 'bad' }), /From/);
  assert.match(smtpIssue({ ...base, port: 0 }), /포트/);
});

test('전체 검증 — 꺼져 있으면 통과, 켜져 있는데 수신자가 없으면 미리 알린다', () => {
  assert.deepEqual(validate({ enabled: false }), []);
  const errs = validate({ enabled: true, smtp: CFG.smtp, defaultTo: [], kinds: { alert: { enabled: true, to: [], cc: [] } } });
  assert.ok(errs.some((e) => /받는 사람이 없습니다/.test(e)), '조용히 안 보내면 "왜 메일이 안 오지" 가 된다');
});

test('알 수 없는 종류 id 는 저장을 거절한다(설정 파일 오염 방지)', () => {
  assert.deepEqual(unknownKinds({ alert: {}, bogus: {} }), ['bogus']);
  assert.deepEqual(unknownKinds({ alert: {} }), []);
});

test('기본값 — 설치만으로 메일이 나가지 않는다', () => {
  assert.equal(DEFAULTS.enabled, false);
  assert.equal(DEFAULTS.smtp.host, '');
  assert.ok(DEFAULTS.rateLimitPerHour > 0, '기본 속도 제한이 있어야 릴레이가 차단되지 않는다');
});

/* ── 알림 → 메일 본문 ────────────────────────────────────────────────── */

test('알림 메일 제목 — 심각도가 앞에 온다(받은 편지함 정렬·필터)', () => {
  assert.equal(alertSubject({ severity: 'critical', title: 'vCenter 다운' }), '[위험] vCenter 다운');
  assert.equal(alertSubject({ severity: 'warning', title: 'DS 90%' }), '[경고] DS 90%');
  assert.equal(alertSubject({ severity: 'info', title: '리포트' }), '[안내] 리포트');
});

test('알림 메일 본문 — HTML 이스케이프 + 메일 클라이언트 호환', () => {
  const html = alertHtml({ severity: 'critical', title: '<img src=x onerror=1>', detail: 'a & b' });
  assert.ok(!html.includes('<img'), '제목을 이스케이프하지 않으면 메일에서 실행된다');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('a &amp; b'));
  assert.ok(!/<style/i.test(html), '<style> 블록은 여러 클라이언트가 제거한다');
  assert.ok(!/display:\s*flex/i.test(html), 'flex 는 Outlook 에서 무너진다');
});

/* ── 배선 계약 ───────────────────────────────────────────────────────── */

test('alerts.js 가 email 채널을 갖는다 — 기존 알림 소스가 전부 메일을 쓸 수 있다', async () => {
  const { loadAlertConfig } = await import('../src/alerts.js');
  const cfg = loadAlertConfig();
  assert.ok(cfg.channels.email, 'email 채널이 없으면 notify() 를 쓰는 8개 기능이 메일을 못 쓴다');
  assert.equal(cfg.channels.email.enabled, false, '기본은 꺼짐 — 업그레이드만으로 메일이 나가면 안 된다');
});

test('SMTP 비밀번호를 담는 파일이 봉인 대상에 등록돼 있다', async () => {
  const { SECRET_FILES } = await import('../src/security/secretVault.js');
  assert.ok(SECRET_FILES.includes('mail.json'), 'mail.json 이 빠지면 SMTP 비밀번호가 평문으로 남는다');
  assert.ok(!SECRET_FILES.includes('dirusage.json'), 'dirusage.json 에는 더 이상 비밀이 없다');
});
