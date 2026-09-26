import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, downloadFile } from '../../api.js';
import { takeSearch, onSearchHandoff } from '../../hooks/searchHandoff.js'; // v2.616 V5 통합 검색 · v2.617 열린 화면도 받는다
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { addressHiddenNote } from './addressHiddenText.js'; // v2.600 AUTHZ-2600-01
import { downloadFailText } from '../downloadFailText.js';

/**
 * 특수기능 › 시리얼 조회(v2.412, 사용자 요구 '서버·스토리지·네트워크·SAN switch 등 등록되고
 * 수집된 모든 장비에서 시리얼 번호 조회').
 *
 * 시리얼은 포탈의 여러 저장소에 흩어져 있다 — iDRAC 인벤토리(섀시 + PSU·디스크·DIMM·NIC),
 * OME, vCenter 호스트 하드웨어, 스토리지 어레이, SAN 스위치(섀시·PSU·SFP), 엣지 베어메탈.
 * 벤더 RMA 나 자산 대조 때 "이 시리얼이 어느 장비인가"를 한 번에 찾기 위한 화면이다.
 *
 * ⚠ 새로 수집하지 않는다 — **이미 수집된 값만** 모은다. 그래서 아직 수집 안 된 장비는 나오지
 *   않으며, 그 사실이 '수집 현황'에 종류별 0 으로 그대로 드러난다(빈 결과의 이유를 숨기지 않는다).
 */
export default function SerialLookup() {
  const [q, setQ] = useState(() => takeSearch('serial-lookup')); // v2.616: V5 통합 검색이 넘긴 검색어(없으면 '')
  // v2.617: 이미 열린 화면이면 다시 마운트되지 않는다 — 구독으로 즉시 받는다.
  useEffect(() => onSearchHandoff((t) => {
    if (t !== 'serial-lookup') return;
    const s = takeSearch('serial-lookup');
    if (s) setQ(s);
  }), []);
  const [kinds, setKinds] = useState(() => new Set());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exportErr, setExportErr] = useState(''); // v2.618(WEB-1): 내보내기 실패는 따로 — 예전엔 setError 만 하고 아무 데도 안 보였다
  const [failedQ, setFailedQ] = useState(null);   // v2.618(WEB-1): 실패한 검색어 — 아래 표가 직전 검색 결과임을 밝힌다

  const kindParam = useMemo(() => [...kinds].join(','), [kinds]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    fetchJson('/tools/serial-lookup', { q: q.trim(), kinds: kindParam })
      .then((d) => { if (alive) { setData(d); setError(null); setFailedQ(null); } })
      .catch((e) => { if (alive) { setError(e.message); setFailedQ(q.trim()); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [q, kindParam]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const toggleKind = (k) => setKinds((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const rows = data.rows || [];
  const kindLabel = new Map((data.kinds || []).map((k) => [k.key, k.label]));

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🔎 시리얼 조회</div>

      <div className="card" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
        등록·수집된 모든 장비의 시리얼 번호를 한 번에 찾습니다 — 서버(iDRAC) 섀시와 부품(PSU·디스크·메모리·NIC),
        OME 장비, ESXi 호스트, 스토리지 어레이, SAN 스위치(섀시·PSU·SFP), 엣지 베어메탈.
        <div className="muted" style={{ marginTop: 6 }}>
          • 대소문자와 <code>:</code> <code>-</code> 공백을 무시하고 <b>부분 일치</b>로 찾습니다 —
            자산대장에서 <code>1000000517</code> 로 적어 둔 값이 <code>10:00:00:05:17</code> 에도 걸립니다.<br />
          • <b>새로 수집하지 않습니다.</b> 이미 수집된 값만 모으므로, 아직 수집 전인 장비는 나오지 않습니다
            (아래 '수집 현황'에서 종류별 개수를 확인하세요).<br />
          • 한 장비가 서비스 태그·시리얼·자산 태그로 여러 줄에 나올 수 있습니다.
        </div>
      </div>

      {addressHiddenNote(data) && (
        <div className="card" style={{ marginBottom: 12, fontSize: 12.5, borderLeft: '3px solid var(--border)' }}>
          🔒 <BoldText text={addressHiddenNote(data)} />
        </div>
      )}

      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <SearchBox className="input" style={{ maxWidth: 420, minWidth: 260, fontSize: 15 }}
          value={q} onChange={setQ} placeholder="시리얼 / 서비스 태그 / WWN / 부품번호 입력" />
        {busy && <span className="muted" style={{ fontSize: 12 }}>찾는 중…</span>}
        <button className="tab" style={{ marginLeft: 'auto', flex: 'none', padding: '6px 12px' }}
          onClick={() => { setExportErr(''); downloadFile(`/tools/serial-lookup/export.csv?q=${encodeURIComponent(q.trim())}&kinds=${encodeURIComponent(kindParam)}`).catch((e) => setExportErr(downloadFailText(e))); }}
          title="현재 검색 결과(검색어가 없으면 선택한 종류 전체)를 CSV 로 내려받습니다.">⬇ CSV 내보내기</button>
      </div>

      {exportErr && <div className="banner" style={{ marginBottom: 10, color: '#f87171' }}>CSV 내보내기 실패 — {exportErr}</div>}
      {error && data && (
        <div className="banner" style={{ marginBottom: 10, color: '#fbbf24' }}>
          검색에 실패했습니다({error}){failedQ != null ? ` — ‘${failedQ}’ 결과가 아닙니다.` : ''} 아래는 직전에 성공한 검색 결과입니다.
        </div>
      )}

      {/* 종류 필터 + 수집 현황 — 개수가 0 이면 왜 결과가 없는지가 바로 보인다. */}
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        {(data.kinds || []).map((k) => {
          const n = data.counts?.[k.key] || 0;
          const on = kinds.has(k.key);
          const err = data.sources?.[k.key]?.error;
          return (
            <button key={k.key} className={`qn-btn${on ? ' on' : ''}${n === 0 ? ' down' : ''}`} aria-pressed={on}
              onClick={() => toggleKind(k.key)}
              title={err ? `이 출처를 읽지 못했습니다: ${err}` : `${k.label} — 수집된 시리얼 ${n}건${n === 0 ? '\n(아직 수집 전이거나 이 장비 종류는 시리얼을 제공하지 않습니다)' : ''}`}>
              {k.icon} {k.label}<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{n}</span>
              {err ? ' ⚠' : ''}
            </button>
          );
        })}
        {kinds.size > 0 && <button className="qn-btn" onClick={() => setKinds(new Set())}>✕ 종류 필터 해제</button>}
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        수집된 시리얼 <b style={{ color: 'var(--text)' }}>{(data.total || 0).toLocaleString()}</b>건
        (고유 {(data.uniqueSerials || 0).toLocaleString()}개)
        {q.trim() ? <> · 검색 결과 <b style={{ color: 'var(--text)' }}>{(data.matched || 0).toLocaleString()}</b>건
          {data.truncated ? ' (상위 500건만 표시 — 검색어를 더 좁히거나 CSV 로 내려받으세요)' : ''}</> : ' · 검색어를 입력하세요'}
      </div>

      {q.trim() && !rows.length && !busy && !(error && failedQ === q.trim()) && ( /* v2.618: 실패한 검색을 '결과 없음' 이라 말하지 않는다 */
        <div className="card muted" style={{ fontSize: 13 }}>
          <b>'{q.trim()}'</b> 에 해당하는 시리얼이 없습니다.
          <div style={{ marginTop: 4 }}>일부만 입력해도 찾습니다. 그래도 없다면 그 장비가 아직 수집되지 않았을 수 있습니다 — 위 종류별 개수를 확인하세요.</div>
        </div>
      )}

      {!!rows.length && (
        <div className="table-wrap">
          <STable>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>시리얼</th><th>항목</th><th>장비 종류</th>
                <th style={{ minWidth: 160 }}>장비</th><th>모델</th><th>부품</th><th>법인/vCenter</th><th>수집</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.kind}-${r.deviceId}-${r.serial}-${i}`}>
                  <td><b style={{ fontFamily: 'ui-monospace, monospace' }}>{r.serial}</b></td>
                  <td className="muted">{r.serialType}</td>
                  <td>{kindLabel.get(r.kind) || r.kind}</td>
                  <td>
                    {r.deviceName || '—'}
                    {(r.hostname && r.hostname !== r.deviceName) || r.host
                      ? <div className="muted" style={{ fontSize: 11 }}>
                          {r.hostname && r.hostname !== r.deviceName ? `${r.hostname} · ` : ''}{r.host || ''}
                        </div>
                      : null}
                  </td>
                  <td className="muted">{[r.vendor, r.model].filter(Boolean).join(' ') || '—'}</td>
                  <td className="muted">
                    {r.part ? <>{r.part}{r.partLocation ? ` (${r.partLocation})` : ''}
                      {r.partModel ? <div style={{ fontSize: 11 }}>{r.partModel}</div> : null}</> : '—'}
                  </td>
                  <td className="muted">{[r.datacenterId, r.vcenterId].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="muted">{r.agent || '중앙'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
    </>
  );
}
