/**
 * linkcheck/poller.js — 통신 점검 폴러(v2.552).
 *
 * 규약(회귀 방지 — 루트 CLAUDE.md '적용된 성능 메커니즘'):
 *  · **재진입 가드**를 수동 실행('지금 점검')과 **공유**한다 — 연타가 점검 세션을 곱하지 않게.
 *  · **동시성 제한**(`concurrency`, 기본 6) — 링크가 140개까지 늘 수 있고 한꺼번에 열면 매 주기
 *    소켓 수백 개가 열린다. 고RTT(폴란드·미국동부 RTT 800ms↑) 환경에서는 그 자체가 지연이다.
 *  · `startAdaptiveTimer(getMs, fn, opts)` — `setInterval` 은 생성 시 간격에 묶여 중앙에서 주기를
 *    바꿔도 재시작해야 먹는다.
 *  · prune 스로틀 `(++tick % N) === 0` — `% N === 1` 이나 `tick++ % N === 0` 은 **기동 첫 틱에
 *    즉발**해 보존기간을 줄인 직후 재시작이 차액을 한 번에 지운다(v2.453).
 *
 * ⚠⚠ **중앙은 `by:'central'` 링크만 잰다.** 엣지가 재는 링크를 중앙에서 돌리면 '중앙에서 안
 *   닿는다' 를 그 링크 상태로 기록하는 거짓이 된다(엣지는 닿는다) — 그 값은 엣지 보고
 *   (`central/linkCheckEdge.js`)가 채운다.
 */
import { config } from '../config.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { loadCollectors } from '../collector/registry.js';
import { listRegistry as listVcenters } from '../vcenter/registry.js';
import { buildLinks, CENTRAL_KINDS } from './links.js';
import { buildSettingsTargets } from './settingsLinks.js';
import { runSettingsTarget } from './settingsRun.js';
import { loadLinkCheckSettings, linkCheckEnabled, onLinkCheckSettingsChange } from './settings.js';
import { runLink } from './run.js';
import { insertResults, pruneLinkCheck } from './db.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스

/*
 * **측정자 이름은 지어내지 않는다.** 이 폴러는 중앙에서도 엣지에서도 돈다(중계 엣지는 자기
 * 하위 수집 서버를 갖는다). 엣지에서 돈 측정을 `byNode:'central'` 로 적으면 "중앙에서 쟀다" 는
 * 거짓이 되고, 나중에 로그를 보는 사람이 어느 노드에서 안 닿았는지를 잘못 판단한다.
 */
const selfNode = () => (config.agent?.centralUrl ? (String(config.agent?.name || '').trim() || 'edge') : 'central');

let running = false;          // 재진입 가드 — 수동 실행과 공유한다
let _last = null;             // 마지막 주기 요약(화면이 '언제 점검했나' 를 말한다)
let timer = null;
let tick = 0;

export function linkCheckPollerStatus() {
  const s = loadLinkCheckSettings();
  return {
    enabled: s.enabled, running,
    intervalMs: s.intervalMs, concurrency: s.concurrency,
    last: _last,
  };
}

/** 지금 이 노드가 잴 수 있는 링크. 중앙/엣지 판정은 `config.agent.name` 이 아니라 역할로 한다. */
export function centralLinks() {
  const cols = loadCollectors();          // ⚠ 토큰이 필요하므로 redact 되지 않은 원본을 쓴다
  const s = loadLinkCheckSettings();
  const { links, counts, problems } = buildLinks({
    collectors: cols, vcenters: listVcenters(), pairs: s.pairs, settings: s,
  });
  return {
    all: links, counts, problems,
    mine: links.filter((l) => CENTRAL_KINDS.includes(l.kind) && l.enabled !== false),
    collectors: cols,
  };
}

// v2.579(ARCH-01): 풀 스캐폴드는 util/pool.js 하나다 — 항목별 결과 모양(예전 그대로)만 여기서 입힌다.
async function pool(items, limit, fn) {
  return (await poolSettled(items, limit, fn)).map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message || r.reason) }));
}

/**
 * 한 주기. `trigger:'manual'` 이어도 **같은 가드**를 쓴다.
 * @returns {{ok:boolean, skipped?:string, checked?:number, failed?:number, skippedLinks?:number}}
 */
export async function pollOnce({ trigger = 'timer' } = {}) {
  if (running) return { ok: false, skipped: 'already-running' };
  if (!linkCheckEnabled()) return { ok: false, skipped: 'disabled' };
  running = true;
  const startedAt = Date.now();
  try {
    const s = loadLinkCheckSettings();
    const { mine, counts, problems, collectors } = centralLinks();
    const ctx = {
      collectors: new Map(collectors.map((c) => [String(c.name || c.id), c])),
      collectorIds: collectors.map((c) => String(c.id || '')),
    };
    const timeouts = { dnsMs: s.dnsTimeoutMs, tcpMs: s.tcpTimeoutMs, tlsMs: s.tlsTimeoutMs, httpMs: s.httpTimeoutMs, sshMs: s.sshTimeoutMs, smtpMs: s.smtpTimeoutMs };

    const node = selfNode();
    const results = await pool(mine, s.concurrency, (l) => runLink(l, { timeouts, ctx, byNode: node }));

    /*
     * ⚠⚠ **설정 전수 점검도 같은 주기·같은 가드·같은 DB 를 쓴다**(v2.553). 폴러를 하나 더 만들면
     *   재진입 가드가 둘이 되어 같은 장비에 동시에 두 세션이 열린다(CLAUDE.md 폴러 규약).
     *   대상 id 는 `set:<종류>|<ref>` 라 v2.552 링크 id 와 **이름공간이 겹치지 않는다**.
     */
    let setResults = [];
    let setProblems = [];
    let setSourceErrors = [];
    let setIds = [];
    if (s.settingsCheck !== false) {
      const built = await buildSettingsTargets();
      setProblems = built.problems;
      setSourceErrors = built.sourceErrors;
      setIds = built.targets.map((x) => x?.id).filter(Boolean);
      const doable = built.targets.filter((x) => x.enabled !== false && !x.bad
        // 엣지 위임 장비는 중앙에서 닿지 않는 것이 **정상**이다 — 점검해서 '실패' 로 적으면 거짓이다.
        && !(x.agent && node === 'central') && !(node !== 'central' && x.agent && x.agent !== node));
      setResults = await pool(doable, s.concurrency, (x) => runSettingsTarget(x, { timeouts, ctx }));
    }

    const measured = [...results, ...setResults].filter((r) => r && r.verdict);
    const skippedLinks = [...results, ...setResults].filter((r) => r && r.skipped);

    const saved = await insertResults(measured, { byNode: node });
    // ⚠ 스로틀은 `(++tick % N) === 0` — 기동 첫 틱 즉발 금지(v2.453).
    if ((++tick % 12) === 0) {
      /*
       * v2.607(감사 LEFT2607-01): 고아 최신값 정리에 **현재 링크 집합**을 넘긴다 — 예전에는 currentIds 없이 불러
       *   pruneOrphanLatest 가 한 번도 돌지 않았다(엣지 삭제·vCenter 이관으로 사라진 링크가 보존일까지 남았다).
       *   현재 집합 = 중앙이 계산한 전 링크(엣지가 재는 것 포함) ∪ 설정 전수 대상(set:*). 설정 대상을 다 읽지 못한
       *   주기(sourceErrors)에는 그 대상의 행을 지우지 않도록 넘기지 않는다(판정 보류). 설정 점검이 꺼져 있으면 set:* 행은
       *   더 갱신되지 않는 낡은 값이므로 링크 집합만 넘긴다(1일 넘게 갱신되지 않은 것만 지워진다 — db.js LATEST_ORPHAN_MS).
       */
      const currentIds = (setSourceErrors && setSourceErrors.length) ? null : [...centralLinks().all.map((l) => l.id), ...setIds];
      await pruneLinkCheck({ sampleDays: s.sampleRetentionDays, eventDays: s.eventRetentionDays, dailyDays: s.dailyRetentionDays, force: true, currentIds });
    }

    const failed = measured.filter((r) => !r.verdict.ok).length;
    _last = {
      at: startedAt, ms: Date.now() - startedAt, trigger, node,
      links: counts.total, mine: mine.length,
      settingsTargets: setResults.length, settingsProblems: setProblems.length, settingsSourceErrors: setSourceErrors,
      checked: measured.length, failed, ok: measured.length - failed,
      skipped: skippedLinks.length,
      // ⚠ **건너뛴 사유를 조용히 버리지 않는다** — '점검했는데 정상' 과 구분해야 한다.
      // ⚠ 설정 대상은 `target`, v2.552 링크는 `link` 다 — 한쪽만 읽으면 사유가 빈 문자열이 된다.
      skippedReasons: skippedLinks.slice(0, 20).map((r) => ({ id: r.link?.id || r.target?.id || '', reason: r.skipped })),
      skippedTruncated: Math.max(0, skippedLinks.length - 20),
      problems: problems.length,
      dbOk: saved.ok !== false, dbError: saved.error || '',
      events: saved.events || 0,
    };
    return { ok: true, checked: measured.length, failed, skippedLinks: skippedLinks.length };
  } catch (e) {
    _last = { at: startedAt, ms: Date.now() - startedAt, trigger, error: String(e?.message || e).slice(0, 300) };
    return { ok: false, error: String(e?.message || e) };
  } finally {
    running = false;
  }
}

export function startLinkCheckPoller() {
  if (timer) return;
  // 기동 직후에 몰리지 않게 지연 시작(다른 폴러와 겹치면 첫 분에 CPU 가 튄다).
  timer = startAdaptiveTimer(
    () => loadLinkCheckSettings().intervalMs,
    () => pollOnce({ trigger: 'timer' }),
    { firstDelayMs: 45_000, name: 'linkcheck', subscribe: onLinkCheckSettingsChange },
  );
  return timer;
}

export function stopLinkCheckPoller() { timer?.stop?.(); timer = null; }

export function _resetPollerForTest() { running = false; _last = null; tick = 0; }
