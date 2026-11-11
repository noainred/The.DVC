/**
 * 서버 집중 모니터링 v2.978 — CSV 대량 등록 · 일괄 시험 · 엣지 연결 진단 화면 문구(순수 함수).
 *  · CSV 줄 처리 이름이 서버(registry.planCsv)와 1:1 · 깨우기 결과 이름이 서버(edgePull kind + ok · error)를 모두 덮는다.
 *  · 못 읽은 진단 값은 칸을 빼고 0 으로 쓰지 않는다 · 엑셀(CP949) CSV 를 깨지지 않게 읽는다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  CSV_ACTION_TEXT, csvChangeText, needsRetry, csvHeaderNotes, decodeCsvBytes, WAKE_TEXT, WAKE_KEYS, wakeFallbackText, upgradeText, diagItems, bulkLine, installGroups, TEST_TEXT,
} from './focusMonText.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('서버와 이름 1:1', () => {
  it('CSV 줄 처리(add · update · same · error) = registry.planCsv counts 키', () => {
    const src = read('../../../../server/src/focusmon/registry.js');
    const m = src.match(/const counts = \{([^}]+)\}/);
    expect(m).toBeTruthy();
    const server = [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]).sort();
    expect(Object.keys(CSV_ACTION_TEXT).sort()).toEqual(server);
  });
  it('깨우기 결과 — edgePull 의 kind 전부 + ok · error 를 문구로 덮는다', () => {
    const src = read('../../../../server/src/central/edgePull.js');
    const m = src.match(/export const EDGE_PULL_KINDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    const kinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of [...kinds, 'ok', 'error']) expect(WAKE_KEYS).toContain(k);
    for (const k of WAKE_KEYS) expect(['ok', 'warn', 'crit', 'off']).toContain(WAKE_TEXT[k].tone);
  });
});

describe('CSV', () => {
  it('엑셀 CP949 저장본은 EUC-KR 로 · UTF-8 은 그대로', () => {
    const cp949 = new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0x49, 0x50]); // '이름,IP'
    expect(decodeCsvBytes(cp949)).toEqual({ text: '이름,IP', encoding: 'euc-kr' });
    expect(decodeCsvBytes(new TextEncoder().encode('이름,IP')).encoding).toBe('utf-8');
  });
  it('갱신 줄은 바뀌는 칸만 · 노드는 ‘중앙’ · ‘엣지 이름’ 으로', () => {
    expect(csvChangeText({ action: 'update', changes: ['username', 'agent'], before: { username: 'root', agent: '' }, value: { username: 'dvcmon', agent: 'edge-pl' } }))
      .toBe('계정 root → dvcmon · 담당 노드 중앙 → 엣지 edge-pl');
    expect(csvChangeText({ action: 'add' })).toBe('');
  });
});

describe('엣지 진단', () => {
  it('못 읽은 값은 칸을 빼고 0 으로 쓰지 않는다', () => {
    expect(diagItems(null, 0)).toEqual([]);
    const it1 = diagItems({ rttMs: null, buffered: 0, dropped: 0, fails: 0, collectors: undefined, idleMs: 10_000, lastError: null }, 0);
    expect(it1).toEqual([['쉬는 동안 조회', '10초마다'], ['못 보낸 표본', '0개']]);
  });
  it('깨우기 실패 안내 — 쉬는 주기를 응답 값으로 · 옛 판은 30초', () => {
    expect(wakeFallbackText({ kind: 'edge', idleMs: 10_000 })).toMatch(/10초마다/);
    expect(wakeFallbackText({ kind: 'edge', idleMs: 10_000, upgrade: 'diag' })).toMatch(/30초/);
    expect(wakeFallbackText({ kind: 'central' })).toBe('');
  });
  it('업그레이드 안내 — 서버 판정 그대로 · 판 번호는 응답 값', () => {
    expect(upgradeText({ upgrade: 'feature' }, { edgeMin: '2.976.0' })).toMatch(/v2\.976\.0 이상/);
    expect(upgradeText({ upgrade: 'diag', version: '2.977.0' }, { diagMin: '2.978.0' })).toMatch(/v2\.978\.0 이상.*v2\.977\.0/);
    expect(upgradeText({ upgrade: null })).toBe('');
  });
});

describe('일괄 시험 · 설치 명령', () => {
  it('진행 한 줄 — 건너뜀 · 답 없음 · 실패 사유 상위 3', () => {
    const p = { startedAt: 0, total: 10, done: 6, ok: 4, fail: 2, skipped: 1, noAnswer: 0, finished: false, kinds: { ok: 4, auth: 2 } };
    const l = bulkLine(p, 1000);
    expect(l.tone).toBe('run');
    expect(l.text).toBe(`일괄 시험 중 — 6 / 9대 · 성공 4 · 실패 2 · 건너뜀 1(10초 안에 시험함) (${TEST_TEXT.auth} 2)`);
    expect(bulkLine({ ...p, finished: true, fail: 0, noAnswer: 0 }, 1000).tone).toBe('ok');
    expect(bulkLine({ ...p, finished: true }, 31 * 60_000)).toBe(null);
    expect(bulkLine(null, 0)).toBe(null);
  });
  it('설치 명령은 그 노드 · 계정별 묶음(데모 제외 · 노드 대소문자 무시)', () => {
    const t = [
      { host: '10.0.0.1', username: 'dvcmon', agent: 'Edge-PL' }, { host: '10.0.0.2', username: 'dvcmon', agent: 'edge-pl' },
      { host: '10.0.0.3', username: 'root', agent: 'edge-pl' }, { host: '10.0.0.4', username: 'dvcmon', agent: '' },
      { host: '10.0.0.5', username: 'dvcmon', agent: 'edge-pl', demo: true },
    ];
    expect(installGroups(t, 'edge-pl')).toEqual([{ user: 'dvcmon', hosts: ['10.0.0.1', '10.0.0.2'] }, { user: 'root', hosts: ['10.0.0.3'] }]);
    expect(installGroups(t, '')).toEqual([{ user: 'dvcmon', hosts: ['10.0.0.4'] }]);
  });
});

describe('다시 연결 버튼(사용자 보고 2026-11-12 — 엣지 서버는 시험만 하면 버튼이 없었다)', () => {
  it('엣지 서버는 시험 결과(거부 · 거부로 멈춤)만으로도 보인다', () => {
    expect(needsRetry({ agent: 'NJ', test: { result: { kind: 'auth-stopped' } } })).toBe(true);
    expect(needsRetry({ agent: 'NJ', test: { result: { kind: 'auth' } } })).toBe(true);
    expect(needsRetry({ status: { state: 'auth' } })).toBe(true);
    expect(needsRetry({ authStop: { since: 1 } })).toBe(true);
    expect(needsRetry({ agent: 'NJ', test: { result: { kind: 'unreachable' } } })).toBe(false);
    expect(needsRetry(null)).toBe(false);
  });
});

describe('반증 반영(v2.978)', () => {
  it('엑셀 유니코드 텍스트(UTF-16 · BOM)도 읽는다', () => {
    const le = new Uint8Array([0xff, 0xfe, ...[...'이름\tIP'].flatMap((ch) => { const c = ch.charCodeAt(0); return [c & 255, c >> 8]; })]);
    expect(decodeCsvBytes(le)).toEqual({ text: '이름\tIP', encoding: 'utf-16' });
  });
  it('머리글 안내 — 못 찾은 선택 열은 기본값이 들어간다고 말한다 · 읽지 않은 열', () => {
    expect(csvHeaderNotes({ header: true, missing: ['port', 'agent'], ignored: ['비고'] })).toEqual([
      '포트 열을 찾지 못해 모든 줄을 22 로 넣습니다.', '담당 노드 열을 찾지 못해 모든 줄을 중앙이 맡습니다.', '읽지 않은 열: 비고 — 이 열의 값은 쓰지 않습니다.',
    ]);
    expect(csvHeaderNotes({ header: false, missing: ['port'] })).toEqual([]);
  });
});
