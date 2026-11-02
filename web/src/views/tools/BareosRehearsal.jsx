/**
 * Bareos 복원 검증(리허설) 카드 · 일일 요약 메일 설정(v2.862 — 사용자 결정 ⓔ · ⓕ · 시안 ⑫ · docs/design/bareos-ui-v2 §11).
 *   복원 검증: 정한 요일 · 시각에 법인마다 몇 대를 새 VM 으로 복원 → NIC 끊기 → 켜기 → VMware Tools 응답 → 끄기 → 성공이면 지우기(실패는 남김).
 *   정책은 전 법인 공용이라 저장 · 지금 검증은 전체 범위 관리자 + 본인 OTP(서버가 집행). 결과 표는 조회 범위 안 대상만(서버가 거른다).
 *   무거운 조회가 아니어도 폴링하지 않는다(처음 한 번 + 다시 읽기 단추) — 운영 › 복원 화면의 목록 폴링이 진행 상태를 따로 바꾼다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { unitText } from '../unitText.js';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { Note, ReadGuide } from './BareosBits.jsx';
import { requireChanged } from '../changeResult.js';   // putJson 은 400 · 409 를 던지지 않고 본문을 돌려준다 — 실패를 '저장됨' 으로 보이지 않게
import { whenText } from './bareosText.js';
import { WEEKDAYS, rehearsalPolicyText, rehearsalDsOptions, toolsText, verifyText, verifyTone, digestStatusText } from './bareosRestoreText.js';

const BASE = '/tools/bareos-backup';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const FIELD = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };
const TONE_COLOR = { ok: '#86efac', bad: '#fca5a5', info: 'var(--text-dim)' };

export default function BareosRehearsal({ directors = [] }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [runDir, setRunDir] = useState('');
  const [dss, setDss] = useState(null);       // v2.863 vCenter → 데이터스토어 목록(정책 편집을 열 때 한 번 — 인벤토리 조회)
  const [dsErr, setDsErr] = useState(null);
  const gen = useRef(0);
  const load = useCallback(() => {
    const g = ++gen.current;
    setErr(null);
    fetchJson(`${BASE}/rehearsal`).then((r) => { if (g === gen.current) setD(r); }).catch((e) => { if (g === gen.current) setErr(e); });
  }, []);
  useEffect(() => { load(); }, [load]);
  const editing = !!edit;
  useEffect(() => {
    if (!editing || dss || dsErr) return;
    let live = true;
    fetchJson('/datastores').then((r) => {
      if (!live) return;
      const by = {};
      for (const x of r.items || []) (by[x.vcenterId] ||= []).push({ name: x.name, freeGB: x.freeGB ?? null, capacityGB: x.capacityGB ?? null, accessible: x.accessible });
      setDss(by);
    }).catch((e) => { if (live) setDsErr(e); });
    return () => { live = false; };
  }, [editing, dss, dsErr]);
  const setDs = (vcId, v) => setEdit((cur) => { const m = { ...(cur.datastores || {}) }; if (v) m[vcId] = v; else delete m[vcId]; return { ...cur, datastores: m }; });

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      requireChanged(await putJson(`${BASE}/rehearsal`, { ...edit, otp }));
      setMsg({ ok: true, text: '복원 검증 정책을 저장했습니다.' }); setEdit(null); load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); setOtp(''); }
  };
  const runNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = requireChanged(await postJson(`${BASE}/rehearsal/run`, { directorId: runDir, otp }));
      setMsg({ ok: r.started > 0, text: r.started ? `검증 복원을 ${r.started}대 시작했습니다 — 복원이 끝나면 켜 보고 결과가 아래 표에 남습니다.` : `시작하지 않았습니다 — ${r.reason || '대상 없음'}` });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); setOtp(''); }
  };

  if (err && !d) return <div className="card" style={{ padding: 12 }}><ErrorBox error={err} /></div>;
  if (!d) return <div className="card" style={{ padding: 12 }}><Loading /></div>;
  const p = d.policy || {};
  const dirName = (id) => directors.find((x) => x.id === id)?.name || id || '—';

  return (
    <div className="card" data-bareos-rehearsal="" style={{ padding: 12, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={ROW}>
        <b style={{ fontSize: 13.5 }}>복원 검증(리허설)</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>{rehearsalPolicyText(p)}</span>
        <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }} onClick={load}>다시 읽기</button>
        {d.fullScope && !edit && <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => { setEdit({ enabled: !!p.enabled, weekday: p.weekday ?? 6, time: p.time || '03:17', perCorp: p.perCorp ?? 3, deleteOnOk: p.deleteOnOk !== false, datastores: { ...(p.datastores || {}) } }); /* vCenter 별 데이터스토어 — 아래 칸에 없는 vCenter 의 값도 저장이 지우지 않게(반증 F5) */ setMsg(null); }}>정책 바꾸기</button>}
      </div>
      {d.loadError && <Note tone="bad">복원 검증 정책 파일을 읽지 못했습니다(손상본 보존) — 검증을 돌리지 않고 저장을 막았습니다.</Note>}
      {!p.enabled && <Note tone="info">꺼져 있습니다 — 검증은 VM 을 새로 만들고 데이터스토어를 씁니다. 전체 범위 관리자가 정책을 켜야 정한 요일 · 시각에 돕니다.</Note>}
      {msg && <Note tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Note>}
      {edit && (
        <div style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, background: 'var(--panel-deep)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 8 }}>
            <label className="muted" style={{ ...FIELD, flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />켜기</label>
            <label className="muted" style={FIELD}>요일
              <Select className="input" sort={false} value={String(edit.weekday)} onChange={(e) => setEdit({ ...edit, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}요일</option>)}
              </Select>
            </label>
            <label className="muted" style={FIELD}>시각(포탈 시각)
              <input className="input" value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} placeholder="03:17" />
            </label>
            <label className="muted" style={FIELD}>법인마다(대)
              <input className="input" type="number" min={1} max={10} value={edit.perCorp} onChange={(e) => setEdit({ ...edit, perCorp: Number(e.target.value) })} />
            </label>
            <label className="muted" style={{ ...FIELD, flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={edit.deleteOnOk} onChange={(e) => setEdit({ ...edit, deleteOnOk: e.target.checked })} />성공한 검증용 VM 지우기</label>
          </div>
          {(d.vcenters || []).length > 0 && (
            <details data-rehearsal-ds="" style={{ minWidth: 0 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>검증용 VM 을 만들 데이터스토어(vCenter 마다) · 지정 {Object.keys(edit.datastores || {}).length}곳</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, minWidth: 0 }}>
                <span className="muted" style={{ fontSize: 12 }}>고르지 않으면 VM 의 홈 데이터스토어(첫 디스크)에 만듭니다. 어느 쪽이든 검증 때 여유를 합산해 보고, 여유나 VM 용량을 읽지 못하면 그 VM 은 건너뜁니다.</span>
                {dsErr && <Note tone="bad">데이터스토어 목록을 읽지 못했습니다 — 지금 값은 그대로 둡니다.</Note>}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 8 }}>
                  {d.vcenters.map((vc) => (
                    <label key={vc.id} className="muted" style={FIELD}>
                      <span style={{ overflowWrap: 'anywhere' }}>{vc.name} · 대상 {unitText(vc.jobs, '대')}</span>
                      <Select className="input" sort={false} style={{ minWidth: 0 }} value={edit.datastores?.[vc.id] || ''} onChange={(e) => setDs(vc.id, e.target.value)} aria-label={`${vc.name} 검증 데이터스토어`}>
                        {rehearsalDsOptions(dss && !dsErr ? (dss[vc.id] || []) : null, edit.datastores?.[vc.id], { loading: !dss && !dsErr }).map((o) => <option key={o.value || '-'} value={o.value}>{o.label}</option>)}
                      </Select>
                    </label>
                  ))}
                </div>
                {!dss && !dsErr && <span className="muted" style={{ fontSize: 12 }}>데이터스토어 목록을 읽는 중…</span>}
              </div>
            </details>
          )}
          <div style={ROW}>
            <label className="muted" style={{ ...FIELD, width: 180 }}>본인 OTP(6자리)
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </label>
            <span className="muted" style={{ fontSize: 12, flex: '1 1 240px', minWidth: 0 }}>검증용 VM 은 '원래 이름-verify-날짜' 로 백업 당시 자리에 꺼진 채로 만들어지고, 켜기 전에 네트워크 어댑터를 모두 끊습니다. 실패한 검증용 VM 은 지우지 않고 남깁니다(조사용).</span>
            <button type="button" className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => setEdit(null)}>취소</button>
            <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy || !/^\d{6}$/.test(otp)} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
          </div>
        </div>
      )}
      {d.fullScope && !edit && (
        <div style={ROW}>
          <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={runDir} onChange={(e) => setRunDir(e.target.value)} aria-label="지금 검증할 법인">
            <option value="">지금 검증할 법인 고르기…</option>
            {directors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <input className="input" style={{ width: 130 }} inputMode="numeric" autoComplete="one-time-code" placeholder="본인 OTP" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="지금 검증 OTP" />
          <button type="button" className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={busy || !runDir || !/^\d{6}$/.test(otp)} onClick={runNow}>{busy ? '보내는 중…' : `지금 검증 · 법인마다 ${unitText(p.perCorp, '대')}`}</button>
        </div>
      )}
      {/* v2.863: 결과가 없으면 표 대신 문구만 — 760px 표 가운데 칸에 두면 좁은 화면(400px)에서 가로 스크롤 밖으로 잘렸다(Chromium 판독) */}
      {!d.results.length && <div className="muted" style={{ fontSize: 12.5, padding: '10px 4px' }}>아직 검증 결과가 없습니다.</div>}
      {d.results.length > 0 && <div className="table-wrap" style={{ maxHeight: '40vh' }}>
        <STable minWidth={760} wrap={false}>
          <thead><tr><th>VM</th><th>검증용 VM</th><th>시작</th><th>결과</th><th>Tools 응답</th><th>정리</th></tr></thead>
          <tbody>
            {d.results.map((x) => (
              <tr key={`${x.jobId}-${x.rid}`}>
                <td data-sort={x.vmName}><b>{x.vmName}</b><div className="muted" style={{ fontSize: 11 }}>{dirName(x.directorId)}</div></td>
                <td style={{ fontSize: 12 }}>{x.name || '—'}</td>
                <td data-sort={x.at ?? ''}>{whenText(x.at)}</td>
                <td style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 320, color: TONE_COLOR[verifyTone(x)] }} title={x.finish?.detail || undefined}>{verifyText(x)}{x.finish?.detail && x.finish?.verify !== 'ok' ? <div className="muted" style={{ fontSize: 11 }}>{String(x.finish.detail).slice(0, 160)}</div> : null}</td>
                <td data-sort={x.finish?.toolsMs ?? ''}>{toolsText(x.finish?.toolsMs)}</td>
                <td style={{ fontSize: 12 }}>{x.finish?.deleted ? '지움' : x.finish?.verify ? '남김' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>}
      <ReadGuide note="검증은 켜 보기까지만 합니다 — 네트워크를 끊은 채라 핑 · 앱 시험은 하지 않습니다.">
        <div>① 고르기: 법인마다 마지막 백업이 성공한 활성 대상 중 가장 오래 검증하지 않은 VM 부터(돌아가며). 진행 중 복원이 있거나 등록 뒤 위치가 바뀐 VM 은 뺍니다.</div>
        <div>② 회차는 보내기 전에 기록합니다 — 같은 날 다시 돌지 않습니다. 인증이 멈춘 Director 는 정기 검증에서 건너뜁니다.</div>
        <div>③ 결과는 일일 요약 메일에도 실립니다(설정 › 공통 기본값 · 수집).</div>
      </ReadGuide>
    </div>
  );
}

/** 일일 요약 메일 설정(설정 › 공통 기본값 · 수집 안 — 전체 범위 관리자). */
export function BareosDigestSettings() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => { fetchJson(`${BASE}/digest`).then((r) => { setD(r); setForm({ enabled: r.config.enabled !== false, time: r.config.time || '08:30' }); }).catch(setErr); }, []);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <ErrorBox error={err} />;
  if (!d || !form) return <Loading />;
  const save = async () => {
    setBusy(true); setMsg(null);
    try { requireChanged(await putJson(`${BASE}/digest`, form)); setMsg({ ok: true, text: '저장했습니다.' }); load(); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const sendNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = requireChanged(await postJson(`${BASE}/digest/send`, {})); setMsg({ ok: true, text: r.skipped ? '백업 대상이 없어 보내지 않았습니다.' : '보냈습니다 — 받은 편지함을 확인하세요.' }); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div data-bareos-digest="" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>법인마다 최근 24시간의 백업 결과(성공 · 경고 · 실패 · 실행 없음) · 복원 · 복원 검증과 실패한 VM 목록을 하루 한 번 보냅니다. Director 조회가 실패 중인 법인은 수 대신 ‘모름’ 으로 적습니다. 받는 사람은 설정 › 메일 발송의 ‘Bareos 일일 요약’ 종류입니다.</div>
      {d.loadError && <Note tone="bad">설정 파일을 읽지 못했습니다(손상본 보존) — 보내지 않고 저장을 막았습니다.</Note>}
      <div style={ROW}>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />보내기</label>
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}>시각(포탈 시각)<input className="input" style={{ width: 90 }} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '5px 12px' }} disabled={busy} onClick={save}>저장</button>
        <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={sendNow}>지금 보내 보기</button>
        <span className="muted" style={{ fontSize: 12 }}>마지막: {digestStatusText(d.status)}</span>
      </div>
      {msg && <Note tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Note>}
    </div>
  );
}
