// v2.586 — IPv4 파서 단일 소스(util/ipv4.js). 예전 ipam/scan.js 판본은 빈 옥텟·16진·지수를 받았다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipToNum, numToIp, isIpv4 } from '../src/util/ipv4.js';
import { isIpv4 as scanIsIpv4 } from '../src/ipam/scan.js';
import { ipToNum as ledgerIpToNum } from '../src/ipam/ledger.js';
import { ipToNum as specIpToNum, numToIp as specNumToIp } from '../src/provision/spec.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('유효 IPv4 — 값과 왕복', () => {
  assert.equal(ipToNum('10.0.0.1'), 167772161);
  assert.equal(ipToNum('0.0.0.0'), 0);
  assert.equal(ipToNum('255.255.255.255'), 4294967295);
  assert.equal(ipToNum(' 192.168.1.10 '), ipToNum('192.168.1.10')); // 붙여넣기 공백
  // 선행 0 은 예전 판본 전부처럼 10진수(저장된 키 호환) — 접속처로 쓸 곳은 정규형으로 바꾼다.
  assert.equal(numToIp(ipToNum('010.020.030.041')), '10.20.30.41');
  for (const ip of ['1.2.3.4', '10.94.41.237', '172.16.0.254']) assert.equal(numToIp(ipToNum(ip)), ip);
});

test('예전 판본이 받던 잘못된 입력을 거부한다', () => {
  for (const bad of ['10..1.1', '10.1.1.', '.10.1.1', '10.1.0x1.1', '1e0.1.1.1',
    '10.1.1.256', '10.1.1', '10.1.1.1.1', '', ' ', 'a.b.c.d', '10.1.-1.1', '10.1.+1.1', null, undefined, {}, []]) {
    assert.equal(ipToNum(bad), null, `거부해야 한다: ${JSON.stringify(bad)}`);
    assert.equal(isIpv4(bad), false);
  }
});

test('재수출 경로가 같은 함수를 쓴다', () => {
  assert.equal(scanIsIpv4, isIpv4);
  assert.equal(ledgerIpToNum, ipToNum);
  assert.equal(specIpToNum, ipToNum);
  assert.equal(specNumToIp, numToIp);
});

test('소스 스윕 — ipToNum/isIpv4 사본을 다시 만들지 않는다', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.endsWith(path.join('util', 'ipv4.js'))) {
        const s = fs.readFileSync(p, 'utf8');
        if (/function\s+(ipToNum|ipToInt|isIpv4)\s*\(/.test(s)) hits.push(path.relative(SRC, p));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(hits, []);
});
