import React, { useMemo, useState } from 'react';
import { postJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { mountLabel } from './vmCloneMountText.js';
import {
  backupRuns, runTone, cloneBytes, fmtBytes, agoText, durText, execText, phaseRows, busyOp, KIND_LABEL, triggerText,
} from './vmCloneView.js';

/**
 * VM 백업 센터 › 잡 상세(시안 ②, v2.793) — 복원 지점(검증·복구) · 세션 타임라인 · 세션 이력.
 * 검증·복구 버튼은 **그 사본만** 잠근다(진행 중 작업이 있는 대상만 — web.md '긴 작업의 진행 중 잠금').
 * 엣지 위임 잡의 원장·이력은 담당 엣지가 보고한 것이다 — 보고가 없으면 비어 있다고 단정하지 않고 '보고 없음' 이라 말한다.
 */
const MODE_LABEL = { manual: '수동만', daily: '매일', interval: '간격' };
const scheduleText = (s) => `${MODE_LABEL[s?.mode] || '수동만'}${s?.mode === 'daily' ? ` ${s.time}` : s?.mode === 'interval' ? ` ${s.hours}시간` : ''}`;
const fmtAt = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default function VmCloneJobDetail({ d, job, now, msg, busy, onBack, onRun, onEdit, onDelete, onRestore, onReload, setMsg }) {
  const [sel, setSel] = useState(null);      // 이력에서 고른 줄(타임라인)
  const [pending, setPending] = useState(''); // 방금 누른 사본 ref(응답 전 잠금)
  const runs = backupRuns(job);
  const history = useMemo(() => [...(job.history || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), [job.history]);
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
  const rows = phaseRows(shown || { phases: [] }, !sel && running ? running : null);
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
            <span className={`vbk-chip ${job.quiesce ? 'ok' : ''}`}>{job.quiesce ? '앱 정합(정지점)' : '크래시 정합'}</span>
            <span className="vbk-chip">보존 {job.keep}개</span>
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
                        <tr key={c.ref}>
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
            <div className="bd">
              {rows.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>{shown ? '단계 기록이 없는 실행입니다(이전 판에서 실행).' : '아직 실행 기록이 없습니다.'}</div>}
              <div className="vbk-tl">
                {rows.map((r, i) => (
                  <div key={i}>
                    <div className="rail"><i className={r.state} />{i < rows.length - 1 && <b />}</div>
                    <div className="body"><span>{r.name}</span><span>{r.ms == null ? '진행 중' : durText(r.ms)}</span></div>
                  </div>
                ))}
              </div>
              {shown?.detail && <div className="muted" style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>{shown.detail}</div>}
            </div>
          </div>
          <div className="vbk-panel">
            <div className="hd"><div className="vbk-sec">세션 이력 <small>{history.length}건</small></div></div>
            {history.length === 0 && <div className="bd muted" style={{ fontSize: 12.5 }}>{edgeNoReport ? '엣지 보고 없음' : '기록 없음'}</div>}
            {history.slice(0, 30).map((h, i) => (
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
