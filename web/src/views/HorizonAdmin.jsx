/**
 * views/HorizonAdmin.jsx — Horizon 연결 서버(Connection Server) 등록·관리(v2.685).
 *
 * 사용자 신고(2026-10-02): "설정에 Horizon 등록 메뉴가 없어". 그 전까지 이 등록 화면은
 * 특수 기능 › 라이선스 만료 도구 안의 접힌 구획에만 있었다(v2.525 대량 등록 포함). 등록부는 하나
 * (`horizon.json`)이고 라이선스 만료·실시간 사용자·앱별 사용 현황이 모두 이 등록을 쓴다.
 *
 *  · 등록 화면을 두 벌로 만들지 않는다 — 이 컴포넌트 하나를 설정(`#/settings/horizon-admin`)과
 *    라이선스 만료 도구가 같이 쓴다(`variant` 로 감싸는 모양만 다르다).
 *  · 등록 목록 403(범위 제한 관리자)·읽기 실패를 '0대 등록' 으로 칠하지 않는다(v2.611·v2.612 규약 — `hzSummary`).
 *  · 접속처(host·계정·도메인)가 바뀌면 저장 비밀번호를 승계하지 않는다 — 서버가 알려 주면 폼을 비우지 않고 그 사실을 말한다(v2.607).
 *  · v2.727(감사 E-01): `delJson` 은 400 본문(`{ok:false, reason}`)을 **돌려준다**(throw 하지 않는다 — api.js sendJson). 삭제도 저장처럼
 *    `r.ok` 를 본다. 예전에는 반환값을 보지 않아 삭제가 거부돼도 목록만 다시 읽고 화면은 아무 말이 없었다(행이 그대로 남는다).
 *  · v2.727(감사 E-09): 목록 조회는 세대 번호로 늦게 온 이전 응답을 버린다(연속 changed()·언마운트).
 * ⚠ 훅은 전부 조기 return 위에(React #310).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, delJson, canCsv } from '../api.js';
import { droppedSecretNote } from './droppedSecretText.js';
import { STable } from '../components/STable.jsx';
import BulkDeviceIo from './tools/BulkDeviceIo.jsx';
import { hzSummary } from './tools/hzListText.js';
import { HorizonSessionSettings } from './tools/HorizonSessionSettings.jsx';
import { hzTestMessage } from './horizonAdminText.js';

const EMPTY = { id: '', name: '', host: '', username: '', password: '', domain: '' };
/** 연결 테스트 줄의 색·표지(v2.686) — 됨 / 이 서버에 없음(404) / 확인 실패 / 참고. */
const LINE_TONE = { ok: '#4ade80', warn: 'var(--amber)', bad: '#f87171', info: 'var(--text-dim)', muted: 'var(--text-dim)' };
const LINE_MARK = { ok: '✓', warn: '✗', bad: '!', info: 'ⓘ', muted: '·' };

/**
 * @param {object} p
 * @param {'details'|'page'} [p.variant]  details = 라이선스 도구 안의 접힌 구획, page = 설정 화면
 * @param {() => void} [p.onChanged]       저장·삭제·대량 등록 뒤 부모가 다시 읽을 것(라이선스 목록)
 */
export function HorizonServerManager({ variant = 'details', onChanged }) {
  const [hz, setHz] = useState(null);
  const [hzErr, setHzErr] = useState(null);
  const [hzDenied, setHzDenied] = useState(false);
  const [hzBulk, setHzBulk] = useState(false);
  const [hzForm, setHzForm] = useState(EMPTY);
  const [hzMsg, setHzMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sessOpen, setSessOpen] = useState(false);

  // v2.727(감사 E-09): 세대 번호 — 마지막으로 부른 load() 의 응답만 받는다. 언마운트 뒤 도착하는 응답도 버린다.
  const loadSeq = useRef(0);
  const load = () => {
    const my = ++loadSeq.current;
    fetchJson('/admin/horizon')
      .then((r) => { setHz(r.servers || []); setHzDenied(false); setHzErr(null); })
      .catch((e) => { if (my !== loadSeq.current) return; if (e?.status === 403) setHzDenied(true); else setHzErr(e?.message || String(e) || '알 수 없는 오류'); });
  };
  useEffect(() => { load(); return () => { loadSeq.current += 1; }; }, []);
  const changed = () => { load(); onChanged?.(); };

  const hzSet = (k) => (e) => setHzForm((f) => ({ ...f, [k]: e.target.value }));
  const hzSave = async () => {
    setBusy(true); setHzMsg(null);
    try {
      const body = { ...hzForm, id: hzForm.id || hzForm.host.trim().replace(/^https?:\/\//i, '').split('/')[0].replace(/[^A-Za-z0-9.-]+/g, '-') };
      const r = await postJson('/admin/horizon', body);
      const dropNote = r.ok ? droppedSecretNote(r) : ''; // v2.607 WEB2607-03: 접속처 변경으로 저장 비밀번호 폐기 — 폼을 비우지 않는다
      setHzMsg(r.ok ? (dropNote ? { ok: false, text: dropNote } : { ok: true, text: '저장됨.' }) : { ok: false, text: r.reason });
      if (r.ok && dropNote) { setHzForm((f) => ({ ...f, id: body.id, password: '' })); changed(); }
      else if (r.ok) { setHzForm(EMPTY); changed(); }
    } catch (e) { setHzMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const hzTest = async () => {
    setBusy(true); setHzMsg(null);
    try {
      const r = await postJson('/admin/horizon/test', hzForm.host ? hzForm : { id: hzForm.id });
      setHzMsg(hzTestMessage(r));
    } catch (e) { setHzMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const hzDel = async (id) => {
    if (!window.confirm(`Horizon 서버 '${id}' 등록을 삭제할까요?`)) return;
    setBusy(true); setHzMsg(null);
    try {
      // v2.727(감사 E-01): 400 본문은 돌아온다 — r.ok 를 본다(hzSave 와 같은 규칙). 거부됐어도 목록은 다시 읽는다(화면 = 실제 등록부).
      const r = await delJson(`/admin/horizon/${encodeURIComponent(id)}`);
      if (r?.ok === false) setHzMsg({ ok: false, text: r.reason || '삭제하지 못했습니다.' });
      else setHzMsg({ ok: true, text: '삭제했습니다.' });
      changed();
    } catch (e) { setHzMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  if (hzDenied) {
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: variant === 'page' ? 0 : 14 }}>
        🖥️ Horizon 연결 서버 관리는 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다(이 계정에서는 등록 목록을 보이지 않습니다).
      </div>
    );
  }

  const body = (
    <>
      {hzErr && <div className="banner warn" style={{ marginTop: 8 }}>Horizon 등록 목록을 읽지 못했습니다(0대라는 뜻이 아닙니다): {hzErr} <button className="tab" style={{ marginLeft: 8, padding: '2px 10px' }} onClick={() => { setHzErr(null); load(); }}>다시 읽기</button></div>}
      <div className="card" style={{ marginTop: 8, padding: 14 }}>
        {(hz || []).length > 0 && (
          <STable minWidth={720} style={{ marginBottom: 10 }}>
            <thead><tr><th>ID</th><th>이름</th><th>host</th><th>계정</th><th>도메인</th><th className="right">작업</th></tr></thead>
            <tbody>
              {hz.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.id}</b></td><td>{s.name}</td><td className="muted">{s.host}</td><td className="muted">{s.username}</td><td className="muted">{s.domain}</td>
                  <td className="right nowrap">
                    <button className="tab" disabled={busy} onClick={() => { setHzForm({ id: s.id, name: s.name, host: s.host, username: s.username, password: '', domain: s.domain }); }}>편집</button>{' '}
                    <button className="tab" style={{ color: 'var(--red)' }} disabled={busy} onClick={() => hzDel(s.id)}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        {Array.isArray(hz) && hz.length === 0 && !hzErr && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>등록된 Horizon 연결 서버가 없습니다. 아래에 입력해 등록하세요.</div>
        )}
        <div className="spec-grid">
          <label>ID <input className="input" value={hzForm.id} onChange={hzSet('id')} placeholder="비우면 host로 자동" /></label>
          <label>표시 이름 <input className="input" value={hzForm.name} onChange={hzSet('name')} placeholder="본사 Horizon" /></label>
          <label>Connection Server(IP·주소) <input className="input" value={hzForm.host} onChange={hzSet('host')} placeholder="10.1.2.3 또는 horizon.example.com" /></label>
          <label>계정 <input className="input" value={hzForm.username} onChange={hzSet('username')} placeholder="administrator" /></label>
          <label>비밀번호 <input className="input" type="password" value={hzForm.password} onChange={hzSet('password')} placeholder={hzForm.id && (hz || []).some((s) => s.id === hzForm.id) ? '●●●●● (비우면 유지)' : ''} /></label>
          <label>AD 도메인 <input className="input" value={hzForm.domain} onChange={hzSet('domain')} placeholder="corp" /></label>
        </div>
        {hzMsg && (
          <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12, background: hzMsg.ok ? 'rgba(34,197,94,.12)' : hzMsg.warn ? 'rgba(251,191,36,.12)' : 'rgba(239,68,68,.12)', color: hzMsg.ok ? '#4ade80' : hzMsg.warn ? 'var(--amber)' : '#f87171', whiteSpace: 'normal' }}>
            {/* v2.686: 기능별 한 줄 — 예전에는 한 문단으로 이어 붙여 무엇이 되고 안 되는지 읽기 어려웠다(사용자 스크린샷). */}
            {Array.isArray(hzMsg.lines) && hzMsg.lines.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', columnGap: 10, rowGap: 3 }}>
                {hzMsg.lines.map((l, i) => (
                  <React.Fragment key={i}>
                    <span style={{ color: LINE_TONE[l.tone] || 'inherit', whiteSpace: 'nowrap' }}>{LINE_MARK[l.tone] || '·'} {l.label}</span>
                    <span style={{ color: l.tone === 'muted' || l.tone === 'info' ? 'var(--text-dim)' : 'var(--text)', overflowWrap: 'anywhere' }}>{l.text}</span>
                  </React.Fragment>
                ))}
              </div>
            ) : hzMsg.text}
          </div>
        )}
        <div className="flex gap wrap" style={{ marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !hzForm.host} onClick={hzSave}>{busy ? '저장 중…' : '저장'}</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy || (!hzForm.host && !hzForm.id)} onClick={hzTest}>연결 테스트</button>
          {hzForm.id && <button className="tab" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy} onClick={() => { setHzForm(EMPTY); setHzMsg(null); }}>새로 입력</button>}
          {/* v2.525: 스토리지·SAN 스위치와 같은 공용 모달 — 식별 키는 id 단독, 타입 열 없음 */}
          {canCsv() && <button className="tab" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setHzBulk(true)}>📥 CSV · 자유텍스트 대량 등록</button>}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          Connection Server 는 IP 나 호스트명만 적으면 됩니다 — https:// 는 자동으로 붙고, 붙여 넣은 주소의 경로(/admin 등)는 떼어 냅니다(http 로 쓰려면 http:// 를 직접 적으세요). Horizon REST API(<code>/rest/login</code>)로 로그인합니다. 라이선스 만료일·실시간 사용자·앱 목록은 각각 다른 경로를 쓰고 Horizon 버전에 따라 없을 수 있어(예: 7.13.1 은 세션·라이선스 경로가 404), <b>연결 테스트</b>가 같은 로그인으로 기능마다 확인해 됨/안 됨을 보여 줍니다. 브라우저 주소창으로 그 경로를 열면 로그인 토큰이 없어 판단할 수 없습니다. 읽기 전용 관리자 계정을 권장하며, 자격증명은 <code>$CONFIG_DIR/horizon.json</code>(0600)에만 저장됩니다.
          대량 등록의 내보내기·샘플에는 <b>비밀번호가 담기지 않습니다</b>. host·계정·도메인 중 하나라도 바꾸면 저장된 비밀번호를 승계하지 않으므로(보안 규칙) 그 행은 비밀번호를 다시 적어야 합니다.
        </div>
      </div>
      {canCsv() && hzBulk && (
        <BulkDeviceIo base="/admin/horizon" resource="servers" unitLabel="서버" typeCol={null}
          title="Horizon 연결 서버 대량 등록 — CSV · 자유텍스트" keyLabel="id"
          onClose={() => setHzBulk(false)} onDone={() => { setHzBulk(false); changed(); }} />
      )}
    </>
  );

  if (variant === 'page') {
    const sum = hzSummary(hz, hzErr);
    return (
      <>
        <div className="section-title" style={{ marginTop: 0 }}>{sum.label}</div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          여기에 등록한 Connection Server 를 세 기능이 함께 씁니다 — 특수 기능 › 라이선스 만료(만료일) · 현재 사용자 › Horizon(VDI)(실시간 사용자) · 앱·데스크톱별 사용 현황.
          실시간 사용자·앱별 사용 수집은 기본 꺼짐이고 아래 버튼에서 켭니다.
        </div>
        <div className="flex gap wrap" style={{ marginTop: 8 }}>
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setSessOpen(true)}>⚙ 실시간 사용자 수집 설정</button>
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => { window.location.hash = '#/tools/curuser'; }}>현재 사용자 화면 열기</button>
        </div>
        {body}
        {sessOpen && <HorizonSessionSettings onClose={() => setSessOpen(false)} />}
      </>
    );
  }
  const sum = hzSummary(hz, hzErr);
  return (
    <details style={{ marginTop: 14 }} open={sum.open}>
      <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>{sum.label}</summary>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>설정 › Horizon 연결 서버 에서도 같은 등록을 관리할 수 있습니다.</div>
      {body}
    </details>
  );
}

export default function HorizonAdmin() {
  return <HorizonServerManager variant="page" />;
}
