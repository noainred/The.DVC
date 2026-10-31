/**
 * Backup › Summary '용량과 일정'(v2.838 — 시안 ① 트리 표 아래 두 카드).
 *   왼쪽 = 백업된 용량 — 법인별(Summary 응답의 법인 줄 pa · 서버가 센 값) + Veeam 저장소 30일 선 · 여유 경고(EM — 전체 범위 계정만).
 *   오른쪽 = 백업 스케줄 — 다음 24시간(GET /tools/backup-summary/schedule — Veeam 잡 다음 실행 · Bareos 그룹 예약) · 7일 요약 · 겹침 경고.
 *   스케줄은 무거운 집계라 폴링하지 않는다 — 처음 한 번 + 위 '새로고침'(reloadKey) 때만 · 늦게 온 이전 응답은 버린다.
 *   출처를 지어내지 않는다: Veeam 은 잡의 **다음 1회**만 알고(반복 주기 미수집 — 7일 칸은 오늘 · 내일만) · Director 스케줄 · 풀은 2차 수집 뒤 '—'.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { fmtNum } from './backupViewText.js';
import { capacityRows, barPct, linePoints, repoWarn, hourStart, hourLabels, barOf, hm, dayLabel, overlapText, sortSchedRows, bytesText } from './backupSummaryPlan.js';

const C = { veeam: '#3b82f6', bareos: '#14b8a6', full: '#f59e0b' };
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', muted: 'var(--text-dim)' };
const card = { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 };
const Legend = ({ items }) => (
  <span className="flex wrap" style={{ gap: 12, fontSize: 11.5, color: 'var(--text-dim)' }}>
    {items.map(([k, t]) => <span key={k} style={{ whiteSpace: 'nowrap' }}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: C[k], verticalAlign: 'middle', marginRight: 4 }} />{t}</span>)}
  </span>
);
const SITE_N = 8;

function Capacity({ rows, em }) {
  const [all, setAll] = useState(false);
  const cap = capacityRows(rows, all ? 0 : 5);
  const pts = linePoints(em?.series30);
  const tr = em?.trend30 || null;
  const rw = repoWarn(em);
  return (
    <section className="card" aria-label="백업된 용량 — 법인별" data-backup-capacity="" style={{ ...card, flex: '5 1 380px' }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '4px 8px' }}>
        <b style={{ fontSize: 14 }}>백업된 용량 — 법인별</b>
        <span className="muted" style={{ fontSize: 12 }}>Veeam 복원 지점 합 · Bareos 마지막 실행 크기 합 · 큰 순</span>
      </div>
      <Legend items={[['veeam', 'Veeam'], ['bareos', 'Bareos']]} />
      {cap.items.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 150px) minmax(0, 1fr) auto', gap: '6px 10px', alignItems: 'center', fontSize: 12 }}>
          {cap.items.map((x) => (
            <React.Fragment key={x.id}>
              <span title={x.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{x.name}</span>
              <div role="img" aria-label={`${x.name} Veeam ${bytesText(x.v)} · Bareos ${bytesText(x.b)}`} style={{ display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden', background: 'var(--panel-deep)', minWidth: 0 }}>
                <span style={{ width: `${barPct(x.v, cap.max)}%`, background: C.veeam }} />
                <span style={{ width: `${barPct(x.b, cap.max)}%`, background: C.bareos }} />
              </div>
              <span style={{ textAlign: 'right', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }} title={x.partial ? '한쪽(Veeam · Bareos)을 못 읽어 부분 합' : undefined}>{bytesText(x.total)}{x.partial ? '*' : ''}</span>
            </React.Fragment>
          ))}
          {(cap.more > 0 || all) && <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ gridColumn: '1 / -1', justifySelf: 'start', padding: '2px 10px', fontSize: 11.5 }}>{all ? '5곳만 보기' : `… ${fmtNum(cap.more)}곳 더`}</button>}
        </div>
      ) : <div className="muted" style={{ fontSize: 12.5 }}>크기를 읽은 VM 이 없습니다 — Veeam 복원 지점 · Bareos 실행 크기를 아직 못 읽었거나 백업이 없습니다(0 이 아닙니다).</div>}
      <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 10, fontSize: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted">Veeam 저장소 사용 30일 추이(EM)</div>
          {pts ? <svg width="100%" height="44" viewBox="0 0 220 44" preserveAspectRatio="none" role="img" aria-label="Veeam 저장소 사용 30일 추이"><polyline fill="none" stroke="#22d3ee" strokeWidth="2" points={pts} /></svg>
            : <div className="muted" style={{ height: 44, display: 'flex', alignItems: 'center' }}>{em ? '이력이 이틀보다 적습니다' : 'EM 자료는 전체 범위 계정만 봅니다'}</div>}
          <div>{tr ? <>{bytesText(tr.before)} → {bytesText(tr.now)} <span style={{ color: tr.pct > 0 ? TONE.warn : TONE.ok }}>{tr.pct > 0 ? '+' : ''}{tr.pct}%</span></> : <span className="muted">30일 전 값 —</span>}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="muted">저장소 여유 경고</div>
          {rw ? <>
            <div style={{ color: TONE[rw.tone], fontWeight: 700 }}>{rw.head}</div>
            {rw.items.map((x) => <div key={x.text} className="muted" style={{ overflowWrap: 'anywhere' }}>{x.text} — {x.left}{x.vc ? ` · ${x.vc}` : ''}</div>)}
            {rw.more > 0 && <div className="muted">… {fmtNum(rw.more)}곳 더 — Veeam 메뉴</div>}
          </> : <div className="muted">EM 자료는 전체 범위 계정만 봅니다</div>}
          <div className="muted" title="Director 풀 · 볼륨 수집은 백업 메뉴 개편 2차에서 합니다">Bareos Full 풀 가득 참 —(2차 수집 뒤)</div>
        </div>
      </div>
    </section>
  );
}

function Lane({ items, from, color, full, top }) {
  return items.map((x, i) => {
    const b = barOf(x, from);
    if (!b) return null;
    return <span key={`${x.name}|${x.at}|${i}`} title={`${x.name} ${hm(x.at)}~${hm(x.end)}${x.est ? '(길이 추정 60분)' : ''}${x.vms ? ` · VM ${x.vms}` : ''}`}
      style={{ position: 'absolute', left: `${b.left}%`, width: `${b.width}%`, top, height: 6, borderRadius: 3, background: full && x.full ? C.full : color, opacity: x.est ? 0.75 : 1 }} />;
  });
}

function Schedule({ reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const gen = useRef(0);
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-summary/schedule')
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, []);
  useEffect(() => { load(); return () => { gen.current++; }; }, [load, reloadKey]);
  const from = hourStart(data?.at || Date.now());
  const rows = sortSchedRows(data?.rows);
  const shown = all ? rows : rows.slice(0, SITE_N);
  const overlaps = rows.filter((r) => r.overlap);
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <section className="card" aria-label="백업 스케줄 — 다음 24시간" data-backup-schedule="" style={{ ...card, flex: '7 1 560px' }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '4px 8px' }}>
        <b style={{ fontSize: 14 }}>백업 스케줄 — 다음 24시간</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>Veeam 잡 다음 실행(B&amp;R 결과) + Bareos 그룹 예약 · Director 스케줄은 2차 수집 뒤 · 이 브라우저 시각</span>
        <span style={{ marginLeft: 'auto' }}><Legend items={[['veeam', 'Veeam'], ['bareos', 'Bareos'], ['full', 'Full']]} /></span>
      </div>
      {error ? <div style={{ fontSize: 12.5, color: error?.status === 403 ? 'var(--text-dim)' : TONE.bad }}>{error?.status === 403 ? '이 계정은 Detail 화면이 허용되지 않아 잡 · 그룹 일정을 볼 수 없습니다.' : `일정을 읽지 못했습니다 — ${String(error?.message || error).slice(0, 160)}`}</div>
        : !data ? <div className="muted" style={{ fontSize: 12.5 }}>{loading ? '읽는 중…' : ''}</div>
          : <>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 560, display: 'grid', gridTemplateColumns: 'minmax(80px, 150px) minmax(0, 1fr)', gap: '4px 8px', fontSize: 11 }}>
                <span />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, minmax(0, 1fr))', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{hourLabels(from).map((h, i) => <span key={i}>{h}</span>)}</div>
                {shown.map((r) => {
                  const o = open.has(r.id);
                  return (
                    <React.Fragment key={r.id}>
                      <button type="button" aria-expanded={o} onClick={() => toggle(r.id)} title={`${r.name} — 잡 · 그룹별 줄로 ${o ? '접기' : '펼치기'}`}
                        style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{o ? '▾' : '▸'} {r.name}</button>
                      <div style={{ position: 'relative', height: 18, background: 'var(--panel-deep)', borderRadius: 4, ...(r.overlap ? { boxShadow: 'inset 0 0 0 1px rgba(245,158,11,.6)' } : {}) }}>
                        <Lane items={r.veeam || []} from={from} color={C.veeam} top={2} />
                        <Lane items={r.bareos || []} from={from} color={C.bareos} full top={10} />
                      </div>
                      {o && [...(r.veeam || []).map((x) => ['veeam', x]), ...(r.bareos || []).map((x) => ['bareos', x])].map(([k, x], i) => (
                        <React.Fragment key={`${k}|${x.name}|${x.at}|${i}`}>
                          <span className="muted" title={x.name} style={{ paddingLeft: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{x.name}</span>
                          <div style={{ position: 'relative', height: 10 }}><Lane items={[x]} from={from} color={C[k]} full={k === 'bareos'} top={2} /></div>
                        </React.Fragment>
                      ))}
                      {o && !(r.veeam?.length || r.bareos?.length) && <><span /><span className="muted">24시간 안 일정 없음{r.bareos == null ? ' · Bareos 그룹 모름' : ''}</span></>}
                    </React.Fragment>
                  );
                })}
                {!rows.length && <><span /><span className="muted">범위 안 법인이 없습니다.</span></>}
              </div>
            </div>
            {rows.length > SITE_N && <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ alignSelf: 'flex-start', padding: '2px 10px', fontSize: 11.5 }}>{all ? `${SITE_N}곳만 보기` : `… ${fmtNum(rows.length - SITE_N)}곳 더`}</button>}
            <div className="muted" style={{ fontSize: 11 }}>법인 이름을 누르면 그 법인의 잡 · 그룹별 줄로 펼칩니다 · 옅은 띠 = 길이를 몰라 60분으로 그린 것(Veeam 은 지난 실행 폭을 압니다){data.groupsUnreadable ? ' · Bareos 그룹 파일을 읽지 못해 Bareos 줄은 모름' : ''}</div>
            <div data-backup-week="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 6, fontSize: 11.5, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
              {(data.days || []).map((d, i) => (
                <div key={d.day} style={{ background: 'var(--panel-deep)', borderRadius: 8, padding: '6px 8px', minWidth: 0 }}>
                  <div className="muted">{dayLabel(d.day, i)}</div>
                  <b title={`Bareos 그룹 회차 ${d.groups} · VM ${d.gvms}`}>그룹 {fmtNum(d.groups)}</b>
                  <div className="muted">Veeam {d.veeam == null ? '—' : fmtNum(d.veeam)}</div>
                  <div style={{ color: d.full ? C.full : 'var(--text-dim)' }}>Full {fmtNum(d.full)}</div>
                </div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>7일 칸 = Bareos 그룹 회차 수 · Full 회차 수 · Veeam 잡 수(다음 실행이 그날인 것 — 다음 1회만 알아 오늘 · 내일 밖은 —)</div>
            {overlaps.length > 0 && (
              <div data-backup-overlap="" style={{ fontSize: 11.5, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
                겹침 경고: {overlaps.slice(0, 3).map((r) => <span key={r.id} style={{ color: TONE.warn }}>{overlapText(r)} · </span>)}
                {overlaps.length > 3 ? `외 ${overlaps.length - 3}곳 · ` : ''}동시 실행 상한에 걸려 대기가 길어지는 원인 후보(Bareos 진행 현황의 ‘대기 사유’ 와 함께 보세요)
              </div>
            )}
          </>}
    </section>
  );
}

export default function BackupSummaryCapSched({ rows, em, reloadKey }) {
  return (
    <div role="group" aria-label="용량과 일정" data-backup-capsched="" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, minWidth: 0 }}>
      <Capacity rows={rows} em={em} />
      <Schedule reloadKey={reloadKey} />
    </div>
  );
}
