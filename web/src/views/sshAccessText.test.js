import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shortFp, dateTime, ageDays, featuresText, folderTree, keysInFolder, inboxInFolder, sortedCheck, suggestKeyName,
  LEVEL_TEXT, LEVEL_TONE, KEY_MODE_TEXT, ISSUE_TEXT,
} from './sshAccessText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const view = {
  corps: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }],
  servers: [{ id: 's1', name: 'bm-a1', vcenterId: 'vcA' }, { id: 's2', name: 'bm-a2', vcenterId: 'vcA' }, { id: 's3', name: 'pl-1', vcenterId: 'vcB' }],
  keys: [
    { id: 'k1', name: 'kr-common', folderCorp: 'vcA', folderServer: '', features: ['bm-usage'] },
    { id: 'k2', name: 'a1-only', folderCorp: 'vcA', folderServer: 'bm-a1', features: [] },
    { id: 'k3', name: 'legacy', folderCorp: '', folderServer: '', features: null },
    { id: 'k4', name: 'gone-srv', folderCorp: 'vcB', folderServer: 'old-box', features: ['disk-audit'] },
  ],
  inbox: { items: [{ id: 'i1', corp: 'vcA', server: '', relPath: 'vcA/common/x' }, { id: 'i2', corp: 'vcA', server: 'bm-a1', relPath: 'vcA/servers/bm-a1/y' }] },
};

describe('SSH 공용 접속 — 표시 도우미', () => {
  it('지문 줄임 · 시각 · 나이 — 없으면 ‘—’ · null(0 으로 지어내지 않는다)', () => {
    expect(shortFp('SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe('SHA256:abcdefghijkl…DEFG');
    expect(shortFp('')).toBe('—');
    expect(dateTime(0)).toBe('—'); expect(dateTime(null)).toBe('—');
    expect(ageDays(null)).toBe(null);
    expect(ageDays(Date.now() - 3 * 86_400_000)).toBe(3);
  });
  it('허용 기능 — null 은 모든 기능(예전 방식) · [] 는 없음 · id 는 목록 이름으로', () => {
    expect(featuresText(null)).toBe('모든 기능(예전 방식)');
    expect(featuresText([])).toBe('없음');
    expect(featuresText(['bm-usage', 'x'], [{ id: 'bm-usage', label: '베어메탈 사용률' }])).toBe('베어메탈 사용률 · x');
  });
  it('폴더 트리 — 법인마다 공통 · 서버별(등록 서버 + 키가 있는 폴더 — 서버가 지워져도 키가 숨지 않는다) · 미분류', () => {
    const tree = folderTree(view);
    const ids = tree.map((n) => n.id);
    expect(ids).toContain('server:vcA:bm-a1'); expect(ids).toContain('server:vcA:bm-a2');
    expect(ids).toContain('server:vcB:old-box');
    expect(tree.at(-1)).toMatchObject({ id: 'none', count: 1 });
    expect(tree.find((n) => n.id === 'corp:vcA').count).toBe(2);
    expect(keysInFolder(view, tree.find((n) => n.id === 'common:vcA')).map((k) => k.id)).toEqual(['k1']);
    expect(keysInFolder(view, tree.find((n) => n.id === 'server:vcA:bm-a1')).map((k) => k.id)).toEqual(['k2']);
    expect(keysInFolder(view, tree.find((n) => n.id === 'none')).map((k) => k.id)).toEqual(['k3']);
    expect(inboxInFolder(view, tree.find((n) => n.id === 'common:vcA')).map((x) => x.id)).toEqual(['i1']);
    expect(inboxInFolder(view, tree.find((n) => n.id === 'server:vcA:bm-a1')).map((x) => x.id)).toEqual(['i2']);
    expect(folderTree({}).map((n) => n.id)).toEqual(['none']);
  });
  it('키 점검 정렬 — 위험 → 확인 → 모름 → 정상 · 글자 · 톤(모름은 회색)', () => {
    expect(sortedCheck([{ level: 'ok' }, { level: 'bad' }, { level: 'unknown' }, { level: 'warn' }]).map((i) => i.level)).toEqual(['bad', 'warn', 'unknown', 'ok']);
    expect(LEVEL_TONE.unknown).toBe('muted'); expect(LEVEL_TEXT.bad).toBe('위험');
    expect(KEY_MODE_TEXT.pinned).toBe('이름 고정'); expect(ISSUE_TEXT['key-folder']).toBeTruthy();
  });
  it('받은 키 기본 이름 — 서버 이름 규칙 글자만', () => {
    expect(suggestKeyName({ corp: 'vcA', server: 'bm a1', file: 'id ed25519' })).toBe('vcA-bm-a1-id-ed25519');
    expect(suggestKeyName({})).toBe('common-key');
  });
});

describe('SSH 공용 접속 화면 — 규약', () => {
  const src = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
  it('표는 STable · 원시 table 없음 · 백틱 강조 · 대문자 변환 없음', () => {
    expect(src).not.toMatch(/<table[\s>]/);
    expect((src.match(/<STable /g) || []).length).toBeGreaterThanOrEqual(6);
    expect(src).not.toMatch(/textTransform|text-transform/);
    const css = fs.readFileSync(path.join(HERE, 'sshAccess.css'), 'utf8');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    for (const m of src.matchAll(/BoldText text=\{'([^']*)'\}/g)) expect(m[1]).not.toMatch(/`/);
  });
  it('비밀은 보내기만 — 응답에서 개인키 · passphrase 를 그리지 않는다 · 1회 비밀번호는 보낸 뒤 비운다', () => {
    expect(src).not.toMatch(/resp\.privateKey|k\.privateKey|it\.privateKey|c\.privateKey/);
    expect(src).toMatch(/setOnce\(''\)/);
  });
  it('설정 메뉴에 등록 — 보안 묶음 · 키 ssh-access', () => {
    const st = fs.readFileSync(path.join(HERE, 'Settings.jsx'), 'utf8');
    expect(st).toMatch(/\{ k: 'ssh-access', label: 'SSH 공용 접속', C: SshAccessSettings, group: 'security'/);
  });
});
