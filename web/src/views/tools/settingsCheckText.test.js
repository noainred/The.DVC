/**
 * settingsCheckText 회귀(v2.553) — 이 화면이 만들 수 있는 거짓을 막는 것이 목적이다:
 *   ① 측정값·확인 깊이를 넘어 '정상' 이라 말하기  ② 틀린 조언(v2.525 실제 사고)
 *   ③ 백틱이 글자로 새기(v2.545 실제 사고)        ④ 같은 말로 화면을 덮기(v2.509)
 */
import { describe, it, expect } from 'vitest';
import {
  SEVERITY_LABEL, severityTone, remedyText, targetState, STATE_LABEL, stateTone,
  kpisOf, depthNote, depthReached, headerNote, groupRows, settingsLinkOf, tableFootnotes,
} from './settingsCheckText.js';

const ALL_CODES = [
  'address-empty', 'address-unparsable', 'address-whitespace', 'scheme-in-host', 'scheme-missing',
  'ldap-scheme-wrong', 'path-in-host', 'no-password', 'no-token', 'no-username', 'ssh-port-443',
  'api-port-22', 'ssrf-blocked', 'duplicate-host', 'webhook-plain-http', 'ad-plain-ldap',
  'smtp-no-from', 'dataplane-basepath', 'site-no-agent', 'central-direct', 'disabled', 'failed',
  'auth-required-ok', 'probe-path-404', 'cert-expiring', 'cert-expired', 'cert-untrusted',
  'ssh-banner', 'smtp-no-starttls',
];
const FACTS = {
  address: '10.1.1.1', stripped: '10.1.1.1', host: '10.1.1.1', reason: 'r', basePath: '/v3',
  days: 5, count: 2, port: 443, status: 401, path: '/x', banner: 'SSH-2.0-OpenSSH_8.0',
  fix: '조치', phase: 'tcp', error: '오류', username: 'u', subject: 's', issuer: 'i',
  authError: 'self signed', method: 'ssh', form: 'url',
};

describe('해결책 문구 — 모든 코드에 제목이 있고 백틱이 없다', () => {
  it('제목이 비지 않는다', () => {
    for (const code of ALL_CODES) {
      expect(remedyText({ code, facts: FACTS }, { hostForm: 'host' }).title, code).toBeTruthy();
    }
  });
  it('백틱을 쓰지 않는다(BoldText 가 글자로 흘린다 — v2.545)', () => {
    for (const code of ALL_CODES) {
      const r = remedyText({ code, facts: FACTS }, { hostForm: 'host' });
      const all = `${r.title} ${r.detail} ${r.action}`;
      expect(all.includes('`'), code).toBe(false);
    }
  });
  it('알 수 없는 코드는 지어내지 않는다', () => {
    const r = remedyText({ code: 'nope' });
    expect(r.title).toBe('nope');
    expect(r.detail).toBe('');
    expect(r.action).toBe('');
  });
  it('조치가 없는 발견은 action 이 빈 문자열이다', () => {
    for (const code of ['central-direct', 'disabled', 'cert-untrusted', 'ssh-banner', 'probe-path-404']) {
      expect(remedyText({ code, facts: FACTS }).action, code).toBe('');
    }
  });
});

describe('⚠ 틀린 조언 방지 — 종류마다 정답 형식이 다르다(v2.525)', () => {
  it('주소만 쓰는 종류: 스킴을 빼라고 말한다', () => {
    const r = remedyText({ code: 'scheme-in-host', facts: { address: 'https://10.1.1.1', stripped: '10.1.1.1' } }, { hostForm: 'host' });
    expect(r.action).toContain('10.1.1.1');
    expect(r.detail).toContain('주소만');
  });
  it('URL 이 필수인 종류: 스킴을 붙이라고 말한다(반대 방향)', () => {
    const r = remedyText({ code: 'scheme-missing', facts: { address: 'hz.corp' } }, { hostForm: 'url' });
    expect(r.action).toContain('https://hz.corp');
    expect(r.detail).toContain('필수');
  });
  it('형식을 모르면 형식 문장을 만들지 않는다', () => {
    const r = remedyText({ code: 'address-empty' }, {});
    expect(r.action).not.toContain('이 종류는');
  });
});

describe('무인증 401 은 정상이라고 말한다', () => {
  it('그리고 계정 확인 방법을 알려준다', () => {
    const r = remedyText({ code: 'auth-required-ok', facts: { status: 401 } });
    expect(r.title).toContain('정상');
    expect(r.action).toContain('연결 테스트');
  });
});

describe('행 상태 — 측정값이 없으면 정상이 아니다', () => {
  it('설정 blocker 가 있으면 config(주의색)', () => {
    expect(targetState({ findings: [{ code: 'scheme-in-host', severity: 'blocker' }] }, { enabled: true }).state).toBe('config');
  });
  it('failed 는 config 가 아니라 fail 이다(중복 분류 금지)', () => {
    expect(targetState({ latest: { ok: false }, findings: [{ code: 'failed', severity: 'blocker' }] }, { enabled: true }).state).toBe('fail');
  });
  it('측정값이 없으면 no-data 이고 이유가 다르다', () => {
    expect(targetState({}, { enabled: false }).short).toContain('꺼짐');
    expect(targetState({}, { enabled: true, settingsCheck: false }).short).toContain('꺼짐');
    expect(targetState({ agent: 'GM1' }, { enabled: true, settingsCheck: true }).short).toBe('엣지 위임');
    expect(targetState({}, { enabled: true, settingsCheck: true }).short).toBe('첫 주기 대기');
  });
  it('비활성은 별도 상태다', () => {
    expect(targetState({ enabled: false }).state).toBe('disabled');
  });
  it('no-data·config 색이 정상·실패와 다르다', () => {
    expect(stateTone('no-data')).toMatch(/muted/);
    expect(stateTone('config')).toMatch(/warn/);
    expect(stateTone('ok')).not.toBe(stateTone('fail'));
    expect(STATE_LABEL.config).not.toBe(STATE_LABEL['no-data']);
  });
});

describe('KPI — 다섯 칸이 겹치지 않는다', () => {
  const rows = [
    { latest: { ok: true }, findings: [] },
    { latest: { ok: false }, findings: [{ code: 'failed', severity: 'blocker' }] },
    { findings: [{ code: 'scheme-in-host', severity: 'blocker' }] },
    { findings: [{ code: 'cert-expiring', severity: 'warn' }] },
    { enabled: false, findings: [] },
  ];
  it('합계 항등식', () => {
    const k = kpisOf(rows, { enabled: true, settingsCheck: true });
    expect(k.ok + k.fail + k.config + k.nodata + k.disabled).toBe(k.total);
  });
  it('정상률 분모는 측정분이고 0 이면 null', () => {
    expect(kpisOf(rows, { enabled: true, settingsCheck: true }).okPct).toBe(50);
    expect(kpisOf([{ findings: [] }], { enabled: true, settingsCheck: true }).okPct).toBe(null);
  });
  it('심각도 건수를 센다', () => {
    const k = kpisOf(rows, { enabled: true, settingsCheck: true });
    expect(k.blockers).toBe(2);
    expect(k.warns).toBe(1);
  });
});

describe("확인 깊이 — '정상' 의 뜻을 종류마다 밝힌다", () => {
  it('포트만 본 것을 제품 확인처럼 말하지 않는다', () => {
    const tcp = depthNote('tcp', { tcp: '포트 열림까지' });
    const ident = depthNote('identity', { identity: '제품 확인까지' });
    expect(tcp).toContain('프로토콜 대화는 하지 않았습니다');
    expect(ident).toContain('제품인지까지');
    expect(tcp).not.toBe(ident);
  });
  it('문구가 "확인까지 확인했습니다" 로 겹치지 않는다', () => {
    expect(depthNote('identity', { identity: '제품 확인까지' })).not.toContain('확인까지 확인');
  });
});

describe('⚠ 선언 깊이를 그대로 확인했다고 말하지 않는다(v2.553 API 판독)', () => {
  it('403 으로 인증 단계에서 끝났으면 http 까지로 낮춘다', () => {
    const dr = depthReached({ depth: 'identity', latest: { reached: 'auth', ok: true } });
    expect(dr.depth).toBe('http');
    expect(dr.declared).toBe('identity');
    expect(dr.shallower).toBe(true);
  });
  it('⚠ 실패한 대상의 깊이는 null 이다(실패 단계를 확인했다고 말하지 않는다)', () => {
    const dr = depthReached({ depth: 'identity', latest: { ok: false, reached: 'tcp' } });
    expect(dr.depth).toBe(null);
    expect(dr.failed).toBe(true);
    expect(dr.failedAt).toBe('tcp');
    expect(dr.shallower).toBe(false);
    const n = depthNote(dr.depth, { tcp: '포트 열림까지' }, dr);
    expect(n).toContain('확인 깊이를 말할 수 없습니다');
    expect(n).not.toContain('봤습니다');
  });
  it('실패 행은 얕음 각주를 만들지 않는다', () => {
    const f = tableFootnotes([{ depth: 'identity', latest: { ok: false, reached: 'tcp' }, findings: [] }], { enabled: true, settingsCheck: true }).join(' ');
    expect(f).not.toContain('얕게 끝난');
  });
  it('정체까지 갔으면 그대로 identity', () => {
    const dr = depthReached({ depth: 'identity', latest: { reached: 'identity', ok: true } });
    expect(dr.depth).toBe('identity');
    expect(dr.shallower).toBe(false);
  });
  it('측정 전에는 선언 깊이를 쓰고 얕다고 말하지 않는다', () => {
    const dr = depthReached({ depth: 'identity' });
    expect(dr.measured).toBe(false);
    expect(dr.shallower).toBe(false);
  });
  it('측정 전 문구는 "확인했다" 고 말하지 않는다', () => {
    const dr = depthReached({ depth: 'identity' });
    const n = depthNote(dr.depth, { identity: '제품 확인까지' }, dr);
    expect(n).toContain('아직 측정하지 않았습니다');
    expect(n).not.toContain('봤습니다');
  });
  it('얕게 끝난 이유를 문구가 말한다', () => {
    const dr = depthReached({ depth: 'identity', latest: { reached: 'auth' } });
    const n = depthNote(dr.depth, { http: 'HTTP 응답까지', identity: '제품 확인까지' }, dr);
    expect(n).toContain('그 전에 끝났습니다');
  });
  it('각주도 그 대상이 있을 때만 만든다', () => {
    const none = tableFootnotes([{ depth: 'identity', latest: { reached: 'identity', ok: true }, findings: [] }], { enabled: true, settingsCheck: true }).join(' ');
    expect(none).not.toContain('얕게 끝난');
    const some = tableFootnotes([{ depth: 'identity', latest: { reached: 'auth', ok: true }, findings: [] }], { enabled: true, settingsCheck: true }).join(' ');
    expect(some).toContain('얕게 끝난');
  });
});

describe('배너 — 로그인하지 않는다는 사실을 먼저 말한다', () => {
  it('항상 첫 줄에 있다', () => {
    const n = headerNote({ enabled: true, targets: [], settingsCheck: true });
    expect(n[0]).toContain('로그인하지 않습니다');
  });
  it('꺼짐·설정문제·측정없음·등록부 오류를 각각 말한다', () => {
    const rows = [{ findings: [{ code: 'scheme-in-host', severity: 'blocker' }] }, { findings: [] }];
    const n = headerNote({ enabled: false, targets: rows, sourceErrors: [{ source: 'nsx', reason: 'x' }] }).join(' ');
    expect(n).toContain('꺼져 있습니다');
    expect(n).toContain('접속을 막는 문제');
    expect(n).toContain('통째로 빠졌습니다');
  });
  it('등록부를 다 읽었으면 그 경고를 만들지 않는다', () => {
    const n = headerNote({ enabled: true, targets: [{ latest: { ok: true }, findings: [] }], settingsCheck: true, sourceErrors: [] }).join(' ');
    expect(n).not.toContain('통째로 빠졌습니다');
  });
});

describe('그룹·딥링크·각주', () => {
  it('표시 순서를 지키고 모르는 그룹은 뒤로', () => {
    expect(groupRows([{ group: '서버' }, { group: 'zz' }, { group: '알림' }], ['알림', '서버']).map((g) => g.group))
      .toEqual(['알림', '서버', 'zz']);
  });
  it('좌표가 없으면 죽은 링크를 만들지 않는다', () => {
    expect(settingsLinkOf({ settings: 'central' }, { central: { label: 'portal.env', hash: '' } })).toBe(null);
    expect(settingsLinkOf({ settings: 'vcenter' }, { vcenter: { label: 'L', hash: '#/x' } })).toEqual({ label: 'L', hash: '#/x' });
  });
  it('각주는 그 종류가 있을 때만', () => {
    expect(tableFootnotes([{ latest: { ok: true }, findings: [] }], { enabled: true, settingsCheck: true })).toEqual([]);
    const f = tableFootnotes([{ agent: 'GM1', findings: [] }, { depth: 'tcp', latest: { ok: true }, findings: [] }], { enabled: true, settingsCheck: true }).join(' ');
    expect(f).toContain('엣지 위임');
    expect(f).toContain('포트·TLS 까지만');
  });
});

describe('심각도 라벨·색', () => {
  it('세 등급이 다른 색이다', () => {
    expect(SEVERITY_LABEL.blocker).not.toBe(SEVERITY_LABEL.warn);
    expect(severityTone('blocker')).not.toBe(severityTone('warn'));
    expect(severityTone('info')).toMatch(/muted/);
  });
});
