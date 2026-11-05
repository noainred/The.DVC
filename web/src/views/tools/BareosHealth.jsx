// v2.891 Bareos 사전 점검 화면 조각(docs/design/bareos-precheck · 컨펌 2026-11-05) — 현황 띠 · 법인 카드 · 설정 행.
// 판정은 서버(GET /tools/bareos-backup/health — 관리자) · 이 파일은 보여 주기만. 403(관리자 아님)이면 조용히 숨긴다(조각이라 화면을 막지 않는다).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Note } from './BareosBits.jsx';
import { requireChanged } from '../changeResult.js';
import {
  healthBadge, healthCounts, healthBand, whenShort, fromText, sparkPoints, HEALTH_LIMIT_TEXT, healthSettingsBody, healthSettingsForm, lastRunText,
  sparkOf, staleText, healthRunWaitMs, healthRunErrorText, isTimeoutError,
} from './bareosHealthText.js';

export const HEALTH_URL = '/tools/bareos-backup/health';
const TONE_TAG = {
  ok: { background: 'rgba(34,197,94,.16)', color: '#86efac' }, warn: { background: 'rgba(245,158,11,.16)', color: '#fcd34d' },
  bad: { background: 'rgba(239,68,68,.16)', color: '#fca5a5' }, muted: { background: 'rgba(148,163,184,.12)', color: 'var(--text-dim)' },
};
const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', minWidth: 0 };

export function HealthTag({ status, children }) {
  const b = healthBadge(status);
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', ...(TONE_TAG[b.tone] || TONE_TAG.muted) }}>{children || b.text}</span>;
}

/** GET /health 를 한 번(+ reload) — 관리자가 아니면 { hidden:true }. 늦게 온 이전 응답은 버린다. */
export function useHealth() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const gen = useRef(0);
  const load = useCallback(() => {
    const g = ++gen.current;
    return fetchJson(HEALTH_URL, {}, undefined, { retries: 0 })
      .then((r) => { if (g === gen.current) { setD(r); setErr(null); } })
      .catch((e) => { if (g === gen.current) { if (e?.status === 403 || e?.status === 401) setD({ hidden: true, corps: [] }); else setErr(e); } });
  }, []);
  useEffect(() => { load(); }, [load]);
  return { d, err, load };
}

/** 현황 위 경고 띠 — 불가 법인이 있을 때만. */
export function HealthBand({ corps, nameOf, onOpen }) {
  const band = healthBand(corps, nameOf);
  if (!band.length) return null;
  const n = healthCounts(corps);
  const last = Math.max(0, ...(corps || []).map((c) => Number(c.at) || 0));
  return (
    <div role="status" data-bareos-health-band="" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '6px 14px', padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(239,68,68,.45)', background: 'rgba(239,68,68,.08)', minWidth: 0 }}>
      <b style={{ color: '#fca5a5' }}>사전 점검({whenShort(last)}) — 오늘 밤 백업이 실패할 수 있는 법인 {band.length}곳</b>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, minWidth: 0, flex: '1 1 420px' }}>
        {band.map((b) => (
          <li key={b.vcenterId} style={{ overflowWrap: 'anywhere' }}>
            <b>{b.name}</b> — {b.label}: {b.detail}{onOpen && <> · <button type="button" onClick={() => onOpen(b.vcenterId)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent-2, #93c5fd)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>법인 화면 →</button></>}
          </li>
        ))}
      </ul>
      <span className="muted" style={{ fontSize: 11.5 }}>경고 {n.warn}곳 · 모름 {n.unknown}곳 · {HEALTH_LIMIT_TEXT}</span>
    </div>
  );
}

/** 법인 화면의 '사전 점검' 카드. */
export function BareosHealthCard({ vcId }) {
  const { d, err, load } = useHealth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (d?.hidden) return null;
  if (!d) return err ? <Note tone="bad">사전 점검을 읽지 못했습니다 — {String(err.message || err).slice(0, 200)}</Note> : null;
  const c = (d.corps || []).find((x) => x.vcenterId === vcId) || null;
  const run = async () => {
    setBusy(true); setMsg(null);
    // 브라우저 시한은 서버 시한(deadlineMs)보다 길게(반증 R8 — 기본 180초가 서버 대기보다 짧아 서버는 기록하는데 화면은 실패로 보였다)
    try { const r = await postJson(`${HEALTH_URL}/run`, { vcenterId: vcId }, { timeoutMs: healthRunWaitMs(d.deadlineMs) }); if (r?.ok === false) throw new Error(r.reason || '점검하지 못했습니다'); await load(); setMsg({ ok: true, text: '점검했습니다.' }); }
    catch (e) { setMsg({ ok: false, text: healthRunErrorText(e) }); if (isTimeoutError(e)) load(); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (!window.confirm('지금 본 vCenter 인증서 지문을 기준으로 삼습니다 — FD INI 의 지문을 새 값으로 바꾼 뒤에 누르세요. 계속할까요?')) return;
    setBusy(true); setMsg(null);
    try { const r = await postJson(`${HEALTH_URL}/${encodeURIComponent(vcId)}/thumb-accept`, {}); if (r?.ok === false) throw new Error(r.reason || '바꾸지 못했습니다'); await load(); setMsg({ ok: true, text: '새 지문을 기준으로 삼았습니다.' }); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const border = c?.verdict === 'bad' ? 'rgba(239,68,68,.45)' : c?.verdict === 'warn' ? 'rgba(245,158,11,.45)' : undefined;
  const live = c && !c.stale ? c.items || [] : [];   // 지난 회차에서 못 돈 법인은 이전 항목의 수를 세지 않는다(모름)
  const nBad = live.filter((x) => x.status === 'bad').length; const nWarn = live.filter((x) => x.status === 'warn').length; const nUnk = live.filter((x) => x.status === 'unknown').length;
  const disk = (c?.items || []).find((x) => x.key === 'disk');
  const spark = sparkOf(c);
  const pts = sparkPoints(spark);
  const thumbWarn = (c?.items || []).some((x) => x.key === 'thumb' && x.status === 'warn');
  return (
    <div className="card" data-bareos-health="" style={{ padding: 0, overflow: 'hidden', minWidth: 0, ...(border ? { borderColor: border } : {}) }}>
      <div style={{ ...ROW, padding: '12px 16px', borderBottom: '1px solid var(--border-soft)' }}>
        <b style={{ fontSize: 14 }}>사전 점검</b>
        {c ? <span className="muted" style={{ fontSize: 12 }}>{whenShort(c.at)} · {fromText(c.from)}{c.demo ? ' · 데모(합성값)' : ''}</span> : <span className="muted" style={{ fontSize: 12 }}>아직 점검 기록이 없습니다</span>}
        {nBad > 0 && <HealthTag status="bad">불가 {nBad}</HealthTag>}{nWarn > 0 && <HealthTag status="warn">경고 {nWarn}</HealthTag>}{nUnk > 0 && <HealthTag status="unknown">모름 {nUnk}</HealthTag>}
        <div style={{ ...ROW, marginLeft: 'auto' }}>
          {thumbWarn && <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={accept}>새 지문을 기준으로</button>}
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '5px 12px' }} disabled={busy} onClick={run}>{busy ? '점검 중…' : '지금 점검'}</button>
        </div>
      </div>
      <div style={{ padding: '10px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {msg && <Note tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Note>}
        {c?.stale && <Note tone="warn">{staleText(c)}</Note>}
        {busy && <div className="muted" style={{ fontSize: 12 }}>엣지 대행 법인은 엣지가 가져가 회신할 때까지 기다립니다(최대 {Math.round((d.deadlineMs || 0) / 1000) || '—'}초).</div>}
        {c?.verdict === 'bad' && <div style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid rgba(239,68,68,.45)', background: 'rgba(239,68,68,.10)', color: '#fca5a5', fontWeight: 700 }}>오늘 밤 백업이 실패할 수 있습니다 — {(c.items.find((x) => x.status === 'bad') || {}).label}.</div>}
        {c && (
          <div className="table-wrap">
            <STable sortable={false} minWidth={600} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ textAlign: 'left', fontSize: 12 }}><th style={{ padding: '6px 8px', width: 170 }}>항목</th><th style={{ padding: '6px 8px', width: 70 }}>결과</th><th style={{ padding: '6px 8px' }}>상세</th><th style={{ padding: '6px 8px' }}>조치</th></tr></thead>
              <tbody>
                {c.items.map((x) => (
                  <tr key={x.key} style={{ borderTop: '1px solid var(--border-soft)', verticalAlign: 'top' }}>
                    <td style={{ padding: '7px 8px' }}><b>{x.label}</b></td>
                    <td style={{ padding: '7px 8px' }}><HealthTag status={x.status} /></td>
                    <td style={{ padding: '7px 8px', overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
                      {x.detail || '—'}
                      {x.key === 'disk' && pts && (
                        <div style={{ marginTop: 4 }}>
                          <svg width="180" height="36" viewBox="0 0 180 36" role="img" aria-label="최근 디스크 사용률 추이"><polyline points={pts} fill="none" stroke={disk?.status === 'bad' ? '#f87171' : disk?.status === 'warn' ? '#fbbf24' : '#4ade80'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ padding: '7px 8px', fontSize: 12, overflowWrap: 'anywhere', whiteSpace: 'normal', minWidth: 180 }}>{x.action || '없음'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        )}
        <div className="muted" style={{ ...ROW, fontSize: 11.5 }}>
          {c?.history?.length ? <span>최근 {c.history.length}회: {c.history.map((h) => healthBadge(h.verdict).text).join(' → ')}</span> : null}
          <span style={{ marginLeft: 'auto' }}>{HEALTH_LIMIT_TEXT}</span>
        </div>
      </div>
    </div>
  );
}

/** 설정 › 공통 기본값 · 수집 › 사전 점검(따로 저장). 관리자 + 전체 범위만(서버가 집행). */
export function BareosHealthSettings({ writable = true }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => fetchJson(HEALTH_URL).then((r) => { setD(r); setForm(healthSettingsForm(r.config)); }).catch(setErr), []);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <Note tone="bad">사전 점검 설정을 읽지 못했습니다 — {String(err.message || err).slice(0, 200)}</Note>;
  if (!d || !form) return <div className="muted" style={{ fontSize: 12 }}>읽는 중…</div>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    setBusy(true); setMsg(null);
    try { requireChanged(await putJson(`${HEALTH_URL}/settings`, healthSettingsBody(form))); setMsg({ ok: true, text: '저장했습니다.' }); load(); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const runAll = async () => {
    setBusy(true); setMsg(null);
    try { const r = await postJson(`${HEALTH_URL}/run`, {}); if (r?.ok === false) throw new Error(r.reason || '시작하지 못했습니다'); setMsg({ ok: true, text: r.demo ? '데모 — 합성값입니다.' : '전 법인 점검을 시작했습니다 — 엣지가 회신하면 현황 · 법인 화면에 반영됩니다.' }); setTimeout(load, 5000); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const INP = { width: 64 };
  const n = healthCounts(d.corps);
  return (
    <div data-bareos-health-settings="" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>법인마다 엣지 노드(포탈 완전 설치는 FD · SD 와 같은 서버)에서 오늘 밤 백업이 실패할 조건을 미리 봅니다 — FD → vCenter:443 접속 · 인증서 지문 · Director 콘솔 · SD 디스크 여유. SSH · 비밀번호 없이 읽기만 합니다. 담당 엣지가 없는 Director 는 중앙에서 본 vCenter 접속을 ‘참고’ 로만 싣고 디스크는 모름입니다.</div>
      {d.loadError && <Note tone="bad">설정 파일을 읽지 못했습니다(손상본 보존) — 점검하지 않고 저장을 막았습니다.</Note>}
      <div style={ROW}>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}><input type="checkbox" checked={form.enabled} onChange={set('enabled')} />매일 점검</label>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}>시각(포탈 시각)<input className="input" style={{ width: 80 }} value={form.time} onChange={set('time')} aria-label="점검 시각" /></label>
        <span className="muted" style={{ fontSize: 11.5 }}>기본 20:00 — 완전 설치 기본 백업 창(02:00)보다 앞입니다. 그룹 스케줄이 더 이르면 그 전으로 옮기세요.</span>
      </div>
      <div style={ROW}>
        <b style={{ fontSize: 12.5, minWidth: 90 }}>디스크 기준</b>
        <span className="muted" style={{ fontSize: 12 }}>경고</span>
        <label className="muted" style={{ ...ROW, gap: 4, fontSize: 12 }}>여유<input className="input" style={INP} inputMode="numeric" value={form.warnPct} onChange={set('warnPct')} aria-label="경고 여유 %" />% 이하 또는</label>
        <label className="muted" style={{ ...ROW, gap: 4, fontSize: 12 }}><input className="input" style={INP} inputMode="numeric" value={form.warnDays} onChange={set('warnDays')} aria-label="경고 일수" />일 이내</label>
        <span className="muted" style={{ fontSize: 12 }}>위험</span>
        <label className="muted" style={{ ...ROW, gap: 4, fontSize: 12 }}>여유<input className="input" style={INP} inputMode="numeric" value={form.badPct} onChange={set('badPct')} aria-label="위험 여유 %" />% 또는</label>
        <label className="muted" style={{ ...ROW, gap: 4, fontSize: 12 }}><input className="input" style={INP} inputMode="numeric" value={form.badDays} onChange={set('badDays')} aria-label="위험 일수" />일</label>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: -4 }}>‘n일’ 은 최근 7일 사용량 증가 속도(하루 한 표본)로 가득 찰 때까지를 선형으로 셉니다 — 표본이 3개 미만이거나 늘지 않으면 쓰지 않습니다.</div>
      <div style={ROW}>
        <b style={{ fontSize: 12.5, minWidth: 90 }}>알림</b>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}><input type="checkbox" checked={form.onWorse} onChange={set('onWorse')} />나빠지면 메일(‘Bareos 사전 점검’)</label>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}><input type="checkbox" checked={form.onRecover} onChange={set('onRecover')} />회복되면 1통</label>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}><input type="checkbox" checked={form.inDigest} onChange={set('inDigest')} />일일 요약에 ‘사전 점검’ 절</label>
      </div>
      <div style={ROW}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '5px 12px' }} disabled={busy || d.loadError || !writable} onClick={save}>저장</button>
        <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy || !writable || d.running} onClick={runAll}>{d.running ? '전 법인 점검 중…' : '지금 전 법인 점검'}</button>
        <span className="muted" style={{ fontSize: 12 }}>마지막: {lastRunText(d.last)} · 정상 {n.ok} · 불가 {n.bad} · 경고 {n.warn} · 모름 {n.unknown}</span>
      </div>
      {msg && <Note tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Note>}
      <div className="muted" style={{ fontSize: 11.5 }}>{HEALTH_LIMIT_TEXT}</div>
    </div>
  );
}
