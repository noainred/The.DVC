import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync, preserveCorrupt } from '../src/util/atomicWrite.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
const file = path.join(dir, 'sub', 'data.json');

test('atomicWriteFileSync: 디렉터리 생성 + 쓰기/읽기 라운드트립', () => {
  atomicWriteFileSync(file, JSON.stringify({ a: 1 }), { mode: 0o600 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
});

test('atomicWriteFileSync: 덮어쓰기에도 모드 0600 유지', () => {
  atomicWriteFileSync(file, JSON.stringify({ a: 2 }), { mode: 0o600 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('atomicWriteFileSync: 임시파일이 남지 않음(rename으로 교체)', () => {
  atomicWriteFileSync(file, 'x', { mode: 0o600 });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
  assert.equal(leftovers.length, 0);
});

test('preserveCorrupt: 손상본을 .corrupt.<ts>로 옮기고 원본을 비운다(다음 저장의 덮어쓰기 방지)', () => {
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-'));
  const cfile = path.join(cdir, 'vcenters.json');
  fs.writeFileSync(cfile, '{ this is : truncated'); // 손상 JSON
  const bak = preserveCorrupt(cfile, 'test');
  assert.ok(bak, '백업 경로 반환');
  assert.ok(bak.includes('.corrupt.'), '.corrupt 접미사');
  assert.equal(fs.existsSync(cfile), false, '원본은 옆으로 치워져 사라짐');
  assert.equal(fs.readFileSync(bak, 'utf8'), '{ this is : truncated', '손상본 내용 보존');
  fs.rmSync(cdir, { recursive: true, force: true });
});

test('preserveCorrupt: 파일이 없으면 null(무해)', () => {
  assert.equal(preserveCorrupt(path.join(dir, 'nope.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
