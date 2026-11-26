/**
 * 부품 장애 알림 단계 올리기 · 당직(v3.51 · 시안 docs/design/bm-feature-proposals ⑪) — 전체 범위 관리자 설정 패널(부품 장애 화면 안).
 *  · 기본 꺼짐. 정책: 수집 주체(비우면 모두) · 대상 상태 · 단계(몇 분 뒤 · 메일 주소 · 알림 채널 · 당직). 당직표: 수집 주체마다 요일별 이름 · 메일.
 *  · 검증은 서버 — 거절 사유를 그대로 보인다(칸을 고치면 지운다). 저장 버튼은 읽기에 실패했거나 파일을 못 읽은 상태로 열지 않는다.
 *  · 같은 수집 주체의 당직표가 겹치면 저장 전에 막는다(반증 B2) · 저장 중에는 칸을 잠근다 · 저장하면 부모 목록을 다시 읽는다(onSaved — 반증 B3).
 *  · 바뀐 칸이 있는지 부모에게 알린다(onDirty — 닫기 전에 묻는다).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson } from '../../api.js';
import Select from '../../components/Select.jsx';
import { ESC_NOTE, ESC_ONCALL_NOTE, ESC_STATE_LABEL, DAY_LABEL, escToForm, formToEsc, newPolicy, newOncall, nextOncallAgent, oncallDupOf, agentLabel, escRunText, escRunResults } from './partFaultEscText.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function PartFaultEscalation({ initial = null, onSaved = null, onDirty = null }) {
  const [st, setSt] = useState({ d: initial, err: '' });
  const [form, setFormRaw] = useState(initial?.settings ? escToForm(initial.settings) : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirtyRef = useRef(false);
  const markDirty = (v) => { if (dirtyRef.current !== v) { dirtyRef.current = v; onDirty?.(v); } };
  const load = () => fetchJson('/tools/part-faults/escalation').then((d) => { setSt({ d, err: '' }); setFormRaw(escToForm(d.settings)); markDirty(false); }).catch((e) => setSt({ d: null, err: e?.message || String(e) }));
  useEffect(() => { if (!initial) load(); return () => onDirty?.(false); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const d = st.d;
  if (st.err) return <div className="card" style={{ padding: 12 }}><div className="muted">알림 단계 설정을 읽지 못했습니다 — {st.err}</div></div>;
  if (!d || !form) return <div className="card" style={{ padding: 12 }}><div className="muted">알림 단계 설정을 읽는 중…</div></div>;
  // 칸을 고치면 — 지난 거절 사유를 지우고(고친 뒤에도 남지 않게 — 반증 B14) 바뀜을 알린다
  const setForm = (f) => { setFormRaw(f); markDirty(true); if (msg && !msg.ok) setMsg(null); };
  const agents = ['*', '', ...(Array.isArray(d.agents) ? d.agents : [])];
  const setP = (i, patch) => setForm({ ...form, policies: form.policies.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setS = (i, k, patch) => setP(i, { steps: form.policies[i].steps.map((s, j) => (j === k ? { ...s, ...patch } : s)) });
  const setO = (i, patch) => setForm({ ...form, oncall: form.oncall.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const dup = oncallDupOf(form);
  const nextAgent = nextOncallAgent(form, d.agents);
  const save = async () => {
    if (dup) { setMsg({ ok: false, text: `‘${dup}’ 당직표가 둘 이상입니다 — 하나로 합친 뒤 저장하세요.` }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/part-faults/escalation', formToEsc(form));
      if (!r || r.ok === false) throw new Error(r?.reason || '저장하지 못했습니다.');
      setFormRaw(escToForm(r.settings)); setSt({ d: { ...d, settings: r.settings }, err: '' }); markDirty(false);
      setMsg({ ok: true, text: r.settings.enabled ? '저장했습니다 — 단계 올리기가 켜져 있습니다.' : '저장했습니다 — 단계 올리기는 꺼져 있습니다.' });
      onSaved?.();
    } catch (e) { setMsg({ ok: false, text: e?.message || String(e) }); } finally { setBusy(false); }
  };
  const lim = d.limits || {};
  const results = escRunResults(d.run);
  return (
    <div className="card pfe" style={{ padding: 12, minWidth: 0 }}>
      <div className="flex wrap gap" style={{ alignItems: 'center' }}>
        <b>알림 단계 올리기 · 당직</b>
        <label className="pfe-on"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 켜기</label>
        <span className="muted" style={{ fontSize: 12, minWidth: 0 }}>마지막 회차: {escRunText(d.run, d.tickMs)}</span>
      </div>
      {results.length ? (
        <details className="pfe-res">
          <summary>마지막 회차 보낸 결과 {results.length}건 · 안 감 {results.filter((x) => !x.ok).length}</summary>
          <ul>{results.map((x) => <li key={x.key} className={x.ok ? '' : 'pfe-bad'}>{x.text}</li>)}</ul>
        </details>
      ) : null}
      <div className="muted pfe-note">{ESC_NOTE}</div>
      {d.unreadable ? <div className="pfe-warn" role="alert">설정 파일을 읽지 못했습니다(서비스 점검에서 확인) — 저장이 막힙니다.</div> : null}
      {d.stateError ? <div className="pfe-warn" role="status">{d.stateError}</div> : null}
      <fieldset className="pfe-fs" disabled={busy}>
        {form.policies.map((p, i) => (
          <div key={p.id || i} className="pfe-pol">
            <div className="flex wrap gap" style={{ alignItems: 'center' }}>
              <input className="input" value={p.name} maxLength={80} onChange={(e) => setP(i, { name: e.target.value })} aria-label={`정책 ${i + 1} 이름`} style={{ flex: '1 1 160px', minWidth: 0 }} />
              {['fault', 'warn'].map((k) => <label key={k} className="pfe-chk"><input type="checkbox" checked={!!p.states[k]} onChange={(e) => setP(i, { states: { ...p.states, [k]: e.target.checked } })} /> {ESC_STATE_LABEL[k]}</label>)}
              <button type="button" className="logout-btn" onClick={() => setForm({ ...form, policies: form.policies.filter((_, j) => j !== i) })}>정책 지우기</button>
            </div>
            <input className="input pfe-wide" value={p.agentsText} placeholder="수집 주체(엣지 이름 — 쉼표로 · 비우면 모두)" onChange={(e) => setP(i, { agentsText: e.target.value })} aria-label={`정책 ${i + 1} 수집 주체`} />
            <div className="muted pfe-note">1단계 — 지금 부품 장애 알림(장애가 열릴 때)</div>
            {p.steps.map((s, k) => (
              <div key={k} className="pfe-step">
                <span className="pfe-no">{k + 2}단계</span>
                <input className="input pfe-min" inputMode="numeric" value={s.afterMin} onChange={(e) => setS(i, k, { afterMin: e.target.value })} aria-label={`${k + 2}단계 몇 분 뒤`} />
                <span className="muted">분 확인 없음</span>
                <input className="input pfe-mail" value={s.emailsText} placeholder="메일 주소(쉼표로)" onChange={(e) => setS(i, k, { emailsText: e.target.value })} aria-label={`${k + 2}단계 메일 주소`} />
                <label className="pfe-chk"><input type="checkbox" checked={s.channels} onChange={(e) => setS(i, k, { channels: e.target.checked })} /> 알림 채널</label>
                <label className="pfe-chk"><input type="checkbox" checked={s.oncall} onChange={(e) => setS(i, k, { oncall: e.target.checked })} /> 당직</label>
                <button type="button" className="logout-btn" onClick={() => setP(i, { steps: p.steps.filter((_, j) => j !== k) })}>빼기</button>
              </div>
            ))}
            {p.steps.length < (lim.steps || 4) ? <button type="button" className="logout-btn pfe-add" onClick={() => setP(i, { steps: [...p.steps, { afterMin: '', emailsText: '', channels: true, oncall: false }] })}>단계 더하기</button> : null}
          </div>
        ))}
        {form.policies.length < (lim.policies || 20) ? <button type="button" className="logout-btn pfe-add" onClick={() => setForm({ ...form, policies: [...form.policies, newPolicy(form.policies.length + 1)] })}>정책 더하기</button> : null}

        <div className="pfe-h">당직표</div>
        <div className="muted pfe-note">{ESC_ONCALL_NOTE}</div>
        {form.oncall.map((o, i) => {
          const usedElse = new Set(form.oncall.filter((_, j) => j !== i).map((x) => String(x.agent).toLowerCase()));
          return (
            <div key={i} className="pfe-oc">
              <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                <Select className="input" value={o.agent} sort={false} onChange={(e) => setO(i, { agent: e.target.value })} aria-label={`당직표 ${i + 1} 수집 주체`}>
                  {[...new Set([...agents, o.agent])].map((a) => <option key={a} value={a} disabled={a !== o.agent && usedElse.has(String(a).toLowerCase())}>{agentLabel(a)}</option>)}
                </Select>
                <button type="button" className="logout-btn" onClick={() => setForm({ ...form, oncall: form.oncall.filter((_, j) => j !== i) })}>표 지우기</button>
              </div>
              <div className="pfe-days">
                {DAYS.map((day, k) => (
                  <div key={day} className="pfe-day">
                    <span className="pfe-dl">{DAY_LABEL[day]}</span>
                    <input className="input" value={o.days[k].name} placeholder="이름" maxLength={60} onChange={(e) => setO(i, { days: o.days.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} aria-label={`${agentLabel(o.agent)} ${DAY_LABEL[day]} 당직 이름`} />
                    <input className="input" value={o.days[k].email} placeholder="메일" maxLength={254} onChange={(e) => setO(i, { days: o.days.map((x, j) => (j === k ? { ...x, email: e.target.value } : x)) })} aria-label={`${agentLabel(o.agent)} ${DAY_LABEL[day]} 당직 메일`} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {dup ? <div className="pfe-bad" role="alert">‘{dup}’ 당직표가 둘 이상입니다 — 저장하면 하나만 남으므로 저장을 막습니다.</div> : null}
        {nextAgent != null ? <button type="button" className="logout-btn pfe-add" onClick={() => setForm({ ...form, oncall: [...form.oncall, newOncall(nextAgent)] })}>당직표 더하기</button> : null}
      </fieldset>
      <div className="flex wrap gap" style={{ marginTop: 10, alignItems: 'center' }}>
        <button type="button" className="login-btn bmd-btn" disabled={busy || !!d.unreadable || !!dup} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg ? <span className={msg.ok ? 'muted' : 'pfe-bad'} role={msg.ok ? 'status' : 'alert'} style={{ minWidth: 0 }}>{msg.text}</span> : null}
      </div>
    </div>
  );
}
