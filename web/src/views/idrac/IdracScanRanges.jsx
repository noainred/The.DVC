// IdracScanRanges.jsx — IdracAdmin.jsx(구 1,309줄)에서 분리(v2.292). 본문은 원본 1053~1308행 그대로.
// props 계약(순수 이동 — 시그니처 불변): { data, vcenters, datacenters, agents, busy, form, setForm,
//   msg, setMsg, onNew, onEdit, onSave, onDelete, onScan, onReload }
// 주기 저장(saveInterval)·스캔 중지(stopScan)는 이 컴포넌트가 자체 소유(원본과 동일) — putJson/postJson 직접 사용.
import React, { useState } from 'react';
import { putJson, postJson } from '../../api.js';

// ---- vCenter별 iDRAC 스캔 대역(주기 자동 발견) ------------------------------
// 각 vCenter에 iDRAC IP 대역 + 계정을 저장하면, 주기 스캐너가 그 대역을 돌며 Dell iDRAC을
// 발견해 해당 vCenter로 자동 등록한다(IPMS의 'vCenter별 스캔 대역'과 같은 흐름).
export function IdracScanRanges({ data, vcenters, datacenters = [], agents, busy, form, setForm, msg, setMsg, onNew, onEdit, onSave, onDelete, onScan, onReload }) {
  const st = data?.status || {};
  const prog = st.progress;
  const dcName = (id) => (datacenters.find((d) => d.id === id)?.name || id);
  const [showPw, setShowPw] = useState(false); // 비밀번호 표시 토글 — 특수문자 입력을 눈으로 확인
  // 컬럼 정렬 — 헤더 클릭으로 asc/desc 토글. 기본은 법인명 오름차순.
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const SORT_VAL = {
    name: (e) => String(dcName(e.datacenterId) || '').toLowerCase(),
    service: (e) => String(e.service || '').toLowerCase(),
    ranges: (e) => (e.ranges || []).length,
    username: (e) => String(e.username || '').toLowerCase(),
    agent: (e) => String(e.agent || '').toLowerCase(), // 빈 값(직접)이 맨 앞/뒤
    enabled: (e) => (e.enabled ? 1 : 0),
    lastRun: (e) => e.lastRun?.at || 0,
  };
  const list = [...(data?.ranges || [])].sort((a, b) => {
    const f = SORT_VAL[sort.key] || SORT_VAL.name;
    const x = f(a); const y = f(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.dir === 'asc' ? c : -c;
  });
  const clickSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const Th = ({ k, children, right }) => (
    <th className={right ? 'right' : undefined} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title="클릭하여 정렬" onClick={() => clickSort(k)}>
      {children}{sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : <span style={{ opacity: 0.35 }}> ↕</span>}
    </th>
  );
  const fmtRun = (r) => {
    if (!r) return <span className="muted">—</span>;
    const when = r.at ? new Date(r.at).toLocaleString('ko-KR') : '';
    if (r.error) return <span style={{ color: '#f87171' }} title={r.error}>오류 · {when}</span>;
    if (r.delegated) return <span style={{ color: '#a78bfa' }} title={`에이전트 ${r.agent || ''} 위임`}>위임{r.agent ? `(${r.agent})` : ''} · {when}</span>;
    return <span className="muted">발견 {r.found ?? 0} · 등록 {r.registered ?? 0}{r.scanned != null ? ` · 스캔 ${r.scanned}` : ''} · {when}</span>;
  };
  const intervalH = st.intervalMs != null ? Math.round(st.intervalMs / 3600000 * 10) / 10 : null;
  // 주기 설정(시간) — 저장 시 즉시 재적용(0=주기 끔, 수동 스캔만). 스캔 중지 버튼과 함께 헤더에 배치.
  const [ivEdit, setIvEdit] = useState(null); // null=보기 모드, 문자열=편집 중 값
  const [ivMsg, setIvMsg] = useState(null);
  const saveInterval = async () => {
    const hours = Number(ivEdit);
    if (!Number.isFinite(hours) || hours < 0) { setIvMsg('0 이상 숫자(시간)를 입력하세요.'); return; }
    try {
      const r = await putJson('/admin/idrac/scan-ranges/interval', { hours });
      // 서버가 하한(10분) 등으로 클램프할 수 있으므로 실제 적용된 값으로 안내한다.
      const appliedH = Number.isFinite(r?.intervalMs) ? Math.round(r.intervalMs / 3600000 * 10) / 10 : hours;
      setIvMsg(appliedH === 0 ? '주기 스캔을 껐습니다(수동만).' : `주기 ${appliedH}시간으로 저장됨${appliedH !== hours ? ` (입력 ${hours} → 하한/상한 적용)` : ''}`);
      setIvEdit(null);
      onReload?.(); // 버튼 라벨('주기 N시간')을 즉시 갱신 — 폴링 전까지 이전 값이 남아 저장 실패로 오인 방지
      setTimeout(() => setIvMsg(null), 4000);
    }
    catch (e) { setIvMsg(e.message); }
  };
  const stopScan = async () => {
    try {
      const r = await postJson('/admin/idrac/scan-ranges/stop', {});
      setIvMsg(`중지 요청됨 — 중앙 스캔 ${r.stoppingCentral ? '중단' : '없음'} · 대기 위임 잡 ${r.canceledJobs}건 취소(진행 중 위임 잡은 원격 중지 불가)`);
      setTimeout(() => setIvMsg(null), 6000);
    } catch (e) { setIvMsg(e.message); }
  };

  return (
    <div className="card" style={{ marginBottom: 12, padding: '12px 16px', borderLeft: '3px solid var(--accent, #60a5fa)' }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>법인별 iDRAC 장비 스캔</b>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            활성 {st.enabledDatacenters ?? 0} 법인 · 대역 {st.totalRanges ?? 0}개
            {st.running && <span style={{ color: 'var(--amber)' }}> · 스캔 중…</span>}
          </span>
          {/* 주기 표시/설정 — 클릭해 편집, 시간 단위(0=끔) */}
          {ivEdit === null ? (
            <button className="tab" style={{ padding: '5px 10px', fontSize: 12 }} title="클릭하여 주기 변경(시간 단위, 0=주기 끔)"
              onClick={() => setIvEdit(String(intervalH ?? 6))}>
              주기 {intervalH === 0 ? '끔(수동만)' : `${intervalH}시간`} ✎
            </button>
          ) : (
            <span className="flex gap" style={{ alignItems: 'center' }}>
              <input className="input" type="number" min={0} max={720} step={0.5} value={ivEdit} onChange={(e) => setIvEdit(e.target.value)} style={{ width: 76, padding: '5px 8px', fontSize: 12 }} />
              <span className="muted" style={{ fontSize: 12 }}>시간</span>
              <button className="login-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} onClick={saveInterval}>저장</button>
              <button className="logout-btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setIvEdit(null)}>취소</button>
            </span>
          )}
          <button className="logout-btn" style={{ padding: '8px 12px' }} disabled={busy || st.running} onClick={() => onScan()} title="활성화된 모든 법인 대역을 지금 스캔(백그라운드)">⚡ 지금 스캔(전체)</button>
          <button className="logout-btn" style={{ padding: '8px 12px', color: 'var(--red)' }} disabled={busy} onClick={stopScan}
            title="진행 중인 중앙 스캔을 중단하고, 대기 중인 위임 잡을 취소합니다(진행 중 위임 잡은 원격 중지 불가)">⏹ 스캔 중지</button>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy} onClick={onNew}>+ 대역 추가</button>
        </div>
      </div>
      {ivMsg && <div className="muted" style={{ fontSize: 12, marginBottom: 6, color: '#93c5fd' }}>{ivMsg}</div>}

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 8 }}>
        <b>법인(DataCenter)별</b>로 iDRAC IP 대역과 계정을 저장하면, 주기 스캐너가 각 대역의 Redfish에 접속해 <b>Dell iDRAC만 골라</b>
        해당 <b>법인 DB로 자동 등록</b>합니다(vCenter와 독립). 형식: CIDR(10.0.0.0/24)·범위(10.0.0.1-50)·단일 IP, 한 줄에 하나.
        등록 모드는 기본 <b>병합</b>(기존 유지+추가/갱신)이며, 스캔이 일시적으로 0건이면 기존 등록을 지우지 않습니다.
        중앙이 못 닿는 사설망은 <b>스캔 수행 Agent</b>를 지정해 현장 에이전트가 대행합니다.
        <b> 스캔 방식</b>은 <b>에이전트 폴링</b>(엣지가 중앙으로 폴링해 잡 인출 — 엣지에 CENTRAL_URL/토큰 필요)과
        <b> 중앙→엣지 직접(PUSH)</b>(중앙이 등록된 수집 서버 URL로 엣지에 직접 스캔 전송 — 엣지 폴링 설정 없이도 동작) 중 선택합니다.
        {datacenters.length === 0 && <span style={{ color: 'var(--amber)' }}> · ⚠ 먼저 <b>설정 › DataCenter(법인)</b>에서 법인을 1개 이상 정의하세요.</span>}
      </div>

      {st.running && prog && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>
            스캔 진행: {dcName(prog.datacenterId)} ({(prog.idx ?? 0) + 1}/{prog.totalDatacenters})
            {prog.total ? ` — ${prog.done}/${prog.total} (${prog.pct ?? 0}%)` : ''}
            {prog.foundSoFar != null && ` · 누적 발견 ${prog.foundSoFar}`}
          </div>
          <div style={{ height: 6, borderRadius: 4, background: 'rgba(148,163,184,.2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${prog.pct ?? 0}%`, background: 'var(--accent, #60a5fa)', transition: 'width .3s' }} />
          </div>
        </div>
      )}

      {form && (
        <div className="card" style={{ marginBottom: 10, padding: '12px 14px', background: 'rgba(96,165,250,.06)' }}>
          <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>{form.isNew ? '스캔 대역 추가' : `스캔 대역 수정 — ${dcName(form.datacenterId)}${form.service ? ` / ${form.service}` : ''}`}</b>
            <button className="logout-btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => { setMsg && setMsg(null); setForm(null); }}>닫기</button>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 200px', minWidth: 180 }}>
              <label className="muted" style={{ fontSize: 11.5 }}>법인(DataCenter) *</label>
              <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.datacenterId}
                onChange={(e) => setForm({ ...form, datacenterId: e.target.value })}>
                <option value="">(선택)</option>
                {datacenters.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}{d.region ? ` · ${d.region}` : ''}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 180px', minWidth: 160 }}>
              <label className="muted" style={{ fontSize: 11.5 }}>서비스명 <span className="muted">(한 법인 내 여러 서비스 구분)</span></label>
              <input className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.service || ''} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="예: 서비스A / VDI / 관리망" />
            </div>
            <div style={{ flex: '2 1 300px', minWidth: 240 }}>
              <label className="muted" style={{ fontSize: 11.5 }}>IP 대역 (한 줄에 하나) *</label>
              <textarea value={form.ranges} onChange={(e) => setForm({ ...form, ranges: e.target.value })}
                placeholder={'10.0.0.0/24\n10.0.1.1-10.0.1.50\n10.0.2.10'}
                style={{ width: '100%', minHeight: 84, padding: '8px 10px', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
            </div>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 8 }}>
            <div style={{ flex: '1 1 150px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>iDRAC 계정 *</label>
              <input className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="root" />
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>iDRAC 비밀번호 {form.hasPassword ? '(저장됨, 변경 시만 입력)' : '*'}</label>
              <div style={{ position: 'relative' }}>
                {/* 특수문자·공백 포함 비밀번호를 온전히 보존한다: 함수형 setState로 빠른 입력/조합 시 문자 유실 방지,
                    SHOW 토글로 마스킹된 특수문자를 눈으로 확인(입력이 안 된 것처럼 보이는 문제 해소). */}
                <input className="input" type={showPw ? 'text' : 'password'} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  style={{ width: '100%', padding: '8px 44px 8px 10px' }} value={form.password}
                  onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, password: v })); }}
                  placeholder={form.hasPassword ? '•••• (유지)' : ''} />
                <button type="button" onClick={() => setShowPw((v) => !v)} title={showPw ? '가리기' : '표시'}
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, letterSpacing: '.05em', color: 'var(--muted, #94a3b8)', padding: '2px 4px' }}>
                  {showPw ? '가림' : '표시'}
                </button>
              </div>
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>스캔 수행 Agent</label>
              <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                <option value="__local__">이 포탈에서 직접</option>
                {(() => {
                  // 실제 잡을 인출하는 건 '지금 폴링 중인 이름'이다. 폴링 중인 에이전트를 위에 모아
                  // '· 폴링 중'으로 표시해, 등록만 되고 폴링 안 하는 이름(예: OC2Sandbox) 대신 실제
                  // 폴링 이름(예: oc2)을 고르도록 유도한다.
                  const pollSet = new Set((agents?.pollingAgents || []).map((p) => p.toLowerCase()));
                  const all = agents?.agents || [];
                  const polling = all.filter((a) => pollSet.has(a.toLowerCase()));
                  const idle = all.filter((a) => !pollSet.has(a.toLowerCase()));
                  return (<>
                    {polling.length > 0 && <optgroup label="폴링 중(권장)">{polling.map((a) => <option key={a} value={a}>{a} · 폴링 중</option>)}</optgroup>}
                    {idle.length > 0 && <optgroup label="등록됨(현재 미폴링)">{idle.map((a) => <option key={a} value={a}>{a}</option>)}</optgroup>}
                  </>);
                })()}
              </select>
            </div>
            {form.agent && form.agent !== '__local__' && (
              <div style={{ flex: '1 1 200px' }}>
                <label className="muted" style={{ fontSize: 11.5 }}>스캔 방식</label>
                <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.dispatch || 'poll'} onChange={(e) => setForm({ ...form, dispatch: e.target.value })}>
                  <option value="poll">에이전트 폴링(기본) — 엣지가 중앙으로 폴링</option>
                  <option value="push">중앙→엣지 직접(PUSH) — 엣지 폴링 불필요</option>
                </select>
              </div>
            )}
            <div style={{ flex: '1 1 140px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>등록 모드</label>
              <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="merge">병합(추가/갱신)</option>
                <option value="replace-datacenter">이 법인만 교체</option>
              </select>
            </div>
            <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '8px 0' }} title="체크 시 주기 스캔에 포함">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 주기 스캔 포함
            </label>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={onSave}>{busy ? '저장 중…' : '저장'}</button>
          </div>
          {msg && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
              background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
              color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.ok ? '✅ ' : '⚠ '}{msg.text}</div>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr>
            <Th k="name">법인(DataCenter)</Th><Th k="service">서비스</Th><Th k="ranges">대역</Th><Th k="username">계정</Th><Th k="agent">스캔 주체</Th><Th k="enabled">주기</Th><Th k="lastRun">최근 결과</Th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 24 }}>저장된 스캔 대역이 없습니다. “+ 대역 추가”로 등록하세요.</td></tr>}
            {list.map((e) => (
              <tr key={e.id || e.datacenterId} style={{ opacity: e.enabled ? 1 : 0.55 }}>
                <td><b>{dcName(e.datacenterId)}</b>{dcName(e.datacenterId) !== e.datacenterId && <span className="muted" style={{ fontSize: 11 }}> ({e.datacenterId})</span>}</td>
                <td>{e.service ? <span className="muted">{e.service}</span> : <span className="muted" style={{ opacity: 0.5 }}>—</span>}</td>
                <td className="muted" title={(e.ranges || []).join('\n')}>{(e.ranges || []).length}개</td>
                <td className="muted">{e.username || '—'}{e.hasPassword ? '' : <span style={{ color: 'var(--amber)' }} title="비밀번호 미설정 — 스캔 불가"> ⚠</span>}</td>
                <td>{e.agent ? <>
                  <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{e.agent}</span>
                  {e.dispatch === 'push'
                    ? <span className="badge" style={{ marginLeft: 4, background: 'rgba(34,197,94,.18)', color: '#4ade80' }} title="중앙이 엣지로 직접 스캔 전송(엣지 폴링 불필요)">PUSH</span>
                    : <span className="badge" style={{ marginLeft: 4, background: 'rgba(96,165,250,.15)', color: '#93c5fd' }} title="엣지가 중앙으로 폴링해 잡 인출">폴링</span>}
                </> : <span className="muted">직접</span>}</td>
                <td>{e.enabled ? <span className="badge green">포함</span> : <span className="badge gray">제외</span>}</td>
                <td style={{ fontSize: 12 }}>{fmtRun(e.lastRun)}</td>
                <td className="right">
                  <button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12 }} disabled={busy || st.running} onClick={() => onScan(e)} title="이 서비스 대역만 지금 스캔">스캔</button>
                  {' '}<button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12 }} disabled={busy} onClick={() => onEdit(e)}>수정</button>
                  {' '}<button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12, color: 'var(--red)' }} disabled={busy} onClick={() => onDelete(e)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {st.lastRun && !st.running && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          최근 전체 스캔: {st.lastRun.at ? new Date(st.lastRun.at).toLocaleString('ko-KR') : ''}
          {st.lastRun.vcenters != null && ` — ${st.lastRun.vcenters} vCenter · 발견 ${st.lastRun.found ?? 0} · 등록 ${st.lastRun.registered ?? 0}${st.lastRun.delegated ? ` · 위임 ${st.lastRun.delegated}` : ''}`}
          {st.lastRun.errors?.length ? <span style={{ color: '#f87171' }}> · 오류 {st.lastRun.errors.length}건</span> : ''}
          {st.lastRun.skipped && ` — ${st.lastRun.skipped}`}
        </div>
      )}
    </div>
  );
}
