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
 * ## 교체 순서와 반환값 검사
 * `deleteTargetsByBatch(이전 태그)` → `bulkAddTargets(새 목록, {batch: 새 태그})` 순서다.
 * **두 반환값을 모두 검사해야 한다**:
 *  - 삭제를 건너뛰면 이름이 겹쳐 dedup 으로 전부 `skip` 되고 **정의가 갱신되지 않는다**
 *    (갱신이 아니라 skip 이다 — 실측 확인).
 *  - `bulkAddTargets` 는 상한·검증 실패에 예외를 던지지 않고 `{committed:false, added:0}` 을
 *    돌려준다. 확인하지 않으면 '적용했다'고 중앙에 회신하면서 실제로는 아무것도 없다.
 * 그래서 결과를 중앙에 ack 로 회신하고, 중앙은 수가 일치할 때만 `active` 로 전이한다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { bulkAddTargets, deleteTargetsByBatch, LIMITS } from '../svcmon/store.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };

const INTERVAL_MS = Math.max(30_000, envNum('SVCMON_CONFIG_PULL_MS', 300_000));   // 기본 5분
const ENABLED = process.env.SVCMON_CONFIG_PULL !== 'false';

let timer = null;
let running = false;
let appliedSig = '';        // 마지막으로 적용에 성공한 sig
let last = null;
let unsupportedUntil = 0;

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(config.agent.name ? { 'X-Agent-Name': config.agent.name } : {}),
    ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
  };
}

async function ack(sig, applied, removed, errors) {
  try {
    await resilientFetch(`${config.agent.centralUrl}/api/central/svcmon-config-ack`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ sig, applied, removed, errors: errors.slice(0, 20) }),
      timeoutMs: 20_000, retries: 1,
    });
  } catch (e) {
    // ack 실패는 적용 자체를 되돌리지 않는다 — 중앙이 pending 으로 남겨 두고 다음 주기에
    // 다시 확인하는 편이 안전하다(적용을 롤백하면 감시 공백이 생긴다).
    console.warn(`[svcmon-pull] ack 실패: ${e?.message || e}`);
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
    if (!res.ok) return { ok: false, reason: `pull → ${res.status}` };
    const d = await res.json();
    if (!d?.assigned) { last = { at: Date.now(), assigned: false }; return { ok: true, assigned: false }; }
    if (d.unchanged) { last = { at: Date.now(), assigned: true, unchanged: true, sig: d.sig }; return { ok: true, unchanged: true, sig: d.sig }; }

    const targets = Array.isArray(d.targets) ? d.targets : [];
    if (targets.length > LIMITS.maxTargets) {
      const reason = `배정 대상이 상한을 넘습니다(${targets.length} > ${LIMITS.maxTargets}).`;
      await ack(d.sig, { added: 0, newTests: 0 }, 0, [reason]);
      return { ok: false, reason };
    }

    // ① 이전 배포분 삭제 — 건너뛰면 이름 중복으로 전부 skip 되어 정의가 갱신되지 않는다.
    let removed = 0;
    const errors = [];
    if (d.prevTag) {
      const del = deleteTargetsByBatch(d.prevTag);
      removed = del.removed || 0;
      // '없음'은 정상이다(첫 배포·이미 정리됨). 그 외 오류는 그대로 보고한다.
      if (del.error && !/대상이 없습니다/.test(del.error)) errors.push(`이전 배포분 삭제: ${del.error}`);
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
    if (r.committed && !errors.length) appliedSig = d.sig;

    await ack(d.sig, { added: r.added || 0, newTests: r.newTests || 0 }, removed, errors);
    last = {
      at: Date.now(), assigned: true, sig: d.sig, tag: d.tag,
      added: r.added || 0, newTests: r.newTests || 0, skipped: (r.skipped || []).length,
      removed, committed: !!r.committed, errors,
    };
    if (errors.length) console.warn(`[svcmon-pull] 적용 문제: ${errors.join(' · ')}`);
    else console.log(`[svcmon-pull] 정의 적용 — 대상 ${r.added} · 점검 ${r.newTests} · 이전분 삭제 ${removed} (sig ${d.sig})`);
    return { ok: !errors.length, ...last };
  } catch (e) {
    last = { at: Date.now(), error: e?.message || String(e) };
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
