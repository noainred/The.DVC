// [7회차 변이 축] 가림 재료 기록 관리 화면 — 순수 판정(seenCapText) 경계와 SeenRecords 배선에서 살아남은 변이를 잡는 시험.
//   + 7회차 화면 수정(U1 · U2/F1 · U4 · U5 · U6)의 순수 함수 · 배선.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './rackView.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const CENSUS = strip(fs.readFileSync(path.join(here, 'RackMaskCensus.jsx'), 'utf8'));
const seen = CENSUS.slice(CENSUS.indexOf('function SeenRecords('));
const count = (s, sub) => s.split(sub).length - 1;

describe('seenCapText 경계', () => {
  it('[w05] 경고는 주소 · 태그 중 큰 쪽으로(태그만 상한에 가까워도)', () => {
    expect(V.seenCapText({ hosts: 1, tags: 190000, max: 200000 }).warn).toBe(true);
  });
  it('[w07] 태그 수를 못 읽었으면 null(‘—’)', () => {
    expect(V.seenCapText({ hosts: 1, tags: '2', max: 9 })).toBe(null);
    expect(V.seenCapText({ hosts: 1, max: 9 })).toBe(null);
  });
  it('[w08] 상한이 0 이면 경고하지 않는다', () => {
    expect(V.seenCapText({ hosts: 0, tags: 0, max: 0 }).warn).toBe(false);
  });
  it('[w10] 음수는 못 읽은 값', () => {
    expect(V.seenCapText({ hosts: -1, tags: 2, max: 9 })).toBe(null);
  });
});

describe('SeenRecords 배선', () => {
  it('[c01] 지우기 전에 확인을 받고, 취소하면 그 자리에서 멈춘다', () => {
    expect(seen).toMatch(/\n\s*if \(!window\.confirm\(`[^`]*`\)\) return;\n/);
  });
  it('[c02 · c03] 늦게 온 응답(오류 포함) · 닫힌 뒤의 응답은 버린다', () => {
    expect(seen).toContain('catch (e) { if (my === seq.current) setErr(e); }');
    expect(seen).toContain('finally { if (my === seq.current) setBusy(false); }');
    expect(seen).toContain('useEffect(() => () => { seq.current += 1; }, []);');
  });
  it('[c04 · c10] 지운 뒤 목록 · 집계를 다시 읽고(결과 문구는 남긴다), 실패하면 busy 를 푼다', () => {
    expect(seen).toContain('await load({ keepMsg: true }); onChanged?.();');
    expect(seen).toContain('} catch (e) { setErr(e); setBusy(false); }');
  });
  it('[c05] 고른 것이 없으면 지우기 버튼은 닫힌다', () => {
    expect(seen).toContain('disabled={busy || !items.length} onClick={forget}');
  });
  it('[c08] 기록 크기 안내는 seenCapText 로(못 읽으면 —)', () => {
    expect(seen).toContain('const cap = seenCapText(material);');
    expect(seen).toContain("{cap ? cap.text : '—'}");
  });
  it('[c11] 지운 수 문구는 서버가 돌려준 removed · 건너뛴 수는 skippedCurrent(순수 함수 forgetResultText)', () => {
    expect(seen).toContain('setMsg(forgetResultText(r));');
    expect(V.forgetResultText({ removed: 2, skippedCurrent: 0 })).toBe('2건을 지웠습니다.');
    expect(V.forgetResultText({ removed: 1, skippedCurrent: 1 })).toBe('1건을 지웠습니다 · 지금 등록부에 있는 1건은 건너뛰었습니다.');
    expect(V.forgetResultText({ removed: 0, skippedCurrent: 3 })).toBe('0건을 지웠습니다 · 지금 등록부에 있는 3건은 건너뛰었습니다.');
    expect(V.forgetResultText({})).toBe('지웠습니다(지운 수를 받지 못했습니다).');
    expect(V.forgetResultText({ removed: '2' })).toBe('지웠습니다(지운 수를 받지 못했습니다).');
  });
});

describe('7회차 화면 수정', () => {
  it('U2 · F1: 지운 뒤 다시 읽어도 결과 문구를 지우지 않는다 — load 는 keepMsg 일 때만 문구를 남긴다', () => {
    expect(seen).toContain("const load = useCallback(async ({ keepMsg = false } = {}) => {");
    expect(seen).toContain("setBusy(true); if (!keepMsg) setMsg('');");
    // 단추 onClick 은 이벤트를 load 에 넘기지 않는다(이벤트 객체가 keepMsg 자리에 들어가지 않게)
    expect(seen).toContain('disabled={busy} onClick={() => load()}>지금 등록부에 없는 기록 보기</button>');
    expect(count(seen, 'onClick={load}')).toBe(0);
  });
  it('U5: 목록 보기 단추의 글은 바쁠 때도 같다(폭이 줄지 않는다) · 진행은 상태 줄로', () => {
    expect(seen).not.toContain("busy && !list ? '불러오는 중…' : '지금 등록부에 없는 기록 보기'");
    expect(seen).toContain("{busy && !list ? <div role=\"status\" style={{ fontSize: 12, color: 'var(--text-dim)' }}>불러오는 중…</div> : null}");
  });
  it('U4: 머리 줄 · 목록 머리의 글은 기본 폭(220px)을 갖는다 — 좁은 화면에서 단추 옆에 세로로 늘어서지 않는다', () => {
    expect(count(seen, "flex: '1 1 220px', minWidth: 0, fontSize: 12")).toBe(2);
    expect(count(seen, 'flex: 1, minWidth: 0')).toBe(0);
  });
  it('U6: 미리 보기가 없을 때 관리자 문구는 지금 원장을 읽지 못한 것만 말하고, 확인 단계에서 미리 보기 없이 되돌린다고 밝힌다', () => {
    expect(V.restoreMissingText(true)).toMatch(/^지금 원장과 비교하지 못했습니다\(지금 원장을 판 꼴로 읽지 못했습니다\)/);
    expect(V.restoreMissingText(true)).not.toMatch(/되살릴 수 없습니다/);
    const a = V.restoreConfirmText('KR', 7, true); const b = V.restoreConfirmText('KR', 7, false);
    expect(a).toBe('KR 의 랙 실장도 전체가 판 #7 의 모습으로 바뀝니다. 지금 모습도 판으로 남아 다시 되돌릴 수 있습니다. 열려 있는 다른 편집 화면은 다음 저장에서 최신을 다시 불러옵니다.');
    expect(b.startsWith(a)).toBe(true);
    expect(b).toMatch(/⚠ 미리 보기 없이 되돌립니다/);
    const TOOL = strip(fs.readFileSync(path.join(here, 'RackTool.jsx'), 'utf8'));
    expect(TOOL).toContain('{restoreConfirmText(corpName, selVid, !!detail.restore)}');
  });
  it('U1: 랙 머리글의 줄 · 용도 글은 남는 폭만 쓴다(기본 폭 0) — 짧은 랙 이름을 줄임표로 밀어내지 않는다', () => {
    const TOOL = strip(fs.readFileSync(path.join(here, 'RackTool.jsx'), 'utf8'));
    const head = TOOL.slice(TOOL.indexOf('<strong title={rack.name}'), TOOL.indexOf('세로 PDU A'));
    expect(head).toContain("flex: '0 1 auto'");
    expect(head).toContain("flex: '1 1 0%', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis'");
    expect(head).not.toContain("marginLeft: 'auto'");
  });
});
