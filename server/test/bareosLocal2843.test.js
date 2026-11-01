/**
 * test/bareosLocal2843.test.js — v2.843 '백업은 법인 로컬, 통합 로그는 중앙'(사용자 원칙 2026-11-01 '기억해줘') 반영분.
 *  ① ops.prunePreview: pruneJobs 와 같은 입력·같은 판정으로 개수만 · delete 를 보내지 않는다 · 상태 변경 작업 아님(MUTATING 밖) · 엣지 회신 시한
 *  ② 엣지 회신 정제: 아는 칸만 · 음수·문자열 버림 · 성공인데 개수가 없으면 실패(모름 — 0 으로 보지 않는다)
 *  ③ 설정 응답 vcenters[].siteAgent — 그 vCenter 인벤토리를 올리는 엣지(listInventory) · 모르면 ''
 *  ④ 웹 판정: directorAgentAdvice(중앙 직접 + 법인 엣지 있음 → 권함 · 어긋남 · 여럿) · prunePreviewText · Bareos 하위 탭 줄바꿈
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2843-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const { OPS, MUTATING } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult, VALUE } = await import('../src/bareos/edgeResult.js');
const { RESULT_MS } = await import('../src/bareos/edgeOps.js');
const W = await import('../../web/src/views/tools/bareosText.js');
const G = await import('../../web/src/views/tools/bareosGroupText.js');

const R = (jobid, level, status = 'T', name = 'pv-a') => ({ jobid, name, type: 'B', level, jobstatus: status, jobbytes: 5e9, starttime: `2026-10-${String(jobid % 28 + 1).padStart(2, '0')} 02:10:00` });
function fakeSession(hist, { dieOn = null } = {}) {
  const cmds = [];
  return {
    cmds,
    async call(cmd) {
      cmds.push(cmd);
      if (dieOn && cmd.includes(dieOn)) throw Object.assign(new Error('closed'), { code: 'closed' });
      const m = cmd.match(/^list jobs job=(\S+)/);
      if (m) return { jobs: (hist.get(m[1]) || []).map((r) => ({ ...r })) };
      const d = cmd.match(/^delete jobid=([\d,]+)$/);
      if (d) { const ids = new Set(d[1].split(',').map(Number)); for (const [k, v] of hist) hist.set(k, v.filter((r) => !ids.has(r.jobid))); return {}; }
      throw Object.assign(new Error(`unknown ${cmd}`), { code: 'jsonrpc' });
    },
  };
}

test('① prunePreview — pruneJobs 와 같은 수 · delete 0 · MUTATING 밖 · 엣지 회신 시한', async () => {
  const mk = () => new Map([['pv-a', [R(1, 'F'), R(2, 'I'), R(3, 'F'), R(4, 'I'), R(5, 'I')]], ['pv-b', [R(11, 'I', 'T', 'pv-b'), R(12, 'I', 'T', 'pv-b')]]]);
  const items = [{ key: 0, job: 'pv-a', keep: 2 }, { key: 1, job: 'pv-b', keep: 1 }, { key: 2, job: 'bad name', keep: 1 }];
  const sp = fakeSession(mk());
  const prev = await OPS.prunePreview(sp, { items });
  assert.equal(sp.cmds.filter((c) => c.startsWith('delete')).length, 0, '미리 보기는 delete 를 보내지 않는다');
  assert.ok(!sp.cmds.some((c) => c.includes('bad')), '틀린 이름은 Director 에 보내지 않는다');
  const sr = fakeSession(mk());
  const real = await OPS.pruneJobs(sr, { items });
  assert.equal(prev[0].would, real[0].deleted.length, '같은 입력이면 실제 정리와 같은 수');
  assert.equal(prev[0].would, 2);
  assert.equal(prev[1].would, 0); assert.match(prev[1].reason, /기준 Full/);
  assert.equal(prev[2].ok, false);
  // since 를 그대로 넘긴다(등록 전 행은 세지 않는다)
  const s5 = fakeSession(new Map([['pv-a', [R(1, 'F'), R(2, 'F'), R(3, 'F')]]]));
  const p5 = await OPS.prunePreview(s5, { items: [{ key: 0, job: 'pv-a', keep: 1, since: Date.parse('2026-10-03T00:00:00') }] });
  assert.equal(p5[0].would, 1, '등록(10-03) 전에 시작한 1 은 세지 않는다');
  // 세션째 끊기면 남은 것은 건너뜀
  const sd = fakeSession(mk(), { dieOn: 'pv-a' });
  const pd = await OPS.prunePreview(sd, { items });
  assert.equal(pd[0].ok, false); assert.equal(pd[1].code, 'skipped');
  assert.ok(!MUTATING.has('prunePreview'), '읽기 전용 — 상태 변경 작업이 아니다');
  assert.equal(RESULT_MS.prunePreview, RESULT_MS.pruneJobs, '같은 조회를 하므로 같은 회신 시한');
  assert.equal(typeof VALUE.prunePreview, 'function');
  const src = stripComments(fs.readFileSync(new URL('../src/bareos/ops.js', import.meta.url), 'utf8'));
  const body = /async prunePreview\(s[\s\S]*?\n {2}\},\n/.exec(src)?.[0] || '';
  assert.ok(body.length > 200);
  assert.doesNotMatch(body, /deleteJobIds|delete jobid/, '미리 보기 본문에 지우는 호출이 없다');
});

test('② 엣지 회신 정제 — 아는 칸만 · 음수·문자열 버림 · 성공인데 개수 없음은 실패', () => {
  const r = sanitizeEdgeResult('prunePreview', { ok: true, value: [
    { key: 0, ok: true, would: 3, kept: 4, good: 7, baseJobid: 10, baseAt: Date.parse('2026-10-01T00:00:00Z'), reason: '', extra: 'x' },
    { key: 1, ok: true, would: -1 }, { key: 2, ok: true }, { key: 3, ok: false, code: 'closed', message: 'm' }, { key: 'x', ok: true, would: 1 },
  ] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value[0], { key: 0, ok: true, would: 3, kept: 4, good: 7, baseJobid: 10, baseAt: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(r.value[1].ok, false, '음수 개수는 못 읽은 값');
  assert.equal(r.value[2].ok, false);
  assert.equal(r.value[3].code, 'closed');
  assert.equal(r.value[4].key, -1);
});

test('③ 설정 응답 — vcenters[].siteAgent(그 vCenter 인벤토리를 올리는 엣지) · 모르면 빈 값', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8'));
  assert.match(src, /listInventory\(\)\.map\(\(i\) => \[i\.vcenterId, i\.agent \|\| ''\]\)/);
  assert.match(src, /siteAgent: owners\.get\(v\.id\) \|\| ''/);
});

test('④ 웹 판정 — Director 담당 권함 · 미리 보기 문구 · 하위 탭 줄바꿈', () => {
  const vcs = [{ id: 'vc-a', siteAgent: 'edge-kr' }, { id: 'vc-b', siteAgent: 'edge-pl' }, { id: 'vc-c', siteAgent: '' }];
  assert.deepEqual(W.directorAgentAdvice({ agent: '', vcenterIds: ['vc-a'], vcenters: vcs }), { kind: 'suggest', edge: 'edge-kr' });
  assert.equal(W.directorAgentAdvice({ agent: 'edge-kr', vcenterIds: ['vc-a'], vcenters: vcs }), null, '이미 그 엣지면 말하지 않는다');
  assert.deepEqual(W.directorAgentAdvice({ agent: 'edge-pl', vcenterIds: ['vc-a'], vcenters: vcs }), { kind: 'mismatch', edge: 'edge-kr', agent: 'edge-pl' });
  assert.deepEqual(W.directorAgentAdvice({ agent: '', vcenterIds: ['vc-a', 'vc-b'], vcenters: vcs }), { kind: 'mixed', edges: ['edge-kr', 'edge-pl'] });
  assert.equal(W.directorAgentAdvice({ agent: '', vcenterIds: ['vc-c'], vcenters: vcs }), null, '엣지가 수집하지 않는 법인은 권하지 않는다(단정하지 않는다)');
  assert.equal(W.directorAgentAdvice({ agent: '', vcenterIds: [], vcenters: vcs }), null);
  for (const a of [{ kind: 'suggest', edge: 'e' }, { kind: 'mismatch', edge: 'e', agent: 'f' }, { kind: 'mixed', edges: ['e', 'f'] }]) {
    const t = W.directorAgentAdviceText(a);
    assert.ok(t.length > 20); assert.ok(!t.includes('`'));
  }
  assert.match(W.directorAgentAdviceText({ kind: 'suggest', edge: 'edge-kr' }), /법인 안에서 하는 것이 원칙/);
  let t = G.prunePreviewText({ keep: 2, jobs: 3, would: 5, vms: 2, noBase: 1, failed: 0, errors: [], rows: [] });
  assert.match(t.text, /\*\*지금 정리하면 VM 2대에서 실행 기록 5건을 카탈로그에서 지웁니다\*\*/);
  assert.match(t.text, /1대는 기준 Full/);
  assert.match(t.text, /아무것도 지우지 않은 미리 보기/);
  assert.equal(t.tone, 'warn');
  t = G.prunePreviewText({ keep: 7, jobs: 3, would: 0, vms: 0, noBase: 0, failed: 1, errors: [{ vmName: 'x', reason: 'r' }], rows: [] });
  assert.match(t.text, /지울 실행 기록이 없습니다\(확인한 잡 2개/);
  assert.match(t.text, /1대는 확인하지 못했습니다/);
  assert.equal(t.tone, 'bad');
  assert.match(G.prunePreviewText({ keep: 3, jobs: 0 }).text, /잡이 등록된 VM 이 없습니다/);
  assert.ok(!G.prunePreviewText({ keep: 3, jobs: 2, would: 1, vms: 1 }).text.includes('`'));
  const tabs = stripComments(fs.readFileSync(new URL('../../web/src/views/tools/BareosTabs.jsx', import.meta.url), 'utf8'));
  assert.match(tabs, /flexWrap: 'wrap'/, '400px 에서 줄바꿈(가려진 탭이 없게)');
  assert.doesNotMatch(tabs, /overflowX: 'auto'/);
});
