/**
 * v2.923(리눅스 성능 4단계) — 튜닝 탭: 카탈로그 계약(항목 26 · 근거 문서 11 · 등급 · 출처) · 판정 경계(‘확인 불가’ ≠ ‘불일치’) ·
 *   관리자 덮어쓰기(법인 > 전체 · 손상 → 503 · 저장 거부) · 기능 프로파일 우선 · 쓰기 경로 없음(소스 스윕).
 * 설계 docs/design/linux-bm-perf/TUNING-SOURCES.md · README §4.3.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2923tu-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC = path.join(import.meta.dirname, '../src');

const C = await import('../src/bmusage/tuning/catalog.js');
const SRCS = await import('../src/bmusage/tuning/sources.js');
const J = await import('../src/bmusage/tuning/judge.js');
const OV = await import('../src/bmusage/tuning/overrides.js');
const M = await import('../src/bmusage/profiles/match.js');

/* ── 카탈로그 계약 ───────────────────────────────────────────── */
test('카탈로그 — 항목 26 · id 유일 · 분류 ①~⑤ · 출처 id 존재 · 등급 ●◐○ · 출처 없는 항목은 ○ · 근거 인용 있음', () => {
  assert.equal(C.TUNING_ITEMS.length, 26, 'TUNING-SOURCES 항목표 26행');
  const ids = C.TUNING_ITEMS.map((x) => x.id);
  assert.equal(new Set(ids).size, 26, '항목 id 유일');
  const catCount = {};
  for (const x of C.TUNING_ITEMS) {
    assert.ok([1, 2, 3, 4, 5].includes(x.cat), `${x.id} 분류`);
    catCount[x.cat] = (catCount[x.cat] || 0) + 1;
    assert.ok(typeof x.title === 'string' && x.title.length > 2, `${x.id} 이름`);
    assert.ok(typeof x.reads === 'string' && x.reads.length > 2, `${x.id} 읽는 곳`);
    assert.ok(typeof x.evidence === 'string' && x.evidence.length > 10, `${x.id} 근거 요지`);
    assert.ok(Array.isArray(x.sources), `${x.id} 출처 배열`);
    for (const s of x.sources) assert.ok(SRCS.sourceOf(s), `${x.id} 출처 ${s} 가 근거 문서 목록에 있다`);
    const toks = String(x.grade).split(/\s*(?:\/|→ 확인 불가)\s*/).filter(Boolean);
    assert.ok(toks.length && toks.every((g) => SRCS.GRADES.includes(g)), `${x.id} 등급 ‘${x.grade}’`);
    if (!x.sources.length) assert.equal(x.grade, '○', `${x.id}: 출처가 없으면 ○(공식 문서 없음)`);
    assert.ok(x.rec && (x.rec.all || x.rec.db), `${x.id} 권장 규칙`);
    for (const rule of Object.values(x.rec)) assert.ok(['oneOf', 'eqNum', 'maxPctMem', 'info', 'hold', 'custom'].includes(rule.kind), `${x.id} 규칙 종류 ${rule.kind}`);
    for (const r of Object.keys(x.rec)) assert.ok(r === 'all' || C.ROLES.includes(r), `${x.id} 역할 키 ${r}`);
  }
  assert.deepEqual(catCount, { 1: 3, 2: 7, 3: 6, 4: 3, 5: 7 }, '분류별 항목 수(TUNING-SOURCES 표)');
  assert.equal(C.CATEGORIES.length, 5);
});

test('근거 문서 — 튜닝 11(R1 · R2 · H1~H9) · 용도 11(A1~A6 · G1~G4 · R3) · id 유일 · https · 등급(Red Hat 은 ◐ — 원문 미열람 정직 기록)', () => {
  assert.equal(SRCS.TUNING_SOURCES.length, 11);
  assert.equal(SRCS.PROFILE_SOURCES.length, 11);
  const ids = SRCS.ALL_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(SRCS.TUNING_SOURCES.map((s) => s.id), ['R1', 'R2', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9']);
  for (const s of SRCS.ALL_SOURCES) {
    assert.ok(/^https:\/\//.test(s.url), `${s.id} URL`);
    assert.ok(SRCS.GRADES.includes(s.grade), `${s.id} 등급`);
    assert.ok(s.how && s.title, `${s.id} 확인 방법 · 제목`);
  }
  for (const s of SRCS.TUNING_SOURCES.filter((x) => x.id.startsWith('H'))) assert.equal(s.grade, '◐', `${s.id} 은 검색 발췌(◐)`);
  for (const s of SRCS.TUNING_SOURCES.filter((x) => x.id.startsWith('R'))) assert.equal(s.grade, '●');
});

test('DB 를 전제로 한 권장(TuneD · governor · swappiness 10 · THP madvise · HugeTLB)은 다른 역할에 지어내지 않는다 — 권장 없음(참고)', () => {
  for (const id of ['tuned.active', 'cpu.governor', 'mem.swappiness', 'mem.thp', 'mem.hugetlb']) {
    const it = C.itemOf(id);
    assert.ok(it.rec.db, `${id} DB 권장 있음`);
    assert.equal(it.rec.all, undefined, `${id} 는 all 규칙이 없다`);
    for (const r of ['web', 'cache', 'file', 'general']) assert.equal(C.roleRule(it, r), null, `${id} · ${r} 는 권장 없음`);
  }
  const j = J.judgeTuning({ tuning: { sysctl: { 'vm.swappiness': '60' }, sections: { sysctl: 'ok' } }, role: 'web' });
  const sw = j.items.find((x) => x.id === 'mem.swappiness');
  assert.equal(sw.status, 'info'); assert.equal(sw.reason, 'noRec'); assert.equal(sw.by, 'none');
});

/* ── 판정 경계 ───────────────────────────────────────────────── */
const TU = (o = {}) => ({ v: 1, at: 1, sysctl: {}, sections: { sysctl: 'ok', blkq: 'ok', irq: 'ok', netq: 'ok', softnet: 'ok', units: 'ok', kargs: 'ok', hugepages: 'ok' }, ...o });
const item = (j, id) => j.items.find((x) => x.id === id);

test('확인 불가 ≠ 불일치 — 사실이 없으면(null) 전 항목 advise 0 · 구획은 읽었는데 값 없음은 notPresent · 구획 못 읽음은 notRead', () => {
  const none = J.judgeTuning({ tuning: null, role: 'db' });
  assert.equal(none.counts.advise, 0, '못 읽은 서버를 권고로 세지 않는다');
  assert.ok(none.items.filter((x) => x.status === 'unknown').length >= 15);
  const j = J.judgeTuning({ tuning: TU({ sysctl: { 'vm.swappiness': '60' } }), role: 'db' });
  assert.equal(item(j, 'tuned.active').status, 'unknown');
  assert.equal(item(j, 'tuned.active').reason, 'notPresent', '구획 ok · 파일 없음');
  const j2 = J.judgeTuning({ tuning: TU({ sections: { sysctl: 'missing' } }), role: 'db' });
  assert.equal(item(j2, 'tuned.active').reason, 'notRead');
  assert.equal(item(j, 'mem.swappiness').status, 'advise', 'DB 권장 10 · 현재 60');
  assert.equal(item(j, 'mem.swappiness').current, '60');
});

test('경계: eqNum · oneOf · maxPctMem(2% 정확히 = 적합) · 메모리 모름 → memNotRead · hold → unknown(hold) · info → info', () => {
  const mem = 1_000_000;
  const at = (v) => item(J.judgeTuning({ tuning: TU({ memTotalKb: mem, sysctl: { 'vm.min_free_kbytes': String(v) } }), role: 'general' }), 'mem.minFree');
  assert.equal(at(20_000).status, 'ok', '정확히 2%');
  assert.equal(at(20_001).status, 'advise', '2% 초과');
  assert.equal(at(1).status, 'ok', '하한 문장은 수치가 없다 — 지어내지 않는다');
  assert.equal(item(J.judgeTuning({ tuning: TU({ sysctl: { 'vm.min_free_kbytes': '1' } }), role: 'general' }), 'mem.minFree').reason, 'memNotRead');
  const j = J.judgeTuning({ tuning: TU({ sysctl: { 'vm.swappiness': '10', 'thp.enabled': 'never', 'kernel.numa_balancing': '1', 'net.core.somaxconn': '4096' } }), role: 'db' });
  assert.equal(item(j, 'mem.swappiness').status, 'ok');
  assert.equal(item(j, 'mem.thp').status, 'advise', 'DB madvise · 현재 never');
  assert.equal(item(j, 'cpu.numaBalancing').status, 'unknown'); assert.equal(item(j, 'cpu.numaBalancing').reason, 'hold');
  assert.equal(item(j, 'net.somaxconn').status, 'info');
  assert.equal(item(j, 'net.rmemMax').reason, 'noRtt');
  assert.equal(item(j, 'mem.khugepaged').reason, 'snapshotOnly');
});

test('장치 · NIC 항목 — 장치마다 판정 · 가장 나쁜 것(권고 > 확인 불가 > 적합) · 해당 장치 없음은 참고(noDevice) · txqueuelen 20000 초과만 권고 · 채널 > 코어 권고', () => {
  const blkq = [
    { name: 'nvme0n1', scheduler: 'none', rotational: false, nrRequests: 1023, readAheadKb: 128 },
    { name: 'nvme1n1', scheduler: 'mq-deadline', rotational: false },
    { name: 'sda', scheduler: 'mq-deadline', rotational: true },
  ];
  const j = J.judgeTuning({ tuning: TU({ blkq, cores: 8, netq: [{ name: 'eno1', txqlen: 1000, rxq: 8 }, { name: 'eno2', txqlen: 5000, rxq: 16 }] }), role: 'general' });
  const nv = item(j, 'disk.nvmeSched');
  assert.equal(nv.status, 'advise');
  assert.deepEqual(nv.devices.map((d) => [d.name, d.status]), [['nvme0n1', 'ok'], ['nvme1n1', 'advise']]);
  assert.equal(item(j, 'disk.hddSched').status, 'ok');
  const tq = item(j, 'net.txqueuelen');
  assert.deepEqual(tq.devices.map((d) => [d.name, d.status]), [['eno1', 'ok'], ['eno2', 'info']], '5000 은 참고(바뀜) — 20000 초과만 권고');
  assert.equal(tq.status, 'ok');
  const tq2 = item(J.judgeTuning({ tuning: TU({ netq: [{ name: 'eno1', txqlen: 20_001, rxq: 1 }] }), role: 'general' }), 'net.txqueuelen');
  assert.equal(tq2.status, 'advise');
  const ch = item(j, 'net.channels');
  assert.equal(ch.status, 'advise'); assert.equal(ch.devices[1].status, 'advise', '16 큐 > 8 코어');
  assert.equal(ch.devices[0].status, 'ok', '8 큐 = 8 코어 — 경계는 적합(이하)');
  const noCores = item(J.judgeTuning({ tuning: TU({ netq: [{ name: 'eno1', txqlen: 1000, rxq: 4 }] }), role: 'general' }), 'net.channels');
  assert.equal(noCores.status, 'unknown'); assert.equal(noCores.devices[0].reason, 'coresNotRead');
  const noNvme = item(J.judgeTuning({ tuning: TU({ blkq: [{ name: 'sda', scheduler: 'bfq', rotational: true }] }), role: 'general' }), 'disk.nvmeSched');
  assert.equal(noNvme.status, 'info'); assert.equal(noNvme.reason, 'noDevice');
  assert.equal(item(J.judgeTuning({ tuning: TU({ blkq: null }), role: 'general' }), 'disk.nvmeSched').reason, 'notRead');
});

test('softnet 누적 0 → 적합 · 0 아님 → 참고(cumulative — 지금 늘고 있는지 모른다) · 드롭 0 → 적합(noDrops) · 드롭 있으면 NIC 카운터 미수집 → 확인 불가 · 첫 표본(null) → notRead', () => {
  assert.equal(item(J.judgeTuning({ tuning: TU({ softnet: { squeezed: 0 } }) }), 'net.softnet').status, 'ok');
  const s = item(J.judgeTuning({ tuning: TU({ softnet: { squeezed: 12 } }) }), 'net.softnet');
  assert.equal(s.status, 'info'); assert.equal(s.reason, 'cumulative');
  const d0 = J.judgeTuning({ tuning: TU(), detail: { nics: [{ dropDelta: 0 }, { dropDelta: 0 }] } });
  assert.equal(item(d0, 'net.dropCounters').status, 'ok'); assert.equal(item(d0, 'net.ring').reason, 'noDrops');
  const d1 = J.judgeTuning({ tuning: TU(), detail: { nics: [{ dropDelta: 0 }, { dropDelta: 5 }] } });
  assert.equal(item(d1, 'net.dropCounters').status, 'unknown'); assert.equal(item(d1, 'net.dropCounters').reason, 'ethtoolNotRead');
  const dn = J.judgeTuning({ tuning: TU(), detail: { nics: [{ dropDelta: null }] } });
  assert.equal(item(dn, 'net.dropCounters').reason, 'notRead', '첫 표본(null)은 0 이 아니다');
});

/* ── 기능 프로파일 > 역할 ───────────────────────────────────── */
test('우선순위 기능 > 역할 — gpdb 가 swappiness 를 1 로 덮고 누가 정했나(by)가 profile:gpdb · 역할만이면 role:db', () => {
  const tu = TU({ sysctl: { 'vm.swappiness': '10', 'thp.enabled': 'madvise' } });
  const roleOnly = J.judgeTuning({ tuning: tu, role: 'db' });
  assert.equal(item(roleOnly, 'mem.swappiness').status, 'ok'); assert.equal(item(roleOnly, 'mem.swappiness').by, 'role:db');
  const app = M.appRulesForJudge(['gpdb']);
  const withGp = J.judgeTuning({ tuning: tu, role: 'db', appRules: app.rules });
  assert.equal(item(withGp, 'mem.swappiness').status, 'advise', 'gpdb 요구 1');
  assert.equal(item(withGp, 'mem.swappiness').by, 'profile:gpdb');
  assert.equal(item(withGp, 'mem.thp').rec, 'never');
});

/* ── 관리자 덮어쓰기 ───────────────────────────────────────── */
test('덮어쓰기 — 법인 > 전체 > 역할 기본 · 덮을 수 없는 항목 거부 · 값 형식 · 해제(빈 문자열) · 기능 프로파일은 덮어쓰기보다 위', () => {
  OV._resetTuningOverridesForTest();
  assert.equal(OV.saveTuningOverride({ scope: 'all', role: 'db', itemId: 'mem.swappiness', value: '5' }, { by: 'adm' }).ok, true);
  assert.equal(OV.saveTuningOverride({ scope: 'vcA', role: 'db', itemId: 'mem.swappiness', value: '20' }, { by: 'adm' }).ok, true);
  assert.equal(OV.saveTuningOverride({ scope: 'all', role: 'db', itemId: 'mem.minFree', value: '1000' }).ok, false, '범위 규칙 항목은 덮어쓰지 않는다');
  assert.equal(OV.saveTuningOverride({ scope: 'all', role: 'db', itemId: 'mem.swappiness', value: '$(reboot)' }).ok, false, '값 형식');
  assert.equal(OV.saveTuningOverride({ scope: 'all', role: 'boss', itemId: 'mem.swappiness', value: '1' }).ok, false, '역할');
  assert.equal(OV.saveTuningOverride({ scope: '__proto__', role: 'db', itemId: 'mem.swappiness', value: '1' }).ok, false, 'scope 형식');
  const a = OV.overridesFor({ role: 'db', vcenterId: 'vcB' });
  assert.deepEqual(a.map['mem.swappiness'], { value: '5', by: 'override:all' });
  const b = OV.overridesFor({ role: 'db', vcenterId: 'vcA' });
  assert.deepEqual(b.map['mem.swappiness'], { value: '20', by: 'override:corp' });
  const tu = TU({ sysctl: { 'vm.swappiness': '20' } });
  const j = J.judgeTuning({ tuning: tu, role: 'db', overrides: b.map });
  assert.equal(item(j, 'mem.swappiness').status, 'ok'); assert.equal(item(j, 'mem.swappiness').by, 'override:corp');
  const g = J.judgeTuning({ tuning: tu, role: 'db', overrides: b.map, appRules: M.appRulesForJudge(['gpdb']).rules });
  assert.equal(item(g, 'mem.swappiness').by, 'profile:gpdb', '기능 > 역할(덮어쓰기 포함)');
  assert.equal(OV.saveTuningOverride({ scope: 'vcA', role: 'db', itemId: 'mem.swappiness', value: '' }).cleared, true);
  assert.equal(OV.overridesFor({ role: 'db', vcenterId: 'vcA' }).map['mem.swappiness'].by, 'override:all');
  assert.equal(OV.saveTuningOverride({ scope: 'all', role: 'db', itemId: 'mem.swappiness', value: null }).ok, true);
  const n = J.judgeTuning({ tuning: tu, role: 'db', overrides: OV.overridesFor({ role: 'db' }).map });
  assert.equal(item(n, 'mem.swappiness').status, 'info', 'null = 권장 없음');
});

test('덮어쓰기 파일 손상 → 보존본 · 판정 · 저장 거부(unreadable) — 재시작(캐시 초기화) 뒤에도 보존본만 남으면 여전히 못 읽음', () => {
  OV._resetTuningOverridesForTest();
  fs.writeFileSync(path.join(DIR, 'bmusage-tuning.json'), '{ broken');
  const r = OV.overridesFor({ role: 'db' });
  assert.ok(r.error, '오류');
  assert.ok(!/broken/.test(r.error.reason), '사유에 원문 조각을 싣지 않는다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bmusage-tuning.json.corrupt.')), '보존본');
  const s = OV.saveTuningOverride({ scope: 'all', role: 'db', itemId: 'mem.swappiness', value: '5' });
  assert.equal(s.ok, false); assert.equal(s.unreadable, true);
  OV._resetTuningOverridesForTest();
  assert.ok(OV.overridesFor({ role: 'db' }).error, '보존본만 남은 상태 = 여전히 못 읽음(v2.633 규약)');
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('bmusage-tuning.json')) fs.rmSync(path.join(DIR, f));
  OV._resetTuningOverridesForTest();
});

/* ── 쓰기 경로 없음(자동 튜닝 적용 금지) ───────────────────────── */
test('자동 적용 경로 없음 — 튜닝 · 용도 · 조립 · 라우트에 sysctl -w · tuned-adm profile · ethtool -G/-L/-K · echo > /proc|/sys 가 없다(소스 스윕)', () => {
  const files = [
    ...['tuning', 'profiles'].flatMap((d) => fs.readdirSync(path.join(SRC, 'bmusage', d)).map((f) => path.join(SRC, 'bmusage', d, f))),
    path.join(SRC, 'bmusage/opsView.js'), path.join(SRC, 'bmusage/parse/linuxFacts.js'), path.join(SRC, 'routes/api/bmUsage.js'),
  ];
  const BAD = [/sysctl\s+-w/, /sysctl\s+--write/, /tuned-adm\s+profile/, /ethtool\s+-[GLKs]\b/, /\bexec\s*\(\s*[^)]*sysctl/, />\s*\/proc\/sys/, />\s*\/sys\//, /\bsudo\b/];
  for (const f of files) {
    // 근거 인용(evidence)은 문서 문장 그대로라 뺀다(R3: “… by running sudo dnf -y upgrade.” — 실행하는 명령이 아니라 인용).
    const src = stripComments(fs.readFileSync(f, 'utf8')).split('\n').filter((l) => !/^\s*evidence:/.test(l) && !/\bevidence: '/.test(l)).join('\n');
    for (const re of BAD) assert.ok(!re.test(src), `${path.relative(SRC, f)}: ${re}`);
  }
});

/* ── 반증 R9 — ‘a / b’ 묶음의 한쪽 결측 = 확인 불가(권고 아님) · 업그레이드 기간(엣지 v2.922 + 중앙 v2.923) ───────────── */
test('묶음 값(‘a / b’) 한쪽 결측 → 확인 불가 — eqStr · gpdb SYS2 · 카탈로그 묶음 항목 전부 · v2.922 엣지 사실(새 sysctl 키 없음)이 섞여도 권고가 새지 않는다', async () => {
  assert.equal(C.pairText(undefined, undefined), undefined);
  assert.equal(C.pairText('2', undefined), '2 / —');
  assert.equal(C.hasMissingPart('2 / —'), true); assert.equal(C.hasMissingPart('— / 95'), true); assert.equal(C.hasMissingPart('2 / 95'), false); assert.equal(C.hasMissingPart('—'), false);
  assert.deepEqual(J.evalRule({ kind: 'eqStr', value: '2 / 95' }, '2 / —'), { status: 'unknown', reason: 'notRead' });
  assert.deepEqual(J.evalRule({ kind: 'eqStr', value: '2 / 95' }, '2 / 90'), { status: 'advise', reason: null }, '둘 다 읽혔으면 그대로 판정');
  // v2.922 엣지가 보내던 sysctl 키(기준판 SYSCTL_PATHS)만 — 4단계에 더한 14키(overcommit_ratio · rmem_default · wmem_default …)는 없다.
  const OLD = {
    'vm.swappiness': '1', 'vm.dirty_ratio': '10', 'vm.dirty_background_ratio': '3', 'vm.min_free_kbytes': '500000', 'vm.overcommit_memory': '2', 'vm.zone_reclaim_mode': '0',
    'kernel.numa_balancing': '0', 'net.core.somaxconn': '4096', 'net.core.netdev_max_backlog': '10000', 'net.core.rmem_max': '16777216', 'thp.enabled': 'always madvise [never]',
  };
  const tu = { v: 1, os: { id: 'rocky', versionId: '9.4', pageSize: 4096 }, sysctl: OLD, memTotalKb: 16 * 1024 * 1024, sections: { sysctl: 'ok', osrel: 'ok' } };
  const pv = M.profileView({ tuning: tu, manual: { apps: ['gpdb'], role: 'db' } });
  const gp = pv.profiles.find((p) => p.id === 'gpdb');
  const by = Object.fromEntries(gp.tunings.map((x) => [x.key, x]));
  assert.equal(by['gp.overcommit'].current, '2 / —'); assert.equal(by['gp.overcommit'].status, 'unknown', 'overcommit_ratio 를 못 받았다 — 권고가 아니다');
  assert.equal(by['gp.rmemMax'].current, '16777216 / —'); assert.equal(by['gp.rmemMax'].status, 'unknown');
  assert.equal(by['gp.rmemDefault'].status, 'unknown');
  for (const x of gp.tunings) if (typeof x.current === 'string' && C.hasMissingPart(x.current)) assert.notEqual(x.status, 'advise', `${x.key} ‘${x.current}’`);
  const { tuningViewFor } = await import('../src/bmusage/opsView.js');
  const tv = tuningViewFor({ tuning: tu, manual: { apps: ['gpdb'], role: 'db' } });
  const rm = tv.items.find((x) => x.id === 'net.rmemMax');
  assert.equal(rm.by, 'profile:gpdb'); assert.equal(rm.status, 'unknown', '튜닝 탭(기능 프로파일이 덮은 항목)도 확인 불가');
  for (const x of tv.items) if (typeof x.current === 'string' && C.hasMissingPart(x.current)) assert.notEqual(x.status, 'advise', `${x.id} ‘${x.current}’`);
  // 카탈로그 묶음 항목(역할 기본) — 한쪽만 있어도 권고 아님.
  const dirty = J.judgeTuning({ tuning: { v: 1, sysctl: { 'vm.dirty_ratio': '20' }, sections: { sysctl: 'ok' } }, role: 'general' }).items.find((x) => x.id === 'mem.dirty');
  assert.equal(dirty.status, 'unknown');
});

/* ── 반증 R10 — 덮어쓰기 scope 의 프로토타입 이름 ───────────────────────────────────────── */
test('덮어쓰기 scope(반증 R10) — toString · hasOwnProperty · valueOf · __proto__ 는 거부(400 사유) · 전역 Object.prototype 을 고치지 않는다 · 파일에 그런 키가 있어도 읽지 않는다', () => {
  OV._resetTuningOverridesForTest();
  try { fs.unlinkSync(path.join(DIR, 'bmusage-tuning.json')); } catch { /* */ }
  for (const sc of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor', 'isPrototypeOf', '__defineGetter__']) {
    const r = OV.saveTuningOverride({ scope: sc, role: 'db', itemId: 'mem.swappiness', value: '1' }, { by: 't' });
    assert.equal(r.ok, false, sc);
  }
  assert.equal(Object.hasOwn(Object.prototype.toString, 'db'), false, '전역 내장 함수 객체에 속성이 생기지 않는다');
  assert.equal(Object.hasOwn(Object.prototype.hasOwnProperty, 'db'), false);
  assert.equal(({}).db, undefined, 'Object.prototype 오염 없음');
  const ok = OV.saveTuningOverride({ scope: 'vc-eu-central', role: 'db', itemId: 'mem.swappiness', value: '5' }, { by: 't' });
  assert.equal(ok.ok, true);
  assert.equal(OV.overridesFor({ role: 'db', vcenterId: 'vc-eu-central' }).map['mem.swappiness'].value, '5');
  assert.deepEqual(OV.overridesFor({ role: 'db', vcenterId: 'toString' }).map['mem.swappiness'], undefined, '상속 이름으로 법인 덮어쓰기를 읽지 않는다');
  // 손으로 고친 파일에 상속 이름 키가 있어도 버린다.
  fs.writeFileSync(path.join(DIR, 'bmusage-tuning.json'), JSON.stringify({ v: 1, all: {}, corps: { toString: { db: { 'mem.swappiness': '9' } }, valueOf: { db: { 'mem.swappiness': '9' } } } }));
  OV._resetTuningOverridesForTest();
  assert.deepEqual(Object.keys(OV.loadTuningOverrides().corps), []);
  assert.deepEqual(Object.keys(OV.overridesFor({ role: 'toString', vcenterId: 'toString' }).map), [], '역할 · 법인 이름이 상속 이름이어도 아무것도 읽지 않는다');
  fs.unlinkSync(path.join(DIR, 'bmusage-tuning.json')); OV._resetTuningOverridesForTest();
});
