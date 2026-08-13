// IdracScanJobs.jsx — IdracAdmin.jsx(구 1,309줄)에서 분리(v2.292). 본문은 원본 904~1051행 그대로.
// props 계약(순수 이동 — 시그니처 불변): { data, vcenters, datacenters, busy, onRefresh, onScanAll }
// (vcenters 는 현재 바디에서 미사용이지만 셸 호출부와의 계약을 바꾸지 않기 위해 유지 — 정리는 별도 변경으로.)
import React, { useState } from 'react';
import { ScanJobLogModal } from './ScanJobLogModal.jsx';

// ---- 스캔 현황(주기 스캐너 + 진행 중/최근 위임 잡) --------------------------
// iDRAC 스캔이 지금 어디까지 진행됐는지 어디서든 한눈에 확인. 주기 스캐너 상태 + 진행 중·최근
// 위임 잡(에이전트 대행)을 실시간으로 보여준다. /admin/idrac/scan-jobs 응답을 렌더.
export function IdracScanJobs({ data, vcenters, datacenters = [], busy, onRefresh, onScanAll }) {
  const [logFor, setLogFor] = useState(null); // reqId → 세부 로그 모달
  const st = data?.status || {};
  const jobs = data?.jobs || [];
  const collectors = data?.collectors || [];
  const dcName = (id) => (datacenters.find((d) => d.id === id)?.name || id || '');
  const active = jobs.filter((j) => j.state === 'pending' || j.state === 'running');
  const recent = jobs.filter((j) => j.state === 'done' || j.state === 'error');

  // 위임 스캔 에이전트 → 수집 서버 매칭(id/datacenter/name, 대소문자 무시). 전력이 '원격 수집'으로
  // 반영되려면 그 에이전트가 수집 서버로 등록돼 있어야 한다.
  const norm = (s) => String(s || '').trim().toLowerCase();
  const collectorForAgent = (agent) => {
    const a = norm(agent);
    return collectors.find((c) => norm(c.id) === a || norm(c.datacenter) === a || norm(c.name) === a) || null;
  };
  // 등록(registered>0) 완료된 위임 잡 중 가장 최근 것으로 반영 상태 안내.
  const lastReg = recent.find((j) => j.agent && (j.result?.registered || 0) > 0);
  let advisory = null;
  if (lastReg) {
    const col = collectorForAgent(lastReg.agent);
    const reg = lastReg.result?.registered || 0;
    if (!col) {
      advisory = { ok: false, text: `에이전트 '${lastReg.agent}'가 ${reg}대를 현지 등록했지만, '${lastReg.agent}'가 '수집 서버(원격)'로 등록되어 있지 않습니다. 전력이 중앙에 반영되려면 설정 → 수집 서버(원격)에서 이 에이전트를 수집 서버로 등록하세요(소속 vCenter 매핑 권장).` };
    } else if (col.enabled === false) {
      advisory = { ok: false, text: `수집 서버 '${col.name || col.id}'가 비활성 상태입니다. 활성화하면 에이전트가 등록한 ${reg}대의 전력이 '원격 수집'으로 반영됩니다.` };
    } else if (col.ok === false) {
      advisory = { ok: false, text: `수집 서버 '${col.name || col.id}' 연결 오류(${col.error || '확인 필요'}). 해결되면 등록한 ${reg}대 전력이 반영됩니다.` };
    } else if (!col.hosts) {
      advisory = { ok: true, text: `에이전트 '${lastReg.agent}'에 ${reg}대 등록됨 — 에이전트가 전력을 수집하고 중앙이 당겨오는 중입니다(보통 1~2분). 잠시 후 '원격 수집'에 반영됩니다.` };
    } else {
      advisory = { ok: true, text: `'원격 수집'으로 반영 중 — 수집 서버 '${col.name || col.id}'에서 호스트 ${col.hosts}대 수신.` };
    }
  }
  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s >= 3600 ? `${Math.floor(s / 3600)}시간 전` : s >= 60 ? `${Math.floor(s / 60)}분 전` : `${s}초 전`;
  };
  const stateBadge = (s) => {
    const map = { pending: ['대기', 'gray'], running: ['진행 중', 'amber'], done: ['완료', 'green'], error: ['오류', 'red'], unknown: ['만료', 'gray'] };
    const [label, cls] = map[s] || [s, 'gray'];
    return <span className={`badge ${cls}`}>{label}</span>;
  };
  const Bar = ({ p }) => {
    if (!p || !p.total) return <span className="muted" style={{ fontSize: 11.5 }}>대기 중…</span>;
    const pct = Math.min(100, Math.round((p.scanned / p.total) * 100));
    return (
      <div style={{ minWidth: 160 }}>
        <div className="flex between" style={{ fontSize: 11, marginBottom: 2 }}>
          <span className="muted">{(p.scanned || 0).toLocaleString()}/{(p.total || 0).toLocaleString()}{p.found ? ` · 발견 ${p.found}` : ''}</span>
          <b>{pct}%</b>
        </div>
        <div style={{ height: 6, borderRadius: 4, background: 'rgba(36,48,73,.8)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width .4s', borderRadius: 4 }} />
        </div>
      </div>
    );
  };

  const pollerRunning = !!st.running;
  const anyActive = pollerRunning || active.length > 0;
  const borderColor = anyActive ? 'var(--amber)' : 'var(--green, #22c55e)';

  return (
    <div className="card" style={{ marginBottom: 12, padding: '12px 16px', borderLeft: `3px solid ${borderColor}` }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>스캔 현황 {anyActive ? <span style={{ color: 'var(--amber)' }}>· 진행 중</span> : <span className="muted" style={{ fontWeight: 400 }}>· 유휴</span>}</b>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            주기 스캐너: {pollerRunning ? <span style={{ color: 'var(--amber)' }}>스캔 중</span> : '대기'}
            {' '}· 활성 {st.enabledDatacenters ?? 0} 법인
            {st.intervalMs ? ` · 주기 ${Math.round(st.intervalMs / 3600000 * 10) / 10}h` : ''}
          </span>
          <button className="logout-btn" style={{ padding: '7px 12px', fontSize: 12 }} disabled={busy} onClick={onRefresh}>새로고침</button>
          <button className="logout-btn" style={{ padding: '7px 12px', fontSize: 12 }} disabled={busy || pollerRunning} onClick={onScanAll} title="활성 법인 대역 전체를 지금 스캔">⚡ 지금 스캔(전체)</button>
        </div>
      </div>

      {/* 주기 스캐너 자체 진행률(중앙 직접 스캔 중) */}
      {pollerRunning && st.progress && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>
            중앙 직접 스캔: {dcName(st.progress.datacenterId)} ({(st.progress.idx ?? 0) + 1}/{st.progress.totalDatacenters})
            {st.progress.total ? ` — ${st.progress.done}/${st.progress.total} (${st.progress.pct ?? 0}%)` : ''}
            {st.progress.foundSoFar != null ? ` · 누적 발견 ${st.progress.foundSoFar}` : ''}
          </div>
          <div style={{ height: 6, borderRadius: 4, background: 'rgba(36,48,73,.8)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${st.progress.pct ?? 0}%`, background: 'var(--accent)', transition: 'width .4s', borderRadius: 4 }} />
          </div>
        </div>
      )}

      {jobs.length === 0 && !pollerRunning ? (
        <div className="muted" style={{ fontSize: 12 }}>
          진행 중인 스캔이 없습니다. 아래 ‘스캔 대역’에서 ‘스캔’을 누르거나, 주기 스캐너가 {st.intervalMs ? `${Math.round(st.intervalMs / 3600000 * 10) / 10}시간` : '설정 주기'}마다 자동 실행합니다.
          {data?.centralEnabled === false && <span style={{ color: 'var(--amber)' }}> (에이전트 위임 스캔은 중앙 토큰 설정 필요)</span>}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>상태</th><th>유형</th><th>대상</th><th>에이전트</th><th>진행/결과</th><th>시각</th><th>로그</th>
            </tr></thead>
            <tbody>
              {[...active, ...recent].map((j) => (
                <tr key={j.reqId}>
                  <td>{stateBadge(j.state)}</td>
                  <td className="muted">{j.action === 'register' ? '등록' : '스캔'}</td>
                  <td>{j.datacenterId ? <b>{dcName(j.datacenterId)}</b> : (j.vcenterId ? <b>{j.vcenterId}</b> : <span className="muted">—</span>)}</td>
                  <td>{j.agent ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{j.agent}</span> : <span className="muted">직접</span>}</td>
                  <td>
                    {(j.state === 'pending' || j.state === 'running') ? <Bar p={j.progress} />
                      : j.state === 'error' ? <span style={{ color: '#f87171', fontSize: 12 }} title={j.result?.error || ''}>오류: {(j.result?.error || '').slice(0, 60) || '알 수 없음'}</span>
                        : <span className="muted" style={{ fontSize: 12 }}>발견 {j.result?.foundCount ?? 0} · 등록 {j.result?.registered ?? 0}{j.result?.scanned != null ? ` · 스캔 ${j.result.scanned}` : ''}</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{ago(j.doneAt || j.takenAt || j.createdAt)}</td>
                  <td><button className="tab" style={{ padding: '3px 10px', fontSize: 12 }} title="이벤트 타임라인 + 멈춤 진단" onClick={() => setLogFor(j.reqId)}>로그</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {advisory && (
        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
          background: advisory.ok ? 'rgba(96,165,250,.12)' : 'rgba(245,158,11,.14)',
          color: advisory.ok ? '#93c5fd' : '#fbbf24' }}>
          {advisory.ok ? 'ℹ️ ' : '⚠ '}{advisory.text}
        </div>
      )}

      {st.lastRun && !pollerRunning && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          최근 주기 스캔: {st.lastRun.at ? new Date(st.lastRun.at).toLocaleString('ko-KR') : ''}
          {st.lastRun.vcenters != null ? ` — ${st.lastRun.vcenters} vCenter · 발견 ${st.lastRun.found ?? 0} · 등록 ${st.lastRun.registered ?? 0}${st.lastRun.delegated ? ` · 위임 ${st.lastRun.delegated}` : ''}` : ''}
          {st.lastRun.skipped ? ` — ${st.lastRun.skipped}` : ''}
        </div>
      )}

      {logFor && <ScanJobLogModal reqId={logFor} dcName={dcName} onClose={() => setLogFor(null)} />}
    </div>
  );
}
