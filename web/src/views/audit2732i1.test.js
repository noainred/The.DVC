/**
 * v2.732 점검 2회차 그룹 i1 — 화면 실패 정직성(verify-B5 B5-01 · B5-03 · B5-04 · B5-05 · B5-06 · B5-08).
 *
 *  B5-01 svcmon 폴더 삭제 — postJson 은 409(하위 대상 있음)를 던지지 않고 본문 {error,count} 를 돌려준다. 반환값을 버려
 *        폴더가 그대로인데 안내가 없고 강제 삭제 확인은 도달할 수 없었다(재현).
 *  B5-03 변경 응답의 실패 본문(400 {ok:false} · 200 {ok:false})을 성공으로 처리하던 6화면(iDRAC 주기 1000 → '주기 1000시간으로
 *        저장됨' 재현).
 *  B5-04 트래픽 연속 모니터링 — 저장·실행·삭제·토글의 catch 가 비어 실패가 남지 않았다(저장 실패에도 창이 닫혀 비밀번호 소실).
 *  B5-05 VM 복제 잡 폼 — 조회 실패를 빈 목록으로 삼켜 '0대 중 · 일치 VM 없음' (재현).
 *  B5-06 서버 분석 › 파트 인벤토리 표 — minWidth 없음(400px 에서 395px 넘침 재현).
 *  B5-08 알람 무시 규칙 — 읽기 전·실패·재조회를 '0개 · 없습니다' 로 보였다.
 *
 * 순수 판정은 실제로 호출하고, 컴포넌트 안 핸들러 배선은 DOM 없이 부를 수 없어(웹 테스트 환경이 node) 주석을 지운 소스로 고정한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { changeFailText, requireChanged } from './changeResult.js';
import { intervalSaveText, IDRAC_SCAN_INTERVAL_MAX_H } from './idrac/IdracScanRanges.jsx';
import { bulkAssignDoneText } from './tools/FleetInventory.jsx';
import { clearHangsText } from './PerfMonitor.jsx';
import { canAddMonitor } from './NetTrafficAnalysis.jsx';
import { vmPickLabel, listFailText } from './tools/VmCloneTool.jsx';
import { muteListState } from './Alarms.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const src = (rel) => stripComments(raw(rel));

const thrownMessage = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

describe('B5-01 svcmon 폴더 삭제 — 409 본문을 성공으로 읽지 않고 강제 삭제 확인에 닿는다', () => {
  const store = () => { const mem = new Map(); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }; };
  let saved;
  beforeEach(() => {
    saved = { fetch: globalThis.fetch, ls: globalThis.localStorage, ss: globalThis.sessionStorage };
    globalThis.localStorage = store(); globalThis.sessionStorage = store();
  });
  afterEach(() => { globalThis.fetch = saved.fetch; globalThis.localStorage = saved.ls; globalThis.sessionStorage = saved.ss; vi.restoreAllMocks(); });

  it('실제 postJson 은 409 를 던지지 않는다(규약) · requireChanged 가 서버 사유로 던지고 그 문구가 강제 삭제 확인 정규식에 맞는다', async () => {
    const body = { error: '폴더에 대상 32개가 있습니다(먼저 이동/삭제하거나 강제 삭제).', count: 32 };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    const { postJson } = await import('../api.js');
    const r = await postJson('/svcmon/folders/delete', { kind: 'infra', path: 'a' });
    expect(r).toEqual(body); // api.js 규약 — 바꾸지 않았다
    const msg = thrownMessage(() => requireChanged(r));
    expect(msg).toBe(body.error);
    expect(/대상 \d+개/.test(msg)).toBe(true); // SvcMonitor.deleteFolderAt 의 catch 가 보는 정규식
    expect(changeFailText({ removedTargets: 0, folders: [] })).toBeNull(); // 성공 본문은 성공
  });

  it('SvcMonitor 의 폴더 삭제 호출(일반·강제)은 전부 requireChanged 를 거친다', () => {
    const s = src('SvcMonitor.jsx');
    const all = [...s.matchAll(/postJson\('\/svcmon\/folders\/delete'/g)].length;
    const wrapped = [...s.matchAll(/requireChanged\(await postJson\('\/svcmon\/folders\/delete'/g)].length;
    expect(all).toBe(2);
    expect(wrapped).toBe(all);
    // 확인 흐름은 catch 안에 그대로 있다(사유 문구로 판정)
    expect(s).toMatch(/if \(\/대상 \\d\+개\/\.test\(e\.message \|\| ''\) && window\.confirm\(/);
  });
});

describe('B5-03 iDRAC 스캔 주기 — 400 본문을 \'저장됨\' 으로 말하지 않는다', () => {
  it('서버가 거부하면(1000시간) 사유를 말하고 ok:false', () => {
    const r = intervalSaveText({ ok: false, reason: '주기는 0~720 시간이어야 합니다(0=주기 끔).' }, 1000);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('주기는 0~720 시간이어야 합니다');
    expect(r.text).not.toMatch(/저장됨/);
    expect(r.text).not.toMatch(/1000시간/);
  });
  it('성공은 적용된 값으로 말한다(하한 적용·끔)', () => {
    expect(intervalSaveText({ ok: true, intervalMs: 6 * 3600000 }, 6)).toEqual({ ok: true, text: '주기 6시간으로 저장됨' });
    expect(intervalSaveText({ ok: true, intervalMs: 0 }, 0)).toEqual({ ok: true, text: '주기 스캔을 껐습니다(수동만).' });
    expect(intervalSaveText({ ok: true, intervalMs: 600000 }, 0.1).text).toContain('(입력 0.1 → 하한/상한 적용)');
  });
  it('500(저장 실패 본문)도 실패 · 상한은 서버와 같은 720 이고 화면이 먼저 막는다', () => {
    expect(intervalSaveText({ ok: false, reason: '저장 실패: EIO' }, 6).ok).toBe(false);
    expect(IDRAC_SCAN_INTERVAL_MAX_H).toBe(720);
    const s = src('idrac/IdracScanRanges.jsx');
    expect(s).toMatch(/hours > IDRAC_SCAN_INTERVAL_MAX_H\)/);
    expect(s).toMatch(/const res = intervalSaveText\(await putJson\('\/admin\/idrac\/scan-ranges\/interval'/);
    expect(s).toMatch(/if \(!res\.ok\) return;/);
  });
});

describe('B5-03 통합 서버 인벤토리 일괄 등록 · hang 로그 비우기 — 실패 본문을 성공 문구로 만들지 않는다', () => {
  it('일괄 등록: 실패 본문은 사유로 던지고, 성공은 숫자로 · 숫자가 없으면 undefined 를 찍지 않는다', () => {
    expect(thrownMessage(() => bulkAssignDoneText({ ok: false, reason: '존재하지 않는 vCenter id: vc-x' }))).toBe('존재하지 않는 vCenter id: vc-x');
    expect(bulkAssignDoneText({ ok: true, assigned: 3, total: 5 })).toBe('3/5대 일괄 등록 완료');
    const t = bulkAssignDoneText({ ok: true });
    expect(t).not.toMatch(/undefined|NaN/);
  });
  it('hang 로그 비우기: 200 {ok:false} 는 실패 · deferred 는 말한다', () => {
    expect(thrownMessage(() => clearHangsText({ ok: false, reason: 'EBUSY: resource busy' }))).toBe('EBUSY: resource busy');
    expect(clearHangsText({ ok: true })).toMatch(/^hang 로그 파일을 비웠습니다\(/);
    expect(clearHangsText({ ok: true, deferred: true })).toContain('한 번 더 지웁니다');
  });
});

describe('B5-03 · B5-04 · B5-05 · B5-08 배정 파일의 변경 호출은 전부 판정을 거친다(소스 — 주석 제거 후)', () => {
  // 판정 모양: requireChanged(await X( · 이 그룹이 만든 판정 헬퍼(await X( · NetTrafficAnalysis 의 act(() => X(
  const JUDGED = /(requireChanged|intervalSaveText|bulkAssignDoneText|clearHangsText)\(\s*await\s+(putJson|patchJson|delJson)\(|act\(\(\) => (putJson|patchJson|delJson)\(/g;
  const FILES = {
    'idrac/IdracScanRanges.jsx': 1, 'svcmon/BulkTab.jsx': 1, 'tools/FleetInventory.jsx': 3, 'SanSwitchPerf.jsx': 1,
    'PerfMonitor.jsx': 2, 'StorageIntervals.jsx': 1, 'NetTrafficAnalysis.jsx': 3, 'tools/VmCloneTool.jsx': 1, 'Alarms.jsx': 1,
  };
  for (const [f, n] of Object.entries(FILES)) {
    it(f, () => {
      const s = src(f);
      const calls = [...s.matchAll(/\b(putJson|patchJson|delJson)\(/g)].length;
      const judged = [...s.matchAll(JUDGED)].length;
      expect(calls, `${f}: 변경 호출 수`).toBe(n);
      expect(judged, `${f}: 변경 호출 ${calls}곳 중 ${judged}곳만 판정한다`).toBe(calls);
    });
  }
  it('audit2727e 와 같은 검출기로 보면 이 파일들의 \'반환값을 버린 호출\' 은 0 이다(허용 목록에서 뺄 수 있다)', () => {
    const USED_TAIL = /(=|return|\?|:|\(|\|\||&&|,|\[|\?\?|=>\s*\{?)\s*$/;
    for (const f of Object.keys(FILES)) {
      const lines = src(f).split('\n'); let n = 0;
      for (let i = 0; i < lines.length; i++) {
        const re = /\bawait\s+(delJson|putJson|patchJson|sendJson)\s*\(/g; let m;
        while ((m = re.exec(lines[i]))) {
          let before = lines[i].slice(0, m.index).trimEnd();
          let j = i; while (!before && j > 0) { j -= 1; before = lines[j].trimEnd(); }
          if (!USED_TAIL.test(before)) n += 1;
        }
      }
      expect(n, f).toBe(0);
    }
  });
  it('StorageIntervals·SanSwitchPerf 는 판정한 뒤에만 폼을 바꾼다(실패 본문으로 폼을 덮지 않는다)', () => {
    expect(src('StorageIntervals.jsx')).toMatch(/const r = requireChanged\(await putJson\('\/tools\/storage\/intervals'/);
    expect(src('SanSwitchPerf.jsx')).toMatch(/const r = requireChanged\(await putJson\('\/tools\/sanswitch\/perf\/settings', form\)\); setData\(r\); setForm\(r\.settings\)/);
  });
});

describe('B5-04 트래픽 연속 모니터링 — 실패를 삼키지 않는다', () => {
  it('목록이 403 이면 \'+ 모니터 추가\' 를 숨긴다(저장도 같은 403) · 다른 실패는 숨기지 않는다', () => {
    expect(canAddMonitor({ status: 403 })).toBe(false);
    expect(canAddMonitor({ status: 503 })).toBe(true);
    expect(canAddMonitor(new Error('timeout'))).toBe(true);
    expect(canAddMonitor(null)).toBe(true);
  });
  it('빈 catch 0 · 저장은 성공일 때만 창을 닫는다 · 실패는 창 안(formErr)·표 위(actErr)에 말한다', () => {
    const r = raw('NetTrafficAnalysis.jsx');
    expect(r).not.toMatch(/catch \(e\) \{ \/\* \*\/ \}/);
    expect(r).not.toMatch(/catch \{ \/\* \*\/ \}/);
    const s = src('NetTrafficAnalysis.jsx');
    expect(s).toMatch(/try \{ requireChanged\(await putJson\('\/admin\/net\/monitors', form\)\); setForm\(null\);/);
    expect(s).toMatch(/catch \(e\) \{ setFormErr\(e\); \}/);
    expect(s).toMatch(/\{formErr && <ErrorBox error=\{formErr\} \/>\}/);
    expect(s).toMatch(/\{actErr && <ErrorBox error=\{actErr\} \/>\}/);
    expect(s).toMatch(/\{canAddMonitor\(loadErr\) && <button/);
    // v2.621 계약 그대로(403 이면 30초 폴링을 멈춘다)
    expect(s).toMatch(/if \(denied\.current\) return; fetchJson\('\/admin\/net\/monitors'\)/);
  });
});

describe('B5-05 VM 복제 잡 폼 — 조회 실패를 \'0대\' 로 보이지 않는다', () => {
  it('실패·로딩은 개수를 말하지 않는다', () => {
    expect(vmPickLabel({ state: 'error', count: 0 })).toBe('VM 검색·선택 — VM 목록을 읽지 못했습니다');
    expect(vmPickLabel({ state: 'error', count: 0 })).not.toMatch(/0대/);
    expect(vmPickLabel({ state: 'loading', count: 0 })).not.toMatch(/0대/);
    expect(vmPickLabel({ state: 'ok', count: 12, total: 12 })).toBe('VM 검색·선택 (12대 중)');
    expect(vmPickLabel({ state: 'ok', count: 0, total: 0 })).toBe('VM 검색·선택 (0대 중)'); // 실제로 0대면 0
    expect(vmPickLabel({ state: 'ok', count: 5000, total: 6100 })).toContain('전체 6100대 중 앞 5000대');
  });
  it('실패 문구는 사유를 싣고 \'비어 있다는 뜻이 아니다\' 를 말한다', () => {
    const t = listFailText('VM', new Error('/vms -> 503'));
    expect(t).toContain('/vms -> 503');
    expect(t).toContain('비어 있다는 뜻이 아닙니다');
    expect(listFailText('VM', null)).toContain('사유 미상');
  });
  it('폼의 세 조회가 실패를 빈 목록·무음으로 삼키지 않는다 · 다시 시도가 있다', () => {
    const s = src('tools/VmCloneTool.jsx');
    const form = s.slice(s.indexOf('function JobForm'));
    expect(form).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(form).not.toMatch(/catch\(\(\) => \{ if \(gen === loadGen\.current\) set(Vms|Dss)\(\[\]\)/);
    expect(form).toMatch(/\.catch\(\(e\) => setVcErr\(e\)\)/);
    expect(form).toMatch(/setVmList\(\{ state: 'error'/);
    expect(form).toMatch(/setDsErr\(e\)/);
    expect(form).toMatch(/>다시 시도<\/button>/);
    expect(form).toMatch(/\{ql && !sel && vmList\.state === 'ok' && \(/); // 못 읽었으면 '일치 VM 없음' 을 그리지 않는다
  });
  it('서버 분석: vCenter 목록을 두 경로 다 못 읽으면 2차 박스가 그 사실을 말한다', () => {
    const s = src('tools/HardwareTools.jsx');
    const line = s.split('\n').find((l) => l.includes("fetchJson('/vcenters')") && l.includes("'/admin/vcenters'"));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/\.catch\(\(\) => \{\}\)\)/);
    expect(line).toMatch(/\.catch\(\(e\) => setVcErr\(e\)\)/);
    expect(s).toMatch(/vcErr \? '전체 \(vCenter 목록을 읽지 못함\)'/);
  });
});

describe('B5-06 서버 분석 › 파트 인벤토리 표 — minWidth(가로 스크롤 래퍼를 STable 이 만든다)', () => {
  it('파트(모델) 머리를 가진 STable 에 minWidth 가 있다', () => {
    const s = src('tools/HardwareTools.jsx');
    const at = s.indexOf("th('label', '파트(모델)')");
    expect(at).toBeGreaterThan(0);
    const open = s.lastIndexOf('<STable', at);
    const tag = s.slice(open, s.indexOf('>', open) + 1);
    expect(tag).toMatch(/minWidth=\{\d+\}/);
  });
});

describe('B5-08 알람 무시 규칙 — 모르는 것을 \'0개 · 없습니다\' 로 말하지 않는다', () => {
  it('읽기 전·실패·성공·갱신 실패', () => {
    const loading = muteListState(null, null);
    expect(loading.kind).toBe('loading');
    expect(loading.label).not.toMatch(/0개/);
    const err = muteListState(null, new Error('timeout'));
    expect(err.kind).toBe('error');
    expect(err.label).not.toMatch(/0개/);
    expect(err.mutes).toEqual([]);
    const ok0 = muteListState({ mutes: [] }, null);
    expect(ok0).toMatchObject({ kind: 'ok', stale: false, label: '🔕 무시 규칙 0개' }); // 실제로 0개면 0
    const stale = muteListState({ mutes: [{ id: 'a' }] }, new Error('503'));
    expect(stale).toMatchObject({ kind: 'ok', stale: true });
    expect(stale.label).toContain('1개');
    expect(stale.label).toContain('갱신 실패');
    expect(muteListState({ nope: true }, null).kind).toBe('loading'); // 모양이 다른 응답을 '0개' 로 읽지 않는다
  });
  it('재조회가 목록을 비우지 않는다(usePolling 파라미터 변경 금지) · 등록·해제 뒤 다시 읽는다 · 판정을 거친다', () => {
    const s = src('Alarms.jsx');
    expect(s).not.toMatch(/usePolling\('\/alarm-mutes'/);
    expect(s).not.toMatch(/muteData\?\.mutes \|\| \[\]/);
    expect(s).toMatch(/const ml = muteListState\(muteData, muteLoadErr\);/);
    expect(s).toMatch(/requireChanged\(await postJson\('\/alarm-mutes'[^\n]*\n\s*setMuteFor\(null\);\n\s*loadMutes\(\);/);
    expect(s).toMatch(/requireChanged\(await delJson\(`\/alarm-mutes\/\$\{encodeURIComponent\(m\.id\)\}`\)\); loadMutes\(\);/);
    expect(s).toMatch(/ml\.kind === 'loading' \? <div className="muted" style=\{\{ padding: 12 \}\}>불러오는 중…<\/div>/);
  });
});

describe('문구 위생 — 이 그룹이 만든 화면 문구에 백틱·별표가 새지 않는다', () => {
  it('순수 헬퍼 출력', () => {
    const texts = [
      intervalSaveText({ ok: false, reason: 'x' }, 1).text, intervalSaveText({ ok: true, intervalMs: 3600000 }, 1).text,
      bulkAssignDoneText({ ok: true, assigned: 1, total: 1 }), bulkAssignDoneText({ ok: true }),
      clearHangsText({ ok: true, deferred: true }), vmPickLabel({ state: 'error' }), vmPickLabel({ state: 'ok', count: 1, total: 2 }),
      listFailText('VM', new Error('e')), muteListState(null, null).label, muteListState(null, new Error('e')).label,
      muteListState({ mutes: [] }, new Error('e')).label,
    ];
    for (const t of texts) expect(t).not.toMatch(/`|\*\*|undefined|NaN/);
  });
});
