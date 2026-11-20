/**
 * v3.32 정기 점검 보고(server/src/periodic/* · routes/api/periodicReport.js · 설계 docs/design/periodic-report).
 *  ① 일정 — 일일(주말 건너뛰기) · 주간 · 월간(없는 날은 말일) · 분기(1 · 4 · 7 · 10월) 다음 · 이전 회차
 *  ② 보고 기간 · 회차 ID — 전날 · 앞 ISO 주(연도 경계) · 앞 달 · 앞 분기(1월이면 작년 4분기)
 *  ③ 회차 판정 — 유예 안 만들기 · 유예 밖 놓침(꺼져 있었음 · 늦음) · since 이전 소급 없음 · 시계 되감김
 *  ④ 판정 합치기 — crit > warn > unknown > ok · 확인 불가는 정상이 아니다 · 정보 제외 · 판정 항목이 없으면 확인 불가
 *  ⑤ 항목 정리 — DataCenter 행은 그 법인의 vCenter 로 · 모르는 vCenter 는 법인 미지정 · 해당 없음은 정보 · 행보다 좋은 항목 판정은 행으로 끌어내린다
 *  ⑥ 범위 절단 — 전체 항목(법인 행 없음) 숨김 · 보이는 행만 · 판정 다시 합침 · 행렬로 센 목록 수 = 절단 문서 수
 *  ⑦ 설정 정규화 — 잘못된 값 400 · 켜면 since · 모르는 항목 · 주소 형식 · 보관 범위
 *  ⑧ 카탈로그 ↔ 리더 1:1 · 도구 키는 웹 목록에 있다 · 카테고리 · 도구 접근 매핑 · 메일 종류
 *  ⑨ 리더는 저장된 것만 — 장비 · vCenter · Director · SSH · iDRAC 호출 모듈을 import 하지 않는다(주석 제거 뒤)
 *  ⑩ 조립 — 던지는 리더 · 시한 초과 · 리더 없음은 그 항목만 확인 불가 · 직전 회차 대비
 *  ⑪ 글 — 공지에는 판정 · 법인 이름이 없다 · 첨부 이름 형식 · 메일 제목
 *  ⑫ 실제 api — 범위 계정은 보관함 수 · 보고서가 자기 법인만 · 설정 조회 403 · 저장 · 만들기는 admin + 전체 범위 · 잘못된 설정 400
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import express from 'express';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });
const TMP = tmpDir('periodic3310-');
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL; delete process.env.CENTRAL_TOKEN;

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const R = await import('../src/periodic/rules.js');
const C = await import('../src/periodic/catalog.js');
const A = await import('../src/periodic/assemble.js');
const RD = await import('../src/periodic/render.js');
const { READERS } = await import('../src/periodic/readers/index.js');
const { localMs } = await import('../src/xferspeed/schedule.js');
const OFF = 540;
const at = (y, mo, d, h = 0, mi = 0) => localMs(y, mo, d, h, mi, OFF);
const H = 3_600_000;

test('① 일정 — 주기별 다음 · 이전 회차', () => {
  const daily = { enabled: true, time: '08:00', skipWeekend: false };
  assert.equal(R.nextSlot('daily', daily, at(2026, 11, 20, 9), OFF), at(2026, 11, 21, 8));
  assert.equal(R.prevSlot('daily', daily, at(2026, 11, 20, 9), OFF), at(2026, 11, 20, 8));
  // 2026-11-21(토) · 22(일) 건너뛰기
  assert.equal(R.nextSlot('daily', { ...daily, skipWeekend: true }, at(2026, 11, 20, 9), OFF), at(2026, 11, 23, 8));
  const weekly = { enabled: true, time: '08:30', weekday: 1 };
  assert.equal(R.nextSlot('weekly', weekly, at(2026, 11, 20, 9), OFF), at(2026, 11, 23, 8, 30));
  const monthly = { enabled: true, time: '09:00', monthDay: 31 };
  assert.equal(R.nextSlot('monthly', monthly, at(2026, 11, 20, 9), OFF), at(2026, 11, 30, 9), '11월에 31일이 없으면 말일');
  assert.equal(R.nextSlot('monthly', monthly, at(2026, 12, 1), OFF), at(2026, 12, 31, 9));
  const quarterly = { enabled: true, time: '09:30', monthDay: 1 };
  assert.equal(R.nextSlot('quarterly', quarterly, at(2026, 11, 20, 9), OFF), at(2027, 1, 1, 9, 30));
  assert.equal(R.prevSlot('quarterly', quarterly, at(2026, 11, 20, 9), OFF), at(2026, 10, 1, 9, 30));
  assert.deepEqual(R.nextSlots('daily', { ...daily, enabled: false }, at(2026, 11, 20)), []);
});

test('② 보고 기간 · 회차 ID', () => {
  const d = R.periodOf('daily', at(2026, 11, 20, 8), OFF);
  assert.equal(d.id, 'D-2026-11-19');
  assert.equal(d.from, at(2026, 11, 19)); assert.equal(d.to, at(2026, 11, 20));
  const w = R.periodOf('weekly', at(2026, 11, 23, 8, 30), OFF);   // 월요일 회차 → 앞 주 11-16(월) ~ 11-22(일)
  assert.equal(w.from, at(2026, 11, 16)); assert.equal(w.to, at(2026, 11, 23));
  assert.equal(w.id, 'W-2026-47');
  const w1 = R.periodOf('weekly', at(2027, 1, 4, 8, 30), OFF);   // 앞 주 2026-12-28 ~ 2027-01-03 = 2026년 53주차(ISO)
  assert.equal(w1.id, 'W-2026-53');
  const m = R.periodOf('monthly', at(2026, 12, 1, 9), OFF);
  assert.equal(m.id, 'M-2026-11'); assert.equal(m.from, at(2026, 11, 1)); assert.equal(m.to, at(2026, 12, 1));
  const mj = R.periodOf('monthly', at(2027, 1, 1, 9), OFF);
  assert.equal(mj.id, 'M-2026-12');
  const q = R.periodOf('quarterly', at(2027, 1, 1, 9, 30), OFF);
  assert.equal(q.id, 'Q-2026-4'); assert.equal(q.from, at(2026, 10, 1)); assert.equal(q.to, at(2027, 1, 1));
  assert.equal(R.periodOf('quarterly', at(2026, 7, 1, 9, 30), OFF).id, 'Q-2026-2');
  assert.match(R.manualRunId('D-2026-11-19', at(2026, 11, 20, 14, 3, 0) + 7000, OFF), /^D-2026-11-19-m140307$/);
  for (const id of ['D-2026-11-19', 'W-2026-47', 'M-2026-11', 'Q-2026-4', 'D-2026-11-19-m140307']) assert.ok(R.RUN_ID_RE.test(id), id);
  assert.ok(!R.RUN_ID_RE.test('../etc'));
});

test('③ 회차 판정 — 유예 · 놓침 · since · 시계', () => {
  const def = { enabled: true, time: '08:00', skipWeekend: false, since: null };
  const slot = at(2026, 11, 20, 8);
  assert.deepEqual(R.planKindTick({ kind: 'daily', def, state: {}, now: slot + 10 * 60_000, offsetMin: OFF }), { action: 'run', slot });
  const late = R.planKindTick({ kind: 'daily', def, state: { lastSlot: slot - 24 * H }, now: slot + 2 * H, bootAt: slot + H, offsetMin: OFF });
  assert.equal(late.action, 'missed'); assert.equal(late.reason, 'down', '기동 전 회차는 꺼져 있었음');
  const late2 = R.planKindTick({ kind: 'daily', def, state: { lastSlot: slot - 24 * H }, now: slot + 2 * H, bootAt: slot - 5 * H, offsetMin: OFF });
  assert.equal(late2.reason, 'late');
  assert.equal(R.planKindTick({ kind: 'daily', def: { ...def, since: slot + 60_000 }, state: {}, now: slot + 10 * 60_000, offsetMin: OFF }).action, 'none', 'since 이전 회차는 소급하지 않는다');
  assert.equal(R.planKindTick({ kind: 'daily', def, state: { lastSlot: slot }, now: slot + 10 * 60_000, offsetMin: OFF }).action, 'none', '같은 회차를 두 번 만들지 않는다');
  assert.equal(R.planKindTick({ kind: 'daily', def, state: { lastSlot: slot + 10 * H }, now: slot, offsetMin: OFF }).action, 'rebase');
  assert.equal(R.planKindTick({ kind: 'daily', def: { ...def, enabled: false }, state: {}, now: slot }).action, 'none');
});

test('④ 판정 합치기 — 확인 불가는 정상이 아니다', () => {
  assert.equal(R.worstOf(['ok', 'unknown']), 'unknown');
  assert.equal(R.worstOf(['ok', 'unknown', 'warn']), 'warn');
  assert.equal(R.worstOf(['warn', 'crit', 'info']), 'crit');
  assert.equal(R.worstOf(['info']), null);
  assert.equal(R.overallOf([{ status: 'info' }]), 'unknown', '판정 항목이 없으면 정상이라 말하지 않는다');
  assert.equal(R.overallOf([{ status: 'ok' }, { status: 'info' }]), 'ok');
  assert.deepEqual(R.countsOf([{ status: 'ok' }, { status: 'unknown' }, { status: 'info' }, { status: 'crit' }]), { ok: 1, warn: 0, crit: 1, unknown: 1, info: 1 });
});

test('⑤ 항목 정리 — DataCenter 행 · 모르는 vCenter · 해당 없음 · 행이 이긴다', () => {
  const def = C.ITEM_BY_KEY['array-health'];
  const it = A.normalizeItem(def, { status: 'ok', rows: [{ dc: 'dc-kr', status: 'warn', text: 'a' }, { vc: 'vc-gone', status: 'ok' }, { vc: 'vc-1', status: 'bogus' }] },
    { vcOfDc: (dc) => (dc === 'dc-kr' ? 'vc-1' : null), knownVc: new Set(['vc-1']) });
  assert.equal(it.rows[0].vc, 'vc-1', 'DataCenter 행은 그 법인의 vCenter 로');
  assert.equal(it.rows[1].vc, null, '지금 등록에 없는 vCenter 는 법인 미지정');
  assert.equal(it.rows[2].status, 'unknown', '모르는 판정 값은 확인 불가');
  assert.equal(it.status, 'warn', '항목 판정을 ok 로 줘도 행이 주의면 주의');
  const na = A.normalizeItem(def, { na: true, basis: '등록된 장비가 없습니다' });
  assert.equal(na.status, 'info'); assert.equal(na.na, true); assert.match(na.value, /해당 없음/);
  const info = A.normalizeItem(C.ITEM_BY_KEY['vm-count'], { rows: [{ vc: 'vc-1', status: 'crit' }] }, { knownVc: new Set(['vc-1']) });
  assert.equal(info.status, 'info'); assert.equal(info.rows[0].status, 'info', '정보 항목의 행은 판정하지 않는다');
});

const DOC = {
  id: 'M-2026-10', kind: 'monthly', items: [
    { key: 'ds-usage', axis: 'infra', label: 'DS', status: 'crit', rows: [{ vc: 'a', status: 'crit', count: 2 }, { vc: 'b', status: 'ok', count: 0 }] },
    { key: 'veeam', axis: 'service', label: 'Veeam', status: 'unknown', rows: [{ vc: 'b', status: 'unknown' }] },
    { key: 'portal-db', axis: 'service', label: 'DB', status: 'warn', fleet: true, rows: [] },
    { key: 'vm-count', axis: 'infra', label: 'VM', status: 'info', rows: [{ vc: 'a', status: 'info' }, { vc: 'b', status: 'info' }] },
    { key: 'part-faults', axis: 'facility', label: '파트', status: 'crit', rows: [{ vc: null, status: 'crit' }] },
  ],
  corps: [{ vc: 'a', name: 'A', reported: true }, { vc: 'b', name: 'B', reported: false }],
};

test('⑥ 범위 절단 — 전체 항목 숨김 · 보이는 행만 · 다시 합침 · 행렬 수 일치', () => {
  const cut = R.scopeCutDoc(DOC, new Set(['b']));
  assert.deepEqual(cut.items.map((i) => i.key), ['ds-usage', 'veeam', 'vm-count'], '포탈 자체(전체) · 법인 미지정 행만 있는 항목은 범위 계정에 없다');
  assert.equal(cut.items.find((i) => i.key === 'ds-usage').status, 'ok', '보이는 행으로 다시 합친다');
  assert.equal(cut.overall, 'unknown');
  assert.deepEqual(cut.corps.map((c) => c.vc), ['b']);
  const m = R.matrixOf(DOC);
  const sc = R.scopedCountsFromMatrix(m, new Set(['b']));
  assert.deepEqual(sc.counts, cut.counts, '목록(행렬로 센 수)과 보고서(절단 문서)의 수가 같다');
  assert.equal(sc.overall, cut.overall);
  assert.equal(R.scopeCutDoc(DOC, null), DOC, '전체 범위는 그대로');
  const acts = R.actionsOf(DOC, (vc) => vc || '미지정');
  assert.equal(acts[0].status, 'crit');
  assert.ok(!acts.some((x) => x.status === 'unknown'), '확인 불가는 조치 필요가 아니라 따로');
  assert.ok(R.unknownsOf(DOC).some((u) => u.item === 'veeam'));
});

test('⑦ 설정 정규화 — 400 · since · 모르는 항목 · 주소 · 보관', () => {
  const now = at(2026, 11, 20, 12);
  const base = R.settingsOf(null);
  assert.equal(base.kinds.daily.enabled, true); assert.equal(base.mail.enabled, true); assert.equal(base.chat.enabled, false); assert.equal(base.issues.enabled, false);
  assert.equal(R.normalizeSettings({ kinds: { daily: { time: '25:00' } } }, null, { now }).field, 'kinds.daily.time');
  assert.equal(R.normalizeSettings({ kinds: { weekly: { weekday: 9 } } }, null, { now }).field, 'kinds.weekly.weekday');
  const ok = R.normalizeSettings({ kinds: { daily: { time: '07:30' } } }, null, { now, by: 'admin' });
  assert.equal(ok.settings.kinds.daily.since, now, '회차 정의를 바꾸면 기준을 지금으로(소급 없음)');
  assert.equal(ok.settings.updatedBy, 'admin');
  const same = R.normalizeSettings({ kinds: { daily: { time: '07:30' } } }, ok.settings, { now: now + H });
  assert.equal(same.settings.kinds.daily.since, now, '같은 정의면 since 를 바꾸지 않는다');
  assert.equal(R.normalizeSettings({ kinds: { daily: { enabled: false } } }, ok.settings, { now }).settings.kinds.daily.since, null);
  assert.equal(R.normalizeSettings({ items: { nope: { enabled: false } } }, null, { now, knownItems: C.ITEM_KEYS }).field, 'items.nope');
  assert.equal(R.normalizeSettings({ items: { 'ds-usage': { kinds: ['yearly'] } } }, null, { now, knownItems: C.ITEM_KEYS }).field, 'items.ds-usage.kinds');
  assert.equal(R.normalizeSettings({ mail: { to: 'not-an-email' } }, null, { now }).field, 'mail.to');
  assert.equal(R.normalizeSettings({ mail: { corpTo: { 'vc-x': 'a@example.com' } } }, null, { now, knownVcIds: new Set(['vc-1']) }).field, 'mail.corpTo.vc-x');
  assert.equal(R.normalizeSettings({ retainDays: { daily: 3 } }, null, { now }).field, 'retainDays.daily');
  assert.equal(R.normalizeSettings({ retainDays: { quarterly: 1825 } }, null, { now }).settings.retainDays.quarterly, 1825);
  assert.equal(R.normalizeSettings('x', null).field, 'settings');
});

test('⑧ 카탈로그 ↔ 리더 · 도구 키 · 카테고리 · 접근 매핑 · 메일 종류', async () => {
  const keys = C.ITEMS.map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length, '항목 키 중복 없음');
  assert.deepEqual([...keys].sort(), Object.keys(READERS).sort(), '리더 1:1');
  for (const it of C.ITEMS) {
    assert.ok(['infra', 'service', 'facility'].includes(it.axis), it.key);
    assert.ok(it.kinds.length && it.kinds.every((k) => R.KINDS.includes(k)), it.key);
    assert.ok(it.rule && it.source, it.key);
    assert.ok(!/`/.test(`${it.label}${it.rule}${it.source}${it.fix}`), `문구에 백틱: ${it.key}`);
  }
  const webList = fs.readFileSync(path.join(here, '..', '..', 'web', 'src', 'views', 'specialToolsList.js'), 'utf8');
  for (const it of C.ITEMS.filter((x) => x.tool)) assert.match(webList, new RegExp(`k: '${it.tool}'`), `바로가기 도구 키가 웹 목록에 없다: ${it.tool}`);
  assert.match(webList, /k: 'periodic-report'/);
  const { TOOL_PATH_KEYS } = await import('../src/auth/toolAccess.js');
  assert.equal(TOOL_PATH_KEYS['periodic-report'], 'periodic-report', '세그먼트 = 키');
  const { PRESET } = await import('../src/toolcats/catalog.js');
  assert.ok(PRESET.find((c) => c.id === 'report').tools.includes('periodic-report'));
  const { KINDS: MAILK, isKind } = await import('../src/mail/kinds.js');
  assert.ok(isKind('periodic-report') && MAILK.some((k) => k.id === 'periodic-report'));
});

test('⑨ 리더는 저장된 것만 — 장비 · vCenter · Director · SSH · iDRAC 호출 모듈을 부르지 않는다', () => {
  const dir = path.join(here, '..', 'src', 'periodic', 'readers');
  const FORBIDDEN = [/soapClient/, /restClient/, /\/ssh/i, /runDirector\b/, /\brunAll\b/, /probeAll/, /collectHorizonLicenses/, /runSecretScan/, /inspectMany/,
    /diskbad\/(scan|lclog|probe|redfish)/, /edgePull/, /recordRun/, /startInspection/, /runVmDnsProbe/, /refreshCerts/, /idrac\/redfish/, /bareos\/ops/];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const code = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const re of FORBIDDEN) assert.ok(!re.test(code), `${f}: 금지 경로 ${re}`);
    assert.ok(!/from '\.\.\/\.\.\/routes\//.test(code) && !/import\('\.\.\/\.\.\/routes\//.test(code), `${f}: 리더가 routes/ 를 import(의존 방향)`);
  }
  for (const f of ['periodic/service.js', 'periodic/assemble.js', 'periodic/rules.js', 'periodic/render.js']) {
    assert.ok(!/routes\//.test(stripComments(src(f)).replace(/\/\/[^\n]*/g, '')), `${f}: routes/ import 금지`);
  }
});

test('⑩ 조립 — 던짐 · 시한 · 리더 없음은 그 항목만 확인 불가 · 직전 대비', async () => {
  const snap = { vcenters: [{ id: 'a', name: 'A', status: 'connected' }, { id: 'b', name: 'B', status: 'unreachable' }] };
  const items = ['ds-usage', 'veeam', 'vm-count', 'portal-db'].map((k) => C.ITEM_BY_KEY[k]);
  const readers = {
    'ds-usage': () => ({ rows: [{ vc: 'a', status: 'warn', text: '90%' }, { vc: 'b', status: 'unknown' }] }),
    veeam: () => { throw new Error('boom'); },
    'vm-count': () => new Promise(() => {}),
  };
  const prev = { id: 'M-2026-09', doc: { items: [{ key: 'ds-usage', status: 'ok', rows: [{ vc: 'a', status: 'ok' }] }] } };
  const doc = await A.assembleRun({ kind: 'monthly', slot: null, period: R.periodOf('monthly', at(2026, 11, 1, 9), OFF), id: 'M-2026-10', items, readers, snap, now: at(2026, 11, 1, 9), prev, timeoutMs: 50 });
  const by = Object.fromEntries(doc.items.map((i) => [i.key, i]));
  assert.equal(by['ds-usage'].status, 'warn');
  assert.equal(by['ds-usage'].prev.status, 'ok'); assert.equal(by['ds-usage'].rows[0].prev, 'ok');
  assert.equal(by.veeam.status, 'unknown'); assert.match(by.veeam.unknownReason, /boom/);
  assert.equal(by['vm-count'].status, 'info', '정보 항목은 시한을 넘겨도 정보'); assert.match(by['vm-count'].unknownReason, /초를 넘겨/);
  assert.equal(by['portal-db'].status, 'unknown'); assert.match(by['portal-db'].unknownReason, /리더가 없습니다/);
  assert.equal(doc.corpsTotal, 2); assert.equal(doc.corpsReported, 1, '수집 실패 vCenter 는 보고 안 함');
  assert.equal(doc.overall, 'warn');
});

test('⑪ 글 — 공지에는 판정 · 법인 이름이 없다 · 첨부 이름 · 메일 제목', () => {
  const doc = { ...DOC, periodLabel: '2026년 10월', counts: R.countsOf(DOC.items), overall: R.overallOf(DOC.items), corpsTotal: 2, corpsReported: 1, generatedAt: at(2026, 11, 1, 9) };
  const n = RD.renderNotice(doc);
  assert.ok(!/\bA\b|\bB\b/.test(n.body), '공지에 법인 이름을 싣지 않는다');
  assert.ok(!/이상|주의|확인 불가/.test(`${n.title}${n.body}`), '공지에 판정을 싣지 않는다');
  assert.match(RD.attachmentName(doc), /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/);
  assert.match(RD.attachmentName(doc, 'vc:한글 이름'), /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/);
  const m = RD.renderMail(doc, { portal: 'P' });
  assert.match(m.subject, /월간 점검 보고서/);
  const html = RD.renderReportHtml(doc, {});
  assert.match(html, /확인하지 못한 것/); assert.ok(!html.includes('<script'), '첨부에 스크립트 없음');
});

/* ── ⑫ 실제 api ── */
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const { api } = await import('../src/routes/api.js');
const db = await import('../src/periodic/db.js');
async function call(urlPath, { user = { username: 'root', role: 'admin', scope: {} }, method = 'GET', body = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, body: j, text };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

test('⑫ 실제 api — 범위 계정 · 게이트 · 400', async () => {
  // 문서 하나를 보관(실제 vCenter id 가 스냅샷에 없을 수 있다 — 범위 판정은 user.scope 를 그대로 쓰므로 가짜 id 로 충분)
  const doc = { ...DOC, id: 'M-2026-10', kind: 'monthly', periodFrom: at(2026, 10, 1), periodTo: at(2026, 11, 1), periodLabel: '2026년 10월', generatedAt: Date.now(), status: 'done',
    counts: R.countsOf(DOC.items), overall: R.overallOf(DOC.items), corpsTotal: 2, corpsReported: 1 };
  const put = await db.putRun(doc, R.matrixOf(doc));
  assert.ok(put.ok, put.reason);
  const admin = { username: 'root', role: 'admin', scope: {} };
  const scopedUser = { username: 'kr', role: 'operator', scope: { vcenters: ['b'] } };
  const viewer = { username: 'v', role: 'viewer', scope: {} };

  const full = await call('/tools/periodic-report/runs/M-2026-10', { user: admin });
  assert.equal(full.status, 200); assert.equal(full.body.run.items.length, 5);
  const sc = await call('/tools/periodic-report/runs/M-2026-10', { user: scopedUser });
  assert.equal(sc.status, 200);
  assert.deepEqual(sc.body.run.items.map((i) => i.key), ['ds-usage', 'veeam', 'vm-count'], '범위 계정은 자기 법인 행이 있는 항목만(포탈 자체 · 법인 미지정 행 숨김)');
  assert.equal(sc.body.run.items.find((i) => i.key === 'ds-usage').status, 'ok', '보이는 행으로 다시 합친다');
  assert.deepEqual(sc.body.deliveries, [], '범위 계정에는 전달 기록을 주지 않는다');
  const other = await call('/tools/periodic-report/runs/M-2026-10', { user: { ...scopedUser, scope: { vcenters: ['zz'] } } });
  assert.equal(other.status, 404, '보이는 행이 하나도 없으면 존재를 숨긴다');
  const list = await call('/tools/periodic-report/runs', { user: scopedUser });
  assert.equal(list.status, 200);
  const row = list.body.runs.find((r) => r.id === 'M-2026-10');
  assert.ok(row && row.scoped === true, '범위 계정 목록은 자기 범위로 다시 센다');
  assert.equal((await call('/tools/periodic-report/settings', { user: scopedUser })).status, 403, '설정 조회는 전체 범위만');
  assert.equal((await call('/tools/periodic-report/settings', { user: viewer })).status, 200);
  // 역할 게이트(requireRole admin)는 인증을 끈 시험 구성에서는 익명 역할로 판정한다 — 역할 거부는 라우터 태그로 확인한다(아래).
  assert.equal((await call('/tools/periodic-report/settings', { user: { ...admin, scope: { vcenters: ['b'] } }, method: 'PUT', body: { mail: { enabled: false } } })).status, 403, '범위 관리자는 저장 불가');
  const bad = await call('/tools/periodic-report/settings', { user: admin, method: 'PUT', body: { kinds: { daily: { time: '99:99' } } } });
  assert.equal(bad.status, 400); assert.equal(bad.body.field, 'kinds.daily.time');
  const okPut = await call('/tools/periodic-report/settings', { user: admin, method: 'PUT', body: { chat: { enabled: false } } });
  assert.equal(okPut.status, 200);
  assert.equal((await call('/tools/periodic-report/run', { user: { ...admin, scope: { writeVcenters: ['b'] } }, method: 'POST', body: { kind: 'daily' } })).status, 403, '쓰기 범위를 줄인 관리자는 만들기 불가(fullRwOnly)');
  assert.equal((await call('/tools/periodic-report/run', { user: admin, method: 'POST', body: { kind: 'yearly' } })).status, 400);
  const html = await call('/tools/periodic-report/runs/M-2026-10/report.html', { user: admin });
  assert.equal(html.status, 200); assert.match(html.text, /<!doctype html>/i);
  assert.equal((await call('/tools/periodic-report/runs/..%2Fetc', { user: admin })).status, 400);
  // 상태를 바꾸는 라우트는 전부 admin 역할 게이트 + 전체 범위(조회 · 쓰기) 게이트를 단다(라우터 스택의 게이트 태그로 확인).
  const routes = api.stack.filter((l) => l.route && String(l.route.path).startsWith('/tools/periodic-report'));
  for (const l of routes) {
    const methods = Object.keys(l.route.methods);
    if (methods.some((m) => m !== 'get')) {
      const gates = l.route.stack.map((x) => x.handle?.gate?.kind || (x.handle?.name === 'roleGate' ? 'role' : x.name));
      assert.ok(gates.includes('fullScope'), `${l.route.path}: 전체 범위 게이트 없음`);
      assert.ok(l.route.stack.some((x) => x.handle?.name === 'roleGate' || x.name === 'roleGate' || x.handle?.gate?.kind === 'role'), `${l.route.path}: admin 역할 게이트 없음`);
    }
  }
  const nonAdminSet = await call('/tools/periodic-report/settings', { user: viewer });
  assert.equal(nonAdminSet.body.settings.mail.toHidden, true, '비관리자에게 받는 사람 주소를 주지 않는다');
});

test('⑬ 전달 — 이슈 자동 등록은 같은 항목 · 법인을 한 번만 · 공지는 하나를 갱신 · 데모 데이터는 보내지 않는다', async () => {
  const svc = await import('../src/periodic/service.js');
  const issues = await import('../src/issues/store.js');
  const bulletin = await import('../src/bulletin/store.js');
  const s = R.settingsOf({ mail: { enabled: false }, chat: { enabled: false }, notice: { enabled: true, kinds: ['monthly'] }, issues: { enabled: true, dailyMax: 10 } });
  const doc = { ...DOC, id: 'M-2026-09', kind: 'monthly', periodLabel: '2026년 9월', counts: R.countsOf(DOC.items), overall: R.overallOf(DOC.items), corpsTotal: 2, corpsReported: 1, generatedAt: Date.now() };
  const r1 = await svc.deliverRun(doc, s, { manual: false });
  const iss = r1.find((x) => x.channel === 'issues');
  assert.equal(iss.state, 'sent', JSON.stringify(iss));
  const made = issues.findByOrigin((o) => o?.kind === 'alert' && String(o.alertKey).startsWith('periodic:'), { openOnly: true });
  assert.equal(made.length, 2, '이상 행 둘(ds-usage · a / part-faults · 미지정) — 각각 한 건');
  const r2 = await svc.deliverRun({ ...doc, id: 'M-2026-08' }, s, { manual: false });
  assert.match(r2.find((x) => x.channel === 'issues').reason, /이미 있음 2/, '열린 같은 이슈가 있으면 다시 만들지 않는다');
  assert.equal(issues.findByOrigin((o) => o?.kind === 'alert' && String(o.alertKey).startsWith('periodic:'), { openOnly: true }).length, 2);
  const notices = (bulletin.listNotices?.({ all: true }) || bulletin.listNotices?.() || []);
  const mine = (Array.isArray(notices) ? notices : notices.items || []).filter((n) => n.createdBy === 'periodic-report');
  assert.equal(mine.length, 1, '공지는 회차마다 새로 올리지 않고 하나를 갱신한다');
  assert.ok(!/이상|주의|확인 불가/.test(`${mine[0].title}${mine[0].body}`));
  const r3 = await svc.deliverRun({ ...doc, id: 'M-2026-07', mock: true }, s, { manual: false });
  assert.equal(r3.length, 0, '데모 데이터뿐이면 보내지 않는다');
});

test('⑭ 상태 — 범위 계정에는 전 법인 종합 · 판정 수 · 기록을 싣지 않는다', async () => {
  const sc = await call('/tools/periodic-report/status', { user: { username: 'kr', role: 'operator', scope: { vcenters: ['b'] } } });
  assert.equal(sc.status, 200);
  assert.equal(sc.body.scoped, true);
  for (const k of R.KINDS) { const l = sc.body.kinds[k].last; if (l) { assert.equal(l.overall, undefined); assert.equal(l.counts, undefined); } }
  assert.deepEqual(sc.body.history, []);
  const full = await call('/tools/periodic-report/status');
  assert.equal(full.body.scoped, false);
  assert.ok(full.body.kinds.monthly.last == null || full.body.kinds.monthly.last.overall, '전체 범위는 종합을 본다');
});
