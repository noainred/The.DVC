/**
 * UAGMon M3 회귀 방지 — 자격증명 유출 체인의 세 고리를 각각 막았는지 검증.
 *  ③ guard: 공개 IP 기본 차단(옵트인) + 도메인 화이트리스트(옵트인)
 *  ① store: host 변경 시 저장 비밀번호 이월 금지
 * (② uag: 연결 직전 DNS 재검증은 네트워크 의존이라 정적/수동 검증 — 여기선 제외)
 *
 * 실행: node --test uagmon/test/m3.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostBlockReason } from '../lib/guard.js';
import { normalizeTarget } from '../lib/store.js';

test('③ guard: RFC1918 은 허용, 공개 IP 는 기본 차단', () => {
  delete process.env.UAGMON_ALLOW_PUBLIC;
  assert.equal(hostBlockReason('10.0.0.1'), null);
  assert.equal(hostBlockReason('172.16.5.9'), null);
  assert.equal(hostBlockReason('192.168.1.10'), null);
  assert.match(hostBlockReason('8.8.8.8'), /공개 IP/);
  assert.match(hostBlockReason('203.0.113.5'), /공개 IP/);
});

test('③ guard: UAGMON_ALLOW_PUBLIC=true 면 공개 IP 허용(옵트인)', () => {
  process.env.UAGMON_ALLOW_PUBLIC = 'true';
  assert.equal(hostBlockReason('8.8.8.8'), null);
  delete process.env.UAGMON_ALLOW_PUBLIC;
  assert.match(hostBlockReason('8.8.8.8'), /공개 IP/);
});

test('③ guard: 루프백/링크로컬은 옵트인과 무관하게 항상 차단', () => {
  process.env.UAGMON_ALLOW_PUBLIC = 'true';
  assert.match(hostBlockReason('127.0.0.1'), /루프백/);
  assert.match(hostBlockReason('169.254.169.254'), /링크로컬/);
  assert.match(hostBlockReason('::1'), /루프백/);
  delete process.env.UAGMON_ALLOW_PUBLIC;
});

test('③ guard IPv6: 공개 GUA 는 차단·사설 ULA 는 허용(IPv4 와 대칭 — 2차 검증 확정)', () => {
  delete process.env.UAGMON_ALLOW_PUBLIC;
  assert.match(hostBlockReason('2001:db8::1'), /공개 IPv6/);       // 공개 GUA 차단
  assert.match(hostBlockReason('2600:1400::abcd'), /공개 IPv6/);
  assert.equal(hostBlockReason('fd12:3456::1'), null);             // ULA 허용
  assert.equal(hostBlockReason('fc00::1'), null);
  process.env.UAGMON_ALLOW_PUBLIC = 'true';
  assert.equal(hostBlockReason('2001:db8::1'), null);              // 옵트인 시 허용
  delete process.env.UAGMON_ALLOW_PUBLIC;
});

test('③ guard: 도메인 화이트리스트 — 미설정이면 전 호스트명 허용, 설정 시 접미사만', () => {
  delete process.env.UAGMON_ALLOWED_DOMAINS;
  assert.equal(hostBlockReason('uag01.anything.example'), null);
  process.env.UAGMON_ALLOWED_DOMAINS = 'corp.local, dvc.internal';
  assert.equal(hostBlockReason('uag01.corp.local'), null);
  assert.equal(hostBlockReason('dvc.internal'), null);
  assert.match(hostBlockReason('evil.com'), /허용된 도메인/);
  assert.match(hostBlockReason('corp.local.evil.com'), /허용된 도메인/);
  delete process.env.UAGMON_ALLOWED_DOMAINS;
});

test('① store: host 유지 + 비번 미입력 → 기존 비번 보존(재기동 유실 방지)', () => {
  const existing = { id: 'x', host: '10.0.0.5', username: 'admin', password: 'secret' };
  const r = normalizeTarget({ host: '10.0.0.5', username: 'admin' }, existing);
  assert.equal(r.password, 'secret');
});

test('① store: host 변경 + 비번 미입력 → 기존 비번 이월 금지(빈 값)', () => {
  const existing = { id: 'x', host: '10.0.0.5', username: 'admin', password: 'secret' };
  const r = normalizeTarget({ host: '10.9.9.9', username: 'admin' }, existing);
  assert.equal(r.password, '', 'host 가 바뀌면 저장 비번을 새 host 로 이월하지 않는다');
});

test('① store: host 변경 + 비번 재입력 → 새 비번 사용', () => {
  const existing = { id: 'x', host: '10.0.0.5', password: 'secret' };
  const r = normalizeTarget({ host: '10.9.9.9', password: 'newpass' }, existing);
  assert.equal(r.password, 'newpass');
});

test('① store: 신규 등록(existing 없음)은 정상 저장', () => {
  const r = normalizeTarget({ host: '10.0.0.7', username: 'a', password: 'p' }, {});
  assert.equal(r.password, 'p');
  assert.equal(r.host, '10.0.0.7');
});
