/**
 * 디스크 배드 섹터 — 개선 · 버그 수정 반복 5회차(반증 1인 — R5-3 ~ R5-5 · 개선 I-b · I-c · 변이 N3 · N11 ~ N13).
 * (R5-1 · R5-2 · I-a 는 4회차의 결함이라 4회차에서 고쳤다 — diskBadLoopR4.)
 * 고정하는 것: 저장 못 한 수 셈(N3) · 중단한 조각의 엣지 재시작은 '중단됨'(I-c) · 저장 실패 답에 저장된 서버(I-b) ·
 *   엣지 화면(점검 칸 조기 반환 · 서버 창 점검 버튼 · 장비 진단 안내 — N11 · N12 · R5-3) · 설정 저장 문구의 자리와 수명(N13 · R5-5) · 디스크 목록 '—'(R5-4).
 *   웹 JSX 는 이 저장소에 화면 렌더 시험 도구가 없어 소스 계약으로 고정한다(반증 권고).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadloopr5-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, '..', 'web', 'src');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const web = (p) => stripComments(fs.readFileSync(path.join(WEB, p), 'utf8'));

const J = await import('../src/diskbad/jobs.js');
after(() => { try { J._resetJobsForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

test('N3 — 저장 못 한 수: 이 묶음에서 저장된 서버는 빼고 · 같은 서버는 한 번만', () => {
  const u = {};
  assert.equal(J.noteUnsaved(u, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a']), 2);
  assert.equal(J.noteUnsaved(u, [{ id: 'b' }, { id: 'c' }], []), 2, '503 재전송 — 같은 서버를 두 번 세지 않는다');
  assert.equal(J.noteUnsaved(u, [{ id: 'd' }], null), 3);
});

test('I-c — 보고한 조각을 사용자가 중단한 뒤 엣지가 재시작해 다시 가지러 오면 \'중단됨\' 으로 닫는다', async () => {
  J._resetJobsForTest();
  const job = J.createJob({ scope: 'all', units: [{ agent: 'edge-c', kind: 'edge', serverIds: null }] });
  assert.equal(J.claimForAgent('edge-c')?.id, job.id);
  await J.acceptPush('edge-c', { jobId: job.id, servers: [], final: false });   // 진행 보고 한 번
  J.stopJob(job.id);
  assert.equal(J.claimForAgent('edge-c'), null);
  const u = J.getJob(job.id).units[0];
  assert.equal(u.state, 'stopped');
  assert.equal(u.error, '', '재시작 문구를 붙이지 않는다');
});

test('I-b — 저장 실패 답에 저장된 서버를 싣고, 엣지는 그것을 저장 콜백으로 넘긴다(소스 계약)', () => {
  assert.match(code('diskbad/jobs.js'), /if \(!r\.ok\) return \{ ok: false, stored: false, reason: r\.reason \|\| 'DB 저장 실패', storedIds: \(r\.storedIds \|\| \[\]\)\.map\(String\)\.slice\(0, 500\) \};/);
  const edge = code('diskbad/edge.js');
  assert.match(edge, /storedIds: Array\.isArray\(ack\?\.storedIds\) \? ack\.storedIds\.slice\(0, 500\)\.map\(\(x\) => String\(x\)\.slice\(0, 128\)\) : null/);
  assert.match(edge, /return Array\.isArray\(e\?\.storedIds\) \? \{ stored: false, storedIds: e\.storedIds \} : false;/);
});

test('N11 · N12 · R5-3 — 엣지 포탈 화면: 점검 칸은 안내만 · 서버 창은 점검 버튼 · 장비 진단 안내를 숨김', () => {
  const tool = web('views/tools/DiskBadTool.jsx');
  // 점검 칸의 엣지 조기 반환은 모든 훅 뒤 · 기본 반환 앞에 있다.
  const i = tool.indexOf("if (data.node?.role === 'edge') return (");
  assert.ok(i > 0, '점검 칸 엣지 조기 반환');
  const scanFn = tool.slice(tool.indexOf('function ScanPanel('), i);
  assert.equal(/useState\(|useEffect\(|useMemo\(|useRef\(/.test(tool.slice(i, tool.indexOf('function ', i + 10))), false, '조기 반환 뒤에 훅이 없다');
  assert.ok(/useState\(/.test(scanFn));
  const panel = web('views/tools/DiskBadServerPanel.jsx');
  assert.match(panel, /const edgeNode = data\.node === 'edge';/);
  assert.match(panel, /\{!edgeNode && <div style=\{\{ display: 'flex', gap: 6, flexWrap: 'wrap' \}\}>\s*<button className="login-btn"[^>]*onClick=\{\(\) => scan\('incremental'\)\}/);
  assert.match(panel, /\{data\.canProbe && !data\.probe && !edgeNode && \(/);
});

test('N13 · R5-5 — 설정 저장 문구는 설정 칸의 \'담당자 저장\' 아래에, 상태는 부모가 들어 점검 칸을 다시 만들어도 남는다', () => {
  const tool = web('views/tools/DiskBadTool.jsx');
  assert.match(tool, /담당자 저장<\/button><\/div>\s*\{settingsMsg\?\.text && <div/);
  assert.match(tool, /const \[settingsMsg, setSettingsMsg\] = useState\(\{ text: '', bad: false \}\);/);
  assert.match(tool, /<ScanPanel key=\{unreadKind\(unreadMarkOf\(data\)\) \|\| 'ok'\}[^>]*settingsMsg=\{settingsMsg\} setSettingsMsg=\{setSettingsMsg\} \/>/);
  const scanFn = tool.slice(tool.indexOf('function ScanPanel('));
  assert.equal(/useState\([^)]*\)[^;]*settingsMsg|\[settingsMsg,/.test(scanFn), false, '점검 칸 안에 따로 두지 않는다');
});

test('R5-4 — 읽은 서버가 없으면 디스크 목록 탭도 \'—\'', () => {
  const tool = web('views/tools/DiskBadTool.jsx');
  assert.match(tool, /<Disks [^>]*noneRead=\{noneRead\} \/>/);
  assert.match(tool, /const count = \(k\) => \(noneRead \? '—' :/);
});

// ── 6회차 반증(R6-2 · R6-3) ─────────────────────────────────────────────────────────────
test('R6-3 — 413 으로 나눈 뒤 뒤쪽 반이 실패하면, 저장된 앞쪽 반을 오류의 storedIds 에 싣는다', async () => {
  const E = await import('../src/diskbad/edge.js');
  const batch = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => ({ id }));
  const send = async (b) => {
    if (b.length > 4) throw Object.assign(new Error('413'), { status: 413 });
    if (b[0].id === 's1') return { ok: true, stored: true, newRecords: 0 };
    throw Object.assign(new Error('503'), { status: 503, storedIds: [] });
  };
  await assert.rejects(E._postSplitWithForTest(send, batch, { final: true }), (e) => {
    assert.equal(e.status, 503);
    assert.deepEqual(e.storedIds, ['s1', 's2', 's3', 's4']);
    return true;
  });
  // 앞쪽 반이 실패하면 그대로 던진다(뒤쪽 반은 보내지 않는다 — 전부 저장 못 함).
  const sendA = async (b) => { if (b.length > 4) throw Object.assign(new Error('413'), { status: 413 }); throw Object.assign(new Error('503'), { status: 503, storedIds: null }); };
  await assert.rejects(E._postSplitWithForTest(sendA, batch, { final: true }), (e) => e.storedIds === null);
  // 7회차 Q3: 앞쪽 반이 '보관하지 않음'(닫힌 작업 — stored:false) 이면 저장으로 세지 않는다.
  const sendC = async (b) => {
    if (b.length > 4) throw Object.assign(new Error('413'), { status: 413 });
    if (b[0].id === 's1') return { ok: true, stored: false, stop: true };
    throw Object.assign(new Error('503'), { status: 503, storedIds: ['s6'] });
  };
  await assert.rejects(E._postSplitWithForTest(sendC, batch, { final: true }), (e) => { assert.deepEqual(e.storedIds, ['s6']); return true; });
});

test('R6-2 — 설정 파일 읽기 오류 동안은 체크박스도 잠근다(잠긴 저장 문구가 풀린 뒤에도 남지 않게)', () => {
  const tool = web('views/tools/DiskBadTool.jsx');
  assert.match(tool, /checked=\{st\.autoEnabled\} disabled=\{!editable \|\| saveLocked\}/);
  assert.match(tool, /checked=\{st\.mailEnabled\} disabled=\{!editable \|\| saveLocked\}/);
});
