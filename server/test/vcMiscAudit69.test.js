// 전체 점검 69회차 — vCenter 부가 점검 모듈(1차: availability · cost · migration · vmchanges · vmhygiene · vmlife · fieldcheck · tags · vcinfo · corelicense · dscfg).
//  F1 이벤트 상세 파서(inner) 중첩 태그 O(n²) — 장비 출력 · 로그 폴러 경로
//  F2 이력 화면(vm-changes · vm-lifecycle · VM 상세)의 마지막 이벤트 시각이 미래 행 1건에 끌려감(v2.783 L-B1 의 형제 경로)
//  F3 VM 상세 태그(/tools/vm-tags/of)가 부분 읽기 · 템플릿에 '필수 태그 없음' 을 단정(목록 analyzeTags 와 반대)
//  I1 잘린 CSV(vm-hygiene · storage-paths · vm-changes · vm-lifecycle)의 표지가 헤더에만 있었다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vcmisc69-'));
process.env.CONFIG_DIR = TMP;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const DAY = 86_400_000;

test('F1: 이벤트 상세 inner — 같은 태그가 깊게 중첩돼도 선형(비율로 고정) · 중첩 이름 판정은 그대로', async () => {
  const { eventDetail } = await import('../src/vmchanges/eventDetail.js');
  // 의미: 바깥 <host> 의 <name> 을 읽는다(안쪽 같은 이름 태그를 건너뛴다 — v2.702 규칙)
  const ok = eventDetail('VmMigratedEvent', '<host><host type="HostSystem">host-2</host><name>esx-b</name></host><sourceHost><host type="HostSystem">host-1</host><name>esx-a</name></sourceHost>');
  assert.equal(ok.to, 'esx-b');
  assert.equal(ok.from, 'esx-a');
  assert.equal(ok.kind, 'vmotion');
  // <hostX> 를 <host> 로 읽지 않는다 · 자기닫힘은 빈 값
  assert.equal(eventDetail('VmMigratedEvent', '<hostX><name>no</name></hostX><host><name>yes</name></host>').to, 'yes');
  assert.equal(eventDetail('VmMigratedEvent', '<host/><ds><name>d1</name></ds>').to, null);
  // 닫는 태그가 모자라면 null(지어내지 않는다)
  assert.equal(eventDetail('VmMigratedEvent', '<host><host><name>x</name></host>').to, null);
  const timeOf = (k) => {
    const body = `${'<host>'.repeat(k)}x${'</host>'.repeat(k)}`;
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const t = performance.now(); eventDetail('VmMigratedEvent', body); best = Math.min(best, performance.now() - t); }
    return best;
  };
  timeOf(500);   // 워밍업
  const small = timeOf(2_000);
  const big = timeOf(16_000);   // 8배 — 선형이면 약 8배, 이차면 약 64배(수정 전 실측 41ms → 1,597ms)
  assert.ok(big / Math.max(small, 0.5) < 20, `중첩 8배에 ${small.toFixed(1)}ms → ${big.toFixed(1)}ms — 선형이 아니다`);
  assert.ok(big < 400, `203KB 중첩 본문에 ${big.toFixed(0)}ms`);
});

test('F2: 이력 화면의 마지막 이벤트 시각은 미래 행 경계 안의 MAX(실 SQLite) — 라우트 두 곳 · VM 상세가 같은 함수', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const { eventCoverageRows, eventLastTsOf } = await import('../src/vmchanges/analyze.js');
  const db = await getLogsDb();
  const last = NOW - 3 * DAY;
  db.insertMany([
    { vcenterId: 'vc-a', key: 'k1', ts: last - DAY, severity: 'info', type: 'VmMigratedEvent', user: '', entity: 'vm1', message: 'm' },
    { vcenterId: 'vc-a', key: 'k2', ts: last, severity: 'info', type: 'VmMigratedEvent', user: '', entity: 'vm1', message: 'm' },
    // vCenter 시계가 앞서 들어온 미래 행 1건(prune 은 ts < ? 라 남는다)
    { vcenterId: 'vc-a', key: 'k3', ts: Date.UTC(2099, 0, 1), severity: 'info', type: 'VmMigratedEvent', user: '', entity: 'vm1', message: 'm' },
  ]);
  assert.equal(db.lastTs('vc-a'), Date.UTC(2099, 0, 1), '전제: 인자 없는 lastTs 는 원본 MAX(미래 행)');
  assert.equal(eventLastTsOf(db, 'vc-a', NOW), last, '미래 행을 빼고 마지막 이벤트(3일 전) — 화면이 이틀 지남을 말할 수 있다');
  assert.equal(eventLastTsOf(db, 'vc-none', NOW), null, '받은 적 없는 vCenter 는 null(0 = 1970 이 아니다)');
  const rows = eventCoverageRows(db, ['vc-a', 'vc-none'], { vcName: new Map([['vc-a', 'A']]), nc: new Map([['vc-none', 'edge']]), now: NOW });
  assert.deepEqual(rows, [{ vcenterId: 'vc-a', name: 'A', lastTs: last }, { vcenterId: 'vc-none', name: 'vc-none', lastTs: null, notCollected: 'edge' }]);
  // 라우트는 원본 MAX 를 직접 부르지 않는다(인자 하나짜리 db.lastTs 0건)
  for (const f of ['routes/api/vmChanges.js', 'routes/api/vmLifecycle.js']) {
    const s = read(f);
    assert.equal((s.match(/\bdb\.lastTs\(\s*[^,()]+\)/g) || []).length, 0, `${f} 가 경계 없는 db.lastTs 를 부른다`);
    assert.match(s, /eventCoverageRows\(db, ids/, `${f} 는 수집 범위 행을 eventCoverageRows 로 만든다`);
  }
  assert.match(read('routes/api/vmChanges.js'), /lastTs: eventLastTsOf\(db, vm\.vcenterId\)/, 'VM 상세(/of)도 같은 경계');
});

test('F3: VM 상세 태그 — 부분 읽기 · 템플릿에는 빠진 필수 태그를 단정하지 않는다(목록과 같은 판정)', async () => {
  const { vmTagsOfBody } = await import('../src/routes/api/vmTags.js');
  const { analyzeTags } = await import('../src/tags/analyze.js');
  const pol = { requiredCategories: ['Owner', 'Env'], corpCategory: '' };
  const inv = (partialTags) => ({ categories: [{ name: 'Owner' }, { name: 'Env' }], tags: [{ name: 'teamA', cat: 0 }], vmTags: { 'vm-1': [0] }, partialTags, tagsAt: NOW });
  const vm = { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'app01', template: false };
  // 다 읽었으면 예전 그대로 — Env 없음
  const full = vmTagsOfBody(vm, inv(false), pol);
  assert.deepEqual(full.missing, ['Env']);
  assert.equal(full.partial, undefined);
  // 일부만 읽었으면 '없음' 이 아니라 '확인 안 됨' — 목록(analyzeTags)도 이 VM 을 누락으로 세지 않는다
  const part = vmTagsOfBody(vm, inv(true), pol);
  assert.equal(part.missing, null, '부분 읽기에서 Env 없음을 단정했다');
  assert.equal(part.partial, true);
  assert.deepEqual(part.missingUnsure, ['Env']);
  const list = analyzeTags([{ id: 'vc1', name: 'VC1', tagInv: inv(true) }], [vm], pol);
  assert.equal(list.missingByCategory.Env, 0);
  assert.equal(list.coverage.partialUncheckedVms, 1);
  // 부분 읽기라도 읽은 연결에서 다 보였으면 빠진 것이 없다(빈 배열 — 확인됨)
  const allSeen = vmTagsOfBody(vm, { ...inv(true), tags: [{ name: 'teamA', cat: 0 }, { name: 'prod', cat: 1 }], vmTags: { 'vm-1': [0, 1] } }, pol);
  assert.deepEqual(allSeen.missing, []);
  assert.equal(allSeen.missingUnsure, undefined);
  // 템플릿은 점검 대상이 아니다 — 화면이 '점검 대상이 아닙니다' 와 '없음' 배지를 함께 보이지 않게
  const tpl = vmTagsOfBody({ ...vm, template: true }, inv(false), pol);
  assert.equal(tpl.missing, null);
  assert.equal(tpl.template, true);
  // 못 읽은 vCenter 는 예전처럼 null
  assert.equal(vmTagsOfBody(vm, null, pol).missing, null);
  assert.match(read('routes/api/vmTags.js'), /res\.json\(vmTagsOfBody\(vm,/, '/of 라우트가 같은 함수를 쓴다');
});

test('I1: 잘린 CSV 는 파일 안에도 표지를 싣는다(헤더만이 아니다)', () => {
  const cases = [
    ['routes/api/vmHygiene.js', /if \(r\.omitted\) lines\.push\(csvLine\(\[`\(상한으로/],
    ['routes/api/storagePaths.js', /if \(r\.omitted\) lines\.push\(csvLine\(\[`\(상한으로/],
    ['routes/api/vmChanges.js', /if \(L\.truncated\) lines\.push\(csvLine\(\[`\(이벤트가 많아/],
    ['routes/api/vmLifecycle.js', /if \(L\.truncated\) \{[^}]*lines\.push\(csvLine\(\[`\(이벤트가 많아/],
  ];
  for (const [f, re] of cases) assert.match(read(f), re, `${f} — 잘린 사실이 파일에 없다`);
});

// F4: 설정 3종(비용 단가 · VM 구성 점검 · 태그 정책)의 읽기 오류는 손상이 아니다 — 원본을 옮기지 않고 · 캐시하지 않고 · 저장을 거절한다
function withReadError(file, fn) {
  const orig = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === file) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
  let r;
  try { r = fn(); } catch (e) { fs.readFileSync = orig; throw e; }
  if (r && typeof r.then === 'function') return r.finally(() => { fs.readFileSync = orig; });   // 비동기 본문은 끝난 뒤에 되돌린다
  fs.readFileSync = orig;
  return r;
}
const corruptOf = (file) => fs.readdirSync(TMP).filter((n) => n.startsWith(`${file}.corrupt.`));

test('F4: 비용 단가 — 일시적 읽기 오류가 단가 파일을 .corrupt 로 옮기지 않고, 오류가 지나면 단가가 돌아온다 · 그동안 저장 거절', async () => {
  const { loadCostSettings, saveCostSettings, _resetCostSettings } = await import('../src/cost/settings.js');
  const file = path.join(TMP, 'cost-rates.json');
  fs.writeFileSync(file, JSON.stringify({ currency: 'KRW', vcpu: 10000, ramGB: 5000, storageGB: 100 }));
  _resetCostSettings();
  assert.equal(loadCostSettings().vcpu, 10000);
  _resetCostSettings();
  withReadError('cost-rates.json', () => {
    const s = loadCostSettings();
    assert.equal(s.unreadable, true);
    assert.equal(s.vcpu, null, '읽지 못한 동안은 단가 없음(지어내지 않는다)');
    assert.throws(() => saveCostSettings({ vcpu: 1 }, 'admin'), /읽지 못해 저장하지 않습니다/);
  });
  assert.deepEqual(corruptOf('cost-rates.json'), [], '읽기 오류로 원본을 옮겼다');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vcpu, 10000, '원본이 그대로');
  assert.equal(loadCostSettings().vcpu, 10000, '읽지 못한 값을 캐시하지 않아 다음 호출에서 다시 읽는다');
  // 파싱 실패(진짜 손상)는 예전처럼 보존한다
  fs.writeFileSync(file, '{ broken');
  _resetCostSettings();
  assert.equal(loadCostSettings().vcpu, null);
  assert.equal(corruptOf('cost-rates.json').length, 1);
});

test('F4: VM 구성 점검 설정 — 읽기 오류 중 원본 유지 · 저장 거절 · 알림은 off 가 아니라 settings-unreadable', async () => {
  const { loadVmHygieneSettings, saveVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
  const { vmHygieneNotifyOnce } = await import('../src/vmhygiene/notifier.js');
  const file = path.join(TMP, 'vm-hygiene.json');
  fs.writeFileSync(file, JSON.stringify({ snapAgeDays: 3, exceptions: ['keep-me'], notify: { enabled: true, hour: 9 } }));
  _resetVmHygieneSettings();
  assert.equal(loadVmHygieneSettings().snapAgeDays, 3);
  _resetVmHygieneSettings();
  await withReadError('vm-hygiene.json', async () => {
    const s = loadVmHygieneSettings();
    assert.equal(s.unreadable, true);
    assert.throws(() => saveVmHygieneSettings({ snapAgeDays: 9 }, 'admin'), /읽지 못해 저장하지 않습니다/);
    let sent = 0;
    const r = await vmHygieneNotifyOnce({ now: NOW, force: true, send: async () => { sent += 1; return ['ok'] }, snap: { initial: false, vcenters: [], vms: [] } });
    assert.equal(r.reason, 'settings-unreadable');
    assert.equal(sent, 0);
  });
  assert.deepEqual(corruptOf('vm-hygiene.json'), []);
  const s2 = loadVmHygieneSettings();
  assert.equal(s2.snapAgeDays, 3);
  assert.deepEqual(s2.exceptions, ['keep-me']);
  assert.equal(s2.unreadable, undefined);
});

test('F4: 태그 정책 — 읽기 오류 중 원본 유지 · 저장은 unreadable(라우트 503)', async () => {
  const { loadTagPolicy, saveTagPolicy, _resetTagPolicy } = await import('../src/tags/policy.js');
  const file = path.join(TMP, 'tag-policy.json');
  fs.writeFileSync(file, JSON.stringify({ requiredCategories: ['Owner'], corpCategory: 'Corp' }));
  _resetTagPolicy();
  assert.deepEqual(loadTagPolicy().requiredCategories, ['Owner']);
  _resetTagPolicy();
  withReadError('tag-policy.json', () => {
    const p = loadTagPolicy();
    assert.equal(p.unreadable, true);
    assert.deepEqual(p.requiredCategories, []);
    const r = saveTagPolicy({ requiredCategories: [] }, 'admin');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unreadable');
  });
  assert.deepEqual(corruptOf('tag-policy.json'), []);
  assert.deepEqual(loadTagPolicy().requiredCategories, ['Owner']);
  assert.match(read('routes/api/vmTags.js'), /r\.code === 'unreadable' \? 503/);
});
