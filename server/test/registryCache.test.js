import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 저장소 server/config 오염 방지 — import 전에 CONFIG_DIR 고정.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-reg-cache-'));
process.env.CONFIG_DIR = tmp;
const FILE = path.join(tmp, 'idrac.json');

let reg;
before(async () => { reg = await import('../src/idrac/registry.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('loadRegistry copy-on-read: 반환본 변형이 다음 호출에 새지 않고, 파일 변경은 반영된다', () => {
  fs.writeFileSync(FILE, JSON.stringify({ servers: [{ id: 's1', name: 'A', password: 'pw' }] }));
  const a = reg.loadRegistry();
  assert.equal(a[0].name, 'A');
  a[0].name = '변조'; // 호출부가 저장 없이 변형해도
  const b = reg.loadRegistry();
  assert.equal(b[0].name, 'A', '캐시가 오염되지 않는다(구조 복사본 반환)');
  assert.notEqual(a[0], b[0], '호출마다 독립 객체(기존 계약 유지)');

  // 외부(파일) 변경은 mtime/size 로 감지되어 반영된다.
  fs.writeFileSync(FILE, JSON.stringify({ servers: [{ id: 's1', name: 'B', password: 'pw' }] }));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(FILE, future, future); // 같은 초 내 재기록 대비 mtime 강제 변경
  assert.equal(reg.loadRegistry()[0].name, 'B');

  // 파일 삭제 시 빈 목록 + 캐시 무효화.
  fs.rmSync(FILE);
  assert.deepEqual(reg.loadRegistry(), []);
});
