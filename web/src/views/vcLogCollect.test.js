// v2.765 — 설정 › vCenter 로그 보관의 vCenter 별 수집 상태 표 문구(순수). 실서버 OC2 이벤트 수집 13일 정체를 화면이 말하게.
import { describe, it, expect } from 'vitest';
import { vcLogCollectRows, vcLogStateText, vcLogStateClass, vcLogLagText, vcLogLagWarn, vcLogCappedText, vcLogReadStoredText, vcLogDurText, vcLogMaxPerPollText, vcLogHintText, DAY_MS } from './vcLogCollect.js';

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
    expect(vcLogReadStoredText({ read: 4000, stored: 3990, rounds: 4 }, fmt)).toBe('4,000 / 3,990 (4회)');
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
