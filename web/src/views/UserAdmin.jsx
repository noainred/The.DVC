import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { fetchJson, postJson, patchJson, delJson, putJson } from '../api.js';
import { Loading, ErrorBox, Modal } from '../components/ui.jsx';
import { TOOLS as SPECIAL_TOOLS } from './specialToolsList.js';

const ROLES = ['viewer', 'operator', 'admin'];
const REGIONS = ['아시아', '중국', '유럽', '북미'];

/** 설정 → 사용자 관리: 계정 CRUD + Google OTP(TOTP) 등록/해제 + 기능 권한 매트릭스 + 데이터 범위(scope). */
export default function UserAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: '', name: '', role: 'viewer' });
  const [enroll, setEnroll] = useState(null); // { username, secret, otpauthURL, qr, code, error }
  const [perms, setPerms] = useState(null);   // { catalog, roles, matrix }
  const [permDirty, setPermDirty] = useState(false);
  const [vcx, setVcx] = useState([]);         // 범위 지정용 vCenter 목록 [{id,name,region}]
  const [scopeEdit, setScopeEdit] = useState(null); // { username, vcenters:[], regions:[] }
  // ⚠ 모든 훅은 아래 조기 return(if (!data) return <Loading/>) 이전에 선언해야 한다 —
  // v2.202에서 pwEdit useState 를 조기 return 뒤에 뒀다가 렌더 간 훅 개수가 달라져
  // React #310(사용자 관리 화면 전체 크래시)이 발생했다.
  const [pwEdit, setPwEdit] = useState(null); // { username, pw, pw2, error }

  const load = async () => {
    try {
      const [u, p, vc] = await Promise.all([
        fetchJson('/admin/users'),
        fetchJson('/admin/permissions').catch(() => null),
        fetchJson('/vcenters').catch(() => []),
      ]);
      setData(u);
      if (p) { setPerms(p); setPermDirty(false); }
      setVcx(Array.isArray(vc) ? vc : []);
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };

  const addUser = async () => {
    const r = await postJson('/admin/users', form).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setAdding(false); setForm({ username: '', name: '', role: 'viewer' }); await load(); flash(true, '사용자를 추가했습니다. OTP를 등록해 주세요.'); }
    else flash(false, r.reason);
  };

  const changeRole = async (u, role) => {
    const r = await patchJson(`/admin/users/${encodeURIComponent(u.username)}`, { role }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) await load(); else flash(false, r.reason);
  };

  const remove = async (u) => {
    if (!window.confirm(`'${u.username}' 계정을 삭제할까요?`)) return;
    const r = await delJson(`/admin/users/${encodeURIComponent(u.username)}`).catch((e) => ({ ok: false, reason: e.message }));
    if (r?.ok !== false) await load(); else flash(false, r.reason);
  };

  const startEnroll = async (u) => {
    const r = await postJson(`/admin/users/${encodeURIComponent(u.username)}/totp/begin`, {}).catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) return flash(false, r.reason);
    const qr = await QRCode.toDataURL(r.otpauthURL, { width: 200, margin: 1 }).catch(() => null);
    setEnroll({ username: u.username, secret: r.secret, otpauthURL: r.otpauthURL, qr, code: '', error: null });
  };

  const confirmEnroll = async () => {
    const r = await postJson(`/admin/users/${encodeURIComponent(enroll.username)}/totp/confirm`, { code: enroll.code }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setEnroll(null); await load(); flash(true, 'OTP 등록 완료 — 이제 이 계정은 OTP로만 로그인합니다.'); }
    else setEnroll((s) => ({ ...s, error: r.reason }));
  };

  const disableTotp = async (u) => {
    if (!window.confirm(`'${u.username}'의 OTP를 해제할까요? (다시 비밀번호/재등록 필요)`)) return;
    const call = (body) => postJson(`/admin/users/${encodeURIComponent(u.username)}/totp/disable`, body).catch((e) => ({ ok: false, reason: e.message }));
    let r = await call({});
    // v2.277 잠금 방지: 비밀번호 없는 OTP 전용 계정은 서버가 임시 비밀번호를 요구한다 —
    // 없이 해제하면 비번도 OTP 도 없는 '로그인 완전 불가' 계정이 되기 때문(확정 버그 수정).
    // 서버 거부 사유를 보고 즉석에서 임시 비밀번호를 받아 1회 재시도한다.
    if (!r.ok && /임시 비밀번호/.test(r.reason || '')) {
      const pw = window.prompt(`'${u.username}'은(는) 비밀번호가 없는 OTP 전용 계정입니다.\n해제하려면 임시 비밀번호(8자 이상)를 입력하세요 — 이 비밀번호로 로그인해 재등록합니다:`, '');
      if (!pw) { flash(false, 'OTP 해제를 취소했습니다(임시 비밀번호 미입력).'); return; }
      r = await call({ password: pw });
    }
    if (r.ok) { await load(); flash(true, 'OTP를 해제했습니다.'); } else flash(false, r.reason);
  };

  // ── 기능 권한 매트릭스(operator/viewer 편집; admin 은 항상 전체) ──────────────
  const hasMx = (role, key) => (perms?.matrix?.[role] || []).includes(key);
  const togglePerm = (role, key) => {
    setPerms((p) => {
      const cur = new Set(p.matrix[role] || []);
      cur.has(key) ? cur.delete(key) : cur.add(key);
      return { ...p, matrix: { ...p.matrix, [role]: [...cur] } };
    });
    setPermDirty(true);
  };
  const savePerms = async () => {
    const r = await putJson('/admin/permissions', {
      operator: perms.matrix.operator, viewer: perms.matrix.viewer, toolsDenied: perms.matrix.toolsDenied,
    }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setPerms((p) => ({ ...p, matrix: r.matrix })); setPermDirty(false); flash(true, '권한 매트릭스를 저장했습니다.'); }
    else flash(false, r.reason);
  };

  // 특수 기능 도구별 접근(거부목록 모델) — 체크 = 허용, 해제 = 거부. admin 은 항상 허용.
  const toolAllowedMx = (role, k) => !((perms?.matrix?.toolsDenied?.[role]) || []).includes(k);
  const toggleTool = (role, k) => {
    setPerms((p) => {
      const td = { operator: [...(p.matrix.toolsDenied?.operator || [])], viewer: [...(p.matrix.toolsDenied?.viewer || [])] };
      const cur = new Set(td[role]);
      cur.has(k) ? cur.delete(k) : cur.add(k); // 목록에 있으면 거부 → 제거하면 허용
      td[role] = [...cur];
      return { ...p, matrix: { ...p.matrix, toolsDenied: td } };
    });
    setPermDirty(true);
  };
  const setAllTools = (role, allow) => {
    setPerms((p) => {
      const td = { operator: [...(p.matrix.toolsDenied?.operator || [])], viewer: [...(p.matrix.toolsDenied?.viewer || [])] };
      td[role] = allow ? [] : SPECIAL_TOOLS.filter((t) => !t.adminOnly).map((t) => t.k); // 허용=거부목록 비움 / 차단=전부 거부
      return { ...p, matrix: { ...p.matrix, toolsDenied: td } };
    });
    setPermDirty(true);
  };
  const resetPerms = async () => {
    if (!window.confirm('권한 매트릭스를 기본값으로 되돌릴까요?')) return;
    const r = await postJson('/admin/permissions/reset', {}).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setPerms((p) => ({ ...p, matrix: r.matrix })); setPermDirty(false); flash(true, '기본값으로 초기화했습니다.'); }
    else flash(false, r.reason);
  };

  // ── 데이터 범위(scope) — 사용자가 볼 수 있는 vCenter/리전 제한 ──────────────
  const openScope = (u) => setScopeEdit({
    username: u.username,
    vcenters: [...(u.scope?.vcenters || [])],
    regions: [...(u.scope?.regions || [])],
  });
  const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const saveScope = async () => {
    const body = { scope: { vcenters: scopeEdit.vcenters, regions: scopeEdit.regions } };
    const r = await patchJson(`/admin/users/${encodeURIComponent(scopeEdit.username)}`, body).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setScopeEdit(null); await load(); flash(true, '데이터 범위를 저장했습니다.'); }
    else flash(false, r.reason);
  };
  const scopeLabel = (u) => {
    const n = (u.scope?.vcenters?.length || 0) + (u.scope?.regions?.length || 0);
    return n ? `제한(${n})` : '전체';
  };

  // ── 비밀번호 설정/로그인 차단(데모 계정 활성·잠금용) ─────────────────────────
  const savePassword = async () => {
    if (pwEdit.pw.length < 8) return setPwEdit((s) => ({ ...s, error: '비밀번호는 8자 이상이어야 합니다.' }));
    if (pwEdit.pw !== pwEdit.pw2) return setPwEdit((s) => ({ ...s, error: '비밀번호가 서로 일치하지 않습니다.' }));
    const r = await postJson(`/admin/users/${encodeURIComponent(pwEdit.username)}/password`, { password: pwEdit.pw })
      .catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setPwEdit(null); await load(); flash(true, '비밀번호를 설정했습니다 — 이제 이 계정으로 로그인할 수 있습니다.'); }
    else setPwEdit((s) => ({ ...s, error: r.reason }));
  };
  const blockLogin = async (u) => {
    if (!window.confirm(`'${u.username}' 계정의 비밀번호/OTP를 제거해 로그인을 차단할까요?\n(활성 세션도 즉시 종료됩니다. 다시 허용하려면 비밀번호를 새로 설정하면 됩니다.)`)) return;
    const r = await delJson(`/admin/users/${encodeURIComponent(u.username)}/password`).catch((e) => ({ ok: false, reason: e.message }));
    if (r?.ok !== false) { await load(); flash(true, '로그인을 차단했습니다(자격증명 제거).'); } else flash(false, r.reason);
  };

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 10 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>사용자 관리 (관리자)</div>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={() => setAdding((v) => !v)}>+ 사용자 추가</button>
      </div>

      {msg && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
      )}

      {adding && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="spec-grid">
            <label>사용자 ID<input className="input" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="alice" /></label>
            <label>이름<input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Alice" /></label>
            <label>역할
              <select className="select" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0' }}>비밀번호 없이 생성되며, 아래 목록에서 <b>OTP 등록</b> 후 QR을 사용자에게 전달하면 됩니다.</div>
          <div className="flex gap">
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!form.username} onClick={addUser}>추가</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setAdding(false)}>취소</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>사용자 ID</th><th>이름</th><th>역할</th><th>로그인 방식</th><th>데이터 범위</th><th style={{ textAlign: 'right' }}>관리</th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.username}>
                <td><b>{u.username}</b>
                  {u.demo && <span className="badge blue" style={{ marginLeft: 8 }} title="내장 데모 계정 — viewer 고정·삭제 불가. 비밀번호가 설정된 동안만 로그인할 수 있습니다.">데모</span>}
                  {u.superuser && <span className="badge green" style={{ marginLeft: 8 }} title="수퍼관리자 — 항상 admin 이며 강등·삭제·로그인 차단이 불가능합니다.">최고 관리자</span>}
                </td>
                <td>{u.name}</td>
                <td>
                  <select className="select" value={u.role} onChange={(e) => changeRole(u, e.target.value)} style={{ maxWidth: 130 }}
                    disabled={u.demo || u.superuser} title={u.demo ? '데모 계정은 viewer 고정입니다.' : u.superuser ? '수퍼관리자는 admin 고정입니다.' : undefined}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td>
                  {u.totpEnabled
                    ? <span className="badge green">OTP 전용</span>
                    : u.hasPassword ? <span className="badge amber">비밀번호</span>
                      : <span className="badge gray" title="비밀번호/OTP가 없어 이 계정으로는 로그인할 수 없습니다.">로그인 불가</span>}
                </td>
                <td>
                  <button className="tab" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => openScope(u)}
                    title="이 계정이 볼 수 있는 vCenter/리전을 제한합니다.">
                    {scopeLabel(u)}
                  </button>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* 비밀번호가 로그인에 쓰일 수 없는 계정에는 [비번 설정]을 노출하지 않는다:
                       · admin·operator — OTP 전용 정책(비번 로그인 차단). 온보딩은 [OTP 등록](QR)으로 한다.
                       · OTP 등록 계정 — 서버가 OTP 분기를 우선해 비밀번호를 아예 검증하지 않는다.
                     viewer(데모 포함)는 비번 로그인을 쓰므로 계속 노출된다. */}
                  {!u.totpEnabled && u.role !== 'admin' && u.role !== 'operator' && (
                    <>
                      <button className="tab" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => setPwEdit({ username: u.username, pw: '', pw2: '', error: null })}
                        title="비밀번호를 설정/변경합니다. admin·operator 는 이 비밀번호로 최초 1회 로그인한 뒤 OTP 등록을 마쳐야 하며, 등록 시 비밀번호는 삭제됩니다.">비번 설정</button>
                      {' '}
                    </>
                  )}
                  {(u.hasPassword || u.totpEnabled) && !u.superuser && (
                    <>
                      <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => blockLogin(u)}
                        title="비밀번호/OTP를 제거해 이 계정의 로그인을 차단합니다.">로그인 차단</button>
                      {' '}
                    </>
                  )}
                  {u.totpEnabled
                    ? <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => disableTotp(u)}>OTP 해제</button>
                    : <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => startEnroll(u)}>OTP 등록</button>}
                  {' '}
                  {!u.demo && !u.superuser && <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => remove(u)}>삭제</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        Google Authenticator(또는 MS Authenticator/Authy)로 QR을 스캔해 등록합니다.
        등록을 마치면 해당 계정의 비밀번호는 제거되어 <b>OTP 6자리로만</b> 로그인됩니다.
        <b> admin·operator(최고 관리자 포함) 계정은 OTP 로만 로그인합니다</b> — 비밀번호는 로그인에
        쓰이지 않으므로 이 계정들에는 [비번 설정] 버튼을 표시하지 않습니다. 새 admin·operator 는
        <b> [OTP 등록]</b> 으로 QR 을 발급해 전달하거나, 서버에서 <code>vmware-portal-otp &lt;계정&gt;</code>
        으로 등록하면 됩니다. viewer·데모 계정은 비밀번호 로그인을 쓰므로 [비번 설정]이 표시됩니다
        (단 OTP 를 등록하면 비밀번호가 삭제되어 버튼이 사라집니다). AD 계정은 AD 비밀번호로
        로그인하며 여기서 관리하지 않습니다.
      </div>

      {/* ── 기능 권한 매트릭스(역할 × 기능) ─────────────────────────────────── */}
      {perms && (
        <div className="card" style={{ marginTop: 22 }}>
          <div className="flex between wrap gap" style={{ marginBottom: 8 }}>
            <div className="section-title" style={{ margin: '4px 0' }}>기능 권한 (역할별)</div>
            <div className="flex gap">
              <button className="login-btn" style={{ flex: 'none', padding: '7px 14px', opacity: permDirty ? 1 : 0.55 }} disabled={!permDirty} onClick={savePerms}>저장</button>
              <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={resetPerms}>기본값</button>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
            역할에 기능 권한을 켜고 끕니다. <b>admin</b>은 항상 전체 권한을 가지며 변경할 수 없습니다.
            서버에서 강제되므로(메뉴를 숨겨도 API 직접 호출 차단), 저장 즉시 각 사용자에 반영됩니다.
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>기능</th><th style={{ textAlign: 'center' }}>admin</th><th style={{ textAlign: 'center' }}>operator</th><th style={{ textAlign: 'center' }}>viewer</th></tr></thead>
              <tbody>
                {(() => {
                  const rows = [];
                  let lastGroup = null;
                  for (const p of perms.catalog) {
                    if (p.group !== lastGroup) {
                      lastGroup = p.group;
                      rows.push(<tr key={`g-${p.group}`}><td colSpan={4} style={{ background: 'rgba(148,163,184,.08)', fontWeight: 700, fontSize: 12 }}>{p.group}</td></tr>);
                    }
                    rows.push(
                      <tr key={p.key}>
                        <td>{p.label} <span className="muted" style={{ fontSize: 11 }}>({p.key})</span></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked readOnly disabled title="admin은 항상 전체" /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={hasMx('operator', p.key)} onChange={() => togglePerm('operator', p.key)} /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={hasMx('viewer', p.key)} onChange={() => togglePerm('viewer', p.key)} /></td>
                      </tr>,
                    );
                  }
                  return rows;
                })()}
              </tbody>
            </table>
          </div>

          {/* 특수 기능 도구별 접근 — '특수 기능' 권한을 가진 역할에 대해 개별 도구를 켜고 끈다. */}
          <div className="flex between wrap gap" style={{ margin: '20px 0 6px' }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>특수 기능 — 도구별 접근</div>
            <div className="flex gap" style={{ fontSize: 12 }}>
              <span className="muted">operator:</span>
              <button className="tab" style={{ padding: '3px 8px' }} onClick={() => setAllTools('operator', true)}>전체허용</button>
              <button className="tab" style={{ padding: '3px 8px' }} onClick={() => setAllTools('operator', false)}>전체차단</button>
              <span className="muted" style={{ marginLeft: 8 }}>viewer:</span>
              <button className="tab" style={{ padding: '3px 8px' }} onClick={() => setAllTools('viewer', true)}>전체허용</button>
              <button className="tab" style={{ padding: '3px 8px' }} onClick={() => setAllTools('viewer', false)}>전체차단</button>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.7 }}>
            체크 = 해당 도구 접근 허용. '특수 기능' 기본 권한이 있어야 도구가 보이며, 여기서 도구별로 세부 차단할 수 있습니다.
            <b>관리자 전용</b> 도구(VM 생성·에이전트 작업 등)는 admin에게만 노출되어 목록에서 제외됩니다.
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>도구</th><th style={{ textAlign: 'center' }}>admin</th><th style={{ textAlign: 'center' }}>operator</th><th style={{ textAlign: 'center' }}>viewer</th></tr></thead>
              <tbody>
                {SPECIAL_TOOLS.filter((t) => !t.adminOnly).map((t) => (
                  <tr key={t.k}>
                    <td>{t.icon} {t.label} <span className="muted" style={{ fontSize: 11 }}>({t.k})</span></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked readOnly disabled title="admin은 항상 전체" /></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked={toolAllowedMx('operator', t.k)} onChange={() => toggleTool('operator', t.k)} /></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked={toolAllowedMx('viewer', t.k)} onChange={() => toggleTool('viewer', t.k)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {permDirty && <div className="muted" style={{ fontSize: 12, marginTop: 8, color: '#fbbf24' }}>변경사항이 저장되지 않았습니다 — [저장]을 눌러 적용하세요.</div>}
        </div>
      )}

      {/* ── 비밀번호 설정 모달(데모 계정 활성화 등) ─────────────────────────── */}
      {pwEdit && (
        <Modal title={`비밀번호 설정 — ${pwEdit.username}`} onClose={() => setPwEdit(null)} width={420}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.7 }}>
            8자 이상. 저장하면 이 계정으로 <b>비밀번호 로그인</b>이 가능해집니다(기존 세션 토큰은 폐기).
            데모 계정은 비밀번호가 설정된 동안만 로그인할 수 있습니다.
          </div>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>새 비밀번호</label>
          <input className="input" type="password" autoComplete="new-password" value={pwEdit.pw}
            onChange={(e) => setPwEdit((s) => ({ ...s, pw: e.target.value, error: null }))} style={{ width: '100%', boxSizing: 'border-box' }} />
          <label style={{ display: 'block', fontSize: 12, margin: '12px 0 6px' }}>비밀번호 확인</label>
          <input className="input" type="password" autoComplete="new-password" value={pwEdit.pw2}
            onChange={(e) => setPwEdit((s) => ({ ...s, pw2: e.target.value, error: null }))} style={{ width: '100%', boxSizing: 'border-box' }}
            onKeyDown={(e) => { if (e.key === 'Enter') savePassword(); }} />
          {pwEdit.error && <div className="login-error" style={{ marginTop: 10 }}>{pwEdit.error}</div>}
          <div className="flex gap" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setPwEdit(null)}>취소</button>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={!pwEdit.pw} onClick={savePassword}>저장</button>
          </div>
        </Modal>
      )}

      {/* ── 데이터 범위(scope) 편집 모달 ────────────────────────────────────── */}
      {scopeEdit && (
        <Modal title={`데이터 범위 — ${scopeEdit.username}`} onClose={() => setScopeEdit(null)} width={520}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.7 }}>
            선택한 <b>vCenter</b> 또는 <b>리전</b>의 데이터만 볼 수 있습니다. 아무것도 선택하지 않으면 <b>전체</b>를 봅니다.
            (리전을 고르면 그 리전의 모든 vCenter가 포함됩니다. 서버에서 강제됩니다.)
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, margin: '6px 0' }}>리전</div>
          <div className="flex wrap gap" style={{ marginBottom: 14 }}>
            {REGIONS.map((r) => (
              <label key={r} className="flex gap" style={{ alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={scopeEdit.regions.includes(r)}
                  onChange={() => setScopeEdit((s) => ({ ...s, regions: toggleIn(s.regions, r) }))} /> {r}
              </label>
            ))}
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, margin: '6px 0' }}>vCenter</div>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid rgba(148,163,184,.2)', borderRadius: 8, padding: 10 }}>
            {vcx.length === 0 && <div className="muted" style={{ fontSize: 12 }}>표시할 vCenter가 없습니다.</div>}
            {vcx.map((v) => (
              <label key={v.id} className="flex gap" style={{ alignItems: 'center', fontSize: 13, cursor: 'pointer', padding: '3px 0' }}>
                <input type="checkbox" checked={scopeEdit.vcenters.includes(v.id)}
                  onChange={() => setScopeEdit((s) => ({ ...s, vcenters: toggleIn(s.vcenters, v.id) }))} />
                {v.name || v.id} {v.region && <span className="muted" style={{ fontSize: 11 }}>· {v.region}</span>}
              </label>
            ))}
          </div>
          <div className="flex gap" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setScopeEdit({ ...scopeEdit, vcenters: [], regions: [] })}>전체(제한 해제)</button>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={saveScope}>저장</button>
          </div>
        </Modal>
      )}

      {enroll && (
        <Modal title={`OTP 등록 — ${enroll.username}`} onClose={() => setEnroll(null)} width={420}>
          <div style={{ textAlign: 'center' }}>
            {enroll.qr
              ? <img src={enroll.qr} alt="OTP QR" style={{ width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 6 }} />
              : <div className="muted">QR 생성 실패 — 아래 키를 수동 입력하세요.</div>}
            <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>수동 입력 키</div>
            <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{enroll.secret}</code>
            <div className="muted" style={{ fontSize: 12, margin: '14px 0 6px' }}>앱에 표시된 6자리 코드를 입력해 확인하세요.</div>
            <input className="input" value={enroll.code} maxLength={6} inputMode="numeric"
              onChange={(e) => setEnroll((s) => ({ ...s, code: e.target.value.replace(/\D/g, ''), error: null }))}
              placeholder="000000" style={{ textAlign: 'center', fontSize: 20, letterSpacing: 4, maxWidth: 180, margin: '0 auto' }} />
            {enroll.error && <div className="login-error" style={{ marginTop: 8 }}>{enroll.error}</div>}
            <div className="flex gap" style={{ justifyContent: 'center', marginTop: 14 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={enroll.code.length < 6} onClick={confirmEnroll}>확인 및 활성화</button>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setEnroll(null)}>취소</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
