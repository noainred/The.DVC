/**
 * 설정 › 베어메탈 성능 › **알림 규칙 · 집중 모니터링 · 베이스라인 · 소모품 기준**(리눅스 성능 5단계 · 아트보드 Alerts ⑨). 기존 ‘수집 설정’ 카드 안의 절(도구 키 그대로).
 * ⚠ 판정 · 발송은 서버(perfAlerts.js — 수집 노드). 이 화면은 규칙 값만 고친다 — 저장은 설정 소유자 등급(서버 403 · 감사) · 그 밖의 계정은 읽기 전용.
 * ⚠ 켠 규칙만 저장된다(서버 normalizeRules) · 웹훅 URL 은 비밀이라 싣지 않는다(채널 이름만) · 조회는 펼칠 때 1회 + 저장 · 시험 실행 뒤(폴링 없음).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson, hasRole, getCurrentUser } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { unitText } from '../unitText.js';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { shortStamp } from './bmOpsText.js';
import { RULE_TEXT, CHANNEL_TEXT, RULES_HONEST, sentResultText, issueResultText, autoFocusText, HEALTH_CELL_TEXT, FOCUS_METRIC_TEXT } from './bmPerfOpsText.js';
import './bmOps.css';
import './bmPerfOps.css';

const NUM_SECTIONS = Object.freeze([
  { k: 'daily', title: '하루 상한(법인당)', fields: [['alerts', '알림'], ['issues', '이슈'], ['autoFocus', '자동 집중'], ['manualFocus', '수동 집중']] },
  { k: 'focus', title: '집중 모니터링', fields: [['intervalS', '간격(초 · 하한 30)'], ['durationMin', '길이(분 · 상한 60)'], ['corpMax', '법인당 동시'], ['nodeMax', '이 노드 전체 동시'], ['keepDays', '보관(일)'], ['autoSuppressMin', '같은 서버 재발 억제(분)']] },
  { k: 'baseline', title: '베이스라인', fields: [['weeks', '지난 주 수'], ['bandPct', '띠 ±%'], ['minWeeks', '최소 표본 주'], ['maxMissingPct', '결측 상한 %']] },
  { k: 'health', title: '점검 소모품 기준', fields: [['chronyMs', '시각 오프셋 ms'], ['fdPct', 'FD %'], ['conntrackPct', 'conntrack %'], ['dmesgErr24h', '24시간 커널 오류'], ['certDays', '인증서 남은 일']] },
  { k: 'changes', title: '변경 이벤트', fields: [['keepDays', '보관(일)']] },
  { k: 'compare', title: '구간 · 서버 비교', fields: [['diffPct', '구간 비교 차이 표시 ±%'], ['maxServers', '서버 비교 한 화면 상한(대)']] },
  // 6단계 수집 건강 — 보드 상태와 ‘수집 건강’ 알림 행이 같은 기준을 쓴다(DB 상한 0 = 없음 · DB 칸 판정 보류).
  { k: 'collect', title: '수집 건강 기준', fields: [['cyclePct', '주기 소요 % (예산 대비 이상)'], ['successPct', '성공률 % (미만)'], ['dbPct', 'DB % (상한 대비 이상)'], ['dbCapGb', 'DB 상한 GB(0 = 없음)']] },
  // 7a단계 로그 분석 — 출처별 주기당 줄 상한(넘친 줄은 ‘잘림’) · 보관 · SSH 실패 집중(같은 IP · 창 안 줄 수). 끄면 로그 읽기 exec 를 붙이지 않는다.
  { k: 'logs', title: '로그 분석', fields: [['lineCap', '출처별 주기당 줄 상한'], ['keepDays', '보관(일)'], ['burstCount', 'SSH 실패 집중 — 줄 수'], ['burstWindowMin', 'SSH 실패 집중 — 창(분)']] },
  // 8a단계 용량 소진 예측 — 목표선(%) · 데이터 부족 기준(14일 창 안 점 수) · 알림 ‘소진 ≤ N일’ 의 N.
  { k: 'capacity', title: '용량 소진 예측', fields: [['targetPct', '목표선 %'], ['minDays', '데이터 부족 기준(14일 중 점 수)'], ['days', '알림 — 소진 ≤ N일']] },
]);

/** 이 계정이 저장할 수 있나 — 설정 소유자 등급(소유자 ∧ 전체 범위) · 인증 꺼짐(Anonymous admin). 서버가 다시 막는다. */
export function canEditRules(resp, u = getCurrentUser()) {
  if (!resp || resp.readOnly) return false;
  if (!hasRole('admin')) return false;
  return u?.settingsOwnerTier === true || u?.name === 'Anonymous';
}

export default function BmPerfRulesPanel({ vcenters = [] }) {
  const [st, setSt] = useState({ loading: true, resp: null, err: null });
  const [form, setForm] = useState(null);
  const [save, setSave] = useState({ busy: false, msg: '', err: null, field: '' });
  const [dry, setDry] = useState({ busy: false, resp: null, err: null });
  const gen = useRef(0);
  const load = async () => {
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    try { const r = await fetchJson('/tools/bm-usage/perf-rules', {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) { setSt({ loading: false, resp: r, err: null }); setForm(JSON.parse(JSON.stringify(r.rules))); } }
    catch (e) { if (g === gen.current) setSt({ loading: false, resp: null, err: e }); }
  };
  useEffect(() => { load(); }, []);
  const resp = st.resp;
  const edit = canEditRules(resp);
  const ro = !edit;
  const ruleOf = (id) => form?.rules?.[id] || null;
  const setRule = (id, patch) => setForm((f) => {
    const cur = f.rules?.[id] || { ...(resp?.ruleDefaults?.[id] || {}), on: false, corpsOff: [] };
    return { ...f, rules: { ...f.rules, [id]: { ...cur, ...patch } } };
  });
  const setNum = (sec, k, v) => setForm((f) => ({ ...f, [sec]: { ...f[sec], [k]: v === '' ? '' : Number(v) } }));
  const doSave = async () => {
    setSave({ busy: true, msg: '', err: null, field: '' });
    try {
      const body = { ...form, rules: Object.fromEntries(Object.entries(form.rules || {}).filter(([, x]) => x?.on)) };
      const r = await putJson('/tools/bm-usage/perf-rules', body, { timeoutMs: 60_000 });
      if (r?.ok === false) { setSave({ busy: false, msg: `저장하지 못했습니다 — ${r.reason || '형식 밖 값'}`, err: null, field: r.field || '' }); return; }
      if (r?.rules) setForm(JSON.parse(JSON.stringify(r.rules)));   // 서버가 정규화한 값(켠 규칙만)으로 바로 맞춘다
      setSave({ busy: false, msg: '저장했습니다(감사 기록 · 켠 규칙만 저장).', err: null, field: '' });
      load();
    } catch (e) { setSave({ busy: false, msg: '', err: e, field: e?.body?.field || '' }); }
  };
  const doDry = async () => {
    setDry({ busy: true, resp: null, err: null });
    try { setDry({ busy: false, resp: await postJson('/tools/bm-usage/perf-rules/dry-run', { ...form, rules: Object.fromEntries(Object.entries(form.rules || {}).filter(([, x]) => x?.on)) }, { timeoutMs: 60_000 }), err: null }); }
    catch (e) { setDry({ busy: false, resp: null, err: e }); }
  };
  if (st.err) return <div style={{ marginTop: 10 }}><h4 style={{ margin: '14px 0 6px' }}>리눅스 성능 알림 규칙</h4><ErrorBox error={st.err} /></div>;
  if (!resp || !form) return <p className="bmo-note" style={{ marginTop: 10 }}>리눅스 성능 알림 규칙을 읽는 중…</p>;
  const vcName = (id) => vcenters.find((v) => v.id === id)?.name || id;
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0, marginTop: 14 }}>
      <h4 style={{ margin: 0 }}>리눅스 성능 알림 규칙 · 집중 모니터링 · 베이스라인</h4>
      <p className="bmo-note"><BoldText text={'규칙 조건은 수집 노드가 판정한 값의 **변화**에만 걸립니다 — 같은 상태가 이어지면 다시 보내지 않고, 지속 · 재발 억제 · 하루 상한이 있습니다. 채널은 설정 › 알림(메일 · 웹훅 · Slack · Teams)을 그대로 씁니다. **켠 규칙만 저장합니다.**'} /></p>
      {resp.loadError && <p className="bmo-note" style={{ color: toneVar('warn') }}>설정 파일을 읽지 못해 기본값(전부 꺼짐)으로 동작 중입니다 — {resp.loadError.reason}. 저장하면 새 파일로 바뀝니다(손상본은 보존).</p>}
      {ro && <p className="bmo-note">읽기 전용 — 저장은 설정 소유자(전체 범위 관리자)만 할 수 있습니다{resp.readOnly && hasRole('admin') ? '(범위가 지정된 계정은 자기 법인 예외만 봅니다)' : ''}.</p>}
      <STable minWidth={1040} className="bmo-t bmr-t" style={{ fontSize: 12 }}>
        <thead><tr><th>켬</th><th>규칙</th><th>조건</th><th className="right">지속(주기)</th><th className="right">재발 억제(분)</th><th>채널</th><th>이슈 자동 등록</th><th>자동 집중</th><th>법인 예외</th></tr></thead>
        <tbody>
          {(resp.ruleIds || []).map((id) => {
            const r = ruleOf(id); const on = !!r?.on; const d = resp.ruleDefaults?.[id] || {};
            const v = r || { ...d, on: false, corpsOff: [] };
            return (
              <tr key={id}>
                <td data-sort={on ? 1 : 0}><input type="checkbox" checked={on} disabled={ro} onChange={(e) => setRule(id, { on: e.target.checked })} aria-label={`${RULE_TEXT[id]?.label} 켬`} /></td>
                <td data-sort={RULE_TEXT[id]?.label || id} className="bmo-name">{RULE_TEXT[id]?.label || id}</td>
                <td data-sort={v.cond}>
                  <Select sort={false} className="select select-sm" value={v.cond} disabled={ro || !on} onChange={(e) => setRule(id, { cond: e.target.value })} aria-label="조건" title={RULE_TEXT[id]?.conds?.[v.cond] || v.cond}>
                    {(resp.conds?.[id] || []).map((c) => <option key={c} value={c}>{RULE_TEXT[id]?.conds?.[c] || c}</option>)}
                  </Select>
                </td>
                <td className="right" data-sort={v.sustain}><input className="input" type="number" min={1} max={48} value={v.sustain ?? ''} disabled={ro || !on} onChange={(e) => setRule(id, { sustain: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                <td className="right" data-sort={v.repeatMin}><input className="input" type="number" min={0} max={10080} value={v.repeatMin ?? ''} disabled={ro || !on} onChange={(e) => setRule(id, { repeatMin: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                <td data-sort={(v.channels || []).join(',')}><div className="bmr-ch">{(resp.channels || []).map((c) => (
                  <label key={c} className="bmo-check"><input type="checkbox" disabled={ro || !on} checked={(v.channels || []).includes(c)} onChange={(e) => setRule(id, { channels: e.target.checked ? [...new Set([...(v.channels || []), c])] : (v.channels || []).filter((x) => x !== c) })} />{CHANNEL_TEXT[c] || c}</label>
                ))}</div></td>
                <td data-sort={v.issue ? 1 : 0}><label className="bmo-check"><input type="checkbox" disabled={ro || !on} checked={!!v.issue} onChange={(e) => setRule(id, { issue: e.target.checked })} />만들기</label></td>
                <td data-sort={v.autoFocus ? 1 : 0}>{id === 'focusEnd' || id === 'collect' ? <span className="bmo-sub">해당 없음</span> : <label className="bmo-check"><input type="checkbox" disabled={ro || !on} checked={!!v.autoFocus} onChange={(e) => setRule(id, { autoFocus: e.target.checked })} />켜기</label>}</td>
                <td data-sort={(v.corpsOff || []).length}>
                  <details><summary className="bmo-sub">{(v.corpsOff || []).length ? `${(v.corpsOff || []).length}곳 제외` : '없음'}</summary>
                    <div className="bmr-corps">{vcenters.map((vc) => (
                      <label key={vc.id}><input type="checkbox" disabled={ro || !on} checked={(v.corpsOff || []).includes(vc.id)} onChange={(e) => setRule(id, { corpsOff: e.target.checked ? [...new Set([...(v.corpsOff || []), vc.id])] : (v.corpsOff || []).filter((x) => x !== vc.id) })} />{vc.name}</label>
                    ))}</div>
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </STable>
      <div className="bmr-grid">
        {NUM_SECTIONS.map((sec) => (
          <fieldset key={sec.k} className="bmo-card" style={{ margin: 0 }}>
            <legend className="bmo-k">{sec.title}</legend>
            <div style={{ display: 'grid', gap: 6 }}>
              {sec.fields.map(([k, label]) => {
                const lim = resp.limits?.[sec.k]?.[k];
                return (
                  <label key={k} style={{ fontSize: 12 }}>{label}{save.field === `${sec.k}.${k}` ? <span style={{ color: toneVar('bad') }}> — 범위 밖</span> : null}
                    <input className="input" type="number" min={lim?.[0]} max={lim?.[1]} value={form[sec.k]?.[k] ?? ''} disabled={ro} onChange={(e) => setNum(sec.k, k, e.target.value)} />
                  </label>
                );
              })}
              {sec.k === 'logs' && (
                <label className="bmo-check" style={{ fontSize: 12 }}><input type="checkbox" disabled={ro} checked={form.logs?.on !== false} onChange={(e) => setForm((f) => ({ ...f, logs: { ...f.logs, on: e.target.checked } }))} />로그 읽기 켬(같은 SSH 세션 · 읽기 전용)</label>
              )}
              {sec.k === 'focus' && (
                <details><summary className="bmo-sub">자동 집중을 쓰는 법인(옵트인) — {(form.focus?.autoCorps || []).length}곳</summary>
                  <div className="bmr-corps">{vcenters.map((vc) => (
                    <label key={vc.id}><input type="checkbox" disabled={ro} checked={(form.focus?.autoCorps || []).includes(vc.id)} onChange={(e) => setForm((f) => ({ ...f, focus: { ...f.focus, autoCorps: e.target.checked ? [...new Set([...(f.focus?.autoCorps || []), vc.id])] : (f.focus?.autoCorps || []).filter((x) => x !== vc.id) } }))} />{vc.name}</label>
                  ))}</div>
                </details>
              )}
              {sec.k === 'baseline' && <span className="bmo-sub">감시 지표: {(resp.baselineMetrics || []).map((m) => FOCUS_METRIC_TEXT[m]?.label || m).join(' · ')}</span>}
              {sec.k === 'health' && <span className="bmo-sub">칸: {Object.values(HEALTH_CELL_TEXT).map((x) => x.label).slice(0, 4).join(' · ')} 등 8칸</span>}
            </div>
          </fieldset>
        ))}
        <fieldset className="bmo-card" style={{ margin: 0 }}>
          <legend className="bmo-k">유지보수 창 억제</legend>
          <label className="bmo-check"><input type="checkbox" disabled={ro} checked={!!form.maintenance?.backupWindows} onChange={(e) => setForm((f) => ({ ...f, maintenance: { ...f.maintenance, backupWindows: e.target.checked } }))} />백업 창(Bareos · Veeam 스케줄)에서 알리지 않기</label>
          <p className="bmo-note" style={{ color: toneVar('warn') }}>지금은 원천이 없습니다 — 베어메탈 서버의 백업 창을 읽는 스케줄이 없어(그 스케줄은 VM 대상) 억제가 일어나지 않습니다.</p>
        </fieldset>
      </div>
      <div className="bmo-tagrow">
        {edit && <button type="button" className="btn bmp-touch" disabled={save.busy} onClick={doSave}>{save.busy ? '저장하는 중…' : '저장'}</button>}
        {hasRole('admin') && resp && !resp.readOnly && <button type="button" className="btn bmp-touch" disabled={dry.busy} onClick={doDry}>{dry.busy ? '대 보는 중…' : '시험 실행(지금 값에 대 보기 — 보내지 않음)'}</button>}
        <button type="button" className="btn bmp-touch" onClick={load} disabled={st.loading}>{st.loading ? '읽는 중…' : '다시 읽기'}</button>
        {save.msg && <span className="bmo-sub" style={{ color: toneVar('ok') }}>{save.msg}</span>}
      </div>
      {save.err && <ErrorBox error={save.err} />}
      {dry.err && <ErrorBox error={dry.err} />}
      {dry.resp && (
        <div className="bmo-band">
          <div>시험 실행 — 이 노드 대상 {unitText(dry.resp.servers, '대')} · 걸린 규칙 {(dry.resp.fires || []).length}건{dry.resp.skipped ? `(${dry.resp.skipped === 'no-rules' ? '켠 규칙이 없습니다' : dry.resp.skipped})` : ''}</div>
          {(dry.resp.fires || []).slice(0, 20).map((f, i) => <div key={i} className="bmo-sub">{RULE_TEXT[f.rule]?.label || f.rule} · {f.title}</div>)}
          <div className="bmo-sub">{dry.resp.note}</div>
        </div>
      )}
      <section className="bmo-card">
        <h5 className="bmo-h">알림 이력 — 이 노드 + 엣지 봉투(최근) <span className="bmo-sub">추적 중 {unitText(resp.status?.tracked, '건')} · 집중 진행 {resp.status?.focusActive ?? '—'} · 대기 {resp.status?.focusQueued ?? '—'} · 슬롯 {resp.status?.slots?.used ?? '—'}/{resp.status?.slots?.capacity ?? '—'}</span></h5>
        {!(resp.sent || []).length ? <p className="bmo-note">보낸 기록이 없습니다.</p> : (
          <STable minWidth={860} limit={100} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>시각</th><th>규칙</th><th>서버</th><th>법인</th><th>제목</th><th>결과</th><th>이슈</th><th>자동 집중</th></tr></thead>
            <tbody>
              {resp.sent.map((x) => (
                <tr key={`${x.agent}|${x.id}`}>
                  <td data-sort={x.at}>{shortStamp(x.at)}</td>
                  <td data-sort={x.rule}>{RULE_TEXT[x.rule]?.label || x.rule}</td>
                  <td data-sort={x.name}>{x.name}{x.via === 'edge' ? <span className="bmo-sub"> · 엣지 {x.agent}</span> : null}</td>
                  <td data-sort={x.vcenterId}>{vcName(x.vcenterId) || '—'}</td>
                  <td data-sort={x.title} className="bmo-wrap">{x.title}</td>
                  <td data-sort={x.result}>{sentResultText(x.result)}{(x.channels || []).length ? <span className="bmo-sub"> · {(x.channels || []).map((c) => CHANNEL_TEXT[c] || c).join(' · ')}</span> : null}</td>
                  <td data-sort={x.issue || ''}>{issueResultText(x.issue)}</td>
                  <td data-sort={x.autoFocus || ''}>{autoFocusText(x.autoFocus)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </section>
      <p className="bmo-note bmo-card bmo-honest">{RULES_HONEST}</p>
    </div>
  );
}
