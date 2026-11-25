/**
 * v2.923(리눅스 성능 4단계) — 용도 프로파일: 카탈로그 계약(파일 1개 = 프로파일 1개 · 출처 · 등급 · catalogId) · 감지(유닛 · 프로세스 이름 · 포트 · 계정) ·
 *   수동 태그 우선(fleet-tags purposes — 기존 tags 보존) · 우선순위 병합 · 상태(미수집 · 확인 불가는 정상이 아니다) · ‘프로파일 없음’(Ubuntu · Windows · Hadoop 지어내지 않음) ·
 *   엣지 봉투 감지 목록 축약 = 원목록과 같은 감지 · 함대 매트릭스.
 * 설계 docs/design/linux-bm-perf/PROFILES.md §1~§4 · §7.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2923pf-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC = path.join(import.meta.dirname, '../src');

const P = await import('../src/bmusage/profiles/index.js');
const M = await import('../src/bmusage/profiles/match.js');
const C = await import('../src/bmusage/tuning/catalog.js');
const SRCS = await import('../src/bmusage/tuning/sources.js');
const F = await import('../src/bmusage/parse/linuxFacts.js');
const OPS = await import('../src/bmusage/opsView.js');
const FT = await import('../src/insights/fleetTags.js');

const rockyTu = (o = {}) => ({
  v: 1, os: { id: 'rocky', versionId: '9.4' }, sysctl: { 'tuned.active_profile': 'throughput-performance' },
  units: { list: ['chronyd.service', 'sshd.service'], failed: 0, capped: false }, ports: { list: [22], capped: false }, procs: { list: ['sshd'], capped: false }, accounts: [],
  sections: { sysctl: 'ok', osrel: 'ok', units: 'ok', ports: 'ok', procs: 'ok', acct: 'absent' }, ...o,
});

test('카탈로그 계약 — 파일 1개 = 프로파일 1개(셋) · id 유일 · 종류 · 매칭 함수 · 점검/요구값마다 출처 id 존재 · 등급 · 출처 없으면 ○ · catalogId 는 카탈로그 항목', () => {
  assert.deepEqual(P.PROFILES.map((p) => p.id), ['rocky9-base', 'airflow', 'gpdb']);
  const files = fs.readdirSync(path.join(SRC, 'bmusage/profiles')).filter((f) => f.endsWith('.js') && !['index.js', 'match.js'].includes(f)).map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepEqual(files, ['airflow', 'gpdb', 'rocky9-base'], '프로파일 파일과 등록부가 1:1');
  for (const p of P.PROFILES) {
    assert.ok(['os', 'app'].includes(p.kind), p.id);
    assert.equal(typeof p.match, 'function', `${p.id} match`);
    assert.ok(p.matchText, `${p.id} 매칭 규칙 문구`);
    if (p.kind === 'app') { assert.equal(typeof p.detect, 'function'); for (const a of p.accounts || []) assert.ok(F.DETECT_ACCOUNTS.includes(a), `${p.id} 계정 ${a} 는 수집 명령의 고정 목록에 있어야 한다`); }
    const ids = [...p.checks.map((c) => c.id), ...p.tunings.map((x) => x.key)];
    assert.equal(new Set(ids).size, ids.length, `${p.id} 항목 id 유일`);
    for (const x of [...p.checks, ...p.tunings]) {
      assert.ok(Array.isArray(x.sources), `${p.id}/${x.id || x.key} 출처`);
      for (const s of x.sources) assert.ok(SRCS.sourceOf(s), `${p.id}/${x.id || x.key} 출처 ${s}`);
      assert.ok(String(x.grade).split(/\s*\/\s*/).every((g) => SRCS.GRADES.includes(g)), `${p.id}/${x.id || x.key} 등급`);
      if (!x.sources.length) assert.equal(x.grade, '○', `${p.id}/${x.id || x.key} 출처 없으면 ○`);
      assert.ok(x.evidence && x.title, `${p.id}/${x.id || x.key} 근거 · 이름`);
    }
    for (const x of p.tunings) if (x.catalogId) assert.ok(C.itemOf(x.catalogId), `${p.id}/${x.key} catalogId ${x.catalogId}`);
    for (const s of p.sources) assert.ok(SRCS.sourceOf(s), `${p.id} 출처 ${s}`);
  }
  // 예정 프로파일은 지어내지 않는다 — 감지 규칙 · 점검이 없다
  assert.deepEqual(P.PLANNED_PROFILES.map((p) => p.id), ['ubuntu-base', 'windows-base', 'hadoop']);
  const cat = P.catalogView();
  for (const p of cat.filter((x) => x.status === 'planned')) { assert.equal(p.matchText, undefined); assert.equal(p.checks, undefined); }
  assert.ok(!fs.readdirSync(path.join(SRC, 'bmusage/profiles')).some((f) => /hadoop|ubuntu|windows/i.test(f)), '예정 프로파일 파일이 없다');
});

test('감지 — rocky9-base(os-release) · Airflow 는 유닛/프로세스 이름이 강한 단서(계정 · 포트만으로는 감지 안 함) · GPDB 는 gpadmin + (postgres 또는 5432/6000대) · 역할 추정', () => {
  assert.equal(M.detectProfiles(rockyTu()).os.profile, 'rocky9-base');
  assert.equal(M.detectProfiles(rockyTu({ os: { id: 'rocky', versionId: '8.10' } })).os.profile, null, 'Rocky 8 은 프로파일 없음');
  assert.equal(M.detectProfiles(rockyTu({ os: { id: 'ubuntu', versionId: '22.04' } })).os.profile, null, 'Ubuntu 프로파일은 만들지 않았다');
  assert.equal(M.detectProfiles(null, { detail: { osKind: 'windows' } }).os.label, 'Windows');
  const weak = M.detectProfiles(rockyTu({ accounts: ['airflow'], ports: { list: [22, 8080, 8974], capped: false } }));
  assert.equal(weak.apps.find((a) => a.id === 'airflow').detected, false, '계정 + 포트만으로는 감지하지 않는다');
  const af = M.detectProfiles(rockyTu({ units: { list: ['airflow-scheduler.service'], failed: 0, capped: false } }));
  assert.deepEqual(af.activeApps, ['airflow']);
  const afProc = M.detectProfiles(rockyTu({ procs: { list: ['airflow', 'sshd'], capped: false } }));
  assert.deepEqual(afProc.activeApps, ['airflow']);
  const pgOnly = M.detectProfiles(rockyTu({ procs: { list: ['postgres'], capped: false }, ports: { list: [5432], capped: false } }));
  assert.deepEqual(pgOnly.activeApps, [], 'gpadmin 없는 PostgreSQL 은 GPDB 가 아니다');
  const gp = M.detectProfiles(rockyTu({ accounts: ['gpadmin'], procs: { list: ['postgres'], capped: false }, ports: { list: [5432, 6000, 6001], capped: false } }));
  assert.deepEqual(gp.activeApps, ['gpdb']);
  assert.equal(gp.apps.find((a) => a.id === 'gpdb').gpRole, 'both');
  const both = M.detectProfiles(rockyTu({ accounts: ['gpadmin', 'airflow'], procs: { list: ['postgres', 'airflow'], capped: false } }));
  assert.deepEqual(both.activeApps.sort(), ['airflow', 'gpdb'], '기능 둘이면 둘 다 적용');
});

test('수동 태그가 덮는다 — apps 목록(빈 목록 = 기능 없음 확정) · 알 수 없는 기능 id 는 무시 · role 은 튜닝 역할', () => {
  const tu = rockyTu({ units: { list: ['airflow-scheduler.service'], failed: 0, capped: false } });
  assert.deepEqual(M.detectProfiles(tu, { manual: { apps: [] } }).activeApps, [], '감지돼도 수동 빈 목록이면 기능 없음');
  assert.deepEqual(M.detectProfiles(tu, { manual: { apps: ['gpdb', 'hadoop'] } }).activeApps, ['gpdb'], 'hadoop 은 프로파일이 없어 무시');
  const d = M.detectProfiles(tu, { manual: { role: 'db' } });
  assert.equal(d.role, 'db'); assert.equal(d.roleManual, true); assert.deepEqual(d.activeApps, ['airflow'], 'apps 가 없으면 감지 그대로');
  assert.equal(M.detectProfiles(tu, { manual: { role: 'king' } }).role, 'general');
});

test('상태 — 미수집 · 확인 불가 · 참고는 판정에 넣지 않는다(정상으로 세지 않는다) · 맞는 프로파일 없음 = none · 요구값 advise → 주의', () => {
  const none = M.profileView({ tuning: rockyTu({ os: { id: 'ubuntu', versionId: '22.04' } }) });
  assert.equal(none.status, 'none'); assert.equal(none.profiles.length, 0);
  const af = M.profileView({ tuning: rockyTu({ units: { list: ['airflow-scheduler.service', 'chronyd.service'], failed: 0, capped: false } }) });
  const afp = af.profiles.find((p) => p.id === 'airflow');
  assert.ok(afp.checks.filter((c) => c.status === 'notCollected').length >= 6, 'CLI · HTTP · cfg · 메트릭 점검은 미수집');
  assert.equal(afp.status, 'ok', '판정한 것(서비스 유닛)만으로 — 미수집을 정상으로 세지 않지만 이상으로도 세지 않는다');
  assert.ok(afp.tunings.every((t) => t.status === 'unknown' && t.reason === 'appConfigNotRead'), 'airflow.cfg 는 읽지 않는다 — 확인 불가');
  const empty = M.evalProfile(P.profileById('airflow'), { tu: null });
  assert.equal(empty.status, 'unknown', '판정한 칸이 없으면 unknown(정상이 아니다)');
  const r9 = M.profileView({ tuning: rockyTu({ units: { list: [], failed: 2, capped: false } }) });
  assert.equal(r9.profiles[0].status, 'warn', '실패 유닛 2 · 시각 동기 데몬 없음');
});

test('GPDB 요구값 — G1 sysctl · shm(메모리 절반 ±5%) · dirty(64GB 경계) · min_free 3~5% · read-ahead 16384 섹터 = 8192KB · RemoveIPC 명시 없음 = 확인 불가 · enforcing = 확인 불가(정책 미확인) · 디스크 사용 75% = 이상', () => {
  const memKb = 256 * 1024 * 1024;
  const tu = rockyTu({
    accounts: ['gpadmin'], procs: { list: ['postgres'], capped: false }, memTotalKb: memKb,
    os: { id: 'rocky', versionId: '9.4', pageSize: 4096, selinux: 'enforcing', removeIpc: null },
    sysctl: { 'vm.overcommit_memory': '2', 'vm.overcommit_ratio': '95', 'kernel.shmmax': String(memKb * 1024 / 2), 'kernel.shmall': String(memKb * 1024 / 2 / 4096),
      'vm.dirty_background_bytes': '1610612736', 'vm.dirty_bytes': '4294967296', 'vm.min_free_kbytes': String(Math.round(memKb * 0.03)), 'kernel.sem': '32000\t1048576000 1000 32768' },
    blkq: [{ name: 'sda', scheduler: 'mq-deadline', rotational: true, readAheadKb: 8192 }, { name: 'nvme0n1', scheduler: 'none', rotational: false, readAheadKb: 128 }],
    xfs: [{ mount: '/', opts: ['rw', 'relatime'] }, { mount: '/data', opts: ['rw', 'nodev', 'noatime', 'inode64'] }],
  });
  const v = M.profileView({ tuning: tu, row: { disk_used_pct: 75 }, entry: { codes: { net: { E: 'ok' }, hw: { E: 'nopath' } } } });
  const gp = v.profiles.find((p) => p.id === 'gpdb');
  const T = (k) => gp.tunings.find((x) => x.key === k);
  const K = (k) => gp.checks.find((x) => x.id === k);
  assert.equal(T('gp.overcommit').status, 'ok');
  assert.equal(T('gp.shm').status, 'ok');
  assert.equal(T('gp.dirty').status, 'ok', '64GB 초과 → bytes');
  assert.equal(T('gp.minFree').status, 'ok', '3%');
  assert.equal(T('gp.sem').status, 'ok', '공백 · 탭 정규화');
  const ra = T('gp.readAhead');
  assert.deepEqual(ra.devices.map((d) => [d.name, d.status]), [['sda', 'ok'], ['nvme0n1', 'advise']]);
  assert.equal(T('gp.removeIpc').reason, 'notExplicit');
  assert.equal(T('gp.selinux').reason, 'policyNotRead');
  assert.deepEqual(T('gp.xfs').devices.map((d) => [d.name, d.status]), [['/', 'info'], ['/data', 'ok']], '시스템 마운트는 판정에서 뺀다');
  assert.equal(K('gp.diskSpace').status, 'bad', '75% = 임계');
  assert.equal(K('gp.nicRaid').status, 'ok', 'USE code 그대로(하드웨어 경로 없음은 빼고)');
  assert.equal(K('gp.downSeg').status, 'notCollected');
  const small = M.profileView({ tuning: { ...tu, memTotalKb: 32 * 1024 * 1024, sysctl: { ...tu.sysctl, 'vm.dirty_background_ratio': '3', 'vm.dirty_ratio': '10' } } });
  assert.equal(small.profiles.find((p) => p.id === 'gpdb').tunings.find((x) => x.key === 'gp.dirty').status, 'ok', '64GB 이하 → ratio 3/10');
});

test('엣지 봉투 축약 — 관찰 대상만 남겨도 프로파일 감지 · 카탈로그 사실(numad · firewalld · 시각 동기)이 원목록과 같다', () => {
  const units = ['airflow-scheduler.service', 'airflow-worker@1.service', 'numad.service', 'firewalld.service', 'chronyd.service', ...Array.from({ length: 200 }, (_, i) => `svc${i}.service`)];
  const procs = ['airflow', 'postgres', ...Array.from({ length: 400 }, (_, i) => `proc${i}`)];
  const ports = [22, 5432, 6000, 6999, 7000, 8080, 8793, 8974, 9100, ...Array.from({ length: 100 }, (_, i) => 20000 + i)];
  for (const accounts of [[], ['gpadmin'], ['airflow'], ['gpadmin', 'airflow']]) {
    const tu = rockyTu({ units: { list: units, failed: 0, capped: false }, procs: { list: procs, capped: false }, ports: { list: ports, capped: false }, accounts });
    const c = P.compactTuningForEnvelope(tu);
    assert.ok(c.units.list.length < 10 && c.procs.list.length === 2 && c.ports.list.length < 10, '줄었다');
    const a = M.profileView({ tuning: tu }); const b = M.profileView({ tuning: c });
    assert.deepEqual(b.detection.activeApps, a.detection.activeApps);
    assert.deepEqual(b.profiles.map((p) => [p.id, p.status, p.checks.map((x) => x.status), p.tunings.map((x) => x.status)]), a.profiles.map((p) => [p.id, p.status, p.checks.map((x) => x.status), p.tunings.map((x) => x.status)]));
    const ja = OPS.tuningViewFor({ tuning: tu }); const jb = OPS.tuningViewFor({ tuning: c });
    assert.deepEqual(jb.items.map((x) => [x.id, x.status, x.current]), ja.items.map((x) => [x.id, x.status, x.current]));
  }
});

test('fleet-tags purposes — 기존 tags 를 지우지 않는다 · tags 저장이 purposes 를 지우지 않는다 · 알 수 없는 기능 · 역할 거부 · 해제', () => {
  FT.resetFleetTags();
  assert.equal(FT.setFleetTag('TAGA', 'baremetal').ok, true);
  const r = FT.setFleetPurpose('TAGA', { apps: ['gpdb'], role: 'db' }, { by: 'adm', knownApps: [...P.APP_IDS], knownRoles: [...C.ROLES] });
  assert.equal(r.ok, true);
  assert.equal(FT.loadFleetTags().taga, 'baremetal');
  assert.equal(FT.setFleetTag('TAGB', 'exclude').ok, true);
  assert.deepEqual(FT.fleetPurposeOf('taga').apps, ['gpdb']);
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'fleet-tags.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['purposes', 'tags']);
  assert.equal(FT.setFleetPurpose('TAGA', { apps: ['hadoop'] }, { knownApps: [...P.APP_IDS], knownRoles: [...C.ROLES] }).ok, false, '프로파일 없는 기능은 태그하지 않는다');
  assert.equal(FT.setFleetPurpose('TAGA', { role: 'boss' }, { knownApps: [...P.APP_IDS], knownRoles: [...C.ROLES] }).ok, false);
  assert.equal(FT.setFleetPurpose('__proto__', { role: 'db' }, { knownApps: [...P.APP_IDS], knownRoles: [...C.ROLES] }).ok, false);
  assert.equal(FT.setFleetPurpose('TAGA', null).ok, true);
  assert.equal(FT.fleetPurposeOf('TAGA'), null);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, 'fleet-tags.json'), 'utf8'))), ['tags'], '비면 예전 모양');
  FT.resetFleetTags();
});

test('함대 매트릭스 — OS × 기능 칸의 서버 수 · 상태 수 · 프로파일 없음 행 · 튜닝 항목별 상태 수 · 사실 없는 서버 수', () => {
  const items = [
    { key: 'A', name: 'a', vcenterId: 'vc', tuning: rockyTu({ units: { list: ['airflow-scheduler.service', 'chronyd.service'], failed: 0, capped: false } }) },
    { key: 'B', name: 'b', vcenterId: 'vc', tuning: rockyTu({ accounts: ['gpadmin'], procs: { list: ['postgres'], capped: false } }) },
    { key: 'C', name: 'c', vcenterId: 'vc', tuning: rockyTu({ os: { id: 'ubuntu', versionId: '22.04' } }) },
    { key: 'D', name: 'd', vcenterId: 'vc', tuning: null },
  ];
  const v = OPS.fleetProfileView(items);
  assert.deepEqual(v.columns, ['airflow', 'gpdb', 'none']);
  const rocky = v.rows.find((r) => r.label === 'Rocky 9.4');
  assert.equal(rocky.osProfile, 'rocky9-base');
  assert.equal(rocky.byApp.airflow.servers, 1); assert.equal(rocky.byApp.gpdb.servers, 1);
  const ub = v.rows.find((r) => r.label === 'Ubuntu 22.04');
  assert.equal(ub.osProfile, null); assert.equal(ub.byApp.none.status.none, 1, 'Ubuntu = 프로파일 없음');
  assert.equal(v.noFacts, 1);
  assert.equal(v.rows.find((r) => r.label === '미확인').byApp.none.servers, 1);
  assert.equal(v.tuningItems.length, 26);
  const sw = v.tuningItems.find((x) => x.id === 'mem.swappiness').counts;
  assert.equal(sw.advise + sw.ok + sw.info + sw.unknown, 4);
});
