/**
 * views/VeeamParts.jsx — vCenter › VM 및 폴더 'Veeam 백업 VM 표시'(v2.751)의 화면 조각.
 *
 * 사용자 결정(Claude Design 시안 검토, 2026-10-22):
 *  ① 체크하면 요약 카드를 보이고, 체크하지 않으면 요약을 포함한 Veeam 관련 표시를 하나도 그리지 않는다(VCenterDetail 이 판정).
 *  ② '백업 중' 배지에 진행 막대.
 *  ③ 'Veeam' 배지에 백업 완료 날짜·시간을 붙이고, 배지를 누르면 백업 상세 창(복원 지점·용량·마지막 결과·작업·백업 체인)을 띄운다.
 * 문구·판정은 순수 모듈 veeamBadge.js 가 소유한다(vitest 고정). 상세는 주기 수집해 둔 값(/api/veeam/vm-detail — Veeam 왕복 없음).
 * ⚠ 훅은 조기 return 위에(React #310). 표는 STable. 백틱 금지(BoldText 는 **만 해석).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { Modal } from '../components/Modal.jsx';
import { ErrorBox, Loading } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { veeamBadge, veeamDetailView, sizeText, resultLabel, fmtTime } from './veeamBadge.js';

const TONE = {
  green: { bg: 'rgba(34,197,94,.15)', fg: '#4ade80' },
  amber: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24' },
  blue: { bg: 'rgba(59,130,246,.15)', fg: '#60a5fa' },
  muted: { bg: 'rgba(139,155,180,.12)', fg: 'var(--text-dim)' },
};
const fmt = (ms) => fmtTime(ms) || '—';

/** 진행 막대(배지·상세 창 공용). 진행률을 모르면 그리지 않는다(0% 막대를 지어내지 않는다). */
function ProgressBar({ pct, width = 36, height = 4 }) {
  if (!Number.isFinite(pct)) return null;
  return (
    <span aria-hidden="true" style={{ display: 'inline-block', width, height, borderRadius: 3, background: 'rgba(251,191,36,.25)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', height, width: `${Math.max(0, Math.min(100, pct))}%`, background: '#fbbf24' }} />
    </span>
  );
}

/** VM 행의 Veeam 배지 — 누르면 상세 창. 행(Leaf) 클릭(VM 상세)으로 번지지 않게 막는다. */
export function VeeamTag({ vm, veeam, onOpen }) {
  const vb = veeam ? veeamBadge(veeam[vm.id]) : null;
  if (!vb) return null;
  const t = TONE[vb.color] || TONE.green;
  return (
    <button type="button" className="veeam-tag" title={vb.title} aria-label={`${vm.name} Veeam 백업 상세 — ${vb.label}`}
      onClick={(e) => { e.stopPropagation(); onOpen?.(vm); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 4, padding: '2px 9px', borderRadius: 20, border: 'none', cursor: 'pointer',
        fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', background: t.bg, color: t.fg, fontFamily: 'inherit', lineHeight: 1.6 }}>
      {vb.label}
      <ProgressBar pct={vb.progress} />
    </button>
  );
}

/** 요약 카드(체크했을 때만 VCenterDetail 이 그린다). */
export function VeeamSummaryCard({ sum }) {
  if (!sum || (!sum.text && !sum.stats)) return null;
  if (!sum.stats) {
    return <div style={{ margin: '0 0 10px', fontSize: 12, lineHeight: 1.6, color: sum.tone === 'warn' ? 'var(--amber)' : 'var(--text-dim)', minWidth: 0, overflowWrap: 'anywhere' }}>{sum.text}</div>;
  }
  const st = sum.stats;
  const stat = (label, val, color, tail) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color }}>{val}</span>
      {tail && <span className="muted" style={{ fontSize: 12 }}>{tail}</span>}
    </div>
  );
  const chip = (label, tone) => <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: TONE[tone].bg, color: TONE[tone].fg, whiteSpace: 'nowrap' }}>{label}</span>;
  return (
    <div style={{ margin: '0 0 10px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 28px', minWidth: 0 }}>
          {stat('백업 대상', st.total, '#4ade80', st.vmTotal != null ? `/ ${st.vmTotal} VM` : 'VM')}
          {stat('지금 백업 중', st.running, '#fbbf24')}
          {stat('대기', st.pending, '#60a5fa')}
          <div className="muted" style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, fontSize: 12, minWidth: 0, textAlign: 'right' }}>
            {sum.source && <span>{sum.source}{sum.demo ? ' (데모 데이터)' : ''}</span>}
            {sum.basis && <span>{sum.basis}</span>}
          </div>
        </div>
        <div className="muted" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', paddingTop: 10, borderTop: '1px solid var(--border-soft)', fontSize: 12, minWidth: 0 }}>
          {chip('Veeam 10-22 01:12', 'green')}<span>백업 대상 · 마지막 백업 완료 시각</span>
          {chip('백업 중 28%', 'amber')}<span>지금 백업하고 있음</span>
          {chip('대기', 'blue')}<span>실행 중인 작업에서 차례를 기다림</span>
          <span style={{ flex: '1 1 260px', minWidth: 0 }}>배지를 누르면 백업 상세가 열립니다. 배지가 없는 VM 은 백업 여부가 확인되지 않은 것입니다(백업 안 됨이 아닙니다).</span>
        </div>
        {sum.details.length > 0 && (
          <details className="muted" style={{ fontSize: 12 }}>
            <summary style={{ cursor: 'pointer' }}>자세히({sum.details.length})</summary>
            <ul style={{ margin: '4px 0 0 18px', padding: 0, lineHeight: 1.6 }}>{sum.details.map((t, i) => <li key={i} style={{ overflowWrap: 'anywhere' }}>{t}</li>)}</ul>
          </details>
        )}
      </div>
      {sum.warnings.map((w, i) => (
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(245,158,11,.4)',
          background: 'rgba(245,158,11,.08)', color: 'var(--amber)', fontSize: 12, minWidth: 0 }}>
          <span style={{ flex: '1 1 300px', minWidth: 0, overflowWrap: 'anywhere' }}>{w}</span>
          <a href="#/settings/veeam" style={{ fontWeight: 600 }}>설정 › Veeam 백업 서버</a>
        </div>
      ))}
    </div>
  );
}

/** 배지를 눌렀을 때의 백업 상세 창. */
export function VeeamDetailModal({ vcenterId, vm, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setD(null); setErr(null);
    fetchJson('/veeam/vm-detail', { vcenterId, vmId: vm.id })
      .then((r) => { if (my === seq.current) setD(r); })
      .catch((e) => { if (my === seq.current) setErr(e); });
    return () => { seq.current += 1; };
  }, [vcenterId, vm.id]);
  const view = d ? veeamDetailView(d.detail) : null;
  const tone = view ? (TONE[view.status.tone] || TONE.muted) : TONE.muted;
  const basis = d?.servers?.length ? d.servers.map((s) => `${s.name}${s.ok === false ? '(읽기 실패 — 마지막 성공분)' : ''}`).join(', ') : '';
  return (
    <Modal title={`Veeam 백업 상세 — ${vm.name}`} onClose={onClose} width={900}>
      {err && <ErrorBox error={err} />}
      {!err && !d && <Loading label="Veeam 백업 상세" />}
      {view && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: tone.bg, color: tone.fg, fontWeight: 600, minWidth: 0 }}>
            <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{view.status.text}</span>
            <ProgressBar pct={view.status.progress} width={120} height={6} />
          </div>
          {view.sections.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, minWidth: 0 }}>
              {view.sections.map((sec) => (
                <div key={sec.title} className="card" style={{ padding: 12, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>{sec.title}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 10, rowGap: 4, fontSize: 12 }}>
                    {sec.rows.map(([k, v]) => (
                      <React.Fragment key={k}><span className="muted">{k}</span><span style={{ overflowWrap: 'anywhere' }}>{v}</span></React.Fragment>
                    ))}
                  </div>
                  {sec.note && <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>{sec.note}</div>}
                </div>
              ))}
            </div>
          )}
          {view.recent.length > 0 && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>최근 복원 지점 {view.recent.length}개</div>
              <STable minWidth={280}>
                <thead><tr><th className="right">#</th><th>생성 시각</th></tr></thead>
                <tbody>{view.recent.map((t, i) => <tr key={t}><td className="right" data-sort={i}>{i + 1}</td><td data-sort={t}>{fmt(t)}</td></tr>)}</tbody>
              </STable>
            </div>
          )}
          {view.backups.length > 0 && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>백업(체인) — 같은 작업의 다른 VM 과 공유하는 전체 용량</div>
              <STable minWidth={720}>
                <thead><tr><th>백업</th><th>작업</th><th>저장소</th><th className="right">파일</th><th className="right">백업 파일 합</th><th className="right">데이터 크기</th><th className="right">중복 제거</th><th className="right">압축</th><th>최근 파일</th></tr></thead>
                <tbody>{view.backups.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name || '—'}</td><td>{b.job || '—'}</td><td>{b.repo || '—'}</td>
                    <td className="right" data-sort={b.files ?? ''}>{b.files ?? '—'}</td>
                    <td className="right" data-sort={b.backupSize ?? ''}>{sizeText(b.backupSize)}</td>
                    <td className="right" data-sort={b.dataSize ?? ''}>{sizeText(b.dataSize)}</td>
                    <td className="right" data-sort={b.dedup ?? ''}>{Number.isFinite(b.dedup) ? `${b.dedup}x` : '—'}</td>
                    <td className="right" data-sort={b.compress ?? ''}>{Number.isFinite(b.compress) ? `${b.compress}x` : '—'}</td>
                    <td data-sort={b.lastFile ?? ''}>{fmt(b.lastFile)}</td>
                  </tr>
                ))}</tbody>
              </STable>
            </div>
          )}
          {view.jobs.length > 0 && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>이 VM 이 든 Veeam 작업</div>
              <STable minWidth={640}>
                <thead><tr><th>작업</th><th>종류</th><th>상태</th><th>마지막 결과</th><th>마지막 실행</th><th>다음 실행</th></tr></thead>
                <tbody>{view.jobs.map((j) => (
                  <tr key={j.name}>
                    <td>{j.name}{!j.counts && <span className="badge gray" style={{ marginLeft: 6 }} title="꺼진 작업·복제·복사 작업은 백업 대상 근거로 세지 않습니다">근거 아님</span>}</td>
                    <td>{j.type || '—'}</td>
                    <td>{j.running ? <span className="badge amber">실행 중</span> : j.disabled ? '꺼짐' : (j.status || '—')}</td>
                    <td>{resultLabel(j.lastResult) || '—'}</td>
                    <td data-sort={j.lastRun ?? ''}>{fmt(j.lastRun)}</td>
                    <td data-sort={j.nextRun ?? ''}>{fmt(j.nextRun)}</td>
                  </tr>
                ))}</tbody>
              </STable>
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
            출처: {basis || 'Veeam'}{d.demo ? ' (데모 데이터 — 실제 Veeam 에 접속하지 않았습니다)' : ''} · 주기 수집(기본 10분)한 값이라 지금 Veeam 화면과 몇 분 다를 수 있습니다.
            값이 '—' 인 칸은 이 Veeam 판의 REST 응답이 그 정보를 주지 않은 것입니다.
          </div>
        </div>
      )}
    </Modal>
  );
}
