// v2.782(점검 K5 G-I1): 개별 토큰 발급의 save 가 실패하면 메모리 캐시를 되돌린다 — 예전에는 push/교체가 먼저 되고 save 가 던져
//   디스크에는 없고 메모리에만 있는 '유령 토큰' 이 재시작 전까지 남았다(다음 토큰 적용 사전 점검이 '이미 발급됨' 으로 막히고, 그 해시는 인증도 통과).
// 저장 실패 주입: 대상 파일 경로에 '비어 있지 않은 디렉터리' 를 둔다 — atomicWriteFileSync 의 rename(tmp → 파일)이 root 로도 실패한다
//   (읽기 전용 디렉터리는 root 실행에서 막히지 않아 쓰지 않았다). 캐시는 이미 올라와 있어 load() 는 파일을 다시 읽지 않는다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-k5-tok-'));
process.env.CONFIG_DIR = CFG;
const FILE = path.join(CFG, 'central-agent-tokens.json');

let T;
before(async () => { T = await import('../src/central/agentTokens.js'); T._resetAgentTokenCache(); });

const breakSave = () => { fs.rmSync(FILE, { force: true, recursive: true }); fs.mkdirSync(FILE); fs.writeFileSync(path.join(FILE, 'keep'), 'x'); };
const fixSave = (snapshot) => { fs.rmSync(FILE, { force: true, recursive: true }); if (snapshot != null) fs.writeFileSync(FILE, snapshot, { mode: 0o600 }); };
const agents = () => T.listAgentTokens().map((t) => t.agent).sort();

test('G-I1 새 발급의 save 실패 — 캐시에 유령 항목이 남지 않고, 고친 뒤 다시 발급된다', () => {
  const a = T.issueAgentToken('edge-a');
  assert.equal(a.ok, true);
  const snap = fs.readFileSync(FILE, 'utf8');
  breakSave();
  assert.throws(() => T.issueAgentToken('edge-b'));
  assert.deepEqual(agents(), ['edge-a'], '실패한 발급이 메모리 목록에 남았다(유령 토큰)');
  fixSave(snap);
  const b = T.issueAgentToken('edge-b');
  assert.equal(b.ok, true);
  assert.deepEqual(agents(), ['edge-a', 'edge-b']);
  const disk = JSON.parse(fs.readFileSync(FILE, 'utf8')).tokens.map((t) => t.agent).sort();
  assert.deepEqual(disk, ['edge-a', 'edge-b']);
  assert.equal(T.resolveAgentByToken(a.token), 'edge-a');
  assert.equal(T.resolveAgentByToken(b.token), 'edge-b');
});

test('G-I1 재발급(회전)의 save 실패 — 옛 항목을 되돌린다(옛 토큰은 디스크와 같이 계속 인증, 새 해시는 메모리에 없음)', () => {
  T._resetAgentTokenCache();
  const old = T.issueAgentToken('edge-c');
  assert.equal(old.ok, true);
  const snap = fs.readFileSync(FILE, 'utf8');
  const before = T.listAgentTokens().find((t) => t.agent === 'edge-c');
  breakSave();
  assert.throws(() => T.issueAgentToken('edge-c', { note: 'rotate' }));
  const now = T.listAgentTokens().find((t) => t.agent === 'edge-c');
  assert.deepEqual(now, before, '교체가 되돌려지지 않았다');
  assert.equal(T.resolveAgentByToken(old.token), 'edge-c'); // touch 의 save 실패는 인증에 영향 없음
  fixSave(snap);
  T._resetAgentTokenCache();
  assert.equal(T.resolveAgentByToken(old.token), 'edge-c');
  const again = T.issueAgentToken('edge-c');
  assert.equal(again.ok, true);
  assert.equal(T.resolveAgentByToken(old.token), null);
  assert.equal(T.resolveAgentByToken(again.token), 'edge-c');
});

test('G-I1 원자적 쓰기·0600 유지(되돌림 코드가 쓰기 경로를 바꾸지 않았다)', () => {
  const src = fs.readFileSync(new URL('../src/central/agentTokens.js', import.meta.url), 'utf8');
  assert.match(src, /atomicWriteFileSync\(FILE, [^\n]*mode: 0o600/);
  assert.match(src, /renameSync\(FILE, `\$\{FILE\}\.corrupt\./); // preserveCorrupt — 손상본 보존
  if (process.platform !== 'win32') assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
});
