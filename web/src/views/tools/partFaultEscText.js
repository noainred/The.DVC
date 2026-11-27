/**
 * 부품 장애 알림 단계 올리기 · 당직 화면 글자(v3.51 · 시안 docs/design/bm-feature-proposals ⑪). 순수 — 판정 · 검증은 서버(partfault/escalation.js)가 한다.
 *  · 행 표지: 받는 곳에 간 가장 높은 단계(‘보냄’) · 가지 않은 단계(‘안 감’ — 다시 시도 중 · 그만둠) · 확인함(누가 · 언제).
 *    여기 단계는 2단계부터다. 1단계(지금 부품 장애 알림)가 실제로 나갔는지는 이 표지가 말하지 않는다(반증 B6).
 *  · 편집 모델: 서버 설정 ↔ 화면 칸(메일 주소는 쉼표 · 줄바꿈으로 나눈 글자). 문구에 백틱을 쓰지 않는다. 주기 숫자는 API 값(tickMs).
 */
export const ESC_NOTE = '부품 장애 알림(1단계)은 지금처럼 장애가 열릴 때 보냅니다. 아무도 확인하지 않으면 정한 분이 지난 뒤 아래 단계로 더 보냅니다. 부품 장애 목록의 ‘확인’ 을 누르면 그 장애의 단계 올리기가 멈춥니다. 시간은 그 장애를 정책 대상으로 처음 본 때부터 셉니다 — 켜거나 정책을 고친 직후 오래된 장애에 한꺼번에 보내지 않습니다.';
export const ESC_ONCALL_NOTE = '당직은 수집 주체(이 포탈 · 법인 엣지)마다 요일별로 적습니다 — 그 주체 표에 그 요일 당직이 없으면 ‘모두’ 표의 그 요일을 씁니다. 요일은 포탈의 지역 시계(포탈 날짜 기준 — 기본 한국 시각)로 정합니다. 서버 시간대 설정 · 법인 현지 시각이 아닙니다.';
export const ESC_STATE_LABEL = Object.freeze({ fault: '이상', warn: '주의' });   // 부품 장애 화면의 상태 이름과 같게(partfault/types.js PART_STATE_LABEL — 시험이 대조)
export const DAY_LABEL = Object.freeze({ mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' });
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const int = (v) => (Number.isInteger(v) ? v : null);

const WHY = Object.freeze({ off: '꺼짐', 'partfault-off': '부품 장애 점검이 꺼져 있어 보내지 않음', demo: '데모 점검이라 보내지 않음', 'state-unreadable': '진행 기록을 읽지 못해 보내지 않음', 'settings-unreadable': '단계 · 당직 설정을 읽지 못해 보내지 않음' });
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
  // 단계 · 당직 설정을 못 읽음 — 정책 · 대상 여부를 모른다(‘꺼짐 · 정책 밖’ 으로 말하지 않는다). 확인은 된다(진행 기록은 읽힌다 — 디버깅 8회차 판정 #2)
  if (esc.paused === 'settings-unreadable') {
    // 정책을 모르므로 단계 수는 말하지 않고, 풀린 뒤는 멈춤 표지와 같은 두 경우로 말한다(디버깅 9회차 화면 U2)
    return { text: '설정 못 읽음', tone: 'gray', canAck: canAck && !!esc.ackId,
      title: '단계 · 당직 설정을 읽지 못해 단계 알림을 보내지 않습니다(어느 정책 대상인지도 모릅니다) — 설정이 돌아오면 돌아온 설정대로 합니다: 꺼져 있으면 보내지 않고, 켜져 있으면 그 정책으로 이미 세던 장애는 그동안 시각이 지난 단계 가운데 가장 높은 단계를 바로 보내며, 다시 켠 것이거나 새 정책이면 그때부터 1단계부터 셉니다. 확인하면 보내지 않습니다.' };   // 꺼짐 경우(10회차 화면 D1)
  }
  const live = enabled && esc.covered === true;
  // 회차가 보내지 않는 상태 · 정비 창 보류 — ‘보냅니다’ 라고 약속하지 않는다(디버깅 1회차 화면 U7)
  if (live && esc.paused === 'state-unreadable') {
    // 진행 기록을 못 읽으면 확인 여부 · 보낸 단계를 모른다 — 확인 단추도 두지 않는다(저장할 수 없다 — 디버깅 3회차 화면 R1)
    return { text: '기록 못 읽음', tone: 'gray', canAck: false, title: '진행 기록을 읽지 못해 확인 여부 · 보낸 단계를 모릅니다 — 단계 알림을 보내지 않습니다(파일을 고치면 곧 다시 읽습니다).' };
  }
  if (live && (esc.paused || esc.held)) {
    // 풀리면 ‘다시 세는’ 것이 아니라 그동안 시각이 지난 단계 가운데 가장 높은 것을 그 회차에 바로 보낸다(건너뛴 단계는 결과에 밝힘 — 디버깅 2회차 판정 #4)
    const LATER = '그동안 시각이 지난 단계 가운데 가장 높은 단계를 바로 보냅니다(건너뛴 단계는 그 알림 본문에 밝힙니다)';   // ‘결과’ 는 관리자 패널의 마지막 회차 줄뿐이라 다음 회차에 비었다(9회차 화면 U4)
    // 멈춘 회차(점검 꺼짐 · 데모 · 설정 못 읽음)는 다시 켜기 · 새 정책의 시작 시각을 적지 않는다 — 풀린 첫 회차가 그것을 한다. 그래서 ‘바로 보냄’ 은 이 정책으로 이미 세던 장애만이고,
    //   멈춘 동안 단계 알림을 켰거나(다시 켬 포함) 새 정책이 걸렸으면 풀린 때부터 1단계부터 센다(디버깅 7회차 화면 H1 — 문구가 늘 ‘바로 보냄’ 이라 말했다)
    const why = esc.held ? `정비 창 보류 중인 장비라 단계 알림을 보내지 않습니다 — 창이 끝나면 ${LATER}`
      : `${WHY[esc.paused] || '지금은 단계 알림을 보내지 않습니다'} — 사유가 풀리면 이 정책으로 이미 세던 장애는 ${LATER} · 멈춘 동안 단계 알림을 켰거나(다시 켬 포함) 새 정책이 걸렸으면 풀린 때부터 1단계부터 셉니다`;
    return { text: esc.held ? '정비 창 보류' : '보내지 않음', tone: 'gray', canAck: live && canAck && !!esc.ackId, title: `${why}${step ? ` · ${step}단계까지는 갔습니다` : ''}` };
  }
  const ack = live && canAck && !!esc.ackId;
  if (tried) {
    return { text: `${tried}단계 안 감`, tone: 'red', canAck: ack,
      title: `${tried}단계 알림이 받는 곳에 가지 않았습니다(메일 꺼짐 · 시간당 한도 · 채널 실패 · 오늘 당직 없음 등) — ${esc.gaveUp ? '다시 시도를 그만뒀습니다. 받는 곳 설정을 확인하세요.' : '다음 회차에 다시 보냅니다.'}${step ? ` ${step}단계까지는 갔습니다.` : ''}` };
  }
  if (step) return { text: `${step}단계 보냄`, tone: 'amber', canAck: ack, title: live ? '아무도 확인하지 않으면 정책대로 다음 단계로 보냅니다' : '지금은 단계 올리기 대상이 아닙니다(꺼짐 · 정책 밖) — 이미 보낸 단계만 보입니다' };
  if (!live) return null;
  return { text: '2단계 대기', tone: 'gray', canAck: ack, title: '아무도 확인하지 않으면 정책의 2단계 시각에 보냅니다' };
}

/** 정책 수집 주체 칸에서 ‘이 포탈(중앙 수집)’ 을 나타내는 글자(서버 값 ''). */
export const LOCAL_AGENT = '이 포탈';
const splitEmails = (t) => String(t ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 100);   // 개수 상한은 서버가 거절 사유로(조용히 자르지 않는다)
/** 서버 설정 → 편집 칸. */
export function escToForm(s) {
  const st = s && typeof s === 'object' ? s : {};
  return {
    enabled: st.enabled === true,
    policies: (Array.isArray(st.policies) ? st.policies : []).map((p) => ({
      id: p.id, name: p.name || '', agentsText: (p.agents || []).map((a) => (a === '' ? LOCAL_AGENT : a)).join(', '), states: { fault: (p.states || []).includes('fault'), warn: (p.states || []).includes('warn') },
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
      // ‘이 포탈’ · 당직표 표기 ‘이 포탈(중앙 수집)’ = '' · ‘모두’ = '*'(그대로 적으면 어느 장애에도 맞지 않는 정책이 조용히 저장됐다 — 디버깅 2회차 판정 #11)
      agents: String(p.agentsText ?? '').split(/[,;\n]+/).map((a) => a.trim()).filter(Boolean).map((a) => (a === LOCAL_AGENT || a === agentLabel('') ? '' : a === agentLabel('*') ? '*' : a.toLowerCase())),
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
/** 마지막 회차 상태 한 줄. tickMs = API 의 회차 주기(없으면 숫자를 말하지 않는다). */
export function escRunText(run, tickMs = null) {
  if (!run || typeof run !== 'object') {
    const sec = Number.isFinite(tickMs) && tickMs > 0 ? Math.round(tickMs / 1000) : null;
    // 첫 회차는 부품 장애 점검이 시작된 뒤 한 주기 — ‘켜진 뒤 N초 안’ 이 아니다(실측 105초 — 디버깅 2회차 화면 D3)
    return `아직 돌지 않았습니다${sec ? `(부품 장애 점검이 시작되고 ${sec}초 뒤 처음 돕니다 — 포탈을 켠 뒤 몇 분이 걸릴 수 있습니다)` : ''}.`;
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
/**
 * 닫힘을 확인할 수 없어 남긴 진행 기록(v3.54 반증 14c M2) — 0 이면 빈 문자열. 그 장비가 다시 보이지 않으면 영영 남고, 같은 부품의 다음 장애가 옛 확인 · 단계를 이어받는다.
 */
const ORPHAN_WHY = { unassigned: '엣지 · 포탈 보고에서 장비가 빠짐(재배정 · 등록 삭제 등)', edgeStale: '엣지 보고가 오래됨', noReport: '엣지 보고가 1시간 넘게 없음', unjudgeable: '판정할 재료가 없는 옛 기록' };
export function escOrphanText(run) {
  const n = int(run?.orphans) ?? 0;
  if (!n) return '';
  // 사유를 단정하지 않고 판정이 본 대로 나눠 말한다(반증 15c P2 — 일시적 보류는 서버가 세지 않는다)
  const r = run?.orphanReasons && typeof run.orphanReasons === 'object' ? run.orphanReasons : {};
  const why = Object.keys(ORPHAN_WHY).filter((k) => int(r[k])).map((k) => `${ORPHAN_WHY[k]} ${int(r[k])}건`).join(' · ');
  return `닫힘을 확인할 수 없는 진행 기록 ${n}건${why ? ` — ${why}` : ''}. 남아 있으면 같은 부품의 다음 장애가 옛 확인과 단계를 이어받습니다(장비 읽기 실패 · 정비 창 같은 일시적 보류는 세지 않습니다).`;
}
/** 마지막 회차의 보낸 결과 줄(최대 20) — 어디에 갔고 어디에 가지 않았는지(반증 B1). */
export function escRunResults(run) {
  return (Array.isArray(run?.results) ? run.results : []).slice(0, 20).map((r, i) => ({
    key: `${i}`, text: `${String(r?.part || '—')} · ${int(r?.step) ? `${r.step}단계` : '—'}${Array.isArray(r?.skipped) && r.skipped.length ? `(${r.skipped.map((k) => int(k)).filter(Boolean).join(' · ')}단계 건너뜀)` : ''}${Array.isArray(r?.undelivered) && r.undelivered.length ? `(${r.undelivered.map((k) => int(k)).filter(Boolean).join(' · ')}단계 안 감)` : ''} · ${String(r?.result || '—')}`, ok: r?.delivered === true,   // 건너뛴 단계(8회차 화면 U2)
    notSent: r?.notSent === true,   // 회차 도중 확인돼 보내지 않음 — 안 감으로 세지 않고 회색(10회차 화면 D5)
  }));
}
