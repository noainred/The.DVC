import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { RETENTION_PRESETS, bytesText, retentionEstimate } from './tools/sanSwitchPerfText.js';
import { edgePerfLine, perfCollectSummary } from './tools/sanPerfDiagText.js';
import { STable } from '../components/STable.jsx';
// v2.599 LO2599-01: 빈 칸은 보내지 않는다(Number('')=0 → 서버가 기본값으로 저장하던 것 — 보존 3650→90일).
import { blankOr } from './blankOr.js';

/**
 * 설정 › 수집 서버 › SAN 스위치 포트 사용량 수집(v2.411, 사용자 요구
 * '설정에서 주기적으로 portperfshow 를 수행해서 포트 사용량 수집하는 DB').
 *
 * 기본은 **꺼짐**이다 — 운영 중인 SAN 스위치에 주기적으로 SSH 세션을 붙이는 동작이라,
 * 관리자가 명시적으로 켜야 시작한다.
 */
export default function SanSwitchPerf() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try { const d = await fetchJson('/tools/sanswitch/perf/settings'); setData(d); setForm((f) => f || d.settings); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data || !form) return <Loading />;

  const L = data.limits;
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await putJson('/tools/sanswitch/perf/settings', form); setData(r); setForm(r.settings); setMsg('저장되었습니다.'); }
    catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/sanswitch/perf/collect', {});
      // v2.517: 중앙 직접분과 엣지 요청분을 **나눠** 말한다. 예전에는 `r.collected`(중앙 직접만)를
      // '수집 완료' 로 보여줘, 엣지 위임 장비가 하나도 수집되지 않았는데 성공처럼 보였다.
      setMsg(`${perfCollectSummary(r)}${r?.note ? ` — ${r.note}` : ''}`);
      await load();
    } catch (e) { setMsg(`수집 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  const pruneNow = async () => {
    if (!window.confirm(`보관 기간 ${data.settings.retentionDays}일보다 오래된 표본을 지금 삭제할까요? (되돌릴 수 없습니다. 저장하지 않은 보관 기간 변경은 반영되지 않습니다 — 먼저 저장하세요.)`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/sanswitch/perf/prune', {});
      setMsg(r.ok ? `정리 완료 — ${Number(r.deleted || 0).toLocaleString()}행 삭제${r.unavailable ? ' (DB 사용 불가)' : ''}. 파일 크기는 SQLite 특성상 즉시 줄지 않고 빈 공간이 재사용됩니다.` : `정리 실패: ${r.reason}`);
      await load();
    } catch (e) { setMsg(`정리 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  const db = data.db || {};
  const st = data.status || {};
  const fmtTs = (t) => (t ? new Date(t).toLocaleString() : '—');
  // 보관 기간별 DB 크기 **추정**(v2.420) — 최근 24시간 적재량 × 보관일 × 행당 바이트. 표본이 없으면 표시하지 않는다.
  const retDays = form.retentionDays ?? data.settings?.retentionDays;   // 빈 칸이면 저장값(보내지 않으므로 그대로 유지된다)
  const est = retentionEstimate({ rows: db.rows, fileBytes: db.fileBytes, rowsLastDay: db.rowsLastDay, retentionDays: retDays });
  const dirty = form.retentionDays !== data.settings?.retentionDays;

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>📊 SAN 스위치 포트 사용량 수집</div>

      <div className="card" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
        등록된 Brocade 스위치에 주기적으로 접속해 <code>portperfshow</code> 를 실행하고, 포트별 처리량을
        전용 DB(<code>sanswitch-perf.db</code>)에 시계열로 쌓습니다. 쌓인 데이터는
        특수기능 › SAN 스위치 모니터링의 포트 상세에서 <b>차트</b>로 보고, 연결된 스토리지별로 합산해
        <b> 어느 어레이가 얼마나 쓰이는지</b> 분석할 수 있습니다.
        <div className="muted" style={{ marginTop: 6 }}>
          • 기본은 <b>꺼짐</b>입니다 — 운영 스위치에 주기적으로 SSH 세션을 붙이는 동작이라 명시적으로 켜야 시작합니다.<br />
          • <code>portperfshow</code> 는 Ctrl-C 전까지 화면을 계속 갱신하는 명령이라, <b>표본 시간</b>만큼 받아쓴 뒤
            가장 최근 화면 1벌을 저장합니다.<br />
          • 값의 단위는 스위치가 주는 <b>바이트/초</b> 그대로 저장하고, 화면에서 bps 로 환산해 보여줍니다.<br />
          • SSH 수집 방식 장비만 대상입니다. REST 방식 장비는 포트 통계 카운터로 이미 처리량을 계산합니다.<br />
          • 엣지 위임 장비는 <b>그 엣지에서</b> 수집한 뒤 시계열을 <b>중앙으로 중계</b>합니다(v2.423, 엣지 v2.423 이상). 여기서 켠 설정(켜짐·주기·표본·보관)이
            엣지의 다음 설정 pull(≤5분) 때 내려가므로 <b>엣지에서 따로 켤 필요가 없습니다</b>(엣지가 <code>SANSW_PERF_LOCAL=1</code> 이면 현장 설정 유지).
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <b>포트 사용량 수집 사용</b>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={{ fontSize: 12 }}>수집 주기(초)
            <input className="input" type="number" value={form.intervalMs == null ? '' : Math.round(form.intervalMs / 1000)}
              min={L.intervalMs.min / 1000} max={L.intervalMs.max / 1000}
              onChange={(e) => { const v = blankOr(e.target.value); set('intervalMs', v === undefined ? undefined : v * 1000); }} />
            <span className="muted" style={{ fontSize: 11 }}>{L.intervalMs.min / 1000}~{L.intervalMs.max / 1000}초 · 기본 {L.intervalMs.def / 1000}초</span>
          </label>
          <label style={{ fontSize: 12 }}>표본 시간(초)
            <input className="input" type="number" value={form.sampleSeconds ?? ''}
              min={L.sampleSeconds.min} max={L.sampleSeconds.max}
              onChange={(e) => set('sampleSeconds', blankOr(e.target.value))} />
            <span className="muted" style={{ fontSize: 11 }}>portperfshow 를 받아쓸 시간 · 기본 {L.sampleSeconds.def}초</span>
          </label>
          <label style={{ fontSize: 12 }} title="수집한 포트 사용량 표본을 며칠 동안 보관할지 정합니다. 이보다 오래된 표본은 수집 주기마다(20틱에 1회) 자동 삭제되고, '지금 정리'로 즉시 삭제할 수도 있습니다.">
            보관 기간(일)
            <input className="input" type="number" value={form.retentionDays ?? ''}
              min={L.retentionDays.min} max={L.retentionDays.max}
              onChange={(e) => set('retentionDays', blankOr(e.target.value))} />
            <span className="muted" style={{ fontSize: 11 }}>{L.retentionDays.min}~{L.retentionDays.max.toLocaleString()}일 · 기본 {L.retentionDays.def}일</span>
          </label>
        </div>
        {/* 보관 기간 프리셋 + 영향 설명(v2.420, 사용자 요구 '수집값을 얼마나 오래 저장할지 지정'). */}
        <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 8, fontSize: 12 }}>
          <span className="muted">보관 기간 프리셋</span>
          {RETENTION_PRESETS.map(([d, label]) => (
            <button key={d} className={form.retentionDays === d ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '3px 10px' }}
              title={`보관 기간을 ${d}일(${label})로 설정합니다. 저장을 눌러야 적용됩니다.`}
              onClick={() => set('retentionDays', d)}>{label}<span className="muted" style={{ fontWeight: 400, marginLeft: 4 }}>{d}일</span></button>
          ))}
          {dirty && <span style={{ color: 'var(--amber)' }}>변경됨 — 저장해야 적용됩니다.</span>}
        </div>
        <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 8 }}>
          <b>보관 기간이 영향을 주는 것</b> — ① 사용량 분석 화면에서 조회할 수 있는 최대 과거 범위(기간 지정도 보관 기간 밖은 데이터가 없음)
          ② DB 파일 크기(스위치 수 × 포트 수 × 하루 수집 횟수 × 보관일 만큼 행이 쌓임)
          ③ 정리 비용(삭제는 <code>ts</code> 인덱스를 타므로 행 수와 무관하게 빠르지만, 파일 크기는 SQLite 특성상 즉시 줄지 않고 빈 공간이 재사용됨).
          {est ? (
            <div style={{ marginTop: 4 }}>
              <b>추정</b>(최근 24시간 적재 {est.rowsPerDay.toLocaleString()}행, 행당 약 {Math.round(est.bytesPerRow)}바이트 — 현재 파일 크기 ÷ 행 수, WAL 포함이라 실제보다 다소 클 수 있음):
              하루 약 <b>{bytesText(est.bytesPerDay)}</b> → 보관 {retDays}일이면 최대 약 <b>{bytesText(est.bytesAtRetention)}</b>({Math.round(est.rowsAtRetention).toLocaleString()}행).
              수집 주기·표본 시간·스위치 수를 바꾸면 달라집니다.
            </div>
          ) : <div style={{ marginTop: 4 }}>크기 추정은 최근 24시간에 적재된 표본이 있어야 계산됩니다(지금은 표본이 없습니다).</div>}
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>저장</button>
          <button className="tab" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy} onClick={runNow}
            title="설정이 꺼져 있어도 한 번 수집해 동작을 확인합니다.">지금 1회 수집</button>
          <button className="tab" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy || db.available === false} onClick={pruneNow}
            title="저장된 보관 기간보다 오래된 표본을 지금 삭제합니다(폴러의 자동 정리를 기다리지 않음). 되돌릴 수 없습니다.">🧹 지금 정리</button>
          {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>수집 현황</div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
          마지막 수집: {fmtTs(st.at)} · 성공 {st.collected ?? 0} / 실패 {st.failed ?? 0}
          {st.busy ? ' · 수집 진행중' : ''}<br />
          DB: {db.available === false ? <span style={{ color: 'var(--amber)' }}>사용 불가(node:sqlite 미지원 — 수집·화면은 동작하고 이력만 비활성)</span>
            : <>{(db.rows ?? 0).toLocaleString()}행 · 스위치 {db.devices ?? 0}대 · {fmtTs(db.oldest)} ~ {fmtTs(db.newest)}
                {db.fileBytes != null ? <> · 파일 <b>{bytesText(db.fileBytes)}</b>(WAL 포함)</> : null}
                {db.rowsLastDay != null ? <> · 최근 24시간 적재 {Number(db.rowsLastDay).toLocaleString()}행</> : null}</>}
          {db.file ? <><br />파일: <code>{db.file}</code></> : null}
          {st.errors?.length ? <><br /><span style={{ color: 'var(--amber)' }}>최근 오류: {st.errors.join(' / ')}</span></> : null}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          ⚠ 위 수치는 <b>이 서버가 직접 수집하는 스위치</b>만 센 것입니다 — 엣지 위임 스위치는 아래 표를 보세요.
        </div>
      </div>

      {/* 엣지별 수집 상태(v2.517, 사용자 신고 "데이터 수집이 안되, edge 의 사용량도 분석하게 해줘").
          엣지는 표본이 0건이어도 상태를 올리므로(perfPush 하트비트) '켜졌는지·돌았는지·왜 실패하는지'
          를 중앙에서 볼 수 있다. 보고가 없는 엣지는 '꺼짐' 이라 말하지 않는다 — '모른다' 다. */}
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>엣지 위임 스위치의 수집 상태</div>
        {!(data.edges || []).length ? (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
            엣지가 보고한 수집 상태가 없습니다. 위임 스위치가 없다면 정상이고, 있다면 그 엣지의 포탈 버전이 낮거나
            (상태 보고는 v2.517 부터) 중앙 설정을 받아가지 못하는 상태입니다 — 설정 › 수집 서버에서 그 엣지의
            마지막 연결 시각을 확인하세요.
          </div>
        ) : (
          <div className="table-wrap">
            <STable>
              <thead><tr><th>엣지</th><th>상태</th><th data-nosort>실패한 스위치</th></tr></thead>
              <tbody>
                {(data.edges || []).map((e) => {
                  const failed = (e.devices || []).filter((d) => d.ok === false);
                  return (
                    <tr key={e.agent}>
                      <td><b>{e.agent}</b></td>
                      <td data-sort={String(e.at || 0)}>{edgePerfLine(e)}</td>
                      <td>
                        {!failed.length ? <span className="muted">—</span> : (
                          <div style={{ display: 'grid', gap: 4 }}>
                            {failed.slice(0, 5).map((d) => (
                              <div key={d.id}>
                                <code style={{ fontSize: 11 }}>{d.id}</code>
                                {/* 사유는 툴팁이 아니라 본문 — 복사·공유가 되고 모바일에서도 보인다(v2.516 규약) */}
                                <pre style={{ margin: '2px 0 0', padding: 6, background: 'var(--bg2, rgba(0,0,0,0.25))',
                                  borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{d.error || '사유 미보고'}</pre>
                              </div>
                            ))}
                            {failed.length > 5 && <span className="muted" style={{ fontSize: 11 }}>… 외 {failed.length - 5}대(상한으로 생략)</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        )}
      </div>
    </>
  );
}
