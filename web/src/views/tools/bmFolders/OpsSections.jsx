/**
 * 물리서버 상세 드로어의 운영 구역(v3.50 · 시안 docs/design/bm-feature-proposals ⑩ 건강 점수 · ⑤ 하드웨어 이벤트 로그 · ⑫ 제조사 케이스 · ④ 보안 권고).
 *  · 판정은 서버가 한다 — 여기는 응답을 그리기만(글자는 opsText.js).
 *  · ⑤ 이벤트 로그는 **단추를 눌러 읽는다** — 드로어를 열거나 ↑↓ 로 넘길 때마다 장비에 묻지 않게(그 서버를 수집하는 쪽이 iDRAC 에 SEL 을 쪽마다 묻는다).
 *  · ⑫ 케이스 쓰기는 서버가 허용한 계정에만 칸을 연다(canWrite — 집행은 서버). 접수 자료 묶음은 JSON 내려받기.
 *  · 표는 STable · 늦게 온 이전 서버의 응답은 버린다(컴포넌트를 서버 키로 새로 만든다 — 호출부 key).
 */
import React, { useEffect, useRef, useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import { fetchJson, postJson, downloadFile } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import {
  healthView, HWLOG_SEV, HWLOG_STATUS, HWLOG_WHY, HWLOG_SCOPE_NOTE, filterHwLog, hwLogHead,
  CASE_STATUS, caseStatusText, CASE_NOTE, advisoryView,
} from './opsText.js';
import { lifeView, memCeView, LIFE_NOTE, MEMCE_NOTE } from './lifeText.js';

const when = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString() : '—');

/** ⑩ 건강 점수 — 점수만 보이지 않고 사유를 늘 같이(감점 · 감점 0 으로 견준 것 · 못 읽은 것). */
export function HealthSection({ r, rules }) {
  const v = healthView(r, rules);
  if (!v) return null;
  return (
    <section className="vmh-sec" aria-label="건강 점수">
      <div className="sh">
        <h3>건강 점수{' '}<span className={`badge ${v.color}`} style={{ marginLeft: 8 }}>{v.score == null ? '판정 못 함' : `${v.score} · ${v.band === 'ok' ? '양호' : v.band === 'warn' ? '주의' : '나쁨'}`}</span></h3>
        <span className="muted bmd-sh-sub">100 에서 확인된 문제만큼 뺍니다(부품 장애 · 보증 · 펌웨어 · BIOS — 보안 권고는 점수에 넣지 않고 아래에 따로)</span>
      </div>
      {v.score == null ? <div className="muted bmd-note">{v.few ? '견준 항목이 부족해 점수를 내지 않았습니다 — 못 읽은 것이 많은 서버를 ‘양호’ 로 보이지 않게 합니다. 확인된 사실은 아래에 그대로 보입니다.' : '견준 항목이 없어 점수를 내지 않았습니다.'}</div> : null}
      {v.lines.length || v.judged.length ? (
        <ul className="bmd-hs-list">
          {v.lines.map((l) => <li key={l.k} className="bmd-hs-minus">{l.text}</li>)}
          {v.judged.map((t) => <li key={t} className="muted">{t}</li>)}
        </ul>
      ) : null}
      {v.unknownText.length ? <div className="muted bmd-note">못 읽어서 점수에 넣지 않은 것: {v.unknownText.join(' · ')}</div> : null}
      {v.ruleText ? <div className="muted bmd-note">{v.ruleText}. 점수는 판단을 돕는 값이고, 사유가 먼저입니다.</div> : null}
    </section>
  );
}

/** ⑤ 하드웨어 이벤트 로그(SEL) — 단추로 읽기 · 등급 · 찾기 · 일부만 읽음 · 못 읽은 이유. */
export function HwLogSection({ r, initial = null }) {
  const isBm = r?.kind === 'bm';
  // initial = 시험용 응답(SSR 시험은 effect · 클릭이 돌지 않는다 — 응답별 화면을 그려 보려고)
  const [st, setSt] = useState({ busy: false, d: initial, err: '' });
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('');
  const read = async () => {
    setSt({ busy: true, d: null, err: '' });
    // 장비 시한 · 엣지 당김 시한보다 길게 기다리고 다시 보내지 않는다(기본 GET 은 20초 · 재시도 2 — 한 번 누름에 요청이 세 번 나갔다: 반증 B10)
    try { setSt({ busy: false, d: await fetchJson('/tools/bm-folders/hwlog', { key: r.key }, undefined, { timeoutMs: 60_000, retries: 0 }), err: '' }); } catch (e) { setSt({ busy: false, d: null, err: opErrorText(e) }); }
  };
  const d = st.d;
  const rows = d && !d.why ? filterHwLog(d.rows, { q, sev }) : [];
  return (
    <section className="vmh-sec" aria-label="하드웨어 이벤트 로그">
      <div className="sh">
        <h3>하드웨어 이벤트 로그{d?.demo ? <span className="badge gray" style={{ marginLeft: 8 }}>데모 합성 기록</span> : null}</h3>
        {isBm ? <button type="button" className="logout-btn" disabled={st.busy} onClick={read}>{st.busy ? '읽는 중…' : d ? '다시 읽기' : '기록 읽기'}</button> : null}
      </div>
      {!isBm ? <div className="muted bmd-note">{HWLOG_WHY.esxi}</div>
        : st.err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>{st.err}</div>
          : !d ? <div className="muted bmd-note">{st.busy ? '그 서버를 수집하는 쪽이 장비에서 읽고 있습니다(최대 수십 초)…' : HWLOG_SCOPE_NOTE}</div>
            : d.why ? <div className="muted bmd-note">{HWLOG_WHY[d.why] || '이 서버의 로그를 읽지 못했습니다.'}{d.reason ? ` — ${d.reason}` : ''}</div>
              : d.status !== 'ok' && !(d.rows || []).length ? <div className="muted bmd-note">{HWLOG_STATUS[d.status] || HWLOG_STATUS.error}</div>
                : (
                  <>
                    <div className="flex wrap bmd-hl-bar">
                      <span className="muted">{hwLogHead(d)}</span>
                      <span style={{ flex: 1 }} />
                      {['critical', 'warning', 'ok'].map((k) => (
                        <button key={k} type="button" className={`bmf-chip${sev === k ? ' on' : ''}`} aria-pressed={sev === k} onClick={() => setSev(sev === k ? '' : k)}>
                          {HWLOG_SEV[k].label} {d.counts?.[k] ?? 0}
                        </button>
                      ))}
                    </div>
                    <input className="input bmd-hl-q" type="search" placeholder="기록에서 찾기 — 부품 이름 · 내용 · 코드" value={q} maxLength={64} onChange={(e) => setQ(e.target.value)} aria-label="기록에서 찾기" />
                    {rows.length ? (
                      <STable className="table bmd-ct" minWidth={300} limit={300}>
                        <thead><tr><th>시각</th><th>등급</th><th>내용</th></tr></thead>
                        <tbody>
                          {rows.map((x, i) => {
                            const s = HWLOG_SEV[x.sev] || HWLOG_SEV[''];
                            return (
                              <tr key={`${x.at}:${i}`}>
                                <td data-sort={x.at ?? ''} style={{ whiteSpace: 'nowrap' }}>{when(x.at)}</td>
                                <td data-sort={s.label}><span className={`badge ${s.color}`}>{s.label}</span></td>
                                <td data-sort={x.msg || ''} style={{ overflowWrap: 'anywhere' }}>{x.sensor ? <b>{x.sensor} — </b> : null}{x.msg || '—'}{x.code ? <span className="muted mono" style={{ marginLeft: 6, fontSize: 11 }}>{x.code}</span> : null}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </STable>
                    ) : <div className="muted bmd-note">{q || sev ? '찾는 조건에 맞는 기록이 없습니다.' : '읽은 기록이 없습니다.'}</div>}
                    <MemCeBlock m={d.memCe} />
                    <div className="muted bmd-note">읽은 시각 {when(d.at)} · {HWLOG_SCOPE_NOTE}</div>
                  </>
                )}
    </section>
  );
}

/** ⑫ 제조사 케이스 — 기록 표 · 적기(허용된 계정) · 접수 자료 받기. */
export function CaseSection({ r, initial = null }) {
  const isBm = r?.kind === 'bm';
  const [st, setSt] = useState({ d: initial, err: '' });   // initial = 시험용 응답(HwLogSection 과 같은 까닭)
  const [rev, setRev] = useState(0);
  const [form, setForm] = useState({ id: '', part: '', caseNo: '', status: 'open', note: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const formRef = useRef(null);
  const partRef = useRef(null);
  useEffect(() => {
    if (!isBm) return undefined;
    let alive = true;
    fetchJson('/tools/bm-folders/cases', { key: r.key }).then((x) => { if (alive) setSt({ d: x, err: '' }); }).catch((e) => { if (alive) setSt({ d: null, err: opErrorText(e) }); });
    return () => { alive = false; };
  }, [r?.key, isBm, rev]);
  if (!isBm) return null;
  const d = st.d;
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const x = await postJson('/tools/bm-folders/cases', { key: r.key, ...form });
      if (!x || x.ok === false) throw new Error(x?.reason || '저장하지 못했습니다.');
      setMsg({ ok: true, text: !x.changed ? '바뀐 것이 없어 쓰지 않았습니다.' : form.id ? '고친 내용을 저장했습니다.' : '케이스를 적었습니다.' });
      setForm({ id: '', part: '', caseNo: '', status: 'open', note: '' });
      setRev((n) => n + 1);
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); } finally { setBusy(false); }
  };
  // 파일 이름은 서버가 정한 것(날짜 붙음)을 쓴다 — 고정 이름이면 서버마다 같은 이름이 됐다(반증 B15)
  const bundle = () => downloadFile(`/tools/bm-folders/case-bundle?key=${encodeURIComponent(r.key)}`).catch((e) => setMsg({ ok: false, text: opErrorText(e) }));
  // 고치기 — 적기 칸이 표 아래에 있어 눌러도 보이는 변화가 없었다(반증 B5): 칸으로 옮기고 첫 칸에 초점
  const edit = (c) => {
    setForm({ id: c.id, part: c.part, caseNo: c.caseNo, status: c.status, note: c.note }); setMsg(null);
    requestAnimationFrame(() => { try { formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); partRef.current?.focus({ preventScroll: true }); } catch { /* 이전 브라우저 */ } });
  };
  const remove = async (c) => {
    if (!window.confirm(`끝난 케이스 ‘${c.caseNo || c.part || c.id}’ 를 지웁니다. 되돌릴 수 없습니다(감사 로그에 남습니다).`)) return;
    setBusy(true); setMsg(null);
    try {
      const x = await postJson('/tools/bm-folders/cases/delete', { key: r.key, id: c.id });
      if (!x || x.ok === false) throw new Error(x?.reason || '지우지 못했습니다.');
      setMsg({ ok: true, text: '끝난 케이스를 지웠습니다.' });
      if (form.id === c.id) setForm({ id: '', part: '', caseNo: '', status: 'open', note: '' });
      setRev((n) => n + 1);
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); } finally { setBusy(false); }
  };
  return (
    <section className="vmh-sec" aria-label="제조사 케이스">
      <div className="sh">
        <h3>제조사 케이스</h3>
        <button type="button" className="logout-btn" onClick={bundle} title="서버 · 보증 · 열린 부품 장애 · 뒤처진 펌웨어 · 최근 위험 기록을 한 파일로">접수 자료 받기</button>
      </div>
      <div className="muted bmd-note">{CASE_NOTE}</div>
      {st.err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>{st.err}</div>
        : !d ? <div className="muted bmd-note">읽는 중…</div>
          : d.why === 'no-tag' ? <div className="muted bmd-note">서비스 태그를 모르는 서버라 케이스를 적지 않습니다.</div>
            : (
              <>
                {d.cases?.length ? (
                  <STable className="table bmd-ct" minWidth={300}>
                    <thead><tr><th>부품 · 케이스</th><th>상태</th><th>고친 때</th></tr></thead>
                    <tbody>
                      {d.cases.map((c) => (
                        <tr key={c.id}>
                          <td data-sort={c.part || ''} style={{ overflowWrap: 'anywhere' }}>{c.part || '—'}{c.caseNo ? <div className="mono muted" style={{ fontSize: 11 }}>{c.caseNo}</div> : null}{c.note ? <div className="muted" style={{ fontSize: 11 }}>{c.note}</div> : null}</td>
                          <td data-sort={caseStatusText(c.status)}><span className={`badge ${(CASE_STATUS[c.status] || CASE_STATUS.open).color}`}>{caseStatusText(c.status)}</span></td>
                          <td data-sort={c.at ?? ''}><span style={{ whiteSpace: 'nowrap' }}>{when(c.at)}</span>{c.by ? <div className="muted" style={{ fontSize: 11 }}>{c.by}</div> : null}
                            {/* 단추를 따로 열에 두면 400px 에서 ‘고/치/기’ 로 세로로 접히고 표가 칸을 넘었다(반증 B4) — 시각 칸 아래 줄에 */}
                            {d.canWrite ? <div className="bmd-case-acts"><button type="button" className="logout-btn" disabled={busy} onClick={() => edit(c)}>고치기</button>{c.status === 'closed' ? <button type="button" className="logout-btn" disabled={busy} onClick={() => remove(c)}>지우기</button> : null}</div> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                ) : <div className="muted bmd-note">적힌 케이스가 없습니다.</div>}
                {d.canWrite ? (
                  <div className="bmd-case-form" ref={formRef}>
                    {form.id ? <div className="muted bmd-note" role="status">고치는 중 — {form.caseNo || form.part || '케이스'}</div> : null}
                    <input ref={partRef} className="input" placeholder="부품(예: 디스크 Bay 4)" value={form.part} maxLength={120} onChange={(e) => setForm({ ...form, part: e.target.value })} aria-label="부품" />
                    <input className="input" placeholder="케이스 번호" value={form.caseNo} maxLength={64} onChange={(e) => setForm({ ...form, caseNo: e.target.value })} aria-label="케이스 번호" />
                    <Select className="input" value={form.status} sort={false} onChange={(e) => setForm({ ...form, status: e.target.value })} aria-label="상태">
                      {(d.statuses || Object.keys(CASE_STATUS)).map((s) => <option key={s} value={s}>{caseStatusText(s)}</option>)}
                    </Select>
                    <input className="input" placeholder="비고" value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="비고" />
                    <div className="flex wrap gap">
                      <button type="button" className="login-btn bmd-btn" disabled={busy || (!form.part.trim() && !form.caseNo.trim())} onClick={save}>{form.id ? '고친 내용 저장' : '케이스 적기'}</button>
                      {form.id ? <button type="button" className="logout-btn" disabled={busy} onClick={() => setForm({ id: '', part: '', caseNo: '', status: 'open', note: '' })}>새로 적기</button> : null}
                    </div>
                  </div>
                ) : <div className="muted bmd-note">케이스를 적으려면 이 법인의 쓰기 권한(운영자 이상)이 필요합니다.</div>}
              </>
            )}
      {msg ? <div className={`bmd-opnote ${msg.ok ? 'ok' : 'bad'}`} role={msg.ok ? 'status' : 'alert'} style={{ borderRadius: 8, borderBottom: 0, marginTop: 6 }}>{msg.text}</div> : null}
    </section>
  );
}

/** ④ 펌웨어 보안 권고 — /check 응답(chk)의 adv. 표가 비면 ‘대조하지 않았음’ 을 말한다. */
export function AdvisorySection({ r, chk }) {
  if (r?.kind !== 'bm') return null;
  const d = chk?.d;
  if (!d) return null;   // 읽는 중 · 오류는 보증 구역이 말한다
  const v = advisoryView(d.adv, { unreadable: !!d.advUnreadable });
  return (
    <section className="vmh-sec" aria-label="보안 권고">
      <div className="sh"><h3>펌웨어 보안 권고{' '}<span className={`badge ${v.badge.color}`} style={{ marginLeft: 8 }}>{v.badge.label}</span></h3><span className="muted bmd-sh-sub">관리자가 확인해 올린 권고 표와 대조</span></div>
      {v.rows.length ? (
        <STable className="table bmd-ct" minWidth={300}>
          <thead><tr><th>권고 · 심각도</th><th>구성요소 · 설치 버전</th><th>고친 버전</th></tr></thead>
          <tbody>
            {v.rows.map((h) => (
              <tr key={`${h.id}:${h.label}`}>
                <td data-sort={h.id}>{h.url ? <a href={h.url} target="_blank" rel="noreferrer noopener">{h.id}</a> : <span className="mono">{h.id}</span>} <span className={`badge ${h.sevColor}`}>{h.sevLabel}</span>{h.title ? <div className="muted" style={{ fontSize: 11 }}>{h.title}</div> : null}</td>
                <td data-sort={h.label} style={{ overflowWrap: 'anywhere' }}>{h.label}<div className="mono muted" style={{ fontSize: 11 }}>{h.installed}</div></td>
                <td data-sort={h.fixed} className="mono">{h.fixed}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      ) : null}
      <div className="muted bmd-note">{v.why}</div>
    </section>
  );
}

/** v3.51 ⑧ 메모리 교정 오류 경고 — 이벤트 로그를 읽은 뒤 슬롯별(서버가 센 값 · 오류 건수 자체가 아니다). */
export function MemCeBlock({ m }) {
  const v = memCeView(m);
  if (!v) return null;
  return (
    <div className="bmd-memce" aria-label="메모리 교정 오류 경고">
      <div className="bmd-memce-h"><b>메모리 교정 오류 경고</b> <span className="muted">— {v.head}</span></div>
      {v.slots.length ? (
        <div className="bmd-memce-grid">
          {v.slots.map((x) => <span key={x.slot} className={`bmd-memce-c${x.n ? ' hot' : ''}`} title={`${x.slot} — 경고 기록 ${x.n}건`}><span className="mono">{x.slot}</span> <b>{x.n}</b></span>)}
        </div>
      ) : null}
      {v.unknown ? <div className="muted bmd-note">슬롯을 알 수 없는 경고 기록 {v.unknown}건</div> : null}
      {v.note ? <div className="muted bmd-note">{v.note}</div> : null}
      <div className="muted bmd-note">{MEMCE_NOTE}</div>
    </div>
  );
}

/** v3.51 ⑧ 부품 수명 지표 — SSD 잔여 수명(장비가 보고한 값). /hw 응답(hw.d)을 그리기만 한다. */
export function LifeSection({ r, hw }) {
  if (r?.kind !== 'bm') return null;
  if (!hw || hw.loading || (!hw.d && !hw.err)) return null;   // 읽는 중 · 오류는 하드웨어 요약 구역이 말한다
  const v = hw.d ? lifeView(hw.d) : null;
  if (!v) return null;
  return (
    <section className="vmh-sec" aria-label="부품 수명 지표">
      <div className="sh"><h3>부품 수명 지표</h3><span className="muted bmd-sh-sub">{v.head}</span></div>
      {v.kind === 'rows' ? (
        <STable className="table bmd-ct" minWidth={300}>
          <thead><tr><th>SSD</th><th>잔여 수명</th></tr></thead>
          <tbody>
            {v.rows.map((x) => (
              <tr key={x.key}>
                <td data-sort={x.name} style={{ overflowWrap: 'anywhere' }}>{x.name}<div className="muted" style={{ fontSize: 11 }}>{[x.model, x.gb != null ? `${x.gb} GB` : ''].filter(Boolean).join(' · ')}</div></td>
                <td data-sort={x.life ?? ''}>
                  <span className={`badge ${x.tone}`}>{x.lifeText}</span>
                  {x.life != null ? <span className="bmd-life-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, x.life))}%` }} className={x.tone} /></span> : null}
                  {x.note ? <div className="muted" style={{ fontSize: 11 }}>{x.note}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </STable>
      ) : null}
      {v.why ? <div className="muted bmd-note">{v.why}</div> : null}
      <div className="muted bmd-note">{LIFE_NOTE}</div>
    </section>
  );
}
