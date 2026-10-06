/**
 * VM 생성·삭제 이력 — 특수 기능 `vm-lifecycle`(v2.706 — C5). 생성·복제·템플릿 배포·등록·삭제·이름 변경과 누가 했는지,
 * 하루 추가/삭제 막대, 기간 안에 만들었다 지운 '단명 VM'.
 * ⚠ 판정은 서버(`server/src/vmlife/analyze.js`) — 이 화면은 조립만. 문구는 `views/vmlife/vmLifeText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다(세대 번호) · 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import { fmtTs, coverageNote, truncNote, noDetailNote } from '../vmchanges/vmChangesText.js';
import { LIFE_KIND_LABEL, LIFE_KIND_TONE, ADD_KINDS, existsText, lifeSpanText, netText, sourceText, REMOVE_NOTE } from '../vmlife/vmLifeText.js';

const DAYS = [1, 7, 30, 90];

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}

function DayBars({ series }) {
  const max = Math.max(1, ...series.map((s) => Math.max(s.added, s.removed)));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56, minWidth: 0 }} aria-label="하루 추가·삭제">
      {series.map((s) => (
        <div key={s.day} title={`${new Date(s.day).toLocaleDateString('ko-KR')} · 추가 ${s.added} · 삭제 ${s.removed}`}
          style={{ flex: '1 1 0', minWidth: 3, display: 'flex', gap: 1, alignItems: 'flex-end', height: '100%' }}>
          <div style={{ flex: 1, height: s.added ? `${Math.max(4, (s.added / max) * 100)}%` : 1, background: s.added ? 'var(--green)' : 'var(--border)' }} />
          <div style={{ flex: 1, height: s.removed ? `${Math.max(4, (s.removed / max) * 100)}%` : 1, background: s.removed ? 'var(--red)' : 'var(--border)' }} />
        </div>
      ))}
    </div>
  );
}

export default function VmLifecycleTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [days, setDays] = useState(7);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);

  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const params = { days };
      if (vcId) params.vcenterId = vcId;
      if (kind) params.kind = kind;
      if (qApplied) params.q = qApplied;
      const d = await fetchJson('/tools/vm-lifecycle', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, days, kind, qApplied]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (vcId) qs.set('vcenterId', vcId);
      await downloadFile(`/tools/vm-lifecycle.csv?${qs}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const life = data.life || {};
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const cov = coverageNote(data, Date.now(), { what: '생성·삭제', events: '생성·삭제' });
  const trunc = truncNote(data);
  const events = Array.isArray(life.events) ? life.events : [];
  const short = Array.isArray(life.shortLived) ? life.shortLived : [];

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        누가 언제 VM 을 만들고(새로 생성·복제·템플릿 배포·등록) 지웠는지, 이름을 바꿨는지를 봅니다. 원천은 이 포탈이 받아 둔 vCenter 이벤트입니다(vCenter 왕복 없음).
      </div>
      {cov && <div className="banner" style={{ marginBottom: 8 }}>{cov}</div>}
      {trunc && <div className="banner" style={{ marginBottom: 8 }}>{trunc}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div className="kpis" style={{ marginBottom: 10 }}>
        <div className="kpi"><div className="label">추가된 VM</div><div className="value">{(life.added ?? 0).toLocaleString()}</div><div className="sub">생성·복제·배포·등록</div></div>
        <div className="kpi"><div className="label">삭제·제거된 VM</div><div className="value">{(life.removed ?? 0).toLocaleString()}</div><div className="sub">인벤토리 제거 포함</div></div>
        <div className="kpi"><div className="label">순증</div><div className="value">{netText(life)}</div><div className="sub">추가 − 삭제 · 기간 {days}일</div></div>
        <div className="kpi"><div className="label">단명 VM</div><div className="value">{(life.shortLivedCount ?? 0).toLocaleString()}</div><div className="sub">기간 안에 만들고 지운 VM</div></div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>기간</span>
        {DAYS.map((d) => <Chip key={d} active={days === d} onClick={() => setDays(d)}>{d}일</Chip>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>vCenter</span>
        <select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcs.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name}</option>)}
        </select>
        <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="VM·사용자·호스트·원본 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      {Array.isArray(life.series) && life.series.length > 1 && (
        <div className="card" style={{ padding: 10, marginBottom: 8, minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            하루 추가(초록)·삭제(빨강) — 한국 날짜 · 막대에 마우스를 올리면 날짜·개수
          </div>
          <DayBars series={life.series} />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <Chip active={!kind} onClick={() => setKind('')}>전체 <b>{(life.total ?? 0).toLocaleString()}</b></Chip>
        <Chip active={kind === 'added'} onClick={() => setKind(kind === 'added' ? '' : 'added')}>추가 전체 <b>{(life.added ?? 0).toLocaleString()}</b></Chip>
        {Object.entries(LIFE_KIND_LABEL).map(([k, label]) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? '' : k)}>{label} <b>{(life.byKind?.[k] ?? 0).toLocaleString()}</b></Chip>
        ))}
      </div>

      {Array.isArray(life.users) && life.users.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>수행한 사람</span>
          {life.users.slice(0, 12).map((u) => (
            <button key={u.user} type="button" className="badge gray" style={{ cursor: 'pointer', border: 0, whiteSpace: 'nowrap' }}
              onClick={() => setQ(u.user === '(사용자 미상)' ? '' : u.user)} title="누르면 이 사용자로 검색합니다">
              {u.user} +{u.added} / −{u.removed}
            </button>
          ))}
          {life.users.length > 12 && <span className="muted" style={{ fontSize: 12 }}>외 {life.users.length - 12}명</span>}
        </div>
      )}
      {noDetailNote(life.noDetail, life.total ?? 0) && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{noDetailNote(life.noDetail, life.total ?? 0)}</div>}

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {events.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 13 }}>
            {(life.total ?? 0) === 0 ? '이 기간에 받은 생성·삭제 이벤트가 없습니다(수집 범위는 위 안내를 보세요).' : '조건에 맞는 이벤트가 없습니다.'}
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={980} wrap={false}>
            <thead><tr><th>시각</th><th>vCenter</th><th>VM</th><th>종류</th><th>사용자</th><th>호스트</th><th>데이터스토어</th><th>원본·이름</th><th>지금 인벤토리</th></tr></thead>
            <tbody>
              {events.map((e, i) => {
                const ex = existsText(e);
                return (
                  <tr key={`${e.ts}-${i}`}>
                    <td data-sort={e.ts} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(e.ts)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{e.vcenterName}</td>
                    <td style={{ minWidth: 140 }}>{e.existsNow && ADD_KINDS.includes(e.kind) ? <VmLink name={e.vm} vcenterId={e.vcenterId} /> : (e.vm || '—')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><span className={`badge ${LIFE_KIND_TONE[e.kind] || 'gray'}`}>{LIFE_KIND_LABEL[e.kind] || e.type}</span></td>
                    <td style={{ fontSize: 12 }}>{e.user || <span className="muted">미상</span>}</td>
                    <td style={{ fontSize: 12 }}>{e.host || '—'}</td>
                    <td style={{ fontSize: 12 }}>{e.ds || '—'}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{sourceText(e)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><span className={`badge ${ex.tone}`} title={ex.title}>{ex.text}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </STable></div>
        )}
      </div>
      {life.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>최신 {events.length.toLocaleString()}건만 표시했습니다 — {life.omitted.toLocaleString()}건은 검색·종류로 좁혀 보세요.</div>}

      {short.length > 0 && (
        <div className="card" style={{ padding: 0, marginTop: 10, minWidth: 0 }}>
          <div style={{ padding: '8px 12px', fontWeight: 600, fontSize: 13 }}>단명 VM — 이 기간 안에 만들고 지운 VM {life.shortLivedCount.toLocaleString()}대</div>
          <STable minWidth={640}>
            <thead><tr><th>vCenter</th><th>VM</th><th>처음 추가</th><th>삭제</th><th>수명</th></tr></thead>
            <tbody>
              {short.map((r) => (
                <tr key={`${r.vcenterId}|${r.vm}`}>
                  <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                  <td>{r.vm}</td>
                  <td data-sort={r.added} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(r.added)}</td>
                  <td data-sort={r.removed} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(r.removed)}</td>
                  <td data-sort={r.lifeMs}>{lifeSpanText(r.lifeMs)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {REMOVE_NOTE} VM 은 이벤트의 VM 이름으로 묶습니다 — 같은 vCenter 의 동명 VM 은 구분하지 못합니다. '지금 인벤토리' 도 이름으로만 대조합니다.
      </div>
    </div>
  );
}
