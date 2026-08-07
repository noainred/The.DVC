import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseStats } from '../../uagmon/lib/uag.js';
import { hostBlockReason, parseIpv4 } from '../../uagmon/lib/guard.js';
import { Store, normalizeTarget } from '../../uagmon/lib/store.js';
import { Auth, hashPassword } from '../../uagmon/lib/auth.js';

/* ------------------------------ parseStats ------------------------------ */

const SAMPLE_JSON = JSON.stringify({
  accessPointStatusAndStats: {
    apVersion: '2503.1',
    upTime: 86400000,
    highWaterMark: 520,
    authenticatedSessionCount: 380,
    totalSessionCount: 410,
    overAllStatus: { status: 'UP' },
    systemStats: { cpuUtilPercent: 23, totalMemoryMb: 16384, freeMemoryMb: 8192 },
    edgeServiceSessionStats: [
      { identifier: 'VIEW', edgeServiceStatus: 'UP', totalSessionCount: 260, highWaterMark: 300 },
      { identifier: 'TUNNEL', edgeServiceStatus: 'DOWN', totalSessionCount: 0 },
    ],
  },
});

test('parseStats: UAG JSON 응답 정규화(버전·세션·서비스·CPU/메모리·종합상태)', () => {
  const r = parseStats(SAMPLE_JSON);
  assert.equal(r.ok, true);
  assert.equal(r.version, '2503.1');
  assert.equal(r.totalSessions, 410);
  assert.equal(r.authenticatedSessions, 380);
  assert.equal(r.highWaterMark, 520);
  assert.equal(r.cpuPercent, 23);
  assert.equal(r.memPercent, 50);
  assert.equal(r.upSeconds, 86400);
  assert.equal(r.overall, 'UP');
  assert.equal(r.services.length, 2);
  assert.deepEqual(r.services[0], { id: 'VIEW', status: 'UP', sessions: 260, high: 300 });
  assert.equal(r.services[1].status, 'DOWN');
});

test('parseStats: 종합상태 필드가 없으면 서비스 상태로 유도(부분 장애=PARTIAL)', () => {
  const r = parseStats(JSON.stringify({
    edgeServiceSessionStats: [
      { identifier: 'view', status: 'UP', sessionCount: 10 },
      { identifier: 'blast', status: 'STOPPED', sessionCount: 0 },
    ],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.overall, 'PARTIAL');
  assert.equal(r.totalSessions, 10, 'totalSessionCount 부재 시 서비스 합계');
  assert.equal(r.services[0].id, 'VIEW', '식별자는 대문자로 정규화');
});

test('parseStats: 구버전 XML 응답도 최소 필드를 뽑는다', () => {
  const xml = `<?xml version="1.0"?><accessPointStatusAndStats>
    <totalSessionCount>99</totalSessionCount><authenticatedSessionCount>90</authenticatedSessionCount>
    <edgeServiceSessionStats><identifier>VIEW</identifier><edgeServiceStatus>UP</edgeServiceStatus><totalSessionCount>99</totalSessionCount></edgeServiceSessionStats>
  </accessPointStatusAndStats>`;
  const r = parseStats(xml);
  assert.equal(r.ok, true);
  assert.equal(r.totalSessions, 99);
  assert.equal(r.services.length, 1);
  assert.equal(r.services[0].id, 'VIEW');
});

test('parseStats: JSON/XML 이 아니면 실패로 보고(예외 없음)', () => {
  assert.equal(parseStats('oops').ok, false);
  assert.equal(parseStats('').ok, false);
  assert.equal(parseStats('{broken').ok, false);
});

/* ------------------------------ SSRF 가드 ------------------------------ */

test('hostBlockReason: 루프백·링크로컬·우회표기 차단, 사내 IP/호스트네임 허용', () => {
  // 차단 — 정공법 + 우회 표기(10진/16진/8진 정수, IPv4-mapped IPv6)
  for (const h of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '169.254.169.254',
    '2130706433', '0xA9FEA9FE', '017700000001', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', 'fe80::1']) {
    assert.ok(hostBlockReason(h), `${h} 는 차단되어야 함`);
  }
  // 허용 — RFC1918/사내 FQDN/일반 IPv6
  for (const h of ['10.1.2.3', '192.168.0.5', '172.16.0.9', 'uag01.corp.local', '2001:db8::10']) {
    assert.equal(hostBlockReason(h), null, `${h} 는 허용되어야 함`);
  }
  // 형식 오류
  assert.ok(hostBlockReason('https://uag01'), '스킴 포함 입력 거부');
  assert.ok(hostBlockReason('a b'), '공백 거부');
  assert.ok(hostBlockReason(''), '빈 값 거부');
});

test('parseIpv4: inet_aton 계열 표기 해석', () => {
  assert.equal(parseIpv4('127.0.0.1'), 0x7F000001);
  assert.equal(parseIpv4('2130706433'), 0x7F000001);
  assert.equal(parseIpv4('0x7f000001'), 0x7F000001);
  assert.equal(parseIpv4('017700000001'), 0x7F000001);
  assert.equal(parseIpv4('127.1'), 0x7F000001, '축약형(a.b)');
  assert.equal(parseIpv4('256.1.1.1'), null, '옥텟 초과');
  assert.equal(parseIpv4('uag01'), null, '호스트네임은 IP 아님');
});

/* ------------------------------ Store ------------------------------ */

test('Store: 추가/수정/삭제 + 자격증명 redact + 빈 비밀번호는 기존 유지', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uagmon-store-'));
  try {
    const s = new Store(dir);
    const t = s.addTarget({ name: 'A', host: '10.0.0.1', username: 'admin', password: 'pw1', port: '9443' });
    assert.equal(t.port, 9443);
    assert.equal(s.redact(t).password, undefined);
    assert.equal(s.redact(t).hasPassword, true);

    // 빈 비밀번호로 수정 → 기존 비밀번호 유지(폼 미입력 = 변경 안 함)
    const u = s.updateTarget(t.id, { name: 'A2', host: '10.0.0.1', username: 'admin', password: '' });
    assert.equal(u.name, 'A2');
    assert.equal(u.password, 'pw1');

    // 재로드 시에도 유지 + 파일 권한 0600
    const s2 = new Store(dir);
    assert.equal(s2.targets.length, 1);
    assert.equal(s2.targets[0].password, 'pw1');
    const mode = fs.statSync(path.join(dir, 'uag-config.json')).mode & 0o777;
    assert.equal(mode, 0o600);

    assert.equal(s2.removeTarget(t.id), true);
    assert.equal(s2.targets.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Store: 손상된 설정 파일은 .corrupt 보존 후 빈 값으로 시작(원본 덮어쓰기 방지)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uagmon-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'uag-config.json'), '{broken json');
    const s = new Store(dir);
    assert.equal(s.targets.length, 0);
    const preserved = fs.readdirSync(dir).filter((f) => f.startsWith('uag-config.json.corrupt.'));
    assert.equal(preserved.length, 1, '손상본이 보존되어야 함');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------ Auth ------------------------------ */

test('Auth: IP별 실패 잠금 + Bearer 토큰 검증, 로컬 모드는 전부 통과', () => {
  const a = new Auth({ required: true, passwordHash: hashPassword('secret-pw') });
  // 다른 IP 의 실패가 내 IP 를 잠그지 않는다(출발지별 카운터).
  for (let i = 0; i < 5; i++) assert.equal(a.login('1.1.1.1', 'wrong').ok, false);
  assert.match(a.login('1.1.1.1', 'secret-pw').error || '', /잠겼습니다/, '잠긴 IP 는 정답도 거부');
  const r = a.login('2.2.2.2', 'secret-pw');
  assert.equal(r.ok, true, '다른 IP 는 정상 로그인');
  assert.equal(a.check(`Bearer ${r.token}`), true);
  assert.equal(a.check('Bearer deadbeef'), false);
  assert.equal(a.check(''), false);

  const local = new Auth({ required: false, passwordHash: '' });
  assert.equal(local.check(''), true, '로컬(127.0.0.1) 모드는 인증 없음');
});

/* ------------------------------ normalizeTarget ------------------------------ */

test('normalizeTarget: 포트 범위 클램프 + 이름 기본값(host)', () => {
  const t = normalizeTarget({ host: '10.0.0.9', username: 'u', password: 'p', port: 99999 });
  assert.equal(t.port, 65535);
  assert.equal(t.name, '10.0.0.9');
  assert.equal(t.insecureTls, false);
});
