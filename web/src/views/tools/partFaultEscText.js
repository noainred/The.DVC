/**
 * 부품 장애 알림 단계 올리기 · 당직 화면 글자(v3.51 · 시안 docs/design/bm-feature-proposals ⑪). 순수 — 판정 · 검증은 서버(partfault/escalation.js)가 한다.
 *  · 행 표지: 받는 곳에 간 가장 높은 단계(‘보냄’) · 가지 않은 단계(‘안 감’ — 다시 시도 중 · 그만둠) · 확인함(누가 · 언제).
 *    여기 단계는 2단계부터다. 1단계(지금 부품 장애 알림)가 실제로 나갔는지는 이 표지가 말하지 않는다(반증 B6).
 *  · 편집 모델: 서버 설정 ↔ 화면 칸(메일 주소는 쉼표 · 줄바꿈으로 나눈 글자). 문구에 백틱을 쓰지 않는다. 주기 숫자는 API 값(tickMs).
 */
export const ESC_NOTE = '부품 장애 알림(1단계)은 지금처럼 장애가 열릴 때 보냅니다. 아무도 확인하지 않으면 정한 분이 지난 뒤 아래 단계로 더 보냅니다. 부품 장애 목록의 ‘확인’ 을 누르면 그 장애의 단계 올리기가 멈춥니다. 시간은 그 장애를 정책 대상으로 처음 본 때부터 셉니다 — 켜거나 정책을 고친 직후 오래된 장애에 한꺼번에 보내지 않습니다.';
export const ESC_ONCALL_NOTE = '당직은 수집 주체(이 포탈 · 법인 엣지)마다 요일별로 적습니다 — 그 주체 표에 그 요일 당직이 없으면 ‘모두’ 표의 그 요일을 씁니다. 요일은 이 포탈 서버의 시각으로 정합니다(법인 현지 시각이 아닙니다).';
export const ESC_STATE_LABEL = Object.freeze({ fault: '이상', warn: '주의' });   // 부품 장애 화면의 상태 이름과 같게(partfault/types.js PART_STATE_LABEL — 시험이 대조)
export const DAY_LABEL = Object.freeze({ mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' });
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const int = (v) => (Number.isInteger(v) ? v : null);

/**
 * 행의 esc 표지 → { text, title, tone, canAck }. 표지가 없으면(구버전 응답 · 대상 아님 · 아무 단계도 없음) null.
 *  · step = 받는 곳에 간 가장 높은 단계 · tried = 그보다 높은데 가지 않은 단계(gaveUp = 다시 시도를 그만둠).
 */
export function escMarkView(esc, { canAck = false, enabled = false } = {}) {
  if (!esc || typeof esc !== 'object') return null;
  if (esc.acked) {
    const when = Number.isFinite(esc.ackedAt) ? new Date(esc.ackedAt).toLocaleString('ko-KR') : '';
    const who = esc.ackBy ? ` · ${String(esc.ackBy)}` : '';
    return { text: `확인함${who}`, title: `${when ? `${when} ` : ''}확인${who} — 단계 올리기를 멈췄습니다`, tone: 'gray', canAck: false };
  }
  const step = int(esc.step); const tried = int(esc.tried);
  const live = enabled && esc.covered === true;
  const ack = live && canAck && !!esc.ackId;
  if (tried) {
    return { text: `${tried}단계 안 감`, tone: 'red', canAck: ack,
      title: `${tried}단계 알림이 받는 곳에 가지 않았습니다(메일 꺼짐 · 시간당 한도 · 채널 실패 · 오늘 당직 없음 등) — ${esc.gaveUp ? '다시 시도를 그만뒀습니다. 받는 곳 설정을 확인하세요.' : '다음 회차에 다시 보냅니다.'}${step ? ` ${step}단계까지는 갔습니다.` : ''}` };
  }
  if (step) return { text: `${step}단계 보냄`, tone: 'amber', canAck: ack, title: live ? '아무도 확인하지 않으면 정책대로 다음 단계로 보냅니다' : '지금은 단계 올리기 대상이 아닙니다(꺼짐 · 정책 밖) — 이미 보낸 단계만 보입니다' };
  if (!live) return null;
  return { text: '2단계 대기', tone: 'gray', canAck: ack, title: '아무도 확인하지 않으면 정책의 2단계 시각에 보냅니다' };
}

const splitEmails = (t) => String(t ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 100);   // 개수 상한은 서버가 거절 사유로(조용히 자르지 않는다)
/** 서버 설정 → 편집 칸. */
export function escToForm(s) {
  const st = s && typeof s === 'object' ? s : {};
  return {
    enabled: st.enabled === true,
    policies: (Array.isArray(st.policies) ? st.policies : []).map((p) => ({
      id: p.id, name: p.name || '', agentsText: (p.agents || []).join(', '), states: { fault: (p.states || []).includes('fault'), warn: (p.states || []).includes('warn') },
      steps: (p.steps || []).map((x) => ({ afterMin: String(x.afterMin ?? ''), emailsText: (x.emails || []).join(', '), channels: !!x.channels, oncall: !!x.oncall })),
    })),
    oncall: Object.entries(st.oncall && typeof st.oncall === 'object' ? st.oncall : {}).map(([agent, v]) => ({ agent, days: DAYS.map((_, i) => ({ name: v?.days?.[i]?.name || '', email: v?.days?.[i]?.email || '' })) })),
  };
}
const ocKey = (a) => String(a ?? '').trim().toLowerCase();
/** 같은 수집 주체의 당직표가 둘 이상이면 그 이름(화면 글자) — 저장하면 앞 표가 소리 없이 사라지므로 저장 전에 막는다(반증 B2). 없으면 ''. */
export function oncallDupOf(f) {
  const seen = new Set();
  for (const o of Array.isArray(f?.oncall) ? f.oncall : []) {
    const k = ocKey(o.agent);
    if (seen.has(k)) return agentLabel(k);
    seen.add(k);
  }
  return '';
}
/** 편집 칸 → 서버로 보낼 본문(검증은 서버가 — 사유를 그대로 보인다). 같은 주체 표가 겹치면 저장 전에 oncallDupOf 로 막는다. */
export function formToEsc(f) {
  const x = f && typeof f === 'object' ? f : {};
  const oncall = {};
  for (const o of Array.isArray(x.oncall) ? x.oncall : []) {
    const k = ocKey(o.agent);
    if (Object.hasOwn(oncall, k)) continue;   // 겹치면 앞 표를 남긴다(뒤 표가 덮지 않게 — 화면은 저장 전에 막는다)
    oncall[k] = { days: DAYS.map((_, i) => ({ name: String(o.days?.[i]?.name ?? '').trim(), email: String(o.days?.[i]?.email ?? '').trim() })) };
  }
  return {
    enabled: x.enabled === true,
    policies: (Array.isArray(x.policies) ? x.policies : []).map((p) => ({
      id: p.id, name: String(p.name ?? '').trim(),
      agents: String(p.agentsText ?? '').split(/[,;\n]+/).map((a) => a.trim().toLowerCase()).filter(Boolean),
      states: ['fault', 'warn'].filter((k) => p.states?.[k]),
      steps: (Array.isArray(p.steps) ? p.steps : []).map((s) => ({ afterMin: Number(String(s.afterMin ?? '').trim()), emails: splitEmails(s.emailsText), channels: !!s.channels, oncall: !!s.oncall })),
    })),
    oncall,
  };
}
export const newPolicy = (n = 1) => ({ id: `p${Date.now().toString(36)}${n}`.slice(0, 40), name: '부품 장애 — 이상', agentsText: '', states: { fault: true, warn: false }, steps: [{ afterMin: '15', emailsText: '', channels: true, oncall: false }, { afterMin: '30', emailsText: '', channels: false, oncall: true }] });
export const newOncall = (agent = '*') => ({ agent, days: DAYS.map(() => ({ name: '', email: '' })) });
/** 새 당직표의 수집 주체 — 아직 표가 없는 첫 주체(모두 → 이 포탈 → 엣지 순). 다 쓰였으면 null(더하기 단추를 닫는다). */
export function nextOncallAgent(f, agents) {
  const used = new Set((Array.isArray(f?.oncall) ? f.oncall : []).map((o) => ocKey(o.agent)));
  for (const a of ['*', '', ...(Array.isArray(agents) ? agents : [])]) if (!used.has(ocKey(a))) return a;
  return null;
}
/** 당직표의 수집 주체 이름 글자. */
export const agentLabel = (a) => (a === '*' ? '모두' : a === '' ? '이 포탈(중앙 수집)' : a);
const WHY = Object.freeze({ off: '꺼짐', 'partfault-off': '부품 장애 점검이 꺼져 있어 보내지 않음', demo: '데모 점검이라 보내지 않음', 'state-unreadable': '진행 기록을 읽지 못해 보내지 않음' });
/** 마지막 회차 상태 한 줄. tickMs = API 의 회차 주기(없으면 숫자를 말하지 않는다). */
export function escRunText(run, tickMs = null) {
  if (!run || typeof run !== 'object') {
    const sec = Number.isFinite(tickMs) && tickMs > 0 ? Math.round(tickMs / 1000) : null;
    return `아직 돌지 않았습니다${sec ? `(이 포탈이 켜진 뒤 ${sec}초 안에 처음 돕니다)` : ''}.`;
  }
  const when = Number.isFinite(run.at) ? new Date(run.at).toLocaleString('ko-KR') : '';
  const parts = [`${when} · ${run.why ? WHY[run.why] || run.why : run.enabled ? '켜짐' : '꺼짐'}`];
  const sent = int(run.sent) ?? 0;
  if (sent || !run.why) parts.push(`시도 ${sent} · 감 ${int(run.delivered) ?? 0} · 안 감 ${int(run.failed) ?? 0}`);
  if (int(run.deferred)) parts.push(`다음 회차로 미룸 ${run.deferred}(한 회차 상한)`);
  if (int(run.held)) parts.push(`정비 창 보류 ${run.held}`);
  if (int(run.overCap)) parts.push(`기록 상한을 넘어 보내지 않음 ${run.overCap}`);
  if (Array.isArray(run.errors) && run.errors.length) parts.push(run.errors.join(' · '));
  return parts.join(' · ');
}
/** 마지막 회차의 보낸 결과 줄(최대 20) — 어디에 갔고 어디에 가지 않았는지(반증 B1). */
export function escRunResults(run) {
  return (Array.isArray(run?.results) ? run.results : []).slice(0, 20).map((r, i) => ({
    key: `${i}`, text: `${String(r?.part || '—')} · ${int(r?.step) ? `${r.step}단계` : '—'} · ${String(r?.result || '—')}`, ok: r?.delivered === true,
  }));
}
