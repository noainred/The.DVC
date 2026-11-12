/**
 * focusMonProc.test.js — v2.981 서버 집중 모니터링 '프로세스 세부 정보'(사용자 요청 2026-11-12 · 시안 ⑩ 컨펌 '구현해줘').
 *  · procDescOf: 정확한 이름 · 규칙(오라클 · 커널 스레드 — 원격이 '/' 를 '_' 로 바꾼 이름) · 모르면 null
 *  · 안내 글: 상위 30 에 든 시간 · 읽기/쓰기를 못 읽은 까닭 · 지연 집계 · 네트워크(프로세스 몫 아님) — 백틱 없음
 *  · 단위 글: MB/s · MB/GB · 값 없음은 —
 *  · 화면 소스: 줄을 누르면 그 줄 아래(Fragment) · 서버 이름 단추는 펼침과 겹치지 않음 · 세부 요청은 지금 구간만 5초 폴링 · 404 는 오류 상자가 아니라 안내
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  procDescOf, PROC_STATE_TEXT, procKey, procCoverText, procIoNote, procWaitNote, procThreadNote, PROC_NET_NOTE, PROC_ARGS_NOTE, mbsText, mbText,
} from './focusMonText.js';

describe('procDescOf — 이름으로 본 설명', () => {
  it('정확한 이름 · 규칙 · 원격이 바꾼 이름(kworker/3:1 → kworker_3:1)', () => {
    expect(procDescOf('java')).toMatch(/Java/);
    expect(procDescOf('postgres')).toMatch(/PostgreSQL/);
    expect(procDescOf('ora_dbw0_ORCL')).toMatch(/Oracle/);
    expect(procDescOf('python3')).toMatch(/Python/);
    expect(procDescOf('python3.11')).toMatch(/Python/);
    expect(procDescOf('kworker_3:1')).toMatch(/커널/);
    expect(procDescOf('kworker/3:1')).toMatch(/커널/);
    expect(procDescOf('jbd2_sda1-8')).toMatch(/ext4/);
    expect(procDescOf('awk')).toMatch(/이 포탈의 수집도/);
  });
  it('모르면 null · 프로토타입 이름에 속지 않는다', () => {
    expect(procDescOf('my-custom-app')).toBe(null);
    expect(procDescOf('')).toBe(null);
    expect(procDescOf('constructor')).toBe(null);
    expect(procDescOf('__proto__')).toBe(null);
    expect(procDescOf('toString')).toBe(null);
  });
});

describe('안내 · 단위 글', () => {
  it('상위 30 에 든 시간 — 100% · 일부 · 모름', () => {
    expect(procCoverText({ inTopMs: 600_000, totalMs: 600_000 })).toMatch(/내내/);
    expect(procCoverText({ inTopMs: 300_000, totalMs: 600_000 })).toMatch(/50% 동안 .* 0 이 아닙니다/);
    expect(procCoverText(null)).toBe('');
    expect(procCoverText({ inTopMs: 1, totalMs: 0 })).toBe('');
  });
  it('읽기/쓰기 못 읽음 · 지연 집계 · 네트워크 · 인자 안내', () => {
    expect(procIoNote({ rb: null, wb: null })).toMatch(/그 프로세스의 계정이나 root 만/);
    expect(procIoNote({ rb: 0, wb: null })).toBe('');
    expect(procWaitNote(true)).toBe('');
    expect(procWaitNote(false)).toMatch(/꺼져 있어/);
    expect(procWaitNote(null)).toMatch(/모릅니다/);
    expect(PROC_NET_NOTE).toMatch(/이 프로세스의 몫이 아닌 참고/);
    expect(PROC_ARGS_NOTE).toMatch(/수집하지 않습니다/);
    for (const t of [procIoNote({}), procWaitNote(false), procWaitNote(null), PROC_NET_NOTE, PROC_ARGS_NOTE, procCoverText({ inTopMs: 1, totalMs: 2 })]) expect(t).not.toMatch(/`/);
  });
  it('단위 — 값이 없으면 단위를 붙이지 않는다', () => {
    expect(mbsText(null)).toBe('—'); expect(mbsText('')).toBe('—'); expect(mbsText(0)).toBe('0.00 MB/s');
    expect(mbsText(2.5)).toBe('2.50 MB/s'); expect(mbsText(42.31)).toBe('42.3 MB/s'); expect(mbsText(512)).toBe('512 MB/s');
    expect(mbText(null)).toBe('—'); expect(mbText(512)).toBe('512 MB'); expect(mbText(2048)).toBe('2.0 GB');
  });
  it('반증 F3 — 스레드가 여럿이면 상태 · 디스크 대기가 주 스레드 값이라고 밝힌다 · 하나면 없음', () => {
    expect(procThreadNote(1)).toBe('');
    expect(procThreadNote(null)).toBe('');
    expect(procThreadNote(40)).toMatch(/스레드 40개 — 상태와 디스크를 기다린 시간은 주 스레드 하나의 값/);
    expect(procThreadNote(40)).not.toMatch(/`/);
    expect(procCoverText({ inTopMs: 1, totalMs: 4 })).toMatch(/수집한 시간의 25%/);
  });
  it('상태 글 · 펼침 열쇠(시작 tick 까지 — pid 재사용을 가른다)', () => {
    expect(PROC_STATE_TEXT.D).toMatch(/디스크 대기/);
    expect(procKey('fm-a', { pid: 10, sk: 99 })).toBe('fm-a|10|99');
    expect(procKey('fm-a', { pid: 10 })).toBe('fm-a|10|');
  });
});

describe('화면 소스 — 프로세스 줄 펼침', () => {
  const src = fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8');
  it('세부 요청 · 지금 구간만 5초 폴링(과거는 한 번)', () => {
    const body = src.slice(src.indexOf('function ProcDetail('), src.indexOf('function ProcDetail(') + 1200);
    expect(body).toMatch(/usePoll\('\/tools\/focus-mon\/proc', params, live \? 5_000 : 0, true\)/);
    expect(body).toMatch(/target: id, pid: p\.pid, sk: p\.sk \?\? ''/);
    expect(src).toMatch(/const nf = Number\(q\.error\?\.status\) === 404;/);
  });
  it('줄을 누르면 그 줄 아래(Fragment) — 상위 5 · 상위 30 둘 다 · 서버 이름 단추는 전파를 막는다', () => {
    expect((src.match(/<ProcDetail id=\{id\} p=\{p\} tb=\{tb\}/g) || []).length).toBe(2);
    expect(src).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); onOpen\(id\); \}\}/);
    expect((src.match(/className=\{`fm-click \$\{on \? 'fm-editing' : ''\}`\} onClick=\{toggle\}/g) || []).length).toBe(2);
    expect((src.match(/tabIndex=\{0\} aria-expanded=\{on\}/g) || []).length).toBe(2);
  });
  it('반증 F7 · F11 — 404 뒤 멈춘 값은 밝힌다 · 네트워크 툴팁 · 옛 엣지 CPU 한 줄 · 펼친 프로세스는 서버에 묶인다', () => {
    expect(src).toMatch(/const staleBan = q\.error && d \?/);
    expect(src).toMatch(/onClick=\{q\.reload\}>다시 묻기<\/button>/);
    expect(src).toMatch(/h=\{110\} nullText="수집 없음" \/>/);
    expect(src).toMatch(/const splitCpu = /);
    expect(src).toMatch(/openProc && openProc\.id === id && !top5\.some/);
  });
  it('표에서 빠져도(상위 밖 · 찾기) 펼친 세부 정보를 닫지 않는다', () => {
    expect(src).toMatch(/지금 상위 5 에 없습니다 — 세부 정보는 계속 보여 줍니다/);
    expect(src).toMatch(/지금 표에 없습니다\(찾기 · 상위 30 밖\) — 세부 정보는 계속 보여 줍니다/);
  });
});
