/**
 * 파트 장애(물리 부품 장애) — 서버·스토리지의 PSU·디스크·메모리·팬·컨트롤러 등 **부품 단위**
 * 장애를 기록하고 알리는 화면(v2.547).
 *
 * 사용자 요청(2026-09-17): "서버 스토리지 등의 모든 장비에 있는 물리 파트 장애가 발생하면
 * 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면을 만들고 싶어" +
 * "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘".
 *
 * 화면 설계 의도:
 *  1. **맨 위는 '이 목록을 믿어도 되는가'** 다 — 점검이 돌았는지, 못 본 장비가 몇 대인지,
 *     보고가 없는 엣지가 몇 곳인지. 빈 목록을 '정상' 으로 읽게 두는 것이 이 기능이 만들 수
 *     있는 가장 위험한 거짓이다(v2.519 월간 점검과 같은 판단).
 *  2. 열린 장애 표와 **전이 이력**(열림/변화/해소)을 나눠 둔다 — '지금' 과 '경과' 는 다른 질문이다.
 *  3. 판정·문구는 `partFaultText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ 폴링하지 않는다 — 점검 자체가 10분 주기이고 이 화면은 그 결과(DB)를 읽을 뿐이다.
 *   마운트 1회 + 버튼(`v4Portal2508.test.js` 규약과 같은 판단).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  emptyDiag, scanNote, edgeNote, keyKindNote, holdText, eventText,
  notifyNote, lastRunText, ageText, intervalText, toneVar, holdNote,
} from './partFaultText.js';

// ⚠ 서버 톤(red/amber/green/gray)과 진단 톤(bad/warn/ok/muted) 을 **한 함수**가 받는다 —
//   나눠 두면 한쪽이 색을 잃는다(v2.547 초판 결함).
const stateColor = toneVar;

export function PartFaults() {
  // ⚠ 훅은 전부 조기 return 위에(루트 CLAUDE.md — 조기 반환 뒤 훅 추가는 React #310 크래시).
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('open');
  const [days, setDays] = useState(30);

  const load = React.useCallback(() => {
    setLoading(true);
    return fetchJson('/tools/part-faults')
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== 'events') return;
    fetchJson('/tools/part-faults/events', { days }).then(setEvents).catch((e) => setEvents({ error: e.message }));
  }, [tab, days]);

  const labels = data?.labels || {};
  const open = data?.open || [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return open;
    const terms = needle.split(/\s+/);
    return open.filter((p) => {
      const hay = `${p.deviceName} ${p.deviceId} ${p.label} ${p.detail} ${p.rawState} ${p.agent}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [open, q]);

  const diag = useMemo(() => emptyDiag({
    open, poller: data?.poller, db: data?.db, edges: data?.edges, role: data?.role,
  }), [open, data]);
  const sn = useMemo(() => scanNote(data?.poller?.last?.local), [data]);
  const en = useMemo(() => edgeNote(data?.edges), [data]);

  async function runScan() {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/part-faults/scan', {});
      setMsg(r.ok
        ? `점검 완료 — 신규 ${r?.stats?.opened ?? 0} · 해소 ${r?.stats?.closed ?? 0} · 변화 ${r?.stats?.changed ?? 0}`
        : `점검하지 못했습니다 — ${r.reason || '알 수 없는 사유'}`);
      await load();
    } catch (e) { setMsg(`점검 실패 — ${e.message}`); }
    finally { setBusy(false); }
  }

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  const poller = data?.poller;
  const db = data?.db;

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && <div className="banner warn">갱신 실패 — {error}</div>}

      {/* ① 이 목록을 믿어도 되는가 — 가장 위. */}
      <div className="card" style={{ padding: 12, borderLeft: `3px solid ${stateColor(diag.tone)}` }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <b>파트 장애 점검</b>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{lastRunText(poller)}</span>
            <button className="btn" onClick={runScan} disabled={busy}>{busy ? '점검 중…' : '지금 점검'}</button>
          </div>
        </div>
        {diag.text && <div style={{ marginTop: 8, color: stateColor(diag.tone) }}><BoldText text={diag.text} /></div>}
        {sn && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-faint)' }}><BoldText text={sn.text} /></div>}
        {en && <div style={{ marginTop: 4, fontSize: 12, color: stateColor(en.tone) }}><BoldText text={en.text} /></div>}
        {/* 보류 사유의 **긴 설명은 여기서 한 번만** — 행에는 짧은 라벨만 둔다(v2.509 규약). */}
        {holdNote(open) && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--amber)' }}><BoldText text={holdNote(open)} /></div>}
        {notifyNote(poller?.last) && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}><BoldText text={notifyNote(poller.last)} /></div>
        )}
        {poller && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}>
            자동 점검 {poller.enabled ? `켜짐 · 주기 ${intervalText(poller.intervalMs)}` : '꺼짐'}
            {db && db.available === false ? ' · DB 사용 불가' : db?.retentionDays ? ` · 이력 보존 ${db.retentionDays}일` : ''}
          </div>
        )}
        {msg && <div style={{ marginTop: 6 }}><BoldText text={msg} /></div>}
      </div>

      {/* ② 수치 — unknown/absent 를 정상에도 장애에도 넣지 않는다(각각 표시). */}
      <div className="kpis">
        <Kpi label="이상 부품" value={data?.summary?.fault ?? 0} accent="var(--red)" meta="즉시 조치" />
        <Kpi label="주의 부품" value={data?.summary?.warn ?? 0} accent="var(--amber)" meta="예고·성능저하 포함" />
        <Kpi label="영향 장비" value={data?.summary?.devices ?? 0} meta="이상·주의가 열려 있는 장비 수" />
        <Kpi label="상태 미확인 부품" value={sn ? sn.unknown : '—'} meta="정상이라는 뜻이 아닙니다" />
        <Kpi label="빈 슬롯" value={sn ? sn.absent : '—'} meta="고장이 아닙니다" />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className={`btn${tab === 'open' ? ' active' : ''}`} onClick={() => setTab('open')}>열린 장애 {open.length}</button>
        <button className={`btn${tab === 'events' ? ' active' : ''}`} onClick={() => setTab('events')}>이력</button>
        {tab === 'open' && <SearchBox value={q} onChange={setQ} placeholder="장비·부품·원문 상태 검색" />}
        {tab === 'events' && (
          <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>최근 {d}일</option>)}
          </select>
        )}
      </div>

      {tab === 'open' && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <STable>
            <thead><tr>
              <th>상태</th><th>장비</th><th>부품</th><th>장비 보고 원문</th><th>처음 감지</th><th>최근 확인</th><th>수집</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ padding: 16, color: 'var(--text-faint)' }}>
                {open.length ? '검색 조건에 맞는 항목이 없습니다.' : '열린 장애가 없습니다 — 위 안내를 함께 읽어 주세요.'}
              </td></tr>}
              {rows.map((p) => {
                const kk = keyKindNote(p.keyKind, labels.keyKindNote);
                const hold = holdText(p.holdReason);
                return (
                  <tr key={p.partKey}>
                    <td data-sort={p.state === 'fault' ? '0' : '1'}>
                      <span style={{ color: stateColor(labels.tone?.[p.state]), fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {labels.state?.[p.state] || p.state}
                      </span>
                    </td>
                    <td style={{ maxWidth: 180, whiteSpace: 'normal' }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.deviceId}>{p.deviceName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{labels.scope?.[p.scope] || p.scope}</div>
                    </td>
                    <td style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                      <div>{p.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                        {labels.kind?.[p.kind] || p.kind}{p.detail ? ` · ${p.detail}` : ''}
                      </div>
                      {kk && <div style={{ fontSize: 11, color: 'var(--amber)' }}><BoldText text={kk} /></div>}
                    </td>
                    <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>
                      <code style={{ fontSize: 11 }}>{p.rawState || '—'}</code>
                      {hold && <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 2 }}><BoldText text={hold} /></div>}
                    </td>
                    <td data-sort={p.firstSeenAt || 0} style={{ whiteSpace: 'nowrap' }}>{p.firstSeenAt ? new Date(p.firstSeenAt).toLocaleString('ko-KR') : '—'}</td>
                    <td data-sort={p.lastSeenAt || 0} style={{ whiteSpace: 'nowrap' }}>{ageText(Date.now() - (p.lastSeenAt || 0))}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{p.agent || '중앙'}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}

      {tab === 'events' && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {!events && <Loading />}
          {events?.error && <ErrorBox message={events.error} />}
          {events?.events && (
            <>
              {events.truncated && (
                <div style={{ padding: 8, color: 'var(--amber)', fontSize: 12 }}>
                  상한({events.limit}건)으로 잘렸습니다 — 더 이전 이력은 기간을 좁혀 보세요.
                </div>
              )}
              <STable>
                <thead><tr><th>시각</th><th>장비</th><th>부품</th><th>사건</th><th>장비 보고 원문</th><th>수집</th></tr></thead>
                <tbody>
                  {events.events.length === 0 && <tr><td colSpan={6} style={{ padding: 16, color: 'var(--text-faint)' }}>
                    <BoldText text="이 기간에 기록된 전이가 없습니다. 이력은 **상태가 바뀐 순간만** 남기므로, 기록이 없다는 것은 그동안 변화가 없었다는 뜻입니다." />
                  </td></tr>}
                  {events.events.map((ev, i) => (
                    <tr key={`${ev.partKey}:${ev.at}:${i}`}>
                      <td data-sort={ev.at} style={{ whiteSpace: 'nowrap' }}>{new Date(ev.at).toLocaleString('ko-KR')}</td>
                      <td style={{ maxWidth: 180, whiteSpace: 'normal' }}>{ev.deviceName || ev.deviceId}</td>
                      <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>{ev.label}<div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{events.labels?.kind?.[ev.kind] || ev.kind}</div></td>
                      <td style={{ maxWidth: 220, whiteSpace: 'normal' }}><BoldText text={eventText(ev, events.labels)} /></td>
                      <td style={{ maxWidth: 180, whiteSpace: 'normal' }}><code style={{ fontSize: 11 }}>{ev.rawState || '—'}</code></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{ev.agent || '중앙'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default PartFaults;
