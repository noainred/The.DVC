/**
 * 리눅스 성능 6단계 — 서버 상세 **‘진단 플레이북’ · ‘목표선’ 탭**(설계 PROFILES §16 E · D · 아트보드 Runbook).
 * ⚠ 조립만 — 판정 id · 플레이북 고르기 · 목표 대조는 서버. 조회는 탭을 고를 때 1회 + ‘다시 읽기’(폴링 없음).
 * ⚠ 명령은 복사 버튼이 있는 글자다 — 포탈은 실행하지 않는다. 목표 저장은 설정 소유자 등급(서버 PUT 이 다시 막는다) · 저장 결과는 r?.ok === false 로 검사.
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, hasRole, getCurrentUser } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import Select from '../../components/Select.jsx';
import { toneVar } from './toneVar.js';
import { valText } from './bmTrendText.js';
import {
  STEP_KIND_TEXT, LOOK_TEXT, RUNBOOK_HONEST, judgmentText, fillLine, wikiSearchHref,
  SLO_METRIC_TEXT, SLO_BASIS_TEXT, SLO_OP_TEXT, SLO_STATUS_TEXT, sloSourceText, goalText, hoursText, longestText, dailySpark, resNote, SLO_HONEST,
  sloMaintText,
} from './bmRunbookText.js';
import './bmStage6.css';

function useOnce(path, tick = 0) {
  const [st, setSt] = useState({ data: null, err: null, loading: !!path });
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    setSt((p) => ({ ...p, loading: true, err: null }));
    fetchJson(path, {}, undefined, { timeoutMs: 60_000 }).then((d) => { if (alive) setSt({ data: d, err: null, loading: false }); }).catch((e) => { if (alive) setSt({ data: null, err: e, loading: false }); });
    return () => { alive = false; };
  }, [path, tick]);
  return st;
}
function CopyPre({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="bmrb-cmd">
      <pre>{text}</pre>
      <button type="button" className="btn btn-sm bmp-touch" onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { setOk(false); } }}>{ok ? '복사됨' : '복사'}</button>
    </div>
  );
}

export function PlaybookView({ pb, catalog, sel, onSel }) {
  const list = catalog?.playbooks || [];
  const auto = (pb?.matched || []).map((m) => m.id);
  const cur = list.find((p) => p.id === sel) || list.find((p) => p.id === auto[0]) || null;
  const fill = pb?.fill || {};
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div className="bmcmp-ctl" style={{ marginTop: 0 }}>
        <span className="bmo-k">지금 판정</span>
        {(pb?.ids || []).length ? pb.ids.map((id) => <span key={id} className="bmp-chip">{judgmentText(id)}</span>) : <span className="bmo-note" style={{ margin: 0 }}>{pb?.noEntry ? '표본이 없어 판정이 없습니다' : '후보 판정이 없습니다 — 아래에서 플레이북을 직접 고를 수 있습니다'}</span>}
      </div>
      <div className="bmcmp-ctl" style={{ marginTop: 0 }}>
        <span className="bmo-k">플레이북</span>
        <Select sort={false} className="select" value={cur?.id || ''} onChange={(e) => onSel(e.target.value)} aria-label="플레이북">
          {!cur && <option value="">고르세요</option>}
          {list.map((p) => <option key={p.id} value={p.id}>{auto.includes(p.id) ? '● ' : ''}{p.title}</option>)}
        </Select>
        {cur && <a className="btn btn-sm bmp-touch" href={wikiSearchHref(cur.wikiTitle)}>위키 덮어쓰기 찾기</a>}
      </div>
      {cur && cur.steps.map((s, i) => (
        <section key={i} className="bmo-card bmrb-step">
          <div className="bmo-h"><span><b>{i + 1}</b> {STEP_KIND_TEXT[s.kind] || s.kind}{s.title && s.title !== STEP_KIND_TEXT[s.kind] ? ` — ${s.title}` : ''}</span>{!!s.sources?.length && <span className="bmo-sub">근거 {s.sources.join(' · ')}</span>}</div>
          {s.kind === 'portal' && (
            <div className="bmo-reads">
              {!!(s.metrics || []).length && <div>지금 값(수집 노드 판정 그대로): {(s.metrics || []).map((m) => `${SLO_METRIC_TEXT[m]?.label || m} ${valText(pb?.portal?.values?.[m], SLO_METRIC_TEXT[m]?.unit || '')}`).join(' · ')}</div>}
              {pb?.portal?.focus && <div>마지막 집중 모니터링: {pb.portal.focus.status} · 판정 {pb.portal.focus.verdictFrom || '—'} → {pb.portal.focus.verdictTo || '—'}{pb.portal.focus.candidate ? ` · 원인 후보(상관) ${pb.portal.focus.candidate}` : ''}</div>}
              <div>볼 곳: {(s.look || []).map((x) => LOOK_TEXT[x] || x).join(' · ')}</div>
            </div>
          )}
          {(s.commands || []).map((c, j) => <CopyPre key={j} text={fillLine(c, fill)} />)}
          {!!(s.tuning || []).length && <div className="bmo-sub">튜닝 탭 대조: {s.tuning.map((x) => `‘${x}’`).join(' · ')}</div>}
          {s.note && <p className="bmo-note">{s.note}</p>}
          {!!(s.items || []).length && <ul className="bmrb-items">{s.items.map((x, j) => <li key={j}>{x}</li>)}</ul>}
        </section>
      ))}
      <p className="bmo-note"><BoldText text={RUNBOOK_HONEST} /></p>
    </div>
  );
}

export function BmPlaybookTab({ itemKey }) {
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState('');
  const cat = useOnce('/tools/bm-usage/playbooks');
  const pb = useOnce(itemKey ? `/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/playbook` : '', tick);
  const err = cat.err || pb.err;
  return (
    <div className="bmt-card" style={{ minWidth: 0 }}>
      <div className="bmt-panel-head"><h5>진단 플레이북 — 읽기 전용 런북(지금 판정에 맞는 것이 먼저)</h5><span style={{ flex: '1 1 auto' }} /><button type="button" className="btn btn-sm bmp-touch" onClick={() => setTick((v) => v + 1)} disabled={pb.loading}>{pb.loading ? '읽는 중…' : '다시 읽기'}</button></div>
      {err && (err.status === 403 || err.status === 404 ? <ErrorBox error={err} /> : <p className="bmo-note" style={{ color: toneVar('bad') }}>읽지 못했습니다: {err.message || String(err)}</p>)}
      {cat.data && <PlaybookView pb={pb.data} catalog={cat.data} sel={sel} onSel={setSel} />}
    </div>
  );
}

/* ── 목표선 ─────────────────────────────────────────────────────────── */
export function SloTable({ resp }) {
  const items = resp?.items || [];
  if (!items.length) return <p className="bmo-note">이 서버에 걸린 목표가 없습니다.</p>;
  return (
    <STable minWidth={980} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>목표</th><th>출처</th><th className="right">달성률</th><th className="right">위반 시간</th><th>최장 위반</th><th>추이(일)</th><th className="right">결측 · 정비 창</th><th>상태</th></tr></thead>
      <tbody>
        {items.map((it) => {
          const st = it.error ? { label: '읽지 못함', tone: 'warn' } : (SLO_STATUS_TEXT[it.status] || { label: it.status, tone: 'idle' });
          return (
            <tr key={it.goal.id}>
              <td data-sort={it.goal.metric} className="bmo-wrap">{goalText(it.goal)}{it.goal.basis === 'p95' && it.p95 != null ? <div className="bmo-sub">기간 p95 {valText(it.p95, SLO_METRIC_TEXT[it.goal.metric]?.unit || '')}</div> : null}</td>
              <td data-sort={it.goal.source}>{sloSourceText(it.goal.source)}</td>
              <td className="right" data-sort={it.achievementPct ?? ''}>{it.achievementPct == null ? '—' : `${it.achievementPct}%`}{it.valid != null && <div className="bmo-sub">{it.within ?? 0}/{it.valid}주기</div>}</td>
              <td className="right" data-sort={it.violationMs ?? ''}>{hoursText(it.violationMs)}</td>
              <td data-sort={it.longest?.cycles ?? ''}>{longestText(it.longest)}</td>
              <td data-nosort className="bmrb-spark">{dailySpark(it.daily)}</td>
              <td className="right" data-sort={it.missing ?? ''}>{it.missing ?? '—'}주기 · {sloMaintText(it, resp)}{it.peakMissing ? <div className="bmo-sub">피크 표본 없음 {it.peakMissing}주기(결측으로 셈)</div> : null}</td>
              <td data-sort={st.label}><span style={{ color: toneVar(st.tone) }}>{st.label}</span>{it.error && <div className="bmo-sub">{it.error}</div>}</td>
            </tr>
          );
        })}
      </tbody>
    </STable>
  );
}
/** 지표별로 고를 수 있는 기준 — 피크 표본 열이 없는 지표는 ‘피크’ 를 빼고(서버가 400 으로 막는 것과 같은 목록 — 응답 peakMetrics). */
export function basesFor(meta = {}, metric = '') {
  const all = meta.bases || [];
  return Array.isArray(meta.peakMetrics) && !meta.peakMetrics.includes(metric) ? all.filter((b) => b !== 'peak') : all;
}
function GoalEditor({ cfg, meta, onSaved }) {
  const [scope, setScope] = useState('default');
  const [form, setForm] = useState(() => JSON.parse(JSON.stringify(cfg)));
  const [msg, setMsg] = useState(null);
  const listOf = (f) => (scope === 'default' ? f.default : (f.profiles?.[scope] || []));
  const setList = (fn) => setForm((f) => (scope === 'default' ? { ...f, default: fn(f.default || []) } : { ...f, profiles: { ...f.profiles, [scope]: fn(f.profiles?.[scope] || []) } }));
  async function save() {
    setMsg(null);
    try { const r = await putJson('/tools/bm-usage/slo', form); if (r?.ok === false) { setMsg({ tone: 'bad', text: `저장하지 못했습니다 — ${r.reason || ''}` }); return; } setMsg({ tone: 'ok', text: '저장했습니다(감사 기록).' }); onSaved?.(); }
    catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
  }
  return (
    <section className="bmo-card">
      <div className="bmo-h"><span>목표 편집 — 역할(기본) · 용도</span><span className="bmo-sub">서버 개별 목표는 이 서버 목록에서(설정 파일 · 감사)</span></div>
      <div className="bmcmp-ctl" style={{ marginTop: 0 }}>{['default', ...(meta.profiles || [])].map((s) => <button key={s} type="button" className={`btn btn-sm bmp-touch${scope === s ? ' btn-primary' : ''}`} onClick={() => setScope(s)}>{s === 'default' ? '역할(기본)' : `용도 ${s}`}</button>)}</div>
      {listOf(form).map((g, i) => (
        <div key={g.id || i} className="bmcmp-ctl">
          <Select sort={false} className="select select-sm" value={g.metric} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, metric: e.target.value, basis: basesFor(meta, e.target.value).includes(x.basis) ? x.basis : 'avg' } : x)))} aria-label="지표">{(meta.metrics || []).map((m) => <option key={m} value={m}>{SLO_METRIC_TEXT[m]?.label || m}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={g.basis} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, basis: e.target.value } : x)))} aria-label="기준">{basesFor(meta, g.metric).map((m) => <option key={m} value={m}>{SLO_BASIS_TEXT[m] || m}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={g.op} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))} aria-label="연산">{(meta.ops || []).map((m) => <option key={m} value={m}>{SLO_OP_TEXT[m] || m}</option>)}</Select>
          <input className="input" style={{ width: 90 }} type="number" value={g.value} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value === '' ? '' : Number(e.target.value) } : x)))} aria-label="값" />
          <label className="bmo-sub">목표 %<input className="input" style={{ width: 70 }} type="number" min={1} max={100} value={g.objectivePct} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, objectivePct: e.target.value === '' ? '' : Number(e.target.value) } : x)))} /></label>
          <button type="button" className="bmcmp-x" aria-label="목표 빼기" onClick={() => setList((l) => l.filter((_x, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="bmcmp-btns">
        <button type="button" className="btn btn-sm bmp-touch" onClick={() => setList((l) => [...l, { metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99 }])}>목표 더하기</button>
        <button type="button" className="btn btn-sm bmp-touch" onClick={save}>저장</button>
      </div>
      {msg && <p className="bmo-note" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
    </section>
  );
}
export function BmSloTab({ itemKey }) {
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState(false);
  const r = useOnce(itemKey ? `/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/slo` : '', tick);
  const cfg = useOnce(edit ? '/tools/bm-usage/slo' : '', tick);
  const u = getCurrentUser();
  const owner = hasRole('admin') && (u?.settingsOwnerTier === true || u?.name === 'Anonymous');
  const d = r.data;
  return (
    <div className="bmt-card" style={{ minWidth: 0 }}>
      <div className="bmt-panel-head">
        <h5>목표선(SLO) — {d?.month ? '이번 달' : '고른 기간'} 달성률</h5>
        <span style={{ flex: '1 1 auto' }} />
        {owner && d?.canEdit && <button type="button" className="btn btn-sm bmp-touch" aria-expanded={edit} onClick={() => setEdit((v) => !v)}>{edit ? '편집 닫기' : '목표 편집'}</button>}
        <button type="button" className="btn btn-sm bmp-touch" onClick={() => setTick((v) => v + 1)} disabled={r.loading}>{r.loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      {r.err && (r.err.status === 403 || r.err.status === 404 ? <ErrorBox error={r.err} /> : <p className="bmo-note" style={{ color: toneVar('bad') }}>읽지 못했습니다: {r.err.message || String(r.err)}</p>)}
      {d?.loadError && <p className="bmo-note" style={{ color: toneVar('warn') }}>{d.loadError.reason}</p>}
      {d && <SloTable resp={d} />}
      {d && <p className="bmo-note">{resNote(d.res)} {d.apps?.length ? `용도: ${d.apps.join(' · ')}.` : ''}</p>}
      {edit && cfg.data?.slo && <GoalEditor cfg={cfg.data.slo} meta={cfg.data} onSaved={() => setTick((v) => v + 1)} />}
      <p className="bmo-note">{SLO_HONEST}</p>
    </div>
  );
}
