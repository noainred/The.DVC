// v2.583 — '불러오는 중' 의 지연 주체(요청 ID · 서버 상태) 표시 회귀 고정.
// 사용자 요청: "불러오는 중… 이라는 메시지 나올 때 누가 이 메시지의 지연을 발생시켰는지 ID 도 같이 보여줘".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { statusPollTargets, serverStateText, stallPayload, requesterText } from './perfClientLogic.js';
import { taskRows } from './components/taskLabel.js';
import { startReq, endReq, ridOf, inflightSnapshot, pollServerStatus, _resetPerfClient } from './perfClient.js';

describe('요청 ID (v2.583)', () => {
  beforeEach(() => _resetPerfClient());

  it('startReq 가 서버 형식에 맞는 ID 를 만든다 — 탭 접두 + 순번, /perf/ 는 추적하지 않는다', () => {
    const a = startReq('/admin/x'); const b = startReq('/admin/y');
    const ra = ridOf(a); const rb = ridOf(b);
    expect(ra).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{3,39}$/);
    expect(ra).not.toBe(rb);
    expect(ra.split('-')[0]).toBe(rb.split('-')[0]);
    expect(startReq('/perf/req-status')).toBe(null);
    expect(ridOf(null)).toBe('');
    endReq(a); endReq(b);
    expect(ridOf(a)).toBe('');
  });

  it('statusPollTargets — 문턱을 넘긴 것만, 오래된 순, 상한', () => {
    const rows = [
      { rid: 'w1-1', ms: 1000 }, { rid: 'w1-2', ms: 9000 }, { rid: 'w1-3', ms: 4000 }, { rid: '', ms: 99999 },
    ];
    expect(statusPollTargets(rows, { detailMs: 3000 })).toEqual(['w1-2', 'w1-3']);
    expect(statusPollTargets(rows, { detailMs: 3000, limit: 1 })).toEqual(['w1-2']);
    expect(statusPollTargets([], {})).toEqual([]);
  });

  it('serverStateText — 지연 주체를 나눠 말하고, 값이 없으면 단위를 붙이지 않는다', () => {
    expect(serverStateText(null)).toEqual({ tone: 'pending', text: '서버 상태 확인 중' });
    expect(serverStateText({ state: 'processing', serverMs: 6200 }).text).toBe('서버가 처리 중 (6초째) — 지연 주체는 서버의 이 작업입니다');
    expect(serverStateText({ state: 'processing' }).text).toBe('서버가 처리 중 — 지연 주체는 서버의 이 작업입니다');
    expect(serverStateText({ state: 'done', serverMs: 120, status: 200 }).text).toBe('서버는 이미 응답했습니다 (1초 미만 · 200) — 전송이나 브라우저 처리를 기다리는 중입니다');
    expect(serverStateText({ state: 'done', status: 200 }).text).toBe('서버는 이미 응답했습니다 (200) — 전송이나 브라우저 처리를 기다리는 중입니다');
    const u = serverStateText({ state: 'unknown' });
    expect(u.tone).toBe('unknown');
    expect(u.text).toContain('도달하지 않았거나');
    for (const t of [serverStateText({ state: 'processing', serverMs: '' }).text, serverStateText({ state: 'done', serverMs: null }).text]) {
      expect(t).not.toMatch(/undefined|NaN|0초/);
    }
  });

  it('taskRows — 묶인 작업은 가장 오래 기다린 요청의 ID·메서드·서버 상태를 싣는다', () => {
    const rows = taskRows([
      { path: '/admin/vclogs/settings', method: 'GET', ms: 2000, rid: 'w1-a', server: null },
      { path: '/admin/users', method: 'GET', ms: 6000, rid: 'w1-b', server: { state: 'processing', serverMs: 5900 } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: '관리 설정 조회', count: 2, ms: 6000, rid: 'w1-b', method: 'GET', path: '/admin/users' });
    expect(rows[0].server.state).toBe('processing');
  });

  it('hang 보고 본문에 ID 가 실린다(서버 성능 측정에서 대조)', () => {
    const p = stallPayload({ view: '#/settings', path: '/admin/x', ms: 70000, inflight: [{ path: '/admin/x', ms: 70000, rid: 'w1-z' }] });
    expect(p.inflight[0].rid).toBe('w1-z');
  });

  it('pollServerStatus — 문턱 전에는 묻지 않고, 받은 상태를 진행 중 요청에만 붙인다 · 5초 간격', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    try {
      const calls = [];
      const fake = (path, params) => { calls.push(params.ids); return Promise.resolve({ items: Object.fromEntries(params.ids.split(',').map((r) => [r, { state: 'processing', serverMs: 4000 }])) }); };
      const id = startReq('/tools/x');
      pollServerStatus(fake);
      expect(calls).toHaveLength(0);              // 문턱(3초) 미만 — 묻지 않는다
      vi.advanceTimersByTime(4000);
      pollServerStatus(fake);
      expect(calls).toEqual([ridOf(id)]);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(inflightSnapshot(1)[0].server).toMatchObject({ state: 'processing', serverMs: 4000 });
      pollServerStatus(fake);
      expect(calls).toHaveLength(1);              // 5초 간격 — 바로 다시 묻지 않는다
      endReq(id);
      expect(inflightSnapshot(1)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('요청자 표시 (v2.585)', () => {
  it('서버가 답한 소유자가 먼저이고, 없으면 로그인 계정, 둘 다 없으면 지어내지 않는다', () => {
    expect(requesterText({ state: 'processing', user: 'alice' }, { username: 'alice' })).toEqual({ name: 'alice', source: 'server', mine: true });
    expect(requesterText({ state: 'done', user: 'bob' }, { username: 'alice' })).toEqual({ name: 'bob', source: 'server', mine: false });
    expect(requesterText(null, { username: 'alice' })).toEqual({ name: 'alice', source: 'session', mine: true });
    expect(requesterText({ state: 'unknown' }, { username: ' carol ' })).toEqual({ name: 'carol', source: 'session', mine: true });
    expect(requesterText(null, null)).toEqual({ name: '', source: null, mine: false });
    expect(requesterText({ state: 'processing', user: '' }, {})).toEqual({ name: '', source: null, mine: false });
  });
});
