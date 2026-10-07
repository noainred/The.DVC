/**
 * audit2719b.test.js — v2.719 그룹 B: mock 모드 데모 계정의 '실접속 GET' 과 보안 조회 차단(R1-02·R1-08).
 *
 * ① 순수 판정 — 실접속 GET·보안 조회는 거부, 같은 화면의 캐시 조회는 허용.
 * ② 실제 라우터 스택(api·admin·ping 등)을 자식 프로세스에서 훑는다 —
 *    · LIVE_GET_DENY 의 경로가 전부 실재하는 GET 라우트인지(목록이 낡지 않게)
 *    · 라우트 소스에서 실제 접속 함수를 부르는 GET 핸들러를 찾아 그 URL 이 전부 거부되는지(새 실접속 GET 누락을 잡는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demoGuestDenial, LIVE_GET_DENY, READ_DENY } from '../src/auth/demoGuest.js';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

test('① 실접속 GET 은 거부, 같은 경로의 캐시 조회는 허용 (R1-02)', () => {
  for (const u of ['/api/admin/vcenter/relay-test?host=127.0.0.1:4931', '/api/Admin/vCenter/Relay-Test/',
    '/api/admin/idrac/srv-1/gpu-probe', '/api/admin/idrac/srv-1/inventory?refresh=1',
    '/api/admin/idrac/srv-1/inventory?x=2&refresh=%31', '/api/admin/idrac/srv-1/sensors?live=1',
    '/api/admin/idrac/srv-1/sensors?live=0&live=1', '/api/tools/network-check']) {
    assert.ok(demoGuestDenial('GET', u), `GET ${u}`);
    assert.ok(demoGuestDenial('HEAD', u), `HEAD ${u}`);
  }
  for (const u of ['/api/admin/idrac/srv-1/inventory', '/api/admin/idrac/srv-1/inventory?refresh=0',
    '/api/admin/idrac/srv-1/sensors?minutes=60', '/api/admin/idrac', '/api/tools/service-check', '/api/tools/portal-check/arch'])
    assert.equal(demoGuestDenial('GET', u), null, u);
});

test('① 보안·비밀 조회(/api/tools 아래)도 거부 (R1-08)', () => {
  for (const u of ['/api/tools/secret-scan', '/api/tools/portal-check/tokens', '/api/tools/Portal-Check/Tokens/'])
    assert.ok(demoGuestDenial('GET', u), u);
  assert.ok(READ_DENY.includes('/api/tools/secret-scan'));
});

// 실제 장비·네트워크에 접속하는 함수(라우트 핸들러에서 부르면 '실접속 GET').
const LIVE_CALLEES = ['probeRelayPath', 'fetchIdracInventory', 'fetchIdracSensors', 'probeGpuTelemetry', 'getNetworkCheck', 'tcpProbeMany', 'tcpProbe('];

/** 라우트 파일에서 '실접속 함수를 부르는 GET 선언' → [{ lit, query }]. 질의 조건(req.query.X === '1')이 그 앞에 있으면 함께. */
function liveGetDecls() {
  const out = [];
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(SRC, 'routes'));
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /\b\w+\.(get|post|put|patch|delete|use)\(\s*'([^']+)'/g;
    const decls = [...src.matchAll(re)].map((m) => ({ method: m[1], lit: m[2], at: m.index }));
    decls.forEach((d, i) => {
      if (d.method !== 'get') return;
      const body = src.slice(d.at, i + 1 < decls.length ? decls[i + 1].at : src.length);
      const callee = LIVE_CALLEES.find((c) => body.includes(c));
      if (!callee) return;
      const ci = body.indexOf(callee);
      const qm = body.slice(0, ci).match(/req\.query\.(\w+)\s*===\s*'([^']+)'/);
      out.push({ file: path.relative(SRC, f), lit: d.lit, query: qm ? [qm[1], qm[2]] : null });
    });
  }
  return out;
}

function routerGetPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719b-'));
  const script = `
    const R = ${JSON.stringify(path.join(SRC, 'routes') + '/')};
    const list = [['/api','api.js','api'],['/api/admin','admin.js','adminRouter'],['/api/ping','ping.js','pingRouter'],
      ['/api/svcmon','svcmon.js','svcmonRouter'],['/api/capacity','capacity.js','capacityRouter'],['/api/insights','insights.js','insightsRouter'],
      ['/api/remote','remote.js','remoteRouter'],['/api/upgrade','upgrade.js','upgradeRouter']];
    const out = [];
    const walk = (stack, pre) => { for (const l of stack) {
      if (l.route) { if (l.route.methods.get) out.push(pre + l.route.path); }
      else if (l.handle && l.handle.stack) { const m = (l.regexp && l.regexp.source || '').match(/^\\^\\\\\\/(.*?)\\\\\\/\\?\\(\\?=/); walk(l.handle.stack, pre + (m ? '/' + m[1].replace(/\\\\\\//g, '/') : '')); } } };
    for (const [pre, f, n] of list) { const m = await import(R + f); walk(m[n].stack, pre); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_SECRET: 'x'.repeat(40) },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600));
  return JSON.parse(line.slice(2));
}

const toUrl = (p, q) => p.replace(/:[A-Za-z_]\w*/g, 'x') + (q ? `?${q[0]}=${q[1]}` : '');

test('② 라우터 스택: LIVE_GET_DENY 는 실재 GET 이고, 실접속 함수를 부르는 GET 은 전부 거부된다', () => {
  const gets = routerGetPaths();
  assert.ok(gets.length > 300, `GET 라우트 ${gets.length}개 — 스택을 제대로 못 읽었다`);
  const lower = new Set(gets.map((g) => g.toLowerCase()));
  for (const d of LIVE_GET_DENY) assert.ok(lower.has(d.path.toLowerCase()), `LIVE_GET_DENY 의 ${d.path} 가 라우터 스택에 없다(낡은 목록)`);

  const decls = liveGetDecls();
  // 감사 시점에 확인한 다섯 곳은 반드시 잡혀야 한다(스윕 자체가 무력해지지 않게).
  assert.ok(decls.length >= 5, JSON.stringify(decls));
  for (const d of decls) {
    const full = gets.filter((g) => g.endsWith(d.lit));
    assert.ok(full.length, `${d.file} 의 GET ${d.lit} 를 라우터 스택에서 못 찾았다`);
    for (const g of full) {
      const u = toUrl(g, d.query);
      assert.ok(demoGuestDenial('GET', u), `데모 계정에 열린 실접속 GET: ${u} (${d.file})`);
    }
  }
});
