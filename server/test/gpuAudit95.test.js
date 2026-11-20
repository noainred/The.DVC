// 전체 점검 95회차 — GPU 2차(물리 GPU 등록부 · 모델 명목 용량 · 물리 수집 MIG).
//   F1(중간 · 데이터 손실): 물리 GPU 서버 등록부(gpu-physical.json — SSH 계정)가 읽기 오류(EISDIR · EACCES)도 손상으로 보고 원본을 .corrupt.* 로 옮긴 뒤
//     빈 목록으로 돌아, 다음 등록 한 번이 그 한 건만 든 파일을 썼다 · 손상 표지가 없어 빈 목록이 '등록 없음' 처럼 보였다 · 원소 null 하나에 목록 · 등록이 TypeError.
//     → 공용 등록부 읽기(util/registryCore.js makeLoadError) · 읽기 오류 중 쓰기 409 · GET 에 loadError(요약) · 저장 결과를 보는 자동 등록.
//   F2(중간): inferGpuMemGB 가 PCI 장치 이름('GA102GL [A10]')에서 칩 이름 · 부분 글자로 틀린 명목값(A10 → 48 · A16 → 24 · RTX A4000 → 48)을 냈다.
//   개선: 물리 GPU 수집이 MIG(utilNA)의 파서 0 을 utilPct 로 싣던 것 → null.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gpuAudit95-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;
const FILE = path.join(TMP, 'gpu-physical.json');

// 읽기 오류(EISDIR) — 등록부 경로가 디렉터리. 모듈을 import 하기 전에 만든다(첫 읽기에서 판정이 선다).
fs.mkdirSync(FILE);
fs.writeFileSync(path.join(FILE, 'keep.txt'), 'x');

const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileRead.js');
let clock = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 떨어뜨린 기준 시각
_setJsonFileLoadClockForTest(() => clock);
const reg = await import('../src/gpu/physicalRegistry.js');

const USERS = { full: { username: 'full', role: 'admin', scope: null } };
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/admin`;
});
after(() => {
  _setJsonFileLoadClockForTest();
  try { srv?.close(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});
async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': 'full', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j };
}
const corruptCopies = () => fs.readdirSync(TMP).filter((n) => n.startsWith('gpu-physical.json.corrupt.'));

test('F1 ① 읽기 오류(EISDIR): 원본을 옮기지 않고 · 표지를 세우고 · 등록 · 수정 · 삭제를 거절한다(라우트 409) · 읽히면 재시작 없이 풀린다', async () => {
  assert.deepEqual(reg.listPhysical(), []);
  assert.equal(corruptCopies().length, 0, '읽기 오류는 손상이 아니다 — 보존본으로 옮기지 않는다');
  assert.ok(fs.statSync(FILE).isDirectory(), '원본(여기서는 디렉터리)이 그 자리에 그대로');
  const le = reg.physicalRegistryLoadError();
  assert.equal(le?.readError, true);
  const add = reg.addPhysical({ host: '10.0.0.9', username: 'u2', password: 'p2' });
  assert.equal(add.ok, false); assert.equal(add.status, 409); assert.equal(add.code, 'registry-unreadable');
  assert.equal(reg.removePhysical('x').status, 409);
  // 라우트: GET 은 loadError 요약을 싣는다(원문 조각 없음) · POST 409 · 자동 등록은 SSH 접속 전에 409
  const g = await call('GET', '/gpu-physical');
  assert.equal(g.s, 200);
  assert.equal(g.j.loadError?.readError, true);
  assert.equal(g.j.loadError?.code, 'read-error');
  const p = await call('POST', '/gpu-physical', { host: '10.0.0.9', username: 'u2', password: 'p2' });
  assert.equal(p.s, 409, JSON.stringify(p.j));
  const a = await call('POST', '/gpu-physical/auto-register', { host: '10.0.0.9', username: 'u2', password: 'p2' });
  assert.equal(a.s, 409, JSON.stringify(a.j));
  const b = await call('POST', '/gpu-physical/bulk-auto-register', { ips: '10.0.0.9', username: 'u2', password: 'p2' });
  assert.equal(b.s, 409, JSON.stringify(b.j));
  assert.ok(fs.statSync(FILE).isDirectory(), '어떤 경로도 원본 자리에 새 파일을 쓰지 않았다');
  // 설정 연동(서비스 모니터)은 읽기 오류 동안의 빈 목록을 '등록 0건' 으로 읽지 않는다 — 표지(registryLoadError)로 sourceErrors
  const LINKS = await import('../src/linkcheck/settingsLinks.js');
  const t = await LINKS.buildSettingsTargets({ snapshot: null, deploy: [], capture: [], credentials: [] });
  assert.ok(t.sourceErrors.some((e) => e.source === 'gpuPhysical'), JSON.stringify(t.sourceErrors));
  // 사람이 고친다(디렉터리 → 정상 파일) — 30초 간격이 지나면 다시 읽고 표지가 풀린다
  fs.rmSync(FILE, { recursive: true, force: true });
  fs.writeFileSync(FILE, JSON.stringify({ servers: [{ id: 'a', name: 'A', host: '10.0.0.5', username: 'root', password: 'pw' }, null, 'x'] }));
  clock += 31_000;
  const list = reg.listPhysical();
  assert.deepEqual(list.map((s) => s.id), ['a'], '원소 null · 글자는 거르고 정상 원소는 남긴다(예전에는 매 호출 TypeError)');
  assert.equal(reg.physicalRegistryLoadError(), null);
  assert.equal(reg.addPhysical({ host: '10.0.0.6', username: 'root', password: 'p' }).ok, true);
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')).servers.map((s) => s.host).sort();
  assert.deepEqual(saved, ['10.0.0.5', '10.0.0.6'], '기존 서버를 잃지 않았다');
});

test('F1 ② 손상: 보존본으로 옮기고 표지(GET loadError) · 관리자 저장은 새 등록부를 만들고 표지를 푼다 · 재시작 뒤 보존본만 있으면 여전히 표지', async () => {
  fs.writeFileSync(FILE, '{"servers":[{"id":"z","host":"10.0.0.7","username":"u","password":"SuperSecret123!"},');
  const fresh = await import(`../src/gpu/physicalRegistry.js?corrupt=${Date.now()}`);
  assert.deepEqual(fresh.listPhysical(), []);
  assert.equal(corruptCopies().length, 1, '손상본은 보존본으로');
  const sum = fresh.physicalRegistryLoadErrorSummary();
  assert.ok(sum && sum.readError === false && sum.code === 'parse-error', JSON.stringify(sum));
  assert.ok(!JSON.stringify(sum).includes('SuperSecre'), '요약에 파일 원문 조각을 싣지 않는다');
  // 재시작(새 모듈) — 파일 없음 + 보존본만 → 여전히 표지
  const again = await import(`../src/gpu/physicalRegistry.js?restart=${Date.now()}`);
  assert.ok(again.physicalRegistryLoadError(), '보존본만 남은 재시작도 못 읽은 상태다');
  const r = again.addPhysical({ host: '10.0.0.8', username: 'root', password: 'p' });
  assert.equal(r.ok, true, '손상(보존본으로 옮김)은 관리자 저장을 막지 않는다 — v2.612 규약');
  assert.equal(again.physicalRegistryLoadError(), null);
});

test('F1 ③ 수정은 사본을 고친다 — 거절된 수정이 메모리에 남지 않는다', async () => {
  const fresh = await import(`../src/gpu/physicalRegistry.js?upd=${Date.now()}`);
  const before = fresh.listPhysical().find((s) => s.host === '10.0.0.8');
  assert.ok(before);
  const bad = fresh.updatePhysical(before.id, { name: 'renamed', host: 'gpu.example' });
  assert.equal(bad.ok, false);
  assert.equal(fresh.getPhysicalRaw(before.id).name, before.name);
  const ok = fresh.updatePhysical(before.id, { name: 'renamed' });
  assert.equal(ok.ok, true);
  assert.equal(fresh.getPhysicalRaw(before.id).name, 'renamed');
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).servers.find((s) => s.id === before.id).name, 'renamed');
});

test('F1 ④ 웹 PhysicalGpuManager 는 loadError 배너를 보이고 · 삭제 거절 본문(ok:false)을 실패로 보인다(소스 계약)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', 'views', 'gpu-guest', 'PhysicalGpuManager.jsx'), 'utf8');
  assert.match(stripComments(src), /d\?\.loadError && <div className="banner warn"[^>]*>\{physicalLoadErrorText\(d\.loadError\)\}/);
  assert.match(stripComments(src), /const r = await delJson\(.*?\); if \(r && r\.ok === false\) setOpErr/);
});

test('F3 PUT /admin/metrics/settings — 설정 파일 읽기 오류 중 저장은 라우트가 409 + 사유(예전: 모듈 409 → 전역 핸들러 \'bad request\') · 화면은 거절 본문을 사유로', async () => {
  const MF = path.join(TMP, 'metrics.json');
  fs.mkdirSync(MF, { recursive: true });
  clock += 31_000;   // 재읽기 간격을 넘긴다(다른 시험이 먼저 읽었어도 디스크를 다시 본다)
  try {
    const r = await call('PUT', '/metrics/settings', { sampleIntervalMs: 60_000 });
    assert.equal(r.s, 409, JSON.stringify(r.j));
    assert.equal(r.j.ok, false);
    assert.match(String(r.j.reason || ''), /읽지 못해 저장하지 않았습니다/);
    assert.ok(fs.statSync(MF).isDirectory(), '원본 자리에 쓰지 않았다');
  } finally { fs.rmSync(MF, { recursive: true, force: true }); clock += 31_000; }
  for (const f of ['GpuSettings.jsx', 'MetricsSettings.jsx']) {
    const src = stripComments(fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', 'views', f), 'utf8'));
    assert.match(src, /const r = await putJson\('\/admin\/metrics\/settings'[\s\S]{0,400}?if \(!r \|\| r\.ok === false \|\| !r\.settings\) \{ setMsg\(/, f);
  }
});

test('F2 inferGpuMemGB — 낱말 경계로만 모델을 맞춘다(PCI 장치 이름 꼴 포함) · 여러 모델이 쓰는 칩 이름은 지어내지 않는다', async () => {
  const { inferGpuMemGB: f } = await import('../src/gpu/gpuModelMem.js');
  const cases = [
    ['GA102GL [A10]', 24], ['NVIDIA A10', 24], ['GA102GL [A40]', 48], ['NVIDIA A40', 48],
    ['GA107GL [A16]', 16], ['NVIDIA A16', 16], ['GA104GL [RTX A4000]', 0], ['NVIDIA RTX A4000', 0], ['GA102GL [RTX A5000]', 0], ['GA102GL', 0],
    ['AD102GL [L40S]', 48], ['NVIDIA L4', 24], ['AD104GL [L4]', 24], ['AD104GL', 24], ['TU104GL [Tesla T4]', 16], ['TU104GL', 16],
    ['GA100 [A100 PCIe 40GB]', 40], ['NVIDIA A100 80GB', 80], ['GRID A100-4C', 80], ['GH100 [H100 PCIe]', 80], ['NVIDIA H100 80GB', 80],
    ['NVIDIA A30', 24], ['Tesla V100', 32], ['Unknown GPU', 0], ['', 0], [null, 0],
  ];
  for (const [m, gb] of cases) assert.equal(f(m), gb, String(m));
  // 패스스루 용량(allocTree.gpuCapacityOf)도 같은 표 — A10 패스스루가 48 GB 로 잡히지 않는다 · 모르는 모델은 용량 모름(null)
  const { gpuCapacityOf } = await import('../src/gpu/allocTree.js');
  assert.deepEqual(gpuCapacityOf({ model: 'GA102GL [A10]', mode: 'passthrough', memGB: 0 }), { gb: 24, basis: 'model' });
  assert.deepEqual(gpuCapacityOf({ model: 'GA104GL [RTX A4000]', mode: 'passthrough', memGB: 0 }), { gb: null, basis: null });
  // vGPU A10(보고 22.5 GB) — 명목 24(예전 48 → 할당률 반토막)
  assert.deepEqual(gpuCapacityOf({ model: 'GA102GL [A10]', mode: 'vgpu', memGB: 22.5 }), { gb: 24, basis: 'nominal' });
  // 긴 입력은 자른다(선형)
  const t0 = process.hrtime.bigint(); f('A'.repeat(200_000)); assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200);
});

test('개선: 물리 GPU 수집은 MIG(utilNA)의 파서 0 을 utilPct 로 싣지 않는다(소스 계약 — 게스트 폴러와 같은 규칙)', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', 'gpu', 'physicalPoller.js'), 'utf8'));
  assert.match(src, /utilPct: r\.utilNA \? null : r\.utilPct, utilNA: !!r\.utilNA/);
});
