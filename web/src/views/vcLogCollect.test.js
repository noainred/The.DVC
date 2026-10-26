// v2.765 — 설정 › vCenter 로그 보관의 vCenter 별 수집 상태 표 문구(순수). 실서버 OC2 이벤트 수집 13일 정체를 화면이 말하게.
import { describe, it, expect } from 'vitest';
import { vcLogCollectRows, vcLogStateText, vcLogStateClass, vcLogLagText, vcLogLagWarn, vcLogCappedText, vcLogReadStoredText, vcLogDurText, vcLogMaxPerPollText, vcLogHintText, DAY_MS,
  vcLogSkipText, vcLogStateSort, vcLogRunningText, vcLogCountsAtText, vcLogCatchupText, vcLogCapNoteText, VCLOG_STATE_TEXT } from './vcLogCollect.js';
import { vcLogCollectText } from './VcenterLogs.jsx';

const fmt = (n) => Number(n).toLocaleString('en-US');

describe('vcLogCollect — 행 합치기', () => {
  it('서버 collect 가 없으면(구버전) 보관 목록만으로 행을 만들고 수집 칸은 null', () => {
    const rows = vcLogCollectRows({ store: { vcenters: [{ vcenterId: 'b', count: 3, lastTs: 100 }, { vcenterId: 'a', count: 0, lastTs: null }] } });
    expect(rows.map((r) => r.vcenterId)).toEqual(['a', 'b']);
    expect(rows[1]).toMatchObject({ count: 3, lastStoredTs: 100 });
    expect(rows[0].lastStoredTs).toBeNull();
    expect(rows[0].read).toBeUndefined();
  });
  it('collect 가 있으면 건수·마지막 저장을 덧씌우고 lastPoll 을 펼친다 · 범위 계정의 errorHidden 을 남긴다 · 힌트·예산', () => {
    const rows = vcLogCollectRows({
      store: { vcenters: [{ vcenterId: 'oc2', count: 10, lastTs: 50 }] },
      collect: [{ vcenterId: 'oc2', count: 12, lastStoredTs: 60, okAt: 55, cursorTs: 70, lagMs: 2 * DAY_MS, capped: true, ended: 'budget', consecutiveCapped: 3, ratePerMin: 400, state: 'catching-up',
        lastPoll: { read: 4000, stored: 3990, ms: 12_000, rounds: 4, deadlineMs: 540_000, budgetMs: 480_000, error: null, errorHidden: true, hint: 'timeout' } }, null, { vcenterId: '' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 12, lastStoredTs: 60, okAt: 55, cursorTs: 70, capped: true, ended: 'budget', read: 4000, stored: 3990, ms: 12_000, rounds: 4, deadlineMs: 540_000, budgetMs: 480_000, error: null, errorHidden: true, state: 'catching-up', hint: 'timeout' });
  });
  it("'못 읽은 값' 은 0 이 아니다 — 빈 문자열·null 은 null", () => {
    const [r] = vcLogCollectRows({ collect: [{ vcenterId: 'x', count: '', lastStoredTs: null, lagMs: '', lastPoll: { read: null, stored: '', ms: 0, hint: '', budgetMs: null } }] });
    expect(r.count).toBeNull(); expect(r.lagMs).toBeNull(); expect(r.read).toBeNull(); expect(r.stored).toBeNull(); expect(r.ms).toBe(0); expect(r.hint).toBeNull(); expect(r.budgetMs).toBeNull();
  });
});

describe('vcLogCollect — 칸 문구', () => {
  it('상태', () => {
    expect(vcLogStateText('catching-up')).toBe('따라잡기 중'); expect(vcLogStateText('stalled')).toBe('정체'); expect(vcLogStateText('ok')).toBe('정상');
    expect(vcLogStateText('failed')).toBe('실패'); expect(vcLogStateText(null)).toBe('—');
    expect(vcLogStateClass('failed')).toBe('red'); expect(vcLogStateClass(undefined)).toBe('gray');
  });
  it('지연 — 일/시간, 1일 넘으면 경고', () => {
    expect(vcLogLagText(null)).toBe('—'); expect(vcLogLagText(30_000)).toBe('1분 미만'); expect(vcLogLagText(12 * 60_000)).toBe('12분');
    expect(vcLogLagText(5 * 3_600_000)).toBe('5시간'); expect(vcLogLagText(3 * DAY_MS + 4 * 3_600_000)).toBe('3일 4시간'); expect(vcLogLagText(13 * DAY_MS)).toBe('13일');
    expect(vcLogLagWarn(DAY_MS)).toBe(false); expect(vcLogLagWarn(DAY_MS + 1)).toBe(true); expect(vcLogLagWarn(null)).toBe(false);
  });
  it('상한 — ended 우선(예산·중단 포함), 없으면 capped 불리언', () => {
    expect(vcLogCappedText({ capped: true, ended: 'pages' })).toBe('쪽 수 한도'); expect(vcLogCappedText({ capped: true, ended: 'aborted' })).toBe('시한');
    expect(vcLogCappedText({ capped: true, ended: 'budget' })).toBe('예산'); expect(vcLogCappedText({ capped: true, ended: 'batch' })).toBe('중단');
    expect(vcLogCappedText({ capped: true, ended: 'max' })).toBe('상한'); expect(vcLogCappedText({ capped: false, ended: 'empty' })).toBe('아니오');
    expect(vcLogCappedText({ capped: true })).toBe('상한'); expect(vcLogCappedText({ capped: null })).toBe('—'); expect(vcLogCappedText(null)).toBe('—');
  });
  it('읽음/저장 · 소요/시한 · 시한 힌트(2-c)', () => {
    expect(vcLogReadStoredText({ read: 4000, stored: 3990, rounds: 4 }, fmt)).toBe('4,000 / 3,990 (묶음 4)');   // v2.772(I-2): '회' 는 실제로 묶음 수였다
    expect(vcLogReadStoredText({ read: 100, stored: 0, rounds: 1 }, fmt)).toBe('100 / 0');
    expect(vcLogReadStoredText({ read: null, stored: null })).toBe('—');
    expect(vcLogDurText({ ms: 12_000, deadlineMs: 60_000 })).toBe('12초 / 60초'); expect(vcLogDurText({ ms: 1_500, deadlineMs: null })).toBe('1.5초'); expect(vcLogDurText({ ms: null })).toBe('—');
    expect(vcLogHintText({ hint: 'timeout' })).toBe('시한 안에 첫 묶음도 못 읽었습니다 — 요청 시한(vCenter 관리 › timeoutMs)을 올리세요');
    expect(vcLogHintText({ hint: null })).toBe(''); expect(vcLogHintText(null)).toBe(''); expect(vcLogHintText({ hint: 'other' })).toBe('');
    expect(vcLogHintText({ hint: 'timeout' })).not.toMatch(/[`*]/);
  });
  it('한 주기 상한 안내 — 묶음 수집(streaming) 서버는 시간 예산·묶음 크기를, 옛 서버는 설정값·실효 상한·회차를 서버 값으로', () => {
    const t = vcLogMaxPerPollText({ settings: { maxPerPoll: 50_000, pollIntervalMin: 10 }, maxPerPollEffective: 40_000, collectorMaxEvents: 40_000, catchup: { budgetMs: 480_000, ratio: 0.8, batchRows: 2000, minBudgetMs: 30_000, streaming: true } }, fmt);
    expect(t).toBe('vCenter 마다 주기의 80% 시간 예산 안에서 2,000건씩 한 세션으로 이어 읽어 적재합니다(로그인은 주기에 1회). 한 번에 읽는 건수 상한은 없고 시간 예산이 끝을 정합니다.');
    const old = vcLogMaxPerPollText({ settings: { maxPerPoll: 50_000, pollIntervalMin: 10 }, maxPerPollEffective: 40_000, collectorMaxEvents: 40_000, catchup: { budgetMs: 480_000, maxRounds: 40, ratio: 0.8 } }, fmt);
    expect(old).toBe('한 주기 상한(maxPerPoll): 설정 50,000건 · 실효 40,000건(수집기 한도 40,000건). 상한에 걸린 vCenter 는 같은 주기 안에서 이어 읽습니다(주기의 80% 안 · 최대 40회).');
    expect(vcLogMaxPerPollText({ settings: { maxPerPoll: 5000 }, maxPerPollEffective: 5000 }, fmt)).toBe('한 주기 상한(maxPerPoll): 설정 5,000건.');
    expect(vcLogMaxPerPollText({ settings: {} })).toBe('');
    expect(t).not.toMatch(/[`*]/); expect(old).not.toMatch(/[`*]/);
  });
});

// v2.772 — 주기 도중 혼합(Z1-1) · 마지막 저장 실시간·집계 시각(Z1-2) · 지금 수집 먼저 응답(Z1-3) · 수집 제외 사유(Z1-4) · 용량 상한 안내(Z2-I1) · 진척(I-1) · 정렬·묶음(I-2)
describe('v2.772 — 수집 상태 표', () => {
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H;
  it('Z1-1 진행 중 — 상한 칸은 진행 중(중단 아님), 읽음/저장·소요는 직전 주기 표기, 진행분은 따로', () => {
    const [r] = vcLogCollectRows({ collect: [{ vcenterId: 'oc2', capped: true, ended: 'batch', state: 'ok', running: { since: NOW - 60_000, read: 1500, stored: 1500, rounds: 15 },
      lastPoll: { read: 21, stored: 20, rounds: 1, ms: 900, deadlineMs: 540_000 } }] });
    expect(r.running).toEqual({ since: NOW - 60_000, read: 1500, stored: 1500, rounds: 15 });
    expect(vcLogCappedText(r)).toBe('진행 중');
    expect(vcLogReadStoredText(r, fmt)).toBe('직전 21 / 20');
    expect(vcLogDurText(r)).toBe('직전 0.9초 / 540초');
    expect(vcLogRunningText(r, fmt)).toBe('수집 중 · 읽음 1,500 / 저장 1,500(묶음 15)');
    expect(vcLogStateText(r.state)).toBe('정상');
    // 진행 중이 아니면 예전 그대로(끝난 주기의 'batch' 는 진짜 중단)
    const [d] = vcLogCollectRows({ collect: [{ vcenterId: 'x', capped: true, ended: 'batch', lastPoll: { read: 5, stored: 5, rounds: 1 } }] });
    expect(d.running).toBeNull(); expect(vcLogCappedText(d)).toBe('중단'); expect(vcLogReadStoredText(d, fmt)).toBe('5 / 5'); expect(vcLogRunningText(d)).toBe('');
  });
  it('Z1-2 건수 집계 시각', () => {
    expect(vcLogCountsAtText(NOW - 3 * 60_000, NOW)).toBe('3분 전 집계');
    expect(vcLogCountsAtText(NOW - 10_000, NOW)).toBe('방금 집계');
    expect(vcLogCountsAtText(null, NOW)).toBe(''); expect(vcLogCountsAtText('', NOW)).toBe('');
  });
  it('Z1-3 지금 수집 — 먼저 응답(running)은 완료라 말하지 않고 표를 보라고 한다', () => {
    const t = vcLogCollectText({ ok: true, running: true, runningSince: NOW }, () => 'T');
    expect(t).toBe('수집이 오래 걸려 먼저 응답했습니다(T 시작) — 수집은 계속 진행 중입니다. 결과(실패한 vCenter 포함)는 아래 표의 상태 칸에서 확인하세요.');
    expect(t).not.toMatch(/수집 완료|0건|[`*]/);
    expect(vcLogCollectText({ ok: true, running: true }, () => 'T')).toMatch(/^수집이 오래 걸려 먼저 응답했습니다 — /);
  });
  it('Z1-4 수집 제외 — 상태 문구·색·툴팁(인증 정지는 빨강, 수집 안 함은 회색)', () => {
    const [a, b] = vcLogCollectRows({ collect: [{ vcenterId: 'a', state: 'auth-stopped', skip: 'auth-stopped', lagMs: 2 * DAY_MS }, { vcenterId: 'b', state: 'not-collected', skip: 'site' }] });
    expect(vcLogStateText(a.state)).toBe('인증 정지'); expect(vcLogStateClass(a.state)).toBe('red');
    expect(vcLogSkipText(a)).toMatch(/^인증 실패로 멈춘 vCenter 입니다 — 주기 수집에서 건너뜁니다/);
    expect(vcLogStateText(b.state)).toBe('수집 안 함'); expect(vcLogStateClass(b.state)).toBe('gray'); expect(vcLogSkipText(b)).toMatch(/엣지에 위임/);
    expect(vcLogSkipText({ skip: 'zzz' })).toBe(''); expect(vcLogSkipText(null)).toBe('');
    for (const v of Object.values(VCLOG_STATE_TEXT)) expect(v).not.toMatch(/[`*]/);
  });
  it('I-2 상태 정렬은 심각도 순 · 모르면 빈 값(뒤로)', () => {
    const order = ['ok', 'catching-up', 'failed', 'not-collected', 'stalled', 'auth-stopped'].map((state) => ({ state })).sort((x, y) => vcLogStateSort(x) - vcLogStateSort(y)).map((x) => x.state);
    expect(order).toEqual(['failed', 'auth-stopped', 'stalled', 'catching-up', 'not-collected', 'ok']);
    expect(vcLogStateSort({ state: null })).toBe(''); expect(vcLogStateSort(null)).toBe('');
  });
  it('I-1 따라잡기 진척 — 순진척 = 온전한 시각 전진 − 주기 간격', () => {
    const base = { state: 'catching-up', everyMs: 10 * 60_000, okAtStart: NOW - 9 * DAY_MS };
    // 한 주기(10분)에 1일 전진 → 순진척 1일 − 10분(23시간 50분) · 지연 9일 → 약 9.06 주기 ≈ 91분 → '1시간'(시간 단위 표기)
    expect(vcLogCatchupText({ ...base, okAtEnd: NOW - 8 * DAY_MS, lagMs: 9 * DAY_MS })).toBe('따라잡기 진척: 주기마다 23시간 따라잡음 · 완료 예상 약 1시간 뒤(지난 주기 속도 기준 추정)');
    expect(vcLogCatchupText({ ...base, okAtEnd: NOW - 9 * DAY_MS + 5 * 60_000, lagMs: 9 * DAY_MS })).toBe('따라잡기 진척: 생성 속도를 못 따라갑니다(지난 주기 기준 주기마다 지연 5분 증가 — 추정)');
    expect(vcLogCatchupText({ ...base, okAtEnd: null })).toBe('따라잡기 진척 —');
    expect(vcLogCatchupText({ ...base, okAtEnd: NOW - 8 * DAY_MS, lagMs: null })).toMatch(/완료 예상 —/);
    expect(vcLogCatchupText({ ...base, state: 'ok', okAtEnd: NOW })).toBe('');
    const [r] = vcLogCollectRows({ collect: [{ vcenterId: 'z', lastPoll: { okAtStart: 5, okAtEnd: '', everyMs: 600_000 } }] });
    expect(r.okAtStart).toBe(5); expect(r.okAtEnd).toBeNull(); expect(r.everyMs).toBe(600_000);
  });
  it('Z2-I1 용량 상한 안내 — 지운 것이 있고 같은 상한일 때만 · 범위 계정은 행의 가장 오래된 시각으로', () => {
    const st = { settings: { maxSizeMB: 1024, retentionDays: 365 }, store: { firstTs: NOW - 6 * DAY_MS }, lastCap: { at: NOW - H, limitBytes: 1024 * 1024 * 1024, dropped: 290318, stuck: false, done: true } };
    const opts = { now: NOW, fmtTime: (ts) => `@${(NOW - ts) / H}h` };
    expect(vcLogCapNoteText(st, [], opts)).toBe('용량 상한(1,024MB)이 실제 보관 기간을 정하고 있습니다 — 가장 오래된 로그 @144h(약 6일 전, 설정 보관 365일보다 짧음) · 마지막 용량 정리 @1h에 290,318건 삭제.');
    expect(vcLogCapNoteText({ ...st, lastCap: { ...st.lastCap, done: false } }, [], opts)).toMatch(/아직 상한을 넘어 다음 주기에 이어 지웁니다\.$/);
    expect(vcLogCapNoteText({ ...st, store: { firstTs: null } }, [{ firstTs: NOW - 2 * DAY_MS }, { firstTs: NOW - 3 * DAY_MS }, { firstTs: null }], opts)).toMatch(/가장 오래된 로그 @72h\(약 3일 전/);
    expect(vcLogCapNoteText({ ...st, store: {} }, [], opts)).toMatch(/가장 오래된 로그 — /);
    expect(vcLogCapNoteText({ ...st, lastCap: { ...st.lastCap, dropped: 0 } }, [], opts)).toBe('');
    expect(vcLogCapNoteText({ ...st, settings: { maxSizeMB: 2048, retentionDays: 365 } }, [], opts)).toBe('', '상한을 바꿨으면 옛 정리 기록으로 말하지 않는다');
    expect(vcLogCapNoteText({ ...st, settings: { maxSizeMB: 0 } }, [], opts)).toBe('');
    expect(vcLogCapNoteText({ settings: st.settings }, [], opts)).toBe('');
    expect(vcLogCapNoteText(st, [], opts)).not.toMatch(/[`*]/);
    const [r] = vcLogCollectRows({ collect: [{ vcenterId: 'a', firstTs: 0, skip: '' }] });
    expect(r.firstTs).toBeNull(); expect(r.skip).toBeNull();
  });
});
