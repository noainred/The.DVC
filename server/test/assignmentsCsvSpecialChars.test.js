import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 위임(에이전트) iDRAC 스캔 자격증명 CSV — 특수문자 비밀번호 보존(RFC 4180).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-csv-'));
process.env.CONFIG_DIR = tmp;
let assignments;
before(async () => { assignments = await import('../src/central/assignments.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('assignments.parseCsv: 따옴표로 감싼 쉼표 포함 비밀번호 보존', () => {
  const csv = 'agent,ips,username,password,enabled\n' +
    'edge-pl,10.0.0.0/24,root,"p@ss,w0rd",true';
  const [r] = assignments.parseCsv(csv);
  assert.equal(r.password, 'p@ss,w0rd');
  assert.equal(r.enabled, true); // ,w0rd가 enabled 칸으로 밀리지 않음
  assert.equal(r.agent, 'edge-pl');
});

test('assignments.parseCsv: 비인용 특수문자(&,<,백슬래시,한글) 그대로', () => {
  const csv = 'agent,ips,username,password\nedge2,10.0.1.0/24,root,a&b<c\\d한글';
  const [r] = assignments.parseCsv(csv);
  assert.equal(r.password, 'a&b<c\\d한글');
});

test('assignments.parseCsv: 비밀번호 앞뒤 공백 보존', () => {
  const csv = 'agent,ips,username,password\nedge3,10.0.2.0/24,root," pw "';
  const [r] = assignments.parseCsv(csv);
  assert.equal(r.password, ' pw ');
});

test('assignments.parseCsv: 헤더 없는 CSV + # 주석 무시', () => {
  const csv = '# comment line\nedge4,10.0.3.0/24,root,"x,y"';
  const rows = assignments.parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].password, 'x,y');
});

test('assignments.parseCsv: 단순(비인용) 하위호환', () => {
  const csv = 'agent,ips,username,password,enabled\nedge5,10.0.4.0/24,root,plainpw,false';
  const [r] = assignments.parseCsv(csv);
  assert.equal(r.password, 'plainpw');
  assert.equal(r.enabled, false);
});
