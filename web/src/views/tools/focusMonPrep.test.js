// v3.18.0 접속 자동 준비 — 행 판정 · 결과 문구(순수). 서버 까닭 이름과의 1:1 은 server/test/focusMonPrep3180.test.js ⑦ 이 본다.
import { describe, it, expect } from 'vitest';
import { prepRowState, prepResultText, loginText, loginOk, prepCredText, keyLinePreview } from './focusMonPrepText.js';

const row = (o = {}) => ({ id: 'fm-1', name: 'a', username: 'dvcmon', login: { kind: null }, cred: { state: 'ok', key: 'k1', acct: 'root' }, credInstall: { state: 'ok', key: 'k1' }, hostShared: false, job: null, ...o });

describe('prepRowState', () => {
  it('키 로그인이 되면 할 일 없음(고를 수 없음)', () => {
    for (const kind of ['ok', 'os-unverified']) { const s = prepRowState(row({ login: { kind } })); expect(s.settled).toBe(true); expect(s.can).toBe(false); }
  });
  it('거부 · 시험한 적 없음은 할 수 있음 — 같은 키가 ‘설치’ 도 켰으면 디스크 점검 함께', () => {
    for (const kind of ['auth', 'auth-stopped', null, 'unreachable']) { const s = prepRowState(row({ login: { kind } })); expect(s.can).toBe(true); expect(s.audit.can).toBe(true); }
  });
  it('못 하는 까닭 — 작업 중 · root · 호스트키 · 계정 상태 · 고르지 않음', () => {
    expect(prepRowState(row({ job: { state: 'queued' } })).why).toBe('이미 작업이 진행 중');
    expect(prepRowState(row({ username: 'root' })).why).toBe('수집 계정이 root');
    expect(prepRowState(row({ login: { kind: 'hostkey' } })).why).toBe('호스트키 승인 먼저');
    expect(prepRowState(row({ cred: { state: 'feature' } })).why).toBe('키에 ‘접속 준비’ 가 꺼짐');
    expect(prepRowState(row({ cred: { state: 'edge-unknown' } })).why).toBe('엣지가 아직 알려 오지 않음');
    const amb = row({ cred: { state: 'ambig', choices: [{ id: 'a1' }, { id: 'a2' }] } });
    expect(prepRowState(amb).why).toBe('공통 계정을 고르지 않음');
    expect(prepRowState(amb, 'a2').can).toBe(true);
    expect(prepRowState(amb, 'zz').can).toBe(false);
  });
  it('반증 D4 · D7 — 준비 계정 자신이면 못 함 · 공통 계정을 고르는 행은 함께 설치를 단정하지 않는다', () => {
    expect(prepRowState(row({ username: 'dvcadmin', cred: { state: 'ok', acct: 'dvcadmin', key: 'k1' } })).why).toBe('수집 계정이 준비 계정 자신');
    const amb = row({ cred: { state: 'ambig', choices: [{ id: 'a1' }] }, credInstall: { state: 'ambig' } });
    const a = prepRowState(amb, 'a1').audit; expect(a.can).toBe(true); expect(a.maybe).toBe(true); expect(a.why).toContain('노드가 판단');
    const b = prepRowState(row({ cred: { state: 'ok', key: 'k1', acct: 'root' }, credInstall: { state: 'ambig' } })).audit; expect(b.maybe).toBe(true);
  });
  it('디스크 점검 함께 — 같은 주소 다른 계정 · ‘설치’ 꺼짐 · 다른 키면 준비만', () => {
    expect(prepRowState(row({ hostShared: true })).audit).toEqual({ can: false, why: '같은 주소에 다른 수집 계정 — 손으로 설치' });
    expect(prepRowState(row({ credInstall: { state: 'feature' } })).audit.why).toBe('그 키에 ‘설치’ 가 꺼져 있음');
    expect(prepRowState(row({ credInstall: { state: 'noentry' } })).audit.why).toBe('설치 계정이 정해지지 않음');
    expect(prepRowState(row({ credInstall: { state: 'ok', key: 'k2' } })).audit.why).toBe('설치에 다른 키를 씀 — 디스크 점검 탭에서');
    expect(prepRowState(row({ cred: { state: 'feature' } })).audit.can).toBe(false);
  });
});

describe('결과 · 로그인 문구', () => {
  it('prepResultText — 한 일 · 디스크 점검 · 경고 · 고칠 곳', () => {
    const t = prepResultText({ code: 'ok', created: true, added: true, from: true, audit: 'done', warn: ['home-perm'] });
    expect(t.tone).toBe('ok'); expect(t.label).toBe('준비됨 — 키 로그인 확인');
    expect(t.sub).toContain('계정 만듦'); expect(t.sub).toContain('공개키 넣음'); expect(t.sub).toContain('주소 제한'); expect(t.sub).toContain('이어서 설치함'); expect(t.sub).toContain('StrictModes');
    const s = prepResultText({ code: 'script', fail: 'sshd-allow' });
    expect(s.tone).toBe('bad'); expect(s.label).toBe('준비 파일이 멈춤 — sshd AllowUsers 에 이 계정이 없음'); expect(s.sub).toContain('포탈은 바꾸지 않았습니다');
    expect(prepResultText({ code: 'login', exists: true, have: true }).tone).toBe('warn');
    // 반증 D6 · D2 — 계정을 만든 뒤 멈췄으면 '바꾸지 않았다' 고 하지 않는다 · 넣지 않았으면 주소 제한이라 하지 않는다
    const c = prepResultText({ code: 'script', fail: 'no-runuser', created: true });
    expect(c.sub).toContain('계정은 생겼습니다'); expect(c.sub).not.toContain('포탈은 바꾸지 않았습니다');
    expect(prepResultText({ code: 'script', fail: 'acct-create', partial: true }).sub).toContain('홈을 만들지 못함');
    const d = prepResultText({ code: 'ok', exists: true, differs: true, from: false, fromAsked: true });
    expect(d.sub).toContain('다른 옵션'); expect(d.sub).toContain('주소 제한은 적용되지 않음'); expect(d.sub).not.toMatch(/(^| · )주소 제한( · |$)/);
    expect(prepResultText(null)).toBe(null);
  });
  it('loginText · loginOk · prepCredText · 미리 보기', () => {
    expect(loginText({ kind: null }).label).toBe('시험한 적 없음');
    expect(loginText({ kind: 'auth-stopped' }).tone).toBe('bad');
    expect(loginOk({ kind: 'os-unverified' })).toBe(true); expect(loginOk({ kind: 'auth' })).toBe(false);
    expect(prepCredText({ state: 'nope' }).label).toBe('모름 — 해석 오류');
    expect(keyLinePreview(true)).toContain('restrict,from='); expect(keyLinePreview(false).startsWith('restrict <')).toBe(true);
  });
});
