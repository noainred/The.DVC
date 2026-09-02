import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const EMPTY = { id: '', name: '', host: 'https://', username: 'admin', password: '', datacenterId: '', enabled: true };

/**
 * 설정 → Unity 스토리지: Dell EMC Unity(Unisphere) 등록/수정/삭제 + **API 동작 확인(연결 테스트)**.
 *
 * 연결 테스트는 도달성 → 인증 → 데이터 조회 3단계를 서버에서 순서대로 시도하고, 실패하면
 * '어느 단계에서' 왜 막혔는지와 조치 안내를 함께 돌려준다(실측: 대상이 Unity 가 아니면
 * SSO 로그인 페이지로 302 되는데, 그냥 '실패'로만 보이면 원인 파악이 불가능했다).
 */
export default function UnityAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);       // 저장 결과
  const [test, setTest] = useState(null);     // 연결 테스트 결과(구조화)
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try { setData(await fetchJson('/admin/unity')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm(structuredClone(EMPTY)); setMsg(null); setTest(null); };
  const openEdit = (a) => { setEditing(true); setForm({ ...structuredClone(EMPTY), ...a, password: '' }); setMsg(null); setTest(null); };
  const close = () => { setForm(null); setMsg(null); setTest(null); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing
        ? await putJson(`/admin/unity/${encodeURIComponent(form.id)}`, form)
        : await postJson('/admin/unity', form);
      if (r.ok) { await load(); close(); } else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  // 저장 전에도 동작한다(폼 값 그대로 전송). 저장된 항목은 비밀번호를 비워두면 저장된 값을 쓴다.
  const runTest = async () => {
    setTesting(true); setTest(null); setMsg(null);
    try { setTest(await postJson('/admin/unity/test', form)); }
    catch (e) { setTest({ ok: false, reason: e.message }); } finally { setTesting(false); }
  };

  const remove = async (a) => {
    if (!window.confirm(`'${a.name}' (${a.id}) Unity 장비를 삭제할까요?`)) return;
    try { await delJson(`/admin/unity/${encodeURIComponent(a.id)}`); await load(); } catch (e) { setError(e.message); }
  };

  const list = data.arrays || [];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>Unity 스토리지 등록 — Dell EMC Unity (Unisphere REST)</b>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px', marginLeft: 'auto' }} onClick={openAdd}>+ 장비 추가</button>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
        Unisphere REST API(HTTPS)로 풀 용량·상태를 조회합니다. 등록 전 <b>[연결 테스트]</b>로 API가 실제로
        동작하는지 확인하세요 — 도달성·인증·데이터 조회를 순서대로 검사해 막힌 단계를 알려줍니다.
        계정은 <b>읽기 전용(operator)</b> 권장. 자체서명 인증서는 기본 허용이며 <code>UNITY_TLS_STRICT=true</code>로 검증을 켤 수 있습니다.
      </div>

      {list.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>등록된 Unity 장비가 없습니다. ‘+ 장비 추가’로 등록하세요.</div>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>ID</th><th>표시 이름</th><th>주소</th><th>계정</th><th>법인(DC)</th><th>수집</th><th className="right">작업</th></tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td><b>{a.id}</b></td>
                <td>{a.name}</td>
                <td className="muted" style={{ fontSize: 12 }}>{a.host}</td>
                <td>{a.username}{a.hasPassword ? '' : ' (비번 없음)'}</td>
                <td>{a.datacenterId || <span className="muted">—</span>}</td>
                <td>{a.enabled !== false ? <span className="badge green">수집</span> : <span className="badge">중지</span>}</td>
                <td className="right">
                  <button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12 }} onClick={() => openEdit(a)}>수정</button>
                  <button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12, marginLeft: 6, color: 'var(--red)' }} onClick={() => remove(a)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {form && (
        <>
          <EscClose onClose={close} />
          <div className="card" style={{ marginTop: 16, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <b style={{ fontSize: 14 }}>{editing ? `Unity 수정 — ${form.id}` : 'Unity 장비 추가'}</b>
              <button className="logout-btn" style={{ padding: '5px 10px', marginLeft: 'auto' }} onClick={close}>닫기</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Field label="ID *">
                <input className="input" value={form.id} onChange={setF('id')} disabled={editing} placeholder="unity-seoul-01" />
              </Field>
              <Field label="표시 이름 *">
                <input className="input" value={form.name} onChange={setF('name')} placeholder="Seoul Unity 480F" />
              </Field>
              <Field label="법인(DataCenter)">
                <input className="input" value={form.datacenterId} onChange={setF('datacenterId')} placeholder="seoul" />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginTop: 12 }}>
              <Field label="Unisphere 주소 * (https://IP)">
                <input className="input" value={form.host} onChange={setF('host')} placeholder="https://10.0.0.10" />
              </Field>
              <Field label="계정 *">
                <input className="input" value={form.username} onChange={setF('username')} autoComplete="off" />
              </Field>
              <Field label={editing ? '비밀번호 (비우면 유지)' : '비밀번호 *'}>
                <input className="input" type="password" value={form.password} onChange={setF('password')} autoComplete="new-password" />
              </Field>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '9px 20px' }} disabled={busy} onClick={save}>
                {busy ? '저장 중…' : '저장'}
              </button>
              <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={testing} onClick={runTest}>
                {testing ? '테스트 중…' : '🔌 연결 테스트'}
              </button>
              <span className="muted" style={{ fontSize: 11.5 }}>저장 전에도 테스트할 수 있습니다.</span>
            </div>

            {msg && (
              <div className={msg.ok ? 'card' : 'card error-box'} style={{ marginTop: 12, padding: 10, fontSize: 13 }}>{msg.text}</div>
            )}
            {test && <TestResult r={test} />}
          </div>
        </>
      )}
    </>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

/** 연결 테스트 결과 — 성공이면 장비 식별 정보, 실패면 '막힌 단계 + 원인 + 조치'를 보여준다. */
function TestResult({ r }) {
  if (r.ok) {
    return (
      <div className="card" style={{ marginTop: 12, padding: 12, fontSize: 13, borderColor: 'var(--green)' }}>
        <div><b style={{ color: 'var(--green)' }}>✅ 연결 성공</b> — API가 정상 동작합니다.</div>
        <div className="muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
          모델 <b>{r.model}</b>{r.name ? ` · 이름 ${r.name}` : ''}{r.serialNumber ? ` · S/N ${r.serialNumber}` : ''}<br />
          {r.oeVersion ? `OE ${r.oeVersion} · ` : ''}{r.apiVersion ? `API ${r.apiVersion} · ` : ''}
          스토리지 풀 <b>{r.pools}</b>개 조회됨 · {r.ms}ms
        </div>
      </div>
    );
  }
  return (
    <div className="card error-box" style={{ marginTop: 12, padding: 12, fontSize: 13 }}>
      <div>
        <b>❌ 연결 실패</b>
        {r.stepLabel ? <> — <b>{r.stepLabel}</b> 단계에서 막혔습니다.</> : null}
        {r.ms != null ? <span className="muted" style={{ fontSize: 11.5 }}> ({r.ms}ms)</span> : null}
      </div>
      <div style={{ marginTop: 6 }}>{r.reason}</div>
      {r.hint && <div className="muted" style={{ marginTop: 8, lineHeight: 1.6 }}>💡 {r.hint}</div>}
    </div>
  );
}
