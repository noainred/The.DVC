/**
 * snapCreatorExclude3304.test.js — v3.30.4 ‘만든 계정에서 뺄 백업 계정’(vm-hygiene.json creatorExclude).
 *   ① 설정 — 글자만 · 제어 문자 · 128자 초과 버림 · 대소문자 무시 중복 제거 · 50개 상한 · 배열이 아니면 그대로(지우지 않음)
 *   ② 맞춤 — 도메인을 적으면 그 도메인만 · 안 적으면 어느 도메인이든 · 'veeam' 이름 규칙은 끼지 않는다 · 뺀 이벤트 수(listed)
 *   ③ 응답 가림 — 관리자 판본이 아니면 개수만 · 범위 계정은 예외 원문과 함께 가림
 *   ④ 라우트(정적) — 저장은 관리자 판본만 이 칸을 쓴다 · 만든 계정 캐시 열쇠에 설정 판본
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapcrex3304-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ } });
process.env.CONFIG_DIR = TMP;

const { applyPatch, DEFAULTS, CREATOR_EXCLUDE_MAX, saveVmHygieneSettings, loadVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
const { creatorsOf, listedMatcher } = await import('../src/snaphist/creators.js');
const { maskedSettings, creatorMasked } = await import('../src/routes/api/vmHygiene.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('① 설정 — 정리 · 상한 · 배열이 아니면 그대로', () => {
  const base = { ...DEFAULTS, notify: { ...DEFAULTS.notify }, creatorExclude: ['keep'] };
  assert.deepEqual(DEFAULTS.creatorExclude, []);
  const n = applyPatch(base, { creatorExclude: [' VSPHERE.LOCAL\\bareos ', 'vsphere.local\\BAREOS', 'rubrik@corp', 'bad\nline', 'x'.repeat(129), 7, ''] });
  assert.deepEqual(n.creatorExclude, ['VSPHERE.LOCAL\\bareos', 'rubrik@corp']);
  assert.deepEqual(applyPatch(base, { creatorExclude: 'bareos' }).creatorExclude, ['keep'], '글자 하나는 바꾸지 않는다');
  assert.deepEqual(applyPatch(base, { snapAgeDays: 9 }).creatorExclude, ['keep'], '칸이 없으면 그대로');
  assert.deepEqual(applyPatch(base, { creatorExclude: [] }).creatorExclude, [], '빈 배열은 비운다');
  const many = Array.from({ length: 80 }, (_, i) => `svc${i}`);
  assert.equal(applyPatch(base, { creatorExclude: many }).creatorExclude.length, CREATOR_EXCLUDE_MAX);
  _resetVmHygieneSettings();
  const s = saveVmHygieneSettings({ creatorExclude: ['bareos'] }, 'admin');
  assert.deepEqual(s.creatorExclude, ['bareos']);
  _resetVmHygieneSettings();
  assert.deepEqual(loadVmHygieneSettings().creatorExclude, ['bareos'], '파일로 남는다');
  const s2 = saveVmHygieneSettings({ snapAgeDays: 5 }, 'admin');
  assert.deepEqual(s2.creatorExclude, ['bareos'], '다른 칸 저장이 지우지 않는다');
});

test('② 맞춤 — 도메인 규칙 · veeam 이름 규칙은 끼지 않음 · listed 수', () => {
  const m = listedMatcher(['VSPHERE.LOCAL\\bareos', 'rubrik']);
  assert.equal(m('vsphere.local\\Bareos'), true);
  assert.equal(m('bareos@vsphere.local'), true, '같은 도메인 다른 표기');
  assert.equal(m('CORP\\bareos'), false, '도메인을 적었으면 그 도메인만');
  assert.equal(m('CORP\\rubrik'), true); assert.equal(m('rubrik@x.local'), true, '도메인 없이 적으면 어느 도메인이든');
  assert.equal(m('svc-veeam'), false, "'veeam' 이름 규칙은 이 목록의 일이 아니다");
  assert.equal(listedMatcher(undefined)('x'), false);
  const vms = [{ id: 'a:1', name: 'web' }];
  const ev = (user, ts) => ({ entity: 'web', user, ts, type: 'VmSnapshotCreatedEvent', message: 'Task: Create virtual machine snapshot', severity: 'info' });
  const r = creatorsOf(vms, [ev('kim', 10), ev('VSPHERE.LOCAL\\bareos', 40), ev('rubrik@corp', 50), ev('svc-veeam', 60)], (u) => /veeam/.test(u), m);
  assert.deepEqual(r.byVm.get('a:1'), { user: 'kim', ts: 10 }, '백업 계정이 사람 계정을 가리지 않는다');
  assert.equal(r.listed, 2); assert.equal(r.events, 1);
  assert.equal(creatorsOf(vms, [ev('kim', 10)], () => false).listed, 0, '목록 없이 부르면 예전과 같다');
});

test('③ 응답 가림 — 관리자 판본이 아니면 개수만', () => {
  const s = { ...DEFAULTS, exceptions: ['vm-a'], creatorExclude: ['bareos', 'rubrik'], updatedBy: 'kim' };
  const c = creatorMasked(s);
  assert.deepEqual(c.creatorExclude, []); assert.equal(c.creatorExcludeCount, 2); assert.equal(c.creatorExcludeHidden, true);
  assert.deepEqual(c.exceptions, ['vm-a'], '예외는 그대로(전체 범위 비관리자)');
  const m = maskedSettings(s);
  assert.deepEqual(m.creatorExclude, []); assert.deepEqual(m.exceptions, []); assert.equal(m.updatedBy, null);
});

test('④ 라우트(정적) — 관리자 판본만 저장 · 응답 세 곳이 같은 판정 · 캐시 열쇠', () => {
  const hy = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/vmHygiene.js'), 'utf8'));
  assert.match(hy, /if \(!isAdminDetailUser\(req\.user\)\) delete body\.creatorExclude;/);
  assert.equal((hy.match(/settingsFor\(req\.user/g) || []).length, 3, '분석 · 설정 조회 · 저장 응답');
  const vt = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/vcTools.js'), 'utf8'));
  const cr = vt.slice(vt.indexOf("api.get('/tools/snapshots/creators'"), vt.indexOf("api.get('/tools/snapshots/holds'"));
  assert.match(cr, /snapshotCreators\(\{ snap, vcIds, exclude \}\)/);
  assert.match(cr, /\|s\$\{loadVmHygieneSettings\(\)\.rev\}/, '목록을 바꾸면 5분 캐시가 바로 갈린다');
  assert.match(cr, /user: admin \? c\.user : null/);
});
