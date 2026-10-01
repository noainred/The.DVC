/**
 * PowerTotal.jsx — 특수 기능 › 전체 소비 전력(v2.664). 사용자 요청 "특수기능에 전체 소비 전력 카드를 만들고
 *   서버/네트워크/스토리지 전력 사용량 취합". 합산은 서버 `power/total.js`(Overview 카드와 같은 함수)가 한다.
 * 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { STable } from '../../components/STable.jsx';
import { kwText, kwOrDash, wText, powerCatNote, powerCatKw, powerTotalKw, POWER_FOOTNOTE, countText, storagePowerReasonText, reasonCountsText } from '../overviewCardsText.js';
import { errorBoxInput } from '../../components/accessDeniedText.js';

/** v2.680 D-05: 갱신 실패 배너 문구 — 오류 객체를 그대로 그리지 않는다(React #31 — v2.621 WEB-01). */
export function refreshErrText(e) {
  const v = errorBoxInput(e);
  if (v.perm) return `권한이 없습니다 — ${v.text}`;
  return v.text || '알 수 없는 오류';
}

const CATS = [['servers', '🖥 서버', '#3b82f6'], ['network', '🔀 네트워크', '#22c55e'], ['storage', '🗄 스토리지', '#a855f7']];

export default function PowerTotal() {
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [tick, setTick] = useState(0);
  const [tab, setTab] = useState('servers');
  useEffect(() => {
    let alive = true; setErr(null);
    fetchJson('/tools/power-total').then((r) => { if (alive) setD(r); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [tick]);
  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="전체 소비 전력" />;
  const total = d.totalWatts || 0;
  const cat = d[tab];
  const corpName = (id) => (id ? (d.byCorp.find((c) => c.corpId === id)?.corpName || id) : '(법인 미지정)');
  return (
    <div className="power-total">
      <div className="kpis" style={{ marginBottom: 12 }}>
        <div className="card kpi" style={{ '--kpi-accent': 'var(--amber)' }}>
          <div className="label">전체 소비 전력</div>
          <div className="value" style={{ color: 'var(--amber)' }}>{powerTotalKw(d)}</div>
          <div className="meta">서버 + 네트워크 + 스토리지(읽은 장비만)</div>
        </div>
        {CATS.map(([k, label, color]) => {
          const x = d[k];
          const share = total > 0 ? Math.round((x.watts / total) * 1000) / 10 : null;
          return (
            <div key={k} className="card kpi kpi-click" role="button" tabIndex={0} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}
              style={{ '--kpi-accent': color, outline: tab === k ? `1px solid ${color}` : undefined }}>
              <div className="label">{label}</div>
              <div className="value" style={{ color }}>{powerCatKw(x)}{share != null && powerCatKw(x) !== '—' && <small> {share}%</small>}</div>
              <div className="meta">{powerCatNote(k, x)}</div>
            </div>
          );
        })}
      </div>
      {total > 0 && (
        <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', marginBottom: 14, background: 'var(--border)' }} aria-label="전력 비중">
          {CATS.map(([k, label, color]) => (d[k].watts > 0 ? <span key={k} title={`${label} ${kwText(d[k].watts)}`} style={{ width: `${(d[k].watts / total) * 100}%`, background: color }} /> : null))}
        </div>
      )}
      {err && <div className="banner" style={{ marginBottom: 10 }}>갱신 실패(직전 데이터 표시 중): {refreshErrText(err)}</div>}
      {d.addressHidden && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>주소로 등록된 서버의 이름·식별자는 관리자에게만 보입니다(가림 표시).</div>}
      {Object.keys(d.errors || {}).length > 0 && <div className="banner" style={{ marginBottom: 10 }}>일부를 읽지 못했습니다: {Object.entries(d.errors).map(([k, v]) => `${k} — ${v}`).join(' · ')}</div>}

      <div className="card" style={{ padding: '14px 16px', marginBottom: 12, minWidth: 0 }}>
        <div className="flex wrap" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <b>법인별 소비 전력</b>
          <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0, marginLeft: 'auto' }} onClick={() => setTick((t) => t + 1)}>↻ 새로고침</button>
        </div>
        <STable minWidth={640}>
          <thead><tr><th>법인</th><th className="right">서버</th><th className="right">네트워크</th><th className="right">스토리지</th><th className="right">합계</th><th className="right">장비</th></tr></thead>
          <tbody>
            {d.byCorp.map((c) => (
              <tr key={c.corpId || '_'}>
                <td>{c.corpId ? c.corpName : '(법인 미지정)'}</td>
                <td className="right" data-sort={c.servers}>{kwOrDash(c.servers)}</td>
                <td className="right" data-sort={c.network}>{kwOrDash(c.network)}</td>
                <td className="right" data-sort={c.storage}>{kwOrDash(c.storage)}</td>
                <td className="right" data-sort={c.total}><b>{kwText(c.total)}</b></td>
                <td className="right">{countText(c.devices)}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        {!d.byCorp.length && <div className="muted" style={{ padding: 10 }}>측정된 장비가 없습니다.</div>}
      </div>

      <div className="card" style={{ padding: '14px 16px', minWidth: 0 }}>
        <div className="flex wrap" style={{ gap: 6, marginBottom: 8 }} role="group" aria-label="장비 종류">
          {CATS.map(([k, label]) => <button key={k} type="button" className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px', marginTop: 0 }} onClick={() => setTab(k)}>{label} {countText(d[k].measured)}</button>)}
        </div>
        <STable minWidth={640}>
          <thead><tr><th>장비</th><th>법인</th>{tab === 'network' && <th>모델</th>}{tab === 'storage' && <th>타입</th>}<th className="right">소비 전력</th>{tab === 'network' && <th>기준</th>}{tab === 'servers' && <th>출처</th>}</tr></thead>
          <tbody>
            {cat.items.map((x) => (
              <tr key={x.id}>
                <td>{x.name}</td>
                <td>{corpName(x.corpId)}</td>
                {tab === 'network' && <td>{x.model || '—'}</td>}
                {tab === 'storage' && <td title={x.source || ''}>{x.type}{x.scope === 'dpe' ? ' · DPE 만' : x.scope === 'node' ? ' · 노드 합' : x.scope === 'psu' ? ' · PSU 합' : ''}{x.basis === 'output' ? ' · 출력 기준' : ''}</td>}
                <td className="right" data-sort={x.watts}>{wText(x.watts)}</td>
                {tab === 'network' && <td>{x.basis === 'output' ? 'PSU 출력' : x.basis === 'mixed' ? '입력·출력 혼합' : 'PSU 입력'} · {x.partial ? `PSU ${x.read ?? '?'}/${x.psus} 만 읽음(일부)` : `PSU ${x.psus}`}</td>}
                {tab === 'servers' && <td>{x.source === 'remote' ? '엣지' : x.source === 'ome' ? 'OME' : 'iDRAC'}</td>}
              </tr>
            ))}
          </tbody>
        </STable>
        {!cat.items.length && <div className="muted" style={{ padding: 10 }}>측정된 장비가 없습니다 — {powerCatNote(tab, cat)}</div>}
        {cat.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>큰 순 {cat.items.length}대만 보였습니다 — {cat.omitted}대는 목록에서 뺐습니다(합계에는 포함).</div>}
        {tab === 'storage' && <StorageUnread cat={cat} corpName={corpName} />}
        <ul className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6, paddingLeft: 18 }}>
          {POWER_FOOTNOTE.map((t) => <li key={t}>{t}</li>)}
        </ul>
      </div>
    </div>
  );
}

/** 스토리지 — 전력을 못 읽은 장비와 사유(v2.667). 수집 경로가 없는 장비는 사유별 개수만 말한다. */
function StorageUnread({ cat, corpName }) {
  const issues = Array.isArray(cat?.issues) ? cat.issues : [];
  const unsup = reasonCountsText(cat?.unsupportedBy);
  if (!issues.length && !unsup) return null;
  return (
    <div style={{ marginTop: 14, minWidth: 0 }}>
      <b style={{ fontSize: 13 }}>전력을 합계에 넣지 못한 장비</b>
      {cat.unreadBy && Object.keys(cat.unreadBy).length > 0 && <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>못 읽음 — {reasonCountsText(cat.unreadBy)}</div>}
      {unsup && <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>수집 경로 없음 — {unsup}</div>}
      {issues.length > 0 && (
        <STable minWidth={760}>
          <thead><tr><th>장비</th><th>법인</th><th>타입</th><th>사유</th><th>세부 · 응답에 있던 키</th></tr></thead>
          <tbody>
            {issues.map((x) => (
              <tr key={x.id}>
                <td>{x.name}</td>
                <td>{corpName(x.corpId)}</td>
                <td>{x.type}{x.method ? ` · ${x.method}` : ''}</td>
                <td>{storagePowerReasonText(x.reason)}</td>
                <td style={{ whiteSpace: 'normal', fontSize: 12 }}>
                  {[x.source, x.detail].filter(Boolean).join(' — ') || '—'}
                  {x.detailHidden && <span className="muted"> (오류 원문은 관리자에게만 보입니다)</span>}
                  {Array.isArray(x.seenKeys) && x.seenKeys.length > 0 && <div className="muted" style={{ overflowWrap: 'anywhere' }}>키: {x.seenKeys.join(', ')}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
      {cat.issuesOmitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{cat.issuesOmitted}대는 목록 상한으로 뺐습니다(개수에는 포함).</div>}
    </div>
  );
}
