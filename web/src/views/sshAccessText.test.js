import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shortFp, dateTime, ageDays, featuresText, folderTree, keysInFolder, inboxInFolder, sortedCheck, suggestKeyName,
  LEVEL_TEXT, LEVEL_TONE, KEY_MODE_TEXT, ISSUE_TEXT, serverStatus, auditTime, EVENT_TEXT,
  APPROVAL_STATUS_TEXT, APPROVAL_STATUS_TONE, GUARD_KEYS, GUARD_TEXT, JOB_CODE_TEXT,
  splitApprovals, approvalRemaining, isOwnRequest, pendingText, pendingTone, folderText, keyOptionLabel, guardDiff, guardSaveText,
  approvalDetail, approvalOutcome, rotateDoneText, eventDetail, keyLoginRow, keyRevokeRow, jobSummary, tallyText, restrictLineText,
  keyLoginSelectable, keyLoginKeyOptions, corpKeyOptions, rotateTargetOptions, defaultKeyChoice, savedAuthHints, pendingKeyRequest,
} from './sshAccessText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../server/src');
const serverSrc = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');
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

describe('SSH 공용 접속 — 서버 상태 칸(접속을 막는 사유 먼저)', () => {
  const base = { keyMode: 'pinned', keyId: 'k1', keyFeatures: ['bm-usage'] };
  it('계정 없음 · 키 없음 · 사용 중지 · 바꿔치기 · 폴더 · 퇴역 · 비밀번호 · 수집 기능 미허용 · 정상', () => {
    expect(serverStatus({ ...base, accountMissing: true }).label).toBe('공통 계정 없음');
    expect(serverStatus({ ...base, keyMissing: true }).tone).toBe('bad');
    expect(serverStatus(base, { stop: true }).label).toBe('키 사용 중지');
    expect(serverStatus({ keyMode: 'password' }, { stop: true }).label).toBe('비밀번호');
    expect(serverStatus(base, { tampered: ['k1'] }).tone).toBe('bad');
    expect(serverStatus({ ...base, placementIssue: 'key-folder' }).tone).toBe('bad');
    expect(serverStatus({ ...base, keyStatus: 'retired' }).label).toBe('퇴역 키');
    // v3.10.0: 승인 대기 키는 접속에 쓰이지 않는다 — ‘키’(정상)로 그리지 않는다
    expect(serverStatus({ ...base, keyStatus: 'pending' })).toMatchObject({ label: '키 승인 대기', tone: 'bad' });
    expect(serverStatus({ ...base, keyFeatures: ['disk-audit'] }).label).toBe('수집 기능 미허용');
    expect(serverStatus({ ...base, keyFeatures: [] }).tone).toBe('warn');
    expect(serverStatus({ ...base, keyFeatures: null })).toEqual({ label: '키', tone: 'ok' });
    expect(serverStatus(base)).toEqual({ label: '키', tone: 'ok' });
  });
  it('감사 시각 — ISO(UTC) 를 ms 로 · 못 읽으면 0', () => {
    expect(auditTime('2026-11-14T08:27:00.000Z')).toBe(Date.UTC(2026, 10, 14, 8, 27));
    expect(auditTime('')).toBe(0);
  });
});

describe('SSH 공용 접속 2단계(v3.10.0) — 두 사람 승인 문구', () => {
  const H = 3600_000;
  const now = 1_800_000_000_000;
  it('요청 상태 글자 · 톤은 서버 상태 목록(approval/store STATUSES)과 1:1 — 모르는 상태가 생기면 깨진다', () => {
    const m = /const STATUSES = \[([^\]]+)\]/.exec(serverSrc('approval/store.js'));
    const statuses = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(statuses.length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(APPROVAL_STATUS_TEXT).sort()).toEqual([...statuses].sort());
    expect(Object.keys(APPROVAL_STATUS_TONE).sort()).toEqual([...statuses].sort());
    expect(APPROVAL_STATUS_TONE.failed).toBe('bad'); expect(APPROVAL_STATUS_TONE.executed).toBe('ok'); expect(APPROVAL_STATUS_TONE.expired).toBe('muted');
  });
  it('대기 / 끝난 것 가르기 — 서버 순서 그대로 · 객체가 아닌 것은 버린다', () => {
    const list = [{ id: 'a', status: 'executed' }, { id: 'b', status: 'pending' }, null, { id: 'c', status: 'expired' }, { id: 'd', status: 'pending' }];
    const s = splitApprovals(list);
    expect(s.pending.map((r) => r.id)).toEqual(['b', 'd']);
    expect(s.done.map((r) => r.id)).toEqual(['a', 'c']);
    expect(splitApprovals(undefined)).toEqual({ pending: [], done: [] });
  });
  it('남은 시간 — 못 읽은 값은 ‘—’(0분으로 지어내지 않는다) · 지났으면 ‘시한 지남’', () => {
    expect(approvalRemaining(now + 23 * H + 12 * 60_000, now)).toBe('23시간 12분');
    expect(approvalRemaining(now + 2 * H, now)).toBe('2시간');
    expect(approvalRemaining(now + 5 * 60_000 + 30_000, now)).toBe('5분');
    expect(approvalRemaining(now + 20_000, now)).toBe('1분 미만');
    expect(approvalRemaining(now, now)).toBe('시한 지남');
    expect(approvalRemaining(now - 1, now)).toBe('시한 지남');
    for (const bad of [null, undefined, '', '0', 0, NaN, [], {}]) expect(approvalRemaining(bad, now)).toBe('—');
    expect(approvalRemaining(now + H, null)).toBe('—');
  });
  it('내 요청 판정 — 소문자 비교(서버와 같은 규칙) · 내 이름을 모르면 잠그지 않는다(false)', () => {
    expect(isOwnRequest({ requestedBy: 'Kim.Admin' }, 'kim.admin ')).toBe(true);
    expect(isOwnRequest({ requestedBy: 'kim.admin' }, 'KIM.Admin')).toBe(true);   // 내 이름 쪽 대소문자도 접는다(변이 M1 이 살아남던 자리)
    expect(isOwnRequest({ requestedBy: 'kim.admin' }, 'park.sec')).toBe(false);
    expect(isOwnRequest({ requestedBy: 'kim.admin' }, '')).toBe(false);
    expect(isOwnRequest({ requestedBy: '' }, '')).toBe(false);
    expect(isOwnRequest(null, 'kim.admin')).toBe(false);
    // 서버 store 가 실제로 소문자로 비교한다(화면 잠금과 서버 403 이 같은 사람을 가리킨다)
    expect(serverSrc('approval/store.js')).toMatch(/lc\(who\) === lc\(r\.requestedBy\)\) return \{ ok: false, code: 'self-approve'/);
  });
  it('202 승인 대기 문구 — 소유자 수를 알면 적고 · 모르면 적지 않고 · 0명이면 승인할 사람이 없다고 말하며 보호 장치를 가리킨다', () => {
    const two = pendingText({ pending: true, approvers: 2 }, { what: 'kr-ops 등록', then: '쓰입니다' });
    expect(two).toContain('kr-ops 등록 요청을 보냈습니다 — 다른 설정 소유자가 승인하면 쓰입니다(승인할 수 있는 소유자 2명)');
    const unknown = pendingText({ pending: true }, { what: '삭제', then: '지워집니다' });
    expect(unknown).toContain('다른 설정 소유자가 승인하면 지워집니다.');
    expect(unknown).not.toMatch(/소유자 \S*명/);
    const none = pendingText({ pending: true, approvers: 0 }, { what: 'kr-ops 등록' });
    expect(none).toContain('승인할 수 있는 다른 설정 소유자가 없습니다');
    expect(none).toContain('보호 장치'); expect(none).toContain('‘두 사람 승인’');
    expect(none).not.toContain('0명');
    expect(pendingTone({ approvers: 0 })).toBe('bad');
    expect(pendingTone({ approvers: 1 })).toBe('warn');
    expect(pendingTone({})).toBe('warn');
    // '0' 글자 · null 을 0명으로 읽지 않는다(Number('')===0 계열)
    expect(pendingTone({ approvers: null })).toBe('warn');
    expect(pendingText({ approvers: '' }, {})).not.toContain('없습니다');
  });
  it('요청이 실행할 내용 — 서버가 등록한 종류(SSH_KINDS) 전부에 설명이 있다 · 모르는 종류는 빈 글자', () => {
    const m = /export const SSH_KINDS = Object\.freeze\(\[([^\]]+)\]\)/.exec(serverSrc('sshaccess/service.js'));
    const kinds = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(kinds.length).toBeGreaterThanOrEqual(6);
    for (const kind of kinds) expect(approvalDetail({ kind, payload: {} }), kind).not.toBe('');
    expect(approvalDetail({ kind: 'something-else', payload: {} })).toBe('');
    const cn = (id) => ({ vcA: 'KR-SEL' }[id] || id);
    expect(approvalDetail({ kind: 'ssh-key-activate', payload: { name: 'kr-ops', fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', folderCorp: 'vcA', folderServer: '' } }, cn))
      .toContain('키 kr-ops · 지문 SHA256:abcdefghijkl…DEFG · 폴더 KR-SEL › 공통 — 승인하면');
    // 요청 본문의 종류 · 허용 기능(승인자가 보는 것 = 요청 지문에 묶인 것) — 본문에 없으면 지어내지 않고, null 은 ‘모든 기능(예전 방식)’
    const cat = [{ id: 'bm-usage', label: '베어메탈 사용률' }];
    expect(approvalDetail({ kind: 'ssh-key-activate', payload: { name: 'kr-ops', algo: 'ed25519', fingerprint: 'SHA256:x', folderCorp: 'vcA', folderServer: 'bm-a1', features: ['bm-usage'] } }, cn, cat))
      .toContain('키 kr-ops · ed25519 · 지문 SHA256:x · 폴더 KR-SEL › 서버별 › bm-a1 · 쓸 수 있는 기능 베어메탈 사용률 — 승인하면');
    expect(approvalDetail({ kind: 'ssh-key-activate', payload: { name: 'k', features: null } }, cn, cat)).toContain('쓸 수 있는 기능 모든 기능(예전 방식)');
    expect(approvalDetail({ kind: 'ssh-key-activate', payload: { name: 'k', features: [] } }, cn, cat)).toContain('쓸 수 있는 기능 없음');
    expect(approvalDetail({ kind: 'ssh-key-activate', payload: { name: 'k' } }, cn, cat)).not.toContain('쓸 수 있는 기능');
    // 서버가 실제로 그 본문을 싣는다(화면이 읽는 칸 이름)
    expect(serverSrc('sshaccess/service.js')).toMatch(/payload: \{ keyId: r\.key\.id, fingerprint: r\.key\.fingerprint, name: r\.key\.name, algo: r\.key\.algo \|\| '', folderCorp:[^}]*\n\s*features: Array\.isArray\(r\.key\.features\) \? r\.key\.features : null \}/);
    expect(approvalDetail({ kind: 'ssh-key-rotate', payload: { from: 'k_1', to: 'k_2', fromName: 'old', toName: 'new' } })).toContain('옛 키 old → 새 키 new');
    expect(approvalDetail({ kind: 'ssh-corp-resume', payload: { corp: 'vcA' } }, cn)).toContain('KR-SEL');
    expect(approvalDetail({ kind: 'ssh-guard-change', payload: { patch: { twoPerson: false } } })).toBe('끄는 보호 장치: 두 사람 승인');
    expect(approvalDetail({ kind: 'ssh-guard-change', payload: { patch: { twoPerson: false, serverRestrict: false } } })).toBe('끄는 보호 장치: 두 사람 승인 · 서버 쪽 제한');
    expect(approvalDetail({ kind: 'ssh-guard-change' })).toBe('끄는 보호 장치: —');
  });
  it('끝난 요청 결과 · 교체 결과 — 실패 사유는 서버 값 · 수를 모르면 단위 없이 ‘—’', () => {
    expect(approvalOutcome({ status: 'failed', result: { ok: false, reason: '쓰는 서버가 있어 지울 수 없습니다' } })).toBe('쓰는 서버가 있어 지울 수 없습니다');
    expect(approvalOutcome({ status: 'failed', result: null })).toContain('실행하지 못했습니다');
    expect(approvalOutcome({ status: 'expired' })).toContain('시한');
    // 승인은 됐는데 실행 결과가 아직 없는 요청 — ‘실행됨’ 으로 읽히지 않게(서버가 얼마 뒤 실패(중단)로 확정한다 · 그때는 서버 사유를 그대로)
    expect(APPROVAL_STATUS_TEXT.approved).toContain('결과 아직 없음');
    expect(approvalOutcome({ status: 'approved' })).toContain('아직 적히지 않았습니다');
    expect(approvalOutcome({ status: 'approved' })).not.toMatch(/\d+\s*분/);   // 시한 숫자를 화면에 박지 않는다
    expect(approvalOutcome({ status: 'failed', result: { ok: false, code: 'interrupted', reason: '승인 뒤 실행 결과가 적히지 않았습니다(포탈이 실행 중 멈춤) — 다시 요청하세요.' } })).toContain('포탈이 실행 중 멈춤');
    // 승인 대기 키의 등록 요청 — 살아 있는 요청만(끝난 요청 · 다른 종류 · 다른 키는 아니다)
    const vv = { approvals: [
      { id: 'ap_1', kind: 'ssh-key-activate', target: 'k_p', status: 'pending' }, { id: 'ap_2', kind: 'ssh-key-activate', target: 'k_q', status: 'rejected' },
      { id: 'ap_3', kind: 'ssh-key-delete', target: 'k_r', status: 'pending' },
    ] };
    expect(pendingKeyRequest(vv, 'k_p')?.id).toBe('ap_1');
    expect(pendingKeyRequest(vv, 'k_q')).toBe(null);
    expect(pendingKeyRequest(vv, 'k_r')).toBe(null);
    expect(pendingKeyRequest(vv, '')).toBe(null);
    expect(pendingKeyRequest({}, 'k_p')).toBe(null);
    expect(approvalOutcome({ status: 'rejected', note: '키 이름 규칙 위반' })).toBe('키 이름 규칙 위반');
    expect(approvalOutcome({ status: 'executed', note: '' })).toBe('');
    expect(rotateDoneText({ servers: ['a', 'b'], accounts: 1 })).toBe('서버 2대 · 공통 계정 1개를 새 키로 옮기고 옛 키를 퇴역시켰습니다');
    expect(rotateDoneText({ servers: [], accounts: 0 })).toContain('서버 0대 · 공통 계정 0개');
    expect(rotateDoneText(undefined)).toBe('서버 — · 공통 계정 —를 새 키로 옮기고 옛 키를 퇴역시켰습니다');
  });
  it('폴더 글자 · 드롭다운 한 줄', () => {
    const cn = (id) => ({ vcA: 'KR-SEL' }[id] || id);
    expect(folderText({ folderCorp: 'vcA', folderServer: '' }, cn)).toBe('KR-SEL › 공통');
    expect(folderText({ folderCorp: 'vcA', folderServer: 'bm-a1' }, cn)).toBe('KR-SEL › 서버별 › bm-a1');
    expect(folderText({ folderCorp: '' }, cn)).toBe('미분류');
    expect(keyOptionLabel({ name: 'old', status: 'retired', folderCorp: 'vcA' }, cn)).toBe('old (퇴역) — KR-SEL › 공통');
  });
});

describe('SSH 공용 접속 2단계 — 보호 장치 · 사건 문구', () => {
  it('보호 장치 키 · 이름은 서버 GUARD_KEYS 와 같다 · 설명에 시한 숫자를 박지 않는다', () => {
    const m = /export const GUARD_KEYS = Object\.freeze\(\[([^\]]+)\]\)/.exec(serverSrc('sshaccess/state.js'));
    expect([...GUARD_KEYS]).toEqual(m[1].split(',').map((x) => x.trim().replace(/'/g, '')));
    for (const k of GUARD_KEYS) { expect(GUARD_TEXT[k].label).toBeTruthy(); expect(GUARD_TEXT[k].note).not.toMatch(/\d+\s*시간/); }
  });
  it('편집값 ↔ 지금 값 — 켜는 것 · 끄는 것을 가른다 · 참/거짓이 아닌 값은 바꾸지 않는 것으로', () => {
    expect(guardDiff({ twoPerson: true, serverRestrict: false }, { twoPerson: false, serverRestrict: true })).toEqual({ on: ['serverRestrict'], off: ['twoPerson'], changed: 2 });
    expect(guardDiff({ twoPerson: true, serverRestrict: true }, { twoPerson: true, serverRestrict: true })).toEqual({ on: [], off: [], changed: 0 });
    expect(guardDiff({}, { twoPerson: false, serverRestrict: false }).changed).toBe(0);
    expect(guardDiff({ twoPerson: true, serverRestrict: true }, { twoPerson: 'false' }).changed).toBe(0);
  });
  it('저장 결과 문구 — 202 면 ‘다른 설정 소유자의 승인을 기다립니다’ · 켠 것은 켰다고 따로 말한다', () => {
    const diff = { on: ['serverRestrict'], off: ['twoPerson'], changed: 2 };
    const p = guardSaveText({ ok: true, pending: true, approvers: 1 }, diff);
    expect(p).toContain('서버 쪽 제한 — 켰습니다.');
    expect(p).toContain('두 사람 승인 끄기는 다른 설정 소유자의 승인을 기다립니다(승인할 수 있는 소유자 1명)');
    expect(guardSaveText({ ok: true, guards: {}, changed: 1 }, { on: [], off: ['serverRestrict'], changed: 1 })).toBe('보호 장치를 저장했습니다 — 서버 쪽 제한 끔.');
    expect(guardSaveText({ ok: true, changed: 0 }, { on: [], off: [], changed: 0 })).toBe('바뀐 것이 없습니다.');
  });
  it('사건 글자 — 서버가 남기는 종류(CRITICAL_EVENTS)는 전부 이름이 있다 · 새 파일의 내부 표지는 싣지 않는다 · 보호 장치 키는 화면 이름으로', () => {
    const m = /export const CRITICAL_EVENTS = Object\.freeze\(\[([^\]]+)\]\)/.exec(serverSrc('sshaccess/state.js'));
    for (const kind of m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)) expect(EVENT_TEXT[kind], kind).toBeTruthy();
    expect(eventDetail({ kind: 'guard-changed', detail: 'twoPerson=끔 · serverRestrict=켬' })).toBe('두 사람 승인 끔 · 서버 쪽 제한 켬');
    expect(eventDetail({ kind: 'approval-decided', detail: '승인 · 실행됨(요청 kim.admin)' })).toBe('승인 · 실행됨(요청 kim.admin)');
    expect(eventDetail({ kind: 'inbox-new', detail: 'vcA/common/x|abc\nvcA/common/y|def' })).toBe('');
    expect(eventDetail({ kind: 'key-login-set' })).toBe('');
    expect(eventDetail(null)).toBe('');
    expect(ISSUE_TEXT['key-pending']).toBeTruthy();
  });
  it('키 로그인 창의 서버 쪽 제한 줄 — 켬 · 끔 · 못 읽음 · 못 받음을 따로 말한다(모르는 것을 켬 · 끔으로 지어내지 않는다)', () => {
    expect(restrictLineText({ serverRestrict: true })).toMatch(/^켬/);
    expect(restrictLineText({ serverRestrict: false })).toMatch(/^끔/);
    expect(restrictLineText({ serverRestrict: true, unreadable: true })).toContain('읽지 못해');
    expect(restrictLineText(undefined)).toContain('받지 못했습니다');
    expect(restrictLineText({})).toContain('받지 못했습니다');
  });
});

describe('SSH 공용 접속 2단계 — 키 로그인 설정 · 키 거두기 결과 줄', () => {
  it('결과 code 글자 — 서버 keyLogin.js 가 내는 code 는 전부 글자가 있다', () => {
    const src = serverSrc('sshaccess/keyLogin.js');
    // code 가 적히는 네 꼴 — fail('x' · code: 'x' · code(: | =) 조건 ? 'a' : (조건 ? 'b' :) 'c' · fail(조건 ? 'a' : 'b'
    const codes = new Set();
    for (const re of [/fail\('([a-z][a-z-]*)'/g, /\bcode: '([a-z][a-z-]*)'/g,
      /\bcode(?: =|:) [^;,\n']*\? '([a-z][a-z-]*)' : (?:[^;,\n']*\? '([a-z][a-z-]*)' : )?'([a-z][a-z-]*)'/g, /fail\([^,\n]*\? '([a-z][a-z-]*)' : '([a-z][a-z-]*)'/g]) {
      for (const m of src.matchAll(re)) for (const c of m.slice(1)) if (c) codes.add(c);
    }
    // 작업을 시작하지 못한 요청 오류(행 결과가 아니다 — 서버 reason 을 그대로 보인다)
    for (const skip of ['busy', 'empty', 'too-many']) codes.delete(skip);
    for (const must of ['ok', 'edge-delegated', 'install-failed', 'key-login-failed', 'bind-failed', 'revoke-failed', 'bad-key', 'removed', 'not-present', 'none', 'hostkey', 'auth-rejected', 'connect', 'no-secret', 'error', 'key-pending', 'key-retired']) {
      expect(codes.has(must), `keyLogin.js 에서 ${must} 를 찾지 못함(추출 규칙 확인)`).toBe(true);
    }
    for (const c of codes) expect(JOB_CODE_TEXT[c], c).toBeTruthy();
    for (const c of ['moved', 'not-found', 'corp-stopped', 'key-folder', 'key-feature', 'key-tampered', 'state-unreadable']) expect(JOB_CODE_TEXT[c], c).toBeTruthy();
  });
  it('키 로그인 — 완료: 줄 추가 · 출발지 제한 · 비밀번호 삭제 · 옛 키 줄 수 · 메모가 있으면 확인 톤', () => {
    const ok = keyLoginRow({ ok: true, code: 'ok', line: 'added', restricted: true, fromIp: '192.0.2.5', bound: true, passwordRemoved: true, oldRemoved: 1, oldUnmarked: 0 }, { restrict: true });
    expect(ok).toMatchObject({ label: '완료', tone: 'ok', rollback: '' });
    expect(ok.parts.join(' · ')).toBe('공개키 줄을 더하고 키 접속 확인 · 출발지 제한 적용(192.0.2.5) · 포워딩 금지 · 이 서버가 이 키를 쓰도록 설정됨 · 저장 비밀번호 삭제 · 옛 키 줄 1개 삭제');
    // 법인 기본 키를 따르는 서버는 이름 고정으로 바꾸지 않는다(서버) — 화면도 ‘고정’ 이라고 말하지 않는다
    expect(ok.parts.join(' ')).not.toContain('고정');
    // 저장 비밀번호 — 지움(true) · 지울 것이 없었음(null — 지우라고 했을 때만 말한다) · 지우지 못함(false — 사유는 서버 메모)
    const nonePw = keyLoginRow({ ok: true, line: 'added', restricted: true, bound: true, passwordRemoved: null }, { restrict: true, removePassword: true });
    expect(nonePw.parts).toContain('지울 저장 비밀번호 없음'); expect(nonePw.parts.join(' ')).not.toContain('저장 비밀번호 삭제'); expect(nonePw.tone).toBe('ok');
    expect(keyLoginRow({ ok: true, line: 'added', restricted: true, bound: true, passwordRemoved: null }, { removePassword: false }).parts.join(' ')).not.toContain('비밀번호');
    const pwFail = keyLoginRow({ ok: true, line: 'added', restricted: true, bound: true, passwordRemoved: false, note: '저장 비밀번호를 지우지 못했습니다(쓰기 실패).' }, { removePassword: true });
    expect(pwFail.tone).toBe('warn'); expect(pwFail.parts.join(' ')).not.toContain('저장 비밀번호 삭제'); expect(pwFail.parts.at(-1)).toContain('지우지 못했습니다');
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/if \(!server\.password\) out\.passwordRemoved = null;/);
    // 줄이 이미 있었으면 제한을 새로 붙이지 않는다 — ‘적용’ 이라고 말하지 않는다
    const present = keyLoginRow({ ok: true, code: 'ok', line: 'present-marked', restricted: false, bound: true, passwordRemoved: false }, { restrict: true });
    expect(present.parts.join(' ')).toContain('있던 줄이라 서버 쪽 제한을 새로 붙이지 않음');
    expect(present.parts.join(' ')).not.toContain('출발지 제한 적용');
    expect(present.parts.join(' ')).not.toContain('저장 비밀번호 삭제');
    // 보호 장치가 꺼져 있으면 제한 없이 넣었다고 말한다
    expect(keyLoginRow({ ok: true, line: 'added', restricted: false, bound: true }, { restrict: false }).parts.join(' ')).toContain('서버 쪽 제한 없이 넣음');
    // 옛 키 줄을 못 지웠으면(null) 수를 지어내지 않고 서버 메모를 보인다 · 톤은 확인
    const noted = keyLoginRow({ ok: true, line: 'added', restricted: true, bound: true, oldRemoved: null, note: '옛 키 줄을 지우지 못했습니다(접속 실패).' }, {});
    expect(noted.tone).toBe('warn');
    expect(noted.parts.join(' ')).not.toMatch(/옛 키 줄 \S+개 삭제/);
    expect(noted.parts.at(-1)).toBe('옛 키 줄을 지우지 못했습니다(접속 실패).');
    expect(keyLoginRow({ ok: true, line: 'added', restricted: true, oldRemoved: 1, oldUnmarked: 2 }, {}).tone).toBe('warn');
  });
  it('키 로그인 — 실패: 서버 사유 그대로 · 되돌림 여부 · 시도하지 않은 것은 ‘하지 않음’(실패와 따로)', () => {
    const fail = keyLoginRow({ ok: false, code: 'key-login-failed', reason: '키 접속 확인 실패 — 인증이 거부됐습니다 더한 줄을 지웠습니다.', line: 'added', rolledBack: true });
    expect(fail).toMatchObject({ label: '실패', tone: 'bad', rollback: 'done' });
    expect(fail.parts).toEqual(['키 접속 확인 실패 — 인증이 거부됐습니다 더한 줄을 지웠습니다.']);
    expect(keyLoginRow({ ok: false, code: 'key-login-failed', reason: 'x', rolledBack: false }).rollback).toBe('failed');
    expect(keyLoginRow({ ok: false, code: 'auth-rejected', reason: 'x', rolledBack: null }).rollback).toBe('');
    expect(keyLoginRow({ ok: false, code: 'moved', reason: '서버 주소가 다릅니다' })).toMatchObject({ label: '하지 않음', tone: 'warn' });
    expect(keyLoginRow({ ok: false, code: 'edge-delegated' })).toMatchObject({ label: '하지 않음', parts: [JOB_CODE_TEXT['edge-delegated']] });
    // 사유가 없으면 code 글자, 그것도 없으면 code, 아무것도 없으면 ‘사유를 받지 못했습니다’ — 성공으로 읽지 않는다
    expect(keyLoginRow({ ok: false, code: 'connect' }).parts).toEqual([JOB_CODE_TEXT.connect]);
    expect(keyLoginRow({ ok: false, code: 'brand-new-code' }).parts).toEqual(['brand-new-code']);
    expect(keyLoginRow(undefined)).toMatchObject({ label: '실패', tone: 'bad', parts: ['사유를 받지 못했습니다'] });
    // ok 가 참이 아닌 값(문자열 등)은 완료로 그리지 않는다
    expect(keyLoginRow({ ok: 'true', code: 'ok' }).label).toBe('실패');
  });
  it('키 거두기 — 지움 / 포탈 줄 없음 / 파일 없음 / 못 닿음 · 표식 없는 줄 · 아직 그 키로 고정된 서버는 확인 톤', () => {
    expect(keyRevokeRow({ ok: true, code: 'removed', removed: 2, unmarked: 0, pinned: false })).toEqual({ label: '지움', tone: 'ok', parts: ['포탈이 넣은 줄 2개 삭제'], rollback: '' });
    expect(keyRevokeRow({ ok: true, code: 'not-present', removed: 0, unmarked: 0 })).toMatchObject({ label: '포탈 줄 없음', tone: 'muted' });
    expect(keyRevokeRow({ ok: true, code: 'none', removed: 0, unmarked: 0 })).toMatchObject({ label: '파일 없음', tone: 'muted' });
    const left = keyRevokeRow({ ok: true, code: 'not-present', removed: 0, unmarked: 1 });
    expect(left.tone).toBe('warn'); expect(left.parts.join(' ')).toContain('표식 없는 같은 키 줄 1개 남음');
    const pinned = keyRevokeRow({ ok: true, code: 'removed', removed: 1, unmarked: 0, pinned: true });
    expect(pinned.tone).toBe('warn'); expect(pinned.parts.join(' ')).toContain('아직 이 키로 고정');
    expect(keyRevokeRow({ ok: false, code: 'connect', reason: '접속하지 못했습니다(timeout)' })).toEqual({ label: '못 닿음', tone: 'bad', parts: ['접속하지 못했습니다(timeout)'], rollback: '' });
    expect(keyRevokeRow({ ok: false, code: 'corp-stopped', reason: 'r' }).label).toBe('못 닿음');
    expect(keyRevokeRow({ ok: false, code: 'revoke-failed', reason: 'r' }).label).toBe('실패');
    expect(keyRevokeRow({ ok: false, code: 'edge-delegated', reason: 'r' })).toMatchObject({ label: '하지 않음', tone: 'warn' });
    // 지운 수를 못 받았으면 단위 없이 ‘—’
    expect(keyRevokeRow({ ok: true, code: 'removed' }).parts).toEqual(['포탈이 넣은 줄 — 삭제']);
  });
  it('작업 요약 · 결과 글자별 개수 — 총 대수를 모르면 null(0 으로 지어내지 않는다)', () => {
    const job = { running: true, total: 5, current: 'pl-app-01', results: [{ ok: true }, { ok: false }, { ok: true }] };
    expect(jobSummary(job)).toEqual({ ok: 2, fail: 1, done: 3, total: 5, left: 2, running: true, current: 'pl-app-01' });
    expect(jobSummary(null)).toEqual({ ok: 0, fail: 0, done: 0, total: null, left: null, running: false, current: '' });
    expect(jobSummary({ total: '5', results: [] }).total).toBe(null);
    expect(tallyText(['완료', '실패', '완료', '하지 않음'])).toBe('완료 2 · 실패 1 · 하지 않음 1');
    expect(tallyText([])).toBe('');
  });
  it('키 선택지 — 여러 대 = 그 법인 공통 폴더의 활성 키만(승인 대기 · 퇴역 · 바꿔치기 · 서버별 · 다른 법인 제외)', () => {
    const v2 = { tampered: ['kT'], keys: [
      { id: 'kA', name: 'kr-common', status: 'active', folderCorp: 'vcA', folderServer: '' },
      { id: 'kP', name: 'kr-pending', status: 'pending', folderCorp: 'vcA', folderServer: '' },
      { id: 'kR', name: 'kr-old', status: 'retired', folderCorp: 'vcA', folderServer: '' },
      { id: 'kT', name: 'kr-tampered', status: 'active', folderCorp: 'vcA', folderServer: '' },
      { id: 'kS', name: 'a1-only', status: 'active', folderCorp: 'vcA', folderServer: 'bm-a1' },
      { id: 'kB', name: 'pl-common', status: 'active', folderCorp: 'vcB', folderServer: '' },
      { id: 'kN', name: 'legacy', status: 'active', folderCorp: '', folderServer: '' },
    ] };
    expect(keyLoginKeyOptions(v2, 'vcA').map((k) => k.id)).toEqual(['kA']);
    expect(keyLoginKeyOptions(v2, '').map((k) => k.id)).toEqual(['kN']);
    expect(keyLoginKeyOptions({}, 'vcA')).toEqual([]);
    // 거두기 · 교체의 옛 키 — 그 법인 폴더 + 미분류(퇴역 포함 — 줄이 서버에 남아 있을 수 있다) · 승인 대기는 넣은 적이 없다
    expect(corpKeyOptions(v2, 'vcA').map((k) => k.id)).toEqual(['kA', 'kR', 'kT', 'kS', 'kN']);
    expect(corpKeyOptions(v2, 'vcA', { exclude: 'kA' }).map((k) => k.id)).toEqual(['kR', 'kT', 'kS', 'kN']);
    // 교체의 새 키 — 활성 · 바꿔치기 아님 · 자기 자신 제외
    expect(rotateTargetOptions(v2, { id: 'kA' }).map((k) => k.id)).toEqual(['kS', 'kB', 'kN']);
    expect(defaultKeyChoice([{ id: 'kA' }])).toBe('kA');
    expect(defaultKeyChoice([{ id: 'kA' }, { id: 'kS' }], 'kS')).toBe('kS');
    expect(defaultKeyChoice([{ id: 'kA' }, { id: 'kS' }], 'kZ')).toBe('');
    expect(defaultKeyChoice([], 'kA')).toBe('');
    expect(keyLoginSelectable({ id: 's1', agent: '' })).toBe(true);
    expect(keyLoginSelectable({ id: 's2', agent: 'pl-edge' })).toBe(false);
    expect(keyLoginSelectable(null)).toBe(false);
  });
  it('‘저장된 인증 사용’ 주의 — 키로 설정됐는데 서버에 든 것이 확인되지 않은 서버 · 인증 수단이 없는 서버만 말한다', () => {
    const t = [
      { id: 'a', keyMode: 'corp-default', installed: null },                    // 읽은 적 없음 — 확인 안 됨
      { id: 'b', keyMode: 'pinned', installed: { hasKey: false } },             // 읽었는데 없음
      { id: 'c', keyMode: 'pinned', installed: { hasKey: true } },              // 들어 있음 — 말하지 않는다
      { id: 'd', keyMode: 'password' },                                         // 저장 비밀번호 — 말하지 않는다
      { id: 'e', keyMode: 'none' },
    ];
    const h = savedAuthHints(t);
    expect(h).toHaveLength(2);
    expect(h[0]).toContain('서버 2대는 지금 키로 접속하도록 설정돼');
    expect(h[1]).toContain('서버 1대는 저장된 인증 수단이 없습니다');
    expect(savedAuthHints([t[2], t[3]])).toEqual([]);
    expect(savedAuthHints(undefined)).toEqual([]);
    // 지금 넣는 키가 그 서버에 설정된 키이고 저장 비밀번호가 있으면 주의하지 않는다(서버가 그 비밀번호로 붙는다 — keyLogin.firstLegAuth)
    const u = [{ id: 'f', keyMode: 'corp-default', keyId: 'k_1', accountName: 'kr-acc', installed: null }, { id: 'g', keyMode: 'pinned', keyId: 'k_1', hasPassword: true, installed: null }];
    expect(savedAuthHints(u, { keyId: 'k_1', accounts: [{ name: 'kr-acc', hasPassword: true }] })).toEqual([]);
    expect(savedAuthHints(u, { keyId: 'k_1', accounts: [{ name: 'kr-acc', hasPassword: false }] })[0]).toContain('서버 1대는');
    expect(savedAuthHints(u, { keyId: 'k_2', accounts: [{ name: 'kr-acc', hasPassword: true }] })[0]).toContain('서버 2대는');
    // 근거 — 서버 쪽 판정(설정된 키 = 넣는 키 → 저장 비밀번호 먼저)
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/r\.authKind === 'key' && installingKeyId && r\.keyId === installingKeyId/);
  });
});

describe('SSH 공용 접속 화면 — 규약', () => {
  const src = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
  it('2단계(v3.10.0) — 작업 진행은 도는 동안에만 묻고 · 떠나면 멈추고 · 늦은 응답은 버린다(주기 폴링 없음)', () => {
    expect(src).not.toMatch(/setInterval\(/);
    expect(src).not.toMatch(/usePolling/);
    expect(src).toMatch(/if \(r\.job\?\.running\) timer\.current = setTimeout\(\(\) => ask\(id, g\), JOB_POLL_MS\)/);
    expect(src).toMatch(/const JOB_POLL_MS = 2000;/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{ gen\.current \+= 1; clearTimeout\(timer\.current\); \}, \[\]\)/);
    expect((src.match(/if \(g !== gen\.current\) return;/g) || []).length).toBeGreaterThanOrEqual(2);
    // 못 물으면 끝없이 묻지 않는다(상한 · 404 는 바로 멈춤)
    expect(src).toMatch(/e\?\.status === 404 \|\| e\?\.status === 403 \|\| fails\.current >= JOB_POLL_MAX_FAILS/);
  });
  it('2단계 — 202 승인 대기를 성공으로 그리지 않는다 · 승인은 본 지문을 보낸다 · 본인 요청은 승인 단추가 잠긴다', () => {
    expect((src.match(/r\.pending \? pendingText\(/g) || []).length).toBeGreaterThanOrEqual(4);   // 키 등록 · 받은 키 승인 · 교체 · 삭제
    expect((src.match(/if \(r\?\.pending\) say\(pendingText\(/g) || []).length).toBe(2);             // 법인 재개 · 키 저장소 다시 읽기
    expect(src).toMatch(/r\.plaintextLeft \? 'bad' : r\.pending \? pendingTone\(r\) : 'ok'/);
    expect(src).toMatch(/say\(guardSaveText\(r, diff\), r\.pending \? pendingTone\(r\) : 'ok'\)/);
    expect(src).toMatch(/approve \? \{ digest: actReq\.digest, note: act\.note, otp: act\.otp \} : \{ note: act\.note, otp: act\.otp \}/);
    expect(src).toMatch(/disabled=\{busy \|\| own\} title=\{own \? '요청한 사람은 승인할 수 없습니다/);
    expect(src).toMatch(/getCurrentUser\(\)\?\.username/);
    // 승인 기록을 못 읽었으면 빈 목록이 아니라 띠
    expect(src).toMatch(/v\.approvalsUnreadable && <p className="ssa-banner"/);
    // 승인 대기 키는 고치기 · 교체가 잠기고, 삭제는 등록 요청이 살아 있지 않을 때만(승인 기록을 못 읽었으면 모르므로 잠근다)
    expect(src).toMatch(/disabled=\{busy \|\| \(k\.status === 'pending' && \(!!v\.approvalsUnreadable \|\| !!pendingKeyRequest\(v, k\.id\)\)\)\}/);
    expect((src.match(/disabled=\{busy \|\| k\.status !== 'active'\}/g) || []).length).toBe(2);
    // 승인 창은 요청 본문을 지금 읽은 목록에서 다시 찾는다(낡은 지문으로 승인하지 않는다) · 허용 기능 이름까지 보인다
    expect(src).toMatch(/const actReq = act \? apprPending\.find\(\(r\) => r\.id === act\.id\) \|\| null : null;/);
    expect(src).toMatch(/approvalDetail\(actReq, corpName, v\.features\)/);
  });
  it('2단계 — 키 로그인 · 거두기: 화면에서 본 접속처를 돌려보내고 · 서버 쪽 제한은 요청이 고르지 않고 · 1회 비밀번호 · OTP 는 보낸 뒤 비운다', () => {
    expect(src).toMatch(/const body = \{ servers: targets\.map\(\(s\) => \(\{ id: s\.id, addr: s\.addr \|\| '' \}\)\), keyId: key\.id, removePassword: removePw, otp \};/);
    expect(src).not.toMatch(/body\.(restrict|serverRestrict)\b/);
    expect(src).toMatch(/setOnce\(''\); setOtp\(''\);\n\s+setBusy\(true\)/);
    expect(src).toMatch(/setRv\(\(x\) => \(\{ \.\.\.x, once: '', otp: '' \}\)\);/);
    expect(src).toMatch(/restrictLineText\(v\.guards\)/);
    // Esc · 바깥 누르기는 작업이 도는 동안 닫지 않는다
    expect(src).toMatch(/e\.key === 'Escape' && !lockedRef\.current/);
    expect(src).toMatch(/e\.target === e\.currentTarget && !locked\) close\(\)/);
    // 엣지 위임 서버는 고를 수 없다
    expect(src).toMatch(/const pickable = servers\.filter\(keyLoginSelectable\)/);
    // 보호 장치는 바꾼 것만 보낸다
    expect(src).toMatch(/putJson\('\/settings\/ssh-access\/guards', \{ \.\.\.patch, otp: gOtp \}\)/);
  });
  it('표는 STable · 원시 table 없음 · 백틱 강조 · 대문자 변환 없음', () => {
    expect(src).not.toMatch(/<table[\s>]/);
    expect((src.match(/<STable /g) || []).length).toBeGreaterThanOrEqual(6);
    expect(src).not.toMatch(/textTransform|text-transform/);
    const css = fs.readFileSync(path.join(HERE, 'sshAccess.css'), 'utf8');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    for (const m of src.matchAll(/BoldText text=\{'([^']*)'\}/g)) expect(m[1]).not.toMatch(/`/);
  });
  it('쓰기 응답은 전부 must() — postJson 409 · putJson/delJson 400 · 409 를 성공으로 그리지 않는다', () => {
    const calls = [...src.matchAll(/await (postJson|putJson|delJson)\(/g)].length;
    const wrapped = [...src.matchAll(/must\(await (postJson|putJson|delJson)\(/g)].length;
    expect(calls).toBe(wrapped);
    expect([...src.matchAll(/run\(\(\) => (postJson|putJson|delJson)\(/g)].length).toBeGreaterThan(0);
    expect(src).toMatch(/const r = must\(await fn\(\)\)/);
  });
  it('기능 고르기는 렌더 밖 컴포넌트 · 예전 키는 ‘제한 없음’ 을 보존 · 0개는 저장 단추를 막는다', () => {
    expect(src).toMatch(/^function FeaturePicker\(/m);
    expect(src).toMatch(/features: k\.features == null \? null : \[\.\.\.k\.features\]/);
    expect(src).toMatch(/allowAll=\{edit\.key\.features == null\}/);
    expect((src.match(/!featuresChosen\(/g) || []).length).toBeGreaterThanOrEqual(6);
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
