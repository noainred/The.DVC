import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Kpi, UsageCell, Modal, SearchBox } from '../../components/ui.jsx';
import { stateLabel, stateTone, opticalHealth, errorLevel, capacityLevel, aggregate,
  throughputText, filterPorts, RX_WARN_DBM, RX_BAD_DBM } from './sanSwitchPorts.js';

/**
 * 특수기능 › SAN 스위치 모니터링(v2.410 — 사용자 요구 'Brocade SAN switch 포트 모니터링 및
 * 용량 모니터링').
 *
 * '용량'의 뜻: SAN 스위치에는 저장 용량이 없다. 여기서 용량은 **포트 용량**이다 —
 * 라이선스(POD)로 쓸 수 있는 포트가 몇 개인지, 그중 몇 개가 실제로 물려 있는지, 몇 개가
 * 남았는지. 이 값이 신규 서버·어레이를 더 붙일 수 있는지를 결정한다.
 * ⚠ 라이선스 없는 포트(No_License)는 **여유에서 뺀다** — 살 수 없는 포트를 여유로 세면
 *   증설 판단이 틀린다(판정 규칙은 sanSwitchPorts.js·types.js summarizePorts 에 고정).
 *
 * 데이터 흐름은 스토리지 모니터링과 같다: 중앙 등록 → 엣지가 pull → 현지 수집 → 중앙 push.
 * 조회는 전체 범위 계정 전용(서버 403), 등록/수정/삭제/테스트는 admin.
 */

const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
};
const TONE = { ok: 'var(--green, #22c55e)', warn: 'var(--amber, #f59e0b)', bad: 'var(--red, #ef4444)', muted: 'var(--muted, #94a3b8)' };

/** 수집 실패 사유 한 줄 — 부분 실패(섹션만 오류)여도 사유가 반드시 드러나게. */
function failReason(s) {
  if (!s) return '수집 기록 없음';
  return s.error
    || Object.entries(s.sections || {}).filter(([, v]) => v && v !== 'ok' && v !== 'skip').map(([k, v]) => `${k}: ${v}`).join(' · ')
    || '알 수 없는 오류';
}

const EMPTY_FORM = { type: 'brocade', name: '', host: '', username: 'admin', password: '',
  collectMethod: 'ssh', sshPort: 22, agent: '', datacenterId: '', vfId: '', note: '', enabled: true };

export default function SanSwitchTool() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지 — CLAUDE.md).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [dcSel, setDcSel] = useState(() => new Set());
  const [form, setForm] = useState(null);          // null = 폼 닫힘
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  const [detail, setDetail] = useState(null);      // 포트 상세 모달 { device, ports, ... }
  const [portFilter, setPortFilter] = useState('all');
  const [portQ, setPortQ] = useState('');

  const load = async () => {
    try { setData(await fetchJson('/tools/sanswitch')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const dcName = useMemo(() => {
    const m = new Map((data?.datacenters || []).map((d) => [d.id, d.name || d.id]));
    return (id) => m.get(id) || id || '(법인 미지정)';
  }, [data]);

  const rows = data?.devices || [];
  const searched = rows.filter((r) => {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return [r.name, r.host, r.agent, dcName(r.datacenterId), r.snap?.model, r.snap?.fabricOs]
      .some((v) => String(v || '').toLowerCase().includes(s));
  });
  const shown = searched.filter((r) => dcSel.size === 0 || dcSel.has(dcName(r.datacenterId)));
  const dcChips = [...new Set(searched.map((r) => dcName(r.datacenterId)))].sort((a, b) => a.localeCompare(b));
  const agg = aggregate(shown);

  if (error && !data) return <ErrorBox message={error} />;   // 데이터 보유 중 폴링 오류로 화면을 갈아치우지 않음
  if (!data) return <Loading />;

  const openForm = (r) => setForm(r
    ? { ...EMPTY_FORM, ...r, password: '', vfId: r.vfId ?? '' }
    : { ...EMPTY_FORM, agent: '', datacenterId: data.datacenters?.[0]?.id || '' });

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await postJson('/tools/sanswitch/devices', form); setForm(null); await load(); setMsg('저장되었습니다.'); }
    catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const remove = async (r) => {
    if (!window.confirm(`'${r.name}' 스위치 등록을 삭제할까요? 수집된 스냅샷도 함께 지워집니다.`)) return;
    setBusy(true);
    try { await delJson(`/tools/sanswitch/devices/${r.id}`); await load(); setMsg('삭제되었습니다.'); }
    catch (e) { setMsg(`삭제 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const runTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await postJson('/tools/sanswitch/test', form)); }
    catch (e) { setTest({ ok: false, reason: e.message }); }
    finally { setBusy(false); }
  };
  const collectNow = async (r) => {
    setBusy(true); setMsg(null);
    try { const res = await postJson(`/tools/sanswitch/devices/${r.id}/collect`, {}); setMsg(res.reason || '수집했습니다.'); await load(); }
    catch (e) { setMsg(`수집 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const openDetail = async (r) => {
    setDetail({ loading: true, device: r }); setPortFilter('all'); setPortQ('');
    try { setDetail({ device: r, ...(await fetchJson(`/tools/sanswitch/devices/${r.id}/ports`)) }); }
    catch (e) { setDetail({ device: r, error: e.message }); }
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🔗 SAN 스위치 모니터링</div>

      {/* 상단 KPI — '용량'은 포트 용량이다. 라이선스 없는 포트는 여유에서 빠진다. */}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="스위치" value={agg.switches} meta={agg.failed ? `수집 실패 ${agg.failed}대` : '전부 수집 정상'} accent={agg.failed ? 'var(--red)' : undefined} />
        <Kpi label="물리 포트" value={agg.total.toLocaleString()} meta={`라이선스 ${agg.licensed.toLocaleString()}`} />
        <Kpi label="사용 중" value={agg.online.toLocaleString()} pct={agg.usedPct} meta={`포트 사용률 ${agg.usedPct}%`} />
        <Kpi label="여유 포트" value={agg.free.toLocaleString()} meta="라이선스 − 사용중(증설 가능분)" accent={capacityLevel(agg.usedPct) === 'bad' ? 'var(--red)' : capacityLevel(agg.usedPct) === 'warn' ? 'var(--amber)' : undefined} />
        <Kpi label="장애/비활성 포트" value={`${agg.faulty} / ${agg.disabled}`} meta={agg.alerts ? `헬스 경보 ${agg.alerts}` : '헬스 경보 없음'} accent={agg.faulty ? 'var(--red)' : undefined} />
      </div>

      {/* 법인 필터 + 검색 + 등록 */}
      <div className="vc-quicknav" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8 }}>
          <span className="qn-label" style={{ minWidth: 60 }}>🏢 법인</span>
          {dcChips.map((dc) => {
            const on = dcSel.has(dc);
            const list = searched.filter((r) => dcName(r.datacenterId) === dc);
            const a = aggregate(list);
            return (
              <button key={dc} className={`qn-btn${on ? ' on' : ''}${a.failed ? ' down' : ''}`} aria-pressed={on}
                onClick={() => setDcSel((p) => { const n = new Set(p); n.has(dc) ? n.delete(dc) : n.add(dc); return n; })}
                title={`${dc} — 스위치 ${a.switches}대 · 포트 ${a.online}/${a.licensed} (${a.usedPct}%) · 여유 ${a.free}`}>
                {dc}<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{list.length}</span>
              </button>
            );
          })}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 180 }}
            value={q} onChange={setQ} placeholder="스위치·host·모델·엣지 찾기" />
          <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} onClick={() => openForm(null)}>+ 스위치 등록</button>
        </div>
      </div>

      {msg && <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px 2px' }}>{msg}</div>}

      {/* 스위치 목록 */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>스위치</th><th>법인</th><th>모델</th><th>FOS</th><th>Domain</th><th>상태</th>
              <th title="사용중 / 라이선스 포트. 라이선스 없는 포트(No_License)는 분모에서 뺍니다.">포트 사용</th>
              <th style={{ minWidth: 130 }}>포트 사용률</th>
              <th title="라이선스 − 사용중. 지금 새로 물릴 수 있는 포트 수입니다.">여유</th>
              <th>장애/비활성</th><th>수집</th><th>수집 시각</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const s = r.snap;
              const p = s?.ports || {};
              const lvl = capacityLevel(p.usedPct);
              return (
                <tr key={r.id}>
                  <td>
                    <button className="tab" style={{ padding: '2px 8px', fontWeight: 600 }} onClick={() => openDetail(r)} title="클릭하면 포트 상세를 봅니다">{r.name}</button>
                    <div className="muted" style={{ fontSize: 11 }}>{r.host}{r.vfId ? ` · VF ${r.vfId}` : ''}</div>
                  </td>
                  <td>{dcName(r.datacenterId)}</td>
                  <td>{s?.model || <span className="muted">—</span>}</td>
                  <td>{s?.fabricOs || <span className="muted">—</span>}</td>
                  <td>{s?.domainId ?? <span className="muted">—</span>}</td>
                  <td>
                    {s?.ok
                      ? <span style={{ color: s.switchState === 'Online' ? TONE.ok : TONE.warn }}>{s.switchState || 'OK'}</span>
                      : <span className="badge" style={{ background: TONE.bad, color: '#fff' }} title={failReason(s)}>실패 ⓘ</span>}
                  </td>
                  <td>{s?.ok ? <>{p.online}<span className="muted"> / {p.licensed}</span>{p.noLicense ? <span className="muted" style={{ fontSize: 11 }}> (미라이선스 {p.noLicense})</span> : null}</> : <span className="muted">—</span>}</td>
                  <td>{s?.ok ? <span title={`${p.usedPct}% 사용 · ${lvl === 'bad' ? '증설 검토 필요' : lvl === 'warn' ? '여유 부족' : '여유 있음'}`}><UsageCell pct={p.usedPct || 0} /></span> : <span className="muted">—</span>}</td>
                  <td style={{ color: lvl === 'bad' ? TONE.bad : lvl === 'warn' ? TONE.warn : undefined, fontWeight: 600 }}>{s?.ok ? p.free : '—'}</td>
                  <td>{s?.ok ? <span style={{ color: (p.faulty || p.disabled) ? TONE.warn : undefined }}>{p.faulty} / {p.disabled}</span> : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{r.agent ? `엣지 ${r.agent}` : '중앙 직접'}<div>{r.collectMethod === 'rest' ? 'REST' : 'SSH'}</div></td>
                  <td className="muted" style={{ fontSize: 11 }}>{ago(s?.collectedAt)}{r.pending ? <div style={{ color: TONE.warn }}>재수집 대기</div> : null}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="tab" style={{ padding: '2px 8px' }} disabled={busy} onClick={() => collectNow(r)}>수집</button>{' '}
                    <button className="tab" style={{ padding: '2px 8px' }} onClick={() => openForm(r)}>수정</button>{' '}
                    <button className="tab" style={{ padding: '2px 8px' }} disabled={busy} onClick={() => remove(r)}>삭제</button>
                  </td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 24 }}>
              등록된 SAN 스위치가 없습니다. 오른쪽 위 '+ 스위치 등록'으로 추가하세요.
            </td></tr>}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        수집 주기 {Math.round((data.poller?.intervalMs || 0) / 60000)}분(동시 {data.poller?.concurrency}대) ·
        마지막 수집 {ago(data.poller?.at)} · 성공 {data.poller?.collected ?? 0} / 실패 {data.poller?.failed ?? 0}
        {data.poller?.busy ? ' · 수집 진행중' : ''}
      </div>

      {form && <DeviceForm {...{ form, setForm, data, save, busy, runTest, test, setTest }} />}
      {detail && <PortDetail {...{ detail, setDetail, portFilter, setPortFilter, portQ, setPortQ }} />}
    </>
  );
}

/** 등록/수정 폼 — 수집 방식 목록은 서버 카탈로그(types.js)를 그대로 그린다. */
function DeviceForm({ form, setForm, data, save, busy, runTest, test, setTest }) {
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const type = data.types.find((t) => t.type === form.type) || data.types[0];
  return (
    <Modal title={form.id ? 'SAN 스위치 수정' : 'SAN 스위치 등록'} onClose={() => { setForm(null); setTest(null); }} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <label style={{ fontSize: 12 }}>표시명<input className="input" value={form.name} onChange={set('name')} placeholder="예: SAN-A-01" /></label>
        <label style={{ fontSize: 12 }}>host (IP/호스트명)<input className="input" value={form.host} onChange={set('host')} placeholder="10.10.10.11" /></label>
        <label style={{ fontSize: 12 }}>타입
          <select className="input" value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value, collectMethod: (data.types.find((t) => t.type === e.target.value)?.methods || [])[0]?.value || 'ssh' }))}>
            {data.types.map((t) => <option key={t.type} value={t.type} disabled={!t.implemented}>{t.label}{t.implemented ? '' : ' (예정)'}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>수집 방식
          <select className="input" value={form.collectMethod} onChange={set('collectMethod')}
            title={(type?.methods || []).find((m) => m.value === form.collectMethod)?.hint || ''}>
            {(type?.methods || []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>계정<input className="input" value={form.username} onChange={set('username')} autoComplete="off" /></label>
        <label style={{ fontSize: 12 }}>비밀번호
          <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password"
            placeholder={form.hasPassword ? '(변경할 때만 입력)' : ''} />
        </label>
        <label style={{ fontSize: 12 }}>SSH 포트<input className="input" type="number" value={form.sshPort} onChange={set('sshPort')} /></label>
        <label style={{ fontSize: 12 }}>법인(DataCenter)
          <select className="input" value={form.datacenterId} onChange={set('datacenterId')}>
            <option value="">(미지정)</option>
            {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>수집 주체
          <select className="input" value={form.agent} onChange={set('agent')}
            title="중앙에서 스위치에 직접 닿지 않으면 그 법인의 엣지를 지정하세요. 엣지가 현지에서 수집해 중앙으로 올립니다.">
            <option value="">중앙이 직접 수집</option>
            {(data.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }} title="Virtual Fabrics 를 쓰는 장비에서 특정 논리 스위치만 볼 때 지정합니다. 비워두면 기본 컨텍스트만 수집합니다.">
          VF ID (선택)<input className="input" type="number" value={form.vfId} onChange={set('vfId')} placeholder="예: 128" />
        </label>
        <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>메모<input className="input" value={form.note} onChange={set('note')} /></label>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        {(type?.methods || []).find((m) => m.value === form.collectMethod)?.hint}
      </div>
      <div className="flex gap" style={{ marginTop: 12 }}>
        <button className="tab" disabled={busy} onClick={runTest}>연결 테스트</button>
        <button className="login-btn" style={{ flex: 'none', padding: '6px 18px' }} disabled={busy} onClick={save}>저장</button>
      </div>
      {test && <TestResult test={test} />}
    </Modal>
  );
}

/** 연결 테스트 결과 — 실패해도 원인을 감추지 않고, SSH 는 CLI 원문을 접어서 보여준다. */
function TestResult({ test }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ color: test.ok ? TONE.ok : TONE.bad, fontWeight: 600 }}>
        {test.ok ? '연결 성공' : '연결 실패'} <span className="muted" style={{ fontWeight: 400 }}>({test.ms}ms)</span>
      </div>
      {!test.ok && <div style={{ marginTop: 6 }}>{test.reason}</div>}
      {test.ok && test.snap && (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.7 }}>
          이름 <b>{test.snap.name}</b> · 모델 <b>{test.snap.model || '—'}</b> · FOS <b>{test.snap.fabricOs || '—'}</b>
          {' · '}Domain {test.snap.domainId ?? '—'} · 시리얼 {test.snap.serial || '—'}
          <div>포트 {test.snap.ports.online} / {test.snap.ports.licensed} 사용({test.snap.ports.usedPct}%) · 여유 {test.snap.ports.free} · 전체 {test.snap.ports.total}</div>
          {Object.entries(test.snap.sections || {}).filter(([, v]) => v !== 'ok').length > 0 && (
            <div className="muted" style={{ marginTop: 4 }}>
              일부 항목 미수집: {Object.entries(test.snap.sections).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}(${v})`).join(', ')}
            </div>
          )}
        </div>
      )}
      {!!(test.cliRaw || []).length && (
        <>
          <button className="tab" style={{ marginTop: 8, padding: '2px 8px' }} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} CLI 명령 원문 ({test.cliRaw.length}개)
          </button>
          {open && (
            <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 6 }}>
              {test.cliRaw.map((r, i) => (
                <details key={i} open={!r.ok}>
                  <summary style={{ cursor: 'pointer', color: r.ok ? undefined : TONE.warn }}>{r.cmd}</summary>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{r.sample}</pre>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 포트 상세 — 이 화면이 '포트 모니터링'의 본체다. */
function PortDetail({ detail, setDetail, portFilter, setPortFilter, portQ, setPortQ }) {
  const d = detail;
  const list = d.ports?.list || [];
  const unit = d.extra?.rateUnit || 'fps';
  const filtered = filterPorts(list, portFilter).filter((p) => {
    if (!portQ.trim()) return true;
    const s = portQ.trim().toLowerCase();
    return [p.slotPort, p.portType, p.attachedName, (p.attached || []).join(' '), p.sfpVendor, p.sfpSerial]
      .some((v) => String(v || '').toLowerCase().includes(s));
  });
  return (
    <Modal title={`포트 상세 — ${d.device?.name || ''}`} onClose={() => setDetail(null)} width={1180}>
      {d.loading && <Loading />}
      {d.error && <ErrorBox message={d.error} />}
      {!d.loading && !d.error && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {d.model || '모델 미상'} · FOS {d.fabricOs || '—'} · {d.source} · 수집 {ago(d.collectedAt)}
            {d.ports?.portsOmitted ? (
              <div style={{ color: TONE.warn, marginTop: 4 }}>
                ⚠ 이 스위치는 엣지가 수집합니다. 회선 부담 때문에 중앙에는 <b>문제 포트만</b> 올라옵니다 —
                정상 포트 {d.ports.portsOmitted}개는 여기 표에 없습니다(요약 수치는 전체 기준으로 정확합니다).
              </div>
            ) : null}
            {d.extra?.rateReady === false && (
              <div style={{ marginTop: 4 }}>처리량은 두 번째 수집부터 표시됩니다(누적 카운터의 차이로 계산 — 첫 수집은 비교 대상이 없습니다).</div>
            )}
          </div>

          <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            {[['all', '전체'], ['online', '사용중'], ['free', '비어있음'], ['problem', '문제만']].map(([k, label]) => (
              <button key={k} className={portFilter === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
                onClick={() => setPortFilter(k)}>{label}</button>
            ))}
            <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 240 }} value={portQ} onChange={setPortQ}
              placeholder="포트·연결 장비·SFP 찾기" />
            <span className="muted" style={{ fontSize: 12 }}>{filtered.length} / {list.length}</span>
          </div>

          <div className="table-wrap" style={{ maxHeight: '58vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>포트</th><th>상태</th><th>속도</th><th>타입</th><th>연결 장비</th>
                  <th title="누적 에러 카운터입니다 — 마지막 초기화 이후의 합계이며, 값이 크다고 지금 장애라는 뜻은 아닙니다.">CRC / LinkFail / LossSync ⓘ</th>
                  <th title={`SFP 수신·송신 광레벨. 일반 권장 하한 ${RX_WARN_DBM} dBm, 위험 ${RX_BAD_DBM} dBm — 정확한 임계는 SFP 모델·거리에 따라 다릅니다.`}>광레벨 Rx/Tx (dBm) ⓘ</th>
                  <th>SFP 온도</th><th>처리량 (In/Out)</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const el = errorLevel(p);
                  const oh = opticalHealth(p.rxPowerDbm, p.txPowerDbm);
                  return (
                    <tr key={p.index}>
                      <td><b>{p.slotPort}</b><div className="muted" style={{ fontSize: 10.5 }}>idx {p.index}{p.address ? ` · ${p.address}` : ''}</div></td>
                      <td><span style={{ color: TONE[stateTone(p.state)] }} title={p.stateRaw || ''}>{stateLabel(p.state)}</span></td>
                      <td>{p.speed || <span className="muted">—</span>}</td>
                      <td>{p.portType || <span className="muted">—</span>}</td>
                      <td style={{ maxWidth: 240 }}>
                        {p.attachedName ? <div>{p.attachedName}</div> : null}
                        <span className="muted" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{(p.attached || []).join(', ') || '—'}</span>
                      </td>
                      <td style={{ color: TONE[el.level === 'ok' ? 'muted' : el.level] }}>
                        {p.errCrc ?? '—'} / {p.errLinkFail ?? '—'} / {p.errLossSync ?? '—'}
                      </td>
                      <td style={{ color: oh.level === 'none' ? TONE.muted : TONE[oh.level] }} title={oh.why}>
                        {p.rxPowerDbm ?? '—'} / {p.txPowerDbm ?? '—'}{oh.level === 'bad' || oh.level === 'warn' ? ' ⚠' : ''}
                      </td>
                      <td className="muted">{p.sfpTempC != null ? `${p.sfpTempC}℃` : '—'}</td>
                      <td>{throughputText(p, unit)}</td>
                    </tr>
                  );
                })}
                {!filtered.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>조건에 맞는 포트가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>

          {Object.entries(d.sections || {}).filter(([, v]) => v && v !== 'ok').length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              미수집 항목: {Object.entries(d.sections).filter(([, v]) => v && v !== 'ok').map(([k, v]) => `${k}(${v})`).join(', ')}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
