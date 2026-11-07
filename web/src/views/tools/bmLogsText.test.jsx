/**
 * 리눅스 성능 7a단계 — 로그 분석 화면(문구 · 그리기) 회귀.
 * ⚠ 판정은 서버(bmusage/logs · routes/api/bmLogs) — 여기서는 ① 웹 문구 표 = 서버 열거(1:1) ② 서버 정제본을 그대로 그리는지(SSR) ③ 못 읽은 칸을 0 으로 그리지 않는지
 *   ④ 웹이 다시 판정하지 않는지 · 폴링이 없는지(소스 스윕) ⑤ CSV 수식 주입 차단을 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as T from './bmLogsText.js';
import { LogsView } from './BmLogsTab.jsx';
import { LogsFleetView } from './BmLogsFleet.jsx';
import { LOG_CLASSES, LOG_SOURCES, SEC_KINDS, logRuleCatalog } from '../../../../server/src/bmusage/logs/rules.js';
import { STATUS } from '../../../../server/src/bmusage/logs/parse.js';
import { sanitizeLogView } from '../../../../server/src/central/bmLogsPull.js';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

function viewResp(extra = {}) {
  const hourly = Array.from({ length: 24 }, (_, i) => (i < 3 ? { t: NOW - (23 - i) * HOUR, fault: null, perf: null, sec: null, issue: null } : { t: NOW - (23 - i) * HOUR, fault: i === 20 ? 1 : 0, perf: i === 21 ? 14 : 0, sec: i === 22 ? 4 : 0, issue: 0 }));
  const body = sanitizeLogView({
    ok: true, key: 'K1', range: '24h', from: NOW - 23 * HOUR, to: NOW + HOUR, hourly,
    kpi: { fault: { patterns: 1, lines: 1 }, perf: { patterns: 1, lines: 14 }, sec: { patterns: 1, lines: 4 }, issue: { patterns: 0, lines: 0 } },
    read: { lines: 37, truncated: 2, none: 6, at: NOW, lineCap: 5000, ended: true, sources: { journal: { status: 'ok', n: 6, truncated: 2 }, secure: { status: 'perm', n: null }, audit: { status: 'absent', svc: 'inactive' } } },
    security: { fail_ip: [{ item: 'masked-ab12', count: 2 }], totals: { fail_ip: 2, sudo: 1 }, sudo: [{ item: 'masked-cd34 → masked-ef56 systemctl', count: 1 }], auditd: 'inactive' },
    patterns: [
      { sig: 'abcdef0123456789', cls: 'perf', severity: 'medium', ruleId: 'PERF-NVME-TIMEOUT', title: 'NVMe I/O 시한 초과', grade: '○', evidence: ['K1'], src: 'kernel', unit: 'kernel', tmpl: 'nvme <id>: I/O <n> QID <n> timeout', count: 14, total: 20, first: NOW - 3 * HOUR, last: NOW - 2 * HOUR,
        samples: [{ ts: NOW - 2 * HOUR, text: 'nvme nvme1: I/O 1024 QID 7 timeout, completion polled' }], corr: { changes: [{ ts: NOW - 2 * HOUR, kind: 'sysctl', item: 'vm.dirty_ratio' }], focus: [], playbook: 'use:disk' } },
      { sig: '0123456789abcdef', cls: 'sec', severity: 'medium', ruleId: 'SEC-SSH-FAIL', title: 'SSH 로그인 실패', grade: '○', evidence: ['S1'], src: 'secure', unit: 'sshd', tmpl: 'Failed password for <user> from <ip> port <*>', count: 4, first: NOW - HOUR, last: NOW - HOUR, samples: [], corr: {} },
    ],
    method: { lineCap: 5000, keepDays: 30, burst: { count: 20, windowMin: 5 }, firstSinceMin: 60, firstFileLines: 200, lineWidth: 500 }, corrWindowMs: 300_000, ...extra,
  }, NOW);
  return { ...body, rules: logRuleCatalog(), secHidden: true, patterns: body.patterns.map((p) => (p.cls === 'sec' ? { ...p, samplesHidden: true } : p)) };
}

describe('7a 로그 분석 — 문구 표 = 서버 열거', () => {
  it('분류 · 출처 · 상태 · 보안 종류가 서버와 1:1', () => {
    expect([...T.CLASS_ORDER].sort()).toEqual([...LOG_CLASSES].sort());
    expect(Object.keys(T.SRC_LABEL).sort()).toEqual([...LOG_SOURCES].sort());
    expect(Object.keys(T.STATUS_TEXT).sort()).toEqual([...STATUS].sort());
    const kinds = T.SEC_ROWS.flatMap((r) => r.parts.map(([k]) => k));
    for (const k of kinds) expect(['fail_ip', 'fail_user', ...SEC_KINDS]).toContain(k);
    for (const k of SEC_KINDS.filter((x) => x !== 'fail')) expect(kinds).toContain(k);
    for (const c of Object.values(T.CLASS_TEXT)) expect(c.color).toMatch(/^var\(--[a-z0-9-]+\)$/);   // 새 hex 없음
  });
});

describe('7a 로그 분석 — 결측은 0 이 아니다', () => {
  it('못 읽은 시간 칸은 막대 없음(unread) · 읽었는데 없음은 0', () => {
    const b = T.hourlyBars([{ t: 1, fault: null, perf: null, sec: null, issue: null }, { t: 2, fault: 0, perf: 0, sec: 0, issue: 0 }, { t: 3, fault: 2, perf: 1, sec: null, issue: 0 }]);
    expect(b.bars[0]).toMatchObject({ unread: true, total: null, segs: [] });
    expect(b.bars[1]).toMatchObject({ unread: false, total: 0 });
    expect(b.bars[2].total).toBe(3); expect(b.max).toBe(3);
  });
  it('한 번도 읽지 않았으면 KPI 는 ‘—’ · 읽은 양 ‘—’', () => {
    expect(T.kpiCards({ read: { never: true } }).every((c) => c.value === '—')).toBe(true);
    expect(T.readCard({ never: true }).value).toBe('—');
    expect(T.numText(null)).toBe('—'); expect(T.numText('')).toBe('—'); expect(T.numText(0)).toBe('0');
  });
  it('출처 칩 — 권한 없음 · 잘림 · 로테이트 lost 를 말한다', () => {
    const c = T.sourceChips({ secure: { status: 'perm' }, journal: { status: 'ok', truncated: 3 }, audit: { status: 'ok', rotated: true, lost: true } });
    expect(c.find((x) => x.src === 'secure').text).toBe('권한 없음');
    expect(c.find((x) => x.src === 'journal').extra).toContain('잘림 3줄');
    expect(c.find((x) => x.src === 'audit').extra).toContain('그 사이 줄 모름');
  });
});

describe('7a 반증 — 권한 · 보안 합계 · 주기 숫자(F1 · F2 · F3 · F12)', () => {
  it('보안 합계 — 서버가 null 이면 ‘—’ + 이유(담는 출처 · 상태 · 부분 합) · 0 으로 그리지 않는다', () => {
    const rows = T.secPanelRows({ totals: { fail_ip: null, ok: null, avc: 0 }, totalsWhy: { fail_ip: { carriers: ['secure', 'jsec', 'audit'], states: { secure: 'perm', jsec: 'perm', audit: 'perm' }, scopes: { jsec: 'own', audit: 'dir' }, partial: 2 }, ok: { carriers: ['secure', 'jsec'], states: { secure: 'perm', jsec: null } } } });
    const f = rows.find((r) => r.kind === 'fail');
    expect(f.total).toBe(null); expect(f.why).toContain('모름'); expect(f.why).toContain('자기 저널만'); expect(f.why).toContain('상위 폴더'); expect(f.why).toContain('다른 출처에서 2건(부분');
    expect(rows.find((r) => r.kind === 'ok').why).toContain('기록 없음');
    expect(rows.find((r) => r.kind === 'avc').total).toBe(0); expect(rows.find((r) => r.kind === 'avc').why).toBe('');
  });
  it('출처 칩 — 권한 범위(자기 저널만 · 상위 폴더) · 시한 부분 · 끝 줄 미완성 · dmesg 첫 읽기 · 시각 모름 · 같은 기록(dup) · rsyslog', () => {
    const c = T.sourceChips({ journal: { status: 'perm', scope: 'own' }, jsec: { status: 'ok', dup: 4, dupOf: 'secure', partial: 'timeout' }, kernel: { status: 'ok', first: true, older: 9, undated: 1 }, secure: { status: 'ok', partial: 12, svc: 'active' }, audit: { status: 'perm', scope: 'dir' } });
    const g = (s) => c.find((x) => x.src === s).extra;
    expect(g('journal')).toContain('자기 저널만'); expect(g('audit')).toContain('상위 폴더');
    expect(g('jsec')).toContain('/var/log/secure 와 같은 기록 4줄'); expect(g('jsec')).toContain('시한');
    expect(g('kernel')).toContain('그 앞 9줄은 세지 않음'); expect(g('kernel')).toContain('시각 모름 1줄');
    expect(g('secure')).toContain('끝 줄 미완성 12바이트'); expect(g('secure')).toContain('rsyslog active');
  });
  it('필요한 권한 안내 — 못 읽은 출처만 · 수집 계정 uid · 소속 · 포탈은 권한을 바꾸지 않음', () => {
    const g = T.permGuide({ journal: { status: 'perm', scope: 'own', uid: 1001, groups: [] }, secure: { status: 'perm', scope: 'file' }, audit: { status: 'perm', scope: 'dir' }, kernel: { status: 'ok' } });
    expect(g.join('\n')).toContain('uid 1001'); expect(g.join('\n')).toContain('소속 없음'); expect(g.join('\n')).toContain('systemd-journal');
    expect(g.join('\n')).toContain('/var/log/secure'); expect(g.join('\n')).toContain('log_group'); expect(g.at(-1)).toContain('포탈은 서버 권한을 바꾸지 않습니다');
    expect(T.permGuide({ journal: { status: 'ok' } })).toEqual([]);
  });
  it('수집 방식 — 주기는 API 값(설정 intervalMs)만 · 숫자를 박지 않는다(반증 F12)', () => {
    expect(T.methodLines({ intervalMs: 120_000 })[0]).toContain('2분 주기');
    expect(T.methodLines({ intervalMs: null })[0]).toContain('주기(—)');
    expect(T.methodLines({ intervalMs: 90_000 })[0]).toContain('90초 주기');
    const src = fs.readFileSync(path.join(HERE, 'bmLogsText.js'), 'utf8');
    expect(src).not.toMatch(/['`][^'`\n]{0,40}\d+분 주기/);
  });
  it('함대 보안 칸 — 보안 출처를 하나도 못 읽었으면 ‘—’(0 아님) · 다른 출처 줄이 있으면 부분 · 못 읽은 서버는 ‘—’', () => {
    const base = { wasRead: true, cls: { sec: { patterns: 0, lines: 0 }, fault: { patterns: 1, lines: 2 } } };
    expect(T.fleetClsCell({ ...base, secRead: false }, 'sec').text).toBe('—');
    expect(T.fleetClsCell({ ...base, secRead: false }, 'fault').text).toBe('1');
    expect(T.fleetClsCell({ ...base, secRead: true }, 'sec').text).toBe('0');
    const p = T.fleetClsCell({ wasRead: true, secRead: false, cls: { sec: { patterns: 1, lines: 3 } } }, 'sec');
    expect(p.partial).toBe(true); expect(p.sub).toContain('부분');
    expect(T.fleetClsCell({ wasRead: false }, 'sec').text).toBe('—');
  });
  it('범위 밖 노드 수(F10)', () => {
    expect(T.nodeNotes([], 2)).toEqual(['조회 범위 밖 노드 2곳은 싣지 않았습니다.']);
    expect(T.nodeNotes([], null)).toEqual([]);
  });
});

describe('7a 로그 분석 — 그리기(SSR · 서버 정제본 그대로)', () => {
  it('상세 — KPI · 읽은 양 · 출처 상태 · 보안 가림 판본 · 연계(인과 아님) · 규칙 등급 · 수집 방식 숫자는 API 값', () => {
    const html = renderToStaticMarkup(h(LogsView, { resp: viewResp(), range: '24h' }));
    expect(html).toContain('패턴 1 · 줄 14');
    expect(html).toContain('잘림 2');
    expect(html).toContain('/var/log/secure 권한 없음');
    expect(html).toContain('관리자 판본이 아닙니다');
    expect(html).toContain('보안 분류 표본은 관리자 판본에만');
    expect(html).toContain('±5분 시각 매칭 · 인과 아님');
    expect(html).toContain('변경 ');
    expect(html).toContain('플레이북 ‘use:disk’');
    expect(html).toContain('주기당 5,000줄');
    expect(html).toContain('5분 안 20줄');
    expect(html).not.toMatch(/\*\*/);   // BoldText 가 강조를 해석한다(별표 노출 없음)
    expect(html).toContain('읽은 기록 없음(막대 없음 — 0 아님)');
    expect(html).toContain('실장비 표본 없음');
    expect(html).toContain('필요한 권한 — 못 읽은 출처');
  });
  it('상세 — 보안 합계가 모름이면 ‘—’ 와 이유를 그린다(0 이 아니다 · 반증 F1)', () => {
    const r = viewResp({ security: { totals: { fail_ip: null }, totalsWhy: { fail_ip: { carriers: ['secure', 'jsec', 'audit'], states: { secure: 'perm', jsec: 'perm', audit: 'absent' } } } } });
    const html = renderToStaticMarkup(h(LogsView, { resp: r, range: '24h' }));
    expect(html).toContain('모름 — 담는 출처를 이 기간에 못 읽음');
    expect(html).toMatch(/>—<\/td><td[^>]*><div class="bmo-sub bml-why">모름/);
  });
  it('함대 — KPI · 공통 원인 후보(후보 문구 · 창은 API 값) · 못 읽은 서버는 ‘—’ · 구버전 엣지 안내', () => {
    const resp = {
      ok: true, kpi: { servers: 2, faultServers: 1, secHighServers: 0, unread: 1, truncated: 0 }, commonWindowMs: HOUR,
      common: [{ ruleId: 'PERF-NVME-TIMEOUT', cls: 'perf', severity: 'medium', count: 2, from: NOW - HOUR, to: NOW, servers: [{ key: 'a', name: 'bm-a', agent: '' }, { key: 'b', name: 'bm-b', agent: 'e1' }] }],
      servers: [
        { key: 'a', name: 'bm-a', vcenterId: 'vcA', wasRead: true, read: 10, none: 1, cls: { fault: { patterns: 1, lines: 1 }, perf: { patterns: 1, lines: 3 }, sec: { patterns: 0, lines: 0 }, issue: { patterns: 0, lines: 0 } }, top: [{ ruleId: 'HW-MCE', count: 1 }], status: { sources: { secure: 'perm' } }, via: 'local' },
        { key: 'b', name: 'bm-b', vcenterId: 'vcA', wasRead: false, read: 0, none: null, cls: {}, top: [], status: null, via: 'edge', agent: 'e1' },
      ],
      nodes: [{ via: 'edge', agent: 'old1', state: 'old-version' }],
    };
    const html = renderToStaticMarkup(h(LogsFleetView, { resp }));
    expect(html).toContain('공통 원인 후보');
    expect(html).toContain('60분 안');
    expect(html).toContain('원인이 같다는 증거가 아닙니다');
    expect(html).toContain('엣지 old1: 엣지 판이 낮음');
    expect(html).toContain('/var/log/secure 권한 없음');
    expect(html).not.toMatch(/\*\*/);
  });
  it('CSV — 수식 주입 차단(= + - @ 앞 따옴표)', () => {
    const csv = T.patternCsv({ patterns: [{ cls: 'issue', severity: 'info', count: 1, tmpl: '=HYPERLINK("x")', ruleId: 'R', samples: [{ text: '@cmd' }] }] });
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("'@cmd");
  });
});

describe('7a 로그 분석 — 소스 스윕', () => {
  it('폴링 없음 · 웹이 분류 · 집중을 다시 판정하지 않음(규칙 정규식 · 임계를 쓰지 않는다)', () => {
    for (const f of ['BmLogsTab.jsx', 'BmLogsFleet.jsx', 'bmLogsText.js']) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      expect(src, f).not.toMatch(/setInterval\s*\(/);
      expect(src, f).not.toMatch(/burstTimes|matchRule|classifyItems|commonCauseCandidates/);
      expect(src, f).not.toMatch(/server\/src\//);
    }
  });
});
