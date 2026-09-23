/**
 * 성능점검 정의 수신 — 엣지 측 pull 워커.
 *
 * 중앙(`SVCMON_ROLE=central`)이 관리하는 배정을 받아 이 엣지의 로컬 저장소에 적용한다.
 * 적용 후에는 이 엣지의 폴러가 그 대상을 실행하고 결과를 중앙으로 밀어 올린다(svcmonPush).
 *
 * ## 파일을 직접 쓰지 않는다
 * `svcmon.json` 을 통째로 덮어쓰면 빠르지만 **검증을 건너뛴다.** store 의 로드 경로는 값을
 * 검증하지 않으므로, SSRF 가드·유형별 필수값을 통과하지 않은 host 가 그대로 실행 인덱스에
 * 올라간다. 반드시 공개 함수(`bulkAddTargets`)를 통해 넣는다.
 *
 * ## 교체 순서와 반환값 검사(멱등 교체 — v2.279)
 * `central:` 접두 배치를 **전부 삭제** → `bulkAddTargets(새 목록, {batch: 새 태그})` 순서다.
 * 직전 태그 하나만 지우던 과거 방식은 엣지 재시작(appliedSig 인메모리 유실 → 전문 재수신)이나
 * 세대 2개 이상 누락 시, 현/구 세대 대상이 저장에 남아 dedup 으로 전부 `skip` 되고(added=0)
 * 중앙이 수 불일치로 `active` 전이에 실패해 배정이 `mismatch` 로 영구 고착했다. central 관리
 * 대상을 통째로 교체하면 저장분이 수신 목록과 정확히 일치(added=전체 수)해 멱등해진다.
 * **반환값을 모두 검사한다**:
 *  - `bulkAddTargets` 는 상한·검증 실패에 예외를 던지지 않고 `{committed:false, added:0}` 을
 *    돌려준다. 확인하지 않으면 '적용했다'고 중앙에 회신하면서 실제로는 아무것도 없다.
 * 그래서 결과를 중앙에 ack 로 회신하고, 중앙은 수가 일치할 때만 `active` 로 전이한다.
 */

import { config } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { bulkAddTargets, deleteTargetsByBatch, batchCounts, LIMITS } from '../svcmon/store.js';

// 중앙 배포 배치 태그 접두사 — central/svcmonAssign.js TAG_PREFIX 와 같은 프로토콜 계약이다.
// (엣지가 central 모듈을 import 하지 않도록 상수만 복제. 값이 바뀌면 양쪽을 함께 고칠 것.)
const CENTRAL_BATCH_PREFIX = 'central:';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };

const INTERVAL_MS = Math.max(30_000, envNum('SVCMON_CONFIG_PULL_MS', 300_000));   // 기본 5분
const ENABLED = process.env.SVCMON_CONFIG_PULL !== 'false';

let timer = null;
let running = false;
let appliedSig = '';        // 마지막으로 적용에 성공한 sig
let last = null;
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
let unsupportedUntil = 0;

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(config.agent.name ? { 'X-Agent-Name': config.agent.name } : {}),
    ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
  };
}

/**
 * 적용 결과를 중앙에 알린다. 성공이면 true.
 * v2.593(감사 EDGE-1 — 재현): 예전엔 반환값이 없고 `r.ok` 도 보지 않았는데 호출부가 ack **전에** appliedSig 를
 * 세웠다 — ack 가 한 번 실패하면 다음 pull 이 그 sig 를 보내 중앙이 `unchanged` 로 답하고, 엣지는 다시 ack 하지
 * 않아 중앙 배정 상태가 **영원히 'pending'** 이었다. 이제 ack 가 성공해야 appliedSig 를 세운다(실패하면 다음 pull 이
 * 정의 전문을 다시 받아 멱등 재적용 후 다시 ack 한다 — 적용 자체는 되돌리지 않는다).
 */
async function ack(sig, applied, removed, errors) {
  try {
    const r = await resilientFetch(`${config.agent.centralUrl}/api/central/svcmon-config-ack`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ sig, applied, removed, errors: errors.slice(0, 20) }),
      timeoutMs: 20_000, retries: 1,
    });
    if (!r.ok) { console.warn(`[svcmon-pull] ack 실패: HTTP ${r.status} — 다음 pull 에서 다시 적용·보고합니다`); return false; }
    return true;
  } catch (e) {
    // ack 실패는 적용 자체를 되돌리지 않는다(롤백하면 감시 공백이 생긴다) — 다음 pull 에서 다시 보고한다.
    console.warn(`[svcmon-pull] ack 실패: ${e?.message || e} — 다음 pull 에서 다시 적용·보고합니다`);
    return false;
  }
}

export async function pullSvcmonConfigNow() {
  if (!ENABLED) return { ok: false, reason: 'SVCMON_CONFIG_PULL=false' };
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'CENTRAL_URL/토큰 미설정' };
  if (running) return { ok: false, reason: '이전 pull 진행 중' };
  if (Date.now() < unsupportedUntil) return { ok: false, reason: '중앙이 이 기능을 지원하지 않습니다(백오프 중)' };

  running = true;
  try {
    const qs = new URLSearchParams({ agent: config.agent.name || '' });
    if (appliedSig) qs.set('sig', appliedSig);
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/svcmon-config?${qs}`, {
      method: 'GET', headers: headers(), timeoutMs: envNum('SVCMON_PULL_TIMEOUT_MS', 60_000), retries: 1,
    });
    if (res.status === 404) {
      unsupportedUntil = Date.now() + 3_600_000;
      return { ok: false, reason: '중앙이 /api/central/svcmon-config 를 지원하지 않습니다(1시간 후 재시도).' };
    }
    if (!res.ok) {
      // v2.591(PR-7): 예전엔 상태(last)에도 안 남았다 — svcmon-config 는 개별 토큰 전용이라 공유 토큰 엣지는 **영구 403** 인데 흔적이 없었다.
      let why = '';
      try { const b = await res.json(); why = String(b?.reason || '').slice(0, 200); } catch { /* 본문 없음 */ }
      const reason = `pull → ${res.status}${why ? ` — ${why}` : ''}`;
      last = { at: Date.now(), error: reason };
      if (_logChange('pull', reason)) console.warn(`[svcmon-pull] 중앙 정의 pull 실패: ${reason}`);
      return { ok: false, reason };
    }
    const d = await res.json();
    if (!d?.assigned) {
      // v2.596(감사 EF-2 — 재현): 중앙이 배정을 지우면(명시적 200 + assigned:false) 중앙이 배포한 central:* 배치를 지운다 —
      //   예전엔 상태만 적고 끝나 엣지가 지워진 배정의 점검을 계속 돌렸다. 404·5xx 는 여기 오지 않는다(위에서 실패로 반환).
      //   사용자가 직접 만든 배치(다른 접두)는 건드리지 않는다.
      let removed = 0;
      for (const tag of [...batchCounts().keys()].filter((b) => b.startsWith(CENTRAL_BATCH_PREFIX))) removed += deleteTargetsByBatch(tag).removed || 0;
      if (removed) { appliedSig = ''; console.log(`[svcmon-pull] 중앙 배정이 해제돼 중앙 배포 점검 대상 ${removed}개를 지웠습니다`); }
      last = { at: Date.now(), assigned: false, ...(removed ? { removed } : {}) };
      return { ok: true, assigned: false, removed };
    }
    if (d.unchanged) { last = { at: Date.now(), assigned: true, unchanged: true, sig: d.sig }; return { ok: true, unchanged: true, sig: d.sig }; }

    const targets = Array.isArray(d.targets) ? d.targets : [];
    if (targets.length > LIMITS.maxTargets) {
      const reason = `배정 대상이 상한을 넘습니다(${targets.length} > ${LIMITS.maxTargets}).`;
      await ack(d.sig, { added: 0, newTests: 0 }, 0, [reason]);
      return { ok: false, reason };
    }

    // ① 이전 배포분 삭제 — 멱등 교체(v2.279 회귀 수정). 과거에는 d.prevTag(직전 세대) 하나만
    //    지웠는데, appliedSig 가 인메모리라 **엣지 재시작 시 전문을 다시 받고**(unchanged 아님)
    //    현 세대(d.tag) 대상이 이미 저장돼 있어 bulkAddTargets 가 전부 dedup skip → added=0 →
    //    중앙이 수 불일치로 'active' 전이 실패, 배정이 'mismatch' 로 영구 고착했다(세대 2개 이상
    //    누락 시엔 오래된 세대가 계속 남았다). 저장된 **central: 접두 배치를 전부 지우고** 새로
    //    등록해, 저장분이 수신 목록과 정확히 일치(added=전체 수)하도록 멱등하게 만든다.
    //    사용자가 직접 만든 배치(import/generate — 다른 접두)는 건드리지 않는다.
    let removed = 0;
    const errors = [];
    const centralTags = [...batchCounts().keys()].filter((b) => b.startsWith(CENTRAL_BATCH_PREFIX));
    for (const tag of centralTags) {
      const del = deleteTargetsByBatch(tag);
      removed += del.removed || 0;
      if (del.error && !/없습니다/.test(del.error)) errors.push(`이전 배포분(${tag}) 삭제: ${del.error}`);
      if (del.saved === false) errors.push('이전 배포분 삭제 후 저장 실패(디스크·권한 확인)');
    }

    // ② 새 정의 등록 — 반환값을 반드시 확인한다(예외를 던지지 않는 실패가 있다).
    const r = bulkAddTargets(targets, { batch: d.tag, atomic: true, dedup: true });
    if (!r.committed) {
      for (const e of (r.errors || []).slice(0, 10)) errors.push(`${e.row}행 ${e.name}: ${e.reason}`);
      errors.push('검증 실패로 적용하지 않았습니다(부분 적용 없음).');
    } else if (r.saved === false) {
      errors.push('적용했지만 파일 저장에 실패했습니다(재기동 시 유실).');
    }
    const acked = await ack(d.sig, { added: r.added || 0, newTests: r.newTests || 0 }, removed, errors);
    if (r.committed && !errors.length && acked) appliedSig = d.sig;
    last = {
      at: Date.now(), assigned: true, sig: d.sig, tag: d.tag, acked,
      added: r.added || 0, newTests: r.newTests || 0, skipped: (r.skipped || []).length,
      removed, committed: !!r.committed, errors,
    };
    if (errors.length) console.warn(`[svcmon-pull] 적용 문제: ${errors.join(' · ')}`);
    else console.log(`[svcmon-pull] 정의 적용 — 대상 ${r.added} · 점검 ${r.newTests} · 이전분 삭제 ${removed} (sig ${d.sig})`);
    return { ok: !errors.length, ...last };
  } catch (e) {
    last = { at: Date.now(), error: e?.message || String(e) };
    if (_logChange('pull', last.error)) console.warn(`[svcmon-pull] 실패: ${last.error}`);
    return { ok: false, reason: last.error };
  } finally {
    running = false;
  }
}

export function svcmonConfigPullStatus() {
  return {
    enabled: ENABLED && !!config.agent.centralUrl && !!config.agent.centralToken,
    centralUrl: config.agent.centralUrl || '',
    agent: config.agent.name || '',
    intervalMs: INTERVAL_MS,
    appliedSig,
    unsupportedUntil: unsupportedUntil || null,
    last,
  };
}

export function startSvcmonConfigPull() {
  if (timer) return;
  if (!ENABLED || !config.agent.centralUrl || !config.agent.centralToken) return;
  if (config.svcmonRole === 'central') return;      // 중앙은 배포하는 쪽이다(받지 않는다)
  setTimeout(() => {
    pullSvcmonConfigNow().catch((e) => console.error('[svcmon-pull] 실패:', e?.message || e));
    timer = setInterval(() => { pullSvcmonConfigNow().catch(() => {}); }, INTERVAL_MS);
    timer.unref?.();
  }, 10_000).unref?.();
  console.log(`[svcmon-pull] 정의 수신 시작 → ${config.agent.centralUrl} (${Math.round(INTERVAL_MS / 1000)}초 주기)`);
}
