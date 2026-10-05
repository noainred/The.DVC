/**
 * VM 구성 점검 — 특수 기능 `vm-hygiene`(v2.698). B10(v2.697) 구성 속성 + 스냅샷 정책 + 유령 스냅샷 + Tools 미설치 + 장기 미재부팅.
 * ⚠ 판정은 서버(`server/src/vmhygiene/analyze.js`) — 이 화면은 조립만. 문구는 `views/vmcfg/vmHygieneText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다(세대 번호).
 * ⚠ 설정 저장·지금 보내기는 전체 범위 관리자에게만 보인다(서버가 adminOnly + fullScopeOnly 로 집행).
 * ⚠ 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, downloadFile, canCsv, hasRole, getCurrentUser } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import {
  ALL_TEXT, SEV_LABEL, SEV_BADGE, codeChips, findingDetail, coverageText, coverageNote, notifyText, settingsPatch, RANGES,
} from '../vmcfg/vmHygieneText.js';

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}

function PolicyPanel({ settings, notify, canWrite, onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!settings) return;
    setForm({
      snapAgeDays: String(settings.snapAgeDays), snapCount: String(settings.snapCount), snapSizeGB: String(settings.snapSizeGB), uptimeDays: String(settings.uptimeDays),
      exceptionsText: (settings.exceptions || []).join('\n'), notify: { enabled: !!settings.notify?.enabled, hour: settings.notify?.hour ?? 9 },
    });
  }, [settings]);
  if (!settings || !form) return null;
  const save = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await putJson('/tools/vm-hygiene/settings', settingsPatch(form));
      if (r?.ok === false) throw new Error(r.reason || '저장 실패');
      setMsg('저장했습니다.'); onSaved?.();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const sendNow = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await postJson('/tools/vm-hygiene/notify-now', {});
      setMsg(r?.sent ? '보냈습니다.' : r?.reason === 'no-violation' ? '위반이 없어 보낼 내용이 없습니다.' : r?.reason === 'no-channel' ? '켜진 알림 채널이 없습니다 — 설정 › 알림에서 채널을 켜세요.' : `보내지 않았습니다(${r?.reason || '알 수 없음'}).`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const num = (k, label, unit) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 12 }}>
      <span className="muted">{label} ({RANGES[k][0]}~{RANGES[k][1].toLocaleString()} {unit})</span>
      <input className="input" style={{ minWidth: 0 }} inputMode="numeric" disabled={!canWrite} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="card" style={{ marginTop: 14, minWidth: 0 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>스냅샷 정책 · 판정 기준</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 10 }}>
        {num('snapAgeDays', '스냅샷 나이', '일')}
        {num('snapCount', '스냅샷 개수 초과', '개')}
        {num('snapSizeGB', '스냅샷 크기 초과', 'GB')}
        {num('uptimeDays', '장기 미재부팅', '일')}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10, fontSize: 12 }}>
        <span className="muted">스냅샷 정책 예외 — VM 이름이나 메모에 이 글자가 들어 있으면 스냅샷 정책 판정에서 뺍니다(한 줄에 하나, 대소문자 무시)</span>
        <textarea className="input" rows={3} disabled={!canWrite} value={form.exceptionsText} onChange={(e) => setForm({ ...form, exceptionsText: e.target.value })} style={{ minWidth: 0, fontFamily: 'var(--mono)' }} />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" disabled={!canWrite} checked={form.notify.enabled} onChange={(e) => setForm({ ...form, notify: { ...form.notify, enabled: e.target.checked } })} />
          스냅샷 정책 위반을 하루 한 번 알림 채널로 보내기
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="muted">보낼 시각</span>
          <select className="input" style={{ minWidth: 0 }} disabled={!canWrite} value={form.notify.hour} onChange={(e) => setForm({ ...form, notify: { ...form.notify, hour: Number(e.target.value) } })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}시 이후</option>)}
          </select>
        </label>
      </div>
      {notify && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{notifyText(notify)}</div>}
      {canWrite ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn" disabled={busy} onClick={save}>저장</button>
          <button type="button" className="btn" disabled={busy} onClick={sendNow} title="시각·하루 1회 조건과 무관하게 지금 요약을 보냅니다">지금 보내기</button>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>기준·예외·알림은 전체 범위 관리자만 바꿀 수 있습니다.</div>
      )}
      {msg && <div style={{ fontSize: 12, marginTop: 6 }}>{msg}</div>}
      {err && <ErrorBox error={err} />}
    </div>
  );
}

export default function VmHygieneTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [code, setCode] = useState('');
  const [sev, setSev] = useState('');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);

  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const params = {};
      if (vcId) params.vcenterId = vcId;
      if (code) params.code = code;
      if (sev) params.sev = sev;
      if (qApplied) params.q = qApplied;
      const d = await fetchJson('/tools/vm-hygiene', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, code, sev, qApplied]);
  const loadSettings = useCallback(async () => {
    try { const r = await fetchJson('/tools/vm-hygiene/settings'); setSettings(r?.settings || null); } catch { setSettings(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const u = getCurrentUser();
  const fullScope = !(u?.scope?.vcenters?.length || u?.scope?.regions?.length);
  const canWrite = hasRole('admin') && fullScope;
  const showCsv = canCsv();

  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams();
      if (vcId) qs.set('vcenterId', vcId); if (code) qs.set('code', code); if (sev) qs.set('sev', sev); if (qApplied) qs.set('q', qApplied);
      await downloadFile(`/tools/vm-hygiene.csv${qs.toString() ? `?${qs}` : ''}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const cov = data.coverage;
  const chips = codeChips(data.byCode);
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const note = coverageNote(cov);
  const rows = Array.isArray(data.rows) ? data.rows : [];

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        VM 구성(통합 필요·질문 대기·CBT·예약/제한·게스트 OS 대조·CD-ROM·디스크 모드)과 스냅샷 정책·유령 스냅샷·Tools 미설치·장기 미재부팅을 한 표로 봅니다. vCenter 에 따로 묻지 않습니다(수집 서버가 나눠 읽은 값).
      </div>
      {data.initial && <div className="banner" style={{ marginBottom: 8 }}>첫 수집 중입니다 — VM 목록이 아직 비어 있을 수 있습니다.</div>}
      <div style={{ fontSize: 13, marginBottom: 6 }}>{coverageText(cov)}</div>
      {note && <div className="banner" style={{ marginBottom: 8 }}>{note}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcs.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name} ({v.withFindings}/{v.vms})</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>심각도</span>
        {['', 'crit', 'warn', 'info'].map((s) => <Chip key={s || 'all'} active={sev === s} onClick={() => setSev(s)}>{s ? SEV_LABEL[s] : '전체'}</Chip>)}
        <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="VM·호스트·클러스터 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={() => { load(); loadSettings(); }} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        <Chip active={!code} onClick={() => setCode('')}>전체 판정</Chip>
        {chips.map((c) => (
          <Chip key={c.code} active={code === c.code} onClick={() => setCode(code === c.code ? '' : c.code)} title={ALL_TEXT[c.code]?.fix}>
            <span className={`badge ${SEV_BADGE[c.sev]}`} style={{ marginRight: 4 }}>{SEV_LABEL[c.sev]}</span>{c.title} <b>{c.vms.toLocaleString()}</b>
          </Chip>
        ))}
      </div>

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 13 }}>
            {data.total === 0 ? (cov?.notCollected ? '읽은 값에서 확인할 항목이 없습니다 — 아직 읽지 않은 VM 은 판정하지 않았습니다.' : '확인할 항목이 없습니다.') : '조건에 맞는 VM 이 없습니다.'}
          </div>
        ) : (
          <STable minWidth={820}>
            <thead><tr><th>VM</th><th>vCenter</th><th>호스트</th><th>심각도</th><th>판정</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ minWidth: 160 }}><VmLink name={r.name} vcenterId={r.vcenterId} /></td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.host || '—'}</td>
                  <td data-sort={{ crit: 0, warn: 1, info: 2 }[r.worst]}><span className={`badge ${SEV_BADGE[r.worst]}`}>{SEV_LABEL[r.worst]}</span></td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {r.findings.map((f) => (
                        <span key={f.code} className={`badge ${SEV_BADGE[f.sev]}`} title={[ALL_TEXT[f.code]?.fix, findingDetail(f)].filter(Boolean).join(' · ')} style={{ whiteSpace: 'nowrap' }}>
                          {ALL_TEXT[f.code]?.title || f.code}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>
      {data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>심각도 순 상위 {rows.length.toLocaleString()}대만 표시했습니다 — {data.omitted.toLocaleString()}대는 조건(vCenter·판정·검색)으로 좁혀 보세요.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>배지에 마우스를 올리면 조치와 근거가 보입니다. VM 이름을 누르면 VM 상세(구성 점검 칸)가 열립니다.</div>
      <PolicyPanel settings={settings} notify={data.notify} canWrite={canWrite} onSaved={() => { loadSettings(); load(); }} />
    </div>
  );
}
