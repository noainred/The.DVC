/**
 * 랙 실장도 › 가림 집계(조회 · 쓰기 전체 범위 관리자 · 읽기 전용) — 설계 docs/design/rack-mask-redesign ⑤.
 *   조회 계정에 가려져 보이는 글이 원장에 얼마나 있는지, 검사의 폭을 넓히면 얼마나 더 걸리는지를 센다(다음 단계의 폭을 수치로 정하려고).
 * 무거운 집계라 폴링하지 않는다 — 열 때 1회 + '다시 세기'. 늦게 온 이전 응답은 버린다(요청 순번). 판정은 `rackView.js censusRows`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { CENSUS_FIELD_LABEL, censusRows, censusHitsText } from './rackView.js';

const btn = { height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };
const tile = { flex: '1 1 170px', minWidth: 0, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' };
const num = (v) => (v == null ? '—' : v.toLocaleString());
const th = { textAlign: 'left' };
const thN = { textAlign: 'right' };
const tdN = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const mono = { fontFamily: 'var(--mono)' };

function Tile({ k, n, s, warn }) {
  return (
    <div style={{ ...tile, borderColor: warn ? '#b45309' : 'var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>{k}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2, color: warn ? '#fcd34d' : 'var(--text)' }}>{n}</div>
      {s ? <div style={{ fontSize: 11, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{s}</div> : null}
    </div>
  );
}

export default function RackMaskCensus({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    try { const r = await fetchJson('/tools/rack/mask-census'); if (my === seq.current) { setData(r); setErr(null); } }
    catch (e) { if (my === seq.current) setErr(e); }
    finally { if (my === seq.current) setBusy(false); }
  }, []);
  useEffect(() => { load(); return () => { seq.current += 1; }; }, [load]);
  const c = data ? censusRows(data) : null;
  const corpName = new Map((data?.corps || []).map((x) => [x.id, x.name]));
  return (
    <Modal title="가림 집계 — 조회 계정에 보이는 글" onClose={onClose} width={1040}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            원장의 글(표시 이름 · 모델 · 랙 · 전산실 · 데이터센터 이름) 가운데 조회 계정에 <strong>가려져 보이는</strong> 글을 셉니다. 원장은 바꾸지 않습니다.
            {data?.at ? ` 센 때 ${new Date(data.at).toLocaleString()} · 법인 ${(data.corps || []).length}곳.` : ''}
          </span>
          <button type="button" style={{ ...btn, minWidth: 96, opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }} disabled={busy} onClick={load}>{busy ? '세는 중…' : '다시 세기'}</button>
        </div>
        {err ? <ErrorBox error={err} /> : null}
        {!data && !err ? <Loading label="가림 집계" /> : null}
        {c ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <Tile k="서로 다른 글" n={num(c.sum.total)} s="법인 · 칸 · 글이 같은 것은 한 번" />
              <Tile k="지금 가려져 보이는 글" n={num(c.hidden)} warn={!!c.hidden} s={`주소 ${num(c.sum.addr)} · 태그 · 시리얼 ${num(c.sum.tag)}(범위 계정에만)`} />
              <Tile k="폭을 넓히면 더 걸릴 글" n={num(c.wider)} s={`등록 주소의 첫 마디 ${num(c.sum.firstLabel)} · 구분자를 바꾼 IP ${num(c.sum.altIp)}`} />
              <Tile k="메모가 있는 장비" n={num(c.notes)} s="메모는 조회 계정에 싣지 않습니다" />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={760} style={{ width: '100%', fontSize: 12 }}>
                <thead><tr>
                  <th style={th}>칸</th><th style={thN}>글 수</th><th style={thN}>주소</th><th style={thN}>태그 · 시리얼</th>
                  <th style={thN}>넓히면: 등록 주소의 첫 마디</th><th style={thN}>넓히면: 구분자를 바꾼 IP</th>
                </tr></thead>
                <tbody>{c.rows.map((r) => (
                  <tr key={r.field}>
                    <td>{r.label}</td>
                    {['total', 'addr', 'tag', 'firstLabel', 'altIp'].map((k) => <td key={k} style={tdN} data-sort={r[k] == null ? '' : r[k]}>{num(r[k])}</td>)}
                  </tr>
                ))}</tbody>
              </STable>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
              ‘주소’ 는 조회 계정 모두에게, ‘태그 · 시리얼’ 은 범위 계정에게만 가려져 보입니다. ‘넓히면’ 두 칸의 글은 <strong>지금은 그대로 보입니다</strong> —
              등록 주소의 첫 마디(예: 등록 주소가 ‘idrac-a1.mgmt.example’ 일 때 ‘idrac-a1’)나 구분자를 바꿔 적은 IP 를 식별 정보로 볼지 정하는 데 쓰는 수입니다.
            </div>
            <strong style={{ fontSize: 13 }}>걸린 글 {num((data.samples || []).length)}건{data.sampleOmitted ? ` (${num(data.sampleOmitted)}건 더 있음 — 앞의 것만 보입니다)` : ''}</strong>
            {(data.samples || []).length ? (
              <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
                <STable minWidth={860} style={{ width: '100%', fontSize: 12 }}>
                  <thead><tr><th style={th}>법인</th><th style={th}>칸</th><th style={th}>위치</th><th style={th}>글</th><th style={th}>걸린 종류</th></tr></thead>
                  <tbody>{data.samples.map((x, i) => (
                    <tr key={`${x.corpId}-${x.field}-${i}`}>
                      <td>{corpName.get(x.corpId) || x.corpId}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{CENSUS_FIELD_LABEL[x.field] || x.field}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{x.where || '—'}</td>
                      <td style={{ ...mono, overflowWrap: 'anywhere' }}>{x.text}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{censusHitsText(x.hits)}</td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            ) : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>걸린 글이 없습니다.</div>}
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>가림 재료 — 본 적 있는 주소 {num(data.material?.hosts ?? null)} · 태그 {num(data.material?.tags ?? null)}(원장 옆에 남겨 두며 줄지 않습니다).</div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
