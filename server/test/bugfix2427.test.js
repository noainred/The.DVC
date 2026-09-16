/**
 * v2.427 — 리뷰 버그 1~7 수정 회귀 테스트(서버 측: 브로커 카운터 디바운스, 중계 커서 리셋·meta 청크, 스토리지 signal 양방향).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bug2425-'));

test('#1 brokerFetch 는 비밀 파일을 다시 쓰지 않고(재봉인 없음) 카운터를 별도 파일에 디바운스 저장한다', async () => {
  const cs = await import('../src/security/credentialStore.js');
  const saved = cs.saveCredential({ name: 'svc', kind: 'password', username: 'u', password: 'p', agents: ['A'], hosts: ['10.0.0.1'] }, { actor: 't' });
  const file = path.join(process.env.CONFIG_DIR, 'credentials.json');
  const before = fs.readFileSync(file, 'utf8');
  const r = cs.brokerFetch(saved.id, { agent: 'A', host: '10.0.0.1' });
  assert.equal(r.ok, true); assert.equal(r.secret.password, 'p');
  assert.equal(fs.readFileSync(file, 'utf8'), before, '브로커 인출이 비밀 파일을 재기록하지 않는다');
  assert.equal(fs.existsSync(path.join(process.env.CONFIG_DIR, 'credentials-usage.json')), false, '디바운스 전');
  cs._flushUsageForTest();
  const usage = JSON.parse(fs.readFileSync(path.join(process.env.CONFIG_DIR, 'credentials-usage.json'), 'utf8'));
  assert.equal(usage[saved.id].useCount, 1);
  assert.ok(!JSON.stringify(usage).includes('"p"'), '카운터 파일에 비밀 없음');
  assert.equal(cs.listCredentials().find((c) => c.id === saved.id).useCount, 1);
});

test('#2 reconcileCursor: 커서가 MAX(rowid) 보다 크면 0 으로, 아니면 유지', async () => {
  const { reconcileCursor } = await import('../src/sanswitch/perfPush.js');
  assert.equal(reconcileCursor(500000, 120), 0);
  assert.equal(reconcileCursor(100, 120), 100);
  assert.equal(reconcileCursor(0, 0), 0);
  assert.equal(reconcileCursor(50, null), 50, 'DB 비활성(null)이면 유지');
});

test('#3 chunkMeta: meta 도 예산 안에서 나뉜다(청크 0 에 전량 적재 금지)', async () => {
  const { chunkMeta } = await import('../src/sanswitch/perfPush.js');
  const meta = Array.from({ length: 2560 }, (_, i) => ({ d: 'sw-director-1', p: i, ts: 1700000000000, name: 'SYMMETRIX::000497700230::SAF-1d 4::FC', wwn: '50:00:09:73:98:0a:0b:0c', speed: '32G', type: 'F-Port' }));
  const chunks = chunkMeta(meta, 100 * 1024);
  assert.ok(chunks.length >= 3, `2,560 포트 meta 는 100KB 예산에서 여러 청크 (${chunks.length})`);
  for (const c of chunks) assert.ok(JSON.stringify(c.map((m) => [m.d, m.p, m.ts, m.name, m.wwn, m.speed, m.type])).length <= 100 * 1024 + 200);
  assert.equal(chunks.flat().length, meta.length);
});

test('#4 storage testDeviceConnection 은 signal 을 device._signal 과 opts.signal 양쪽으로 전달한다', async () => {
  const src = fs.readFileSync(new URL('../src/storage/poller.js', import.meta.url), 'utf8');
  assert.match(src, /fn\(\{ \.\.\.full, _signal: signal \}, \{ signal \}\)/, '폴러 경로');
  // v2.525: 연결 테스트 경로에 `_test: true` 가 추가됐다(Unity SSH 가 이때만 전 명령 원문을
  // 담게 하는 표시). signal 두 갈래 전달 규약 자체는 그대로여야 하므로 그 부분만 고정한다.
  assert.match(src, /fn\(\{ \.\.\.device, _signal: ac\.signal,[^)]*\}, \{ signal: ac\.signal \}\)/, '연결 테스트 경로');
});
