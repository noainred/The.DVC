/**
 * Backup › Summary '통합 에러 로그'(v2.838 — 시안 ① 맨 아래 구획).
 *   GET /tools/backup-summary/errors?days=1|7|30 — Veeam VM 마지막 결과 · EM 세션(전체 범위 계정만) · Bareos 원장의 끝난 실행 · 멈춤 의심(진행 현황이 신선할 때만) ·
 *   포탈 수집 오류를 서버가 한 모양으로 모은다(veeam/backupErrors.js). 화면은 거르고 그린다.
 *   무거운 집계라 폴링하지 않는다 — 처음 한 번 · 기간을 바꿀 때 · 위 '새로고침'(reloadKey) 때만 · 늦게 온 이전 응답은 버린다.
 *   오류 원문은 관리자 판본만(서버가 가린다) · joblog 원문은 열기(Bareos 실행 이력)에서.
 *   v2.871(시안 docs/design/bareos-errlog · 사용자 컨펌 2026-11-04): Bareos 실행 행의 [로그] = 이 화면의 서랍(BackupErrorDrawer — 운영 화면과 같은 작업 로그 본문) ·
 *   [이력 →] = 진행 · 이력에서 그 VM · jobid 를 연 채로(예전 고정 주소는 대상 목록의 첫 VM 을 보였다) · 보기 [따로 보기 | 묶어 보기](서버 묶음 id) · 묶음 로그(첫 오류 줄 대조).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, hasRole, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum } from './backupViewText.js';
import { ERROR_KIND, ERROR_SRC, ERROR_DAY_OPTS, filterErrors, errorTarget, errorOpen, errorHistory, canOpenLog, sameText, mdhm,
  ERROR_VIEWS, loadErrorView, saveErrorView, groupErrors, groupTimeText, sortGroups } from './backupSummaryPlan.js';
import { ErrorLogDrawer, BulkLogDrawer } from './BackupErrorDrawer.jsx';
import { saveRunFocus } from './bareosViewText.js';

const PAD = { padding: '8px 8px' };
const Pill = ({ s, children }) => <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>{children ?? s.text}</span>;
const linkBtn = { background: 'none', border: 0, padding: 0, color: '#93c5fd', font: 'inherit', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' };
const CHIP = { padding: '3px 12px', fontSize: 12, fontWeight: 700 };
const KINDS = [['', '전체', 'all'], ['fail', '실패', 'fail'], ['warn', '경고', 'warn'], ['stuck', '멈춤 의심', 'stuck'], ['volume', '오류 볼륨', 'volume'], ['collect', '수집 오류', 'collect']];   // v2.840 오류 볼륨(정책 수집본)

export default function BackupSummaryErrors({ reloadKey, onOpenDetail }) {
  const [days, setDays] = useState(1);
  const [kind, setKind] = useState('');
  const [src, setSrc] = useState('');
  const [all, setAll] = useState(false);
  const [data, setData] = useState(null);
  const [view, setView0] = useState(() => loadErrorView());
  const setView = (v) => { setView0(v); saveErrorView(v); };
  const [open, setOpen] = useState(() => new Set());   // 묶어 보기에서 펼친 묶음 id
  const [gsort, setGsort] = useState({ key: 'time', dir: 'desc' });   // 묶어 보기 정렬(묶음 단위)
  // 서랍 — { kind:'log', list, index, scope } 또는 { kind:'bulk', group }. 거르기 · 기간을 바꾸면 닫는다(목록이 바뀐다).
  const [drawer, setDrawer] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-summary/errors', { days: String(days) })
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, [days]);
  useEffect(() => { load(); return () => { gen.current++; }; }, [load, reloadKey]);

  const c = data?.counts || {};
  const rows = filterErrors(data?.rows, { kind, src });
  const dayText = (ERROR_DAY_OPTS.find(([d]) => d === (data?.days || days)) || [0, '24시간'])[1];
  const opt = { canBareos: toolAllowed('bareos-backup'), canBareosView: toolAllowed('bareos-summary'), admin: hasRole('admin') };
  const go = (r, o) => { if (o.key === 'detail') onOpenDetail?.(r.vc); else window.location.hash = o.hash; };
  const groups = view === 'groups' ? sortGroups(groupErrors(rows), gsort) : null;
  const GH = [['time', '시각(처음 ~ 마지막)'], ['corp', '법인'], ['src', '솔루션'], ['target', '대상'], ['kind', '결과'], ['msg', '메시지(요약)'], ['n', '건수']];
  const sortBy = (k) => setGsort((g0) => (g0.key === k ? { key: k, dir: g0.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'time' || k === 'n' ? 'desc' : 'asc' }));
  // 따로 보기의 [로그] — ‹ › 로 옮길 목록은 지금 거른 행 중 로그를 읽을 수 있는 것 · 묶어 보기의 낱건은 그 묶음
  const openLog = (r, list = rows, scope = '이 목록') => {
    const L = list.filter(canOpenLog);
    const i = L.findIndex((x) => x === r);
    if (i >= 0) setDrawer({ kind: 'log', list: L, index: i, scope });
  };
  const goHistory = (r) => { saveRunFocus(r.vc, r.vmId, r.jobid); window.location.hash = '#/tools/bareos-backup/runs'; };
  const toggle = (id) => setOpen((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  useEffect(() => { setDrawer(null); }, [kind, src, days, view]);
  const isOpen = (r) => drawer?.kind === 'log' && drawer.list[drawer.index] === r;
  const actions = (r) => {
    const o = errorOpen(r, opt); const h = errorHistory(r, opt);
    if (!o) return <span className="muted">—</span>;
    return (
      <div className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
        {o.key === 'log'
          ? <button type="button" className={isOpen(r) ? 'login-btn' : 'logout-btn'} aria-pressed={isOpen(r)} onClick={() => openLog(r)} style={{ padding: '3px 10px', fontSize: 12 }}>{isOpen(r) ? '로그 열림' : '로그'}</button>
          : <button type="button" onClick={() => go(r, o)} style={linkBtn}>{o.text}</button>}
        {h && <button type="button" onClick={() => goHistory(r)} style={linkBtn} title="진행 · 이력에서 이 VM · 이 실행의 로그를 연 채로">{h.text}</button>}
      </div>
    );
  };

  return (
    <section className="card" aria-label="통합 에러 로그" data-backup-errors="" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 8px', padding: '12px 14px', borderBottom: '1px solid var(--border-soft)' }}>
        <b style={{ fontSize: 14 }}>통합 에러 로그 — 최근 {dayText}</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>Veeam(VM 마지막 결과 · EM 세션) + Bareos(실패 · 경고 · 취소 실행 · 멈춤 의심 · 오류 볼륨) + 포탈 수집 오류 · 같은 모양으로</span>
        <div className="flex wrap" role="group" aria-label="거르기" style={{ marginLeft: 'auto', gap: 6 }}>
          {KINDS.filter(([k]) => (k !== 'stuck' || c.stuck > 0) && (k !== 'volume' || c.volume > 0)).map(([k, t, ck]) => (
            <button key={k || 'all'} type="button" className={`tab${kind === k ? ' active' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)} style={CHIP}>{t} {data ? fmtNum(c[ck] ?? 0) : ''}</button>
          ))}
          {[['veeam', 'Veeam'], ['bareos', 'Bareos']].map(([k, t]) => (
            <button key={k} type="button" className={`tab${src === k ? ' active' : ''}`} aria-pressed={src === k} onClick={() => setSrc((v) => (v === k ? '' : k))} title={`${t} 만(다시 누르면 둘 다)`} style={CHIP}>{t}</button>
          ))}
          <div className="flex" role="group" aria-label="보기" style={{ gap: 0, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {ERROR_VIEWS.map(([k, t]) => (
              <button key={k} type="button" className={`tab${view === k ? ' active' : ''}`} aria-pressed={view === k} onClick={() => setView(k)} style={{ ...CHIP, borderRadius: 0, border: 0 }}>
                {t}{k === 'groups' && data ? ` ${fmtNum(groupErrors(rows).length)}` : ''}
              </button>
            ))}
          </div>
          <Select className="input" sort={false} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} aria-label="기간" style={{ minWidth: 0, width: 'auto', fontSize: 12 }}>
            {ERROR_DAY_OPTS.map(([d, t]) => <option key={d} value={String(d)}>{t}</option>)}
          </Select>
        </div>
      </div>
      {error ? <div style={{ padding: '10px 14px', fontSize: 12.5, color: error?.status === 403 ? 'var(--text-dim)' : '#fca5a5' }}>{error?.status === 403 ? '이 계정은 Detail 화면이 허용되지 않아 VM 별 에러 로그를 볼 수 없습니다.' : `읽지 못했습니다 — ${String(error?.message || error).slice(0, 160)}`}</div>
        : !data ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{loading ? '읽는 중…' : ''}</div>
          : rows.length && view === 'groups' ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 1000, width: '100%' }} data-err-groups="">
                <thead><tr>{GH.map(([k, h]) => (
                  <th key={k} style={{ ...PAD, ...(k === 'msg' ? { minWidth: 280 } : {}) }} aria-sort={gsort.key === k ? (gsort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => sortBy(k)} style={{ background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}>{h}{gsort.key === k ? (gsort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                  </th>
                ))}<th style={PAD}>열기</th></tr></thead>
                <tbody>
                  {groups.slice(0, all ? groups.length : 50).map((g) => {
                    const r = g.head; const s = r.src === 'collect' ? ERROR_SRC.collect : ERROR_SRC[r.src] || ERROR_SRC.collect;
                    const isOpenG = open.has(g.id);
                    const bulkOn = drawer?.kind === 'bulk' && drawer.group.id === g.id;
                    return (
                      <React.Fragment key={g.id}>
                        <tr style={{ background: 'var(--panel-deep)', ...(isOpenG || bulkOn ? { boxShadow: 'inset 3px 0 0 var(--accent)' } : {}) }}>
                          <td style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{groupTimeText(g)}</td>
                          <td style={PAD}><div title={r.vcName || ''} style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vcName || <span className="muted">—</span>}</div></td>
                          <td style={PAD}><Pill s={s} /></td>
                          <td style={{ ...PAD, fontSize: 12 }}><div style={{ maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.target}><b>{g.target}</b>{g.n > 1 && g.vms > 1 ? <span className="muted"> {fmtNum(g.vms)}대</span> : null}</div></td>
                          <td style={PAD}><Pill s={ERROR_KIND[r.kind] || ERROR_KIND.collect} /></td>
                          <td style={{ ...PAD, fontSize: 12 }}><div style={{ minWidth: 260, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{r.msg}</div></td>
                          <td style={{ ...PAD, whiteSpace: 'nowrap' }}><span style={{ display: 'inline-flex', minWidth: 22, justifyContent: 'center', padding: '1px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 800, background: g.n > 1 ? 'var(--accent)' : 'var(--border)', color: g.n > 1 ? '#fff' : 'var(--text-dim)' }}>{fmtNum(g.n)}</span></td>
                          <td style={PAD}>
                            <div className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
                              {g.n > 1 && <button type="button" className="logout-btn" aria-expanded={isOpenG} onClick={() => toggle(g.id)} style={{ padding: '3px 10px', fontSize: 12 }}>{isOpenG ? '접기 ▴' : '펼치기 ▾'}</button>}
                              {g.runs > 1 ? <button type="button" className={bulkOn ? 'login-btn' : 'logout-btn'} aria-pressed={bulkOn} onClick={() => setDrawer({ kind: 'bulk', group: g })} style={{ padding: '3px 10px', fontSize: 12 }} title="이 묶음의 로그를 차례로 읽어 첫 오류 줄을 대조합니다">{bulkOn ? '묶음 로그 열림' : '묶음 로그'}</button>
                                : g.n === 1 ? actions(r) : null}
                            </div>
                          </td>
                        </tr>
                        {isOpenG && g.rows.map((m, k) => {
                          const tg = errorTarget(m);
                          return (
                            <tr key={`${g.id}|${k}`} style={isOpen(m) ? { background: 'rgba(59,130,246,.10)' } : undefined}>
                              <td style={{ ...PAD, paddingLeft: 26, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{mdhm(m.at)}</td>
                              <td style={PAD} /><td style={PAD} />
                              <td style={{ ...PAD, fontSize: 12 }}><div style={{ maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[tg.main, tg.sub].filter(Boolean).join(' · ')}>{tg.main}{tg.sub ? <span className="muted"> {tg.sub}</span> : null}</div></td>
                              <td style={PAD}><Pill s={ERROR_KIND[m.kind] || ERROR_KIND.collect} /></td>
                              <td className="muted" style={{ ...PAD, fontSize: 12 }}>{m.msg}</td>
                              <td style={PAD} />
                              <td style={PAD}>{(() => { const o = errorOpen(m, opt); const h = errorHistory(m, opt);
                                if (!o) return <span className="muted">—</span>;
                                return (
                                  <div className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
                                    {o.key === 'log' ? <button type="button" className={isOpen(m) ? 'login-btn' : 'logout-btn'} onClick={() => openLog(m, g.rows, '이 묶음')} style={{ padding: '3px 10px', fontSize: 12 }}>{isOpen(m) ? '로그 열림' : '로그'}</button>
                                      : <button type="button" onClick={() => go(m, o)} style={linkBtn}>{o.text}</button>}
                                    {h && <button type="button" onClick={() => goHistory(m)} style={linkBtn}>{h.text}</button>}
                                  </div>
                                ); })()}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : rows.length ? (
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={1000} limit={all ? 0 : 50}>
                <thead><tr>{['시각', '법인', '솔루션', '대상(잡 · VM)', '결과'].map((h) => <th key={h} style={PAD}>{h}</th>)}<th style={{ ...PAD, minWidth: 280 }}>메시지(요약 — 원문은 열기)</th><th style={PAD} title="같은 모양 = 법인 · 결과 · 레벨 · 오류 수가 같고 1시간 안(Bareos) · 같은 원인인지는 묶어 보기의 묶음 로그가 대조합니다">같은 모양</th><th data-nosort style={PAD}>열기</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const tg = errorTarget(r);
                    const s = r.src === 'collect' ? ERROR_SRC.collect : ERROR_SRC[r.src] || ERROR_SRC.collect;
                    return (
                      <tr key={`${r.at}|${r.src}|${r.vmId || r.uid || r.job}|${r.jobid || ''}|${i}`} style={isOpen(r) ? { background: 'rgba(59,130,246,.10)', boxShadow: 'inset 3px 0 0 var(--accent)' } : undefined}>
                        <td data-sort={r.at} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{mdhm(r.at)}</td>
                        <td data-sort={r.vcName || ''} style={PAD}><div title={r.vcName || ''} style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vcName || <span className="muted">—</span>}</div></td>
                        <td data-sort={s.text} style={PAD}><Pill s={s} />{r.src === 'collect' && r.via ? <span className="muted" style={{ fontSize: 11 }}> {r.via === 'bareos' ? 'Bareos' : 'Veeam'}</span> : null}</td>
                        <td data-sort={tg.main} style={{ ...PAD, fontSize: 12 }}><div style={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[tg.main, tg.sub].filter(Boolean).join(' · ')}><b>{tg.main}</b>{tg.sub ? <span className="muted"> {tg.sub}</span> : null}</div></td>
                        <td data-sort={r.kind} style={PAD}><Pill s={ERROR_KIND[r.kind] || ERROR_KIND.collect} /></td>
                        <td style={{ ...PAD, fontSize: 12 }}><div style={{ minWidth: 260, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{r.msg}</div></td>
                        <td data-sort={r.same ?? 0} style={{ ...PAD, whiteSpace: 'nowrap', fontSize: 12 }}>{sameText(r.same)}</td>
                        <td style={PAD}>{actions(r)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 13 }}>{c.all ? '거른 조건에 맞는 항목이 없습니다.' : `최근 ${dayText} 동안 실패 · 경고 · 수집 오류가 없습니다(읽은 출처 기준 — 아래 안내).`}</div>}
      {view === 'groups' && groups && groups.length > 50 && (
        <div className="flex" style={{ padding: '6px 14px', fontSize: 12, alignItems: 'center', gap: 8 }}>
          <span className="muted">{fmtNum(groups.length)}묶음 중 {fmtNum(all ? groups.length : 50)}묶음</span>
          <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{all ? '50묶음만 보기' : '전부 보기'}</button>
        </div>
      )}
      {view === 'rows' && rows.length > 50 && (
        <div className="flex" style={{ padding: '6px 14px', fontSize: 12, alignItems: 'center', gap: 8 }}>
          <span className="muted">{fmtNum(rows.length)}건 중 {fmtNum(all ? rows.length : 50)}건 · 열 제목으로 정렬</span>
          <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{all ? '50건만 보기' : '전부 보기'}</button>
        </div>
      )}
      {data && (
        <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, borderTop: '1px solid var(--border-soft)', lineHeight: 1.6 }}>
          {data.truncated ? `서버가 새것부터 ${fmtNum(data.rows.length)}건만 보냈습니다(수는 전부 셉니다) · ` : ''}
          Veeam VM = 그 VM 의 마지막 task 결과만(그 앞 실패는 B&amp;R 결과에 없습니다) · EM 세션 = {data.sources?.em ? 'EM 이 읽은 최근 실패 · 경고 세션(EM 이 최근 7일만 읽습니다)' : '전체 범위 계정만 봅니다'} ·
          Bareos = 포탈 원장의 끝난 실행(잡마다 최근 5건 — joblog 원문은 실행 이력에서) · 멈춤 의심 = Bareos 진행 현황이 최근 조회된 법인만 ·
          로그 = 그 실행의 작업 로그를 Director 에서 읽어 옆 서랍에(엣지 대행 법인은 엣지가 대신) · 이력 → = 진행 · 이력에서 그 VM · 그 실행을 골라 엽니다 ·
          같은 모양 = Bareos 는 법인 · 결과 · 레벨 · 오류 수가 같고 1시간 안인 실행 수(그 밖은 출처 · 결과 · 잡 · 메시지 앞머리) — 같은 원인인지는 묶어 보기의 묶음 로그가 첫 오류 줄로 대조합니다{data.bareosUnknownSites ? ` · Bareos 원장을 못 읽은 법인 ${fmtNum(data.bareosUnknownSites)}곳은 Bareos 행이 없습니다(모름)` : ''}.
        </div>
      )}
      {drawer?.kind === 'log' && <ErrorLogDrawer list={drawer.list} index={drawer.index} onIndex={(i) => setDrawer((d0) => (d0 ? { ...d0, index: i } : d0))} onClose={() => setDrawer(null)} limits={data?.relayLimits || null} canBareos={opt.canBareos} scope={drawer.scope} />}
      {drawer?.kind === 'bulk' && <BulkLogDrawer group={drawer.group} onClose={() => setDrawer(null)} limits={data?.relayLimits || null}
        onOpenRow={(r) => openLog(r, drawer.group.rows, '이 묶음')} />}
    </section>
  );
}
