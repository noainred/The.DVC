/**
 * 설정 › 베어메탈 성능 › **정비 창 · 알림 억제**(리눅스 성능 8a단계 · 설계 PROFILES §20 ⑲ · 아트보드 Maint). 기존 ‘수집 설정’ 카드 안의 절(도구 키 그대로).
 * ⚠ 판정(지금 억제 중인가 · 다음 발생 · 남은 시간 · DST · 소유자 등급 필요)은 서버(bmusage/maint/*) — 이 화면은 값을 고치고 서버가 준 결과를 그린다.
 *   미리보기도 서버(POST /maintenance/preview) — 웹이 시간대 계산을 복제하지 않는다.
 * ⚠ 권한은 서버가 다시 막는다(쓰기 operator 이상 · 조회 밖 404 → 쓰기 밖 403 · 법인/태그/긴 창은 설정 소유자 등급) — 버튼은 서버가 준 canEdit · canEnd 로만 연다.
 * ⚠ 조회는 펼칠 때 1회 + 저장 · 동작 뒤(폴링 없음) · 늦게 온 이전 응답은 세대로 버린다 · 조회 실패 상태로 저장 버튼을 열지 않는다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, hasRole } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { unitText } from '../unitText.js';
import { shortStamp } from './bmOpsText.js';
import {
  SCOPE_ORDER, SCOPE_TEXT, STATUS_TEXT, TARGET_KIND_TEXT, WEEKDAY_OPTIONS, NTH_OPTIONS, TZ_OPTIONS, DEPLOY_STATUS_TEXT,
  scheduleText, statusLine, targetText, scopesText, countsText, leakText, formToBody, emptyForm, windowToForm, approvalNote, limitsNote, maintHonest, durText,
} from './bmMaintText.js';
import './bmOps.css';
import './bmPerfOps.css';
import './bmMaint.css';

const optionsOf = (list) => list.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>);
/** 쓰기 요청 — 400 · 409 는 본문(ok:false)으로, 그 밖 실패는 던진 오류로 온다(api.js) — 둘 다 { ok, reason, status } 로. */
async function send(fn) {
  try { const r = await fn(); return r?.ok === false ? { ok: false, reason: r.reason || '처리하지 못했습니다', code: r.code, field: r.field } : { ok: true, ...r }; }
  catch (e) { return { ok: false, reason: e?.message || '처리하지 못했습니다', status: e?.status, code: e?.body?.code, field: e?.body?.field }; }
}

export function MaintForm({ form, setForm, vcenters = [], limits = {}, onPreview, preview, busy, msg, onSave, onCancel, editing = false }) {
  const f = form;
  const set = (p) => setForm((x) => ({ ...x, ...p }));
  const corpOpts = vcenters.map((v) => [v.id, v.name || v.id]);
  const tzOpts = [...new Set([...TZ_OPTIONS, f.tz].filter(Boolean))].map((z) => [z, z]);
  return (
    <div className="bmo-card" style={{ marginTop: 8 }}>
      <h5 style={{ margin: '0 0 6px' }}>{editing ? '창 고치기' : '창 등록'}</h5>
      <div className="bmm-grid">
        <label className="bmm-field">이름<input className="input" value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="bmm-field bmm-wide">사유(필수 · 감사에 남는다)<input className="input" value={f.reason} maxLength={300} onChange={(e) => set({ reason: e.target.value })} /></label>
      </div>
      <div className="bmm-row" role="radiogroup" aria-label="대상">
        <b>대상</b>
        {['server', 'tag', 'corp'].map((k) => <label key={k}><input type="radio" name="bmm-kind" checked={f.kind === k} onChange={() => set({ kind: k })} /> {TARGET_KIND_TEXT[k]}</label>)}
        <span className="bmo-note">서버 · 태그 · 법인 중 하나(섞지 않는다)</span>
      </div>
      <div className="bmm-grid">
        {f.kind === 'server' && <label className="bmm-field bmm-wide">서버 키(서비스 태그 — 쉼표로 · 한 법인 · {unitText(limits.keysMax, '대')}까지)<input className="input" value={f.keys} onChange={(e) => set({ keys: e.target.value })} placeholder="ABC1234, ABC5678" /></label>}
        {f.kind === 'server' && <label className="bmm-field">법인(서버 키가 여러 법인에 있으면 고르세요)<Select sort={false} className="select" value={f.serverCorp || ''} disabled={editing} onChange={(e) => set({ serverCorp: e.target.value })}>{optionsOf([['', '자동 — 키로 찾기'], ...corpOpts])}</Select></label>}
        {f.kind === 'tag' && <label className="bmm-field">태그(role:역할 · app:용도)<input className="input" value={f.tag} onChange={(e) => set({ tag: e.target.value })} /></label>}
        {f.kind !== 'server' && <label className="bmm-field">법인<Select sort={false} className="select" value={f.corp} onChange={(e) => set({ corp: e.target.value })}>{optionsOf([['', '고르세요'], ...corpOpts])}</Select></label>}
        <label className="bmm-field">시간대(법인)<Select sort={false} className="select" value={f.tz} onChange={(e) => set({ tz: e.target.value })}>{optionsOf(tzOpts)}</Select></label>
      </div>
      <div className="bmm-row" role="radiogroup" aria-label="일정">
        <b>일정</b>
        {[['once', '일회'], ['weekly', '매주 요일'], ['monthly', '매월 n째 요일']].map(([k, l]) => <label key={k}><input type="radio" name="bmm-sched" checked={f.sched === k} onChange={() => set({ sched: k })} /> {l}</label>)}
      </div>
      <div className="bmm-grid">
        {f.sched === 'once' && <>
          <label className="bmm-field">시작(벽시계)<input className="input" type="datetime-local" value={f.start} onChange={(e) => set({ start: e.target.value })} /></label>
          <label className="bmm-field">끝<input className="input" type="datetime-local" value={f.end} onChange={(e) => set({ end: e.target.value })} /></label>
        </>}
        {f.sched === 'weekly' && <div className="bmm-field bmm-wide"><span>요일</span><div className="bmm-days">{WEEKDAY_OPTIONS.map(([i, d]) => (
          <label key={i}><input type="checkbox" checked={(f.days || []).includes(i)} onChange={(e) => set({ days: e.target.checked ? [...new Set([...(f.days || []), i])] : (f.days || []).filter((x) => x !== i) })} /> {d}</label>))}</div></div>}
        {f.sched === 'monthly' && <>
          <label className="bmm-field">n째<Select sort={false} className="select" value={String(f.nth)} onChange={(e) => set({ nth: Number(e.target.value) })}>{optionsOf(NTH_OPTIONS.map(([k, l]) => [String(k), l]))}</Select></label>
          <label className="bmm-field">요일<Select sort={false} className="select" value={String(f.weekday)} onChange={(e) => set({ weekday: Number(e.target.value) })}>{optionsOf(WEEKDAY_OPTIONS.map(([k, l]) => [String(k), l]))}</Select></label>
        </>}
        {f.sched !== 'once' && <>
          <label className="bmm-field">시작 시각<input className="input" type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} /></label>
          <label className="bmm-field">길이(분 · 최대 {unitText(limits.recurMaxMin, '')})<input className="input" type="number" min={1} max={limits.recurMaxMin} value={f.durMin} onChange={(e) => set({ durMin: e.target.value })} /></label>
        </>}
      </div>
      <p className="bmo-note">{limitsNote(limits)}</p>
      <div className="bmm-scopes">
        <b>억제 범위 — 켠 것만 저장</b>
        {SCOPE_ORDER.map((k) => (
          <label key={k} className="bmm-scope"><input type="checkbox" checked={!!f.scopes?.[k]} onChange={(e) => set({ scopes: { ...f.scopes, [k]: e.target.checked } })} />
            <span><b>{SCOPE_TEXT[k].label}</b> — {SCOPE_TEXT[k].desc}</span></label>
        ))}
      </div>
      <p className="bmo-note"><BoldText text={approvalNote(limits)} /></p>
      <div className="bmm-row">
        <button type="button" className="btn" onClick={onPreview} disabled={busy}>미리보기(다음 5회)</button>
        <button type="button" className="btn primary" onClick={onSave} disabled={busy}>{busy ? '저장 중…' : '저장 · 엣지 배포'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>취소</button>
        {msg && <span className="bmo-note" style={{ color: toneVar(msg.ok ? 'ok' : 'bad') }}>{msg.text}</span>}
      </div>
      {preview && (preview.ok === false ? <p className="bmo-note" style={{ color: toneVar('bad') }}>미리보기 — {preview.reason}</p> : (
        <div className="bmo-note">
          <b>미리보기</b> · 시간대 {preview.tz} · 길이 {durText(preview.durationMin)}
          <ol className="bmm-preview">{(preview.next || []).map((o) => <li key={o.start}>{o.startLocal} → {o.endLocal}{o.dstShift ? ' · 서머타임으로 없는 시각 — 뒤로 밀렸습니다' : ''}</li>)}</ol>
          {!(preview.next || []).length && '앞으로 발생이 없습니다(이미 지났습니다).'}
        </div>
      ))}
    </div>
  );
}

export default function BmMaintPanel({ vcenters = [] }) {
  const [st, setSt] = useState({ loading: true, resp: null, err: null });
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [rowMsg, setRowMsg] = useState(null);
  const gen = useRef(0);
  const load = async () => {
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    try { const r = await fetchJson('/tools/bm-usage/maintenance', {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) setSt({ loading: false, resp: r, err: null }); }
    catch (e) { if (g === gen.current) setSt({ loading: false, resp: null, err: e }); }
  };
  useEffect(() => { load(); }, []);
  const resp = st.resp;
  const writer = hasRole('admin', 'operator');
  const corpName = (id) => vcenters.find((v) => v.id === id)?.name || id || '—';
  const startNew = () => { setEditId(null); setPreview(null); setMsg(null); setForm(emptyForm({ corp: vcenters[0]?.id || '', tz: resp?.defaultTz || 'Asia/Seoul' })); };
  const startEdit = (w) => { setEditId(w.id); setPreview(null); setMsg(null); setForm({ ...windowToForm(w), rev: w.rev }); };
  const doPreview = async () => {
    const b = formToBody(form);
    const r = await send(() => postJson('/tools/bm-usage/maintenance/preview', { tz: b.tz, schedule: b.schedule }, { timeoutMs: 30_000 }));
    setPreview(r);
  };
  const doSave = async () => {
    setBusy(true); setMsg(null);
    const b = formToBody(form);
    const r = editId ? await send(() => putJson(`/tools/bm-usage/maintenance/${encodeURIComponent(editId)}`, { ...b, rev: form.rev }, { timeoutMs: 60_000 }))
      : await send(() => postJson('/tools/bm-usage/maintenance', b, { timeoutMs: 60_000 }));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: `저장하지 못했습니다 — ${r.reason}` }); return; }
    setMsg({ ok: true, text: '저장했습니다(감사 기록 · 다음 엣지 인출에 배포).' }); setForm(null); setEditId(null); load();
  };
  const act = async (w, op) => {
    if (op === 'delete' && typeof window !== 'undefined' && !window.confirm(`‘${w.name}’ 창을 지웁니다 — 억제가 바로 멈춥니다.`)) return;
    const path = `/tools/bm-usage/maintenance/${encodeURIComponent(w.id)}`;
    const r = op === 'delete' ? await send(() => delJson(`${path}?rev=${w.rev}`, { timeoutMs: 60_000 }))
      : await send(() => postJson(`${path}/${op}`, { rev: w.rev }, { timeoutMs: 60_000 }));
    setRowMsg({ id: w.id, ok: r.ok, text: r.ok ? ({ end: '지금 끝냈습니다(이 발생만 — 반복 창의 다음 발생은 그대로).', confirm: '재확인했습니다(만료 시한을 다시 잡았습니다).', delete: '지웠습니다.' }[op]) : r.reason });
    load();
  };
  if (st.err) return <div style={{ marginTop: 10 }}><h4 style={{ margin: '14px 0 6px' }}>정비 창 · 알림 억제</h4><ErrorBox error={st.err} /></div>;
  if (!resp) return <p className="bmo-note" style={{ marginTop: 10 }}>정비 창을 읽는 중…</p>;
  const lk = leakText(resp.leak);
  const sum = resp.summary || {};
  return (
    <div style={{ marginTop: 10, minWidth: 0 }}>
      <h4 style={{ margin: '14px 0 4px' }}>정비 창 · 알림 억제</h4>
      <p className="bmo-note">패치 · 작업 시간대를 미리 등록해 알림 · 장애 전이 · 자동 집중 모니터링을 억제하고 추이에 음영으로 남깁니다.</p>
      <div className="bmm-row">
        <span className="bmp-chip">진행 중 {sum.active ?? '—'}</span><span className="bmp-chip">예정 {sum.scheduled ?? '—'}</span><span className="bmp-chip">끝남 {sum.ended ?? '—'}</span>
        {!!sum.expired && <span className="bmp-chip" style={{ color: toneVar('bad') }}>재확인 만료 {sum.expired}</span>}
        <span className="bmo-note" style={{ color: toneVar(lk.tone) }}>{lk.text}</span>
        {writer && !form && <button type="button" className="btn" onClick={startNew}>새 창</button>}
        <button type="button" className="btn" onClick={load} disabled={st.loading}>{st.loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      {resp.deployed && <p className="bmo-note" style={{ color: toneVar(resp.deployed.stale || resp.deployed.unreadable ? 'warn' : 'idle') }}>
        중앙 배포본 {unitText(resp.deployed.n, '개')} · 받은 시각 {resp.deployed.at ? shortStamp(resp.deployed.at) : '—'}{resp.deployed.stale ? ' · 오래돼 억제에 쓰지 않습니다' : ''}{resp.deployed.unreadable ? ' · 파일을 읽지 못함(억제에 쓰지 않습니다)' : ''}</p>}
      {form && <MaintForm form={form} setForm={setForm} vcenters={vcenters} limits={resp.limits || {}} onPreview={doPreview} preview={preview} busy={busy} msg={msg} onSave={doSave} onCancel={() => { setForm(null); setEditId(null); }} editing={!!editId} />}
      {!form && msg && <p className="bmo-note" style={{ color: toneVar(msg.ok ? 'ok' : 'bad') }}>{msg.text}</p>}
      <STable minWidth={980} className="bmo-t" style={{ fontSize: 12, marginTop: 8 }}>
        <thead><tr><th>이름 · 사유</th><th>대상</th><th>일정</th><th>억제 범위</th><th>상태</th><th>등록 · 억제 계수</th><th data-nosort>동작</th></tr></thead>
        <tbody>
          {(resp.windows || []).map((w) => (
            <tr key={w.id}>
              <td data-sort={w.name} className="bmo-wrap"><b>{w.name}</b><div className="bmo-note">{w.reason}</div>{w.origin === 'central' && <span className="bmp-chip">중앙 배포</span>}</td>
              <td data-sort={targetText(w, corpName)} className="bmo-wrap">{targetText(w, corpName)}{w.needOwner && <div className="bmo-note">소유자 등급 창</div>}</td>
              <td data-sort={w.next?.start ?? w.current?.start ?? w.last?.start ?? ''} className="bmo-wrap">{scheduleText(w)}<div className="bmo-note">{w.tz}</div></td>
              <td data-sort={scopesText(w.scopes)} className="bmo-wrap">{scopesText(w.scopes)}</td>
              <td data-sort={w.status} className="bmo-wrap" style={{ color: toneVar(STATUS_TEXT[w.status]?.tone || 'idle') }}>{statusLine(w)}{w.current && <div className="bmo-note">{w.current.startLocal} → {w.current.endLocal}</div>}</td>
              <td data-sort={w.at ?? ''} className="bmo-wrap">{w.by || '—'}{w.approvedBy ? ` · 승인 ${w.approvedBy}` : ''}<div className="bmo-note">{countsText(w.counts) || '—'}</div></td>
              <td className="bmo-wrap">
                <div className="bmm-acts">
                  {w.canEdit && <button type="button" className="btn btn-sm" onClick={() => startEdit(w)}>고치기</button>}
                  {w.canEnd && <button type="button" className="btn btn-sm" onClick={() => act(w, 'end')}>지금 끝내기</button>}
                  {w.canConfirm && w.schedule?.kind !== 'once' && <button type="button" className="btn btn-sm" onClick={() => act(w, 'confirm')}>재확인</button>}
                  {w.canDelete && <button type="button" className="btn btn-sm" onClick={() => act(w, 'delete')}>지우기</button>}
                </div>
                {rowMsg?.id === w.id && <div className="bmo-note" style={{ color: toneVar(rowMsg.ok ? 'ok' : 'bad') }}>{rowMsg.text}</div>}
              </td>
            </tr>
          ))}
          {!(resp.windows || []).length && <tr><td colSpan={7} className="bmo-note">등록된 정비 창이 없습니다.</td></tr>}
        </tbody>
      </STable>
      {resp.deploy && (resp.deploy.edges || []).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <h5 style={{ margin: '6px 0 4px' }}>엣지 배포 현황</h5>
          <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>엣지</th><th>상태</th><th>마지막 인출</th><th>엣지 배포본</th><th>창 끝 뒤 억제</th></tr></thead>
            <tbody>{resp.deploy.edges.map((e) => (
              <tr key={e.agent}>
                <td data-sort={e.agent}>{e.agent}</td>
                <td data-sort={e.status} style={{ color: toneVar(DEPLOY_STATUS_TEXT[e.status]?.tone || 'idle') }}>{DEPLOY_STATUS_TEXT[e.status]?.label || e.status}{e.status === 'old' && resp.deploy.minEdgeVersion ? ` · v${resp.deploy.minEdgeVersion} 이상 필요` : ''}</td>
                <td data-sort={e.lastPullAt ?? ''}>{e.lastPullAt ? shortStamp(e.lastPullAt) : '—'}</td>
                <td data-sort={e.envelope?.n ?? ''}>{e.envelope ? `${unitText(e.envelope.n, '개')}${e.envelope.stale ? ' · 오래됨' : ''}${e.envelope.unreadable ? ' · 읽지 못함' : ''}` : '—'}</td>
                <td data-sort={e.envelope?.leak ?? ''}>{e.envelope?.leak == null ? '—' : `${e.envelope.leak}건`}</td>
              </tr>))}</tbody>
          </STable>
        </div>
      )}
      <p className="bmo-note" style={{ marginTop: 8 }}><BoldText text={maintHonest(resp.limits || {})} /></p>
    </div>
  );
}
