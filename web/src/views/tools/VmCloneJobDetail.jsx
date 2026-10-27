import React, { useMemo, useState } from 'react';
import { postJson, canCsv } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { mountLabel } from './vmCloneMountText.js';
import {
  backupRuns, runTone, cloneBytes, fmtBytes, agoText, durText, execText, busyOp, KIND_LABEL, triggerText, keepText, HISTORY_FILTERS, historyFilter, historyCsv,
  rpoText, ganttRows, pointTimeline, progressOf,
} from './vmCloneView.js';

/**
 * VM 백업 센터 › 잡 상세(시안 ②, v2.793) — 복원 지점(검증·복구) · 세션 타임라인 · 세션 이력.
 * 검증·복구 버튼은 **그 사본만** 잠근다(진행 중 작업이 있는 대상만 — web.md '긴 작업의 진행 중 잠금').
 * 엣지 위임 잡의 원장·이력은 담당 엣지가 보고한 것이다 — 보고가 없으면 비어 있다고 단정하지 않고 '보고 없음' 이라 말한다.
 */
const MODE_LABEL = { manual: '수동만', daily: '매일', interval: '간격' };
const scheduleText = (s) => `${MODE_LABEL[s?.mode] || '수동만'}${s?.mode === 'daily' ? ` ${s.time}` : s?.mode === 'interval' ? ` ${s.hours}시간` : ''}`;
const fmtAt = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const mmdd = (ts) => { const x = new Date(ts); return `${String(x.getMonth() + 1).padStart(2, '0')}.${String(x.getDate()).padStart(2, '0')}`; };
/** 타임라인 눈금 — 겹치지 않게 앞 눈금과 minGap% 이상 떨어진 점에만 날짜를 단다(첫·끝은 항상). */
function tickIdx(points, minGap = 14) {
  const out = new Set(); let last = -Infinity;
  points.forEach((p, i) => { if (i === 0 || i === points.length - 1 || p.left - last >= minGap) { out.add(i); last = p.left; } });
  // 끝 눈금이 바로 앞 눈금과 겹치면 앞의 것을 뺀다
  const arr = [...out].sort((a, b) => a - b);
  if (arr.length > 2 && points[arr[arr.length - 1]].left - points[arr[arr.length - 2]].left < minGap) out.delete(arr[arr.length - 2]);
  return out;
}

export default function VmCloneJobDetail({ d, job, now, msg, busy, onBack, onRun, onEdit, onDelete, onRestore, onReload, setMsg }) {
  const [sel, setSel] = useState(null);      // 이력에서 고른 줄(타임라인)
  const [pending, setPending] = useState(''); // 방금 누른 사본 ref(응답 전 잠금)
  const [hf, setHf] = useState('all');        // v2.794 이력 필터
  const [pt, setPt] = useState('');           // v2.797 타임라인에서 고른 복원 지점
  const runs = backupRuns(job);
  const history = useMemo(() => [...(job.history || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), [job.history]);
  const shownHist = useMemo(() => historyFilter(history, hf), [history, hf]);
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob(['\ufeff' + historyCsv(job, shownHist)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `vm-backup-history-${String(job.vmName || job.id).replace(/[^A-Za-z0-9._-]/g, '_')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const clones = useMemo(() => [...(job.clones || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), [job.clones]);
  const b = cloneBytes(job.clones);
  const last30 = runs.slice(-30);
  const okN = last30.filter((h) => ['ok', 'warn'].includes(runTone(h))).length;
  const failN = last30.filter((h) => runTone(h) === 'fail').length;
  const lastOk = [...runs].reverse().find((h) => h.ok);
  const okMs = runs.filter((h) => h.ok && h.ms > 0).map((h) => h.ms);
  const avgMs = okMs.length ? okMs.reduce((a, x) => a + x, 0) / okMs.length : null;
  const isDs = job.dest?.type === 'datastore';
  const edgeNoReport = job.exec && job.exec.where === 'edge' && !job.exec.reported;
  const runningLocal = d.status?.running && d.status.running.jobId === job.id ? d.status.running : null;
  const running = runningLocal || (job.exec?.runningPhase ? { phase: job.exec.runningPhase, kind: job.exec.runningKind, startedAt: job.exec.runningSince } : null);
  const shown = sel || (running ? null : history[0]) || null;
  const gantt = ganttRows(!sel && running ? null : shown);
  const runPct = running ? progressOf(running.phase) : null;
  const tl = useMemo(() => pointTimeline(job.clones, now, 12), [job.clones, now]);
  const ticks = useMemo(() => tickIdx(tl.points), [tl]);
  const ptClone = clones.find((c) => c.ref === pt) || null;
  const ops = d.ops || [];

  const act = async (kind, ref) => {
    setPending(`${kind}:${ref}`); setMsg(null);
    try {
      const r = await postJson(`/tools/vm-clone/jobs/${encodeURIComponent(job.id)}/${kind}`, { ref });
      setMsg(r.ok ? (r.where === 'edge' ? `${KIND_LABEL[kind]} 요청을 담당 엣지(${r.agent})로 보냈습니다 — 엣지가 다음 동기화에 가져가 실행합니다.` : `${KIND_LABEL[kind]} 을(를) 실행 큐에 넣었습니다.`) : `${KIND_LABEL[kind]} 불가: ${r.reason}`);
      await onReload();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setPending(''); }
  };

  return (
    <div className="vbk">
      <div className="vbk-head">
        <div>
          <div className="vbk-crumb"><button type="button" onClick={onBack}>VM 백업</button> › 잡 상세</div>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8, marginTop: 2 }}>
            <h2 className="vbk-title" style={{ margin: 0 }}>{job.vmName}</h2>
            <span className={`vbk-chip ${isDs ? 'ds' : 'nfs'}`}>{isDs ? `${job.dest.nfsDsId ? 'NFS-DS' : 'DS'} · ${job.dest.datastoreName}` : `엣지 NFS · ${mountLabel((d.mounts || []).find((m) => m.id === job.dest.mountId)) || job.dest.mountId}`}</span>
            <span className={`vbk-chip ${job.quiesce ? 'ok' : ''}`} title={job.quiesce ? (job.quiesceFallback === false ? '정지점이 실패하면 그 회차는 실패' : '정지점이 실패하면 일반 스냅샷으로 백업(⚠)') : ''}>{job.quiesce ? `앱 정합(정지점${job.quiesceFallback === false ? ' · 필수' : ''})` : '크래시 정합'}</span>
            <span className="vbk-chip">보존 {keepText(job)}</span>
            {job.rpo ? <span className={`vbk-chip ${job.rpo.overdue ? 'warn' : 'ok'}`} title={job.rpo.overdue ? rpoText(job.rpo, now) : '마지막 성공이 스케줄 주기의 2배 + 1시간 안입니다'}>{job.rpo.overdue ? 'RPO 초과' : 'RPO 충족'}</span>
              : job.enabled !== false && <span className="vbk-chip" title="수동 실행만 하거나, 담당 엣지가 멈췄거나, 시작 시각을 몰라 판정하지 않습니다">RPO 판정 안 함</span>}
            {job.verifying && !running && <span className="vbk-chip warn" title="재시작으로 검증이 중단됐습니다 — 실행 노드가 다음 확인(1분 안팎)에 사본을 끄고 검증 전 상태로 되돌립니다. 그 전에는 새 검증·잡 삭제를 하지 않습니다.">중단된 검증 정리 대기</span>}
            {!job.enabled && <span className="vbk-chip warn">비활성</span>}
          </div>
          <div className="vbk-sub">{d.vcenterNames?.[job.vcenterId] || job.vcenterId} · {scheduleText(job.schedule)} · {isDs ? (job.verifyAfter ? '복제 후 자동 검증 켜짐' : '자동 검증 꺼짐') : '검증 해당 없음(파일 사본)'}{execText(job, now) ? ` · ${execText(job, now)}` : ''}</div>
        </div>
        <div className="vbk-actions">
          <button type="button" className="vbk-btn" onClick={onEdit}>수정</button>
          <button type="button" className="vbk-btn danger" disabled={busy} onClick={onDelete}>삭제</button>
          {isDs && clones[0] && <button type="button" className="vbk-btn" disabled={!!pending || !!busyOp(ops, job.id, 'verify', clones[0].ref)} onClick={() => act('verify', clones[0].ref)}>최신 지점 검증</button>}
          {isDs && <button type="button" className="vbk-btn" disabled={!clones.length} onClick={() => onRestore(clones[0]?.ref || '')}>복구…</button>}
          <button type="button" className="vbk-btn primary" disabled={busy || !job.enabled} onClick={onRun}>지금 실행</button>
        </div>
      </div>
      {msg && <div className="vbk-note info">{msg}</div>}
      {job.exec?.reason && <div className="vbk-note">{job.exec.reason}</div>}
      {job.exec?.problem && <div className="vbk-note">담당 엣지 보고: {job.exec.problem}</div>}
      {edgeNoReport && <div className="vbk-note info">담당 엣지 {job.exec.agent} 가 아직 이 잡의 상태를 보고하지 않았습니다 — 엣지가 이 판(VM 백업 위임)으로 올라가 있고 중앙과 통신하는지 확인하세요. 아래 원장·이력이 비어 있어도 '없다' 는 뜻이 아닙니다.</div>}

      <div className="vbk-kpis">
        <div className="vbk-kpi"><div className="l">마지막 성공</div><div className="v" style={{ fontSize: 20 }}>{lastOk ? agoText(lastOk.at, now) : '—'}</div><div className="m">{lastOk ? `${fmtAt(lastOk.at)} · ${durText(lastOk.ms)}` : '성공 기록 없음'}</div></div>
        <div className="vbk-kpi"><div className="l">최근 {last30.length || 30}회 성공</div><div className="v" style={{ fontSize: 20, color: failN ? 'var(--amber)' : last30.length ? 'var(--green)' : undefined }}>{last30.length ? `${okN} / ${last30.length}` : '—'}</div><div className="m">실패 {failN}{last30.length - okN - failN > 0 ? ` · 건너뜀 ${last30.length - okN - failN}` : ''}</div></div>
        <div className="vbk-kpi"><div className="l">평균 소요(성공)</div><div className="v" style={{ fontSize: 20 }}>{avgMs != null ? durText(avgMs) : '—'}</div><div className="m">이력에 남은 성공 {okMs.length}회 기준</div></div>
        <div className="vbk-kpi"><div className="l">복원 지점</div><div className="v" style={{ fontSize: 20 }}>{clones.length}<small>개</small></div><div className="m">{b.known ? `${fmtBytes(b.bytes)}${b.unknown ? ` + 크기 모름 ${b.unknown}` : ''}` : '크기 모름'}</div></div>
      </div>

      <div className="vbk-cols">
        <div className="vbk-main">
          <div className="vbk-panel">
            <div className="hd">
              <div className="vbk-sec">복원 지점 <small>{clones.length}개</small></div>
              <span className="muted" style={{ fontSize: 12 }}>오래된 것부터 자동 정리 · 포탈이 만든 사본(원장)만 지웁니다</span>
            </div>
            {tl.points.length > 0 && (
              <div className="bd" style={{ borderBottom: '1px solid var(--border-soft)', paddingBottom: 8 }}>
                <div className="vbk-tlh-wrap">
                  <div className="vbk-tlh" role="group" aria-label="복원 지점 타임라인">
                    <div className="axis" />
                    {tl.points.map((p, i) => (
                      <React.Fragment key={p.ref}>
                        <button type="button" className={`${p.tone}${p.latest ? ' latest' : ''}${pt === p.ref ? ' on' : ''}`} style={{ left: `${p.left}%` }}
                          aria-pressed={pt === p.ref} aria-label={`${fmtAt(p.at)} 복원 지점 · ${p.tone === 'ok' ? '부팅 확인' : p.tone === 'fail' ? '검증 실패' : '미검증'}`}
                          title={`${fmtAt(p.at)} · ${p.tone === 'ok' ? '부팅 확인' : p.tone === 'fail' ? '검증 실패' : '미검증'}${p.latest ? ' · 최신' : ''}`}
                          onClick={() => setPt(pt === p.ref ? '' : p.ref)} />
                        {ticks.has(i) && <span className={`lbl${p.left <= 3 ? ' first' : p.left >= 97 ? ' last' : ''}`} style={{ left: `${p.left}%` }}>{p.latest ? `${mmdd(p.at)} 최신` : mmdd(p.at)}</span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
                <div className="flex wrap" style={{ gap: '4px 14px', alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
                  <span><span className="vbk-dot ok" style={{ marginRight: 6 }} />부팅 확인</span>
                  <span><span className="vbk-dot fail" style={{ marginRight: 6 }} />검증 실패</span>
                  <span><span className="vbk-dot" style={{ marginRight: 6 }} />미검증</span>
                  <span><span className="vbk-dot" style={{ marginRight: 6, background: 'var(--accent)' }} />최신</span>
                  {clones.length > tl.points.length + tl.unknown && <span>최근 {tl.points.length}개만 표시</span>}
                  {tl.unknown > 0 && <span>시각 모르는 사본 {tl.unknown}개 제외</span>}
                  {ptClone && (
                    <span className="flex wrap" style={{ gap: 8, alignItems: 'center', marginLeft: 'auto', color: 'var(--text)' }}>
                      <b>{fmtAt(ptClone.at)}</b><span className="muted">{agoText(ptClone.at, now)} · {fmtBytes(ptClone.bytes)}</span>
                      {isDs && <button type="button" className="vbk-btn sm" onClick={() => onRestore(ptClone.ref)}>이 지점으로 복구</button>}
                    </span>
                  )}
                </div>
              </div>
            )}
            {!isDs && <div className="bd muted" style={{ fontSize: 12.5 }}>엣지 NFS 사본은 날짜 폴더(manifest.json)로 남습니다 — 켜서 검증하거나 이 화면에서 복구할 수 없습니다. 복구는 manifest.json 의 안내대로 데이터스토어에 올린 뒤 vmx 를 등록합니다.</div>}
            {isDs && (
              <div style={{ overflowX: 'auto' }}>
                <STable minWidth={720}>
                  <thead><tr><th>시점</th><th>사본 이름</th><th style={{ textAlign: 'right' }}>크기</th><th>검증</th><th className="right" data-nosort>작업</th></tr></thead>
                  <tbody>
                    {clones.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>{edgeNoReport ? '엣지 보고 없음' : '아직 복원 지점이 없습니다'}</td></tr>}
                    {clones.map((c) => {
                      const vBusy = busyOp(ops, job.id, 'verify', c.ref);
                      return (
                        <tr key={c.ref} style={pt === c.ref ? { background: 'rgba(59,130,246,.10)' } : undefined}>
                          <td data-sort={c.at}><div style={{ fontWeight: 600 }}>{fmtAt(c.at)}</div><div className="muted" style={{ fontSize: 11.5 }}>{agoText(c.at, now)}</div></td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{c.name}</td>
                          <td style={{ textAlign: 'right' }} data-sort={c.bytes ?? ''}>{fmtBytes(c.bytes)}</td>
                          <td>{vBusy ? <span className="vbk-chip warn">검증 중</span> : c.verify ? <span className={`vbk-chip ${c.verify.ok ? 'ok' : 'fail'}`} title={c.verify.detail}>{c.verify.ok ? '부팅 확인' : '검증 실패'}</span> : <span className="vbk-chip">미검증</span>}</td>
                          <td className="right" style={{ whiteSpace: 'nowrap' }}>
                            <button type="button" className="vbk-btn sm" disabled={!!vBusy || pending === `verify:${c.ref}`} onClick={() => act('verify', c.ref)}>검증</button>
                            {' '}<button type="button" className="vbk-btn sm" onClick={() => onRestore(c.ref)}>이 지점으로 복구</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
            )}
          </div>
        </div>

        <div className="vbk-side">
          <div className="vbk-panel">
            <div className="hd">
              <div className="vbk-sec">{sel ? `세션 · ${fmtAt(sel.at)}` : running ? '세션 · 지금' : shown ? `세션 · ${fmtAt(shown.at)}` : '세션'}</div>
              {sel ? <button type="button" className="vbk-btn sm" onClick={() => setSel(null)}>최근으로</button>
                : running ? <span className="vbk-chip warn">실행 중</span>
                  : shown ? <span className={`vbk-chip ${runTone(shown) === 'ok' ? 'ok' : runTone(shown) === 'fail' ? 'fail' : 'warn'}`}>{KIND_LABEL[shown.kind || 'backup']}</span> : null}
            </div>
            <div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* v2.797 단계 간트 — 끝난 실행은 단계별 소요를 누적 위치로, 진행 중이면 지금 단계만(앞 단계의 소요는 실행이 끝나야 남는다) */}
              {!sel && running ? (
                <div className="vbk-gantt">
                  <div>
                    <span className="nm" title={running.phase}>{String(running.phase || '단계 보고 전').slice(0, 160).replace(/\s*·\s*\d{1,3}%$/, '')}</span>
                    <span className="tr" title={runPct == null ? '이 단계는 진행률을 보고하지 않습니다' : `${runPct}%`}>{runPct == null ? <b className="indet" /> : <b className="running" style={{ left: 0, width: `${runPct}%` }} />}</span>
                    <span className="t">{runPct == null ? '진행 중' : `${runPct}%`}</span>
                  </div>
                </div>
              ) : gantt.rows.length === 0 ? (
                <div className="muted" style={{ fontSize: 12.5 }}>{shown ? '단계 기록이 없는 실행입니다(이전 판에서 실행).' : '아직 실행 기록이 없습니다.'}</div>
              ) : (
                <div className="vbk-gantt">
                  {gantt.rows.map((r, i) => (
                    <div key={i}>
                      <span className="nm" title={r.name}>{r.name}</span>
                      <span className="tr">{r.width > 0 && <b className={r.state === 'fail' ? 'fail' : ''} style={{ left: `${r.left}%`, width: `${r.width}%` }} />}</span>
                      <span className="t" style={r.state === 'fail' ? { color: '#fca5a5' } : undefined}>{r.ms == null ? '—' : durText(r.ms)}</span>
                    </div>
                  ))}
                </div>
              )}
              {!(!sel && running) && gantt.totalMs > 0 && <div className="flex between" style={{ fontSize: 12, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)', paddingTop: 7 }}><span>단계 합계</span><span style={{ fontFamily: 'var(--mono)' }}>{durText(gantt.totalMs)}</span></div>}
              {!sel && running?.startedAt ? <div className="muted" style={{ fontSize: 12 }}>시작 {fmtAt(running.startedAt)} · {durText(now - running.startedAt)}째</div> : null}
              {shown?.detail && !(!sel && running) && <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{shown.detail}</div>}
            </div>
          </div>
          <div className="vbk-panel">
            <div className="hd flex wrap" style={{ gap: 8 }}>
              <div className="vbk-sec" style={{ minWidth: 0 }}>세션 이력 <small>{hf === 'all' ? `${history.length}건` : `${shownHist.length} / ${history.length}건`}</small></div>
              <div className="flex wrap" style={{ gap: 4, marginLeft: 'auto' }}>
                {HISTORY_FILTERS.map(([k, label]) => <button type="button" key={k} className={`vbk-btn sm${hf === k ? ' primary' : ''}`} aria-pressed={hf === k} onClick={() => { setHf(k); setSel(null); }}>{label}</button>)}
                {/* v2.643 규약: CSV 내보내기는 관리자 이상 + 'CSV 가져오기/내보내기' 권한(canCsv)일 때만 보인다 — 화면에서 만드는 CSV 도 같다. */}
                {canCsv() && <button type="button" className="vbk-btn sm" disabled={!shownHist.length} onClick={exportCsv} title="보이는 이력을 CSV 로 내려받습니다(엑셀에서 열림)">CSV</button>}
              </div>
            </div>
            {shownHist.length === 0 && <div className="bd muted" style={{ fontSize: 12.5 }}>{history.length ? '이 조건의 기록이 없습니다' : edgeNoReport ? '엣지 보고 없음' : '기록 없음'}</div>}
            {shownHist.slice(0, 30).map((h, i) => (
              <button type="button" key={i} className="vbk-sess" style={{ width: '100%', background: sel === h ? 'rgba(59,130,246,.10)' : 'transparent', border: 0, borderTop: i ? '1px solid var(--border-soft)' : 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={() => setSel(h)}>
                <span className={`vbk-dot ${runTone(h)}`} style={{ marginTop: 5 }} />
                <div>
                  <div className="flex between" style={{ gap: 8 }}><b>{KIND_LABEL[h.kind || 'backup']}{h.trigger ? <span className="muted" style={{ fontWeight: 400 }}> · {triggerText(h.trigger)}</span> : null}</b><span className="t">{fmtAt(h.at)}</span></div>
                  <div className="d">{h.detail}{h.ms ? ` · ${durText(h.ms)}` : ''}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
