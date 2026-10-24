/**
 * veeam/progress.js — Veeam 서버 한 대의 '진행 상태'(v2.773 — 사용자 요청 "진행상태를 자세하게 볼수있게 해줘").
 *
 * 엣지가 읽는 서버는 배정 → 개별 토큰 → 엣지 접속 → 배정 받기(veeam-config) → 엣지에서 읽기 → 결과 올리기(veeam-data) → 중앙 반영
 * 순서로 흐른다. 예전 화면은 마지막 칸(중앙 반영)만 보여 줘 '아직 읽지 않음' 이 어느 단계에서 막혔는지 알 수 없었다.
 * 여기서는 **이미 기록된 값만** 모아 단계마다 판정한다(새로 수집하지 않는다 — 순수 함수):
 *  · 개별 토큰 목록(agentTokens) · 엣지 GET 기록(central/pullStats — 실패 포함) · 거부된 push(central/ingestReject)
 *  · 엣지가 올린 상태(central/veeamEdge — 폴러·마지막 push) · 서버 결과(serverStatusView)
 * ⚠ pullStats·ingestReject·veeamEdge 는 **중앙 메모리**다 — 중앙을 다시 시작하면 비고 엣지가 다시 접속해야 찬다.
 *   그래서 '기록 없음' 을 '안 했다' 로 단정하지 않고 기록 시작 시각(since)을 함께 싣는다.
 * ⚠ 공유 토큰 엣지의 이름은 요청이 주장한 값이다(verified:false) — 문구가 그 사실을 말한다.
 *
 * 단계 state: 'ok' | 'warn' | 'bad' | 'wait'(아직 기록 없음·진행 전) | 'skip'(앞 단계 때문에 해당 없음).
 */

/** 엣지의 마지막 접속이 이보다 오래되면 '최근 접속 없음' 으로 본다(서버 쪽 판정 — 화면에 숫자를 박지 않는다). */
export const CONTACT_STALE_MS = 30 * 60_000;

const lc = (v) => String(v ?? '').trim().toLowerCase();
const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function findRow(rows, agent) {
  const want = lc(agent);
  if (!want || !Array.isArray(rows)) return null;
  return rows.find((r) => lc(r?.agent) === want) || null;
}

/**
 * @param {object} p
 * @param {{id:string, agent?:string, enabled?:boolean, vcenterIds?:string[]}} p.server  등록부 항목
 * @param {object|null} p.status       serverStatusView 결과(없으면 null)
 * @param {boolean} p.readsHere        이 노드가 직접 읽는 서버인가
 * @param {string[]|null} p.tokenAgents 개별 토큰이 발급된 엣지 이름(못 읽었으면 null)
 * @param {{rows:Array, since:number}|null} p.pulls  central/pullStats.pullStats()
 * @param {{rows:Array}|null} p.rejects central/ingestReject.rejectStats()
 * @param {object|null} p.edge         central/veeamEdge.veeamEdgeStatus(agent)
 * @param {object|null} p.poller       이 노드의 veeamPollerStatus()(직접 읽는 서버용)
 * @param {number} [p.now]
 * @returns {{ mode:'edge'|'local', steps:Array<{key:string,label:string,state:string,text:string,at:number|null,action?:string}>, blockedAt:string|null, since:number|null, checkedAt:number|null }}
 */
export function veeamProgress({ server, status = null, readsHere = false, tokenAgents = null, pulls = null, rejects = null, edge = null, poller = null, now = Date.now() } = {}) {
  const steps = [];
  const add = (key, label, state, text, at = null, action = '') => steps.push({ key, label, state, text, at: posNum(at), ...(action ? { action } : {}) });
  const agent = String(server?.agent || '').trim();
  const mode = agent && !readsHere ? 'edge' : 'local';
  const vcs = Array.isArray(server?.vcenterIds) ? server.vcenterIds.length : 0;
  const off = server?.enabled === false;

  // 1. 배정
  if (off) add('assign', '배정', 'skip', '수집이 꺼진 서버입니다 — 아래 단계는 진행하지 않습니다(수정에서 수집을 켜세요).');
  else if (!vcs) add('assign', '배정', 'warn', '묶인 vCenter 가 없습니다 — 결과를 붙일 곳이 없습니다.', null, '수정에서 vCenter 를 고르세요.');
  else add('assign', '배정', 'ok', `vCenter ${vcs}개 · 읽는 곳 ${mode === 'edge' ? `엣지 ${agent}` : agent ? `이 노드(엣지 ${agent})` : '중앙'}`);

  if (mode === 'edge') {
    const gone = off;
    // 2. 개별 토큰 — Veeam 위임 라우트는 개별 토큰만 받는다(routes/central.js veeam-config · veeam-data).
    //   항목은 이름 문자열 또는 { agent, lastUsedAt }(listAgentTokens) — lastUsedAt 이 실려 있고 비었으면 '발급만 하고 엣지가 아직 안 씀'.
    const tk = Array.isArray(tokenAgents) ? tokenAgents.find((a) => lc(typeof a === 'string' ? a : a?.agent) === lc(agent)) : undefined;
    const hasToken = Array.isArray(tokenAgents) ? !!tk : null;
    const usedAt = tk && typeof tk === 'object' ? posNum(tk.lastUsedAt) : null;
    if (gone) add('token', '개별 토큰', 'skip', '수집이 꺼져 있어 확인하지 않습니다.');
    else if (hasToken === null) add('token', '개별 토큰', 'warn', '개별 토큰 목록을 읽지 못했습니다 — 발급 여부를 모릅니다.');
    else if (hasToken && tk && typeof tk === 'object' && 'lastUsedAt' in tk && !usedAt) add('token', '개별 토큰', 'warn', `엣지 ${agent} 의 개별 토큰은 발급됐지만 그 토큰으로 접속한 기록이 없습니다 — 엣지가 아직 공유 토큰을 쓰고 있을 수 있습니다.`,
      null, `엣지 ${agent} 의 CENTRAL_TOKEN 을 발급한 개별 토큰으로 바꾼 뒤 엣지 포탈을 다시 시작하세요.`);
    else if (hasToken) add('token', '개별 토큰', 'ok', `엣지 ${agent} 의 개별 토큰이 발급돼 있습니다${usedAt ? ' — 마지막 사용 시각' : ''}.`, usedAt);
    else add('token', '개별 토큰', 'bad', `엣지 ${agent} 에 개별 토큰이 없습니다 — 중앙은 Veeam 자격증명을 개별 토큰으로만 내려줍니다(공유 토큰은 어느 엣지인지 가릴 수 없어 403).`,
      null, `설정 › 수집 서버에서 ${agent} 의 개별 토큰을 발급하고, 그 엣지의 CENTRAL_TOKEN 을 그 값으로 바꾼 뒤 엣지 포탈을 다시 시작하세요.`);

    // 3. 엣지 접속 — 이 엣지가 중앙에 마지막으로 요청한 시각(설정 pull 전부 + Veeam 상태 push).
    const pr = findRow(pulls?.rows, agent);
    const seen = Math.max(posNum(pr?.lastAt) || 0, posNum(edge?.at) || 0) || null;
    const since = posNum(pulls?.since);
    if (gone) add('contact', '엣지 접속', 'skip', '수집이 꺼져 있어 확인하지 않습니다.');
    else if (!seen) add('contact', '엣지 접속', 'wait', `중앙이 기록을 시작한 뒤로 엣지 ${agent} 의 요청이 없습니다 — 엣지가 꺼졌거나, 중앙 주소·토큰이 다르거나, 중앙이 방금 다시 시작했을 수 있습니다.`,
      null, '엣지 포탈의 서비스 상태와 CENTRAL_URL·CENTRAL_TOKEN 을 확인하세요.');
    else {
      const unverified = pr && pr.verified !== true && !(edge?.at);
      const tail = unverified ? ' · 공유 토큰으로 접속 중(이름은 요청이 주장한 값 — 검증 안 됨)' : '';
      if (now - seen > CONTACT_STALE_MS) add('contact', '엣지 접속', 'warn', `엣지 ${agent} 의 마지막 요청이 오래됐습니다${tail}.`, seen, '엣지 포탈이 살아 있는지, 중앙에 닿는지 확인하세요.');
      else add('contact', '엣지 접속', 'ok', `엣지 ${agent} 가 중앙에 접속하고 있습니다${tail}.`, seen);
    }

    // 4. 배정 받기(veeam-config pull) — 실패(403 등)도 기록된다.
    const ep = Array.isArray(pr?.byEndpoint) ? pr.byEndpoint.find((e) => e?.endpoint === '/veeam-config') : null;
    const okAt = posNum(ep?.lastOkAt); const failAt = posNum(ep?.lastFailAt);
    const tally = ep ? ` (성공 ${cnt(ep.okCount) ?? 0} · 실패 ${cnt(ep.failCount) ?? 0})` : '';
    if (gone) add('pull', '배정 받기', 'skip', '수집이 꺼져 있어 엣지에 배정하지 않습니다.');
    else if (!ep) {
      if (!seen) add('pull', '배정 받기', 'wait', '엣지 접속 기록이 없어 아직 판단할 수 없습니다.');
      else {
        const ver = String(edge?.status?.version || '').trim();
        add('pull', '배정 받기', 'warn', `엣지 ${agent} 는 중앙에 접속하지만 Veeam 배정을 가져간 기록이 없습니다 — 엣지가 이 기능(v2.751)보다 옛 판이거나 아직 그 주기가 오지 않았을 수 있습니다${ver ? `(엣지 판 ${ver})` : ''}.`,
          null, '엣지를 최신 판으로 올리세요. 이미 최신이면 몇 분 뒤 다시 보세요.');
      }
    } else if (failAt && (!okAt || failAt > okAt)) {
      const st = Number(ep.lastStatus) || 0;
      if (st === 403) add('pull', '배정 받기', 'bad', `중앙이 배정 요청을 거절했습니다(403 — 개별 토큰이 아닌 요청)${tally}.`, failAt, `2단계(개별 토큰)를 먼저 해결하세요 — 엣지 ${agent} 의 CENTRAL_TOKEN 이 개별 토큰이어야 합니다.`);
      else if (st === 503) add('pull', '배정 받기', 'bad', `중앙이 배정을 내려주지 못했습니다(503 — 중앙 Veeam 서버 등록부를 읽지 못함)${tally}.`, failAt, '중앙 포탈 콘솔 로그에서 Veeam 등록부 오류를 확인하세요.');
      else add('pull', '배정 받기', 'bad', `배정 요청이 실패했습니다(HTTP ${st || '—'})${tally}.`, failAt);
    } else add('pull', '배정 받기', 'ok', `엣지가 Veeam 배정을 가져갔습니다${tally}.`, okAt);

    // 5. 엣지에서 읽기 — 엣지가 올린 폴러 상태(그 엣지가 맡은 서버 전체의 마지막 주기).
    const p = edge?.status?.poller || null;
    if (gone) add('read', '엣지에서 읽기', 'skip', '수집이 꺼져 있습니다.');
    else if (!edge) add('read', '엣지에서 읽기', 'wait', `엣지 ${agent} 가 아직 Veeam 상태를 올리지 않았습니다(배정을 받은 뒤 첫 주기가 끝나야 올라옵니다).`);
    else if (!posNum(p?.at)) add('read', '엣지에서 읽기', 'wait', p?.running ? '엣지가 첫 주기를 읽는 중입니다.' : `엣지가 아직 한 주기를 끝내지 않았습니다(맡은 서버 ${cnt(edge?.status?.servers) ?? '—'}대).`);
    else {
      const ok = cnt(p.ok); const fail = cnt(p.fail);
      const txt = `그 엣지의 마지막 주기 — 성공 ${ok ?? '—'}대 · 실패 ${fail ?? '—'}대 (맡은 서버 ${cnt(edge?.status?.servers) ?? '—'}대)${p.running ? ' · 지금 읽는 중' : ''}`;
      if (fail && !ok) add('read', '엣지에서 읽기', 'bad', `${txt}.`, p.at, '실패 사유는 아래 중앙 반영 단계 또는 그 엣지 포탈의 이 화면에서 보세요.');
      else if (fail) add('read', '엣지에서 읽기', 'warn', `${txt}.`, p.at);
      else add('read', '엣지에서 읽기', 'ok', `${txt}.`, p.at);
    }

    // 6. 결과 올리기(veeam-data push) — 받은 것과 거부된 것.
    const lp = edge?.lastPush || null;
    const rj = findRow(rejects?.rows, agent);
    const rjN = rj && rj.byEndpoint && typeof rj.byEndpoint === 'object' ? (cnt(rj.byEndpoint['/veeam-data']) || 0) : 0;
    if (gone) add('push', '결과 올리기', 'skip', '수집이 꺼져 있습니다.');
    else if (!lp) {
      if (rjN) add('push', '결과 올리기', 'bad', `엣지가 올린 Veeam 결과를 중앙이 ${rjN}회 거절했습니다${rj?.lastReason ? `(마지막 사유: ${String(rj.lastReason).slice(0, 160)})` : ''}.`, rj?.lastAt, '2단계(개별 토큰)를 먼저 확인하세요.');
      else add('push', '결과 올리기', 'wait', '엣지가 올린 Veeam 결과가 아직 없습니다.');
    } else {
      const res = cnt(lp.results) ?? 0; const saved = cnt(lp.saved) ?? 0;
      const d = lp.dropped || {};
      const why = [d.notOwned ? `배정되지 않은 서버 ${d.notOwned}` : '', d.stale ? `옛 접속처 결과 ${d.stale}` : '', d.bad ? `형식 오류 ${d.bad}` : ''].filter(Boolean).join(' · ');
      const base = `마지막 push — 결과 ${res}건 · 저장 ${saved}건${why ? ` · 버림 ${why}` : ''}${rjN ? ` · 거절된 push ${rjN}회` : ''}`;
      if (!res) add('push', '결과 올리기', 'warn', `${base} — 엣지가 아직 이 서버의 결과를 싣지 않았습니다.`, lp.at);
      else if (!saved) add('push', '결과 올리기', 'warn', `${base}.`, lp.at, why.includes('옛 접속처') ? '접속처를 바꿨다면 엣지가 새 배정을 가져간 뒤 풀립니다.' : '');
      else add('push', '결과 올리기', 'ok', `${base}.`, lp.at);
    }
  } else {
    // 직접 읽는 서버(중앙 담당 또는 이 엣지의 자기 몫) — 이 노드의 폴러.
    const p = poller || {};
    if (off) add('read', '이 노드에서 읽기', 'skip', '수집이 꺼져 있습니다.');
    else if (p.running && !posNum(p.at)) add('read', '이 노드에서 읽기', 'wait', '첫 주기를 읽는 중입니다.');
    else if (!posNum(p.at)) add('read', '이 노드에서 읽기', 'wait', '포탈이 시작된 뒤 아직 한 주기를 끝내지 않았습니다.');
    else {
      const ok = cnt(p.ok); const fail = cnt(p.fail);
      const txt = `이 노드의 마지막 주기 — 성공 ${ok ?? '—'}대 · 실패 ${fail ?? '—'}대${p.running ? ' · 지금 읽는 중' : ''}`;
      add('read', '이 노드에서 읽기', fail && !ok ? 'bad' : fail ? 'warn' : 'ok', `${txt}.`, p.at);
    }
  }

  // 마지막. 중앙 반영(=이 서버의 결과) — 상태 칸과 같은 판정(serverStatusView).
  const st = status;
  if (off) add('result', '결과', 'skip', '수집이 꺼져 있습니다.');
  else if (!st) add('result', '결과', 'wait', '이 서버의 결과가 아직 없습니다.');
  else if (st.ok && st.stale) add('result', '결과', 'warn', '마지막 성공 결과가 오래됐습니다 — 그 뒤로 새 결과가 오지 않았습니다.', st.ts);
  else if (st.ok) add('result', '결과', 'ok', `정상 — 작업 ${cnt(st.counts?.jobs) ?? '—'}개.`, st.ts);
  else if (st.authStop) add('result', '결과', 'bad', `인증 실패로 주기 수집이 멈췄습니다${st.error ? ` — ${String(st.error).slice(0, 200)}` : ''}.`, st.ts,
    mode === 'edge' ? `Veeam 계정을 고친 뒤 비밀번호를 바꿔 저장하거나, 엣지 ${agent} 포탈의 이 화면에서 지금 읽기를 누르세요.` : 'Veeam 계정을 고친 뒤 비밀번호를 바꿔 저장하거나 지금 읽기를 누르세요.');
  else add('result', '결과', 'bad', `읽기 실패${st.error ? ` — ${String(st.error).slice(0, 200)}` : ''}.`, st.ts);

  const blocked = steps.find((s) => s.state === 'bad' || s.state === 'warn' || s.state === 'wait');
  // v2.774: checkedAt — 이 판정을 만든 시각(사용자 요청 '마지막으로 체크한 시간 표시'). 화면은 자동 갱신하지 않으므로 이 값이 판정의 나이다.
  return { mode, steps, blockedAt: off ? null : (blocked ? blocked.key : null), since: mode === 'edge' ? posNum(pulls?.since) : null, checkedAt: posNum(now) };
}
