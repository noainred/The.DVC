/**
 * test/bareosBugs2846c.test.js — v2.846 Bareos 확정 결함 묶음 C(반증 판정 hunt/R.md) 회귀.
 *  D-3  보관 정리 상한 — 기준 Full 쪽(새 것) 200건 · 새 jobid 부터 delete · 도중에 끊겨도 남는 것은 체인 앞부분(가운데가 비지 않는다)
 *  E-2  접속값 표지(connSig)에 TLS 최대 판·시한 · 인증 정지 신원에 TLS 판(기본값은 예전 그대로)
 *  S-5  자동 설정 검사 출력의 Password 줄 값 가림(FD 플러그인 · Director) · 장비 출력 길이 상한
 *  S-4  엣지 자동 설정 회신의 경로 모양 정규식(setup.director · fdIni · fdPlugin) · E-3 필수 값 없음 사유가 작업마다
 *  D-7  원장을 못 읽으면 매핑 저장 · Director 삭제 503(대상 0 으로 보지 않음)
 *  C-5  목록 GET memoJson — 범위 계정·쓰기 범위·데모 계정이 전체 범위 관리자 캐시를 받지 않는다 · finishedRuns 를 싣지 않는다 · 세대가 바뀌면 새로
 *  D-9  그룹 삭제·VM 빼기 응답의 '스케줄 없는 잡 N개' (웹 판정과 같은 수 · 같은 글자)
 *  U-9  그룹 트리에 Director 상태(통합·법인별 현황과 같은 판정) · U-11 엣지 대행 'sent' 도 회신 대기(서버·웹 같은 판정)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2846c-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }] }));

const S = await import('../src/bareos/settings.js');
const R = await import('../src/bareos/registry.js');
const G = await import('../src/bareos/groups.js');
const A = await import('../src/bareos/autoSetup.js');
const { pruneSelection, PRUNE_MAX_PER_JOB } = await import('../src/bareos/groupRetention.js');
const { chainFromHistory } = await import('../src/bareos/restore.js');
const { OPS } = await import('../src/bareos/ops.js');
const { deleteJobIds, DELETE_IDS_PER_CMD } = await import('../src/bareos/director.js');
const { sanitizeEdgeResult, VALUE, requiredMissingText } = await import('../src/bareos/edgeResult.js');
const V = await import('../src/bareos/vmView.js');
const { bareosAuthGuard } = await import('../src/bareos/service.js');
const W = await import('../../web/src/views/tools/bareosText.js');
const WG = await import('../../web/src/views/tools/bareosGroupText.js');

/* ───────────────────────── D-3 보관 정리 상한 ───────────────────────── */
const NAME = 'pv-vc1-vm-1';
const SINCE = Date.parse('2026-01-01T00:00:00');
const HOUR = 3_600_000;
const row = (jobid, level, t, extra = {}) => ({ jobid, name: NAME, type: 'B', level, status: 'T', state: 'ok', startedAt: t, endedAt: t + 1000, bytes: 100, ...extra });
/** 재현(hunt/D/d3): 예전 등록 시절 F0(since 앞) · F1 + Incremental 250 · F2 + Incremental 6 */
function history() {
  const rows = [];
  let id = 100; let t = SINCE - 30 * 86_400_000;
  rows.push(row(id++, 'F', t));
  t = SINCE + HOUR;
  const F1 = id; rows.push(row(id++, 'F', t));
  for (let i = 0; i < 250; i++) { t += HOUR; rows.push(row(id++, 'I', t)); }
  t += HOUR; const F2 = id; rows.push(row(id++, 'F', t));
  for (let i = 0; i < 6; i++) { t += HOUR; rows.push(row(id++, 'I', t)); }
  return { rows, F1, F2 };
}
/** 남은 행이 '지운 것보다 모두 앞'(가운데가 비지 않음)이고, 남은 성공 복원 지점의 체인이 등록 뒤 Full 에서 시작하는가. */
function assertIntactPrefix(left, deleted, baseJobid, label) {
  const leftBefore = left.filter((r) => r.jobid < baseJobid && r.startedAt >= SINCE).map((r) => r.jobid);
  if (deleted.length && leftBefore.length) assert.ok(Math.max(...leftBefore) < Math.min(...deleted), `${label}: 남은 것은 지운 것보다 모두 앞(체인 가운데가 비지 않는다)`);
  for (const r of left.filter((x) => x.startedAt >= SINCE && x.level === 'I')) {
    const chain = chainFromHistory(left, r.jobid);
    assert.ok(chain, `${label}: 남은 Incremental ${r.jobid} 의 체인이 있다`);
    const full = left.find((x) => x.jobid === chain[0]);
    assert.ok(full.startedAt >= SINCE, `${label}: 남은 Incremental ${r.jobid} 의 체인이 예전 등록 시절 Full(${chain[0]}) 위에 얹히지 않는다`);
  }
}

test('D-3 상한을 넘으면 기준 Full 쪽(새 것) 200건 — 남는 것은 F1 + 앞 Incremental(온전한 체인) · 미리 보기와 같은 수', () => {
  const { rows, F1, F2 } = history();
  const sel = pruneSelection(rows, 5, NAME, { since: SINCE });
  assert.equal(sel.baseJobid, F2);
  assert.equal(sel.deletable.length, PRUNE_MAX_PER_JOB);
  assert.equal(sel.more, 51, 'F1 + Incremental 250 = 251건 중 200건 · 51건은 다음 정리');
  assert.ok(!sel.deletable.includes(F1), '기준 Full 쪽부터 고르므로 F1 은 이번에 지우지 않는다(예전: F1 만 지우고 그 Incremental 이 남았다)');
  assert.ok(sel.deletable.includes(F2 - 1), 'F2 바로 앞 Incremental 부터');
  assert.ok(!sel.deletable.includes(100), 'since 앞 F0 는 그대로(⑨)');
  const left = rows.filter((r) => !sel.deletable.includes(r.jobid));
  assertIntactPrefix(left, sel.deletable, sel.baseJobid, '한 번 정리 뒤');
  // 다음 정리: 남은 51건을 마저(새 것부터) — 영원히 0건이 되지 않는다
  const sel2 = pruneSelection(left, 5, NAME, { since: SINCE });
  assert.equal(sel2.deletable.length, 51);
  assert.equal(sel2.more, undefined);
});

/** delete 명령을 받는 가짜 세션 — failOnCall 번째 delete 에서 끊긴다(그 명령은 반영하지 않는다). */
function fakeSession(rows, { failOnCall = 0 } = {}) {
  const live = new Map(rows.map((r) => [r.jobid, r]));
  const st = { cmds: [], deletes: 0 };
  return {
    st, live,
    async call(cmd) {
      st.cmds.push(cmd);
      if (cmd.startsWith('list jobs job=')) return { jobs: [...live.values()].map((r) => ({ jobid: r.jobid, job: `${r.name}.x`, name: r.name, type: r.type, level: r.level, jobstatus: r.status, starttime: new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' '), endtime: new Date(r.endedAt).toISOString().slice(0, 19).replace('T', ' '), jobbytes: r.bytes, jobfiles: 1, joberrors: 0 })) };
      const m = /^delete jobid=([\d,]+)$/.exec(cmd);
      if (m) {
        st.deletes += 1;
        if (failOnCall && st.deletes === failOnCall) throw Object.assign(new Error('closed'), { code: 'closed' });
        for (const id of m[1].split(',').map(Number)) live.delete(id);
        return {};
      }
      throw new Error(`unknown ${cmd}`);
    },
  };
}

test('D-3 delete 는 새 jobid → 옛 jobid(묶음 사이·명령 안) · 둘째 묶음에서 끊겨도 남는 것은 체인 앞부분', async () => {
  const s0 = fakeSession([]);
  await deleteJobIds(s0, [3, 1, 2, 120, 51]);
  assert.deepEqual(s0.st.cmds, ['delete jobid=120,51,3,2,1']);
  assert.equal(DELETE_IDS_PER_CMD, 50);
  // 정리 도중 끊김(둘째 delete) — ops.pruneJobs 는 시간대를 현지 시각으로 읽으므로 그대로 같은 판정(시각 순서만 본다)
  const { rows } = history();
  const s = fakeSession(rows, { failOnCall: 2 });
  const out = await OPS.pruneJobs(s, { items: [{ key: 0, job: NAME, keep: 5 }] });
  assert.equal(out[0].ok, false, '끊기면 실패(보낸 것은 sent 로)');
  assert.equal(out[0].sent.length, PRUNE_MAX_PER_JOB);
  const dels = s.st.cmds.filter((c) => c.startsWith('delete'));
  const first = dels[0].slice('delete jobid='.length).split(',').map(Number);
  assert.equal(first.length, DELETE_IDS_PER_CMD);
  assert.ok(first.every((id, i) => i === 0 || id < first[i - 1]), '한 명령 안의 목록도 내림차순');
  const left = [...s.live.values()];
  const deleted = rows.map((r) => r.jobid).filter((id) => !s.live.has(id));
  assert.equal(deleted.length, DELETE_IDS_PER_CMD, '첫 묶음만 지워졌다');
  const base = rows.find((r) => r.level === 'F' && r.jobid > 200).jobid;
  assertIntactPrefix(left, deleted, base, '둘째 묶음에서 끊긴 뒤');
});

/* ───────────────────────── E-2 접속값 표지 · 인증 정지 신원 ───────────────────────── */
test('E-2 connSig 는 TLS 최대 판·시한이 바뀌면 달라진다 · 인증 정지 신원은 TLS 판만(기본값은 예전 그대로)', () => {
  const base = { id: 'dir_x', host: '10.1.1.1', port: 9101, consoleName: 'portal', password: 'pw-123456', tlsMax: 'TLSv1.3', timeoutMs: 15000 };
  assert.notEqual(S.directorConnSig(base), S.directorConnSig({ ...base, tlsMax: 'TLSv1.2' }), 'TLS 최대 판');
  assert.notEqual(S.directorConnSig(base), S.directorConnSig({ ...base, timeoutMs: 120000 }), '시한');
  assert.equal(S.directorConnSig(base), S.directorConnSig({ ...base }), '같은 값이면 같은 표지');
  assert.equal(S.directorCred(base).username, '10.1.1.1:9101/portal', '기본값(TLSv1.3)은 예전 신원 그대로 — 올리기 전 정지 기록이 업그레이드로 풀리지 않는다');
  const c13 = S.directorCred(base); const c12 = S.directorCred({ ...base, tlsMax: 'TLSv1.2' });
  assert.equal(c13.id, c12.id, '정지 키(id)는 그대로');
  assert.notEqual(c13.username, c12.username);
  assert.equal(S.directorCred({ ...base, timeoutMs: 60000 }).username, c13.username, '시한은 인증 정지와 무관');
  bareosAuthGuard.markAuthStopped(c13.id, c13, 'tls 협상 실패');
  assert.ok(bareosAuthGuard.peekAuthStop(c13), 'TLSv1.3 으로 멈췄다');
  assert.equal(bareosAuthGuard.peekAuthStop(c12), null, 'TLS 판을 바꾸면 그 정지는 새 값에 걸리지 않는다(한 번 다시 시도)');
  bareosAuthGuard.clearAuthStop(c13.id);
});

/* ───────────────────────── S-5 · S-4 · E-3 ───────────────────────── */
const MYSELF = 'Client {\n  Name = bareos-fd\n  Maximum Concurrent Jobs = 20\n}\n';
/** 가짜 FD 서버(bareosCorp2823 ④ 와 같은 명령 모양) — testOut 으로 bareos-fd -t 출력을 정한다. */
function fakeFd({ testCode = 0, testOut = '' } = {}) {
  const F = new Map([['/etc/bareos/bareos-fd.d/client/myself.conf', MYSELF]]);
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd) => {
    let m;
    if (cmd === 'id -u') return ok('0\n');
    if (cmd.startsWith('command -v bareos-fd')) return ok('F\nP:/usr/lib64/bareos/plugins\nY\n');
    if (/^if ! \[ "\$\(readlink -f -- \S+\)" = "\S+" \]; then echo LINK; elif \[ -L (\S+) \]/.test(cmd)) return ok(`FILE\nroot bareos 640\n${F.get('/etc/bareos/bareos-fd.d/client/myself.conf')}`);
    if ((m = /^\[ "\$\(readlink -f -- \S+\)" = "\S+" \] && \[ ! -L (\S+) \] && \[ ! -e (\S+) \] && cp -p (\S+) (\S+)$/.exec(cmd))) { if (F.has(m[2])) return { code: 1, stdout: '', stderr: '' }; F.set(m[4], F.get(m[3])); return ok(); }
    if ((m = /^\[ "\$\(readlink -f -- \S+\)" = "\S+" \] && \[ ! -L (\S+) \] && cp -p (\S+) (\S+) && systemctl restart bareos-fd$/.exec(cmd))) { F.set(m[3], F.get(m[2])); return ok(); }
    if ((m = /^mktemp -d \/tmp\/([a-z-]+)\.X{10}$/.exec(cmd))) return ok(`/tmp/${m[1]}.Ab3dEf7hIj\n`);
    if (/^test -d \S+ && test ! -L \S+ && test -O \S+ && echo ok$/.test(cmd)) return ok('ok\n');
    if ((m = /^\[ "\$\(readlink -f -- \S+\)" = "\S+" \] && install -o root -g bareos -m 640 (\S+) (\S+) && rm -f \S+$/.exec(cmd))) { F.set(m[2], F.get(m[1])); F.delete(m[1]); return ok(); }
    if (cmd === 'bareos-fd -t 2>&1') return { code: testCode, stdout: testOut, stderr: '' };
    if (cmd.startsWith('systemctl restart bareos-fd 2>&1')) return ok('active\n');
    if (/^rm -rf \/tmp\/portal-bareos\.\w+$/.test(cmd)) return ok();
    return { code: 127, stdout: '', stderr: `unknown: ${cmd}` };
  };
  const api = { exec, writeFile: async (p, c) => { F.set(p, String(c)); } };
  return { F, ssh: async (_c, fn) => fn(api) };
}
const FD_BODY = { host: '10.20.30.40', password: 'ssh-Secret-1' };
const FD_CTX = { dir: { id: 'dir_t', name: 't' } };

test('S-5 FD 플러그인 bareos-fd -t 실패 출력의 Password 줄 값을 가린다(Director 경로는 bareosAutoSetup ②) · 출력 길이 상한', async () => {
  const f = fakeFd({ testCode: 1, testOut: 'Config error: line 6\n  Director {\n    Password = "dir-Secret-9"\n  Password=plainSecret77 }' });
  A._setDepsForTest({ ssh: f.ssh });
  await assert.rejects(A.setupFdPlugin(FD_BODY, FD_CTX), (e) => {
    assert.equal(e.code, 'config-test');
    assert.ok(!e.message.includes('dir-Secret-9') && !e.message.includes('plainSecret77'), `Password 값이 응답에 없다: ${e.message}`);
    assert.match(e.message, /Password = \(가림\)/);
    return true;
  });
  A._setDepsForTest();
  // install/causes.scrubOutput 과 같은 규칙(같은 입력 → 같은 가림)
  const { scrubOutput } = await import('../src/bareos/install/causes.js');
  const sample = 'a\n  Password = "x y z"\n  password=abc def\nPassword  =  "q"';
  assert.equal(A.maskConfigPasswords(sample), scrubOutput(sample));
  // 장비 출력 길이 상한(정규식 규약) — 닫는 따옴표 없는 'password="' 반복 4MB 도 금방 끝난다(앞을 잘라 뒤쪽만 본다)
  const evil = 'password="'.repeat(400_000);
  const t0 = Date.now();
  const out = A.maskConfigPasswords(evil);
  assert.ok(Date.now() - t0 < 1500, `상한 없이 훑지 않는다(${Date.now() - t0}ms)`);
  assert.ok(out.length <= A.MASK_SCAN_MAX + 64 * 8, '뒤쪽만 남긴다');
});

test('S-4 엣지 자동 설정 회신 — 그 작업이 만드는 경로 모양만 받는다(감사 detail 위조 차단) · 실제 setupFdPlugin 값은 통과', async () => {
  const forged = '(위조) 실제로는 아무 파일도 바꾸지 않음 — 승인자 kim';
  const d = sanitizeEdgeResult('setup.director', { ok: true, value: { files: [{ path: forged, action: 'created' }, { path: `${A.DIR_CONF_ROOT}/console/portal.conf`, action: 'updated' }, { path: `${A.DIR_CONF_ROOT}/../x.conf`, action: 'created' }, { path: `${A.DIR_CONF_ROOT}/job/RestoreVMware.conf`, action: '위조' }] } });
  assert.equal(d.ok, true);
  assert.deepEqual(d.value.files, [{ path: '/etc/bareos/bareos-dir.d/console/portal.conf', action: 'updated' }, { path: '/etc/bareos/bareos-dir.d/job/RestoreVMware.conf', action: 'unknown' }]);
  const ini = sanitizeEdgeResult('setup.fdIni', { ok: true, value: { path: '/etc/shadow 로 위조한 경로', action: 'created', plugin: 'installed' } });
  assert.equal(ini.value.path, '');
  assert.equal(sanitizeEdgeResult('setup.fdIni', { ok: true, value: { path: '/etc/bareos/../shadow', action: 'created' } }).value.path, '');
  assert.equal(sanitizeEdgeResult('setup.fdIni', { ok: true, value: { path: '/etc/bareos/vmware/vc-a.ini', action: 'updated' } }).value.path, '/etc/bareos/vmware/vc-a.ini');
  assert.equal(sanitizeEdgeResult('setup.fdIni', { ok: true, value: { path: '/etc/bareos/vmware/vc-a.ini', action: forged } }).value.action, 'unknown');
  const fp = sanitizeEdgeResult('setup.fdPlugin', { ok: true, value: { action: 'updated', pluginDir: '/tmp/x', backup: forged, added: [forged, 'Plugin Names = "python3"'] } });
  assert.deepEqual([fp.value.pluginDir, fp.value.backup, fp.value.added], ['', '', ['Plugin Names = "python3"']]);
  // 실제 autoSetup 이 만드는 값은 그대로 통과(정규식이 실제 모양과 어긋나지 않는다)
  const f = fakeFd();
  A._setDepsForTest({ ssh: f.ssh });
  const real = await A.setupFdPlugin(FD_BODY, FD_CTX);
  A._setDepsForTest();
  assert.equal(real.action, 'updated');
  const v = VALUE['setup.fdPlugin'](real);
  assert.deepEqual([v.pluginDir, v.backup, v.added], [real.pluginDir, real.backup, real.added]);
  for (const r of A.directorResources({ defaults: S.loadSettings().defaults, consoleName: 'portal', consolePassword: 'x'.repeat(32), restoreClient: 'bareos-fd', restoreStorage: 'File', restorePool: 'Full', pools: true, schedule: true })) {
    const p = `${A.DIR_CONF_ROOT}/${r.type}/${r.name}.conf`;
    assert.equal(VALUE['setup.director']({ files: [{ path: p, action: 'created' }] }).files.length, 1, `Director 리소스 파일 경로 ${p}`);
  }
});

test('E-3 필수 값 없음 사유가 작업마다 — setup.manage 는 jobid·Director 가 아니라 그 서버의 /etc/bareos 파일', () => {
  const m = sanitizeEdgeResult('setup.manage', { ok: true, value: { files: [] } });
  assert.equal(m.code, 'unknown');
  assert.match(m.reason, /\/etc\/bareos/);
  assert.doesNotMatch(m.reason, /jobid|Director 에서 확인/);
  assert.match(sanitizeEdgeResult('runJob', { ok: true, value: null }).reason, /jobid/);
  assert.match(sanitizeEdgeResult('restore', { ok: true, value: {} }).reason, /복원 jobid/);
  assert.equal(requiredMissingText('setup.manage'), m.reason);
});

/* ───────────────────────── U-11 엣지 대행 'sent' ───────────────────────── */
test('U-11 회신 대기 판정 하나 — sent·pending(지난 결과 없음) = relay · 서버·웹 같은 입력 같은 답', () => {
  const st = (poll) => V.directorState({ mapped: true, configured: true, authStopped: false, poll });
  assert.equal(st({ ok: null, relay: 'sent' }).state, 'relay', "보낸 틱('sent')도 회신 대기(예전: '조회 전')");
  assert.equal(st({ ok: null, relay: 'pending' }).state, 'relay');
  assert.equal(st({ ok: true, relay: 'sent' }).state, 'ok', '지난 결과가 있으면 그 결과');
  for (const poll of [null, undefined, {}, { ok: null }, { ok: null, relay: 'sent' }, { ok: null, relay: 'pending' }, { ok: null, relay: 'done' }, { ok: true, relay: 'sent' }, { ok: false, relay: 'pending' }, { relay: 'sent' }]) {
    assert.equal(V.relayWaiting(poll), W.relayWaiting(poll), JSON.stringify(poll));
    if (V.relayWaiting(poll)) assert.equal(W.directorStatus({ configured: true, poll }).label, '엣지 대행 중');
  }
});

/* ───────────────────────── 라우트(C-5 · D-9 · U-9 · D-7) ───────────────────────── */
let srv; let base; let store; let DA = ''; let DB = ''; let DC = '';
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-b'] } },
  wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-b'] } },
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },
};
before(async () => {
  DA = S.addDirector({ name: '한국', host: 'kr.corp', consoleName: 'portal', password: 'pw-a' }).director.id;
  DB = S.addDirector({ name: '폴란드', host: 'pl.corp', consoleName: 'portal', password: 'pw-b' }).director.id;
  DC = S.addDirector({ name: '빈 법인', host: 'xx.corp', consoleName: 'portal', password: 'pw-c' }).director.id;
  S.saveSettings({ sites: [
    { vcenterId: 'vc-a', directorId: DA, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'File', pool: 'Full', configFile: '/etc/bareos/vmware/vc-a.ini' },
    { vcenterId: 'vc-b', directorId: DB, vcserver: 'vc-b.corp', client: 'pl-fd', storage: 'File', pool: 'Full', configFile: '/etc/bareos/vmware/vc-b.ini' },
  ] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  const vm = (vc, n, name) => ({ id: `${vc}:vm-${n}`, vcenterId: vc, name, powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC', folderPath: '/f', folder: 'f' });
  store.snapshot = {
    generatedAt: Date.now(), source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul' }, { id: 'vc-b', name: 'Warsaw' }],
    hosts: [], datastores: [], alarms: [], networks: [],
    vms: [vm('vc-a', 1, 'a1'), vm('vc-b', 9, 'b9'), vm('vc-a', 11, 'g11'), vm('vc-a', 12, 'g12'), vm('vc-a', 13, 'g13')],
  };
  const job = (vc, n, name, dir, schedule = '') => R.addJob({ vcenterId: vc, vmId: `${vc}:vm-${n}`, vmName: name, dc: 'DC', folder: '/f', directorId: dir, bareosJob: `pv-${vc}-vm-${n}`, client: 'fd', storage: 'File', pool: 'Full', schedule, createdBy: 't' });
  const ja = job('vc-a', 1, 'a1', DA, 'WeeklyCycle');
  job('vc-b', 9, 'b9', DB, 'WeeklyCycle');
  job('vc-a', 11, 'g11', DA, '');            // 그룹이 등록한 잡(Director 스케줄 없음)
  job('vc-a', 12, 'g12', DA, 'WeeklyCycle'); // Director 스케줄 있음
  job('vc-a', 13, 'g13', DA, '');
  R.applyRunRow(ja.id, { jobid: 5, status: 'T', state: 'ok', level: 'F', startedAt: Date.now() - 7200_000, endedAt: Date.now() - 3600_000, bytes: 10, files: 1, errors: 0 });   // finishedRuns 에 한 줄
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t, etag: r.headers.get('etag') };
}

test('C-5 목록 GET 캐시 — 범위 계정·쓰기 범위 계정·데모 계정이 전체 범위 관리자의 캐시를 받지 않는다 · finishedRuns 없음 · 세대가 바뀌면 새로', async () => {
  const full = await call('admin', 'GET', '');
  assert.equal(full.s, 200, full.t);
  assert.equal(full.j.jobs.length, 5);
  assert.ok(full.j.directors.some((d) => d.host === 'kr.corp'), '전체 범위 관리자 판본은 주소를 본다');
  assert.ok(full.j.jobs.every((j) => j.writable === true));
  assert.ok(full.j.jobs.every((j) => !('finishedRuns' in j)), '화면이 쓰지 않는 끝난 실행 원문은 싣지 않는다');
  assert.ok(Array.isArray(full.j.jobs[0].restores), '복원 이력은 이력 탭이 쓴다 — 남긴다');
  assert.ok(full.etag, 'ETag(memoJson)');
  // 같은 세대 · 같은 URL — 범위 계정
  const sc = await call('sadm', 'GET', '');
  assert.equal(sc.s, 200, sc.t);
  assert.deepEqual(sc.j.jobs.map((j) => j.vcenterId), ['vc-b'], '범위 계정은 자기 vCenter 대상만(관리자 캐시를 받지 않는다)');
  assert.equal(sc.j.scoped, true);
  assert.ok(sc.j.directors.every((d) => !d.host), '주소 가림');
  assert.notEqual(sc.etag, full.etag);
  // 쓰기 범위만 다른 계정
  const wr = await call('wadm', 'GET', '');
  assert.equal(wr.j.jobs.length, 5);
  assert.deepEqual(wr.j.jobs.filter((j) => j.writable).map((j) => j.vcenterId), ['vc-b'], '쓰기 범위 밖 대상은 writable:false(관리자 캐시를 받지 않는다)');
  assert.equal(wr.j.settingsWritable, false);
  // 데모 계정(관리자 판본 아님)
  const dg = await call('demo', 'GET', '');
  assert.ok(dg.j.directors.every((d) => !d.host && d.masked), '데모 계정에는 주소를 가린다(관리자 캐시를 받지 않는다)');
  // 같은 세대 다시 — 304
  const again = await call('admin', 'GET', '', null, { 'if-none-match': full.etag });
  assert.equal(again.s, 304);
  // 원장이 바뀌면(rev) 새로
  R.patchJob(full.j.jobs[0].id, { enabled: false });
  const after1 = await call('admin', 'GET', '', null, { 'if-none-match': full.etag });
  assert.equal(after1.s, 200);
  assert.equal(after1.j.jobs.find((j) => j.id === full.j.jobs[0].id).enabled, false);
  R.patchJob(full.j.jobs[0].id, { enabled: true });
  // 인증 정지(수동 연결 시험이 폴러 없이 바꾼다)도 새로 — 먼저 같은 세대를 캐시에 채운 뒤(원장·설정은 그대로) 정지만 바꾼다
  const before2 = await call('admin', 'GET', '');
  assert.equal(before2.j.directors.find((x) => x.id === DA).authStopped, null);
  const d = S.directorById(DA);
  bareosAuthGuard.markAuthStopped(S.directorCred(d).id, S.directorCred(d), '인증 실패');
  const after2 = await call('admin', 'GET', '');
  assert.ok(after2.j.directors.find((x) => x.id === DA).authStopped, '인증 정지가 바로 보인다');
  bareosAuthGuard.clearAuthStop(S.directorCred(d).id);
});

test('U-9 그룹 트리에 Director 상태 — 인증 정지면 결과 모름(통합·법인별 현황과 같은 판정)', async () => {
  let t = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.equal(t.s, 200, t.t);
  assert.equal(t.j.directorState?.resultsKnown, true);
  assert.equal(t.j.director.resultsKnown, true);
  const d = S.directorById(DA);
  bareosAuthGuard.markAuthStopped(S.directorCred(d).id, S.directorCred(d), '인증 실패');
  t = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  assert.deepEqual(t.j.directorState, { state: 'auth', resultsKnown: false });
  bareosAuthGuard.clearAuthStop(S.directorCred(d).id);
  // 웹 판정: 결과 모름이면 성공·실패를 세지 않는다
  const m = WG.memberResults([{ b: { st: 'ok' } }, { b: { st: 'error' } }], { resultsKnown: t.j.directorState.resultsKnown });
  assert.equal(m.ok, null); assert.equal(m.unknown, 2);
  assert.equal(WG.resultBadge(m).text, '결과 모름 2대');
});

test('D-9 그룹 VM 빼기·그룹 삭제 응답에 스케줄 없는 잡 수 — 웹 판정과 같은 수 · 같은 글자', async () => {
  const g = G.addGroup({ vcenterId: 'vc-a', name: 'g', vmIds: ['vc-a:vm-11', 'vc-a:vm-12', 'vc-a:vm-13'], schedule: { enabled: true, days: [1], time: '02:10', level: 'Incremental' } }, { by: 't', directorId: DA });
  // 웹(편집 창)이 같은 입력으로 세는 수
  const tree = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  const byId = new Map(tree.j.vms.map((v) => [v.id, v]));
  assert.equal(WG.unscheduledAfter(['vc-a:vm-11'], byId, g.id), 1);
  const put = await call('admin', 'PUT', `/groups/${g.id}`, { name: 'g', vmIds: ['vc-a:vm-12', 'vc-a:vm-13'], schedule: g.schedule, updatedAt: g.updatedAt });
  assert.equal(put.s, 200, put.t);
  assert.deepEqual(put.j.unscheduled, { count: 1, names: ['g11'] }, '뺀 VM(g11)은 Director 스케줄이 없어 이후 예약 백업이 없다');
  const tree2 = await call('admin', 'GET', '/groups/tree?vcenterId=vc-a');
  const byId2 = new Map(tree2.j.vms.map((v) => [v.id, v]));
  const webCount = WG.unscheduledAfter(['vc-a:vm-12', 'vc-a:vm-13'], byId2, g.id);
  const del = await call('admin', 'DELETE', `/groups/${g.id}`);
  assert.equal(del.s, 200, del.t);
  assert.equal(del.j.unscheduled.count, 1, 'g12 는 Director 스케줄이 있어 세지 않는다 · g13 만');
  assert.equal(del.j.unscheduled.count, webCount, '확인 창(웹)과 응답(서버)이 같은 수');
  const { unscheduledText } = await import('../src/routes/api/bareosGroups.js');
  for (const n of [0, 1, 3]) assert.equal(unscheduledText(n), WG.unscheduledText(n));
  assert.match(WG.groupDeleteConfirmText({ name: 'g', vmIds: [1, 2] }, 2), /스케줄 없는 잡 2개 — 이후 예약 백업 없음/);
});

test('D-7 원장을 못 읽으면 매핑 저장 · Director 삭제는 503(대상 0 으로 보지 않음) · 공통 기본값만은 저장', async () => {
  const FILE = path.join(tmp, 'bareos-jobs.json');
  const good = fs.readFileSync(FILE, 'utf8');
  fs.writeFileSync(FILE, '{ broken');
  R._resetForTest();
  assert.ok(R.registryLoadError());
  const rev = (await call('admin', 'GET', '/settings')).j.rev;
  const sites = S.loadSettings().sites;
  let r = await call('admin', 'PUT', '/settings', { rev, sites: sites.map((x) => (x.vcenterId === 'vc-a' ? { ...x, directorId: DB } : x)) });
  assert.equal(r.s, 503, r.t);
  assert.equal(r.j.code, 'registry-unreadable');
  assert.equal(S.siteFor('vc-a').directorId, DA, '매핑은 그대로');
  r = await call('admin', 'DELETE', `/settings/directors/${DC}`);
  assert.equal(r.s, 503, r.t);
  assert.ok(S.directorById(DC), '매핑 없는 Director 도 원장을 모르면 지우지 않는다');
  r = await call('admin', 'PUT', '/settings', { rev, defaults: { level: 'Full' } });
  assert.equal(r.s, 200, r.t);
  // 되돌림 — 원장을 다시 읽을 수 있게
  for (const f of fs.readdirSync(tmp)) if (f.startsWith('bareos-jobs.json.corrupt')) fs.rmSync(path.join(tmp, f));
  fs.writeFileSync(FILE, good);
  R._resetForTest();
  assert.equal(R.registryLoadError(), null);
});
