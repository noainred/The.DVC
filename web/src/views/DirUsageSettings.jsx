import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, sendJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';

/**
 * 설정 › 폴더 사용량 리포트(v2.454, admin 전용) — 사용자 요구사항:
 * "엣지 서버에 마운트된 특정 폴더의 하위 폴더 사용량을 설정한 기간마다 검색해 Top 10/20 사용자를
 *  뽑고 지정한 사용자에게 주기적으로 메일 발송."
 *
 * 집계 기준은 **하위 폴더 이름 = 사용자**다. 실행은 그 법인의 RMA 에이전트가 현지에서 `du` 로 하고
 * (고RTT 회선에 부담이 없다), 중앙은 결과만 받아 Top-N 을 뽑고 메일을 보낸다.
 *
 * ⚠️ 훅은 전부 최상단에 선언한다 — 조기 return 뒤에 useState 를 추가하면 렌더 간 훅 개수가 달라져
 *    React #310 으로 화면 전체가 크래시한다(v2.202 실제 사고).
 */
export default function DirUsageSettings() {
  const [d, setD] = useState(null);          // { settings, status, db, agents, latest }
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState([]);
  const [enabled, setEnabled] = useState(false);
  const [mail, setMail] = useState({ enabled: false, to: '', cc: '', subject: '', onlyOnChange: false });
  const [retentionDays, setRetentionDays] = useState(365);
  const inited = useRef(false);

  const load = async () => {
    try {
      const r = await fetchJson('/admin/dir-usage');
      setD(r);
      // 첫 로드에만 폼을 채운다 — 이후 폴링이 사용자가 입력 중인 값을 덮어쓰면 안 된다.
      if (!inited.current && r?.settings) {
        inited.current = true;
        const s = r.settings;
        setEnabled(!!s.enabled);
        setTargets((s.targets || []).map((t) => ({ ...t })));
        setMail({
          enabled: !!s.mail?.enabled, to: (s.mail?.to || []).join(', '), cc: (s.mail?.cc || []).join(', '),
          subject: s.mail?.subject || '', onlyOnChange: !!s.mail?.onlyOnChange,
        });
        setRetentionDays(s.retentionDays ?? 365);
      }
      setErr(null);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addTarget = () => setTargets((ts) => [...ts, {
    id: `t${Date.now().toString(36)}`, label: '', agent: d?.agents?.[0]?.agent || '', instance: '',
    path: '', topN: 20, intervalHours: 24, enabled: true,
  }]);
  const setT = (i, patch) => setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const delT = (i) => setTargets((ts) => ts.filter((_, j) => j !== i));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = {
        enabled, targets, retentionDays: Number(retentionDays) || 365,
        mail: { ...mail, to: splitAddr(mail.to), cc: splitAddr(mail.cc) },
      };
      const r = await sendJson('/admin/dir-usage', 'PUT', body);
      setMsg('저장되었습니다. 다음 틱(최대 1분)부터 적용됩니다.');
      if (r?.settings) setD((prev) => ({ ...prev, settings: r.settings }));
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const runNow = async (targetId = '') => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/dir-usage/run', { targetId });
      setMsg(r.ok ? `${r.queued.map((q) => `${q.path}: ${q.state}`).join(' · ')} — ${r.note}` : `오류: ${r.reason}`);
      load();
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const st = d.status || {};
  const agents = d.agents || [];
  const latestBy = new Map((d.latest || []).map((x) => [x.target_id, x]));

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>폴더 사용량 리포트</h3>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: -4 }}>
        엣지 서버에 마운트된 폴더의 <b>하위 폴더별 사용량</b>을 주기마다 수집해 <b>Top N</b>을 뽑고 메일로 보냅니다.
        집계 단위는 <b>하위 폴더 이름</b>입니다(<code>/mnt/share/hong</code> → 사용자 <code>hong</code>).
        실행은 그 법인의 <b>RMA 에이전트</b>가 현지에서 <code>du</code> 로 수행하므로 고지연 회선에 부담이 없습니다.
      </p>

      {err && <div className="muted" style={{ color: '#f0a', fontSize: 12, marginBottom: 8 }}>폴링 오류: {err}</div>}

      <div style={{ display: 'grid', gap: 6, marginBottom: 14, padding: '10px 12px', background: 'rgba(255,176,32,.08)', border: '1px solid rgba(255,176,32,.3)', borderRadius: 6, fontSize: 12, lineHeight: 1.7 }}>
        <div>⚠ <b>엣지에서 경로를 먼저 허용해야 합니다.</b> 대상 엣지의 <code>portal.env</code> 에
          <code> RMA_FILE_ROOTS=/var/log,/mnt/share</code> 처럼 스캔할 상위 경로를 넣고 RMA 를 재시작하세요.
          이 목록 밖 경로는 엣지가 거부합니다(중앙 설정으로 열 수 없는 <b>현장 opt-in</b>).</div>
        <div>⚠ <code>du</code> 는 대용량 공유에서 <b>수 분</b>이 걸립니다. 주기는 시간 단위이며 최소 1시간입니다.</div>
      </div>

      <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <b>주기 실행 사용</b>
        <span className="muted" style={{ fontSize: 12 }}>
          (끄면 자동 수집을 멈춥니다 — '지금 스캔'은 계속 가능)
        </span>
      </label>

      {/* ── 대상 ─────────────────────────────────────────────── */}
      <h4 style={{ margin: '16px 0 8px', fontSize: 14 }}>스캔 대상</h4>
      {targets.length === 0 && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>등록된 대상이 없습니다.</div>}
      <STable style={{ width: '100%', fontSize: 12.5 }}>
        <thead>
          <tr>
            <th data-nosort>사용</th><th>이름(선택)</th><th>엣지(법인)</th><th>경로</th>
            <th>Top N</th><th>주기(시간)</th><th>최근 수집</th><th data-nosort></th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t, i) => {
            const last = latestBy.get(t.id);
            const online = agents.find((a) => a.agent === t.agent)?.online;
            return (
              <tr key={t.id}>
                <td><input type="checkbox" checked={t.enabled !== false} onChange={(e) => setT(i, { enabled: e.target.checked })} /></td>
                <td><input className="input" style={{ width: 110 }} value={t.label || ''} placeholder="공유 폴더"
                  onChange={(e) => setT(i, { label: e.target.value })} /></td>
                <td>
                  <select className="input" style={{ width: 130 }} value={t.agent} onChange={(e) => setT(i, { agent: e.target.value })}>
                    <option value="">(선택)</option>
                    {agents.map((a) => <option key={a.agent} value={a.agent}>{a.agent}{a.online ? '' : ' (오프라인)'}</option>)}
                    {t.agent && !agents.some((a) => a.agent === t.agent) && <option value={t.agent}>{t.agent} (미접속)</option>}
                  </select>
                  {t.agent && online === false && <div className="muted" style={{ fontSize: 11, color: '#f0a' }}>RMA 오프라인</div>}
                </td>
                <td><input className="input" style={{ width: 200 }} value={t.path} placeholder="/mnt/share"
                  onChange={(e) => setT(i, { path: e.target.value })} /></td>
                <td><input className="input" type="number" min={1} max={200} style={{ width: 70 }} value={t.topN}
                  onChange={(e) => setT(i, { topN: Number(e.target.value) })} /></td>
                <td><input className="input" type="number" min={1} max={720} style={{ width: 80 }} value={t.intervalHours}
                  onChange={(e) => setT(i, { intervalHours: Number(e.target.value) })} /></td>
                <td data-sort={last?.ts || 0} className="muted">
                  {last ? new Date(last.ts).toLocaleString() : '—'}
                  {last && <div style={{ fontSize: 11 }}>폴더 {last.count}개</div>}
                </td>
                <td>
                  <button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy} onClick={() => runNow(t.id)}>지금 스캔</button>
                  <button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11, marginLeft: 4 }} onClick={() => delT(i)}>삭제</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </STable>
      <button className="logout-btn" style={{ padding: '5px 12px', fontSize: 12, marginTop: 8 }} onClick={addTarget}>+ 대상 추가</button>

      {/* ── 메일 ─────────────────────────────────────────────── */}
      <h4 style={{ margin: '20px 0 8px', fontSize: 14 }}>메일 발송</h4>
      <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={mail.enabled} onChange={(e) => setMail({ ...mail, enabled: e.target.checked })} />
        수집이 끝나면 메일 발송
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 10, marginTop: 10 }}>
        <Field label="받는 사람 (쉼표로 구분)">
          <input className="input" value={mail.to} placeholder="admin@corp.local, storage@corp.local"
            onChange={(e) => setMail({ ...mail, to: e.target.value })} />
        </Field>
        <Field label="참조 (선택)">
          <input className="input" value={mail.cc} onChange={(e) => setMail({ ...mail, cc: e.target.value })} />
        </Field>
      </div>
      <Field label="제목 — {root} {agent} {topN} {date} 를 쓸 수 있습니다">
        <input className="input" value={mail.subject} onChange={(e) => setMail({ ...mail, subject: e.target.value })} />
      </Field>
      <label className="flex gap" style={{ alignItems: 'center', fontSize: 12.5, marginTop: 8 }}>
        <input type="checkbox" checked={mail.onlyOnChange} onChange={(e) => setMail({ ...mail, onlyOnChange: e.target.checked })} />
        직전 회차와 Top 목록이 <b>같으면 보내지 않음</b>
      </label>
      <Field label="스캔 이력 보존(일)">
        <input className="input" type="number" min={1} max={3650} style={{ width: 120 }} value={retentionDays}
          onChange={(e) => setRetentionDays(Number(e.target.value))} />
      </Field>

      <div className="muted" style={{ fontSize: 12, marginTop: 12, padding: '9px 11px', borderRadius: 6, background: 'rgba(46,144,250,.08)', border: '1px solid rgba(46,144,250,.3)', lineHeight: 1.7 }}>
        ✉ <b>SMTP 서버 설정은 여기 없습니다.</b> 포탈의 모든 기능이 함께 쓰는
        <b> 설정 › 메일 발송</b> 한 곳에서 정합니다(메일 테스트도 거기서 합니다).
        위 <b>받는 사람</b>을 비워 두면 그 화면의 기능별/기본 수신자로 갑니다.
      </div>

      <div className="flex gap" style={{ alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
        <button className="logout-btn" style={{ padding: '7px 16px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        <button className="logout-btn" style={{ padding: '7px 16px' }} disabled={busy} onClick={() => runNow('')}>전체 지금 스캔</button>
        {msg && <span className="muted" style={{ fontSize: 12.5, color: msg.startsWith('오류') ? '#f0a' : undefined }}>{msg}</span>}
      </div>

      {/* ── 상태 ─────────────────────────────────────────────── */}
      <h4 style={{ margin: '22px 0 8px', fontSize: 14 }}>상태</h4>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
        스케줄 {st.enabled ? '켜짐' : '꺼짐'} · 마지막 틱 {st.lastTickAt ? new Date(st.lastTickAt).toLocaleTimeString() : '—'}
        {st.running ? ' · 실행 중' : ''}
        {(st.pending || []).length > 0 && ` · 진행 중 ${st.pending.length}건`}
        {d.db && !d.db.available && <span style={{ color: '#f0a' }}> · 이력 DB 사용 불가({d.db.error || 'node:sqlite'})</span>}
      </div>
      {(st.recent || []).length > 0 && (
        <div style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto', fontSize: 11.5, fontFamily: 'ui-monospace,monospace', lineHeight: 1.7 }}>
          {st.recent.map((r, i) => (
            <div key={i} style={{ color: r.level === 'error' ? '#f0a' : undefined }}>
              {new Date(r.at).toLocaleTimeString()} {r.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const splitAddr = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
