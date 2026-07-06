import React, { useEffect, useMemo, useState } from 'react';
import { usePolling, fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

// 상태별 색상(파이썬 원본의 baseline 편차 색상 코딩 이식).
const COLOR = { ok: '#22c55e', warn: '#eab308', crit: '#f97316', down: '#ef4444', unknown: '#6b7280' };
const LABEL = { ok: '정상', warn: '주의(+20%)', crit: '경고(+50%)', down: '무응답', unknown: '수집 전' };
const RANGES = [['1h', '1시간'], ['6h', '6시간'], ['24h', '24시간'], ['7d', '7일'], ['30d', '30일'], ['1y', '1년']];
const fmtMs = (v) => (v == null ? '—' : `${v} ms`);
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
};

/** 버킷 시계열을 상태 색상 막대 + baseline 선으로 그리는 경량 SVG 차트. */
function SeriesChart({ data }) {
  const { series = [], baseline } = data || {};
  const W = 900, H = 220, padB = 22, padL = 40, padT = 10;
  const pts = series.filter((s) => s.avg != null || s.status === 'down');
  const maxRtt = Math.max(1, baseline ? baseline * 1.6 : 1, ...pts.map((s) => s.max || s.avg || 0));
  const n = series.length || 1;
  const bw = (W - padL - 6) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - Math.min(v, maxRtt) / maxRtt);
  const baseY = baseline ? y(baseline) : null;
  const first = series[0]?.ts, last = series[series.length - 1]?.ts;
  const tfmt = (ts) => { const d = new Date(ts); return `${String(d.getMonth() + 1)}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(255,255,255,.02)', borderRadius: 8 }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const v = maxRtt * (1 - f); const yy = padT + (H - padT - padB) * f;
        return <g key={f}><line x1={padL} y1={yy} x2={W - 4} y2={yy} stroke="rgba(255,255,255,.08)" /><text x={4} y={yy + 3} fill="#9ca3af" fontSize="10">{Math.round(v)}</text></g>;
      })}
      {baseY != null && <>
        <line x1={padL} y1={baseY} x2={W - 4} y2={baseY} stroke="#38bdf8" strokeDasharray="4 3" strokeWidth="1.2" />
        <text x={W - 4} y={baseY - 3} fill="#38bdf8" fontSize="10" textAnchor="end">기준 {baseline}ms</text>
      </>}
      {series.map((s, i) => {
        const x = padL + i * bw;
        if (s.status === 'down' || s.avg == null) {
          return <rect key={i} x={x} y={padT} width={Math.max(1, bw - 1)} height={H - padT - padB} fill="rgba(239,68,68,.18)" />;
        }
        const top = y(s.max ?? s.avg); const h = Math.max(1.5, (H - padB) - top);
        return <g key={i}>
          <rect x={x} y={y(s.max ?? s.avg)} width={Math.max(1, bw - 1)} height={Math.max(1, y(s.min ?? s.avg) - y(s.max ?? s.avg))} fill={COLOR[s.status]} opacity="0.35" />
          <rect x={x} y={top} width={Math.max(1, bw - 1)} height={h} fill={COLOR[s.status]} opacity="0.9">
            <title>{`${tfmt(s.ts)}\n평균 ${s.avg}ms (${s.min}~${s.max})\n손실 ${Math.round((s.loss || 0) * 100)}%`}</title>
          </rect>
        </g>;
      })}
      {first && <text x={padL} y={H - 6} fill="#9ca3af" fontSize="10">{tfmt(first)}</text>}
      {last && <text x={W - 4} y={H - 6} fill="#9ca3af" fontSize="10" textAnchor="end">{tfmt(last)}</text>}
    </svg>
  );
}

const EMPTY = { name: '', host: '', kind: 'icmp', port: '', baselineMs: '', note: '', enabled: true };

export default function PingMonitor() {
  const { data, error, loading } = usePolling('/ping/status', {}, 15_000);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sel, setSel] = useState(null);        // 선택 대상 id
  const [range, setRange] = useState('6h');
  const [series, setSeries] = useState(null);
  const [seriesErr, setSeriesErr] = useState(null);
  const [form, setForm] = useState(null);      // 추가/수정 폼
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetchJson('/auth/me').then((r) => setIsAdmin(r.user?.role === 'admin')).catch(() => {}); }, []);
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };

  const targets = data?.targets || [];
  // 선택 대상이 사라지면 해제.
  useEffect(() => { if (sel && !targets.some((t) => t.id === sel)) setSel(null); }, [targets, sel]);

  const loadSeries = () => {
    if (!sel) { setSeries(null); return; }
    setSeriesErr(null);
    fetchJson('/ping/series', { id: sel, range }).then((r) => { if (r.ok) setSeries(r); else setSeriesErr(r.reason || '조회 실패'); }).catch((e) => setSeriesErr(e.message));
  };
  useEffect(() => { loadSeries(); /* eslint-disable-next-line */ }, [sel, range]);

  const save = async () => {
    setBusy(true);
    const body = { name: form.name, host: form.host, kind: form.kind, port: form.port === '' ? undefined : Number(form.port), baselineMs: form.baselineMs === '' ? undefined : Number(form.baselineMs), note: form.note, enabled: form.enabled };
    const r = form.id
      ? await putJson(`/ping/targets/${encodeURIComponent(form.id)}`, body).catch((e) => ({ ok: false, reason: e.message }))
      : await postJson('/ping/targets', body).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) { setForm(null); flash(true, form.id ? '대상을 수정했습니다.' : '대상을 추가했습니다.'); } else flash(false, r.reason || '저장 실패');
  };
  const remove = async (t) => {
    if (!window.confirm(`'${t.name}' 대상을 삭제할까요? 측정 이력도 함께 삭제됩니다.`)) return;
    const r = await delJson(`/ping/targets/${encodeURIComponent(t.id)}`).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { if (sel === t.id) setSel(null); flash(true, '삭제했습니다.'); } else flash(false, r.reason || '삭제 실패');
  };
  const pollNow = async () => { setBusy(true); const r = await postJson('/ping/poll-now').catch((e) => ({ ok: false, reason: e.message })); setBusy(false); flash(r.ok, r.ok ? `측정 완료 (${r.up ?? 0}/${r.measured ?? 0} 응답)` : (r.reason || '측정 실패')); if (r.ok) setTimeout(loadSeries, 500); };
  const syncVc = async () => { setBusy(true); const r = await postJson('/ping/seed-vcenters').catch((e) => ({ ok: false, reason: e.message })); setBusy(false); flash(r.ok, r.ok ? (r.added ? `vCenter ${r.added}개를 대상으로 추가했습니다.` : '추가할 새 vCenter가 없습니다.') : (r.reason || '동기화 실패')); };

  const counts = data?.counts || {};
  const selTarget = targets.find((t) => t.id === sel);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  return (
    <>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          {['ok', 'warn', 'crit', 'down', 'unknown'].map((k) => (counts[k] ? (
            <span key={k} className="badge" style={{ background: `${COLOR[k]}22`, color: COLOR[k], border: `1px solid ${COLOR[k]}55` }}>{LABEL[k]} {counts[k]}</span>
          ) : null))}
          <span className="muted" style={{ fontSize: 12 }}>총 {targets.length}개 대상 · 자동 측정</span>
        </div>
        {isAdmin && <div className="flex gap">
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={busy} onClick={syncVc} title="등록된 vCenter를 Ping 대상으로 자동 추가(TCP 443)">vCenter 동기화</button>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={busy} onClick={pollNow}>지금 측정</button>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={() => setForm({ ...EMPTY })}>+ 대상 추가</button>
        </div>}
      </div>
      {msg && <div className="card" style={{ padding: '8px 12px', marginBottom: 10, borderLeft: `3px solid var(--${msg.ok ? 'green' : 'red'})`, fontSize: 13 }}>{msg.ok ? '✓' : '⚠'} {msg.text}</div>}

      {form && isAdmin && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <b style={{ fontSize: 13 }}>{form.id ? '대상 수정' : '대상 추가'}</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 10 }}>
            <label style={{ fontSize: 12 }}>표시 이름<input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="예: 폴란드 vCenter" /></label>
            <label style={{ fontSize: 12 }}>대상 주소(호스트/IP) *<input className="input" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="예: 10.0.0.5" /></label>
            <label style={{ fontSize: 12 }}>측정 방식<select className="select" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}><option value="icmp">ICMP ping</option><option value="tcp">TCP 연결</option></select></label>
            {form.kind === 'tcp' && <label style={{ fontSize: 12 }}>포트<input className="input" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} placeholder="443" /></label>}
            <label style={{ fontSize: 12 }}>기준 RTT(ms, 선택)<input className="input" value={form.baselineMs} onChange={(e) => setForm((f) => ({ ...f, baselineMs: e.target.value }))} placeholder="비우면 자동(중앙값)" /></label>
            <label style={{ fontSize: 12 }}>메모<input className="input" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="비고(선택)" /></label>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginTop: 18 }}><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> 활성(측정)</label>
          </div>
          <div className="flex gap" style={{ marginTop: 10 }}>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy} onClick={save}>저장</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setForm(null)}>닫기</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>ICMP가 방화벽에 막힌 대상은 'TCP 연결'로 제어플레인 포트(443 등) 지연을 측정하세요. 기준 대비 +20% 주의 / +50% 경고로 색상 표시됩니다.</div>
        </div>
      )}

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead><tr><th>상태</th><th>대상</th><th>주소</th><th>방식</th><th className="right">현재 RTT</th><th className="right">기준</th><th>측정</th>{isAdmin && <th className="right">작업</th>}</tr></thead>
          <tbody>
            {targets.length === 0 && <tr><td colSpan={isAdmin ? 8 : 7} className="center muted" style={{ padding: 24 }}>등록된 Ping 대상이 없습니다. {isAdmin ? '“+ 대상 추가”로 등록하세요.' : '관리자에게 대상 등록을 요청하세요.'}</td></tr>}
            {targets.map((t) => (
              <tr key={t.id} onClick={() => setSel(t.id)} style={{ cursor: 'pointer', background: sel === t.id ? 'rgba(56,189,248,.10)' : (t.enabled ? undefined : 'rgba(255,255,255,.02)') }}>
                <td><span className="badge" style={{ background: `${COLOR[t.status]}22`, color: COLOR[t.status], border: `1px solid ${COLOR[t.status]}55` }}>● {LABEL[t.status]}</span></td>
                <td><b>{t.name}</b>{!t.enabled && <span className="muted" style={{ fontSize: 11 }}> (비활성)</span>}{t.note && <div className="muted" style={{ fontSize: 11 }}>{t.note}</div>}</td>
                <td className="muted">{t.host}{t.kind === 'tcp' ? `:${t.port}` : ''}</td>
                <td className="muted">{t.kind === 'tcp' ? 'TCP' : 'ICMP'}</td>
                <td className="right tabular" style={{ color: COLOR[t.status], fontWeight: 600 }}>{t.status === 'down' ? '무응답' : fmtMs(t.rtt)}</td>
                <td className="right tabular muted">{t.baseline ? `${t.baseline}${t.baselineAuto ? '*' : ''}` : '—'}</td>
                <td className="muted" style={{ fontSize: 12 }}>{ago(t.lastTs)}</td>
                {isAdmin && <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                  <button className="tab" onClick={() => setForm({ id: t.id, name: t.name, host: t.host, kind: t.kind, port: t.port || '', baselineMs: t.baseline && !t.baselineAuto ? t.baseline : '', note: t.note || '', enabled: t.enabled })}>수정</button>
                  <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(t)}>삭제</button>
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: -8, marginBottom: 12 }}>* 기준값 옆 별표는 자동 산출(최근 정상 응답의 중앙값)을 의미합니다. 행을 클릭하면 아래에 추세가 표시됩니다.</div>

      {sel && selTarget && (
        <div className="card" style={{ padding: 14 }}>
          <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
            <b style={{ fontSize: 14 }}>{selTarget.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {selTarget.host}{selTarget.kind === 'tcp' ? `:${selTarget.port}` : ''} · {selTarget.kind === 'tcp' ? 'TCP' : 'ICMP'}</span></b>
            <div className="flex gap">
              {RANGES.map(([k, l]) => <button key={k} className={range === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 10px' }} onClick={() => setRange(k)}>{l}</button>)}
            </div>
          </div>
          {seriesErr ? <ErrorBox message={seriesErr} />
            : !series ? <Loading />
            : series.series.length === 0 ? <div className="center muted" style={{ padding: 30 }}>이 기간에 측정 데이터가 없습니다. 잠시 후 자동 측정되면 표시됩니다.</div>
            : <SeriesChart data={series} />}
          {series && series.series.length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>버킷 {Math.round((series.bucketMs || 0) / 1000)}초 · 막대 높이=최대 RTT, 흐린 영역=min~max, 빨강=무응답. 기준선(하늘색) 대비 색상으로 지연 악화를 표시합니다.</div>
          )}
        </div>
      )}
    </>
  );
}
