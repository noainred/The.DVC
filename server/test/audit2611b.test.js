/**
 * v2.611 감사 그룹 B — 권한·범위(scope). 하니스는 audit2607a 와 같다(실제 adminRouter 를 express 에 마운트하고
 * 요청자를 헤더로 주입 — 'full' = 전체 범위 admin, 'sadm' = vc-us-east 로 범위가 제한된 admin). **상태코드·파일 상태**로 본다.
 *   AUTHZ2611-01 iDRAC 등록부 쓰기·스캔 실행(재귀속 → 삭제로 범위 밖 서버 제거)
 *   AUTHZ2611-02 전 법인 등록부(vCenter 가져오기 replace · 수집 서버 · DataCenter · Horizon · 배정 · 물리 GPU · 엣지 배포 ·
 *                LLM · NFS · 폴더 사용량) — v2.607 fleetWideOnly 의 형제
 *   AUTHZ2611-03 서버 로그·/status·relay-test
 *   AUTHZ2611-04 연동 키 발급·수정
 *   AUTHZ2611-05 site vCenter 병합에서 location.region 은 등록부 값 우선(엣지가 지역 범위를 바꾸지 못한다)
 *   LEFT2611-02·04·07 IPAM 설정 범위 병합 · 대역 CSV dryRun 존재 은닉 · 스캔 설정/상태 게이트
 *   LEFT2611-03 GPU 게스트 설정 범위 + 계정명 변경 시 비밀번호 비승계
 *   LEFT2611-05 FinOps 숫자 칸 빈 값 = 미지정 · 명시적 0 = 값
 *   LEFT2611-06 수집 서버 URL 끝 '/' 제거 선형 + 길이 상한
 *   LEFT2611-08 중앙→엣지 호출에 수집 서버 id 태그
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function runChild(body, { env = {}, setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611b-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const auth = await import(SRC + 'auth/auth.js');
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const { remoteRouter } = await import(SRC + 'routes/remote.js');
    auth.createUser({ username: 'boss', role: 'admin', name: 'B' }, { trusted: true });
    auth.createUser({ username: 'sadm', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'sub', role: 'viewer', name: 'U', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'euop', role: 'operator', name: 'E', scope: { vcenters: ['vc-eu-west'] } }, { trusted: true });
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => {
      const name = req.headers['x-u'] || 'full';
      if (name === 'full') { req.user = { username: 'full', role: 'admin', scope: null }; return n(); }
      const u = auth.listUsers().find((x) => x.username === name);
      req.user = u ? { username: u.username, role: u.role, scope: u.scope } : null; n();
    });
    app.use('/api/admin', adminRouter); app.use('/api/remote', remoteRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const userRec = (n) => auth.listUsers().find((x) => x.username === n) || null;
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

