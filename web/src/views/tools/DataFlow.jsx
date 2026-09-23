/**
 * 데이터 흐름 지도 — 포탈 사이를 오가는 **모든 경로**를 노드 그래프로 본다(v2.587).
 *
 * 사용자 요청(2026-09-23): 엣지·수집 에이전트·iDRAC·GPU·전력 등 모든 데이터와 엣지↔포탈의 push/pull 을
 * 한 화면에 — 노드 그래프 영상(가운데 버스 · 좌우 노드 · 하단 로그/분배/집계 패널) 형태로. 선택:
 * 엣지 내부 수집 상태는 **누를 때만 가져오기**, 화면은 **새로**(통신 지도 확장 아님), 시안은 클로드 디자인.
 *
 * 설계:
 *  · 데이터는 `/tools/data-flow` 하나(15초 폴링, 서버 memoJson 12초). 경로 목록은 서버가 **실제 라우터 선언**에서 읽는다.
 *  · 배치는 `dataFlowLayout.js`, 문구는 `dataFlowText.js`(순수) — 이 파일은 조립만 한다.
 *  · 기록 없는 연결은 **그리지 않는다**(정상으로 칠하지 않는다). 회색 눈금 = 기록이 없는 경로.
 *  · 그래프는 고정폭(약 1370px)이고 좁은 화면에서는 **그 상자만** 가로로 스크롤한다(페이지는 밀리지 않는다).
 *  · 엣지 내부 수집은 `POST /tools/edge-log/fetch`(v2.549) 재사용 — 28곳에 상시로 나가지 않는다.
 */
import React, { useMemo, useState } from 'react';
import { usePolling, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { layoutDataFlow, W, BUS_X, BUS_W } from './dataFlowLayout.js';
import {
  STATE_LABEL, STATE_COLOR, STATE_DOT, KIND_LABEL, KIND_SHORT, CAT_COLOR, TONE_HEAD,
  routePath, sinceNote, linkText, edgeBadge, edgeLasts, innerItemText, legendLines, ageText, spanText, bytesText,
} from './dataFlowText.js';
import { fetchResultText, statusSummary, groupStatus } from './edgeLogText.js';

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const PANEL = { background: '#13161c', border: '1px solid #1f242e', borderRadius: 6, padding: '10px 12px', minWidth: 0 };
const CAP = { fontFamily: MONO, fontSize: 10, color: '#6b7384', letterSpacing: '0.08em', marginBottom: 6 };
const TONE_TEXT = { ok: '#aab1bf', bad: '#f08a8d', warn: '#e0a43a', muted: '#8a93a6' };

function Dot({ state, dashed }) {
  return <i aria-hidden="true" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 4, boxSizing: 'border-box',
    background: dashed ? 'transparent' : STATE_DOT[state], border: dashed ? '1px dashed #5b6272' : 'none' }} />;
}

function Bar({ ok = 0, stale = 0, fail = 0, total = 0, h = 6 }) {
  const n = Math.max(total, ok + stale + fail, 1);
  const w = (v) => `${(v / n) * 100}%`;
  return (
    <div style={{ height: h, background: '#232833', borderRadius: 2, overflow: 'hidden', display: 'flex', flexGrow: 1, minWidth: 0 }}>
      <span style={{ width: w(ok), background: STATE_DOT.ok }} /><span style={{ width: w(stale), background: STATE_DOT.stale }} /><span style={{ width: w(fail), background: STATE_DOT.fail }} />
    </div>
  );
}

export default function DataFlow() {
  const { data, error } = usePolling('/tools/data-flow', {}, 15_000);
  const [sel, setSel] = useState(null);
  const [inner, setInner] = useState({}); // edgeId → { busy, res }
  const lay = useMemo(() => (data ? layoutDataFlow(data, sel) : null), [data, sel]);
  const routesById = useMemo(() => new Map((data?.routes || []).map((r) => [r.id, r])), [data]);
  const edgesById = useMemo(() => new Map((data?.edges || []).map((e) => [e.id, e])), [data]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data || !lay) return <Loading />;
  const now = Date.now();
  const toggle = (type, id) => setSel((s) => (s && s.type === type && s.id === id ? null : { type, id }));
  const selEdge = sel?.type === 'edge' ? edgesById.get(sel.id) : null;
  const selCat = sel?.type === 'cat' ? (data.cats || []).find((c) => c.id === sel.id) : null;
  const tot = data.totals || {};

  async function fetchInner(e) {
    setInner((m) => ({ ...m, [e.id]: { busy: true } }));
    try {
      const res = await postJson('/tools/edge-log/fetch', { agent: e.id, limit: 0, withStatus: true });
      setInner((m) => ({ ...m, [e.id]: { busy: false, res } }));
    } catch (err) {
      setInner((m) => ({ ...m, [e.id]: { busy: false, res: { ok: false, kind: 'error', reason: String(err?.message || err) } } }));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {error && <div className="banner warn">최근 조회가 실패했습니다 — 아래는 직전 값입니다. ({String(error.message || error)})</div>}

      <div style={{ ...PANEL, display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center', fontFamily: MONO, fontSize: 11, color: '#8a93a6' }}>
        <span style={{ color: '#d7dbe3', fontWeight: 600 }}>데이터 흐름 지도</span>
        <span>경로 <b style={{ color: '#d7dbe3' }}>{tot.routes}</b></span>
        <span>데이터 종류 <b style={{ color: '#d7dbe3' }}>{(data.cats || []).length}</b></span>
        <span>엣지 <b style={{ color: '#d7dbe3' }}>{(data.edges || []).length}</b></span>
        <span>관측된 연결 <b style={{ color: '#d7dbe3' }}>{tot.links}</b></span>
        <span>기록 없는 경로 <b style={{ color: '#d7dbe3' }}>{tot.routesNone}</b></span>
        <span>선택 <b style={{ color: '#e0a43a' }}>{selEdge ? selEdge.name : selCat ? selCat.label : '없음'}</b></span>
        <span style={{ flexGrow: 1 }} />
        <span>조회 {ageText(data.generatedAt, now)}</span>
      </div>
      <div style={{ fontSize: 12.5, color: '#aab1bf', lineHeight: 1.6 }}><BoldText text={sinceNote(data, now)} /></div>
      {data.sourceErrors?.length > 0 && <div className="banner warn">원천을 읽지 못했습니다: {data.sourceErrors.map((s) => `${s.source} — ${s.error}`).join(' · ')}</div>}

      <div style={{ overflowX: 'auto', background: '#0d0f13', border: '1px solid #1f242e', borderRadius: 6 }}>
        <div style={{ position: 'relative', width: W + 24, height: lay.height, padding: '0 12px' }}>
          <svg width={W} height={lay.height} style={{ position: 'absolute', left: 12, top: 0 }} aria-hidden="true">
            {lay.inLines.map((l) => (
              <path key={l.key} d={l.d} fill="none" stroke={l.state === 'none' ? STATE_COLOR.none : CAT_COLOR[l.cat] || '#6b7384'}
                strokeWidth={l.hot ? 1.6 : 1.1} strokeOpacity={l.dim ? 0.07 : 0.7} strokeDasharray={l.state === 'none' ? '3 3' : undefined} />
            ))}
            {lay.outLines.map((l) => (
              <path key={l.key} d={l.d} fill="none" stroke={STATE_COLOR[l.state]}
                strokeWidth={l.state === 'fail' ? 1.5 : l.hot ? 1.3 : 0.8}
                strokeOpacity={l.dim ? 0.05 : l.state === 'ok' ? 0.34 : 0.9} />
            ))}
            <rect x={BUS_X} y={lay.bus.top} width={BUS_W} height={lay.bus.bottom - lay.bus.top} rx={3} fill="#1a1e26" stroke="#2c3240" />
            {lay.ticks.map((t) => (
              <rect key={t.id} x={BUS_X + BUS_W + 1} y={t.y - 1} width={6} height={2} fill={t.state === 'none' ? STATE_COLOR.none : CAT_COLOR[t.cat] || '#6b7384'}>
                <title>{routePath(routesById.get(t.id))} · {KIND_LABEL[routesById.get(t.id)?.kind]} · {STATE_LABEL[t.state]}</title>
              </rect>
            ))}
            <text x={BUS_X + BUS_W / 2} y={lay.height - 10} fill="#6b7384" fontSize={9} fontFamily={MONO} textAnchor="middle">포탈 경로 버스 · 눈금 1개 = 경로 1개</text>
          </svg>

          {(data.cats || []).map((c) => {
            const p = lay.catPos.get(c.id); const on = sel?.type === 'cat' && sel.id === c.id;
            return (
              <button type="button" key={c.id} onClick={() => toggle('cat', c.id)} aria-pressed={on}
                title={`${c.label} — 경로 ${c.routes}개 · 클릭하면 이 종류의 선만 강조`}
                style={{ position: 'absolute', left: 12 + p.x, top: p.y, width: p.w, height: p.h, padding: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch',
                  border: `1px solid ${on ? CAT_COLOR[c.id] : '#232833'}`, background: '#151920', borderRadius: 5, textAlign: 'left', cursor: 'pointer', color: '#d7dbe3', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', background: CAT_COLOR[c.id] || '#55606f', fontSize: 11.5, fontWeight: 600, color: '#f4f6f9' }}>
                  <span>{c.label}</span><span style={{ fontFamily: MONO, fontWeight: 500 }}>{c.routes}경로</span>
                </div>
                <div style={{ display: 'flex', gap: 10, padding: '5px 8px 6px', fontFamily: MONO, fontSize: 10, color: '#8a93a6' }}>
                  <span><Dot state="ok" />{c.ok}</span><span><Dot state="stale" />{c.stale}</span><span><Dot state="fail" />{c.fail}</span>
                  <span title="기록이 한 번도 없는 경로 수"><Dot state="none" dashed />{c.none}</span>
                </div>
              </button>
            );
          })}

          {(data.edges || []).map((e) => {
            const p = lay.edgePos.get(e.id); const on = sel?.type === 'edge' && sel.id === e.id;
            const b = edgeBadge(e); const last = edgeLasts(e.id, data.links, routesById);
            return (
              <button type="button" key={e.id} onClick={() => toggle('edge', e.id)} aria-pressed={on}
                title={`${e.name}${e.origin ? ` — ${e.origin}` : ''} · 클릭하면 이 엣지의 선만 강조하고 아래에 상세`}
                style={{ position: 'absolute', left: 12 + p.x, top: p.y, width: p.w, height: p.h, padding: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch',
                  border: `1px solid ${on ? '#e0a43a' : '#232833'}`, background: '#151920', borderRadius: 5, textAlign: 'left', cursor: 'pointer', color: '#d7dbe3', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '5px 9px', background: TONE_HEAD[b.tone], fontSize: 12, fontWeight: 600, color: '#f4f6f9' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{e.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, flexShrink: 0 }}>{b.text}</span>
                </div>
                <div style={{ padding: '6px 9px 8px', display: 'flex', flexDirection: 'column', gap: 4, fontFamily: MONO, fontSize: 10.5, color: '#8a93a6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>↑ 올림</span><span style={{ color: '#c9ced8' }}>{last.up ? ageText(last.up, now) : '—'}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>↓ 가져감</span><span style={{ color: '#c9ced8' }}>{last.down ? ageText(last.down, now) : '—'}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>⇄ 중앙 호출</span><span style={{ color: '#c9ced8' }}>{last.central ? ageText(last.central, now) : '—'}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>사용 경로</span><span style={{ color: '#c9ced8' }}>{e.used} / {tot.routes}</span></div>
                  <Bar ok={e.ok} stale={e.stale} fail={e.fail} total={e.used} h={4} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {selEdge && (
        <div style={{ ...PANEL, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>{selEdge.name}</b>
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#8a93a6' }}>{selEdge.origin || '주소 없음'}</span>
            {!selEdge.registered && <span className="badge red">등록부에 없음{selEdge.unverifiedOnly ? ' · 이름 미검증' : ''}</span>}
            <span style={{ flexGrow: 1 }} />
            <button type="button" className="btn" disabled={!selEdge.registered || inner[selEdge.id]?.busy} onClick={() => fetchInner(selEdge)}
              title={selEdge.registered ? '이 엣지 한 곳에서 내부 수집 상태(수집·push·pull 작업)를 지금 가져옵니다' : '수집 서버 등록부에 없어 가져올 주소를 모릅니다'}>
              {inner[selEdge.id]?.busy ? '가져오는 중…' : '내부 수집 가져오기'}
            </button>
            <button type="button" className="btn" onClick={() => setSel(null)}>선택 해제</button>
          </div>
          <InnerStatus st={inner[selEdge.id]} now={now} groupLabel={data.innerGroupLabel || {}} />
          <STable minWidth={900}>
            <thead><tr><th>데이터 종류</th><th>경로</th><th>방향</th><th>상태</th><th>마지막</th><th>간격</th><th>횟수</th><th>최근 크기</th><th>사유·표시</th></tr></thead>
            <tbody>
              {(data.links || []).filter((l) => l.edge === selEdge.id).map((l) => {
                const r = routesById.get(l.route) || {};
                return (
                  <tr key={l.route}>
                    <td>{(data.cats || []).find((c) => c.id === r.cat)?.label || r.cat}</td>
                    <td style={{ fontFamily: MONO, fontSize: 11.5 }}>{routePath(r)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{KIND_SHORT[r.kind]}</td>
                    <td data-sort={l.state}><Dot state={l.state} />{STATE_LABEL[l.state]}</td>
                    <td data-sort={l.lastAt}>{ageText(l.lastAt, now)}</td>
                    <td data-sort={l.intervalMs || 0}>{l.intervalMs ? spanText(l.intervalMs) : '—'}</td>
                    <td className="right">{l.count}</td>
                    <td className="right" data-sort={l.bytes || 0}>{l.bytes ? bytesText(l.bytes) : '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{[l.state === 'fail' ? l.reason : '', l.unverified ? '이름 미검증' : ''].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          {!selEdge.used && <div className="muted">이 엣지와 오간 기록이 아직 없습니다 — 중앙이 시작된 뒤 통신이 없었거나 이름이 다르게 보고되고 있습니다.</div>}
        </div>
      )}

      {selCat && (
        <div style={{ ...PANEL, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>{selCat.label}</b><span className="muted">경로 {selCat.routes}개</span>
            <span style={{ flexGrow: 1 }} /><button type="button" className="btn" onClick={() => setSel(null)}>선택 해제</button>
          </div>
          <STable minWidth={760}>
            <thead><tr><th>경로</th><th>방향</th><th>상태</th><th>정상</th><th>낡음</th><th>실패·거부</th><th>쓴 엣지</th></tr></thead>
            <tbody>
              {(data.routes || []).filter((r) => r.cat === selCat.id).map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: MONO, fontSize: 11.5 }}>{routePath(r)}{r.undeclared ? ' (라우터에 없음)' : ''}</td>
                  <td title={KIND_LABEL[r.kind]}>{KIND_SHORT[r.kind]}</td>
                  <td data-sort={r.state}><Dot state={r.state} dashed={r.state === 'none'} />{STATE_LABEL[r.state]}</td>
                  <td className="right">{r.ok}</td><td className="right">{r.stale}</td><td className="right">{r.fail}</td>
                  <td style={{ whiteSpace: 'normal' }}>{(data.links || []).filter((l) => l.route === r.id).map((l) => edgesById.get(l.edge)?.name || l.edge).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 12 }}>
        <div style={PANEL}>
          <div style={CAP}>최근 관측(연결마다 마지막 1건)</div>
          {(data.recent || []).length === 0 && <div className="muted" style={{ fontSize: 12 }}>기록이 아직 없습니다.</div>}
          {(data.recent || []).slice(0, 14).map((l) => {
            const r = routesById.get(l.route) || {};
            return (
              <div key={`${l.edge}|${l.route}`} title={linkText(l, now)}
                style={{ display: 'flex', gap: 8, fontFamily: MONO, fontSize: 10.5, lineHeight: '17px', color: l.state === 'fail' ? '#f08a8d' : l.state === 'stale' ? '#e0a43a' : '#aab1bf', minWidth: 0 }}>
                <span style={{ width: 62, flexShrink: 0, color: '#6b7384' }}>{ageText(l.lastAt, now)}</span>
                <span style={{ width: 92, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{edgesById.get(l.edge)?.name || l.edge}</span>
                <span style={{ width: 80, flexShrink: 0, whiteSpace: 'nowrap' }}>{KIND_SHORT[r.kind]}</span>
                <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.path}{l.state === 'fail' && l.reason ? ` · ${l.reason}` : ''}</span>
              </div>
            );
          })}
        </div>
        <div style={PANEL}>
          <div style={CAP}>데이터 종류별 연결 상태</div>
          {(data.cats || []).map((c) => {
            const n = c.ok + c.stale + c.fail;
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#aab1bf', marginBottom: 6 }}>
                <span style={{ width: 96, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{c.label}</span>
                <Bar ok={c.ok} stale={c.stale} fail={c.fail} h={8} />
                <span style={{ width: 86, flexShrink: 0, textAlign: 'right', fontFamily: MONO, fontSize: 10.5, color: '#8a93a6' }}>{n ? `${Math.round((c.ok / n) * 100)}% 정상` : '기록 없음'}</span>
              </div>
            );
          })}
        </div>
        <div style={{ ...PANEL, fontFamily: MONO, fontSize: 11.5 }}>
          <div style={CAP}>집계(연결 = 엣지 × 경로)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '5px 16px', color: '#8a93a6' }}>
            <span>정상</span><span style={{ color: STATE_DOT.ok, textAlign: 'right' }}>{tot.ok}</span>
            <span>낡음</span><span style={{ color: STATE_DOT.stale, textAlign: 'right' }}>{tot.stale}</span>
            <span>실패·거부</span><span style={{ color: STATE_DOT.fail, textAlign: 'right' }}>{tot.fail}</span>
            <span>관측된 연결</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.links}</span>
            <span>기록 없는 경로</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.routesNone} / {tot.routes}</span>
          </div>
          <ul style={{ margin: '10px 0 0', paddingLeft: 16, fontFamily: 'inherit', color: '#8a93a6', fontSize: 11.5, lineHeight: 1.55 }}>
            {legendLines(data.rules).map((s) => <li key={s} style={{ fontFamily: "'IBM Plex Sans KR', sans-serif" }}><BoldText text={s} /></li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

function InnerStatus({ st, now, groupLabel }) {
  if (!st) return <div className="muted" style={{ fontSize: 12 }}>엣지 <b>안의</b> 수집·push·pull 작업 상태는 ‘내부 수집 가져오기’ 를 눌러야 그 엣지에서 가져옵니다(상시로 가져오지 않습니다).</div>;
  if (st.busy) return <div className="muted" style={{ fontSize: 12 }}>그 엣지에서 가져오는 중…</div>;
  const res = st.res || {};
  const head = fetchResultText(res, { now });
  const snap = res.snap || null;
  const sum = snap ? statusSummary(snap) : null;
  const groups = snap && Array.isArray(snap.status) ? groupStatus(snap.status, groupLabel) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, color: TONE_TEXT[head.tone === 'ok' ? 'ok' : 'bad'] }}><BoldText text={head.text} /></div>
      {sum && <div style={{ fontSize: 12, color: '#aab1bf' }}><BoldText text={sum.text} /></div>}
      {groups.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 10 }}>
          {groups.map((g) => (
            <div key={g.group} style={{ border: '1px solid #232833', borderRadius: 5, padding: '6px 8px', minWidth: 0 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>{g.label} <span className="muted">{g.items.length}{g.failed ? ` · 확인 못 함 ${g.failed}` : ''}</span></div>
              {g.items.map((it) => {
                const x = innerItemText(it, now);
                return (
                  <div key={it.key} style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: '17px', minWidth: 0 }}>
                    <span style={{ width: 132, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#c9ced8' }} title={it.key}>{it.label || it.key}</span>
                    <span style={{ flexGrow: 1, minWidth: 0, color: TONE_TEXT[x.tone], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.text}>{x.text}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
