/**
 * views/tools/BmTopProc.jsx — 추이 팝업의 **‘이 시점 프로세스’ 표 + 시간 × 프로세스 띠**(리눅스 성능 8b단계 ⑳ · 아트보드 TopProc).
 * ⚠ 값 · 단서 · 지속 · PID 재사용은 서버(topStore)가 정한다 — 여기는 그리기만(웹이 다시 판정하지 않는다).
 * ⚠ 조회는 그 시각 · 그 창이 바뀔 때 1회(폴링 없음) · 늦게 온 이전 응답은 버린다(세대) · 훅은 조기 return 위.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { TOP_KINDS, STATE_TEXT, valText, rssText, cpuTimeText, hintText, sampleNotes, footText, whenText, bandLayout, bandNotes, BAND_COLORS, OTHER_COLOR, TOP_HONEST, rateText } from './bmTopText.js';

function useGenFetch(url) {
  const [st, setSt] = useState({ resp: null, err: null, loading: false });
  const gen = useRef(0);
  useEffect(() => {
    if (!url) { setSt({ resp: null, err: null, loading: false }); return undefined; }
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    fetchJson(url, {}, undefined, { timeoutMs: 60_000 })
      .then((r) => { if (g === gen.current) setSt({ resp: r, err: null, loading: false }); })
      .catch((e) => { if (g === gen.current) setSt({ resp: null, err: e, loading: false }); });
    return undefined;
  }, [url]);
  return st;
}

export function TopBand({ band, onPick, narrow = false }) {
  const lay = bandLayout(band);
  const comms = band?.comms || [];
  return (
    <div className="bmtp-band">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="시간 × 프로세스 띠" style={{ width: '100%', height: narrow ? 90 : 120 }}>
        {lay.bars.map((b) => (
          <g key={b.t} onClick={() => onPick?.(b.t)} style={{ cursor: onPick ? 'pointer' : 'default' }}>
            {b.segs.map((s) => <rect key={s.c} x={b.x} width={b.w} y={100 - (s.y1 / lay.yMax) * 100} height={((s.y1 - s.y0) / lay.yMax) * 100} fill={s.color}><title>{`${whenText(b.t)} · ${s.c} ${s.v}%`}</title></rect>)}
          </g>
        ))}
      </svg>
      <div className="bmtp-legend">
        {comms.map((c, i) => <span key={c} className="bmt-key"><i style={{ borderTopColor: BAND_COLORS[i % BAND_COLORS.length], borderTopWidth: 6 }} />{c}</span>)}
        <span className="bmt-key"><i style={{ borderTopColor: OTHER_COLOR, borderTopWidth: 6 }} />기타 상위</span>
        <span className="bmo-sub">세로 최대 {Math.round(lay.yMax)}%(코어 하나 = 100%) · 막대를 누르면 그 표본</span>
      </div>
    </div>
  );
}

/**
 * @param {{itemKey:string, ts:number|null, win:{from:number,to:number}, narrow?:boolean}} p
 */
export default function BmTopProc({ itemKey, ts = null, win = null, narrow = false }) {
  const [kind, setKind] = useState('cpu');
  const [at, setAt] = useState(ts);
  useEffect(() => { setAt(ts); }, [ts]);
  const enc = encodeURIComponent(itemKey || '');
  const point = useGenFetch(itemKey && at ? `/tools/bm-usage/perf/${enc}/top?ts=${Math.round(at)}` : '');
  const band = useGenFetch(itemKey && win ? `/tools/bm-usage/perf/${enc}/top/band?from=${Math.round(win.from)}&to=${Math.round(win.to)}` : '');
  if (!itemKey) return null;
  const r = point.resp;
  const rows = r?.rows?.[kind] || [];
  const k = TOP_KINDS.find((x) => x.k === kind) || TOP_KINDS[0];
  return (
    <section className="bmtp" aria-label="이 시점 프로세스">
      <div className="bmtp-head">
        <h5 className="bmo-h" style={{ margin: 0 }}>이 시점 프로세스 — {r?.sample ? whenText(r.sample.ts) : (at ? whenText(at) : '—')}{r?.sample?.cpuTotal != null ? ` (전 프로세스 CPU 합 ${r.sample.cpuTotal}%)` : ''}</h5>
        <div className="bmp-seg bmt-seg" role="tablist" aria-label="종류">
          {TOP_KINDS.map((x) => <button key={x.k} type="button" role="tab" aria-selected={kind === x.k} className={kind === x.k ? 'active' : ''} onClick={() => setKind(x.k)}>{x.label}</button>)}
        </div>
        <button type="button" className="btn btn-sm bmp-touch" disabled={!r?.prevTs} onClick={() => setAt(r.prevTs)}>◀ {r?.prevTs ? whenText(r.prevTs).slice(6) : '이전'}</button>
        <button type="button" className="btn btn-sm bmp-touch" disabled={!r?.nextTs} onClick={() => setAt(r.nextTs)}>{r?.nextTs ? whenText(r.nextTs).slice(6) : '다음'} ▶</button>
        {r?.via === 'edge' && <span className="bmo-sub">엣지 대행({r.agent})</span>}
      </div>
      {point.err && <p className="bmt-note" style={{ color: 'var(--red)' }}>{point.err.message || '프로세스 표를 읽지 못했습니다'}</p>}
      {!r && !point.err && <p className="bmt-note">프로세스 표를 읽는 중…</p>}
      {sampleNotes(r).map((x, i) => <p key={i} className="bmt-note"><BoldText text={x} /></p>)}
      {r?.ok === false && r.kind === 'old-version' && r.minEdgeVersion && <p className="bmt-note">엣지 v{r.minEdgeVersion} 이상이어야 이 표를 대행합니다.</p>}
      {!!rows.length && (
        <STable minWidth={760} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th className="right">#</th><th className="right">PID</th><th>사용자</th><th>명령(comm)</th><th className="right">{k.valLabel}</th>{kind !== 'mem' && <th className="right">RSS</th>}{kind === 'io' && <th className="right">읽기</th>}{kind === 'io' && <th className="right">쓰기</th>}<th>상태</th><th className="right">누적 CPU</th><th style={{ minWidth: 150 }}>프로파일 · 지속</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.rank}|${x.pid}`}>
                <td className="right" data-sort={x.rank}>{x.rank}</td>
                <td className="right" data-sort={x.pid ?? ''} title={x.startAt ? `시작 ${whenText(x.startAt)}` : ''}>{x.pid ?? '—'}</td>
                <td data-sort={x.user || ''}>{x.user || '—'}</td>
                <td data-sort={x.comm || ''} className="bmo-wrap" style={{ wordBreak: 'break-all' }}>{x.comm || '—'}</td>
                <td className="right" data-sort={x.val ?? ''}>{valText(kind, x)}</td>
                {kind !== 'mem' && <td className="right" data-sort={x.rss ?? ''}>{rssText(x.rss)}</td>}
                {kind === 'io' && <td className="right" data-sort={x.rd ?? ''}>{rateText(x.rd)}</td>}
                {kind === 'io' && <td className="right" data-sort={x.wr ?? ''}>{rateText(x.wr)}</td>}
                <td data-sort={x.state || ''} title={STATE_TEXT[x.state] || ''}>{x.state || '—'}</td>
                <td className="right" data-sort={x.cpuS ?? ''}>{cpuTimeText(x.cpuS)}</td>
                <td className="bmo-wrap" data-sort={hintText(x)}>{hintText(x)}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
      {r?.sample && !rows.length && r.reason !== 'base-missing' && <p className="bmt-note">이 종류의 상위 행이 없습니다{kind === 'io' ? '(I/O 를 읽은 후보가 없다 — 권한 없음은 위 안내)' : ''}.</p>}
      {r?.sample && <p className="bmo-sub" style={{ margin: '4px 0' }}>{footText(r)}</p>}
      {r?.userHidden && <p className="bmo-sub">관리자 판본이 아닙니다 — 사용자 이름은 가림 토큰입니다(같은 값은 같은 토큰 · 계정에서 나온 프로파일 단서도 숨깁니다).</p>}
      <h5 className="bmo-h" style={{ margin: '10px 0 4px' }}>시간 × 프로세스 띠 — CPU 상위(누적)</h5>
      {band.err && <p className="bmt-note" style={{ color: 'var(--red)' }}>{band.err.message || '띠를 읽지 못했습니다'}</p>}
      {!band.resp && !band.err && <p className="bmt-note">띠를 읽는 중…</p>}
      {band.resp && band.resp.ok !== false && !!(band.resp.points || []).length && <TopBand band={band.resp} onPick={(t) => setAt(t)} narrow={narrow} />}
      {bandNotes(band.resp).map((x, i) => <p key={i} className="bmt-note">{x}</p>)}
      <p className="bmt-note"><BoldText text={TOP_HONEST} /></p>
    </section>
  );
}
