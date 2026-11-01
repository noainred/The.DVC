// v2.847 Bareos 버그 점검 2회차(5축 + 반증 1인 — hunt2/R.md) — 화면 쪽 회귀.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
// 주석 줄은 뺀다(고친 이유를 적은 주석이 옛 모양을 인용한다)
const install = read('BareosInstall.jsx').replace(/^\s*\/\/.*$/gm, '');

describe('U2-1 — 완전 설치 실패 카드의 전부 되돌리기가 클릭 이벤트를 요청 본문에 싣지 않는다(v2.846 C-1 회귀)', () => {
  it('되돌리기 · 다시 시작 콜백을 onClick 에 그대로 넘기지 않는다(이벤트가 첫 인자로 들어간다)', () => {
    expect(install).not.toMatch(/onClick=\{onRollback\}/);
    expect(install).not.toMatch(/onClick=\{onRetry\}/);
    // FailureCard 단추는 아는 값만 넘긴다(S2-2 — SSH 인증 실패면 sshFixed · 아니면 인자 없음)
    expect(install).toMatch(/onClick=\{\(\) => onRollback\(rbAuth \? \{ sshFixed: true \} : undefined\)\}>전부 되돌리기/);
  });
  it('RunStep 의 onRollback 은 아는 칸(sshFixed === true)만 고른다 — 받은 객체를 본문에 펼치지 않는다', () => {
    const line = install.split('\n').find((l) => /onRollback=\{\(\w+\) => act\('rollback'/.test(l));
    expect(line).toBeTruthy();
    const arg = line.match(/onRollback=\{\((\w+)\) =>/)[1];
    expect(line).toContain(`act('rollback', { ack: true, ...(${arg} && ${arg}.sshFixed === true ? { sshFixed: true } : {}) }`);
    expect(line).not.toMatch(new RegExp(`\\.\\.\\.${arg}\\b`));
  });
});

describe('S2-2 — SSH 인증 실패로 멈춘 설치의 전부 되돌리기도 고쳤음 확인을 받는다', () => {
  it('실패 원인이 ssh-auth 면 고쳤음 체크 없이는 단추가 잠기고, 보낼 때 sshFixed 를 싣는다', () => {
    expect(install).toMatch(/const rbAuth = c\.key === 'ssh-auth';/);
    expect(install).toMatch(/disabled=\{busy \|\| !rbAck \|\| \(rbAuth && !rbFixed\)\}/);
  });
});

const corp = read('BareosCorp.jsx').replace(/^\s*\/\/.*$/gm, '');
const groupsTab = read('BareosGroupsTab.jsx').replace(/^\s*\/\/.*$/gm, '');
const accounts = read('BareosAccounts.jsx').replace(/^\s*\{\/\*.*\*\/\}$/gm, '');

describe('U2-2 — 쓰기 뒤 스캔도 세대로 거른다(늦게 온 A 법인 스캔이 B 법인 화면에 들어가지 않는다)', () => {
  it('세 스캔 경로(단추 · 법인 고름 · 쓰기 뒤)가 모두 scanGen 세대를 잡고 같을 때만 반영한다', async () => {
    const posts = corp.match(/\/scan`/g) || [];
    expect(posts.length).toBe(3);
    const gens = corp.match(/const g = \+\+scanGen\.current;/g) || [];
    expect(gens.length).toBe(3);
    expect(corp).toMatch(/else if \(g === scanGen\.current\) setScan\(x\);/);
  });
});

describe('U2-3 — 정리 미리 보기의 거부(409 등)를 지울 것 없음으로 보이지 않는다', () => {
  it('prunePreviewText — ok:false 면 bad · 사유 · 모름', async () => {
    const { prunePreviewText } = await import('./bareosGroupText.js');
    const t = prunePreviewText({ ok: false, code: 'busy', reason: '이 그룹의 정리 미리 보기가 진행 중입니다' });
    expect(t.tone).toBe('bad');
    expect(t.text).toMatch(/진행 중/);
    expect(t.text).not.toMatch(/등록된 VM 이 없습니다/);
  });
  it('화면은 ok:false 본문을 오류로 던진다(결과로 그리지 않는다)', () => {
    expect(groupsTab).toMatch(/prune-preview`[^\n]*\n\s*if \(r && r\.ok === false\) throw/);
  });
});

describe('U2-4 — 일괄 다시 시도는 같은 작업 · 같은 계정만(생성 비밀번호가 다른 이름으로 CSV 에 실리지 않는다)', () => {
  it('sameBulkJob — 작업 · 계정이 같을 때만 합친다', async () => {
    const { sameBulkJob } = await import('./bareosCorpText.js');
    expect(sameBulkJob({ action: 'console.add', account: 'alice' }, { action: 'console.add', account: 'alice' })).toBe(true);
    expect(sameBulkJob({ action: 'console.add', account: 'alice' }, { action: 'console.add', account: 'bob' })).toBe(false);
    expect(sameBulkJob({ action: 'console.add', account: 'alice' }, { action: 'console.password', account: 'alice' })).toBe(false);
    expect(sameBulkJob(null, { action: 'console.add', account: 'a' })).toBe(false);
  });
  it('다시 시도 폼은 작업 · 이름 · Profile 을 잠그고, 합칠 때 sameBulkJob 을 본다', () => {
    expect(accounts).toMatch(/disabled=\{!!preset && k !== f\.action\}/);
    expect(accounts).toMatch(/value=\{f\.name\} readOnly=\{!!preset\} disabled=\{!!preset\}/);
    expect(accounts).toMatch(/value=\{f\.profile\} disabled=\{!!preset\}/);
    expect(accounts).toMatch(/sameBulkJob\(prev, r\) \? \{ \.\.\.r, results: mergeBulkRows/);
  });
});

describe('E2-6 — 다시 등록 요약은 성공 · 실패 · 결과 모름 · 보내지 않음을 따로 센다', () => {
  it('reregisterSummary', async () => {
    const { reregisterSummary } = await import('./bareosCorpText.js');
    const s = reregisterSummary([{ ok: true }, { ok: false, unknown: true }, { ok: false, notSent: true }, { ok: false }], 'same');
    expect(s.text).toMatch(/성공 1 · 실패 1 · 결과 모름 1 · 보내지 않음 1/);
    expect(s.text).toMatch(/이어 갑니다/);
    expect(reregisterSummary([{ ok: false, unknown: true }], 'new').ok).toBe('warn');
    expect(reregisterSummary([{ ok: true }], 'new').ok).toBe(true);
  });
});
