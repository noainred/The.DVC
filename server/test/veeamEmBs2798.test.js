/**
 * v2.798 — EM 백업 서버 목록 보강(사용자 보고: 'EM 에 등록된 서버가 많은데 전체 리스트를 가져오지 못한다' — 매핑 표에도 일부만 보임).
 *  · 목록이 EM 개요의 서버 수보다 적으면 질의 서비스(type=BackupServer)로 다시 읽어 이름(대소문자 무시)으로 합친다
 *  · 그래도 모자라면 비고·매핑 화면에 '개요 N대 · 목록 M대' 를 밝힌다(원인은 추정 — 계정 역할) · 질의 실패는 목록을 살리고 사유만 · 인증 실패는 위로
 *  · 개요 수를 모르면 그대로(지어내지 않는다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamEmBs2798-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const EC = await import('../src/veeam/em/client.js');
const { emMappingView } = await import('../src/routes/admin/veeamEm.js');
const srv = (n) => ({ Name: n, UID: `urn:veeam:BackupServer:${n}`, Port: 9392 });
const fake = (body, calls = []) => ({ mask: (x) => x, get: async (p) => { calls.push(p); if (body instanceof Error) throw body; return body; } });

test('A 모자라면 질의 서비스로 합친다 — 이름 대소문자 무시 · 메타 · 비고', async () => {
  const calls = [];
  const r = await EC.completeBackupServers(fake({ Entities: { BackupServers: { BackupServers: [srv('gm1'), srv('HD'), srv('HM_SDBX')] } } }, calls), [{ name: 'GM1' }], 3);
  assert.deepEqual(r.list.map((s) => s.name), ['GM1', 'HD', 'HM_SDBX'], '이미 받은 GM1 은 중복으로 넣지 않는다');
  assert.deepEqual(r.meta, { overview: 3, listed: 1, merged: 3, viaQuery: true });
  assert.match(r.note, /1대뿐이라 질의 서비스로 다시 읽어 3대로/);
  assert.match(calls[0], /type=BackupServer/);
});

test('B 그래도 모자라면 개요 N대 · 목록 M대를 밝힌다(원인은 추정) · 질의 실패는 목록 유지', async () => {
  const r = await EC.completeBackupServers(fake({ BackupServers: [srv('GM1')] }), [{ name: 'GM1' }], 22);
  assert.deepEqual([r.meta.merged, r.meta.overview], [1, 22]);
  assert.match(r.note, /개요는 백업 서버 22대인데 목록은 1대만.*역할.*추정/);
  const e = await EC.completeBackupServers(fake(Object.assign(new Error('404 not found'), { status: 404 })), [{ name: 'A' }], 5);
  assert.deepEqual([e.list.map((s) => s.name), e.meta.viaQuery], [['A'], false]);
  assert.match(e.note, /질의 서비스도 실패: 404/);
  await assert.rejects(EC.completeBackupServers(fake(Object.assign(new Error('401'), { fatal: true })), [], 5), /401/, '인증 실패는 삼키지 않는다');
});

test('C 개요 수를 모르거나 목록이 충분하면 그대로 — 질의하지 않는다', async () => {
  const calls = [];
  const a = await EC.completeBackupServers(fake({}, calls), [{ name: 'A' }], null);
  const b = await EC.completeBackupServers(fake({}, calls), [{ name: 'A' }, { name: 'B' }], 2);
  assert.deepEqual([a.note, b.note, calls.length], ['', '', 0]);
});

test('D 매핑 화면 — EM 별 서버 수(개요 · 받은 목록)를 싣는다', () => {
  const v = emMappingView([{ id: 'em1', name: 'HQ' }], {
    recOf: () => ({ result: { ok: true, ts: Date.now(), backupServers: [{ name: 'GM1' }], backupServersMeta: { overview: 22, listed: 1, merged: 1, viaQuery: true } } }),
    map: {}, brServers: [], vcenters: [], healthy: () => false,
  });
  assert.deepEqual(v.counts, [{ emId: 'em1', emName: 'HQ', overview: 22, listed: 1, merged: 1, viaQuery: true }]);
  assert.equal(v.rows.length, 1);
});
