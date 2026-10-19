/**
 * test/audit2744fb.test.js — v2.744 최종 검토 그룹 FB(RD-R1·RG2744-03 · RD-R2·RG2744-01 · RG2744-04).
 *
 * 규칙: 등록부·설정 파일의 JSON.parse 오류 **원문**(V8 이 따옴표로 감싸 보여 주는 파일 조각 — 손상된 자격증명 파일이면 평문 비밀번호 앞부분)은
 *   저장·응답·콘솔 어디에도 싣지 않는다. 요약은 util/registryCore.js summarizeRegistryError 한 벌이고, 위치(줄·칸) 숫자가 든 요약(text)은
 *   관리자에게, 그 밖의 계정에는 분류 고정 문구(label)만 준다(GD-R1 fleetPartialsSummary 와 같은 규칙).
 *   형제 경로 셋이 남아 있었다:
 *   a. 베어메탈 사용률 폴러 sourceErrors(os-registry) → _last → GET /tools/bm-usage 상태(operator 도 본다) · 지금 수집 응답 · 콘솔
 *   b. 엣지 push 4종(SAN·CVP·PDU·스토리지)의 _last(엣지 로그로 중앙에 당겨진다) · 콘솔
 *   c. 수집 서버 연결 테스트(/collectors/test) — 2.743 엣지 export 503 본문의 error 원문을 reason·steps 에 그대로
 *
 * 실제 V8 메시지 · 실제 api 라우터 · 실제 registerCollectorsDc 라우터 · 실제 push 함수로 본다. 손상 파일은 import **전에** 쓴다
 *   (등록부 모듈은 처음 읽은 결과를 메모리에 둔다 — 저장하기 전까지 같은 오류를 계속 돌려준다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fb-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', IPAM_WRITE_WORKER: '0',
  BMUSAGE_ENABLED: 'true',
  // 엣지 push 경로가 돌도록 엣지 설정(닫힌 포트 — 중앙 버전 확인은 즉시 실패해 상태 전용 보고를 건너뛴다).
  CENTRAL_URL: 'http://127.0.0.1:1', CENTRAL_TOKEN: 'ctok-2744fb', AGENT_NAME: 'edge-fb',
});
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const SECRET = 'SuperSecret123!';
const LEAK = /SuperSecre|assword|uperSecret/;   // 원문 조각의 흔적(비밀번호 앞 글자 · 키 이름 조각)
const POS = /번째 줄|번째 칸|위치 \d/;           // 위치 숫자(관리자 요약에만)
// 비밀번호 칸 따옴표를 빠뜨린 손편집 — V8 메시지가 `..."assword": SuperSecre"...` 조각을 싣는다.
const bad = (key) => `{"${key}":[{"id":"d1","name":"d1","host":"192.0.2.1","username":"u","password": ${SECRET}}]}`;
const v8msg = (txt) => { try { JSON.parse(txt); } catch (e) { return e.message; } return ''; };
const RAW = v8msg(bad('servers'));

for (const [file, key] of [
  ['bm-storage.json', 'servers'], ['sanswitch-devices.json', 'devices'], ['cvp-servers.json', 'servers'],
  ['pdu-devices.json', 'devices'], ['storage-devices.json', 'devices'],
]) fs.writeFileSync(path.join(TMP, file), bad(key));

/** console.error·console.warn 를 잡는다(줄은 엣지 링 버퍼로 중앙 엣지 로그에 당겨진다). */
async function capture(fn) {
  const lines = []; const e = console.error; const w = console.warn;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  try { const v = await fn(); return { v, lines }; } finally { console.error = e; console.warn = w; }
}

let apiBase; let adminBase; let edgeBase; const closers = [];
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const listen = (srv) => new Promise((r) => { srv.listen(0, '127.0.0.1', () => { closers.push(() => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q); })); r(`http://127.0.0.1:${srv.address().port}`); }); });
  const inject = (req, _r, n) => { const role = req.get('x-role') || 'admin'; req.user = { username: role === 'admin' ? 'adm' : `u-${role}`, role, scope: null }; n(); };
  const a1 = express(); a1.use(express.json()); a1.use(inject); a1.use('/api', api); apiBase = await listen(http.createServer(a1));
  const r2 = express.Router(); registerCollectorsDc(r2);
  const a2 = express(); a2.use(express.json()); a2.use(inject); a2.use('/a', r2); adminBase = await listen(http.createServer(a2));
  // 가짜 엣지 — 경로 접두로 응답 모양을 고른다(연결 테스트는 `${url}/api/collector/export` 를 부른다).
  const edge = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '60' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v743/')) {
      // 2.743 엣지: detail·error 에 JSON.parse 원문을 그대로 싣는다.
      return send(503, { ok: false, reason: 'registryUnreadable', registry: 'idrac', detail: RAW, error: `엣지 iDRAC 등록부(idrac.json)를 읽지 못했습니다 — ${RAW}` });
    }
    if (req.url.startsWith('/v744/')) {
      // 2.744 엣지: 요약 + 기계 판정 필드(registryError). error 에 원문이 섞여 와도(변조·중간 버전) 쓰지 않아야 한다.
      return send(503, { ok: false, reason: 'registryUnreadable', registry: 'idrac', detail: 'JSON 형식 오류(1번째 줄 33번째 칸)', registryError: { code: 'parse-error', line: 1, column: 33, position: 32, sysCode: null }, error: `엣지 iDRAC 등록부(idrac.json)를 읽지 못했습니다 — ${RAW}` });
    }
    if (req.url.startsWith('/v500/')) return send(500, { error: RAW });   // export 500 경로(err.message)
    if (req.url.startsWith('/plain/')) return send(500, { error: '등록부 처리 중 시간 초과(ETIMEDOUT)' }); // 사람 문장은 그대로 남아야 한다
    return send(404, { ok: false });
  });
  edgeBase = await listen(edge);
});
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

/* ════════════════════ a. 베어메탈 사용률 sourceErrors ════════════════════ */

test('a-① 폴러 — OS 계정 등록부 로드 오류를 원문이 아니라 요약으로 sourceErrors·콘솔에 싣는다(지금 수집 응답 포함)', async () => {
  assert.match(RAW, LEAK, '전제: V8 메시지가 파일 조각을 싣는다');
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [], servers: [] }));
  const { v: r, lines } = await capture(() => P.pollBmUsageOnce({ trigger: 'manual' }));
  const se = (r.sourceErrors || []).find((x) => x?.source === 'os-registry');
  assert.ok(se, JSON.stringify(r).slice(0, 400));
  assert.doesNotMatch(JSON.stringify(r), LEAK, '수집 결과(지금 수집 응답의 원천)에 원문 조각');
  assert.match(se.error, /OS 계정 등록부를 읽지 못했습니다/);
  assert.match(se.error, /JSON 형식 오류/);
  assert.deepEqual(Object.keys(se).sort(), ['error', 'source'], '항목 모양(키)은 그대로');
  assert.ok(lines.some((l) => /\[bmusage\] 대상 해석 입력 실패\(os-registry\)/.test(l)), lines.join('\n'));
  for (const l of lines) assert.doesNotMatch(l, LEAK, `콘솔에 원문 조각: ${l}`);
  // 상태 객체(_last)에도 — 엣지 로그(collect.bmUsage)가 인자 없이 부른다.
  assert.doesNotMatch(JSON.stringify(P.bmUsageStatus()), LEAK);
  assert.doesNotMatch(JSON.stringify(P.bmUsageStatus({ detail: true })), LEAK);
});

test('a-② GET /tools/bm-usage · /activity · POST /collect — operator·admin 응답에 원문 조각 0', async () => {
  for (const role of ['operator', 'admin']) {
    for (const [method, p] of [['GET', '/api/tools/bm-usage'], ['GET', '/api/tools/bm-usage/activity'], ['POST', '/api/tools/bm-usage/collect']]) {
      const res = await fetch(`${apiBase}${p}`, { method, headers: { 'x-role': role, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      const txt = await res.text();
      assert.equal(res.status, 200, `${role} ${p}: ${txt.slice(0, 300)}`);
      assert.doesNotMatch(txt, LEAK, `${role} ${p} 응답에 원문 조각`);
      const j = JSON.parse(txt);
      const list = p.endsWith('/collect') ? j.sourceErrors : (p.endsWith('/activity') ? j.poller?.last?.sourceErrors : j.status?.last?.sourceErrors);
      const se = (list || []).find((x) => x?.source === 'os-registry');
      assert.ok(se, `${role} ${p}: sourceErrors 가 사라졌다 ${txt.slice(0, 300)}`);
      assert.match(se.error, /JSON 형식 오류/, `${role} ${p}`);
    }
  }
});

test('a-③ 관리자는 위치(줄·칸)까지, 그 밖의 계정은 분류 문구만 — sourceErrorsView 한 벌', async () => {
  const P = await import('../src/bmusage/poller.js');
  const sentence = (w) => `OS 계정 등록부를 읽지 못했습니다 — 대상 서버가 no-os-cred 로 보일 수 있습니다(${w})`;
  const posMsg = v8msg('{"a":"b" "c":1}');   // 위치가 든 V8 메시지(따옴표도 있다)
  const e = P.registrySourceError('os-registry', sentence, { at: 1, reason: posMsg });
  assert.match(e.error, POS, e.error);
  assert.doesNotMatch(e.error, /Expected|','/, '원문 글자를 옮기지 않는다');
  const leak = P.registrySourceError('os-registry', sentence, { at: 1, reason: RAW });
  assert.doesNotMatch(leak.error, LEAK);
  const [lab, lab2, other, keep] = P.sourceErrorsView([e, leak, { source: 'classify', error: '분류 실패' }, null], { detail: false });
  assert.equal(lab.source, 'os-registry');
  assert.match(lab.error, /JSON 형식 오류/);
  assert.doesNotMatch(lab.error, POS, `비관리자 문구에 위치: ${lab.error}`);
  assert.doesNotMatch(lab2.error, LEAK);
  assert.deepEqual(Object.keys(lab).sort(), ['error', 'source']);
  assert.deepEqual(other, { source: 'classify', error: '분류 실패' }, '등록부가 아닌 항목은 그대로');
  assert.equal(keep, null);
  const [adm] = P.sourceErrorsView([e], { detail: true });
  assert.equal(adm.error, e.error, '관리자는 요약 text 그대로');
  // 엣지가 보낸 사유처럼 객체가 아닌 값(문자열 원문)도 원문을 옮기지 않는다.
  assert.doesNotMatch(P.registrySourceError('os-registry', sentence, RAW).error, LEAK);
});

test('a-④ 라우트 배선 — 위치가 든 손상(별도 프로세스)에서 admin 은 줄·칸까지, operator 는 분류 문구만(상태·작업 로그·지금 수집 응답)', () => {
  // 등록부 모듈은 처음 읽은 결과를 메모리에 둔다 — 다른 손상 모양은 새 프로세스로 본다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fb-pos-'));
  try {
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
    fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
    fs.writeFileSync(path.join(dir, 'bm-storage.json'), '{"servers":[{"id":"s1","host":"192.0.2.9","username":"root","password":"x" "y":1}]}');
    const out = path.join(dir, 'out.json');
    const code = `
      import fs from 'node:fs';
      const P = await import('./src/bmusage/poller.js');
      P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [], servers: [] }));
      console.warn = () => {}; console.error = () => {};
      await P.pollBmUsageOnce({ trigger: 'manual' });
      const express = (await import('express')).default;
      const { api } = await import('./src/routes/api.js');
      const app = express(); app.use(express.json());
      app.use((req, _r, n) => { const role = req.get('x-role'); req.user = { username: 'u-' + role, role, scope: null }; n(); });
      app.use('/api', api);
      const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port;
      const res = {};
      for (const role of ['admin', 'operator']) {
        const g = await (await fetch(base + '/api/tools/bm-usage', { headers: { 'x-role': role } })).json();
        const a = await (await fetch(base + '/api/tools/bm-usage/activity', { headers: { 'x-role': role } })).json();
        const c = await (await fetch(base + '/api/tools/bm-usage/collect', { method: 'POST', headers: { 'x-role': role, 'Content-Type': 'application/json' }, body: '{}' })).json();
        const pick = (l) => (l || []).find((x) => x && x.source === 'os-registry')?.error || null;
        res[role] = { main: pick(g.status?.last?.sourceErrors), activity: pick(a.poller?.last?.sourceErrors), collect: pick(c.sourceErrors) };
      }
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(res));
      srv.closeAllConnections?.(); srv.close(); process.exit(0);
    `;
    const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const env = { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', BMUSAGE_ENABLED: 'true', IPAM_WRITE_WORKER: '0' };
    delete env.CENTRAL_URL;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', code], { cwd: serverDir, env, encoding: 'utf8', timeout: 60_000 });
    assert.ok(fs.existsSync(out), `자식 프로세스 실패: ${r.status} ${String(r.stderr).slice(0, 600)}`);
    const res = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const k of ['main', 'activity', 'collect']) {
      assert.match(String(res.admin[k]), /JSON 형식 오류\(1번째 줄 \d+번째 칸\)/, `admin ${k}: ${res.admin[k]}`);
      assert.match(String(res.operator[k]), /JSON 형식 오류/, `operator ${k}: ${res.operator[k]}`);
      assert.doesNotMatch(String(res.operator[k]), POS, `operator ${k} 에 위치 숫자: ${res.operator[k]}`);
      for (const role of ['admin', 'operator']) assert.doesNotMatch(String(res[role][k]), /Expected|','|'}'/, `${role} ${k} 에 원문 글자: ${res[role][k]}`);
    }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
});

test('a-⑤ maskPollerStatus 는 last.sourceErrors 의 관리 주소도 가린다(원본은 바꾸지 않는다)', async () => {
  const { maskPollerStatus } = await import('../src/auth/addressMask.js');
  const st = { running: false, last: { at: 1, sourceErrors: [{ source: 'idrac-registry', error: 'connect ECONNREFUSED 10.9.0.77:443 (idrac-a.corp.example)' }, null] } };
  const out = maskPollerStatus(st, ['10.9.0.77', 'idrac-a.corp.example']);   // 등록부 주소 목록(라우트의 bmAddressHosts)
  assert.doesNotMatch(JSON.stringify(out.last), /10\.9\.0\.77|idrac-a\.corp\.example/, JSON.stringify(out.last));
  assert.equal(out.last.sourceErrors[0].source, 'idrac-registry');
  assert.equal(out.last.sourceErrors[1], null);
  assert.match(st.last.sourceErrors[0].error, /10\.9\.0\.77/, '원본은 그대로');
});

/* ════════════════════ b. 엣지 push 4종 ════════════════════ */

test('b 엣지 push 4종(SAN·CVP·PDU·스토리지) — 등록부 로드 오류를 상태(_last)·콘솔에 원문으로 싣지 않는다', async () => {
  const san = await import('../src/sanswitch/push.js');
  const cvp = await import('../src/cvp/push.js');
  const pdu = await import('../src/pdu/push.js');
  const sto = await import('../src/storage/push.js');
  const { lines } = await capture(async () => {
    await san.pushSanSwitchNow().catch(() => null);
    await cvp.pushCvpNow().catch(() => null);
    await pdu.pushPduNow().catch(() => null);
    await sto.pushStorageNow().catch(() => null);
  });
  const sSan = san.sanSwitchPushStatus(); const sCvp = cvp.cvpPushStatus(); const sPdu = pdu.pduPushStatus(); const sSto = sto.storagePushStatus();
  for (const [k, v] of Object.entries({ san: sSan, cvp: sCvp, pdu: sPdu, storage: sSto })) assert.doesNotMatch(JSON.stringify(v), LEAK, `${k} 상태에 원문 조각: ${JSON.stringify(v).slice(0, 300)}`);
  for (const l of lines) assert.doesNotMatch(l, LEAK, `콘솔에 원문 조각: ${l}`);
  // 사유는 남아야 한다(조용히 지우지 않는다) — 키 이름도 그대로.
  assert.match(sSan.reason, /등록부를 읽지 못해 보내지 않았습니다\(JSON 형식 오류\)/, sSan.reason);
  assert.equal(sCvp.kind, 'edge-registry-unreadable');
  assert.match(sCvp.error, /엣지 CVP 등록부를 읽지 못해 보내지 않았습니다\(JSON 형식 오류\)/, sCvp.error);
  assert.equal(sPdu.registryError, 'JSON 형식 오류', JSON.stringify(sPdu));
  assert.equal(sPdu.withheld, true);
  for (const tag of ['[sanswitch-push]', '[cvp-push]', '[pdu-push]', '[storage-push]']) {
    assert.ok(lines.some((l) => l.includes(tag) && /등록부를 읽지 못해/.test(l) && /JSON 형식 오류/.test(l)), `${tag} 콘솔 줄이 사유를 잃었다\n${lines.join('\n')}`);
  }
});

/* ════════════════════ c. 수집 서버 연결 테스트 ════════════════════ */

test('c 수집 서버 연결 테스트 — 엣지 export 오류 본문의 원문을 reason·steps 에 싣지 않는다(puller exportFailError 와 같은 규칙)', async () => {
  const call = async (prefix) => {
    const res = await fetch(`${adminBase}/a/collectors/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${edgeBase}${prefix}`, token: 't'.repeat(24) }) });
    const txt = await res.text();
    assert.equal(res.status, 200, txt.slice(0, 300));
    return { txt, j: JSON.parse(txt) };
  };
  const v743 = await call('/v743');
  assert.doesNotMatch(v743.txt, LEAK, `2.743 본문: ${v743.j.reason}`);
  assert.equal(v743.j.ok, false);
  assert.match(v743.j.reason, /^HTTP 503 — /);
  assert.match(v743.j.reason, /엣지 iDRAC 등록부\(idrac\.json\)를 읽지 못함/);
  assert.match(v743.j.reason, /JSON 형식 오류/);
  assert.ok(v743.j.steps.some((s) => /export HTTP 503 — .*JSON 형식 오류/.test(s.msg)), JSON.stringify(v743.j.steps));

  const v744 = await call('/v744');
  assert.doesNotMatch(v744.txt, LEAK, `2.744 본문(error 에 원문이 섞여 와도): ${v744.j.reason}`);
  assert.match(v744.j.reason, /JSON 형식 오류\(1번째 줄 33번째 칸\)/, '관리자 화면 — 위치 숫자는 남긴다');

  const v500 = await call('/v500');
  assert.doesNotMatch(v500.txt, LEAK, `500 본문: ${v500.j.reason}`);
  assert.match(v500.j.reason, /^HTTP 500 — JSON 형식 오류/);

  const plain = await call('/plain');
  assert.match(plain.j.reason, /등록부 처리 중 시간 초과\(ETIMEDOUT\)/, '따옴표 없는 사람 문장은 그대로');

  const nf = await call('/nf');
  assert.match(nf.j.reason, /^HTTP 404/);
  assert.match(nf.j.reason, /COLLECTOR_TOKEN이 설정되지 않았습니다/, '상태코드 힌트는 그대로');
});
