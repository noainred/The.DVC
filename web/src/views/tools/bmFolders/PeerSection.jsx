/**
 * 물리서버 상세 드로어의 ‘같은 묶음 대비’ 구역(v3.48 · 시안 docs/design/bm-feature-proposals ⑨).
 * 응답 상태({ d, err, stale })를 받아 **그리기만** 한다(판정은 서버 bmcheck/peer.js · 글자 · 좌표는 peerText.js). 드로어가 열릴 때 1건 조회(BmDrawer useOnce).
 *  · 띠 = 묶음의 폭 · 작은 점 = 같은 묶음 서버(이름 없이 값만 · 같은 자리에 다 못 그리면 대수 글자) · 큰 표식 = 이 서버. 판정하지 않은 지표는 이유를 쓰고 띠를 그리지 않는다.
 *  · 색으로 좋다 · 나쁘다를 말하지 않는다(묶음 밖 = 주황 · 그 밖 = 회색 — 밖은 ‘다르다’ 이지 ‘문제’ 가 아니다).
 *  · 다시 묻는 중(폴더를 옮긴 뒤 등 — stale)에는 이전 판정을 보이지 않는다(반증 B3 — 옛 묶음의 판정이 새 배치처럼 보였다).
 *  · 그림 폭은 칸의 실제 폭(useBoxWidth — SSR · 측정 전은 기본 폭 · 폭 반응은 Chromium 으로 확인한다).
 */
import React, { useRef } from 'react';
import { peerView, peerStrip, PEER_FOOT, PEER_WHY, STRIP_COUNT_DY } from './peerText.js';
import { useBoxWidth } from './useBoxWidth.js';

const SELF_IN = 'var(--accent)';
const SELF_OUT = 'var(--amber, #f59e0b)';

function Strip({ id, m, aria }) {
  const boxRef = useRef(null);
  const boxW = useBoxWidth(boxRef, 420);
  const s = peerStrip(id, m, boxW);
  if (!s) return <div ref={boxRef} style={{ minWidth: 0 }} />;
  return (
    <div ref={boxRef} style={{ minWidth: 0 }}>
      <svg viewBox={`0 0 ${s.w} ${s.h}`} width={s.w} height={s.h} style={{ display: 'block', maxWidth: '100%' }} role="img" aria-label={aria}>
        <rect className="peer-band" x={s.band.x} y={s.mid - 9} width={s.band.w} height={18} rx="4" fill="rgba(139,155,180,.18)" />
        <line x1={s.padL} x2={s.w - s.padR} y1={s.mid} y2={s.mid} stroke="var(--border)" strokeWidth="1" />
        {s.dots.map((p, i) => <circle key={i} className="peer-dot" cx={p.x} cy={s.mid + p.dy} r="3.5" fill="var(--text-dim)" />)}
        {s.counts.map((c) => <text key={`n${c.x}`} className="peer-count" x={c.x} y={s.mid + STRIP_COUNT_DY} fontSize="9" fill="var(--text-dim)" textAnchor={c.anchor}>{c.n}대</text>)}
        <circle className="peer-self" cx={s.self.x} cy={s.mid} r="6" fill={s.self.out ? SELF_OUT : SELF_IN} stroke="var(--text)" strokeWidth="1.5" />
        <text x={s.self.x} y="12" fontSize="11" fontWeight="700" fill="var(--text)" textAnchor={s.self.anchor}>{s.self.label}</text>
        <text x={s.padL} y={s.h - 1} fontSize="10" fill="var(--text-dim)">{s.axis[0]}</text>
        <text x={s.w - s.padR} y={s.h - 1} fontSize="10" fill="var(--text-dim)" textAnchor="end">{s.axis[1]}</text>
      </svg>
    </div>
  );
}

/**
 * @param r    목록 행(kind — ESXi 행은 조회하지 않고 이유만 쓴다)
 * @param peer { d, err, stale } — /tools/bm-folders/peer(읽는 중이면 d null · err '' · 다시 묻는 중이면 stale)
 */
export function PeerSection({ r, peer }) {
  const isBm = r?.kind === 'bm';
  const fresh = isBm && peer?.d && !peer.stale ? peer.d : null;
  const v = fresh ? peerView(fresh) : null;
  const metrics = fresh?.metrics || {};
  const judgedView = !!v && !v.why;
  return (
    <section className="vmh-sec" aria-label="같은 묶음 대비">
      <div className="sh">
        <h3>같은 묶음 대비{v?.badge ? <>{' '}<span className={`badge ${v.badge.color}`} style={{ marginLeft: 8 }}>{v.badge.label}</span></> : null}</h3>
        {judgedView && v.sub ? <span className="muted bmd-sh-sub">{v.sub}</span> : null}
      </div>
      {!isBm ? <div className="muted bmd-note">{PEER_WHY.esxi}</div>
        : peer?.err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>{peer.err}</div>
          : !v ? <div className="muted bmd-note">{peer?.stale ? '다시 읽는 중…' : '읽는 중…'}</div>
            : (
              <>
                {v.head ? <div className="bmd-peer-head">{v.head}</div> : null}
                {v.why ? <div className="bmd-note" style={v.error ? { color: 'var(--red)' } : undefined}><span className={v.error ? undefined : 'muted'}>{v.why}</span></div> : (
                  <div className="bmd-peer">
                    {v.rows.map((x) => (
                      <div key={x.id} className="bmd-peer-row">
                        <div className="bmd-peer-l">
                          <b>{x.label}</b>
                          <span className="muted bmd-peer-basis">{x.basis}</span>
                          <span className={`badge ${x.badge.color}`}>{x.badge.label}</span>
                        </div>
                        <div className="bmd-peer-s">
                          {x.judged ? <Strip id={x.id} m={metrics[x.id]} aria={x.aria} /> : <div className="muted bmd-peer-why">{x.note}{x.state === 'few' && x.valueText !== '—' ? ` 이 서버 ${x.valueText}.` : ''}</div>}
                          <div className="muted bmd-peer-cap">{[x.medianText, x.spanText, x.rangeText, x.countText].filter(Boolean).join(' · ')}</div>
                        </div>
                      </div>
                    ))}
                    {v.anyStrip ? (
                      <div className="flex wrap bmd-peer-lg">
                        <span className="bmf-lg"><i style={{ background: 'var(--text-dim)', borderRadius: '50%' }} />같은 묶음 서버</span>
                        <span className="bmf-lg"><i style={{ background: SELF_IN, borderRadius: '50%' }} />이 서버</span>
                        <span className="bmf-lg"><i style={{ background: SELF_OUT, borderRadius: '50%' }} />이 서버(묶음 밖)</span>
                        <span className="bmf-lg"><i style={{ background: 'rgba(139,155,180,.35)', width: 18 }} />묶음의 폭</span>
                      </div>
                    ) : null}
                  </div>
                )}
                {v.notes.length ? <ul className="muted bmd-peer-notes">{v.notes.map((t) => <li key={t}>{t}</li>)}</ul> : null}
                {v.reasons.length ? (
                  <details className="bmd-peer-why-more">
                    <summary className="muted">엣지 사유 {v.reasons.length}건</summary>
                    <ul className="muted bmd-peer-notes">{v.reasons.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  </details>
                ) : null}
                {judgedView ? <div className="muted bmd-note">{PEER_FOOT}</div> : null}
              </>
            )}
    </section>
  );
}
