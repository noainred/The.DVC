/**
 * v2.599 — 10차 점검 그룹 a 확정분 회귀 고정.
 *   RECENT2599-01(bmusage 지속 판정) · RECENT2599-02 = LO2599-02 = SEC2599-01(secretVault 재사용 문맥) ·
 *   SEC2599-02(uemcli 줄끝 공백 O(n²)) · SEC2599-03(게스트 임시 파일 잔존) · C2599-10(MIG 혼합 부분 평균) ·
 *   SEC2599-04(로그 가림 Basic·URL 사용자정보) · SEC2599-05(엣지 배포 토큰이 셸 인자로).
 *
 * 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다. 기준 시각은 고정값이다(Date.now() 금지 — CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2599a-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

const T0 = 1_790_000_000_000;   // 고정 기준 시각

/* ── RECENT2599-01 관측 간격이 '주기 + 수집 시간' 이어도 지속 알림이 울린다 ── */
test('RECENT2599-01 — 주기 300초 · 수집 160초(관측 간격 460초)에서 15분 지속이면 알린다', async () => {
  const { stepAlert } = await import('../src/bmusage/alertRules.js');
  const run = (gapMs, cfgExtra, n = 40) => {
    let st = null; let t = T0; let fired = null; let maxOverMs = 0;
    for (let i = 0; i < n; i += 1) {
      const o = stepAlert(st, 99, { pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 300_000, ...cfgExtra }, t);
      st = o.state; maxOverMs = Math.max(maxOverMs, st?.overMs ?? 0);
      if (o.fire === 'over' && fired == null) fired = i;
      t += gapMs;
    }
    return { fired, maxOverMs };
  };
  const r = run(460_000, { runMs: 160_000 });
  assert.notEqual(r.fired, null, `수집 시간을 반영하면 알림이 울려야 한다(overMs 최대 ${r.maxOverMs})`);
  assert.ok(r.fired <= 3, `15분 지속 = 460초 간격 2~3회 뒤(실제 ${r.fired})`);
  // 공백 보호(v2.598 IDRAC-2598-04)는 그대로 — 수집 시간을 넘는 긴 공백은 '지속' 이 아니다.
  const gap = run(3_600_000, { runMs: 160_000 }, 5);
  assert.equal(gap.fired, null, '1시간 공백을 사이에 둔 두 초과는 지속이 아니다');
  assert.equal(gap.maxOverMs, 0);
});

test('RECENT2599-01 — 폴러가 이번 수집 시간을 알림 판정까지 넘긴다', () => {
  assert.match(read('bmusage/poller.js'), /runBmUsageAlerts\(rows,\s*\{\s*\.\.\.settings,\s*runMs:\s*Date\.now\(\)\s*-\s*t0\s*\}\)/);
  assert.match(read('bmusage/notify.js'), /runMs:\s*settings\.runMs/);
});

/* ── RECENT2599-02 = LO2599-02 = SEC2599-01 맵 키·배열 위치로만 구분되는 대상의 같은 비밀 ── */
const POL = { mode: 'encrypted', level: 2 };

test('SEC2599-01 — gpu-guest 모양(맵 키로만 구분)의 같은 비밀번호가 서로 다른 암호문이 된다', async () => {
  const v = await import('../src/security/secretVault.js');
  const data = { vcenters: {
    'vc-a': { enabled: true, username: 'root', password: 'Same#2599a', vms: { 'vm-1': { username: 'root', password: 'Same#2599a' }, 'vm-2': { username: 'root', password: 'Same#2599a' } } },
    'vc-b': { enabled: true, username: 'root', password: 'Same#2599a', vms: {} },
  } };
  const s = v.sealSecretsDeep(data, POL);
  const all = [s.vcenters['vc-a'].password, s.vcenters['vc-b'].password, s.vcenters['vc-a'].vms['vm-1'].password, s.vcenters['vc-a'].vms['vm-2'].password];
  assert.equal(new Set(all).size, 4, '서로 다른 대상의 같은 비밀번호가 같은 암호문이면 파일에서 "같다" 가 드러난다');
  // 식별 필드 없는 배열 원소
  const arr = v.sealSecretsDeep([{ password: 'arr#2599a' }, { password: 'arr#2599a' }], POL);
  assert.notEqual(arr[0].password, arr[1].password);
  // 한 봉인 안에서는 문맥이 겹쳐도 같은 암호문을 두 번 내지 않는다(v2.598 버그로 이미 같은 암호문을 가진 파일)
  const legacy = v.sealSecret('dup#2599a', POL);
  const opened = v.openSecretsDeep({ a: { id: 'x', password: legacy }, b: { id: 'x', password: legacy } });
  const re = v.sealSecretsDeep(opened, POL);
  assert.notEqual(re.a.password, re.b.password);
});

test('SEC2599-01 — 무변경 저장은 글자 그대로 같고(RECENT2598-01), 로드가 파일 일부를 여는 스토어도 재사용된다', async () => {
  const v = await import('../src/security/secretVault.js');
  // 전체 파일 로드(gpu-guest·storage 모양)
  const file = JSON.parse(JSON.stringify(v.sealSecretsDeep({ vcenters: { 'vc-z': { username: 'u', password: 'keep#2599a', vms: { 'vm-9': { username: 'u', password: 'keep#2599a' } } } } }, POL)));
  const raw = JSON.stringify(file);
  const again = v.sealSecretsDeep(v.openSecretsDeep(JSON.parse(raw)), POL);
  assert.equal(JSON.stringify(again), raw, '설정을 안 바꾼 저장은 봉인 값이 같아야 한다(백업 지문)');
  // 일부 로드(vcenters.json 모양 — 로드는 parsed.vcenters 배열, 저장은 {vcenters: list})
  const list = Array.from({ length: 40 }, (_, i) => ({ id: `vc-${i}`, host: `10.0.0.${i}`, username: 'administrator@vsphere.local', password: `pw-${i}#2599a` }));
  const disk = JSON.stringify(v.sealSecretsDeep({ vcenters: list }, POL));
  const loaded = v.openSecretsDeep(JSON.parse(disk).vcenters);
  loaded[7] = { ...loaded[7], host: '10.9.9.9' };                    // 1대만 수정
  const before = v._vaultStats().scryptCalls;
  const t = process.hrtime.bigint();
  const saved = v.sealSecretsDeep({ vcenters: loaded }, POL);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(v._vaultStats().scryptCalls, before, '재저장이 scrypt 를 돌리면 안 된다(v2.598 L2598-01)');
  const prev = JSON.parse(disk).vcenters;
  const same = saved.vcenters.filter((x, i) => i !== 7 && x.password === prev[i].password).length;
  assert.equal(same, 39, '안 바뀐 39대는 암호문 재사용(경로 문맥 · 래퍼 한 단계 차이 허용)');
  assert.ok(ms < 200, `40대 저장 ${ms.toFixed(1)}ms`);
});

/* ── SEC2599-02 uemcli 줄 끝 공백 제거가 선형이다 ── */
test('SEC2599-02 — 공백만 긴 줄 하나로 파서가 멈추지 않는다', async () => {
  const { parseUemcli } = await import('../src/storage/collectors/uemcliParse.js');
  const line = ' '.repeat(60_000) + 'x';
  const t = process.hrtime.bigint();
  parseUemcli(`1:    ID = pool_1\n${line}\n      Name = p\n`);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 150, `60,000 공백 줄 처리 ${ms.toFixed(0)}ms — replace(/\\s+$/)·/^(.*?)\\s+=/ 는 O(n²)`);
  const { healthOf } = await import('../src/storage/collectors/uemcliParse.js');
  const t2 = process.hrtime.bigint();
  healthOf(`x${' '.repeat(40_000)}y`);
  const ms2 = Number(process.hrtime.bigint() - t2) / 1e6;
  assert.ok(ms2 < 100, `healthOf 공백 4만 ${ms2.toFixed(0)}ms`);
  assert.deepEqual(['OK (5)', ' Degraded  (12) ', 'OK', ''].map(healthOf), ['OK', 'Degraded', 'OK', '']);
  assert.doesNotMatch(read('storage/collectors/uemcliParse.js'), /replace\(\/\\s\+\$\//);
});

/* ── SEC2599-03 게스트 스크립트 중간 실패에도 올린 파일을 지운다 ── */
async function fakeGuest({ startFault }) {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const calls = [];
  const c = {
    sc: { guestOperationsManager: 'gom' }, url: `https://127.0.0.1:${port}/sdk`, vc: { host: '127.0.0.1' },
    retrieveObjectProps: async () => [{ props: { processManager: 'pm', fileManager: 'fm', authManager: 'am' } }],
    callRaw: async (xml) => {
      const op = /^<(\w+)/.exec(xml)[1]; calls.push({ op, xml });
      if (op === 'InitiateFileTransferToGuest') return `<returnval>http://127.0.0.1:${port}/guestFile?id=${calls.length}</returnval>`;
      if (op === 'StartProgramInGuest') throw startFault();
      return '<ok/>';
    },
  };
  return { c, calls, close: () => srv.close() };
}

test('SEC2599-03 — StartProgramInGuest 가 실패해도 비밀번호 파일·스크립트를 지운다', async () => {
  const { addGuestUser } = await import('../src/gpu/guestops.js');
  const g = await fakeGuest({ startFault: () => new Error('GuestOperationsUnavailable') });
  try {
    await assert.rejects(addGuestUser(g.c, 'vm-1', { username: 'root', password: 'x' }, { username: 'svcuser', password: 'Pa$$w0rd!', isWindows: false }));
    const uploaded = g.calls.filter((x) => x.op === 'InitiateFileTransferToGuest').map((x) => /<guestFilePath>([^<]*)</.exec(x.xml)?.[1]);
    const deleted = g.calls.filter((x) => x.op === 'DeleteFileInGuest').map((x) => /<filePath>([^<]*)</.exec(x.xml)?.[1]);
    assert.ok(uploaded.length >= 2, `업로드 ${uploaded.length}`);
    for (const p of uploaded) assert.ok(deleted.includes(p), `올린 파일(${p})이 게스트에 남는다`);
  } finally { g.close(); }
});

test('SEC2599-03 — 게스트 계정 거부로 실패했으면 삭제로 로그온을 더 쌓지 않는다(계정 잠금 방지)', async () => {
  const { addGuestUser } = await import('../src/gpu/guestops.js');
  const g = await fakeGuest({ startFault: () => { const e = new Error('InvalidGuestLogin'); e.guestAuth = true; e.authFailed = true; return e; } });
  try {
    await assert.rejects(addGuestUser(g.c, 'vm-1', { username: 'root', password: 'x' }, { username: 'svcuser', password: 'Pa$$w0rd!', isWindows: false }));
    assert.equal(g.calls.filter((x) => x.op === 'DeleteFileInGuest').length, 0);
  } finally { g.close(); }
});

/* ── C2599-10 MIG 혼합 호스트의 사용률이 부분 평균임을 싣는다 ── */
test('C2599-10 — MIG 혼합(사용률 N/A 1장)은 utilPartial 로 밝힌다', async () => {
  const { parseNvidiaSmiCsv } = await import('../src/gpu/guestops.js');
  const r = parseNvidiaSmiCsv('90, 50, 1000, 2000, Disabled\n[N/A], [N/A], 500, 2000, Enabled\n');
  assert.equal(r.count, 2);
  assert.equal(r.utilPct, 90);
  assert.equal(r.utilNA, false);
  assert.equal(r.utilPartial, 1, '2장 중 1장 기준 평균이라는 사실');
  const all = parseNvidiaSmiCsv('10, 5, 1, 2, Disabled\n20, 5, 1, 2, Disabled\n');
  assert.equal(all.utilPartial, undefined);
});

/* ── SEC2599-04 로그 가림: Basic·Digest 인증 헤더, URL 사용자정보의 비밀번호 ── */
test('SEC2599-04 — Authorization Basic 과 URL 사용자정보 비밀번호를 가린다(계정 이름은 남긴다)', async () => {
  const { redactLogLine, MASK } = await import('../src/edgelog/redact.js');
  const out = redactLogLine('[ping-agent] started (central=https://proxyuser:S3cret!@central.example:4000, poll=4000ms) Authorization: Basic YWRtaW46eA==');
  assert.ok(!out.includes('S3cret!'), out);
  assert.ok(!out.includes('YWRtaW46eA=='), out);
  assert.ok(out.includes(`https://proxyuser:${MASK}@central.example`), out);
  // 오탐 없음 — 사용자정보가 없는 주소·ssh 표기는 그대로
  const plain = 'ssh root@10.0.0.1 https://h/x@y central=https://c:4000/api';
  assert.equal(redactLogLine(plain), plain);
});

/* ── SEC2599-05 엣지 배포가 토큰을 원격 셸 명령 인자로 보내지 않는다 ── */
test('SEC2599-05 — portal.env 에 토큰을 붙일 때 exec 명령 문자열에 값이 들어가지 않는다', () => {
  const src = read('agent/deploy.js');
  assert.doesNotMatch(src, /exec\(`printf[^`]*\$\{(?:block|tk)\}/, 'printf 인자로 블록·토큰을 보내면 대상 호스트 ps 에 보인다');
  assert.match(src, /appendSecretText\(\{\s*exec,\s*writeFile\s*\},\s*'\/etc\/vmware-portal\/portal\.env',\s*block\)/);
  assert.match(src, /appendSecretText\(\{\s*exec,\s*writeFile\s*\},\s*envFile,/);
});
