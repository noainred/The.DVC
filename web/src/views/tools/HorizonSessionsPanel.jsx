/**
 * views/tools/HorizonSessionsPanel.jsx — '현재 사용자' 화면의 **Horizon(VDI)** 소스 탭(v2.525).
 *
 * 사용자 요청(2026-09-16): "Horizon 솔루션 사용중인데 실시간 사용자를 뽑고 싶어".
 * 화면 구조는 사용자 선택(AskUserQuestion)대로 **한 화면에 합치기 — 소스 탭**이다.
 *
 * 화면 설계 의도:
 *  1. **접속 중(CONNECTED) 고유 계정**이 1순위 숫자다 — '실시간 사용자' 가 그 뜻이다.
 *     상태 필드를 읽지 못하면 그 칸은 **'—'** 이고 이유를 적는다(0 을 쓰지 않는다).
 *  2. **읽지 못한 서버를 조용히 빼지 않는다** — 배너 + 서버 표의 상태 열이 사유와 조치를 말한다.
 *  3. **무엇으로 읽었는지 밝힌다**(`provenanceText`) — 공식 문서를 이 환경에서 읽지 못해
 *     계정 필드명을 후보 체인으로 찾는다(v2.522 `usedCmds` 와 같은 규약).
 *  4. 계정명은 목록에서 가린다(사용자 선택) — 상세에서만 본다.
 *
 * 판정·문구는 `horizonSessionText.js`(순수, vitest 고정). 이 파일은 조립만 한다.
 * ⚠ 훅은 전부 조기 return 위에(React #310 — v2.202 실제 크래시).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson, postJson, usePolling } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { hostText, addressHiddenNote } from './addressHiddenText.js'; // v2.600 AUTHZ-2600-05
import CollectActivity from './CollectActivity.jsx';
import { Card } from './shared.jsx';
import { unitText } from '../unitText.js';
import {
  agoText, intervalText, kindTone, kindAdvice, authStopNote, collectStateNote, connectedText,
  unionNote, lowerBoundPrefix, stateUnknownNote, provenanceText, sinceNote, NAME_MASK_NOTE, TRUST_NOTE, SESSION_PATH_NOTE,
} from './horizonSessionText.js';
import { HorizonSessionSettings } from './HorizonSessionSettings.jsx';

const DAYS = [1, 7, 30, 90];
const POLL_MS = 60_000;     // 수집 주기가 기본 5분 — 15초 폴링은 낭비다(CLAUDE.md V4 규약)

const TONE = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', gray: 'var(--text-faint)', info: 'var(--accent)', warn: 'var(--amber)', error: 'var(--red)', none: 'var(--border)' };

function KindBadge({ kind, labels }) {
  const c = TONE[kindTone(kind)] || TONE.gray;
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600, color: c, border: `1px solid ${c}`, whiteSpace: 'nowrap' }}>
      {labels?.[kind] || kind}
    </span>
  );
}

export default function HorizonSessionsPanel() {
  const [nonce, setNonce] = useState(0);
  const params = useMemo(() => (nonce ? { _r: String(nonce) } : {}), [nonce]);
  const { loading, data: fresh, error } = usePolling('/tools/horizon-sessions', params, POLL_MS);
  const seen = useRef(null);
  useEffect(() => { if (fresh) seen.current = fresh; }, [fresh]);
  const data = fresh || seen.current;
  const reload = () => setNonce((n) => n + 1);

  const [serverId, setServerId] = useState('');     // '' = 전체
  const [days, setDays] = useState(7);
  const [q, setQ] = useState('');
  const [showNames, setShowNames] = useState(false);
  const [detail, setDetail] = useState(null);       // 펼친 서버(상세 모달)
  const [setOpen, setSetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState('');

  const servers = data?.servers || [];
  const labels = data?.kindLabels || {};
  const note = useMemo(() => collectStateNote(data || {}), [data]);
  const picked = useMemo(() => (serverId ? servers.find((s) => s.serverId === serverId) : null), [serverId, servers]);
  const total = data?.total || {};
  const namesSrc = picked ? (picked.names || []) : (total.names || []);
  const nameRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return namesSrc.filter((u) => !needle || String(u.name).toLowerCase().includes(needle));
  }, [namesSrc, q]);
  const canShowNames = showNames || data?.settings?.showNamesInList === true;
  const since = hist ? sinceNote({ span: hist.span, retentionDays: hist.retentionDays, now: hist.now }) : null;

  const loadHist = async (d = days, sid = serverId) => {
    setHistErr(''); setHist(null);
    try { setHist(await fetchJson('/tools/horizon-sessions/history', { serverId: sid, days: d })); }
    catch (e) { setHistErr(e?.message || String(e)); }
  };
  const collectNow = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/horizon-sessions/collect', {});
      setMsg(r.ok
        ? `수집 완료 — 서버 ${unitText(r.servers, '대')} · 고유 사용자 ${unitText(r.users, '명')}${r.serversFailed ? ` · 실패 ${r.serversFailed}대` : ''}`
        : `수집 실패: ${r.reason || (r.errors || []).map((e) => e.error).join(' · ') || '사유 없음'}`);
      reload();
    } catch (e) { setMsg(`실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  return (
    // ⚠ 열 트랙을 `minmax(0, 1fr)` 로 못 박는다 — 암시적 트랙이 `auto`(max-content) 라
    //   표가 넓으면 컨테이너가 뷰포트를 넘긴다(v2.520 에서 400px 실측으로 확인한 결함).
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} inline />}

      {/* 긴 설명은 상단 배너가 **한 번만** 한다(v2.509 규칙) */}
      {note.text && (
        <div style={{ border: `1px solid ${TONE[note.tone] || TONE.none}`, borderRadius: 8, padding: '10px 12px', background: 'var(--panel)' }}>
          <div style={{ fontWeight: 700, color: TONE[note.tone] || 'var(--text)', marginBottom: 4 }}>{note.short || '안내'}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'normal', lineHeight: 1.55 }}><BoldText text={note.text} /></div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="tab" onClick={collectNow} disabled={busy}>{busy ? '수집 중…' : '🔄 지금 수집'}</button>
        <button className="tab" onClick={() => setSetOpen(true)}>⚙ 설정</button>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          수집 주기 {intervalText(data?.poller?.intervalMs ?? data?.settings?.intervalMs)} · 마지막 조회 {agoText(data?.lastReadAt, data?.now)} · 등록 {data?.registered ?? 0}대 / 대상 {data?.targets ?? 0}대
        </span>
        {msg && <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{msg}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Card label={picked ? `${picked.name || picked.serverId} 접속 중 사용자` : '실시간(접속 중) 사용자'}
          value={`${lowerBoundPrefix(picked || total, 'connected')}${connectedText(picked || total)}${connectedText(picked || total) === '—' ? '' : '명'}`}
          meta={connectedText(picked || total) === '—'
            // v2.598 WEBUI-2598-01: 전 서버 조회 실패면 '상태 필드' 탓이 아니다 — 읽은 서버가 없다.
            ? (!picked && total.servers > 0 && !total.serversOk ? '읽어낸 서버가 없어 확인 불가(0명 아님)' : '상태 필드를 읽지 못했습니다')
            : (stateUnknownNote(picked || total) || '접속 중 세션이 있는 고유 계정')}
          accent="var(--accent)" />
        <Card label="고유 사용자(전체 상태)" value={`${lowerBoundPrefix(picked || total, 'users')}${(picked || total).users ?? '—'}${(picked || total).users == null ? '' : '명'}`}
          meta={`연결 끊김 포함 · 세션 ${(picked || total).sessions == null ? '—' : `${lowerBoundPrefix(picked || total, 'sessions')}${(picked || total).sessions}`}`} />
        <Card label="세션 상태" value={`${(picked || total).connected ?? '—'}`}
          meta={`끊김 ${(picked || total).disconnected ?? '—'} · 연결 중 ${(picked || total).pending ?? '—'}`} />
        <Card label="서버" value={`${total.serversOk ?? 0}대`}
          meta={`읽지 못함 ${total.serversFailed ?? 0}대${data?.pending?.length ? ` · 수집 전 ${data.pending.length}대` : ''}`} />
      </div>

      {!picked && unionNote(total) && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}><BoldText text={unionNote(total)} /></div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal', lineHeight: 1.55 }}>
        <BoldText text={TRUST_NOTE} /><br /><BoldText text={SESSION_PATH_NOTE} />
        {addressHiddenNote(data) ? <><br />🔒 <BoldText text={addressHiddenNote(data)} /></> : null}
      </div>

      {/* Connection Server 별 — 행 클릭으로 전체↔서버 전환, 상태 배지 클릭으로 상세 */}
      <div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          Connection Server 별
          {picked && <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: 6 }} onClick={() => { setServerId(''); setHist(null); }}>전체 보기</button>}
        </div>
        <div className="table-wrap">
          <STable className="v3-table">
            <thead>
              <tr>
                <th>서버</th><th>주소</th><th>상태</th><th>접속 중 사용자</th><th>고유 사용자</th>
                <th>세션</th><th>접속/끊김/연결중</th><th>마지막 조회</th><th data-nosort>근거</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => (
                <tr key={s.serverId} style={{ background: s.serverId === serverId ? 'var(--hover)' : undefined }}>
                  <td style={{ cursor: 'pointer' }} onClick={() => { setServerId(s.serverId === serverId ? '' : s.serverId); setHist(null); }}><b>{s.name || s.serverId}</b></td>
                  <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{hostText(s.host)}</td>
                  <td data-sort={s.kind}>
                    {/* ⚠ 실패 사유를 툴팁에만 두지 말 것(v2.516) — 버튼으로 상세를 연다. */}
                    <button className="tab" style={{ padding: 0, border: 0, background: 'none' }} onClick={() => setDetail(s)}>
                      <KindBadge kind={s.kind} labels={labels} />
                    </button>
                  </td>
                  <td data-sort={String(s.usersConnected ?? -1)}>{s.usersConnected ?? '—'}</td>
                  <td data-sort={String(s.users ?? -1)}>{s.users ?? '—'}</td>
                  <td data-sort={String(s.sessions ?? -1)}>{s.sessions ?? '—'}</td>
                  <td style={{ fontSize: 11.5 }}>{`${s.connected ?? '—'} / ${s.disconnected ?? '—'} / ${s.pending ?? '—'}`}</td>
                  <td data-sort={String(s.ts || 0)}>{agoText(s.ts, data?.now)}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'normal', maxWidth: 320 }}><BoldText text={provenanceText(s) || '—'} /></td>
                </tr>
              ))}
              {(data?.pending || []).map((p) => (
                <tr key={`p-${p.serverId}`}>
                  <td><b>{p.name}</b></td>
                  <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{hostText(p.host)}</td>
                  <td><span style={{ fontSize: 11, color: 'var(--text-faint)' }}>수집 전</span></td>
                  <td colSpan={6} style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>아직 한 번도 수집되지 않았습니다 — '사용자 0명' 이 아닙니다.</td>
                </tr>
              ))}
              {!servers.length && !data?.pending?.length && (
                <tr><td colSpan={9} style={{ color: 'var(--text-faint)' }}>표시할 Horizon 서버가 없습니다.</td></tr>
              )}
            </tbody>
          </STable>
        </div>
      </div>

      {/* 사용자 목록 — 계정명은 기본 가림(사용자 선택) */}
      <div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>{picked ? `${picked.name || picked.serverId} 사용자` : '사용자'} {nameRows.length}명</div>
          <SearchBox value={q} onChange={setQ} placeholder="계정 검색" />
          <label style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={canShowNames} disabled={data?.settings?.showNamesInList === true} onChange={(e) => setShowNames(e.target.checked)} />
            계정명 표시
          </label>
        </div>
        {!canShowNames && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 6, whiteSpace: 'normal' }}>{NAME_MASK_NOTE}</div>}
        <div className="table-wrap" style={{ maxHeight: '38vh' }}>
          {/* v2.575 BUG-19: 상한은 정렬 뒤 적용(먼저 자르면 '세션 많은 순' 이 앞 500명 안에서만 돈다). */}
          <STable className="v3-table" limit={500}>
            <thead><tr><th>계정</th><th>접속 중</th><th>세션</th><th>{picked ? '풀·장비' : '서버'}</th></tr></thead>
            <tbody>
              {nameRows.map((u, i) => (
                <tr key={`${u.name}-${i}`}>
                  <td>{canShowNames ? u.name : <span style={{ color: 'var(--text-faint)' }}>{`사용자 #${i + 1}`}</span>}{u.isSid && <span style={{ fontSize: 10, marginLeft: 4, color: 'var(--amber)' }}>SID</span>}</td>
                  <td data-sort={String(u.connected ?? 0)}>{u.connected ?? '—'}</td>
                  <td data-sort={String(u.sessions ?? 0)}>{u.sessions ?? '—'}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'normal' }}>
                    {picked ? [...(u.pools || []), ...(u.machines || [])].join(', ') || '—' : (u.servers || []).join(', ') || '—'}
                  </td>
                </tr>
              ))}
              {!nameRows.length && <tr><td colSpan={4} style={{ color: 'var(--text-faint)' }}>표시할 사용자가 없습니다.</td></tr>}
            </tbody>
          </STable>
        </div>
        {nameRows.length > 500 && <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>표에는 500명까지만 표시했습니다(전체 {nameRows.length}명).</div>}
      </div>

      {/* 추이 */}
      <div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>추이 {picked ? `— ${picked.name || picked.serverId}` : '— 전체(합집합)'}</div>
          {DAYS.map((d) => (
            <button key={d} className="tab" style={{ padding: '2px 9px', fontSize: 11, opacity: d === days ? 1 : 0.6 }}
              onClick={() => { setDays(d); loadHist(d, serverId); }}>{d}일</button>
          ))}
          {!hist && !histErr && <button className="tab" style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => loadHist(days, serverId)}>불러오기</button>}
        </div>
        {histErr && <ErrorBox error={histErr} inline />}
        {since && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 6, whiteSpace: 'normal' }}><BoldText text={since.text} /></div>}
        {hist?.rows?.length > 0 && (
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart data={hist.rows.map((r) => ({ ...r, t: new Date(r.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }))}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="usersConnected" name="접속 중 사용자" stroke="#22c55e" dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="users" name="고유 사용자" stroke="#0ea5e9" dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="sessions" name="세션" stroke="#a78bfa" dot={false} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {hist && !hist.rows?.length && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>이 기간에 저장된 추이가 없습니다.</div>}
      </div>

      <CollectActivity
        path="/tools/horizon-sessions/activity"
        title="📋 Horizon 세션 수집 작업"
        emptyText="아직 수집 기록이 없습니다."
        metricCols={[
          { key: 'sessions', label: '세션', render: (e) => (e.sessions == null ? '—' : `${e.sessions}`), sort: (e) => String(e.sessions ?? -1) },
          { key: 'users', label: '고유 사용자', render: (e) => (e.users == null ? '—' : `${e.users}명`), sort: (e) => String(e.users ?? -1) },
        ]}
      />

      {detail && (
        <Modal title={`${detail.name || detail.serverId} — 수집 상태`} onClose={() => setDetail(null)} width={720}>
          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <div><b>판정</b> <KindBadge kind={detail.kind} labels={labels} /></div>
            {/*
              * ⚠⚠ v2.574 BUG-11 — `kindAdvice()` 는 **객체** `{waiting, text}` 를 돌려준다.
              *   예전에는 그 객체를 그대로 BoldText 에 넘겨 `boldText.jsx boldParts` 의
              *   `String(text ?? '')` 가 **`[object Object]`** 를 만들었다 — 조치 안내가 통째로
              *   사라진 것이다(v2.569 React #31 과 같은 계열). 게다가 객체는 **항상 truthy** 라
              *   문구가 없는 `ok` 에서도 그 상자가 떴다.
              *   같은 함수를 쓰는 `CurrentUsers.jsx:258` 은 처음부터 `adv.text` 로 올바르게 썼다.
              */}
            {kindAdvice(detail.kind).text && (
              <div style={{ marginTop: 6, whiteSpace: 'normal' }}><BoldText text={kindAdvice(detail.kind).text} /></div>
            )}
            {/* 정지 사실만이 아니라 **시점·횟수**를 말한다(v2.528 규약) — 없으면 사용자가 그동안의 수치를 현재값으로 읽는다. */}
            {authStopNote(detail.authStopped, data?.now) && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'normal' }}>
                {authStopNote(detail.authStopped, data?.now).text}
              </div>
            )}
            {detail.error && (
              <>
                <div style={{ marginTop: 8, fontWeight: 700 }}>장비가 돌려준 사유(원문)</div>
                {/* 복사·공유가 되도록 `<pre>` 로 — 툴팁에만 두지 말 것(v2.516 규약). */}
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, background: 'var(--panel)', padding: 8, borderRadius: 6 }}>{detail.error}</pre>
              </>
            )}
            <div style={{ marginTop: 8 }}><b>근거</b> — <BoldText text={provenanceText(detail) || '수집에 성공하지 못해 근거가 없습니다.'} /></div>
            {detail.sampleKeys?.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'normal' }}>응답 필드: {detail.sampleKeys.join(', ')}</div>
            )}
            {detail.pools?.length > 0 && (
              <>
                <div style={{ marginTop: 10, fontWeight: 700 }}>풀·팜별</div>
                <div className="table-wrap" style={{ maxHeight: '30vh' }}>
                  <STable className="v3-table">
                    <thead><tr><th>풀·팜</th><th>접속 중</th><th>세션</th><th>사용자</th></tr></thead>
                    <tbody>
                      {detail.pools.map((p) => (
                        <tr key={p.pool}><td>{p.pool}</td><td data-sort={String(p.connected)}>{p.connected}</td><td data-sort={String(p.sessions)}>{p.sessions}</td><td data-sort={String(p.users)}>{p.users}</td></tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {setOpen && <HorizonSessionSettings onClose={() => { setSetOpen(false); reload(); }} />}
    </div>
  );
}
