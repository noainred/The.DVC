/**
 * 3단 지도 — 장비 → 엣지 → 메인(v2.588).
 *
 * 사용자 요청(2026-09-23): "엣지와 main 이 통신하는것도 표시해줘 · 3단계로 만들어줘, 장비-edge-main".
 * 선택: 장비는 **종류별 묶음 + 펼치기**, 특수기능 **별도 화면**.
 *
 * 설계:
 *  · 데이터는 `/tools/device-flow` 하나(15초 폴링, 서버 memoJson 12초). 서버가 통신 지도·데이터 흐름 지도의
 *    판정을 **그대로** 묶어 준다 — 이 화면은 새로 판정하지 않는다.
 *  · 배치는 `deviceFlowLayout.js`, 문구는 `deviceFlowText.js`(순수) — 이 파일은 조립만 한다.
 *  · 등록만 알고 판정하지 않은 묶음은 **회색**이고, 기록 없는 엣지 ↔ 메인 선은 **회색 점선**이다(정상이 아니다).
 *  · 그래프는 고정폭이고 좁은 화면에서는 **그 상자만** 가로로 스크롤한다(페이지는 밀리지 않는다).
 */
import React, { useMemo, useState } from 'react';
import { usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { layoutDeviceFlow, W, EDGE_X, EDGE_W, MAIN_X, HEAD_H } from './deviceFlowLayout.js';
import {
  DEV_KIND_LABEL, DEV_KIND_SHORT, CHANNEL_LABEL, CHANNEL_ICON, CHANNEL_WORD, CH_STATE_LABEL, CH_STATE_COLOR,
  ITEM_STATE_LABEL, ITEM_STATE_COLOR, TONE_LABEL, TONE_COLOR, UNASSIGNED_REASON,
  EDGE_STATE_LABEL, EDGE_STATE_COLOR,
  groupTitle, countsText, groupNote, itemExtra, channelText, headerNote, reasonText, noEdgesNote, LEGEND, ageText, spanText, bytesText,
} from './deviceFlowText.js';

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const PANEL = { background: '#13161c', border: '1px solid #1f242e', borderRadius: 6, padding: '10px 12px', minWidth: 0 };
const CAP = { fontFamily: MONO, fontSize: 10, color: '#6b7384', letterSpacing: '0.08em', marginBottom: 6 };
const CHANNELS = ['up', 'down', 'cpull', 'cpush'];
const CARD = { position: 'absolute', padding: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch',
  background: '#151920', borderRadius: 5, textAlign: 'left', cursor: 'pointer', color: '#d7dbe3', overflow: 'hidden' };

function Chip({ g, pos, on, dim, onClick }) {
  const c = g.counts || {};
  const bad = (c.fail || 0) + (c.stale || 0) + (c.pending || 0);
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      title={`${groupTitle(g)} — ${TONE_LABEL[g.tone]} · ${countsText(g)} · 클릭하면 아래에 목록`}
      style={{ ...CARD, left: 12 + pos.x, top: pos.y, width: pos.w, height: pos.h, opacity: dim ? 0.35 : 1,
        border: `1px solid ${on ? '#e0a43a' : '#232833'}`, borderTop: `3px solid ${TONE_COLOR[g.tone]}` }}>
      <span style={{ padding: '3px 7px 0', fontSize: 10.5, color: '#8a93a6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{DEV_KIND_SHORT[g.kind] || g.kind}</span>
      <span style={{ padding: '0 7px', display: 'flex', alignItems: 'baseline', gap: 5, fontFamily: MONO, whiteSpace: 'nowrap' }}>
        <b style={{ fontSize: 15 }}>{g.total}</b>
        {bad > 0 && <span style={{ fontSize: 10, color: TONE_COLOR[g.tone] }}>!{bad}</span>}
      </span>
    </button>
  );
}

export default function DeviceFlow() {
  const { data, error } = usePolling('/tools/device-flow', {}, 15_000);
  const [sel, setSel] = useState(null);
  const lay = useMemo(() => (data ? layoutDeviceFlow(data, sel) : null), [data, sel]);
  const edgesById = useMemo(() => new Map((data?.edges || []).map((e) => [e.id, e])), [data]);
  const catLabel = useMemo(() => new Map((data?.cats || []).map((c) => [c.id, c.label])), [data]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data || !lay) return <Loading />;
  const now = Date.now();
  const tot = data.totals || {};
  const same = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);
  const toggle = (next) => setSel((s) => (same(s, next) ? null : next));

  const selEdge = sel?.type === 'edge' ? edgesById.get(sel.id) : null;
  const selGroup = (() => {
    if (sel?.type !== 'group') return null;
    if (sel.where === 'main') return (data.main?.groups || []).find((g) => g.kind === sel.kind) || null;
    if (sel.where === 'unassigned') return (data.unassigned || []).find((g) => g.kind === sel.kind) || null;
    return (edgesById.get(sel.edgeId)?.groups || []).find((g) => g.kind === sel.kind) || null;
  })();
  const selGroupOwner = sel?.type === 'group' ? (sel.where === 'main' ? '메인(중앙 직접)' : sel.where === 'unassigned' ? '붙일 곳 없음' : edgesById.get(sel.edgeId)?.name || sel.edgeId) : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {error && <div className="banner warn">최근 조회가 실패했습니다 — 아래는 직전 값입니다. ({String(error.message || error)})</div>}

      <div style={{ ...PANEL, display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center', fontFamily: MONO, fontSize: 11, color: '#8a93a6' }}>
        <span style={{ color: '#d7dbe3', fontWeight: 600 }}>3단 지도 · 장비 → 엣지 → 메인</span>
        <span>엣지 <b style={{ color: '#d7dbe3' }}>{tot.edges}</b></span>
        <span>장비 <b style={{ color: '#d7dbe3' }}>{tot.devices}</b></span>
        <span>엣지 경유 <b style={{ color: '#d7dbe3' }}>{tot.edgeDevices}</b></span>
        <span>메인 직접 <b style={{ color: '#d7dbe3' }}>{tot.mainDevices}</b></span>
        <span>붙일 곳 없음 <b style={{ color: tot.unassignedDevices ? '#e0a43a' : '#d7dbe3' }}>{tot.unassignedDevices}</b></span>
        <span>엣지 ↔ 메인 {['fail', 'stale', 'ok', 'none'].map((s) => (
          <span key={s} style={{ marginLeft: 6 }} title={CH_STATE_LABEL[s]}><i aria-hidden="true" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 3, background: CH_STATE_COLOR[s] }} />{tot.byLine?.[s] || 0}</span>
        ))}</span>
        <span style={{ flexGrow: 1 }} />
        <span>조회 {ageText(data.generatedAt, now)}</span>
      </div>
      <div style={{ fontSize: 12.5, color: '#aab1bf', lineHeight: 1.6 }}><BoldText text={headerNote(data, now)} /></div>
      {data.sourceErrors?.length > 0 && <div className="banner warn">원천을 읽지 못했습니다: {data.sourceErrors.map((s) => `${s.source} — ${s.error}`).join(' · ')}</div>}

      <div style={{ overflowX: 'auto', background: '#0d0f13', border: '1px solid #1f242e', borderRadius: 6 }}>
        <div style={{ position: 'relative', width: W + 24, height: lay.height, padding: '0 12px' }}>
          <svg width={W} height={lay.height} style={{ position: 'absolute', left: 12, top: 0 }} aria-hidden="true">
            <text x={0} y={HEAD_H - 8} fill="#6b7384" fontSize={10} fontFamily={MONO} letterSpacing="0.08em">① 장비(종류별 묶음)</text>
            <text x={EDGE_X} y={HEAD_H - 8} fill="#6b7384" fontSize={10} fontFamily={MONO} letterSpacing="0.08em">② 엣지</text>
            <text x={MAIN_X} y={HEAD_H - 8} fill="#6b7384" fontSize={10} fontFamily={MONO} letterSpacing="0.08em">③ 메인(중앙)</text>
            {lay.rows.map((r) => (
              <g key={r.key} opacity={r.dim ? 0.15 : 1}>
                {r.inLine && <path d={r.inLine.d} fill="none" stroke={TONE_COLOR[r.inLine.tone] || '#5b6272'} strokeWidth={1.4} strokeOpacity={0.8} />}
                {r.outLine && <path d={r.outLine.d} fill="none" stroke={CH_STATE_COLOR[r.outLine.state]} strokeWidth={r.outLine.state === 'fail' ? 2.2 : 1.6}
                  strokeDasharray={r.outLine.dashed ? '4 4' : undefined} strokeOpacity={r.outLine.dashed ? 0.8 : 0.9} />}
                {r.kind === 'direct' && (
                  <text x={EDGE_X + EDGE_W / 2} y={r.cy - 6} fill="#6b7384" fontSize={10} fontFamily={MONO} textAnchor="middle">
                    {r.chips.length ? '엣지를 거치지 않음 · 메인이 직접 수집' : '메인이 직접 수집하는 장비 없음'}
                  </text>
                )}
                {r.kind === 'edge' && !r.chips.length && (
                  <text x={0} y={r.cy + 4} fill="#4a5163" fontSize={10.5} fontFamily={MONO}>이 엣지에 붙은 장비 없음</text>
                )}
              </g>
            ))}
          </svg>

          {lay.rows.map((r) => r.chips.map((c) => {
            const next = r.kind === 'direct' ? { type: 'group', where: 'main', kind: c.kind } : { type: 'group', where: 'edge', edgeId: r.edgeId, kind: c.kind };
            return <Chip key={`${r.key}|${c.kind}`} g={c.group} pos={c} dim={r.dim} on={same(sel, next)} onClick={() => toggle(next)} />;
          }))}

          {lay.rows.filter((r) => r.kind === 'edge').map((r) => {
            const e = edgesById.get(r.edgeId); if (!e) return null;
            const on = sel?.type === 'edge' && sel.id === e.id;
            return (
              <button type="button" key={r.key} onClick={() => toggle({ type: 'edge', id: e.id })} aria-pressed={on}
                title={`${e.name}${e.origin ? ` — ${e.origin}` : ''} · 클릭하면 아래에 방향별 통신`}
                style={{ ...CARD, left: 12 + r.edge.x, top: r.edge.y, width: r.edge.w, height: r.edge.h, opacity: r.dim ? 0.35 : 1,
                  border: `1px solid ${on ? '#e0a43a' : '#232833'}`, borderLeft: `3px solid ${EDGE_STATE_COLOR[e.state] || '#5b6272'}` }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '5px 9px 2px' }}>
                  <b style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{e.name}</b>
                  <span style={{ fontFamily: MONO, fontSize: 10, flexShrink: 0, color: e.registered ? EDGE_STATE_COLOR[e.state] : '#f08a8d' }}>
                    {e.registered ? EDGE_STATE_LABEL[e.state] || e.state : '등록부에 없음'}
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 9px 0', fontFamily: MONO, fontSize: 10.5 }}>
                  {CHANNELS.map((k) => (
                    <span key={k} title={`${CHANNEL_LABEL[k]} — ${channelText(e.channels?.[k], now)}`}
                      style={{ color: CH_STATE_COLOR[e.channels?.[k]?.state || 'none'], whiteSpace: 'nowrap' }}>
                      <b style={{ fontSize: 13 }}>{CHANNEL_ICON[k]}</b>{CHANNEL_WORD[k]}
                    </span>
                  ))}
                  <span style={{ flexGrow: 1 }} />
                  <span style={{ fontSize: 10, color: '#8a93a6', whiteSpace: 'nowrap' }}>장비 {e.deviceTotal}</span>
                </span>
              </button>
            );
          })}

          {lay.emptyEdges && (
            <div role="note" style={{ position: 'absolute', left: 12 + lay.emptyEdges.x, top: lay.emptyEdges.y, width: lay.emptyEdges.w, minHeight: lay.emptyEdges.h,
              boxSizing: 'border-box', padding: '8px 10px', border: '1px dashed #2c3240', borderRadius: 6, fontSize: 11.5, lineHeight: 1.55, color: '#aab1bf' }}>
              <BoldText text={noEdgesNote(data)} />
            </div>
          )}

          <button type="button" onClick={() => toggle({ type: 'main' })} aria-pressed={sel?.type === 'main'}
            title="메인(중앙) — 클릭하면 아래에 종류별 합계"
            style={{ ...CARD, left: 12 + lay.main.x, top: lay.main.y, width: lay.main.w, height: lay.main.h,
              border: `1px solid ${sel?.type === 'main' ? '#e0a43a' : '#2c3240'}`, background: '#161b24' }}>
            <span style={{ padding: '10px 14px 4px', fontSize: 15, fontWeight: 700 }}>메인 포탈</span>
            <span style={{ padding: '0 14px', fontFamily: MONO, fontSize: 10.5, color: '#8a93a6' }}>
              {data.main?.version ? `v${data.main.version}` : '버전 미상'}{data.main?.agentName ? ` · ${data.main.agentName}` : ''}
            </span>
            <span style={{ padding: '12px 14px 0', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '5px 10px', fontFamily: MONO, fontSize: 11, color: '#8a93a6' }}>
              <span>장비 합계</span><b style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.devices}</b>
              <span>엣지 경유</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.edgeDevices}</span>
              <span>메인 직접</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.mainDevices}</span>
              <span>엣지</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.edges}</span>
              <span>엣지 pull 주기</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{data.main?.pullerEnabled ? spanText(data.main.pullIntervalMs) : '꺼짐'}</span>
            </span>
            <span style={{ padding: '12px 14px 0', ...CAP }}>엣지 ↔ 메인 선</span>
            <span style={{ padding: '0 14px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '4px 10px', fontFamily: MONO, fontSize: 11 }}>
              {['fail', 'stale', 'ok', 'none'].map((s) => (
                <React.Fragment key={s}>
                  <span style={{ color: CH_STATE_COLOR[s] }}>{CH_STATE_LABEL[s]}</span><span style={{ color: '#d7dbe3', textAlign: 'right' }}>{tot.byLine?.[s] || 0}</span>
                </React.Fragment>
              ))}
            </span>
          </button>
        </div>
      </div>

      {selGroup && (
        <div style={{ ...PANEL, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>{selGroupOwner} · {groupTitle(selGroup)}</b>
            <span style={{ fontFamily: MONO, fontSize: 11, color: TONE_COLOR[selGroup.tone] }}>{TONE_LABEL[selGroup.tone]}</span>
            <span className="muted" style={{ fontSize: 12 }}>{countsText(selGroup)}</span>
            <span style={{ flexGrow: 1 }} />
            <button type="button" className="btn" onClick={() => setSel(null)}>닫기</button>
          </div>
          <div style={{ fontSize: 12.5, color: '#aab1bf', lineHeight: 1.6 }}><BoldText text={groupNote(selGroup, sel.where, now)} /></div>
          <STable minWidth={720}>
            <thead><tr><th>이름</th><th>상태</th><th>부가 정보</th>{sel.where === 'unassigned' && <th>담당으로 적힌 엣지</th>}<th>식별자</th></tr></thead>
            <tbody>
              {(selGroup.items || []).map((it) => (
                <tr key={`${it.id}|${it.name}`}>
                  <td style={{ whiteSpace: 'normal' }}>{it.name}</td>
                  <td data-sort={it.state} style={{ whiteSpace: 'nowrap' }}>
                    <i aria-hidden="true" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5, background: ITEM_STATE_COLOR[it.state] || '#6b7384' }} />
                    {ITEM_STATE_LABEL[it.state] || it.state}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>{itemExtra(it) || '—'}</td>
                  {sel.where === 'unassigned' && <td style={{ whiteSpace: 'normal' }}>{it.agent || '—'} · {UNASSIGNED_REASON[it.reason] || it.reason || ''}</td>}
                  <td style={{ fontFamily: MONO, fontSize: 11 }}>{it.id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}

      {selEdge && (
        <div style={{ ...PANEL, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>{selEdge.name}</b>
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#8a93a6' }}>{selEdge.origin || '주소 없음'}{selEdge.version ? ` · v${selEdge.version}` : ''}</span>
            {!selEdge.registered && <span className="badge red">등록부에 없음{selEdge.unverifiedOnly ? ' · 이름 미검증' : ''}</span>}
            <span style={{ flexGrow: 1 }} />
            <button type="button" className="btn" onClick={() => { window.location.hash = '#/tools/data-flow'; }}>데이터 흐름 지도</button>
            <button type="button" className="btn" onClick={() => { window.location.hash = '#/tools/comm-map'; }}>통신 지도</button>
            <button type="button" className="btn" onClick={() => setSel(null)}>닫기</button>
          </div>
          {selEdge.reasons?.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#aab1bf', lineHeight: 1.6 }}>
              {selEdge.reasons.map((c) => <li key={c}><BoldText text={reasonText(c)} /></li>)}
            </ul>
          )}
          <STable minWidth={820}>
            <thead><tr><th>방향</th><th>상태</th><th>경로</th><th>마지막 성공</th><th>마지막 실패</th><th>횟수</th><th>받은 크기</th><th>데이터 종류</th></tr></thead>
            <tbody>
              {CHANNELS.map((k) => {
                const c = selEdge.channels?.[k] || {};
                return (
                  <tr key={k}>
                    <td style={{ whiteSpace: 'nowrap' }}>{CHANNEL_ICON[k]} {CHANNEL_LABEL[k]}</td>
                    <td data-sort={c.state} style={{ whiteSpace: 'nowrap', color: CH_STATE_COLOR[c.state || 'none'] }}>{CH_STATE_LABEL[c.state || 'none']}</td>
                    <td className="right">{c.routes || 0}{c.failRoutes ? ` (실패 ${c.failRoutes})` : ''}</td>
                    <td data-sort={c.lastOkAt || 0}>{c.lastOkAt ? ageText(c.lastOkAt, now) : '—'}</td>
                    <td data-sort={c.lastFailAt || 0}>{c.lastFailAt ? ageText(c.lastFailAt, now) : '—'}</td>
                    <td className="right">{c.count || 0}</td>
                    <td className="right" data-sort={c.bytes || 0}>{c.bytes ? bytesText(c.bytes) : '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{(c.cats || []).map((x) => catLabel.get(x) || x).join(', ') || '—'}{c.unverified ? ' · 이름 미검증' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          <div className="muted" style={{ fontSize: 12 }}>
            붙은 장비: {(selEdge.groups || []).map((g) => `${DEV_KIND_LABEL[g.kind]} ${g.total}`).join(' · ') || '없음'}
          </div>
        </div>
      )}

      {sel?.type === 'main' && (
        <div style={{ ...PANEL, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>종류별 장비 분포</b><span style={{ flexGrow: 1 }} />
            <button type="button" className="btn" onClick={() => setSel(null)}>닫기</button>
          </div>
          <STable minWidth={520}>
            <thead><tr><th>종류</th><th>엣지 경유</th><th>메인 직접</th><th>붙일 곳 없음</th><th>합계</th></tr></thead>
            <tbody>
              {Object.keys(DEV_KIND_LABEL).map((k) => {
                const v = tot.byKind?.[k] || { edge: 0, main: 0, unassigned: 0 };
                return (
                  <tr key={k}><td>{DEV_KIND_LABEL[k]}</td><td className="right">{v.edge}</td><td className="right">{v.main}</td>
                    <td className="right">{v.unassigned}</td><td className="right">{v.edge + v.main + v.unassigned}</td></tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 12 }}>
        <div style={PANEL}>
          <div style={CAP}>어느 엣지에도 붙일 수 없는 장비</div>
          {(data.unassigned || []).length === 0 && <div className="muted" style={{ fontSize: 12 }}>없습니다.</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(data.unassigned || []).map((g) => {
              const next = { type: 'group', where: 'unassigned', kind: g.kind };
              const on = same(sel, next);
              return (
                <button type="button" key={g.kind} className="btn" onClick={() => toggle(next)} aria-pressed={on}
                  style={{ borderColor: on ? '#e0a43a' : undefined }}>{groupTitle(g)}</button>
              );
            })}
          </div>
        </div>
        <div style={PANEL}>
          <div style={CAP}>읽는 법</div>
          <ul style={{ margin: 0, paddingLeft: 16, color: '#8a93a6', fontSize: 11.5, lineHeight: 1.55 }}>
            {LEGEND.map((s) => <li key={s}><BoldText text={s} /></li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}
