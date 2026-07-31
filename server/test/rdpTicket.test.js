import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueRdpTicket, consumeRdpTicket, _resetRdpTickets } from '../src/proxy/rdpTicket.js';

test('rdpTicket: 발급 → 소비로 자격증명 회수', () => {
  _resetRdpTickets();
  const id = issueRdpTicket({ username: 'admin', password: 'p@ss', domain: 'CORP', security: 'nla' });
  assert.ok(id && id.length >= 32, '충분히 긴 랜덤 티켓 ID');
  const c = consumeRdpTicket(id);
  assert.deepEqual(c, { username: 'admin', password: 'p@ss', domain: 'CORP', security: 'nla' });
});

test('rdpTicket: 1회용 — 두 번째 소비는 null(재사용 불가)', () => {
  _resetRdpTickets();
  const id = issueRdpTicket({ username: 'u', password: 'x' });
  assert.ok(consumeRdpTicket(id));
  assert.equal(consumeRdpTicket(id), null, '재사용 차단');
});

test('rdpTicket: 없는/빈 티켓은 null', () => {
  _resetRdpTickets();
  assert.equal(consumeRdpTicket('deadbeef'), null);
  assert.equal(consumeRdpTicket(''), null);
  assert.equal(consumeRdpTicket(undefined), null);
});

test('rdpTicket: 서로 다른 발급은 서로 다른 ID', () => {
  _resetRdpTickets();
  const a = issueRdpTicket({ username: 'a', password: '1' });
  const b = issueRdpTicket({ username: 'b', password: '2' });
  assert.notEqual(a, b);
  assert.equal(consumeRdpTicket(a).username, 'a');
  assert.equal(consumeRdpTicket(b).username, 'b');
});
