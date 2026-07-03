import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/idrac/registry.js';

// iDRAC 자격증명 CSV 가져오기 — 특수문자 비밀번호가 온전히 보존되는지(RFC 4180).
// 이전의 순진한 split(',')은 쉼표/따옴표/줄바꿈 포함 비번을 잘라 잘못된 비번을 등록했다.

test('parseCsv: 따옴표로 감싼 쉼표 포함 비밀번호를 온전히 보존', () => {
  const csv = 'name,host,username,password,servicetag\n' +
    'srv1,10.0.0.1,root,"p@ss,w0rd",TAG1';
  const [r] = parseCsv(csv);
  assert.equal(r.password, 'p@ss,w0rd');
  assert.equal(r.serviceTag, 'TAG1'); // 쉼표가 필드를 밀어내지 않음
});

test('parseCsv: 이스케이프된 따옴표("")를 리터럴 따옴표로 복원', () => {
  const csv = 'name,host,username,password\n' +
    'srv2,10.0.0.2,root,"a""b""c"';
  const [r] = parseCsv(csv);
  assert.equal(r.password, 'a"b"c');
});

test('parseCsv: 따옴표 필드 안의 줄바꿈을 한 레코드로 유지', () => {
  const csv = 'name,host,username,password\n' +
    'srv3,10.0.0.3,root,"line1\nline2"';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].password, 'line1\nline2');
});

test('parseCsv: &,<,공백,백슬래시,한글 등 비인용 특수문자 그대로', () => {
  const csv = 'name,host,username,password\n' +
    'srv4,10.0.0.4,root,a&b<c\\d한글';
  const [r] = parseCsv(csv);
  assert.equal(r.password, 'a&b<c\\d한글');
});

test('parseCsv: 비밀번호 앞뒤 공백 보존(다른 필드는 trim)', () => {
  const csv = 'name,host,username,password\n' +
    ' srv5 , 10.0.0.5 , root ," pw "';
  const [r] = parseCsv(csv);
  assert.equal(r.name, 'srv5');       // trim됨
  assert.equal(r.host, '10.0.0.5');   // trim됨
  assert.equal(r.password, ' pw ');   // 공백 보존
});

test('parseCsv: 단순(비인용) CSV 하위호환 유지', () => {
  const csv = 'name,host,username,password\nsrv6,10.0.0.6,root,plainpw';
  const [r] = parseCsv(csv);
  assert.equal(r.password, 'plainpw');
  assert.equal(r.host, '10.0.0.6');
});
