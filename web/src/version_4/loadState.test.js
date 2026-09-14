/**
 * loadState.js 회귀(v2.509) — 사용자가 "기다리면 나오는거야?" 를 **물어봐야 했던** 결함을 막는다.
 *
 * 여기서 고정하는 핵심은 하나다: **'기다리면 되는 상황' 과 '기다려도 안 되는 상황' 을 섞지 않는다.**
 * 서버가 pending(첫 수집 전/수집 중)과 unreachable(연결 실패)을 따로 세어 주는데
 * 화면이 둘을 같은 문구로 덮으면 사용자는 조치해야 할 때 하염없이 기다린다.
 */
import { describe, it, expect } from 'vitest';
import { loadPhase, loadText, collectProgress, liveText, shouldBanner, isTimeoutError } from './loadState.js';

const health = (o = {}) => ({
  vcenters: 28, vcentersConnected: 28, vcentersPending: 0, vcentersUnreachable: 0,
  vcentersMaintenance: 0, generatedAt: 1_700_000_000_000, uptimeSec: 3600, ...o,
});

describe('판정', () => {
  it('데이터가 있으면 ready — 다른 판정을 하지 않는다', () => {
    expect(loadPhase({ health: health(), poll: { data: { x: 1 } } })).toBe('ready');
    // 데이터가 있으면 pending 이 있어도 화면은 그 데이터를 보여준다
    expect(loadPhase({ health: health({ vcentersPending: 9 }), poll: { data: {} } })).toBe('ready');
  });

  it('health 가 아직 없으면 loading, 오류면 no-health', () => {
    expect(loadPhase({ poll: {} })).toBe('loading');
    expect(loadPhase({ healthError: '서버 응답 없음', poll: {} })).toBe('no-health');
  });

  it('등록 0개는 empty — 기다릴 일이 아니다', () => {
    expect(loadPhase({ health: health({ vcenters: 0 }), poll: {} })).toBe('empty');
    expect(loadText('empty', { health: health({ vcenters: 0 }) }).waiting).toBe(false);
  });

  it('대기 중인 vCenter 가 있으면 first-collect — 기다리면 된다', () => {
    const h = health({ vcentersConnected: 20, vcentersPending: 8 });
    expect(loadPhase({ health: h, poll: {} })).toBe('first-collect');
    expect(loadText('first-collect', { health: h }).waiting).toBe(true);
  });

  it('연결 실패만 있으면 unreachable — 기다려도 안 된다', () => {
    const h = health({ vcentersConnected: 25, vcentersUnreachable: 3 });
    expect(loadPhase({ health: h, poll: {} })).toBe('unreachable');
    expect(loadText('unreachable', { health: h }).waiting).toBe(false);
  });

  it('대기와 실패가 섞이면 대기가 이긴다 — 아직 수집이 돌고 있다', () => {
    // 이걸 뒤집으면 '조치하세요' 라고 말해 놓고 잠시 뒤 저절로 채워진다(거짓 안내).
    const h = health({ vcentersConnected: 18, vcentersPending: 7, vcentersUnreachable: 3 });
    expect(loadPhase({ health: h, poll: {} })).toBe('first-collect');
  });

  it('타임아웃·연결 실패는 retrying — 장애로 단정하지 않는다', () => {
    const h = health();
    for (const e of ['signal timed out', 'The operation was aborted', 'TimeoutError: timeout']) {
      expect(loadPhase({ health: h, poll: { error: e } })).toBe('retrying');
    }
    // 브라우저별 네트워크 오류 문구도 '재시도 중' 으로 묶는다(화면 전체를 오류로 갈아치우지 않게).
    for (const e of ['Failed to fetch', 'NetworkError when attempting to fetch resource', 'Load failed']) {
      expect(loadPhase({ health: h, poll: { error: e } })).toBe('retrying');
    }
    const t = loadText('retrying');
    expect(t.waiting).toBe(null);            // 기다리면 되는지 모른다 → null 이어야 한다
    expect(t.long).not.toMatch(/CPU|이벤트 루프|과부하/); // 확인하지 않은 원인을 적지 않는다
  });

  it('시한 초과와 연결 실패는 문구가 다르다 — 확인할 곳이 다르다', () => {
    const to = loadText('retrying', { pollError: 'signal timed out' });
    const net = loadText('retrying', { pollError: 'Failed to fetch' });
    expect(to.short).not.toBe(net.short);
    expect(net.long).toMatch(/연결하지 못했습니다/);
    expect(to.long).toMatch(/응답 시한/);
  });

  it('타임아웃이 아닌 오류는 error', () => {
    expect(loadPhase({ health: health(), poll: { error: 'Internal Server Error' } })).toBe('error');
  });

  it('스냅샷이 아직 없으면(generatedAt 없음) 수집 중으로 본다', () => {
    expect(loadPhase({ health: health({ generatedAt: null }), poll: {} })).toBe('first-collect');
  });

  it('isTimeoutError 는 문구 변형을 넓게 받는다', () => {
    for (const m of ['timeout', 'TimeoutError', 'AbortError: aborted', 'signal is aborted without reason']) {
      expect(isTimeoutError(m)).toBe(true);
    }
    expect(isTimeoutError('forbidden')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe('진행률', () => {
  it('대기 수로 완료분을 센다', () => {
    const p = collectProgress(health({ vcentersConnected: 20, vcentersPending: 8 }));
    expect(p).toMatchObject({ total: 28, pending: 8, done: 20, pct: 71 });
  });

  it('총 대수를 모르면 null — 없는 진행률을 만들지 않는다', () => {
    expect(collectProgress(null)).toBe(null);
    expect(collectProgress({ vcenters: 0 })).toBe(null);
  });
});

describe('LIVE 배지', () => {
  it('첫 수집 중에 OK 라고 말하지 않는다', () => {
    // v2.508 까지의 문구는 `28/28 vCenter OK` 뿐이라 수집 중에도 정상처럼 보였다.
    const s = liveText(health({ vcentersConnected: 20, vcentersPending: 8 }), '3:13:28');
    expect(s).not.toMatch(/OK/);
    expect(s).toMatch(/대기 8/);
    expect(s).toMatch(/3:13:28/);
  });

  it('전부 정상이면 기존 문구를 유지한다', () => {
    expect(liveText(health(), '3:13:28')).toBe('28/28 vCenter OK · 3:13:28');
  });

  it('연결 실패·점검도 구분해 보여준다', () => {
    const s = liveText(health({ vcentersConnected: 24, vcentersUnreachable: 3, vcentersMaintenance: 1 }), 'x');
    expect(s).toMatch(/불가 3/);
    expect(s).toMatch(/점검 1/);
  });

  it('health 가 없으면 연결 중', () => {
    expect(liveText(null, 'x')).toBe('연결 중…');
  });
});

describe('배너', () => {
  it('행동이 갈리는 두 경우만 띄운다', () => {
    expect(shouldBanner('first-collect')).toBe(true);
    expect(shouldBanner('unreachable')).toBe(true);
    for (const p of ['ready', 'loading', 'retrying', 'error', 'empty', 'no-health']) {
      expect(shouldBanner(p)).toBe(false);
    }
  });
});
