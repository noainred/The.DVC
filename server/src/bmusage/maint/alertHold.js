/**
 * bmusage/maint/alertHold.js — 8a단계 ① **임계 초과 알림(v2.551 bmusage/notify.js)의 정비 창 억제**(순수).
 *
 * 성능 알림 규칙(perfAlerts.dispatch)과 같은 규약을 v2.551 상태 모양에 맞춘다:
 *   · 창(① alerts) 안의 ‘초과’ 발화 → 보내지 않는다. 상태의 notifiedAt 을 앞 값으로 되돌리고 `maint`(창 · 시한 · 시작)를 단다 —
 *     지속 계산은 그대로라 창 안 다음 주기에도 다시 발화하지만 같은 창이면 세지 않는다(창마다 한 번).
 *   · 창 안의 ‘해제’ 발화도 보내지 않는다(세기만).
 *   · 창이 끝난 뒤 첫 ‘초과’ 발화에 앞 상태의 `maint` 가 있으면 **그때 1회** 보내고 afterMaint 표지(제목 ‘창 안부터 초과’).
 *   · 발화가 없는 주기에도 `maint` 를 들고 간다(stepAlert 가 상태를 새로 만들어 표지를 잃지 않게). 추적이 끝나면(정상 복귀 · 끊김) 표지도 사라진다.
 * @param {{ prev:object, next:object, fires:Array, stateOf:(key:string)=>object|null, now:number }} p
 * @returns {{ send:Array, held:number, heldNew:number, after:number, applied:Array<{key,until,ids}> }}
 */
export function holdThresholdFires({ prev = {}, next = {}, fires = [], stateOf = () => null, now = Date.now() } = {}) {
  const send = []; let held = 0; let heldNew = 0; let after = 0; const applied = []; const counted = [];
  const fired = new Set();
  for (const f of fires) {
    const id = `${f.key}|${f.metric}`;
    fired.add(id);
    const ms = stateOf(f.key);
    const pm = prev?.[id]?.maint || null;
    if (ms?.scopes?.alerts) {
      const ids = (ms.windows || []).filter((w) => (w.scopes || []).includes('alerts')).map((w) => w.id).sort();
      applied.push({ key: f.key, until: ms.until.alerts, ids });
      held += 1;
      if (f.kind === 'over' && next[id]) next[id] = { ...next[id], notifiedAt: prev?.[id]?.notifiedAt ?? null, maint: { ids, until: ms.until.alerts, since: pm?.since ?? now } };
      if (!(pm && JSON.stringify(pm.ids || []) === JSON.stringify(ids))) { heldNew += 1; counted.push(ids); }
      continue;
    }
    if (f.kind === 'over' && pm) { after += 1; send.push({ ...f, afterMaint: true, maintIds: pm.ids || [] }); continue; }
    send.push(f);
  }
  // 발화가 없던 추적 상태는 표지를 들고 간다(창 안 · 창 뒤 첫 발화 전).
  for (const [id, st] of Object.entries(next)) {
    if (fired.has(id) || !st || st.maint) continue;
    const pm = prev?.[id]?.maint;
    if (pm) next[id] = { ...st, maint: pm };
  }
  return { send, held, heldNew, after, applied, counted };
}
