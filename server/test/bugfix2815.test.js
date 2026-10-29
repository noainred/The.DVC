/**
 * v2.815 — 버그 5건(점검 요청 '버그 5개 찾아줘' 재현분) 회귀 고정.
 *  ① capacity/evaluate.js: 임계 없는 축(네트워크)이 표본 1천 개가 넘어도 '표본이 아직 부족합니다' 라고 영원히 말했다.
 *  ② search/deepSearch.js: Windows 탐침 출력(`MATCH \r\nGPU 0…`)을 불일치로 셌다 — GPU 드라이버가 있으면 오히려 빠졌다.
 *  ③ search/deepSearch.js: 서브넷 '10.1.2.0/'(접두 길이 빈 값)가 Number('')===0 → /0 으로 모든 IP 와 일치했다.
 *  ④ svcmon/checker.js: DNS 점검 질의 서버가 호스트 이름이면 Resolver.setServers 가 던져 매번 bad 였다.
 *  ⑤ svcmon/checker.js: whois.kr 의 'Expiration Date : 2027. 03. 15.' 를 '2027.' 로 잘라 그해 1월 1일로 읽었다.
 * 기준 시각은 정시 −30분으로 고정(v2.517 규약).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix2815-'));
after(() => { try { fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }); } catch {} });
const HOUR = 3600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const { getCapacityDb } = await import('../src/capacity/db.js');
const { evaluateHost } = await import('../src/capacity/evaluate.js');
const { probeOutputMatch, snapshotFilter, filterScanResults } = await import('../src/search/deepSearch.js');
const { dnsServerAddr, parseWhoisExpiry, runCheck } = await import('../src/svcmon/checker.js');

test('① 네트워크(임계 없는 정보 지표)는 표본이 충분하면 "부족" 이 아니라 판정하지 않음 + 실측 통계를 말한다', async () => {
  const db = await getCapacityDb();
  const metrics = ['cpu_system', 'load_per_core', 'event_loop_lag', 'mem_system', 'mem_rss', 'disk_used', 'net_rx', 'net_tx'];
  for (let ts = NOW - 29 * 86_400_000; ts <= NOW; ts += 30 * 60_000) {
    db.insertSnapshot('h2815', metrics.map((m) => ({ metric: m, v: m.startsWith('net') ? 5e6 : m === 'load_per_core' ? 0.4 : 40 })), ts, { hostname: 'h2815' });
  }
  const r = await evaluateHost('h2815');
  assert.equal(r.windows.month.metrics.net_rx.verdict, 'info');
  assert.ok(r.windows.month.metrics.net_rx.stats.n > 1000);
  const net = r.advice.filter((a) => a.group === 'network');
  assert.equal(net.length, 1);
  assert.equal(net[0].level, 'info');
  assert.doesNotMatch(net[0].text, /부족/);
  assert.match(net[0].text, /판정하지 않습니다/);
  assert.match(net[0].text, /수신 처리량 p95 5\.0Mbps/);
  // 임계 있는 축은 예전 그대로(cpu_system 40 — 경고 70 미만이고 그 절반 35 이상이라 ok)
  assert.equal(r.advice.find((a) => a.group === 'cpu').level, 'ok');
  assert.equal(r.advice.filter((a) => a.level === 'measuring').length, 0);
});

test('① 데이터가 없는 호스트의 네트워크 축은 "측정값이 없습니다" 로 말한다(측정 중 등급 유지)', async () => {
  const db = await getCapacityDb();
  db.insertSnapshot('h2815-empty', [{ metric: 'cpu_system', v: 10 }], NOW, { hostname: 'h2815-empty' });
  const r = await evaluateHost('h2815-empty');
  const net = r.advice.find((a) => a.group === 'network');
  assert.equal(net.level, 'measuring');
  assert.match(net.text, /측정값이 없습니다/);
});

test('② Windows 탐침 출력(\\r\\n · MATCH 뒤 공백)도 일치로 읽고 증거 줄을 남긴다', () => {
  assert.deepEqual(probeOutputMatch('MATCH \r\nGPU 0: Tesla T4 (UUID: GPU-1)'), { matched: true, evidence: 'GPU 0: Tesla T4 (UUID: GPU-1)' });
  assert.deepEqual(probeOutputMatch('MATCH\r\nGPU 0'), { matched: true, evidence: 'GPU 0' });
  assert.deepEqual(probeOutputMatch('MATCH\nGPU 0: A100\nGPU 1: A100'), { matched: true, evidence: 'GPU 0: A100\nGPU 1: A100' });
  assert.deepEqual(probeOutputMatch('MATCH'), { matched: true, evidence: '' });
  assert.equal(probeOutputMatch('NOMATCH').matched, false);
  assert.equal(probeOutputMatch('NOMATCH\r\n').matched, false);
  assert.equal(probeOutputMatch('').matched, false);
  assert.equal(probeOutputMatch(null).matched, false);
  assert.equal(probeOutputMatch('xMATCH').matched, false);
});

test('③ 서브넷 접두 길이가 비었거나 숫자가 아니면 아무것도 맞지 않는다(전체 일치 금지)', () => {
  const snap = { vms: [{ name: 'a', ipAddresses: ['10.1.2.5'] }, { name: 'b', ipAddresses: ['192.168.9.9'] }, { name: 'c', ipAddresses: ['172.16.0.1'] }] };
  const names = (subnet) => snapshotFilter(snap, { f: { subnet } }).map((v) => v.name);
  assert.deepEqual(names('10.1.2.0/24'), ['a']);
  assert.deepEqual(names('10.1.2.0/24 '), ['a']);   // 뒤 공백은 예전처럼 허용
  assert.deepEqual(names('0.0.0.0/0'), ['a', 'b', 'c']);   // 명시한 /0 은 전체(의도)
  assert.deepEqual(names('10.1.2.0/'), []);
  assert.deepEqual(names('10.1.2.0/ '), []);
  assert.deepEqual(names('10.1.2.0/1e1'), []);
  assert.deepEqual(names('10.1.2.0/33'), []);
  const scan = [{ ip: '8.8.8.8' }, { ip: '10.1.2.9' }];
  assert.deepEqual(filterScanResults(scan, { subnet: '10.1.2.0/' }).map((x) => x.ip), []);
  assert.deepEqual(filterScanResults(scan, { subnet: '10.1.2.0/24' }).map((x) => x.ip), ['10.1.2.9']);
});

test('④ DNS 질의 서버 — IP 는 그대로, 이름은 해석한 IP 로(포트 유지), 해석 실패는 사유를 말한다', async () => {
  const fake = (map) => (name, _o, cb) => (map[name] ? cb(null, map[name][0], map[name][1]) : cb(Object.assign(new Error('nf'), { code: 'ENOTFOUND' })));
  const lk = fake({ 'dns01.corp.local': ['10.0.0.53', 4], 'dns6.corp.local': ['fd00::53', 6] });
  assert.equal(await dnsServerAddr('10.0.0.53', lk), '10.0.0.53');
  assert.equal(await dnsServerAddr('10.0.0.53:5353', lk), '10.0.0.53:5353');
  assert.equal(await dnsServerAddr('fd00::53', lk), 'fd00::53');
  assert.equal(await dnsServerAddr('[fd00::53]:5353', lk), '[fd00::53]:5353');
  assert.equal(await dnsServerAddr('dns01.corp.local', lk), '10.0.0.53');
  assert.equal(await dnsServerAddr('dns01.corp.local:5353', lk), '10.0.0.53:5353');
  assert.equal(await dnsServerAddr('dns6.corp.local:53', lk), '[fd00::53]:53');
  await assert.rejects(dnsServerAddr('nope.corp.local', lk), /nf/);
  await assert.rejects(dnsServerAddr('', lk));
  // 실제 점검 경로: 이름 해석 실패가 ERR_INVALID_IP_ADDRESS 가 아니라 '질의 서버 이름 해석 실패' 로 나온다
  //   (.invalid 는 RFC 2606 — 해석되지 않는 이름. 시한 3초 안에 끝난다).
  const r = await runCheck({ type: 'dns', record: 'localhost' }, 'dns01.example.invalid');
  assert.equal(r.status, 'bad');
  assert.doesNotMatch(r.reply, /ERR_INVALID_IP_ADDRESS/);
  assert.match(r.reply, /질의 서버 이름 해석 실패/);
});

test('⑤ WHOIS 만료일 — KISA 형식(YYYY. MM. DD.)을 그날로 읽고, ISO·기존 형식은 예전 그대로', () => {
  const kr = 'Domain Name                 : example.co.kr\nRegistered Date             : 2005. 03. 15.\nExpiration Date             : 2027. 03. 15.\n';
  assert.equal(parseWhoisExpiry(kr), Date.UTC(2027, 2, 15));
  assert.equal(parseWhoisExpiry('Registry Expiry Date: 2027-08-13T04:00:00Z\n'), Date.UTC(2027, 7, 13, 4));
  assert.equal(parseWhoisExpiry('paid-till: 2027-01-31\r\n'), Date.UTC(2027, 0, 31));
  assert.equal(parseWhoisExpiry('Expiration Date: 2027/12/01\n'), Date.UTC(2027, 11, 1));
  assert.equal(parseWhoisExpiry('expires: 2027.5.6 KST\n'), Date.UTC(2027, 4, 6));
  assert.equal(parseWhoisExpiry('Expiration Date : 2027. 02. 31.\n'), null);   // 없는 날
  assert.equal(parseWhoisExpiry('no expiry here'), null);
  assert.equal(parseWhoisExpiry(''), null);
});
