/**
 * 랙 실장도 › 가림 집계(조회 · 쓰기 전체 범위 관리자 · 읽기 전용) — 설계 docs/design/rack-mask-redesign ⑤.
 *   조회 계정에 가려져 보이는 글이 원장에 얼마나 있는지, 검사의 폭을 넓히면 얼마나 더 걸리는지를 센다(다음 단계의 폭을 수치로 정하려고).
 * 무거운 집계라 폴링하지 않는다 — 열 때 1회 + '다시 세기'. 늦게 온 이전 응답은 버린다(요청 순번). 판정은 `rackView.js censusRows`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { CENSUS_FIELD_LABEL, censusRows, censusHitsText, SEEN_KIND_LABEL, seenKeyOf, forgetItemsOf, seenCapText } from './rackView.js';

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
                      {/* 표 칸은 전역 규칙으로 줄을 바꾸지 않는다(styles.css tbody td) — 긴 글은 이 칸에서만 줄바꿈해 '걸린 종류' 가 밀려나지 않게(6회차 화면 D4) */}
                      <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 160 }}>{x.where || '—'}</td>
                      <td style={{ ...mono, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 200 }}>{x.text}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{censusHitsText(x.hits)}</td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            ) : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>걸린 글이 없습니다.</div>}
            <SeenRecords material={data.material} onChanged={load} />
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * 가림 재료 기록 관리 — 기록 크기 · 지금 등록부에 없는 기록(지울 후보) · 고른 값 지우기(감사 로그가 남는다).
 * 잘못 들어간 값(등록부 host 칸의 오타 · 모델 번호를 태그로 적은 것)은 등록부를 고쳐도 기록에 남아 이름을 계속 가린다 — 여기서 지운다(6회차 반증 R1).
 * 지운 값은 다시 가리지 않는다(그 값이 든 이름이 조회 계정에 원문으로 보인다) — 확인을 받는다. 목록은 누를 때 한 번(폴링 없음) · 늦게 온 응답은 버린다.
 */
function SeenRecords({ material, onChanged }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [msg, setMsg] = useState('');
  const seq = useRef(0);
  const cap = seenCapText(material);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true); setMsg('');
    try { const r = await fetchJson('/tools/rack/mask-seen'); if (my === seq.current) { setList(r); setErr(null); setSel(new Set()); } }
    catch (e) { if (my === seq.current) setErr(e); }
    finally { if (my === seq.current) setBusy(false); }
  }, []);
  useEffect(() => () => { seq.current += 1; }, []);
  const items = forgetItemsOf(list?.stale, sel);
  const forget = async () => {
    if (!items.length) return;
    if (!window.confirm(`고른 ${items.length}건을 가림 재료 기록에서 지울까요? 그 값이 든 이름은 조회 계정에 다시 원문으로 보입니다(감사 로그에 남습니다).`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await postJson('/tools/rack/op', { op: 'mask.forget', items });
      setMsg(`${(r.removed ?? 0).toLocaleString()}건을 지웠습니다${r.skippedCurrent ? ` · 지금 등록부에 있는 ${r.skippedCurrent.toLocaleString()}건은 건너뛰었습니다` : ''}.`);
      await load(); onChanged?.();
    } catch (e) { setErr(e); setBusy(false); }
  };
  const toggle = (k) => setSel((s0) => { const s1 = new Set(s0); if (s1.has(k)) s1.delete(k); else s1.add(k); return s1; });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>가림 재료 기록</strong>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: cap?.warn ? '#fcd34d' : 'var(--text-dim)' }}>{cap ? cap.text : '—'}{cap?.warn ? ' — 상한에 가깝습니다. 지금 등록부에 없는 기록을 정리하세요.' : ''}</span>
        <button type="button" style={{ ...btn, minWidth: 168, opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }} disabled={busy} onClick={load}>{busy && !list ? '불러오는 중…' : '지금 등록부에 없는 기록 보기'}</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        한 번 본 관리 주소 · 서비스 태그는 서버가 등록부에서 사라져도 기록에 남아 이름을 계속 가립니다. 잘못 들어간 값만 골라 지우세요.
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {msg ? <div role="status" style={{ fontSize: 12 }}>{msg}</div> : null}
      {list ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12 }}>지금 등록부에 없는 기록 {num(list.staleTotal ?? null)}건{list.staleTotal > (list.stale || []).length ? ` — 오래된 순으로 앞 ${num((list.stale || []).length)}건만 보입니다` : ''}</span>
            <button type="button" style={{ ...btn, opacity: busy || !(list.stale || []).length ? 0.5 : 1 }} disabled={busy || !(list.stale || []).length} onClick={() => setSel(new Set((list.stale || []).map(seenKeyOf)))}>보이는 것 모두 고르기</button>
            <button type="button" style={{ ...btn, borderColor: items.length ? 'var(--red)' : 'var(--border)', opacity: busy || !items.length ? 0.5 : 1, cursor: busy || !items.length ? 'not-allowed' : 'pointer' }} disabled={busy || !items.length} onClick={forget}>고른 {items.length.toLocaleString()}건 지우기</button>
          </div>
          {(list.stale || []).length ? (
            <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
              <STable minWidth={560} style={{ width: '100%', fontSize: 12 }}>
                <thead><tr><th data-nosort="1" style={{ width: 36 }} /><th style={th}>종류</th><th style={th}>값</th><th style={th}>처음 본 때</th></tr></thead>
                <tbody>{list.stale.map((x) => {
                  const k = seenKeyOf(x);
                  return (
                    <tr key={k}>
                      <td><input type="checkbox" aria-label={`${SEEN_KIND_LABEL[x.kind] || x.kind} ${x.key} 고르기`} checked={sel.has(k)} onChange={() => toggle(k)} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{SEEN_KIND_LABEL[x.kind] || x.kind}</td>
                      <td style={{ ...mono, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 220 }}>{x.key}</td>
                      <td style={{ whiteSpace: 'nowrap' }} data-sort={x.firstSeen || ''}>{x.firstSeen ? new Date(x.firstSeen).toLocaleString() : '—'}{x.pending ? ' · 파일에 쓰는 중' : ''}</td>
                    </tr>
                  );
                })}</tbody>
              </STable>
            </div>
          ) : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>지울 후보가 없습니다 — 기록이 모두 지금 등록부에 있습니다.</div>}
        </>
      ) : null}
    </div>
  );
}
