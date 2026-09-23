import React, { useEffect, useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { fetchJson, postJson, delJson, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import PduCharts from './PduCharts.jsx';
import BoldText from '../../components/boldText.jsx';
import { authStopInfo, authStopSummary } from './storageAuthText.js'; // v2.590: 인증 실패 정지 안내(도구 공통)
import { collectDropNote } from './collectDropText.js'; // v2.591: 결과 없이 폐기된 위임 '지금 수집' 요청

/**
 * 특수 기능 › PDU 정보 — APC Rack PDU 2G(rpdu2g) 전력·뱅크·온도·습도.
 *
 * 설계 메모:
 *  - **센서/PDU 수량을 사람이 입력하지 않는다.** 수집기가 장비에 물어 자동 탐지하므로
 *    화면도 '탐지된 만큼' 그린다(1대 1센서든 4대 데이지체인이든 같은 화면).
 *  - 값이 없으면 **'—'** 로 둔다. 0 으로 그리면 '측정값 0'과 구분이 사라진다.
 */

const EMPTY = { id: '', name: '', host: '', username: 'apc', password: '', sshPort: 22, datacenterId: '', agent: '', enabled: true, note: '' };

const fmtW = (w) => (w == null ? '—' : (w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`));
const fmtC = (c) => (c == null ? '—' : `${c.toFixed(1)} ℃`);
const fmtH = (h) => (h == null ? '—' : `${Math.round(h)} %RH`);
const fmtA = (a) => (a == null ? '—' : `${Number(a).toFixed(1)} A`);
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

export default function PduTool() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState(null);
  const [openId, setOpenId] = useState(null);   // 상세 펼침
  const [csvOpen, setCsvOpen] = useState(false);
  const [ivOpen, setIvOpen] = useState(false);
  const [thOpen, setThOpen] = useState(false);
  // 하위 탭을 URL 에 실어 새로고침·북마크·뒤로가기에서 유지한다(v2.438, hooks/useHashTab.js).
  const [tab, setTab] = useHashTab({ base: ['tools', 'pdu'], valid: ['list', 'charts'], fallback: 'list' });

  const load = async () => {
    try { setData(await fetchJson('/tools/pdu')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  // 수집이 도는 동안 화면이 멈춘 것처럼 보이지 않게 30초 폴링(기존 데이터는 유지).
  useEffect(() => { const t = setInterval(() => load().catch(() => {}), 30_000); return () => clearInterval(t); }, []);

  const devices = useMemo(() => data?.devices || [], [data]);
  const totals = useMemo(() => {
    let powerW = null, units = 0, sensors = 0, temps = [];
    for (const d of devices) {
      const s = d.snapshot;
      if (!s) continue;
      units += s.summary?.units || 0;
      sensors += s.summary?.sensors || 0;
      if (s.summary?.powerW != null) powerW = (powerW ?? 0) + s.summary.powerW;
      if (s.summary?.tempMaxC != null) temps.push(s.summary.tempMaxC);
    }
    return { powerW, units, sensors, tempMaxC: temps.length ? Math.max(...temps) : null };
  }, [devices]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setForm(structuredClone(EMPTY)); setTest(null); setMsg(null); };
  const openEdit = (d) => { setForm({ ...structuredClone(EMPTY), ...d, password: '' }); setTest(null); setMsg(null); };
  const close = () => { setForm(null); setTest(null); setMsg(null); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/pdu/devices', form);
      if (r.ok) { await load(); close(); } else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const runTest = async () => {
    setTesting(true); setTest(null); setMsg(null);
    try { setTest(await postJson('/tools/pdu/test', form)); }
    catch (e) { setTest({ ok: false, reason: e.message }); } finally { setTesting(false); }
  };
  const remove = async (d) => {
    if (!window.confirm(`'${d.name}' (${d.host}) PDU 를 삭제할까요?\n※ 수집된 시계열은 남습니다.`)) return;
    try { await delJson(`/tools/pdu/devices/${encodeURIComponent(d.id)}`); await load(); } catch (e) { setError(e.message); }
  };
  const collect = async (d) => {
    setBusy(true);
    try {
      const r = await postJson(`/tools/pdu/devices/${encodeURIComponent(d.id)}/collect`, {});
      setMsg({ ok: r.ok, text: r.reason || (r.ok ? '수집 완료' : '수집 실패') });
      await load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const collectAll = async () => {
    setBusy(true);
    try { const r = await postJson('/tools/pdu/collect-all', {}); setMsg({ ok: true, text: `수집 ${r.collected ?? 0} / 실패 ${r.failed ?? 0}${r.authStopped ? ` / 인증 실패 정지 ${r.authStopped}` : ''}` }); await load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>🔌 PDU 정보</b>
        <span className="muted" style={{ fontSize: 12 }}>
          PDU {devices.length}대 · 본체 {totals.units} · 센서 {totals.sensors}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={() => setIvOpen(true)}>⏱ 수집 주기</button>
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={() => setThOpen(true)}>🚨 임계치</button>
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={() => setCsvOpen(true)}>📄 CSV</button>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={busy} onClick={collectAll}>⚡ 전체 수집</button>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={openAdd}>+ PDU 추가</button>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
        APC Rack PDU 2G(rpdu2g) 에 SSH 로 접속해 <b>전력(kW·kWh·역률)</b>, <b>뱅크/상별 전류</b>,
        <b>온도·습도</b>를 수집합니다. <b>데이지체인된 PDU 대수와 센서 개수는 자동 탐지</b>하므로
        따로 입력하지 않습니다. 원격지 장비는 ‘수집 주체’를 엣지로 지정하면 그 엣지가 현지 수집 후 중앙으로 올립니다.
      </div>

      {/* 목록 / 추이 탭 */}
      <div className="vcd-views" style={{ marginBottom: 12 }}>
        {[['list', '📋 목록'], ['charts', '📈 추이']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }}
            onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {/* 요약 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 14 }}>
        <Card label="총 전력" value={fmtW(totals.powerW)} />
        <Card label="최고 온도" value={fmtC(totals.tempMaxC)} />
        <Card label="PDU 본체" value={`${totals.units}대`} />
        <Card label="환경 센서" value={`${totals.sensors}개`} />
      </div>

      {msg && <div className={msg.ok ? 'card' : 'card error-box'} style={{ padding: 10, marginBottom: 12, fontSize: 13 }}>{msg.text}</div>}
      {error && data && <div className="card error-box" style={{ padding: 10, marginBottom: 12, fontSize: 13 }}>폴링 오류: {error}</div>}

      {/* v2.590(감사 F2): 인증 실패로 **주기 수집을 멈춘** PDU — 조용히 멈추지 않는다(authGuard 규칙 1). */}
      {authStopSummary(devices.filter((d) => d.snapshot?.authStopped), { unit: '대', what: 'PDU' }) && (
        <div className="card" style={{ padding: 10, marginBottom: 12, fontSize: 13, borderColor: 'var(--red)' }}>
          <BoldText text={authStopSummary(devices.filter((d) => d.snapshot?.authStopped), { unit: '대', what: 'PDU' })} />
          <span className="muted"> 행의 수집 버튼은 정지와 무관하게 1회 시도하고, 성공하면 정지가 풀립니다.</span>
        </div>
      )}

      {/* v2.591: 엣지가 가져갔지만 결과가 오지 않아 폐기된 '지금 수집' 요청 — 배지만 조용히 꺼지지 않게 */}
      {(() => {
        const t = collectDropNote(data.collectDrops, (id) => devices.find((x) => x.id === id)?.name || id);
        return t ? (
          <div className="card" style={{ padding: 10, marginBottom: 12, fontSize: 13, borderColor: 'var(--amber)' }}>
            ⚠ <BoldText text={t} />
          </div>
        ) : null;
      })()}

      {tab === 'charts' && <PduCharts devices={devices} thresholds={data.thresholds || {}} />}

      {tab === 'list' && (devices.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>등록된 PDU 가 없습니다. ‘+ PDU 추가’ 또는 CSV 가져오기로 등록하세요.</div>
      ) : (
        <div className="table-wrap">
          {/* v2.447(감사 I5): v2.422 에서 표 181개를 STable 로 바꿀 때 이 표 하나가 raw table 로 남아
              헤더 클릭 정렬이 동작하지 않았다. 펼침 상세행은 React.Fragment 로 묶여 있어 sortChildren 이
              Fragment 단위로 옮기므로 상세행이 분리되지 않는다. */}
          <STable>
            <thead>
              <tr>
                <th>이름</th><th>주소</th><th>법인</th><th>수집 주체</th>
                <th className="right">전력</th><th className="right">온도</th><th className="right">습도</th>
                <th>본체/센서</th><th>수집</th><th className="right">작업</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const s = d.snapshot;
                const sum = s?.summary;
                return (
                  <React.Fragment key={d.id}>
                    <tr>
                      <td>
                        <b style={{ cursor: 'pointer' }} onClick={() => setOpenId(openId === d.id ? null : d.id)}>
                          {openId === d.id ? '▾ ' : '▸ '}{d.name}
                        </b>
                        {d.enabled === false && <span className="badge" style={{ marginLeft: 6 }}>중지</span>}
                        {s && !s.ok && (s.authStopped
                          ? <span className="badge red" style={{ marginLeft: 6, whiteSpace: 'nowrap' }} title={`${authStopInfo(s.authStopped, { what: '이 PDU' })?.detail || ''} — 펼치면 사유를 봅니다`}>인증 실패 정지</span>
                          : <span className="badge red" style={{ marginLeft: 6 }} title={s.error}>오류</span>)}
                        {(s?.violations || []).length > 0 && (
                          <span className="badge" style={{ marginLeft: 6, background: s.violations.some((v) => v.severity === 'critical') ? 'rgba(239,68,68,.2)' : 'rgba(245,158,11,.2)', color: s.violations.some((v) => v.severity === 'critical') ? '#ef4444' : '#f59e0b' }}
                            title={s.violations.map((v) => `${v.title} — ${v.detail}`).join('\n')}>
                            🚨 {s.violations.length}
                          </span>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{d.host}</td>
                      <td>{d.datacenterId || <span className="muted">—</span>}</td>
                      <td>{d.agent
                        ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{d.agent}</span>
                        : <span className="muted">중앙 직접</span>}</td>
                      <td className="right"><b>{fmtW(sum?.powerW)}</b></td>
                      <td className="right">{fmtC(sum?.tempMaxC)}</td>
                      <td className="right">{fmtH(sum?.humidityAvgPct)}</td>
                      <td>{sum ? `${sum.units} / ${sum.sensors}` : '—'}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{ago(s?.collectedAt)}</td>
                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                        <button className="logout-btn" style={{ padding: '4px 8px', fontSize: 12 }} disabled={busy} onClick={() => collect(d)}>수집</button>
                        <button className="logout-btn" style={{ padding: '4px 8px', fontSize: 12, marginLeft: 4 }} onClick={() => openEdit(d)}>수정</button>
                        <button className="logout-btn" style={{ padding: '4px 8px', fontSize: 12, marginLeft: 4, color: 'var(--red)' }} onClick={() => remove(d)}>삭제</button>
                      </td>
                    </tr>
                    {openId === d.id && s && (
                      <tr><td colSpan={10} style={{ background: 'rgba(255,255,255,.02)' }}><Detail snap={s} /></td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </STable>
        </div>
      ))}

      {form && <DeviceModal {...{ form, setF, setForm, close, save, runTest, busy, testing, test, msg, data }} />}
      {csvOpen && <CsvModal onClose={() => { setCsvOpen(false); load(); }} />}
      {ivOpen && <IntervalModal data={data} onClose={() => { setIvOpen(false); load(); }} />}
      {thOpen && <ThresholdModal data={data} onClose={() => { setThOpen(false); load(); }} />}
    </>
  );
}

function Card({ label, value }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

/** 자동 탐지된 본체/뱅크/상/센서를 있는 만큼 그린다. */
function Detail({ snap }) {
  return (
    <div style={{ padding: '10px 6px', fontSize: 12.5 }}>
      <div className="muted" style={{ marginBottom: 8 }}>
        {snap.model && <>모델 <b>{snap.model}</b> · </>}
        {snap.serial && <>S/N {snap.serial} · </>}
        {snap.aosVersion && <>AOS {snap.aosVersion} · </>}
        {snap.appVersion && <>APP {snap.appVersion} · </>}
        수집 {snap.agent ? `엣지(${snap.agent})` : '중앙 직접'}
      </div>
      {(snap.violations || []).length > 0 && (
        <div className="card error-box" style={{ padding: 10, marginBottom: 8, textAlign: 'left' }}>
          <b>🚨 임계치 위반 {snap.violations.length}건</b>
          {snap.violations.map((v) => (
            <div key={v.key} style={{ marginTop: 4 }}>
              {v.severity === 'critical' ? '🔴' : '🟠'} {v.title} — {v.detail}
            </div>
          ))}
        </div>
      )}
      {(snap.notes || []).map((n, i) => <div key={i} className="muted" style={{ marginBottom: 4 }}>ⓘ {n}</div>)}
      {snap.authStopped && (
        <div className="card" style={{ padding: 8, marginBottom: 8, borderColor: 'var(--red)', fontSize: 13 }}>
          <BoldText text={authStopInfo(snap.authStopped, { what: '이 PDU', manual: '수집' })?.text || ''} />
        </div>
      )}
      {snap.error && <div className="error-box" style={{ padding: 8, marginBottom: 8 }}>{snap.error}</div>}

      {(snap.units || []).map((u) => (
        <div key={u.index} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <b>PDU 본체 #{u.index}</b>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 6 }}>
            <span>전력 <b>{fmtW(u.powerW)}</b></span>
            <span>누적 <b>{u.energyKwh == null ? '—' : `${u.energyKwh} kWh`}</b></span>
            <span>피상 <b>{u.appPowerW == null ? '—' : `${(u.appPowerW / 1000).toFixed(2)} kVA`}</b></span>
            <span>역률 <b>{u.pf == null ? '—' : u.pf}</b></span>
          </div>
          {(u.banks || []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span className="muted">뱅크별 전류: </span>
              {u.banks.map((b) => <span key={b.index} className="badge" style={{ marginRight: 6 }}>뱅크{b.index} {fmtA(b.currentA)}</span>)}
            </div>
          )}
          {(u.phases || []).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span className="muted">상(phase): </span>
              {u.phases.map((p) => <span key={p.index} className="badge" style={{ marginRight: 6 }}>L{p.index} {fmtA(p.currentA)}{p.voltageV != null ? ` / ${p.voltageV}V` : ''}</span>)}
            </div>
          )}
        </div>
      ))}

      {(snap.sensors || []).length > 0 ? (
        <div className="card" style={{ padding: 10 }}>
          <b>환경 센서 {snap.sensors.length}개</b>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
            {snap.sensors.map((s) => (
              <span key={s.index} className="badge blue">
                #{s.index}{s.name ? ` ${s.name}` : ''} · {fmtC(s.tempC)} · {fmtH(s.humidityPct)}
              </span>
            ))}
          </div>
        </div>
      ) : <div className="muted">환경 센서가 탐지되지 않았습니다(AP9335T/TH 미장착).</div>}
    </div>
  );
}

function DeviceModal({ form, setF, setForm, close, save, runTest, busy, testing, test, msg, data }) {
  return (
    <>
      <EscClose onClose={close} />
      <div className="card" style={{ marginTop: 16, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <b style={{ fontSize: 14 }}>{form.id ? `PDU 수정 — ${form.name}` : 'PDU 추가'}</b>
          <button className="logout-btn" style={{ padding: '5px 10px', marginLeft: 'auto' }} onClick={close}>닫기</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          <F label="표시명 *"><input className="input" value={form.name} onChange={setF('name')} placeholder="9B01_PDU_01" /></F>
          <F label="host (IP/호스트명) *"><input className="input" value={form.host} onChange={setF('host')} placeholder="10.94.10.11" /></F>
          <F label="SSH 포트"><input className="input" type="number" value={form.sshPort} onChange={setF('sshPort')} /></F>
          <F label="계정 *"><input className="input" value={form.username} onChange={setF('username')} autoComplete="off" /></F>
          <F label={form.id ? '비밀번호 (비우면 유지)' : '비밀번호 *'}>
            <input className="input" type="password" value={form.password} onChange={setF('password')} autoComplete="new-password" />
          </F>
          <F label="법인(DataCenter)">
            <select className="input" value={form.datacenterId} onChange={setF('datacenterId')}>
              <option value="">(지정 안 함)</option>
              {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
            </select>
          </F>
          <F label="수집 주체">
            <select className="input" value={form.agent} onChange={setF('agent')}>
              <option value="">중앙 직접 수집</option>
              {(data.agents || []).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </F>
          <F label="수집 여부">
            <select className="input" value={form.enabled ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.value === '1' }))}>
              <option value="1">수집</option><option value="0">중지</option>
            </select>
          </F>
          <F label="메모"><input className="input" value={form.note} onChange={setF('note')} /></F>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: '12px 0 4px' }}>
          연결 테스트를 누르면 <b>데이지체인 PDU 대수와 센서 개수를 자동 탐지</b>해 보여줍니다.
          엣지 위임 장비도 이 테스트는 <b>중앙에서</b> 실행되므로, 중앙이 그 PDU 에 못 닿으면 실패할 수 있습니다(수집 자체는 엣지가 합니다).
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 20px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
          <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={testing} onClick={runTest}>{testing ? '테스트 중…' : '🔌 연결 테스트'}</button>
        </div>
        {msg && <div className="card error-box" style={{ marginTop: 12, padding: 10, fontSize: 13 }}>{msg.text}</div>}
        {test && <TestResult r={test} />}
      </div>
    </>
  );
}

function TestResult({ r }) {
  if (!r.ok) {
    return (
      <div className="card error-box" style={{ marginTop: 12, padding: 12, fontSize: 13 }}>
        <b>❌ 연결 실패</b> {r.ms != null && <span className="muted">({r.ms}ms)</span>}
        <div style={{ marginTop: 6 }}>{r.reason}</div>
      </div>
    );
  }
  const d = r.detected || {};
  return (
    <div className="card" style={{ marginTop: 12, padding: 12, fontSize: 13, borderColor: 'var(--green)' }}>
      <div><b style={{ color: 'var(--green)' }}>✅ 연결 성공</b> — 자동 탐지 결과 ({r.ms}ms)</div>
      <div className="muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
        {r.model && <>모델 <b>{r.model}</b> · </>}{r.serial && <>S/N {r.serial} · </>}
        {r.aosVersion && <>AOS {r.aosVersion} · </>}{r.appVersion && <>APP {r.appVersion}</>}
      </div>
      <div style={{ marginTop: 8 }}>
        <b>PDU 본체 {r.units}대</b>
        {(d.units || []).map((u) => (
          <span key={u.index} className="badge" style={{ marginLeft: 6 }}>#{u.index} {fmtW(u.powerW)} · 뱅크 {u.banks} · 상 {u.phases}</span>
        ))}
      </div>
      <div style={{ marginTop: 6 }}>
        <b>환경 센서 {r.sensors}개</b>
        {(d.sensors || []).map((s) => (
          <span key={s.index} className="badge blue" style={{ marginLeft: 6 }}>#{s.index}{s.name ? ` ${s.name}` : ''} {fmtC(s.tempC)} {fmtH(s.humidityPct)}</span>
        ))}
        {r.sensors === 0 && <span className="muted" style={{ marginLeft: 6 }}>— 센서 미장착(온도·습도 수집 없음)</span>}
      </div>
      {(r.notes || []).map((n, i) => <div key={i} className="muted" style={{ marginTop: 6 }}>ⓘ {n}</div>)}
    </div>
  );
}

function CsvModal({ onClose }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const doImport = async () => {
    setBusy(true); setResult(null);
    try { setResult(await postJson('/tools/pdu/csv/import', { csv })); }
    catch (e) { setResult({ ok: false, failed: [e.message] }); } finally { setBusy(false); }
  };
  return (
    <>
      <EscClose onClose={onClose} />
      <div className="card" style={{ marginTop: 16, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>PDU CSV 가져오기 / 내보내기</b>
          <button className="logout-btn" style={{ padding: '5px 10px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.6 }}>
          열: <code>name, host, username, sshPort, datacenter, agent, enabled, note, password</code><br />
          같은 <b>host</b> 가 이미 있으면 <b>수정</b>, 없으면 추가됩니다(내보내기 → 편집 → 가져오기 왕복 안전).
          <b>비밀번호는 내보내지 않습니다</b>(가져오기에서 비워 두면 기존 값 유지).
          센서/PDU 수량 열이 없는 것은 의도입니다 — 자동 탐지합니다.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => downloadFile('/tools/pdu/csv/export', 'pdu-devices.csv')}>⬇ 현재 목록 내보내기</button>
          <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => downloadFile('/tools/pdu/csv/sample', 'pdu-devices-sample.csv')}>⬇ 샘플 받기</button>
        </div>
        <textarea className="input" style={{ width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12 }}
          value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="여기에 CSV 를 붙여넣으세요" />
        <div style={{ marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !csv.trim()} onClick={doImport}>
            {busy ? '가져오는 중…' : '가져오기'}
          </button>
        </div>
        {result && (
          <div className="card" style={{ marginTop: 12, padding: 10, fontSize: 13 }}>
            추가 <b>{result.added ?? 0}</b> · 수정 <b>{result.updated ?? 0}</b>
            {(result.failed || []).length > 0 && (
              <div className="error-box" style={{ padding: 8, marginTop: 8, textAlign: 'left' }}>
                실패 {result.failed.length}건<br />
                {result.failed.slice(0, 20).map((f, i) => <div key={i}>{f}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function IntervalModal({ data, onClose }) {
  const spec = data.intervalSpec || [];
  const [vals, setVals] = useState(() => Object.fromEntries(spec.map((s) => [s.key, Math.round((data.intervals?.[s.key] || s.def) / 1000)])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v === '' ? '' : Number(v) * 1000]));
      const r = await postJson('/tools/pdu/intervals', body);
      setMsg({ ok: true, text: '저장했습니다. 엣지는 다음 설정 수신 때 반영됩니다.' });
      if (r.ok) setTimeout(onClose, 900);
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <>
      <EscClose onClose={onClose} />
      <div className="card" style={{ marginTop: 16, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>⏱ PDU 수집 주기</b>
          <button className="logout-btn" style={{ padding: '5px 10px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
          여기서 지정한 값이 <b>엣지로 배포</b>됩니다(엣지는 설정 수신 주기마다 받아 즉시 반영).
          비워 두면 ‘미지정’이 되어 각 엣지의 현장 설정(portal.env)이 유지됩니다.
        </div>
        {spec.map((s) => (
          <div key={s.key} style={{ marginBottom: 12 }}>
            <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              {s.label} (초, 최소 {Math.round(s.min / 1000)})
            </label>
            <input className="input" type="number" min={Math.round(s.min / 1000)} value={vals[s.key]}
              onChange={(e) => setVals((v) => ({ ...v, [s.key]: e.target.value }))} style={{ width: 200 }} />
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{s.hint}</div>
          </div>
        ))}
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg && <div className={msg.ok ? 'card' : 'card error-box'} style={{ marginTop: 10, padding: 10, fontSize: 13 }}>{msg.text}</div>}
      </div>
    </>
  );
}

function ThresholdModal({ data, onClose }) {
  const spec = data.thresholdSpec || [];
  const cur = data.thresholds || {};
  const [vals, setVals] = useState(() => Object.fromEntries(spec.map((s) => [s.key, cur[s.key] ?? ''])));
  const [enabled, setEnabled] = useState(cur.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await postJson('/tools/pdu/thresholds', { enabled, ...vals });
      setMsg({ ok: true, text: '저장했습니다. 다음 수집 주기부터 적용됩니다.' });
      setTimeout(onClose, 900);
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <>
      <EscClose onClose={onClose} />
      <div className="card" style={{ marginTop: 16, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>🚨 PDU 임계치 · 알림</b>
          <button className="logout-btn" style={{ padding: '5px 10px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
          임계치를 넘으면 <b>설정 › 알림</b>에 등록된 채널(Slack/Teams/웹훅)로 보냅니다.
          <b>상태가 바뀔 때만</b> 알리고(정상→경고→위험), 해소되면 복구 1통을 보냅니다.
          재알림 간격은 알림 설정의 쿨다운을 따릅니다. <b>비워 두면 그 항목은 감시하지 않습니다.</b>
          측정값이 없으면(센서 미장착·첫 수집) 판정하지 않습니다.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          임계치 감시 사용
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12 }}>
          {spec.map((s) => (
            <div key={s.key}>
              <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{s.label}</label>
              <input className="input" type="number" step="0.1" value={vals[s.key] ?? ''} placeholder="비우면 감시 안 함"
                onChange={(e) => setVals((v) => ({ ...v, [s.key]: e.target.value }))} />
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{s.hint}</div>
            </div>
          ))}
        </div>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px', marginTop: 14 }} disabled={busy} onClick={save}>
          {busy ? '저장 중…' : '저장'}
        </button>
        {msg && <div className={msg.ok ? 'card' : 'card error-box'} style={{ marginTop: 10, padding: 10, fontSize: 13 }}>{msg.text}</div>}
      </div>
    </>
  );
}

function F({ label, children }) {
  return (
    <div>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
