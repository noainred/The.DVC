// 베어메탈 스토리지(v2.340, 사용자 요구) — 서버들의 로컬 디스크(지정 마운트 포인트) 용량을
// SSH(df)로 주기 수집해 전체/그룹/서버 순으로 총·사용·가용을 합산해 보여준다.
// 서버는 표(컬럼) 형식 폼으로 등록하고, 그룹을 지정하면 그룹 합산 카드가 생긴다.
// 수집 주체: 중앙 직접(기본) 또는 글로벌 엣지 위임(중앙→엣지 PUSH — 수집 서버(원격) URL 필요).
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { fmtAgo } from '../../util/fmt.js';

// 바이트 → 사람이 읽는 용량(TB/GB). 합산값이 크므로 TB 우선.
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2).toLocaleString()} MB`;
  return `${n.toLocaleString()} B`;
};
const pctColor = (p) => (p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--green)');

const EMPTY = { id: '', name: '', host: '', port: 22, username: 'root', password: '', agent: '', group: '', mounts: '/', enabled: true };

export default function BmStorageTool() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // 서버 추가/수정 폼 | null
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ivEdit, setIvEdit] = useState(null); // 주기 편집값(분) | null

  // 수동 로드 + 15초 재조회(저장/수집 직후 즉시 refresh 가 필요해 usePolling 대신 직접 관리).
  const refresh = () => fetchJson('/tools/bm-storage').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, []);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { total, groups, servers, config: cfgs, settings, status, agents } = data;
  const cfgOf = (id) => (cfgs || []).find((c) => c.id === id);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-storage/servers', { ...form, port: Number(form.port) || 22 });
      if (r.ok) { setForm(null); refresh(); }
      else setMsg(r.reason);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const del = async (s) => {
    if (!window.confirm(`'${s.name}' (${s.host}) 서버를 목록에서 삭제할까요?`)) return;
    try { await delJson(`/tools/bm-storage/servers/${encodeURIComponent(s.id)}`); refresh(); }
    catch (e) { setMsg(e.message); }
  };
  const collectNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-storage/collect', {});
      if (!r.ok) setMsg(r.reason || '수집이 이미 진행 중입니다.');
      else setMsg(`수집 완료 — 성공 ${r.okCount} · 오류 ${r.errors} (${Math.round(r.ms / 1000)}초)`);
      refresh();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const saveInterval = async () => {
    try {
      const r = await putJson('/tools/bm-storage/settings', { intervalMinutes: Number(ivEdit) });
      if (r.ok) { setIvEdit(null); refresh(); } else setMsg(r.reason);
    } catch (e) { setMsg(e.message); }
  };
  const edit = (s) => {
    const c = cfgOf(s.id);
    setForm({ ...EMPTY, ...c, password: '', mounts: (c?.mounts || []).join('\n') });
  };
  const bar = (p) => (
    <span style={{ display: 'inline-block', position: 'relative', width: 90, height: 7, borderRadius: 5, background: 'rgba(148,163,184,.15)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, p)}%`, background: pctColor(p), borderRadius: 5 }} />
    </span>
  );

  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>💽 베어메탈 스토리지</div>
          <div className="muted" style={{ fontSize: 12 }}>
            서버 SSH(df)로 지정 마운트 포인트의 로컬 디스크 용량을 수집 — 전체/그룹/서버 합산(총·사용·가용).
            엣지 위임 서버는 중앙→엣지 직접(PUSH)으로 수집합니다(수집 서버(원격) URL 필요).
          </div>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            수집 주기 {ivEdit === null
              ? <><b style={{ color: 'var(--text)' }}>{settings.intervalMinutes}분</b> <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => setIvEdit(settings.intervalMinutes)}>✎</button></>
              : <span className="flex gap" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <input className="input" type="number" min={1} max={1440} value={ivEdit} onChange={(e) => setIvEdit(e.target.value)} style={{ width: 70, padding: '4px 8px', fontSize: 12 }} />
                <button className="login-btn" style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }} onClick={saveInterval}>저장</button>
                <button className="logout-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setIvEdit(null)}>취소</button>
              </span>}
            {status.lastRunAt ? <> · 최근 수집 {fmtAgo(status.lastRunAt)}</> : ' · 아직 수집 전'}
          </span>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={busy || status.running} onClick={collectNow}>{status.running ? '수집 중…' : '⚡ 지금 수집'}</button>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setForm({ ...EMPTY })}>+ 서버 추가</button>
        </div>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8, color: '#93c5fd' }}>{msg}</div>}
      {error && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)' }}>⚠ 일시 조회 오류: {error}</div>}

      {/* 전체 합산 KPI — 사용자 요구: 지정 마운트들의 전체 용량·사용량·사용 가능 용량 종합 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Kpi label="서버" value={`${total.servers}대`} meta={`정상 ${total.ok} · 오류 ${total.errors}${total.pending ? ` · 미수집 ${total.pending}` : ''}`} accent={total.errors ? 'var(--red)' : undefined} />
        <Kpi label="총 용량" value={fmtBytes(total.totalBytes)} />
        <Kpi label="사용량" value={fmtBytes(total.usedBytes)} pct={Math.round(total.usedPct)} />
        <Kpi label="사용 가능" value={fmtBytes(total.availBytes)} />
      </div>

      {/* 그룹 합산 — 그룹을 지정한 서버들의 디스크 사용량이 합산되어 표시(사용자 요구) */}
      {groups.length > 0 && servers.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: 12 }}>
          <b style={{ fontSize: 13 }}>그룹별 합산</b>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>그룹</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>총 용량</th><th style={{ textAlign: 'right' }}>사용량</th><th style={{ textAlign: 'right' }}>사용 가능</th><th>사용률</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.name}>
                    <td><b>{g.name}</b></td>
                    <td style={{ textAlign: 'right' }}>{g.servers}{g.errors ? <span style={{ color: 'var(--red)', fontSize: 11 }}> (오류 {g.errors})</span> : ''}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBytes(g.totalBytes)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBytes(g.usedBytes)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBytes(g.availBytes)}</td>
                    <td>{bar(g.usedPct)} <b style={{ fontSize: 12, color: pctColor(g.usedPct) }}>{g.usedPct}%</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 서버 표 — 서버별(자기 마운트 합) 용량 + 마운트 상세 툴팁 + 오류 사유 */}
      <div className="card" style={{ padding: 12 }}>
        <b style={{ fontSize: 13 }}>서버 ({servers.length})</b>
        {servers.length === 0
          ? <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>등록된 서버가 없습니다. '+ 서버 추가'로 SSH 접속 정보와 측정할 마운트 포인트를 등록하세요.</div>
          : <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>이름</th><th>호스트</th><th>그룹</th><th>수집 주체</th><th style={{ textAlign: 'right' }}>마운트</th><th style={{ textAlign: 'right' }}>총 용량</th><th style={{ textAlign: 'right' }}>사용량</th><th style={{ textAlign: 'right' }}>사용 가능</th><th>사용률</th><th>최근 수집</th><th>작업</th></tr></thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id} style={s.enabled ? undefined : { opacity: 0.5 }}>
                    <td><b>{s.name}</b>{!s.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.host}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.group || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.agent ? <span className="badge blue">{s.agent}</span> : '중앙 직접'}</td>
                    <td style={{ textAlign: 'right' }} title={(s.mounts || []).map((m) => `${m.mount}: ${fmtBytes(m.usedBytes)}/${fmtBytes(m.totalBytes)}`).join('\n') || '아직 수집 전'}>
                      {s.mountCount}{s.missing?.length ? <span style={{ color: 'var(--amber)', fontSize: 11 }} title={`미발견 마운트: ${s.missing.join(', ')}`}> (미발견 {s.missing.length})</span> : ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>{s.ok ? fmtBytes(s.totalBytes) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.ok ? fmtBytes(s.usedBytes) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.ok ? fmtBytes(s.availBytes) : '—'}</td>
                    <td>{s.ok ? <>{bar(s.usedPct)} <b style={{ fontSize: 12, color: pctColor(s.usedPct) }}>{s.usedPct}%</b></>
                      : s.error ? <span style={{ color: 'var(--red)', fontSize: 11.5 }} title={s.error}>⚠ {s.error.slice(0, 40)}{s.error.length > 40 ? '…' : ''}</span>
                        : <span className="muted" style={{ fontSize: 12 }}>수집 대기</span>}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{s.at ? fmtAgo(s.at) : '—'}</td>
                    <td>
                      <span className="flex gap">
                        <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => edit(s)}>수정</button>
                        <button className="tab" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--red)' }} onClick={() => del(s)}>삭제</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
      </div>

      {/* 서버 추가/수정 — 컬럼 형식 접속 정보 + 마운트 포인트 목록(줄바꿈 구분) */}
      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setForm(null); }}>
          <EscClose onClose={() => { if (!busy) setForm(null); }} />
          <div className="modal card" style={{ maxWidth: 620 }}>
            <h3 style={{ marginTop: 0 }}>{form.id ? `서버 수정 — ${form.name || form.host}` : '서버 추가'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
              <label>이름<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="표시 이름(비우면 host)" /></label>
              <label>그룹<input className="input" value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} placeholder="합산 그룹(예: WA-백업)" list="bm-groups" />
                <datalist id="bm-groups">{groups.filter((g) => g.name !== '(그룹 없음)').map((g) => <option key={g.name} value={g.name} />)}</datalist></label>
              <label>호스트(IP/FQDN) *<input className="input" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.10.5" /></label>
              <label>SSH 포트<input className="input" type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} /></label>
              <label>계정<input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
              <label>비밀번호<input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={form.id ? '비우면 기존 유지' : ''} autoComplete="new-password" /></label>
              <label>수집 주체
                <select className="input" value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                  <option value="">중앙 직접(SSH)</option>
                  {(agents || []).map((a) => <option key={a} value={a}>엣지 위임 — {a}</option>)}
                </select>
              </label>
              <label className="flex gap" style={{ alignItems: 'center', marginTop: 18, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 수집 활성
              </label>
            </div>
            <label style={{ display: 'block', fontSize: 13, marginTop: 10 }}>측정할 마운트 포인트 * <span className="muted" style={{ fontSize: 11.5 }}>(줄바꿈/쉼표 구분 · 절대경로 · 예: / , /data , /var/log)</span>
              <textarea className="input" style={{ width: '100%', minHeight: 80, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, marginTop: 4 }}
                value={form.mounts} onChange={(e) => setForm({ ...form, mounts: e.target.value })} placeholder={'/\n/data'} />
            </label>
            {msg && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 6 }}>⚠ {msg}</div>}
            <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="tab" style={{ padding: '8px 16px' }} disabled={busy} onClick={() => setForm(null)}>취소</button>
              <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy || !form.host.trim()} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
