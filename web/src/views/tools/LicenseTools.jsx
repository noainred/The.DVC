// LicenseTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { DataTable, Loading, ErrorBox, UsageCell } from '../../components/ui.jsx';
import { Card, useTool } from './shared.jsx';


export function Solutions() {
  const { loading, data, error } = useTool('/tools/solutions', {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  // 버전 드리프트 강조(v2.327): 같은 제품인데 버전이 2개 이상이면 노랑(사이트 간 불일치 = 패치 필요 신호).
  const drift = (arr) => (arr || []).length > 1;
  const VerBadges = ({ arr, unit }) => (
    <div className="flex gap wrap" style={{ marginBottom: 14 }}>
      {(arr || []).length === 0 && <span className="muted">정보 없음</span>}
      {(arr || []).map((n) => <span key={n.version} className={`badge ${drift(arr) ? 'amber' : 'blue'}`} style={{ fontSize: 13, padding: '4px 10px' }} title={drift(arr) ? '사이트 간 버전 불일치 — 패치 수준 확인' : '전 사이트 동일 버전'}>{n.version} · {n.count}{unit}</span>)}
    </div>
  );
  return (
    <>
      {/* 전 함대 버전 요약(v2.327, 사용자 요구 — 모든 vCenter 의 NSX 포함 솔루션 버전 한눈에).
          버전이 2개 이상이면(드리프트) 노란 배지로 사이트 간 불일치를 강조한다. */}
      <div className="section-title" style={{ marginTop: 0 }}>vCenter 버전 분포 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>({data.items.length} 사이트)</span></div>
      <VerBadges arr={data.vcenterVersions} unit=" 사이트" />
      <div className="section-title">ESXi 버전 분포 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(호스트 수)</span></div>
      <VerBadges arr={data.esxiVersions} unit=" 호스트" />
      {/* NSX 버전 분포 — 각 버전이 설치된 법인(datacenter)까지 표시(v2.327 사용자 요구) */}
      <div className="section-title">NSX Manager 버전 분포 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(실수집 {data.nsxManagerCount ?? 0} 매니저 · 설치 법인 표시)</span></div>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        {(data.nsxVersions || []).length === 0 && <span className="muted">NSX 정보 없음</span>}
        {(data.nsxVersions || []).map((n) => (
          <div key={n.version} className="card" style={{ padding: '8px 12px', minWidth: 180 }}>
            <div><span className={`badge ${drift(data.nsxVersions) ? 'amber' : 'blue'}`} style={{ fontSize: 13, padding: '3px 9px' }} title={drift(data.nsxVersions) ? '법인 간 NSX 버전 불일치' : '전 법인 동일 버전'}>NSX {n.version}</span> <span className="muted" style={{ fontSize: 12 }}>· {n.count} 매니저</span></div>
            <div className="flex gap wrap" style={{ marginTop: 6 }}>
              {(n.corps || []).map((c) => <span key={c.corp} className="badge gray" style={{ fontSize: 11 }} title={`${c.corp} — NSX Manager ${c.count}`}>{c.corp}{c.count > 1 ? ` ×${c.count}` : ''}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">vCenter별 설치 버전 (vCenter · ESXi · NSX · 확장 솔루션)</div>
      <div className="grid cols-2">
        {data.items.map((it) => (
          <div className="card" key={it.vcenterId}>
            <div className="flex between" style={{ marginBottom: 8 }}>
              <b>{it.name}{it.corp ? <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> · 법인 {it.corp}</span> : it.region ? <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> · {it.region}</span> : ''}</b>
              <span className="muted" style={{ fontSize: 12 }}>vCenter v{it.version || '—'}{it.build ? ` (b${it.build})` : ''}</span>
            </div>
            {/* ESXi 버전(사이트 내 호스트) — 여러 버전이면 드리프트 */}
            {(it.esxi || []).length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>ESXi</span>
                {it.esxi.map((e) => <span key={e.version} className={`badge ${it.esxi.length > 1 ? 'amber' : 'gray'}`} style={{ marginRight: 4, fontSize: 11 }}>{e.version} × {e.count}</span>)}
              </div>
            )}
            {/* 실제 NSX Manager(nsxStore) — vCenter 확장 항목보다 권위 있음 */}
            {(it.nsxManagers || []).length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>🛡️ NSX</span>
                {it.nsxManagers.map((m, i) => <span key={i} className={`badge ${m.status === 'connected' ? 'green' : 'red'}`} style={{ marginRight: 4, fontSize: 11 }} title={`${m.host || ''} · ${m.status}`}>{m.name} {m.version || '?'}</span>)}
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead><tr><th>확장 솔루션</th><th>버전</th><th>공급사</th></tr></thead>
                <tbody>
                  {(it.solutions || []).slice(0, 30).map((s) => (
                    <tr key={s.key}><td>{/nsx/i.test(s.key + s.label) ? '🛡️ ' : ''}{s.label}</td><td className="tabular">{s.version || '—'}</td><td className="muted">{s.company || '—'}</td></tr>
                  ))}
                  {(it.solutions || []).length === 0 && <tr><td colSpan={3} className="muted center" style={{ padding: 14 }}>vCenter 확장 솔루션 정보 없음</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function Licenses({ scope }) {
  const { loading, data, error } = useTool('/tools/licenses', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'name', label: '라이선스', render: (l) => <b>{l.name}</b> },
    { key: 'vcenterName', label: 'vCenter', render: (l) => <span className="muted">{l.vcenterName}</span> },
    { key: 'productVersion', label: '버전' },
    { key: 'used', label: '사용', align: 'right' },
    { key: 'total', label: '총량', align: 'right' },
    { key: 'usePct', label: '사용률', sortValue: (l) => (l.total ? l.used / l.total : 0), render: (l) => <UsageCell pct={l.total ? Math.round((l.used / l.total) * 100) : 0} /> },
    { key: 'expires', label: '만료', render: (l) => <span style={{ color: isSoon(l.expires) ? 'var(--amber)' : undefined }}>{l.expires || '—'}</span> },
  ];
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>제품별 합계</div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        {data.byLicense.map((b) => <Card key={b.name} label={b.name} value={`${b.used}/${b.total}`} meta={b.productVersion ? `v${b.productVersion}` : ''} />)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'used', dir: 'desc' }} />
    </>
  );
}
function isSoon(d) { if (!d) return false; const t = Date.parse(d); return t && t - Date.now() < 90 * 86400000; }

/**
 * 라이선스 만료일 확인 — vCenter LicenseManager(ESXi·vCenter·vSAN·VCF/VVF 등 등록 전 제품)
 * + NSX Manager + Horizon Connection Server(등록 시 REST 직수집)의 유효/만료 날짜 통합.
 * 만료(빨강)/90일 임박(노랑)/정상/영구 분류 + 제품군 필터 + CSV. 관리자는 Horizon 서버 등록 가능.
 */
export function LicenseExpiry({ scope, isAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [statusSel, setStatusSel] = useState('');
  const [familySel, setFamilySel] = useState('');
  const [hz, setHz] = useState(null); // Horizon 서버 목록(관리자)
  const [hzForm, setHzForm] = useState({ id: '', name: '', host: '', username: '', password: '', domain: '' });
  const [hzMsg, setHzMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetchJson('/tools/license-expiry', scope ? { vcenterId: scope } : {}).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
    if (isAdmin) fetchJson('/admin/horizon').then((r) => setHz(r.servers || [])).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope]);

  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;

  const STATUS = [
    ['expired', '만료', 'var(--red)'], ['expiring', '90일 이내 만료', 'var(--amber)'],
    ['ok', '정상', 'var(--green)'], ['perpetual', '영구/만료없음', 'var(--text-faint)'],
  ];
  const statusLabel = Object.fromEntries(STATUS.map(([k, l]) => [k, l]));
  const statusColor = Object.fromEntries(STATUS.map(([k, , c]) => [k, c]));
  const rows = (data.items || []).filter((i) => (!statusSel || i.status === statusSel) && (!familySel || i.family === familySel));

  const dday = (i) => (i.daysLeft == null ? '' : i.daysLeft < 0 ? `D+${-i.daysLeft}` : `D-${i.daysLeft}`);
  const cols = [
    { key: 'family', label: '제품군', render: (i) => <span className="badge blue">{i.family}</span> },
    { key: 'name', label: '라이선스', render: (i) => <b>{i.name}</b> },
    { key: 'source', label: '소스', render: (i) => <span className="muted">{i.source} · {i.where}</span> },
    { key: 'productVersion', label: '버전', render: (i) => <span className="muted">{i.productVersion || '—'}</span> },
    { key: 'key', label: '키', render: (i) => <span className="muted" style={{ fontSize: 11 }}>{i.key || '—'}</span> },
    { key: 'used', label: '사용/총량', align: 'right', sortValue: (i) => i.used ?? -1, render: (i) => (i.total != null ? `${i.used ?? '—'}/${i.total}` : '—') },
    { key: 'expires', label: '만료일', sortValue: (i) => (i.expires ? Date.parse(i.expires) : Infinity), render: (i) => (i.expires ? <b style={{ color: statusColor[i.status] }}>{i.expires}</b> : <span className="muted">영구/미표기</span>) },
    { key: 'daysLeft', label: '남은 기간', align: 'right', sortValue: (i) => (i.daysLeft == null ? Infinity : i.daysLeft), render: (i) => <b style={{ color: statusColor[i.status] }}>{dday(i) || '—'}</b> },
    { key: 'status', label: '상태', render: (i) => <span className="badge" style={{ color: statusColor[i.status], borderColor: statusColor[i.status] }}>{statusLabel[i.status]}</span> },
  ];

  const exportCsv = () => {
    const head = ['family', 'name', 'source', 'where', 'edition', 'productVersion', 'key', 'used', 'total', 'expires', 'daysLeft', 'status'];
    const lines = rows.map((i) => [i.family, i.name, i.source, i.where, i.edition, i.productVersion, i.key, i.used ?? '', i.total ?? '', i.expires || 'perpetual', i.daysLeft ?? '', statusLabel[i.status]]);
    const csv = [head, ...lines].map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'license-expiry.csv'; a.click(); URL.revokeObjectURL(url);
  };

  const hzSet = (k) => (e) => setHzForm((f) => ({ ...f, [k]: e.target.value }));
  const hzSave = async () => {
    setBusy(true); setHzMsg(null);
    try {
      const body = { ...hzForm, id: hzForm.id || hzForm.host.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '-') };
      const r = await postJson('/admin/horizon', body);
      setHzMsg(r.ok ? { ok: true, text: '저장됨 — 라이선스를 다시 불러옵니다.' } : { ok: false, text: r.reason });
      if (r.ok) { setHzForm({ id: '', name: '', host: '', username: '', password: '', domain: '' }); load(); }
    } catch (e) { setHzMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const hzTest = async () => {
    setBusy(true); setHzMsg(null);
    try {
      const r = await postJson('/admin/horizon/test', hzForm.host ? hzForm : { id: hzForm.id });
      setHzMsg(r.ok ? { ok: true, text: `연결 성공 (${r.ms}ms) · 라이선스 ${r.licenses}건${r.first ? ` · ${r.first}` : ''}` } : { ok: false, text: `${r.reason}${r.hint ? ` · ${r.hint}` : ''}` });
    } catch (e) { setHzMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const hzDel = async (id) => {
    if (!window.confirm(`Horizon 서버 '${id}' 등록을 삭제할까요?`)) return;
    try { await delJson(`/admin/horizon/${encodeURIComponent(id)}`); load(); } catch (e) { setHzMsg({ ok: false, text: e.message }); }
  };

  return (
    <>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="전체 라이선스" value={data.total} meta={scope ? '선택 vCenter' : `vCenter+NSX+Horizon${data.horizonServers ? `(${data.horizonServers})` : ''}`} />
        {STATUS.map(([k, l]) => <Card key={k} label={l} value={data.summary?.[k] || 0} />)}
      </div>

      {(data.collectionErrors || []).length > 0 && (
        <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'rgba(251,191,36,.1)', color: 'var(--amber)' }}>
          ⚠ 일부 수집 실패: {data.collectionErrors.join(' · ')}
        </div>
      )}

      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        {STATUS.map(([k, l, c]) => (
          <button key={k} className="tab" style={{ padding: '5px 12px', fontWeight: 700, color: c, background: statusSel === k ? 'rgba(148,163,184,.15)' : undefined }}
            onClick={() => setStatusSel(statusSel === k ? '' : k)}>{l} <b>{data.summary?.[k] || 0}</b></button>
        ))}
        <span style={{ width: 10 }} />
        {(data.families || []).map((f) => (
          <button key={f} className="tab" style={{ padding: '5px 12px', background: familySel === f ? 'rgba(34,211,238,.15)' : undefined }}
            onClick={() => setFamilySel(familySel === f ? '' : f)}>{f}</button>
        ))}
        <button className="tab" style={{ marginLeft: 'auto', padding: '5px 12px' }} onClick={exportCsv}>CSV 내보내기</button>
      </div>

      <DataTable columns={cols} rows={rows} initialSort={{ key: 'daysLeft', dir: 'asc' }} />

      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        vCenter 소스는 LicenseManager에 등록된 모든 키(ESXi·vCenter·vSAN·VCF/VVF 및 vCenter에 할당된 타 제품 포함)이고, NSX는 각 매니저에서 직접 수집합니다.
        Horizon은 아래에 Connection Server를 등록하면 REST API로 만료일을 직수집합니다(10분 캐시).
      </div>

      {isAdmin && (
        <details style={{ marginTop: 14 }} open={(hz || []).length === 0}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>🖥️ Horizon 연결 서버 관리 ({(hz || []).length}대 등록)</summary>
          <div className="card" style={{ marginTop: 8, padding: 14 }}>
            {(hz || []).length > 0 && (
              <table style={{ marginBottom: 10 }}>
                <thead><tr><th>ID</th><th>이름</th><th>host</th><th>계정</th><th>도메인</th><th className="right">작업</th></tr></thead>
                <tbody>
                  {hz.map((s) => (
                    <tr key={s.id}>
                      <td><b>{s.id}</b></td><td>{s.name}</td><td className="muted">{s.host}</td><td className="muted">{s.username}</td><td className="muted">{s.domain}</td>
                      <td className="right nowrap">
                        <button className="tab" disabled={busy} onClick={() => { setHzForm({ id: s.id, name: s.name, host: s.host, username: s.username, password: '', domain: s.domain }); }}>편집</button>{' '}
                        <button className="tab" style={{ color: 'var(--red)' }} onClick={() => hzDel(s.id)}>삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="spec-grid">
              <label>ID <input className="input" value={hzForm.id} onChange={hzSet('id')} placeholder="비우면 host로 자동" /></label>
              <label>표시 이름 <input className="input" value={hzForm.name} onChange={hzSet('name')} placeholder="본사 Horizon" /></label>
              <label>Connection Server <input className="input" value={hzForm.host} onChange={hzSet('host')} placeholder="https://horizon.example.com" /></label>
              <label>계정 <input className="input" value={hzForm.username} onChange={hzSet('username')} placeholder="administrator" /></label>
              <label>비밀번호 <input className="input" type="password" value={hzForm.password} onChange={hzSet('password')} placeholder={hzForm.id && (hz || []).some((s) => s.id === hzForm.id) ? '●●●●● (비우면 유지)' : ''} /></label>
              <label>AD 도메인 <input className="input" value={hzForm.domain} onChange={hzSet('domain')} placeholder="corp" /></label>
            </div>
            {hzMsg && <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12, background: hzMsg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: hzMsg.ok ? '#4ade80' : '#f87171' }}>{hzMsg.text}</div>}
            <div className="flex gap" style={{ marginTop: 10 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !hzForm.host} onClick={hzSave}>{busy ? '저장 중…' : '저장'}</button>
              <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy || (!hzForm.host && !hzForm.id)} onClick={hzTest}>연결 테스트</button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Horizon 8(2006+) REST API(<code>/rest/login → /rest/config/v1/licenses</code>)를 사용합니다. 읽기 전용 관리자 계정을 권장하며, 자격증명은 <code>$CONFIG_DIR/horizon.json</code>(0600)에만 저장됩니다.
            </div>
          </div>
        </details>
      )}
    </>
  );
}
