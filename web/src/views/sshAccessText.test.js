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
  identityKey, HIDDEN_EVENT_KINDS, guardFailText, guardOffRuleText, approvalStatusChip, rotateNoCollectWarn, placementDoneText,
  keyNoCollect, NO_COLLECT_WARN, hasStoredSecret, auditOutcome, noEndDot, installedReadText, TWO_PERSON_TARGETS, COLLECT_FEATURES, rotatePartialText, recordFailedText, stopDoneText, jobHeadText, jobLostText, revokeStartText, revokeOnceWarn,
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
  it('내 요청 판정 — 신원 비교(소문자 · AD 도메인 접두 · 접미 — 서버와 같은 규칙) · 내 이름을 모르면 잠그지 않는다(false)', () => {
    expect(isOwnRequest({ requestedBy: 'Kim.Admin' }, 'kim.admin ')).toBe(true);
    expect(isOwnRequest({ requestedBy: 'kim.admin' }, 'KIM.Admin')).toBe(true);   // 내 이름 쪽 대소문자도 접는다(변이 M1 이 살아남던 자리)
    expect(isOwnRequest({ requestedBy: 'kim.admin' }, 'park.sec')).toBe(false);
    expect(isOwnRequest({ requestedBy: 'kim.admin' }, '')).toBe(false);
    expect(isOwnRequest({ requestedBy: '' }, '')).toBe(false);
    expect(isOwnRequest(null, 'kim.admin')).toBe(false);
    // AD 별칭 — 같은 사람이 ‘CORP\\kim’ 으로 요청하고 ‘kim@corp.local’ 로 보면 내 요청이다(서버 점검 A2 와 같은 판정)
    expect(isOwnRequest({ requestedBy: 'CORP\\Kim.Admin' }, 'kim.admin@corp.local')).toBe(true);
    expect(identityKey('CORP\\Alice')).toBe('alice'); expect(identityKey('alice@corp.local')).toBe('alice'); expect(identityKey('@x')).toBe('@x');
    expect(identityKey(null)).toBe('');
    // 서버 store 가 실제로 같은 신원 비교를 쓴다(화면 잠금과 서버 403 이 같은 사람을 가리킨다) — 규칙 글자도 대조
    const store = serverSrc('approval/store.js');
    expect(store).toMatch(/identityKey\(who\) === identityKey\(r\.requestedBy\)\) return \{ ok: false, code: 'self-approve'/);
    expect(store).toMatch(/const bs = s\.lastIndexOf\('\\\\'\); if \(bs >= 0\) s = s\.slice\(bs \+ 1\);/);
    expect(store).toMatch(/const at = s\.indexOf\('@'\); if \(at > 0\) s = s\.slice\(0, at\);/);
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
  it('교체 중간 실패(partial) · 실행 결과 기록 실패(recordFailed) — 실패로만 말하지 않고 이미 된 것을 밝힌다(점검 E-9 · C-8)', () => {
    const p1 = rotatePartialText({ servers: ['s1', 's2'] });   // 공통 계정 단계 전에 멈춤
    expect(p1).toContain('서버 2대(공통 계정은 옮기기 전에 멈춤)가 새 키를 가리킵니다'); expect(p1).toContain('옛 키는 퇴역시키지 못했습니다');
    expect(rotatePartialText({ servers: ['s1'], accounts: 2 })).toContain('서버 1대 · 공통 계정 2개가 새 키를');
    expect(rotatePartialText({ servers: 'x', accounts: '3' })).toContain('서버 —(공통 계정은');   // 글자 수는 수로 읽지 않는다
    expect(rotatePartialText(undefined)).toBe(''); expect(rotatePartialText(null)).toBe('');
    // 서버가 그 모양으로 준다
    expect(serverSrc('bmusage/onboard/refs.js')).toMatch(/partial: \{ servers: r1\.ids \}/);
    expect(serverSrc('bmusage/onboard/refs.js')).toMatch(/partial: \{ servers: r1\.ids, accounts: r2\.changed \}/);
    expect(recordFailedText({ ok: true, recordFailed: true, recordReason: '디스크 가득' })).toContain('승인 기록에 적지 못했습니다(디스크 가득)');
    expect(recordFailedText({ ok: true, recordFailed: true })).toContain('이번 실행 자체는 됐습니다');
    expect(recordFailedText({ ok: true })).toBe(''); expect(recordFailedText({ recordFailed: 'true' })).toBe('');
    expect(serverSrc('approval/twoPerson.js')).toMatch(/recordFailed: true, recordReason:/);
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
  it('보호 장치 저장 실패 — 켠 것이 이미 적용됐으면(partial.applied) 그 사실을 먼저 말한다(점검 E-7)', () => {
    const t = guardFailText({ ok: false, code: 'no-approver', partial: { applied: ['serverRestrict'] } }, '승인할 수 있는 다른 설정 소유자가 없습니다');
    expect(t).toBe('서버 쪽 제한 — 켰습니다(적용됨). 끄는 변경은 하지 못했습니다: 승인할 수 있는 다른 설정 소유자가 없습니다');
    expect(guardFailText({ ok: false, reason: 'r' })).toBe('r');
    expect(guardFailText({ partial: { applied: [] } }, 'x')).toBe('x');
    expect(guardFailText(undefined, '')).toBe('실패했습니다');
    expect(serverSrc('sshaccess/service.js')).toMatch(/partial: \{ applied: Object\.keys\(on\) \}/);
  });
  it('키 변경 기록 — 감사 detail 의 ok:false · code · pending 을 칩으로(실패 · 거절을 성공처럼 그리지 않는다 · 점검 E1-5)', () => {
    expect(auditOutcome(JSON.stringify({ ok: false, code: 'demo' }))).toEqual({ label: '실패(demo)', tone: 'bad' });
    expect(auditOutcome(JSON.stringify({ ok: false }))).toEqual({ label: '실패', tone: 'bad' });
    expect(auditOutcome(JSON.stringify({ ok: true, pending: 'ap_1' }))).toEqual({ label: '승인 대기', tone: 'warn' });
    expect(auditOutcome(JSON.stringify({ ok: true }))).toBe(null);
    expect(auditOutcome('{"ok":false,"code":"de')).toBe(null);   // 400자에서 잘린 줄 — 지어내지 않는다
    expect(auditOutcome('')).toBe(null); expect(auditOutcome(null)).toBe(null); expect(auditOutcome('[1]')).toBe(null);
    expect(serverSrc('routes/api/sshAccess.js')).toMatch(/detail: JSON\.stringify\(detail\)\.slice\(0, 400\)/);
    const jsx = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
    expect(jsx).toMatch(/outcome: auditOutcome\(e\.detail\)/);
    expect(EVENT_TEXT['key-job-interrupted']).toBeTruthy();
  });
  it('서버에 들어 있는 키 다시 읽기 — ok:true + error 는 ‘0줄을 읽었습니다’(초록)가 아니라 확인 톤 · 마침표 둘 없음(점검 E1-6)', () => {
    const e = installedReadText({ ok: true, keys: [], error: '출력 머리 표지가 없습니다(셸 출력 섞임).' });
    expect(e.tone).toBe('warn'); expect(e.text).toBe('서버에 들어 있는 키를 읽지 못했습니다 — 출력 머리 표지가 없습니다(셸 출력 섞임).'); expect(e.text).not.toContain('..');
    expect(installedReadText({ ok: true, keys: [{}, {}], truncated: 3 })).toEqual({ text: '서버에 들어 있는 키 2줄을 읽었습니다 · 3줄은 상한을 넘어 읽지 않음.', tone: 'ok' });
    expect(installedReadText({ ok: true, keys: [] }).text).toBe('서버에 들어 있는 키 0줄을 읽었습니다.');
    expect(noEndDot('a..  ')).toBe('a'); expect(noEndDot(null)).toBe(''); expect(noEndDot('x'.repeat(500)).length).toBe(300);
    // 서버가 그 꼴로 준다(읽기 실패도 ok:true + error · 2회차부터 readFailed · 파일 없음은 missing — 읽기 실패가 아니다)
    expect(serverSrc('sshaccess/service.js')).toMatch(/keys: \[\], error: p\.reason, readFailed: true \};/);
    expect(serverSrc('sshaccess/service.js')).toMatch(/error: '', missing: !p\.present, bad: p\.bad \};/);
    expect(serverSrc('sshaccess/service.js')).toMatch(/missing: !!rec\.missing, readFailed: !!rec\.readFailed,/);
    // 2회차 E2-3 — 파일 없음은 중립(키 0개) · 못 읽음 · 일반 파일 아님만 확인 톤
    expect(installedReadText({ ok: true, keys: [], error: '', missing: true })).toEqual({ text: '서버 계정에 authorized_keys 파일이 없습니다(키 0개).', tone: 'muted' });
    const rf = installedReadText({ ok: true, keys: [], readFailed: true, error: 'authorized_keys 가 있지만 이 계정으로 읽을 수 없습니다(권한).' });
    expect(rf.tone).toBe('warn'); expect(rf.text).toContain('읽지 못했습니다 — authorized_keys 가 있지만');
    expect(installedReadText({ ok: true, keys: [], readFailed: true, error: '' }).text).toContain('사유를 받지 못함');
    expect(serverSrc('sshaccess/authorizedKeys.js')).toMatch(/echo '##AK unreadable'/);
  });
  it('작업을 잃었을 때(404) — 다시 붙은 작업은 ‘시작했지만’ 이라고 하지 않고 · 거두기에는 넣기용 ‘확인 · 되돌리기’ 문구를 쓰지 않는다(점검 E1-9)', () => {
    expect(jobHeadText(null, { stopped: true, own: false })).toBe('이 작업의 진행을 받지 못했습니다.');
    expect(jobHeadText(null, { stopped: false, own: false })).toBe('작업의 진행을 묻는 중…');
    expect(jobHeadText(null, { stopped: true })).toBe('작업을 시작했지만 진행을 받지 못했습니다.');
    const rv = jobLostText(404, '작업을 찾을 수 없습니다.', null, 'key-revoke');
    expect(rv).toContain('지우는 명령을 보냈는지 모릅니다'); expect(rv).not.toContain('되돌리기');
    expect(jobLostText(404, '', { kind: 'key-revoke', running: true, current: 'a' }, 'key-login')).toContain('지우는 명령을 보냈는지 모릅니다');   // 서버 job.kind 가 먼저
    expect(jobLostText(404, '', null, 'key-login')).toContain('확인 · 되돌리기 전에');
    const jsx = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
    expect(jsx).toMatch(/jobHeadText\(job, \{ stopped: kj\.stopped, own: kj\.own \}\)/);
    expect(jsx).toMatch(/jobLostText\(kj\.err\?\.status, kj\.err\?\.body\?\.reason \|\| kj\.err\?\.message, job, k\)/);
  });
  it('보호 장치 끄기 규칙 — 승인자 쌍을 본 설치(pairSeen)는 혼자 끌 수 없다 · 모르면 두 경우를 함께 말한다(반증 R3)', () => {
    expect(guardOffRuleText({ twoPerson: true, pairSeen: true })).toContain('혼자 끌 수 없습니다');
    expect(guardOffRuleText({ twoPerson: true, pairSeen: true })).not.toContain('본인 OTP 로 바로 꺼집니다');
    expect(guardOffRuleText({ twoPerson: true, pairSeen: false })).toContain('본인 OTP 로 바로 꺼집니다');
    expect(guardOffRuleText({ twoPerson: true })).toContain('확인한 적이 없는 포탈뿐');
    expect(guardOffRuleText({ unreadable: true, pairSeen: true })).toContain('읽지 못해');
    // 2회차 E2-2 — 인증을 끈 설치는 바로 꺼진다(서버 changeGuards: tpOn 거짓 → 곧바로 setGuards) · pairSeen 이어도 ‘혼자 끌 수 없음’ 이 아니다
    const ao = guardOffRuleText({ twoPerson: true, pairSeen: true, twoPersonActive: false }, { authOff: true });
    expect(ao).toContain('바로 꺼집니다'); expect(ao).not.toContain('혼자 끌 수 없');
    expect(guardOffRuleText(null)).toContain('승인을 거쳐');
    // 예전 규칙(목록에 다른 소유자가 있으면 거절)을 말하지 않는다 — 서버에서 listedOtherOwners 가 없어졌다
    for (const g of [{ pairSeen: true }, { pairSeen: false }, {}]) expect(guardOffRuleText(g)).not.toContain('목록에서 뺀 뒤');
    expect(serverSrc('sshaccess/guards.js')).not.toMatch(/export function listedOtherOwners/);
    expect(serverSrc('sshaccess/service.js')).toMatch(/if \(tpOn && ST\.getGuards\(\)\.pairSeen === true\) return partial\(noApproverIssue\(by\)\);/);
    expect(serverSrc('sshaccess/state.js')).toMatch(/pairSeen: j\.guards\?\.pairSeen === true/);
  });
  it('2회차 — 교체 수집 미허용 경고 · 폴더 · 기능 저장 문구(affectedServers) · 승인 상세의 새 키 기능 · 실행 여부 모름 · 이미 중지(E2-1 · E2-4)', () => {
    const from = { name: 'old', servers: 3, accountsUsing: 1 };
    const w = rotateNoCollectWarn(from, { name: 'disk-only', features: ['disk-audit'] });
    expect(w).toContain('새 키 ‘disk-only’ 는 베어메탈 사용률 · 스토리지 수집에 허용되지 않았습니다'); expect(w).toContain('서버 3대 · 공통 계정 1개');
    expect(rotateNoCollectWarn(from, { name: 'ok', features: ['bm-usage'] })).toBe('');
    expect(rotateNoCollectWarn(from, { name: 'legacy', features: null })).toBe('');   // 예전 키(모든 기능)
    expect(rotateNoCollectWarn({}, { name: 'x', features: [] })).toContain('옛 키를 쓰는 서버 · 공통 계정');   // 수를 모르면 수 없이
    expect(rotateNoCollectWarn(from, undefined)).toBe('');
    // 서버 — 교체 응답의 warning · 승인 본문의 toFeatures · noCollect(digest 에 묶임)
    const svc = serverSrc('sshaccess/service.js');
    expect(svc).toMatch(/payload: \{ from: a\.id, to: b\.id, fromName: a\.name, toName: b\.name, toFeatures, noCollect \}/);
    expect(svc).toMatch(/\{ \.\.\.r, warning: `새 키/);
    const cat = [{ id: 'disk-audit', label: '디스크 오류 이력 점검' }];
    const d1 = approvalDetail({ kind: 'ssh-key-rotate', payload: { fromName: 'old', toName: 'disk-only', toFeatures: ['disk-audit'], noCollect: true } }, (x) => x, cat);
    expect(d1).toContain('새 키의 쓸 수 있는 기능 디스크 오류 이력 점검'); expect(d1).toContain('주기 수집이 멈춥니다');
    expect(approvalDetail({ kind: 'ssh-key-rotate', payload: { fromName: 'a', toName: 'b' } })).not.toContain('쓸 수 있는 기능');   // 예전 요청 — 지어내지 않는다
    expect(approvalDetail({ kind: 'ssh-key-rotate', payload: { fromName: 'a', toName: 'b', toFeatures: null, noCollect: false } })).toContain('모든 기능(예전 방식)');
    // 폴더 · 기능 저장 — 서버 affectedServers
    expect(placementDoneText('k1', { ok: true, affectedServers: 4 }, { features: ['disk-audit'] })).toMatchObject({ tone: 'warn' });
    expect(placementDoneText('k1', { ok: true, affectedServers: 4 }, { features: ['disk-audit'] }).text).toContain('서버 4대는 이제 주기 수집이');
    expect(placementDoneText('k1', { ok: true, affectedServers: 2 }, { features: ['bm-usage'] })).toEqual({ text: 'k1 — 폴더 · 기능을 바꿨습니다. 이 키를 쓰는 서버 2대에 바로 적용됩니다.', tone: 'ok' });
    expect(placementDoneText('k1', { ok: true }, { features: ['disk-audit'] })).toEqual({ text: 'k1 — 폴더 · 기능을 바꿨습니다.', tone: 'ok' });
    expect(placementDoneText('k1', { ok: true, affectedServers: 0 }, { features: ['disk-audit'] }).tone).toBe('ok');
    expect(svc).toMatch(/return r\.ok && affectedServers != null \? \{ \.\.\.r, affectedServers \} : r;/);
    // 실행 여부 모름(interrupted) — ‘실행 실패’ 가 아니다
    expect(approvalStatusChip({ status: 'failed', result: { code: 'interrupted' } })).toEqual({ label: '실행 여부 모름', tone: 'warn' });
    expect(approvalStatusChip({ status: 'failed', result: { code: 'error' } })).toEqual({ label: '실행 실패', tone: 'bad' });
    expect(approvalStatusChip({ status: 'executed' })).toEqual({ label: '실행됨', tone: 'ok' });
    expect(approvalStatusChip(null)).toEqual({ label: '—', tone: 'muted' });
    expect(serverSrc('approval/store.js')).toMatch(/code: 'interrupted'/);
    // 이미 중지 — 기록을 다시 쓰지 않았다
    expect(stopDoneText({ ok: true, already: true }, 'KR')).toBe('KR — 이미 키 사용이 중지돼 있습니다(기록을 다시 쓰지 않았습니다).');
    expect(svc).toMatch(/return \{ ok: true, already: true, stop: ST\.stopFor\(c\) \|\| cur, added,/);
    // 그 뒤 등록된 서버를 더했으면 그 수 · 더하지 못했으면 서버 사유(3회차 E3-3)
    expect(stopDoneText({ ok: true, already: true, added: 2 }, 'KR')).toBe('KR — 이미 키 사용이 중지돼 있습니다. 그 뒤 등록된 서버 2대를 중지 기록에 더했습니다(사건은 다시 쓰지 않았습니다).');
    expect(stopDoneText({ ok: true, already: true, added: 0, reason: '이미 사용 중지 상태입니다 — 사건을 다시 쓰지 않았습니다(그 뒤 등록된 서버를 기록에 더하지 못했습니다 — 상태 파일).' }, 'KR')).toContain('더하지 못했습니다');
  });
  it('두 사람 승인 대상 목록 — 보호 장치 설명 · 끄기 안내가 같은 글자 하나 · 서버 SSH_KINDS 의 종류가 모두 들어 있다', () => {
    expect(GUARD_TEXT.twoPerson.note.startsWith(TWO_PERSON_TARGETS)).toBe(true);
    for (const w of ['키 등록', '받은 키 승인', '교체', '삭제', '법인 키 사용 재개', '키 저장소 다시 읽기', '보호 장치 끄기']) expect(TWO_PERSON_TARGETS).toContain(w);
    const jsx = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
    expect(jsx).toMatch(/두 사람 승인을 끄면 \$\{TWO_PERSON_TARGETS\}가/);
    expect(jsx).not.toContain('키 등록 · 교체 · 삭제 · 사용 재개가 본인 OTP 만으로');
  });
  it('사건 글자 — 서버가 남기는 종류(CRITICAL_EVENTS)는 전부 이름이 있다 · 새 파일의 내부 표지는 싣지 않는다 · 보호 장치 키는 화면 이름으로', () => {
    const m = /export const CRITICAL_EVENTS = Object\.freeze\(\[([^\]]+)\]\)/.exec(serverSrc('sshaccess/state.js'));
    for (const kind of m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)) expect(EVENT_TEXT[kind], kind).toBeTruthy();
    expect(eventDetail({ kind: 'guard-changed', detail: 'twoPerson=끔 · serverRestrict=켬' })).toBe('두 사람 승인 끔 · 서버 쪽 제한 켬');
    expect(eventDetail({ kind: 'approval-decided', detail: '승인 · 실행됨(요청 kim.admin)' })).toBe('승인 · 실행됨(요청 kim.admin)');
    expect(eventDetail({ kind: 'inbox-new', detail: 'vcA/common/x|abc\nvcA/common/y|def' })).toBe('');
    expect(eventDetail({ kind: 'key-login-set' })).toBe('');
    expect(eventDetail({ kind: 'key-revoke-done', detail: '3대 — 지움 2 · 줄 없음 0 · 실패 1 — bm-a1(connect)' })).toContain('실패 1');
    expect(eventDetail({ kind: 'inbox-seen', detail: 'abc123def456' })).toBe('');
    expect(HIDDEN_EVENT_KINDS).toContain('inbox-seen');
    // 서버가 남기는 사건 종류(service.js · state.js)는 전부 이름이 있다
    for (const src of [serverSrc('sshaccess/service.js'), serverSrc('sshaccess/state.js')]) {
      for (const m of src.matchAll(/(?:addEvents?\(|events\.push\(|pushEvents\(d, \[)\{ kind: '([a-z][a-z-]*)'/g)) expect(EVENT_TEXT[m[1]], m[1]).toBeTruthy();
    }
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
    // code 가 적히는 꼴 — ‘code: …’ · ‘code = …’ · ‘fail(…,’ 의 값 자리에서 글자 그대로('x') 또는 삼항의 결과(? 'x' · : 'x') — 삼항이 몇 겹이든 모두
    const lits = (expr) => [...expr.matchAll(/(?:^|\? |: )'([a-z][a-z-]*)'/g)].map((m) => m[1]);
    const codes = new Set();
    for (const m of src.matchAll(/\bcode(?: =|:) ([^;,\n]*)/g)) for (const c of lits(m[1])) codes.add(c);
    for (const m of src.matchAll(/\bfail\(([^,\n]*),/g)) for (const c of lits(m[1])) codes.add(c);
    // 작업을 시작 · 멈추지 못한 요청 오류(행 결과가 아니다 — 서버 reason 을 그대로 보인다)
    for (const skip of ['busy', 'revoking', 'empty', 'too-many', 'bad-kind', 'done']) codes.delete(skip);
    for (const must of ['ok', 'edge-delegated', 'install-failed', 'key-login-failed', 'bind-failed', 'revoke-failed', 'bad-key', 'removed', 'not-present', 'none', 'hostkey', 'auth-rejected', 'connect', 'timeout', 'uncertain', 'cancelled', 'error', 'key-pending', 'key-retired']) {
      expect(codes.has(must), `keyLogin.js 에서 ${must} 를 찾지 못함(추출 규칙 확인)`).toBe(true);
    }
    for (const c of codes) expect(JOB_CODE_TEXT[c], c).toBeTruthy();
    for (const c of ['moved', 'not-found', 'corp-stopped', 'key-folder', 'key-feature', 'key-tampered', 'state-unreadable']) expect(JOB_CODE_TEXT[c], c).toBeTruthy();
    // service.js 가 작업 행으로 내는 code(서버 · 키를 그 차례에 다시 읽음 · 상한) — 글자가 있다
    const svc = serverSrc('sshaccess/service.js');
    for (const c of ['moved', 'key-changed', 'over-limit', 'auth-skipped']) { expect(svc).toContain(`code: '${c}'`); expect(JOB_CODE_TEXT[c], c).toBeTruthy(); }
    // 작업 시작 409(행이 아니다 — 화면이 그 작업에 붙는다) — 넣기는 같은 키 거두기 중이면 revoking
    expect(src).toMatch(/code: 'revoking', status: 409, jobId: rv\.id/);
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
    // 제한을 켰는데 제한 없는 포탈 줄을 바꾸지 못했으면(지금 그 키로만 접속돼 — replaceSkipped) ‘적용’ 이라고 말하지 않고 확인 톤(점검 E-5)
    const present = keyLoginRow({ ok: true, code: 'ok', line: 'present-marked', restricted: false, replaceSkipped: true, bound: true, passwordRemoved: false, note: '제한 없는 포탈 줄이 있지만 …' }, { restrict: true });
    expect(present.parts.join(' ')).toContain('제한 없는 같은 키 줄이 서버에 남아 있습니다');
    expect(present.parts.join(' ')).not.toContain('출발지 제한 적용');
    expect(present.parts.join(' ')).not.toContain('저장 비밀번호 삭제');
    expect(present.tone).toBe('warn');
    // 제한이 다 붙은 기존 포탈 줄 — 서버는 restricted:true 로 준다(keyLogin exactOnly)
    expect(keyLoginRow({ ok: true, line: 'present-marked', restricted: true, bound: true }, { restrict: true })).toMatchObject({ tone: 'ok' });
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/const restricted = !!o\.restrict && \(added \|\| replaced \|\| exactOnly\) && !m\.unmarked && !m\.custom;/);
    // 사람이 넣은 줄만 있음(present-unmarked) · 표식 없는 줄 · 관리자가 바꾼 줄 + 제한 켬 — 메모가 없어도 초록으로 끝내지 않는다
    const human = keyLoginRow({ ok: true, line: 'present-unmarked', restricted: false, unmarked: 1, bound: true }, { restrict: true });
    expect(human.tone).toBe('warn'); expect(human.parts[0]).toContain('사람이 넣은 줄'); expect(human.parts.join(' ')).toContain('제한 없는 같은 키 줄');
    expect(keyLoginRow({ ok: true, line: 'added', restricted: false, unmarked: 0, custom: 1, bound: true }, { restrict: true }).tone).toBe('warn');
    expect(keyLoginRow({ ok: true, line: 'added', restricted: true, unmarked: 2, bound: true }, { restrict: true }).tone).toBe('warn');
    // 제한 없는(다른 주소의) 포탈 줄을 제한 줄로 바꿈(replaced) — 서버의 기존 줄을 바꿨다는 사실을 글자로(점검 E-4)
    const rep = keyLoginRow({ ok: true, line: 'replaced', restricted: true, fromIp: '192.0.2.9', bound: true }, { restrict: true });
    expect(rep).toMatchObject({ label: '완료', tone: 'ok' });
    expect(rep.parts[0]).toBe('제한 없는(또는 다른 주소의) 포탈 줄을 제한 줄로 바꾸고 키 접속 확인');
    expect(rep.parts[1]).toBe('출발지 제한 적용(192.0.2.9) · 포워딩 금지');
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/const replaced = m\.kind === 'replaced';/);
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
    // 명령을 보냈는데 답이 없음 — ‘결과 모름’(실패도 성공도 아니다) · ‘바꾼 것 없음’ 이라고 하지 않는다
    const unc = keyLoginRow({ ok: false, code: 'uncertain', reason: '서버가 시한 안에 답하지 않았습니다 바꾸는 명령은 서버에 보냈지만 결과를 받지 못했습니다' });
    expect(unc).toMatchObject({ label: '결과 모름', tone: 'bad' });
    expect(JOB_CODE_TEXT.uncertain).toContain('바뀌었을 수 있음'); expect(JOB_CODE_TEXT.uncertain).not.toContain('바꾼 것 없음');
    expect(keyLoginRow({ ok: false, code: 'uncertain' }).parts[0]).toBe(JOB_CODE_TEXT.uncertain);
    // 멈춤 · 작업 도중 키가 바뀜 — 시도하지 않음(실패와 따로)
    expect(keyLoginRow({ ok: false, code: 'cancelled', reason: '작업을 멈춰 이 서버는 하지 않았습니다.' })).toMatchObject({ label: '멈춤', tone: 'warn' });
    expect(keyLoginRow({ ok: false, code: 'key-changed', reason: 'x' })).toMatchObject({ label: '하지 않음', tone: 'warn' });
    // 실패 행의 서버 메모(notes 배열)도 보인다
    expect(keyLoginRow({ ok: false, code: 'key-login-failed', reason: 'r', notes: ['표식 없는 같은 키 줄 1개가 서버에 있습니다', 3] }).parts).toEqual(['r', '표식 없는 같은 키 줄 1개가 서버에 있습니다']);
  });
  it('키 거두기 — 지움 / 포탈 줄 없음 / 파일 없음 / 못 닿음 · 표식 없는 줄 · 아직 그 키로 고정된 서버는 확인 톤', () => {
    expect(keyRevokeRow({ ok: true, code: 'removed', removed: 2, unmarked: 0, pinned: false })).toEqual({ label: '지움', tone: 'ok', parts: ['포탈이 넣은 줄 2개 삭제'], rollback: '' });
    expect(keyRevokeRow({ ok: true, code: 'not-present', removed: 0, unmarked: 0 })).toMatchObject({ label: '포탈 줄 없음', tone: 'muted' });
    expect(keyRevokeRow({ ok: true, code: 'none', removed: 0, unmarked: 0 })).toMatchObject({ label: '파일 없음', tone: 'muted' });
    const left = keyRevokeRow({ ok: true, code: 'not-present', removed: 0, unmarked: 1 });
    expect(left.tone).toBe('warn'); expect(left.parts.join(' ')).toContain('표식 없는 같은 키 줄 1개 남음');
    // 아직 그 키를 쓰는 서버 — 이름 고정이든 공통 계정의 기본 키를 따르든(서버 serverUsesKey) 같은 문구
    const pinned = keyRevokeRow({ ok: true, code: 'removed', removed: 1, unmarked: 0, pinned: true });
    expect(pinned.tone).toBe('warn'); expect(pinned.parts.join(' ')).toContain('아직 이 키로 접속하도록 설정돼'); expect(pinned.parts.join(' ')).toContain('공통 계정의 기본 키');
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/const pinned = serverUsesKey\(server, key\.id\);/);
    expect(keyRevokeRow({ ok: false, code: 'connect', reason: '접속하지 못했습니다(timeout)' })).toEqual({ label: '못 닿음', tone: 'bad', parts: ['접속하지 못했습니다(timeout)'], rollback: '' });
    expect(keyRevokeRow({ ok: false, code: 'corp-stopped', reason: 'r' }).label).toBe('못 닿음');
    expect(keyRevokeRow({ ok: false, code: 'revoke-failed', reason: 'r' }).label).toBe('실패');
    expect(keyRevokeRow({ ok: false, code: 'edge-delegated', reason: 'r' })).toMatchObject({ label: '하지 않음', tone: 'warn' });
    // 심볼릭 링크 · 못 읽음 · 못 씀 — ‘파일 없음’(회색)이 아니라 실패(점검 B-F2b) · 서버 사유 그대로
    const link = keyRevokeRow({ ok: false, code: 'revoke-failed', why: 'symlink', reason: '~/.ssh 또는 authorized_keys 가 심볼릭 링크라 건드리지 않았습니다 — 서버에서 직접 확인하세요.', pinned: true });
    expect(link).toMatchObject({ label: '실패', tone: 'bad' }); expect(link.parts[0]).toContain('심볼릭 링크'); expect(link.parts.join(' ')).toContain('아직 이 키로 접속하도록');
    expect(keyRevokeRow({ ok: false, code: 'revoke-failed', why: 'symlink' }).parts).toEqual([JOB_CODE_TEXT['revoke-failed']]);
    // 결과 모름 · 멈춤 · 상한으로 빠짐 — 키 줄이 남았을 수 있다(위험 톤)
    expect(keyRevokeRow({ ok: false, code: 'uncertain', reason: 'r' })).toMatchObject({ label: '결과 모름', tone: 'bad' });
    expect(keyRevokeRow({ ok: false, code: 'cancelled', reason: 'r' })).toMatchObject({ label: '멈춤', tone: 'bad' });
    expect(keyRevokeRow({ ok: false, code: 'over-limit', reason: 'r' })).toMatchObject({ label: '빠짐(상한)', tone: 'bad' });
    expect(keyRevokeRow({ ok: false, code: 'timeout', reason: 'r' })).toMatchObject({ label: '못 닿음', tone: 'bad' });
    // 같은 공통 계정 비밀번호가 다른 서버에서 거부돼 건너뜀 — 거두기는 키 줄이 남았다(위험) · 넣기는 시도하지 않음(확인)
    expect(keyRevokeRow({ ok: false, code: 'auth-skipped', reason: 'r' })).toMatchObject({ label: '건너뜀', tone: 'bad' });
    expect(keyLoginRow({ ok: false, code: 'auth-skipped', reason: 'r' })).toMatchObject({ label: '건너뜀', tone: 'warn' });
    expect(keyRevokeRow({ ok: false, code: 'auth-skipped' }).parts[0]).toContain('계정 잠금 방지');
    // 잠금 · 경합(locked · raced)은 서버 사유 그대로 · 실패
    expect(keyRevokeRow({ ok: false, code: 'revoke-failed', why: 'locked', reason: '다른 작업이 이 서버의 authorized_keys 를 바꾸는 중이라' })).toMatchObject({ label: '실패', tone: 'bad', parts: ['다른 작업이 이 서버의 authorized_keys 를 바꾸는 중이라'] });
    expect(keyLoginRow({ ok: false, code: 'install-failed', reason: '바꾼 직후 다시 읽어 보니' }).parts).toEqual(['바꾼 직후 다시 읽어 보니']);
    // 연결이 종료 코드 없이 닫힘 — 서버가 uncertain 으로 준다
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/if \(m\.kind === 'nocode'\) return \{ \.\.\.base, ok: false, code: 'uncertain'/);
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
  it('작업 머리말 · 진행을 잃었을 때 — 더 묻지 못하게 된 뒤에는 ‘도는 중’ 처럼 말하지 않는다(점검 E-6)', () => {
    const run = { running: true, total: 10, current: 'bm-a3', results: [{}, {}, {}] };
    expect(jobHeadText(run)).toBe('진행 3 / 10대 — 지금 bm-a3 · 1대씩 차례로 합니다');
    expect(jobHeadText(run, { stopped: true })).toBe('마지막으로 받은 진행 3 / 10대 — 그때 처리 중 bm-a3 · 그 뒤는 모릅니다');
    expect(jobHeadText({ ...run, cancelled: true })).toContain('멈추는 중');
    expect(jobHeadText(null)).toContain('진행을 묻는 중');
    expect(jobHeadText(null, { stopped: true })).toBe('작업을 시작했지만 진행을 받지 못했습니다.');
    expect(jobHeadText({ running: false, doneAt: 0, cancelled: true, cancelledBy: 'kim', results: [] })).toBe('끝났습니다(—) — 도중에 멈춤(kim)');
    // 멈춘 사람이 빈 값 = 작업이 스스로 멈춤(1회 비밀번호가 두 번 거부됨 — 서버 job.stop · 사유는 ‘멈춤’ 줄)
    expect(jobHeadText({ running: false, doneAt: 0, cancelled: true, cancelledBy: '', results: [] })).toContain('작업이 스스로 멈춤');
    expect(jobHeadText({ running: true, total: 3, cancelled: true, cancelledBy: '', results: [{}] })).toContain('멈추는 중(작업이 스스로 멈춤)');
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/job\.cancelled = true; job\.cancelledBy = ''; job\.cancelWhy = t\(why, 120\);/);
    expect(jobHeadText({ running: true, total: null, results: [] })).toContain('0 / —');
    const lost = jobLostText(404, '작업을 찾을 수 없습니다(… 포탈이 다시 시작했습니다 …)', run);
    expect(lost).toContain('작업을 찾을 수 없습니다'); expect(lost).toContain('마지막으로 본 처리 중 서버는 bm-a3');
    expect(lost).toContain('서버에 들어 있는 키 다시 읽기'); expect(lost).not.toContain('계속됐을 수 있습니다');
    expect(jobLostText(404, '', null)).not.toContain('마지막으로 본');
    expect(jobLostText(0, 'Failed to fetch', run)).toContain('작업은 서버에서 계속되고 있을 수 있습니다');
    // 숫자 상한(1시간)을 화면에 박지 않는다 — 서버 사유에 있다
    expect(jobLostText(404, '', run)).not.toMatch(/\d+\s*시간/);
  });
  it('키 거두기 시작 · 1회 비밀번호 주의 — 멈춘 넣기 작업 · 상한으로 빠진 서버 · 법인 전 서버에 같은 비밀번호(점검 E-10 · E-13)', () => {
    const t = revokeStartText({ ok: true, total: 500, stopped: 'kj_x', skipped: [{ code: 'over-limit' }, { code: 'over-limit' }, { code: 'edge-delegated' }] });
    expect(t).toContain('서버 500대에 1대씩'); expect(t).toContain('키 로그인 설정 작업을 멈췄습니다'); expect(t).toContain('상한을 넘은 서버 2대'); expect(t).toContain('엣지가 수집하는 서버 1대');
    expect(revokeStartText({ ok: true, total: 3, skipped: [] })).not.toContain('멈췄습니다');
    expect(revokeStartText({})).toContain('서버 —에');
    expect(serverSrc('sshaccess/service.js')).toMatch(/code: 'over-limit'/);
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/return \{ ok: true, jobId: id, \.\.\.\(stopped \? \{ stopped \} : \{\}\) \};/);
    expect(revokeOnceWarn(12)).toContain('이 법인 서버 12대 전부에'); expect(revokeOnceWarn(12)).toContain('저장된 인증으로 되던 서버도');
    expect(revokeOnceWarn(null)).toContain('이 법인 서버 전부에');
    expect(revokeOnceWarn(3)).toContain('두 서버에서 거부되면 작업이 스스로 멈추고');
    expect(serverSrc('sshaccess/service.js')).toMatch(/if \(pw\) \{ onceRejects \+= 1; if \(onceRejects >= 2\) job\?\.stop\(/);
    // 서버 — 1회 비밀번호가 있으면 저장 인증 대신 그것으로 붙는다(firstLegAuth(server, o.oncePassword))
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/const auth = firstLegAuth\(server, o\.oncePassword\);/);
  });
  it('법인 사용 중지 결과 — 등록부를 못 읽어 법인으로만 걸렸으면 그렇게 말한다(점검 E-8)', () => {
    expect(stopDoneText({ ok: true, servers: 5, edgeServers: 2 }, 'KR-SEL')).toBe('KR-SEL — 키 사용을 중지했습니다(이 노드가 접속하는 서버 5대를 함께 적음). 엣지가 수집하는 서버 2대는 그 엣지 포탈에서 따로 중지해야 합니다.');
    const u = stopDoneText({ ok: true, servers: 0, edgeServers: 0, registryUnreadable: true }, 'KR-SEL');
    expect(u).toContain('(법인으로만)'); expect(u).toContain('빠질 수 있습니다'); expect(u).not.toContain('0대');
    expect(stopDoneText({ ok: true }, 'X')).toBe('X — 키 사용을 중지했습니다.');
    expect(serverSrc('sshaccess/service.js')).toMatch(/\.\.\.\(regErr \? \{ registryUnreadable: true \} : \{\}\)/);
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
    // 비밀번호로 고정됐는데 서버 · 공통 계정 어디에도 비밀번호가 없는 서버도 ‘수단 없음’ 으로 센다(점검 E1-10 — keyMode 만 보면 ‘password’ 라 놓쳤다)
    const p = [{ id: 'p1', keyMode: 'password', hasPassword: false, accountName: '' }, { id: 'p2', keyMode: 'password', hasPassword: false, accountName: 'kr-acc' }, { id: 'p3', keyMode: 'password', hasPassword: true }];
    expect(savedAuthHints(p, { accounts: [{ name: 'kr-acc', hasPassword: true }] })).toEqual([expect.stringContaining('서버 1대는 저장된 인증 수단이 없습니다')]);
    expect(savedAuthHints(p, { accounts: [{ name: 'kr-acc', hasPassword: false }] })[0]).toContain('서버 2대는 저장된 인증 수단이 없습니다');
    expect(hasStoredSecret({ keyMode: 'password', hasPassword: false }, [])).toBe(false);
    expect(hasStoredSecret({ keyMode: 'password' }, [])).toBe(null);   // 칸이 없으면 모름 — 세지 않는다
    expect(hasStoredSecret({ keyMode: 'password', hasPassword: false, accountName: 'gone' }, [])).toBe(null);   // 공통 계정 목록에 없으면 모름
    expect(hasStoredSecret({ keyMode: 'corp-default' })).toBe(true);
    expect(hasStoredSecret({ keyMode: 'none' })).toBe(false);
    expect(hasStoredSecret({ keyMode: 'password', hasSecret: true, hasPassword: false })).toBe(true);   // 서버가 hasSecret 를 주면 그것
    expect(hasStoredSecret(null)).toBe(null);
    // 서버 표 칩도 같은 판정 — 공통 계정 목록을 받지 못했으면 가르지 않는다
    expect(serverStatus({ keyMode: 'password', hasPassword: false }, { accounts: [] })).toMatchObject({ label: '인증 수단 없음', tone: 'bad' });
    expect(serverStatus({ keyMode: 'password', hasPassword: false }, {})).toMatchObject({ label: '비밀번호' });
    // 서버 응답 칸(이 판정이 읽는 것)
    expect(serverSrc('sshaccess/service.js')).toMatch(/hasPassword: !!s\.password, passwordPinned: s\.osAuth === 'password',/);
  });
  it('수집 미허용 키 — 판정 하나(keyNoCollect)를 키 고르기 · 키 로그인 창 · 후보 목록 · 서버 표가 함께 쓴다 · 그 경우 비밀번호 지우기 기본 끔(점검 E1-1)', () => {
    expect(keyNoCollect(['disk-audit'])).toBe(true);
    expect(keyNoCollect(['disk-audit', 'bm-usage'])).toBe(false);
    expect(keyNoCollect([])).toBe(true);
    expect(keyNoCollect(null)).toBe(false);   // 예전 키(모든 기능)
    expect(keyNoCollect(undefined)).toBe(false);
    expect([...COLLECT_FEATURES]).toEqual(['bm-usage', 'bm-storage']);
    expect(NO_COLLECT_WARN).toContain('수집이 멈춥니다');
    expect(serverStatus({ keyMode: 'pinned', keyFeatures: ['disk-audit'] })).toMatchObject({ label: '수집 기능 미허용', tone: 'warn' });
    const jsx = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
    expect(jsx).not.toMatch(/COLLECT_FEATURES\.some/);   // 판정을 화면에 다시 쓰지 않는다
    expect(jsx).toMatch(/const noCollect = !!key && keyNoCollect\(key\.features\);/);          // 키 로그인 창
    expect(jsx).toMatch(/const noCollect = !!chosenKey && keyNoCollect\(chosenKey\.features\);/);  // 키 고르기 창
    expect(jsx).toMatch(/const removePw = removePwSet \?\? !noCollect;/);
    expect(jsx).toMatch(/keyNoCollect\(k\.features\) \? ' · 수집 미허용' : ''/);                // 넣을 키 목록
    expect(jsx).toMatch(/k\.selectable && keyNoCollect\(k\.features\) && <Chip tone="warn"/);    // 키 고르기 후보
    // 근거 — 서버 넣기 판정은 기능을 보지 않는다(conn-test) · 확인 뒤 서버를 그 키에 묶는다
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/keyPlacementIssue\(key, server, 'conn-test'\)/);
  });
});

describe('SSH 공용 접속 화면 — 규약', () => {
  const src = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
  it('2단계(v3.10.0) — 작업 진행은 도는 동안에만 묻고 · 떠나면 멈추고 · 늦은 응답은 버린다(주기 폴링 없음)', () => {
    expect(src).not.toMatch(/setInterval\(/);
    expect(src).not.toMatch(/usePolling/);
    expect(src).toMatch(/if \(r\.job\?\.running\) \{ sawRunning\.current = true; timer\.current = setTimeout\(\(\) => ask\(id, g\), JOB_POLL_MS\); \}/);
    expect(src).toMatch(/const JOB_POLL_MS = 2000;/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{ gen\.current \+= 1; clearTimeout\(timer\.current\); \}, \[\]\)/);
    expect((src.match(/if \(g !== gen\.current\) return;/g) || []).length).toBeGreaterThanOrEqual(2);
    // 못 물으면 끝없이 묻지 않는다(상한 · 404 는 바로 멈춤)
    expect(src).toMatch(/e\?\.status === 404 \|\| e\?\.status === 403 \|\| fails\.current >= JOB_POLL_MAX_FAILS/);
  });
  it('2단계 점검 E-2 · E-6 — 작업은 화면을 다시 열어도 이어 보고(v.jobs) · 이미 끝난 작업에 다시 붙으면 다시 읽지 않고 · 도는 동안 멈추기(OTP 없음)', () => {
    expect(src).toMatch(/v\.jobs\?\.revokes/);   // 1시간 안의 거두기 작업 목록(키마다) — 다른 사람이 돌린 거두기도 칸으로
    expect(src).toMatch(/for \(const id of revokeIds\.split\(','\)\.filter\(Boolean\)\.reverse\(\)\) addRevokeJob\(id\)/);
    expect(src).toMatch(/\{!kl && v\.jobs\?\.install\?\.id && !jobsUi\.closed\.has\(v\.jobs\.install\.id\) && <JobPanel key=\{v\.jobs\.install\.id\} jobId=\{v\.jobs\.install\.id\} kind="key-login"/);
    // 거두기는 키마다 따로 돈다 — 칸을 여럿(작업 id 마다 하나 · key={id})
    expect(src).toMatch(/\{rvJobs\.filter\(\(j\) => !jobsUi\.closed\.has\(j\.id\)\)\.map\(\(j\) => <JobPanel key=\{j\.id\} jobId=\{j\.id\} kind="key-revoke"/);
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/kind === 'key-revoke' \? `revoke:\$\{t\(keyId, 32\)\}`/);
    expect(src).toMatch(/const kj = useKeyJob\(\(job, o\) => \{ if \(o\.wasRunning\) onDone\?\.\(job\); \}\);/);
    // 멈추기 — 넣기는 OTP 없이 · 거두기는 본인 OTP(본문)
    expect(src).toMatch(/must\(await postJson\(`\/settings\/ssh-access\/jobs\/\$\{encodeURIComponent\(kj\.id\)\}\/cancel`, needOtp \? \{ otp \} : \{\}\)\)/);
    expect(src).toContain('키 거두기를 멈추면 아직 하지 않은 서버에는 그 키 줄(유출이 의심되는 키)이 그대로 남아');
    // 서버 — 화면 자료에 칸마다 마지막 작업 · 멈추기 라우트는 거두기만 reauth
    expect(serverSrc('sshaccess/service.js')).toMatch(/jobs: KL\.lastJobs\(\),/);
    // 멈추기 OTP 판정(서버 하나) — 거두기 · 옛 키 교체가 붙은 넣기(화면 needOtp 와 같은 기준)
    expect(serverSrc('routes/api/sshAccess.js')).toMatch(/const cancelGate = \(req, res, next\) => \(SVC\.keyJobCancelNeedsOtp\(t\(req\.params\.id, 20\)\) \? reauth\(req, res, next\) : next\(\)\);/);
    expect(serverSrc('sshaccess/keyLogin.js')).toMatch(/return !!j && \(j\.kind === 'key-revoke' \|\| !!j\.meta\?\.replaceKeyId\);/);
    expect(serverSrc('routes/api/sshAccess.js')).toMatch(/api\.post\('\/settings\/ssh-access\/jobs\/:id\/cancel', \.\.\.ownerRead, (?:fullRW, )?cancelGate,/);
    // 결과 표는 작업마다 새로(멈추기 문구 · OTP 칸이 다른 작업에 남지 않게) — 넣기 창 · 작업 칸
    expect((src.match(/<KeyJobResult key=\{kj\.id\} kj=\{kj\}/g) || []).length).toBe(2);
    // 넣기 창 — 409 busy · revoking 에 jobId 가 오면 그 작업에 붙는다(이 창의 설정은 시작하지 않았다고 말한다)
    expect(src).toMatch(/\(code === 'busy' \|\| code === 'revoking'\) && typeof e\?\.body\?\.jobId === 'string'/);
    expect(src).toMatch(/if \(otherJob\) \{ started\.current = true; setForeign\(code\); kj\.start\(otherJob, \[\], \{ own: false \}\); \}/);
    // 결과 줄은 작업의 실제 종류로(넣기 창이 거두기 작업에 붙어도 거두기 글자)
    expect(src).toMatch(/const k = job\?\.kind === 'key-revoke' \|\| job\?\.kind === 'key-login' \? job\.kind : kind;/);
    // 혼자 끌 수 없는 설치의 no-approver 사유에는 보호 장치 스위치를 가리키지 않는다
    expect(src).toMatch(/!String\(base\)\.includes\('혼자 끌 수 없'\)/);
    expect(serverSrc('sshaccess/service.js')).toContain('두 사람 승인을 혼자 끌 수 없습니다');
    // 진행을 잃은 뒤에는 ‘계속됐을 수 있습니다 · 기록에도 남습니다’ 로 단정하지 않는다
    expect(src).not.toContain('결과는 키 보안 › 키 변경 기록에도 남습니다');
  });
  it('1회차 E1-2 · E1-4 · E1-7 · E1-8 · A4 · 정보 — 1440 표 폭 · 인증 꺼짐 표시 · 닫은 작업 칸 기억 · 옛 키 교체 작업 멈추기 OTP · 모르는 스위치', () => {
    // E1-2 — 1440 에서 동작 열이 가로 스크롤 뒤로 숨지 않게(docs/rules/web.md v2.780) — 표 최소 폭을 칸(약 896px) 아래로 · 칸 여백 · 긴 칸 줄바꿈
    expect(src).toMatch(/<STable minWidth=\{820\} className="ssa-t ssa-srvt">/);
    expect(src).toMatch(/<STable minWidth=\{820\} className="ssa-t ssa-appr">/);
    expect(src).toMatch(/<STable minWidth=\{820\} className="ssa-t ssa-apprd" limit=\{10\}>/);
    for (const m of src.matchAll(/<STable minWidth=\{(\d+)\}/g)) expect(Number(m[1])).toBeLessThanOrEqual(880);
    const css = fs.readFileSync(path.join(HERE, 'sshAccess.css'), 'utf8');
    expect(css).toMatch(/\.ssa-t thead th, \.ssa-t tbody td \{ padding-left: 10px; padding-right: 10px; \}/);
    expect(css).toMatch(/\.ssa-keys td:nth-child\(2\) \{ white-space: normal;/);
    // E1-4 — 인증을 끈 설치: 켬(적용 안 됨) · ‘본인 OTP 만으로’ 라고 하지 않는다
    expect(src).toMatch(/const authOff = !g\.unreadable && g\.twoPerson === true && g\.twoPersonActive === false;/);
    expect(src).toContain('켬(적용 안 됨)');
    expect(src).not.toContain('두 사람 승인이 적용되지 않고 본인 OTP 만으로 실행됩니다');
    expect(src).toMatch(/\$\{authOff \? '바로' : '본인 OTP 만으로'\}/);
    // 정보 — 값을 모르면 스위치를 그리지 않는다(role=switch 에 ‘모름’ 이 없다)
    expect(src).toMatch(/\{guardsKnown\n\s+\? <button type="button" role="switch"/);
    // E1-7 · E1-8 — 닫은 작업 칸은 서버가 다시 알려도 나타나지 않는다(화면이 열려 있는 동안)
    expect(src).toMatch(/const \[closedJobs, setClosedJobs\] = useState\(\(\) => new Set\(\)\);/);
    expect(src).toMatch(/if \(!id \|\| \(!force && closedRef\.current\.has\(id\)\)\) return;/);
    expect(src).toMatch(/rvJobs\.filter\(\(j\) => !jobsUi\.closed\.has\(j\.id\)\)\.map/);
    expect(src).toMatch(/onDismiss=\{\(\) => jobsUi\.close\(v\.jobs\.install\.id\)\}/);
    // A4 — 옛 키 교체가 붙은 넣기 작업 멈추기도 본인 OTP(서버 cancelGate 와 같은 기준)
    expect(src).toMatch(/const replacing = !isRevoke && !!\(meta\.replaceKeyId \|\| meta\.replaceKeyName\);/);
    expect(src).toMatch(/const needOtp = isRevoke \|\| replacing;/);
    expect(src).toMatch(/\/cancel`, needOtp \? \{ otp \} : \{\}\)/);
  });
  it('2회차 E2-1 · E2-2 · E2-5 · E2-6 · E2-7 · E2-10 · 정보 — 화면 배선', () => {
    // E2-1 — 교체 목록 표시 · 경고 · 서버 warning 은 확인 톤 · 편집 저장 문구는 affectedServers
    expect(src).toMatch(/rotateTargetOptions\(v, kact\.key\)\.map\(\(k\) => <option key=\{k\.id\} value=\{k\.id\}>\{keyOptionLabel\(k, corpName\)\}\{keyNoCollect\(k\.features\) \? ' · 수집 미허용' : ''\}/);
    expect(src).toMatch(/return r\.warning \? \{ text: `\$\{text\} ⚠ \$\{r\.warning\}`, tone: 'warn' \} : text;/);
    expect(src).toMatch(/\(r\) => placementDoneText\(edit\.key\.name, r, \{ features: edit\.features \}\)/);
    expect(src).toMatch(/say\(isObj \? out\.text : out, isObj && out\.tone \? out\.tone : r\.plaintextLeft \? 'bad' : r\.pending \? pendingTone\(r\) : 'ok'\)/);
    // E2-2 — 인증 꺼짐이면 pairSeen 줄을 숨기고 끄기 안내는 ‘바로’
    expect(src).toMatch(/guardOffRuleText\(g, \{ authOff \}\)/);
    expect(src).toMatch(/g\.pairSeen === true && !g\.unreadable && !authOff &&/);
    // E2-5 — 다시 설정에서 시도하지 않은 서버(접속처 · 키 바뀜 · 없음 · 엣지)는 뺀다
    expect(src).toMatch(/const NO_RETRY = new Set\(\['edge-delegated', 'moved', 'not-found', 'key-changed'\]\);/);
    expect(src).not.toContain('실패한 서버 {retryTargets.length}대만');
    // E2-6 — KPI · 쓰는 키 칸은 저장 수단 판정(hasStoredSecret)
    expect(src).toMatch(/s\.keyMode === 'password' && hasStoredSecret\(s, v\.storeUnreadable \? null : v\.accounts\) !== false/);
    expect(src).toContain("'비밀번호(저장 안 됨)'");
    // E2-7 — 법인 기본 키를 따름 = 공통 계정 기본 키로 수집 미허용 판정 · 기본 키가 사라졌으면 멈춘다고 말한다
    expect(src).toMatch(/choice === '' \? \(c\?\.corpDefault\?\.keyId \|\| null\) : choice/);
    expect(src).toMatch(/const corpKeyGone = !!c\?\.corpDefault\?\.keyId && !c\.corpDefault\.keyName;/);
    expect(serverSrc('sshaccess/service.js')).toMatch(/keyId: acc\.keyRef \|\| '', keyName: acc\.keyRef \? \(KS\.keyById\(acc\.keyRef\)\?\.name \|\| ''\) : ''/);
    // E2-10 — 직접 정리 안내는 그 공개키의 portal-ssh: 표식 줄 전부(키 id 무관)
    expect(src).toContain('‘portal-ssh:’ 표식이 붙은 줄 전부입니다 — 표식 뒤의 키 id 는 다를 수 있습니다');
    expect(src).not.toContain('표식 ‘portal-ssh:{meta.keyId}’ 가 붙은 줄');
    // 정보 — 작업 머리말은 live region 이 아니다 · 끝남만 숨은 칸(polite)이 알린다 · 받는 곳 읽는 중
    expect(src).not.toMatch(/<p className="ssa-note" role="status">\n\s+\{jobHeadText/);
    expect(src).toMatch(/<span className="ssa-sr" aria-live="polite">\{announce\}<\/span>/);
    expect(src).toMatch(/v\.inbox\?\.busy === true &&/);
    const css = fs.readFileSync(path.join(HERE, 'sshAccess.css'), 'utf8');
    expect(css).toMatch(/\.ssa-chip \{ margin-left: 4px; \}/);
    // 7b — 회전 폼도 같은 판정 · 두 사람 승인 409 뒤 ‘다시 붙여 넣으세요’ 가 아니라 SSH 공용 접속에서 요청
    const b7 = fs.readFileSync(path.join(HERE, 'tools', 'BmOnboardPanel.jsx'), 'utf8');
    expect(b7).toMatch(/import \{ rotatePartialText, keyNoCollect, rotateNoCollectWarn \} from '\.\.\/sshAccessText\.js';/);
    expect(b7).toMatch(/keyNoCollect\(k\.features\) \? ' · 수집 미허용' : ''/);
    expect(b7).toMatch(/r\.code === 'two-person-required' \? '키는 설정 › 보안 › SSH 공용 접속에서 등록을 요청하세요' : '다시 붙여 넣으세요'/);
  });
  it('2단계 점검 E-12 · E-15 · E-16 — 키 고르기 창은 저장 중 닫히지 않고 · OTP 는 주소 쿼리 · window.prompt 로 받지 않는다', () => {
    expect(src).toMatch(/closeRef\.current = \(\) => \{ if \(!lockedRef\.current\) onClose\(readDone\.current\); \};/);
    expect(src).toMatch(/disabled=\{!!busy\} onClick=\{\(\) => closeRef\.current\(\)\}/);
    expect(src).not.toMatch(/\?otp=/);
    expect(src).not.toMatch(/window\.prompt\([^)]*OTP/);
    expect((src.match(/sendJson\(`[^`]*`, 'DELETE', \{ otp: /g) || []).length).toBe(2);   // 키 삭제 · 법인 재개
    // 서버 reauth 는 본문을 먼저 본다(DELETE 본문으로 보낸 OTP 가 읽힌다)
    expect(serverSrc('routes/api/reauth.js')).toMatch(/req\.body\?\.otp \?\? req\.query\?\.otp/);
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
    const calls = [...src.matchAll(/await (postJson|putJson|delJson|sendJson)\(/g)].length;
    const wrapped = [...src.matchAll(/must\(await (postJson|putJson|delJson|sendJson)\(/g)].length;
    expect(calls).toBe(wrapped);
    expect([...src.matchAll(/run\(\(\) => (postJson|putJson|delJson|sendJson)\(/g)].length).toBeGreaterThan(0);
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
