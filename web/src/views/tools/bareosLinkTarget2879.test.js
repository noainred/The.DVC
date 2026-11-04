// v2.879 Bareos 완전 설치 '등록부 대상 연결'(사용자 요청 — 배포 등록부에 에이전트 이름이 다르게 들어간 대상을 기존 목록에서 골라 고친다 · 오타 방지).
// 판정 문구(bareosInstallText.js) + 화면 소스 규약(이름 입력 칸이 없다 · 서버에 이름을 보내지 않는다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canLink, linkChoices, linkCandText, linkDoneText, isSshAuthFail } from './bareosInstallText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, 'BareosInstall.jsx'), 'utf8');

const ROW = { vcenterId: 'vc9', vcenterName: '법인9', agent: 'agent-WA', targetId: '', linkable: true };
const LIST = [
  { id: 'a', host: '10.0.0.20', sshPort: 22, username: 'root', agentName: 'edge-1', blocked: '엣지 ‘edge-1’ 가 쓰는 대상입니다' },
  { id: 'b', host: '10.0.0.9', sshPort: 2222, username: 'root', agentName: 'agentWA', blocked: '' },
  { id: 'c', host: '10.0.0.10', sshPort: 22, username: 'admin', agentName: '', blocked: '' },
  { id: 'e', host: '10.0.0.12', sshPort: 22, username: 'root', agentName: 'x', blocked: '', jobs: [{ vcenterId: 'vc9', vcenterName: '법인9', id: 'bi_n' }, { vcenterId: 'vc5', vcenterName: '법인5', id: 'bi_o' }] },
  { id: 'f', host: '10.0.0.13', sshPort: 22, username: 'root', agentName: 'y', blocked: '', jobs: [{ vcenterId: 'vc9', vcenterName: '법인9', id: 'bi_m' }] },
];

describe('등록부 대상 연결 — 판정', () => {
  it('연결 단추는 엣지는 있는데 대상이 없는 행만', () => {
    expect(canLink(ROW)).toBe(true);
    expect(canLink({ ...ROW, targetId: 't1' })).toBe(false);
    expect(canLink({ ...ROW, agent: '' })).toBe(false);
    expect(canLink({ ...ROW, linkable: undefined })).toBe(false);
    expect(canLink(null)).toBe(false);
  });
  it('고를 수 없는 대상은 잠그고 까닭을 보인다 · 고를 수 있는 것 먼저 · 이 법인 작업은 막지 않는다', () => {
    const c = linkChoices(LIST, ROW);
    expect(c.map((x) => [x.id, x.disabled])).toEqual([['b', false], ['c', false], ['f', false], ['a', true], ['e', true]]);
    expect(c.find((x) => x.id === 'a').why).toMatch(/edge-1/);
    expect(c.find((x) => x.id === 'e').why).toMatch(/법인 ‘법인5’ 의 완전 설치 작업/);
    expect(linkChoices(LIST, null)).toEqual([]);
    expect(linkChoices(undefined, ROW)).toEqual([]);
  });
  it('대상 한 줄 · 성공 문구(포트 22 는 생략 · 이름 없음 표시)', () => {
    expect(linkCandText(LIST[1])).toBe('10.0.0.9:2222 · root · 지금 이름 ‘agentWA’');
    expect(linkCandText(LIST[2])).toBe('10.0.0.10 · admin · 지금 이름 ‘(없음)’');
    expect(linkDoneText({ host: '10.0.0.9', sshPort: 22, before: 'agentWA', agent: 'agent-WA', portalName: 'agent-WA' })).toMatch(/‘agentWA’ → ‘agent-WA’/);
    for (const t of [linkCandText(LIST[1]), linkDoneText({ host: 'h', agent: 'a' })]) expect(t).not.toMatch(/`/);
  });
});

describe('등록부 대상 연결 — 화면 소스', () => {
  const card = src.slice(src.indexOf('function LinkCard'), src.indexOf('/* ───────── 1 대상'));
  it('이름 입력 칸이 없다(목록에서만 고른다) · 날 select 금지', () => {
    expect(card).toMatch(/<Select /);
    expect(card).not.toMatch(/<input/);
    expect(card).not.toMatch(/<select/);
  });
  it('서버에는 vCenter · 대상 id · 화면이 본 이름만 보낸다(새 이름을 보내지 않는다)', () => {
    expect(card).toMatch(/link-target`, \{ vcenterId: row\.vcenterId, targetId: c\.id, expectName: c\.cand\.agentName \}/);
    expect(card).not.toMatch(/agentName: row\.agent/);
  });
  it('실패는 카드 안에 보인다 · 고를 수 없는 항목은 disabled', () => {
    expect(card).toMatch(/<Msg m=\{fail\} \/>/);
    expect(card).toMatch(/disabled=\{x\.disabled\}/);
  });
  it('SSH 로그인 실패한 대상은 다시 누르지 못한다(반복 로그인 = 계정 잠금 위험) · 목록 다시 읽기', () => {
    expect(isSshAuthFail({ body: { code: 'ssh-auth' } })).toBe(true);
    expect(isSshAuthFail({ body: { code: 'conflict' } })).toBe(false);
    expect(isSshAuthFail(new Error('x'))).toBe(false);
    expect(card).toMatch(/disabled=\{!c \|\| busy \|\| !writable \|\| locked\}/);
    expect(card).toMatch(/목록 다시 읽기/);
  });
});
