/**
 * 베어메탈 사용률 — **서버 분석 › 구분 › Baremetal(미가상화 물리)** 로 분류된 서버만
 * CPU·메모리·디스크·네트워크·HBA 사용률을 수집해 보여준다(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어".
 * 선택: **iDRAC + OS SSH 둘 다(되는 것부터)** · **법인 단위로 켠다** · **5분 · 원시 90일 + 일롤업
 * 5년** · **Linux + Windows 둘 다**.
 *
 * 화면 설계 의도:
 *  1. 맨 위는 **'이 숫자를 믿어도 되는가'** — 꺼짐/법인 미선택/대상 0/첫 주기/오래됨을 구분해 말한다.
 *  2. 표는 다섯 지표를 나란히 두고 **값이 없으면 `—`** 다(0 을 그리지 않는다).
 *  3. 행을 누르면 상세 — 무엇을 읽었고 무엇을 못 읽었는지, 장치·인터페이스별 값, 추이.
 *  4. 판정·문구는 `bmUsageText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — '지금 수집' 은 SSH·Redfish 왕복이다(마운트 1회 + 버튼, v2.508 규약).
 * ⚠ 전역 잠금을 쓰지 않는다 — 수집 중에도 설정을 고칠 수 있어야 한다(v2.529 규약).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  pctText, bpsText, ageText, usageTone, toneVar, srcMark,
  emptyDiag, firstSampleNote, skippedNotes, detailNotes, retentionNote, edgeNote, missingMark, missingFootnotes, authStopNote,
} from './bmUsageText.js';

/** 표의 지표 열 — 서버가 준 `metrics` 계약과 같은 순서를 쓴다. */
const COLS = [
  { col: 'cpu_pct', label: 'CPU', kind: 'pct' },
  { col: 'mem_pct', label: '메모리', kind: 'pct' },
  { col: 'disk_busy_pct', label: '디스크 I/O', kind: 'pct' },
  { col: 'disk_used_pct', label: '디스크 공간', kind: 'pct' },
  { col: 'net_pct', label: '네트워크', kind: 'pct' },
  { col: 'net_bps', label: '네트워크 처리량', kind: 'bps' },
  { col: 'hba_pct', label: 'HBA', kind: 'pct' },
  { col: 'hba_bps', label: 'HBA 처리량', kind: 'bps' },
];

function Cell({ v, kind }) {
  if (kind === 'bps') return <span>{bpsText(v)}</span>;
  return <span style={{ color: toneVar(usageTone(v)) }}>{pctText(v)}</span>;
}

export function BmUsage() {
  // ⚠ 훅은 전부 조기 return 위에(루트 CLAUDE.md — 조기 반환 뒤 훅 추가는 React #310 크래시).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState('');
  const [detail, setDetail] = useState(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { const d = await fetchJson('/tools/bm-usage'); setData(d); setForm(d.settings || null); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const byKey = new Map((data?.rows || []).map((r) => [String(r.key), r]));
    return (data?.targets || []).map((tg) => ({ ...tg, ...(byKey.get(String(tg.key)) || {}), key: tg.key }));
  }, [data]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => [r.name, r.serviceTag, r.vcenterId, r.model, r.idracHost, r.osHostName]
      .some((v) => String(v || '').toLowerCase().includes(s)));
  }, [rows, q]);

  const diag = useMemo(() => (data ? emptyDiag(data) : null), [data]);

  async function collectNow() {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-usage/collect', {});
      setMsg(r.ok
        ? { tone: 'ok', text: `수집 완료 — 서버 ${r.servers ?? 0}대 중 **성공 ${r.okCount ?? 0}** · 실패 ${r.failCount ?? 0} · 저장 ${r.inserted ?? 0}행` }
        : { tone: 'bad', text: r.reason || '수집에 실패했습니다.' });
      load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }

  async function openDetail(key) {
    setSel(key); setDetail(null);
    try { setDetail(await fetchJson('/tools/bm-usage/history', { key, hours: 24 })); }
    catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
  }

  async function saveSettings(patch) {
    setSaving(true);
    try {
      const r = await putJson('/tools/bm-usage/settings', patch);
      setForm(r.settings); setMsg({ tone: 'ok', text: '설정을 저장했습니다.' });
      load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  }

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const st = data?.status || {};
  const selRow = rows.find((r) => r.key === sel) || null;
  const fsNote = firstSampleNote(data?.rows || []);
  const skNotes = skippedNotes(data?.skippedCounts || {}, data?.reasons || {});

  return (
    <div className="stack" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} />}

      <div className="card" style={{ minWidth: 0 }}>
        <h3 style={{ marginTop: 0 }}>베어메탈 사용률</h3>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'대상은 **서버 분석 › 구분 › Baremetal(미가상화 물리)** 과 정확히 같은 집합입니다. 디스크·네트워크·HBA 는 **OS 계정이 있는 서버만** 읽을 수 있고, iDRAC 텔레메트리는 CPU·메모리·I/O(집계)까지 줍니다.'} />
        </p>
        {diag?.text && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar(diag.waiting ? 'warn' : (diag.kind === 'ok' ? 'ok' : 'bad')) }}>
            <BoldText text={diag.text} />
          </p>
        )}
        {fsNote && <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={fsNote} /></p>}
        {/* ⚠ 인증 실패 정지는 **반드시 화면이 말한다** — 조용히 멈추면 사용자는 수집되는 줄 안다(v2.528). */}
        {authStopNote(data?.authStops || []) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('bad') }}>
            <BoldText text={authStopNote(data.authStops)} />
          </p>
        )}
        {edgeNote(data?.isEdge) && <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={edgeNote(data.isEdge)} /></p>}
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={retentionNote(data?.settings || {}, data?.db || {})} />
        </p>
      </div>

      <div className="kpis">
        <Kpi label="수집 대상" value={data?.counts?.targets ?? 0} />
        <Kpi label="OS 경로" value={data?.counts?.os ?? 0} />
        <Kpi label="iDRAC 경로" value={data?.counts?.idrac ?? 0} />
        <Kpi label="대상 아님" value={data?.counts?.skipped ?? 0} />
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <SearchBox value={q} onChange={setQ} placeholder="서버·서비스태그·법인·모델 검색" />
          <button onClick={collectNow} disabled={busy || !data?.enabled} title={data?.enabled ? '' : '수집이 꺼져 있습니다'}>
            {busy ? '수집 중…' : '지금 수집'}
          </button>
          <button onClick={load}>새로고침</button>
          <button onClick={() => setShowSettings((v) => !v)}>{showSettings ? '설정 닫기' : '설정'}</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            마지막 수집 {ageText(st.last?.at)} · 주기 {st.intervalMs ? `${Math.round(st.intervalMs / 60000)}분` : '—'} · 동시 {st.concurrency ?? '—'}
          </span>
        </div>

        {/* ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다 — 지표 열이 8개라 400px 에서 페이지를 밀어낸다. */}
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <STable>
            <thead>
              <tr>
                <th>서버</th><th>법인</th><th>경로</th>
                {COLS.map((c) => <th key={c.col} className="right">{c.label}</th>)}
                <th>수집</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} style={{ background: sel === r.key ? 'rgba(255,255,255,0.04)' : undefined }}>
                  <td data-sort={r.name}>
                    <span
                      role="button" tabIndex={0}
                      onClick={() => openDetail(r.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.key); } }}
                      style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' }}
                    >{r.name}</span>
                    {r.serviceTag && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.serviceTag}</div>}
                  </td>
                  <td data-sort={r.vcenterId || ''}>{r.vcenterId || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td data-sort={(r.paths || []).join(',')}>
                    <span style={{ fontSize: 12 }}>{(r.paths || []).map((p) => (p === 'os' ? 'OS' : 'iDRAC')).join('·') || '—'}</span>
                    {r.src && r.src !== (r.paths || []).join('+') && <div style={{ fontSize: 11, color: 'var(--muted)' }}>값 출처 {srcMark(r.src)}</div>}
                    {/* ⚠ 전부 `—` 인 행이 **왜** 비었는지 행 자체가 말해야 한다 — 긴 설명은 표 아래 각주가 한 번만 한다. */}
                    {!!(r.missing || []).length && (
                      <div style={{ fontSize: 11, color: toneVar('warn') }}>{missingMark(r.missing)}</div>
                    )}
                  </td>
                  {COLS.map((c) => (
                    <td key={c.col} className="right" data-sort={r[c.col] ?? -1}><Cell v={r[c.col]} kind={c.kind} /></td>
                  ))}
                  <td data-sort={r.ts || 0}>{r.ts ? ageText(r.ts) : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {!shown.length && <p style={{ fontSize: 12, color: 'var(--muted)' }}>표시할 서버가 없습니다.</p>}
        {missingFootnotes(rows).map((f, i) => (
          <p key={i} style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={f} /></p>
        ))}
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'`—` 는 **못 읽은 것**이고 0% 가 아닙니다. 디스크·네트워크·HBA 의 값은 그 서버에서 **가장 높은 장치·회선** 기준입니다(평균을 쓰면 한 디스크가 가득 찬 서버가 낮게 보입니다).'.replace(/`/g, '')} />
        </p>
      </div>

      {msg && (
        <div className="card" style={{ borderLeft: `3px solid ${toneVar(msg.tone)}`, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}><BoldText text={msg.text} /></p>
        </div>
      )}

      {!!skNotes.length && (
        <div className="card" style={{ minWidth: 0 }}>
          <button onClick={() => setShowSkipped((v) => !v)} style={{ background: 'transparent', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', fontSize: 13 }}>
            {showSkipped ? '▾' : '▸'} 대상이 아닌 서버 {data?.counts?.skipped ?? 0}대 — 사유별
          </button>
          {showSkipped && skNotes.map((s, i) => (
            <p key={i} style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6 }}><BoldText text={s} /></p>
          ))}
        </div>
      )}

      {showSettings && form && (
        <div className="card" style={{ minWidth: 0 }}>
          <h4 style={{ marginTop: 0 }}>수집 설정</h4>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} disabled={saving} />
            {' '}수집 켜기
          </label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'**법인을 하나씩 켜세요** — 한꺼번에 켜면 주기마다 SSH·Redfish 세션이 수백 개 열립니다. 회선·장비 부하를 보면서 늘리는 것이 이 설정의 목적입니다.'} />
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 6, marginBottom: 10 }}>
            {(data?.vcenters || []).map((v) => (
              <label key={v.id} style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <input
                  type="checkbox" disabled={saving}
                  checked={!!(form.corps || {})[v.id]}
                  onChange={(e) => saveSettings({ corps: { ...(form.corps || {}), [v.id]: e.target.checked } })}
                />
                {' '}{v.name}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12 }}>주기(분){' '}
              <input type="number" min={1} max={360} defaultValue={Math.round((form.intervalMs || 0) / 60000)} disabled={saving}
                onBlur={(e) => saveSettings({ intervalMs: Number(e.target.value) * 60000 })} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>원시 보존(일){' '}
              <input type="number" min={7} max={365} defaultValue={form.rawRetentionDays} disabled={saving}
                onBlur={(e) => saveSettings({ rawRetentionDays: Number(e.target.value) })} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>롤업 보존(일){' '}
              <input type="number" min={30} max={3650} defaultValue={form.dailyRetentionDays} disabled={saving}
                onBlur={(e) => saveSettings({ dailyRetentionDays: Number(e.target.value) })} style={{ width: 80, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.osSsh} onChange={(e) => saveSettings({ osSsh: e.target.checked })} disabled={saving} /> OS SSH
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.idracTelemetry} onChange={(e) => saveSettings({ idracTelemetry: e.target.checked })} disabled={saving} /> iDRAC 텔레메트리
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.includeUnassigned} onChange={(e) => saveSettings({ includeUnassigned: e.target.checked })} disabled={saving} /> 법인 귀속 없는 서버도 포함
            </label>
          </div>
        </div>
      )}

      {selRow && (
        <div className="card" style={{ minWidth: 0 }}>
          <h4 style={{ marginTop: 0 }}>
            {selRow.name}
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>
              {selRow.serviceTag || selRow.key} · {selRow.model || '모델 미상'}
              {selRow.idracHost ? ` · iDRAC ${selRow.idracHost}` : ''}
              {selRow.osHostName ? ` · OS ${selRow.osHostName}` : ''}
            </span>
          </h4>
          {detailNotes(detail?.target ? { ...detail.target, ...(selRow.detail || {}) } : (selRow.detail || {})).map((s, i) => (
            <p key={i} style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={s} /></p>
          ))}
          {detail?.rawTruncated && (
            <p style={{ margin: '0 0 6px', fontSize: 12, color: toneVar('warn'), lineHeight: 1.6 }}>
              <BoldText text={'조회 상한으로 **일부 구간이 잘렸습니다** — 더 긴 기간은 일 단위 롤업으로 보세요.'} />
            </p>
          )}
          {!detail && <p style={{ fontSize: 12, color: 'var(--muted)' }}>추이를 불러오는 중…</p>}
          {detail && !detail.raw?.length && !detail.daily?.length && (
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>저장된 추이가 없습니다 — 아직 수집되지 않았거나 이 서버의 값을 읽지 못했습니다.</p>
          )}
          {!!detail?.daily?.length && (
            <div style={{ overflowX: 'auto', minWidth: 0 }}>
              <STable>
                <thead><tr><th>날짜</th><th className="right">CPU 평균</th><th className="right">CPU 최대</th><th className="right">메모리 평균</th><th className="right">메모리 최대</th><th className="right">디스크 최대</th><th className="right">네트워크 최대</th><th className="right">HBA 최대</th><th className="right">표본</th></tr></thead>
                <tbody>
                  {detail.daily.slice(-30).reverse().map((d) => (
                    <tr key={d.day}>
                      <td data-sort={d.day}>{d.day}</td>
                      <td className="right" data-sort={d.cpu_avg ?? -1}>{pctText(d.cpu_avg)}</td>
                      <td className="right" data-sort={d.cpu_max ?? -1}>{pctText(d.cpu_max)}</td>
                      <td className="right" data-sort={d.mem_avg ?? -1}>{pctText(d.mem_avg)}</td>
                      <td className="right" data-sort={d.mem_max ?? -1}>{pctText(d.mem_max)}</td>
                      <td className="right" data-sort={d.disk_busy_max ?? -1}>{pctText(d.disk_busy_max)}</td>
                      <td className="right" data-sort={d.net_max ?? -1}>{pctText(d.net_max)}</td>
                      <td className="right" data-sort={d.hba_max ?? -1}>{pctText(d.hba_max)}</td>
                      <td className="right" data-sort={d.samples ?? 0}>{d.samples ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BmUsage;
