/**
 * views/tools/CurrentUsers.jsx — '현재 사용자'(v2.520).
 *
 * 사용자 요청(2026-09-15): "vcenter 별로 사용자가 설정에서 지정한 폴더의 windows 서버에서
 * 로그인한 사용자의 수를 설정에서 지정한 시간마다 수집하여 현재 사용자라는 이름으로 특수기능에
 * 만들어줘, 전체 사용자를 볼 수 도 있고, vcenter 별로 볼 수 있는 기능" + "10분마다 db 에 저장"
 * + "aaa 라는 사용자가 1개의 vcenter 의 여러 서버에 로그인해 있으면 그건 1명" + **"Guestos 계정 없이"**.
 *
 * 화면 설계 의도:
 *  1. **고유 사용자**가 1순위 숫자다(세션 수가 아니다 — 사용자 규칙). 세션은 보조로 붙인다.
 *  2. 전체 ↔ 법인별을 한 화면에서 전환한다(법인 행 클릭).
 *  3. **확인하지 못한 서버를 조용히 빼지 않는다** — 상단 배너 + 표의 상태 열이 사유를 말하고,
 *     그 서버의 사용자는 집계에서 제외했다는 사실을 밝힌다.
 *  4. 계정명은 기본으로 목록에 넣지 않는다(개인정보성). 펼치면 보인다.
 *
 * ── v2.525: **소스 탭**(사용자 선택 "한 화면에 합치기 — 소스 탭") ─────────────────
 * 사용자 요청 "Horizon 솔루션 사용중인데 실시간 사용자를 뽑고 싶어" 에 따라 이 화면이 두 출처를
 * 갖는다 — **Windows 서버**(guestinfo 경로, v2.520)와 **Horizon(VDI)**(세션 REST, v2.525).
 * 맨 위 `전체 | Windows 서버 | Horizon(VDI)` 탭이 본문을 바꾼다.
 *  · '전체' 는 **합집합**이다(같은 사람이 양쪽에 있으면 1명) — 단순 합·겹친 인원을 함께 밝힌다.
 *  · ⚠ **한 출처를 읽지 못하면 '전체' 라고 말하지 않는다** — 빠진 출처와 그 이유를 적는다
 *    (`curuser/combine.js` 의 `partial`). 합쳐서 하나의 숫자만 보여주면 그 전제가 감춰진다.
 *
 * 판정·문구는 `curUserText.js`·`horizonSessionText.js`(순수, vitest 고정). 이 파일은 조립만 한다.
 * ⚠ 훅은 전부 조기 return 위에(React #310 — v2.202 실제 크래시).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { downloadFile, fetchJson, postJson, usePolling } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import CollectActivity from './CollectActivity.jsx';
import { Card } from './shared.jsx';
import {
  agoText, whenText, intervalText, kindTone, kindLabelOf, kindAdvice, TONE_COLOR,
  collectStateNote, unionNote, sinceNote, skippedSummary, agentGuide, TRUST_NOTE, collectSummary,
} from './curUserText.js';
import { CurrentUsersSettings } from './CurrentUsersSettings.jsx';
import HorizonSessionsPanel from './HorizonSessionsPanel.jsx';
import { combinedNote, partialNote, SOURCE_STATE_LABEL } from './horizonSessionText.js';
import { vcAuthSkipNote } from '../authSkipText.js'; // v2.591(감사 F1): vCenter 인증 정지로 건너뛴 vCenter

const DAYS = [1, 7, 30, 90];

function KindBadge({ kind, labels }) {
  const tone = kindTone(kind);
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600,
      color: TONE_COLOR[tone], border: `1px solid ${TONE_COLOR[tone]}`,
    }}
    >
      {kindLabelOf(kind, labels)}
    </span>
  );
}

/**
 * 폴링 60초 — 수집 주기가 기본 10분이라 15초 폴링은 낭비다(무거운 API 는 15초 폴링 금지,
 * CLAUDE.md V4 규약). `_r` 은 '지금 수집'·설정 저장 뒤 즉시 다시 읽기 위한 무의미 파라미터다
 * (서버는 무시한다) — `usePolling` 은 파라미터가 바뀌면 직전 데이터를 비우므로, 화면 전체가
 * 로딩으로 깜빡이지 않게 마지막 데이터를 `seen` 으로 붙들고 있는다.
 */
const POLL_MS = 60_000;

function WindowsUsersPanel({ scope }) {
  const [nonce, setNonce] = useState(0);
  const params = useMemo(() => ({ ...(scope ? { vcenterId: scope } : {}), ...(nonce ? { _r: String(nonce) } : {}) }), [scope, nonce]);
  const { loading, data: fresh, error } = usePolling('/tools/curuser', params, POLL_MS);
  const seen = useRef(null);
  useEffect(() => { if (fresh) seen.current = fresh; }, [fresh]);
  const data = fresh || seen.current;
  const reload = () => setNonce((n) => n + 1);
  const [picked, setPicked] = useState('');       // 선택한 법인('' = 전체)
  const [days, setDays] = useState(7);
  const [q, setQ] = useState('');
  const [showNames, setShowNames] = useState(false);
  const [openErr, setOpenErr] = useState('');     // 펼친 VM 의 사유
  const [setOpen, setSetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState('');

  const vcenters = data?.vcenters || [];
  const records = data?.records || [];
  const labels = data?.kindLabels || {};
  const note = useMemo(() => collectStateNote(data || {}), [data]);
  const cur = useMemo(() => (picked ? vcenters.find((v) => v.vcenterId === picked) : null), [picked, vcenters]);
  const agg = cur || data?.total || {};
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return records
      .filter((r) => (!picked || r.vcenterId === picked))
      .filter((r) => !needle || `${r.name} ${r.folder} ${r.guestHost}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.sessions ?? -1) - (a.sessions ?? -1) || String(a.name).localeCompare(String(b.name), 'ko'));
  }, [records, picked, q]);
  const skip = useMemo(() => skippedSummary(data?.skipped, data?.skipReasons), [data]);
  const guide = useMemo(() => agentGuide({ guestPublishMs: data?.settings?.guestPublishMs }), [data]);

  const loadHist = async (d = days, vc = picked) => {
    setHistErr(''); setHist(null);
    try { setHist(await fetchJson('/tools/curuser/history', { vcenterId: vc, days: d })); }
    catch (e) { setHistErr(e?.message || String(e)); }
  };
  const collectNow = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    try { setMsg(collectSummary(await postJson('/tools/curuser/collect', {}))); reload(); }
    catch (e) { setMsg(`실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };
  const dlScript = async () => {
    // 파일명은 서버가 ASCII 로 준다(v2.519 A/B — 한글 download 파일명은 헤드리스에서 소실된다).
    try { setMsg(`내려받았습니다: ${await downloadFile('/tools/curuser/agent-script')}`); }
    catch (e) { setMsg(`스크립트 내려받기 실패: ${e?.message || e}`); }
  };

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const since = hist ? sinceNote(hist.span, hist.retentionDays, hist.now) : null;

  return (
    // ⚠ `minWidth: 0` — 그리드 항목의 기본 최소 크기는 `auto`(= 내용의 max-content)라, 표가
    //   넓으면 **컨테이너가 뷰포트보다 커져** 페이지 전체에 가로 스크롤이 생긴다. 400px 실측에서
    //   실제로 그랬다(넘침 357px, 다른 도구 화면의 기준선은 228px). 표는 `.table-wrap` 안에서
    //   자체 스크롤한다(gpu 화면과 같은 방식).
    //   ⚠ 컨테이너의 `minWidth: 0` **만으로는 부족하다** — 암시적 열 트랙이 `auto`(max-content)라
    //   열 자체가 컨테이너를 넘어 자란다. 실측으로 확인했다(minWidth 만 두었을 때 359px 그대로).
    //   그래서 열 트랙을 `minmax(0, 1fr)` 로 못 박는다.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} inline />}

      {/* 긴 설명은 상단 배너가 **한 번만** 한다(v2.509 규칙) */}
      <div style={{ border: `1px solid ${TONE_COLOR[note.tone]}`, borderRadius: 8, padding: '10px 12px', background: 'var(--panel)' }}>
        <div style={{ fontWeight: 700, color: TONE_COLOR[note.tone], marginBottom: note.body ? 4 : 0 }}>{note.title}</div>
        {note.body && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'normal', lineHeight: 1.55 }}><BoldText text={note.body} /></div>}
        {vcAuthSkipNote(data?.poller?.lastResult?.skippedVcenters, { what: '현재 사용자 수집', manual: '지금 수집' })
          && <div style={{ fontSize: 12.5, color: 'var(--red)', whiteSpace: 'normal', lineHeight: 1.55, marginTop: 4 }}><BoldText text={vcAuthSkipNote(data?.poller?.lastResult?.skippedVcenters, { what: '현재 사용자 수집', manual: '지금 수집' })} /></div>}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="tab" onClick={collectNow} disabled={busy}>{busy ? '수집 중…' : '🔄 지금 수집'}</button>
        <button className="tab" onClick={() => setSetOpen(true)}>⚙ 설정</button>
        <button className="tab" onClick={dlScript}>⬇ 발행기 스크립트 내려받기</button>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          수집 주기 {intervalText(data?.poller?.intervalMs ?? data?.settings?.intervalMs)} · 발행 주기(게스트) {intervalText(data?.settings?.guestPublishMs)} · 마지막 조회 {whenText(data?.lastReadAt, data?.now)}
        </span>
        {msg && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{msg}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {/* v2.598 WEBUI-2598-02: 확인한 서버가 0대면 서버가 null 을 준다 — '0명' 으로 채우지 않고 '—' + 사유. */}
        <Card label={picked ? `${cur?.vcenterName || picked} 고유 사용자` : '전체 고유 사용자'} value={agg.users == null ? '—' : `${agg.users}명`}
          meta={agg.users == null ? (data?.settings?.enabled === false ? '수집 꺼짐 — 확인한 서버 0대' : '확인한 서버 0대 — 0명이 아니라 확인 불가') : `활성 ${agg.usersActive ?? '—'} · 연결끊김 ${agg.usersDisc ?? '—'}`} accent="var(--accent)" />
        <Card label="세션" value={agg.sessions == null ? '—' : `${agg.sessions}`} meta={agg.sessions == null ? '확인한 서버 없음' : `활성 ${agg.sessionsActive ?? '—'} · 끊김 ${agg.sessionsDisc ?? '—'}${agg.sessionsOther ? ` · 기타 ${agg.sessionsOther}` : ''}`} />
        <Card label="확인한 서버" value={`${agg.vmsOk ?? 0}대`} meta={`확인 불가 ${agg.vmsFailed ?? 0}대 · 대상 ${data?.targets ?? 0}대`} />
        <Card label="대상 아님" value={`${skip.total}대`} meta={skip.rows.slice(0, 2).map((r) => `${r.short} ${r.n}대`).join(' · ') || '없음'} />
      </div>

      {!picked && unionNote(data?.total) && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}><BoldText text={unionNote(data.total)} /></div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal' }}><BoldText text={TRUST_NOTE} /></div>

      {/* 법인별 — 행 클릭으로 전체↔법인 전환 */}
      <div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>법인(vCenter)별 {picked && <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: 6 }} onClick={() => { setPicked(''); setHist(null); }}>전체 보기</button>}</div>
        <div className="table-wrap">
        <STable className="v3-table">
          <thead>
            <tr>
              <th>법인</th><th>고유 사용자</th><th>활성</th><th>세션</th><th>확인한 서버</th><th>확인 불가</th><th>대상 아님</th><th>마지막 조회</th>
            </tr>
          </thead>
          <tbody>
            {vcenters.map((v) => (
              <tr key={v.vcenterId} onClick={() => { setPicked(v.vcenterId === picked ? '' : v.vcenterId); setHist(null); }} style={{ cursor: 'pointer', background: v.vcenterId === picked ? 'var(--hover)' : undefined }}>
                <td>{v.vcenterName || v.vcenterId}</td>
                <td data-sort={String(v.users ?? -1)}>{v.users == null ? '—' : `${v.users}명`}</td>
                <td data-sort={String(v.usersActive ?? -1)}>{v.usersActive ?? '—'}</td>
                <td data-sort={String(v.sessions ?? -1)}>{v.sessions ?? '—'}</td>
                <td data-sort={String(v.vmsOk)}>{v.vmsOk}</td>
                <td data-sort={String(v.vmsFailed)} style={{ color: v.vmsFailed ? 'var(--amber)' : undefined }}>{v.vmsFailed}</td>
                <td data-sort={String(v.skipped || 0)}>{v.skipped || 0}</td>
                <td data-sort={String(v.lastReadAt || 0)}>{v.lastReadAt ? agoText(data.now - v.lastReadAt) : '—'}</td>
              </tr>
            ))}
            {!vcenters.length && <tr><td colSpan={8} style={{ color: 'var(--text-faint)' }}>표시할 법인이 없습니다.</td></tr>}
          </tbody>
        </STable>
        </div>
      </div>

      {/* 사용자 목록 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontWeight: 700 }}>로그인한 사용자 {agg.users == null ? '—' : `${(agg.names || []).length}명`}</span>
          <button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setShowNames(!showNames)}>
            {showNames ? '계정명 숨기기' : '계정명 보기'}
          </button>
          {!showNames && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>계정명은 개인정보성이라 기본으로 가려 둡니다.</span>}
        </div>
        {showNames && (
          <div className="table-wrap">
          <STable className="v3-table">
            <thead><tr><th>계정</th><th>도메인</th><th>세션</th><th>활성</th><th>연결끊김</th><th>로그인한 서버 수</th></tr></thead>
            <tbody>
              {(agg.names || []).map((u) => (
                <tr key={u.name}>
                  <td>{u.user || u.name}</td><td>{u.domain || '—'}</td>
                  <td data-sort={String(u.sessions)}>{u.sessions}</td>
                  <td data-sort={String(u.active)}>{u.active}</td>
                  <td data-sort={String(u.disc)}>{u.disc}</td>
                  <td data-sort={String((u.vms || []).length)}>{(u.vms || []).length}</td>
                </tr>
              ))}
              {!(agg.names || []).length && <tr><td colSpan={6} style={{ color: 'var(--text-faint)' }}>확인된 로그인 사용자가 없습니다.</td></tr>}
            </tbody>
          </STable>
          </div>
        )}
      </div>

      {/* 서버별 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontWeight: 700 }}>서버별 {rows.length}대</span>
          <SearchBox value={q} onChange={setQ} placeholder="VM·폴더 검색" />
        </div>
        <div className="table-wrap">
        <STable className="v3-table">
          <thead><tr><th>VM</th><th>폴더</th><th>상태</th><th>사용자</th><th>세션</th><th>발행 시각</th><th data-nosort>사유</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vmId}>
                <td>{r.name || r.vmId}</td>
                <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{r.folder || '—'}</td>
                <td data-sort={`${kindTone(r.kind)}-${r.kind}`}><KindBadge kind={r.kind} labels={labels} /></td>
                <td data-sort={String(r.ok ? new Set((r.users || []).map((u) => String(u.name).toLowerCase())).size : -1)}>
                  {r.ok ? `${new Set((r.users || []).map((u) => String(u.name).toLowerCase())).size}명` : '—'}
                </td>
                <td data-sort={String(r.sessions ?? -1)}>{r.sessions == null ? '—' : r.sessions}</td>
                <td data-sort={String(r.at || 0)}>{r.at ? agoText(data.now - r.at) : '—'}</td>
                <td>
                  {(r.error || kindAdvice(r.kind).text)
                    ? <button className="tab" style={{ padding: '1px 7px', fontSize: 11 }} onClick={() => setOpenErr(openErr === r.vmId ? '' : r.vmId)}>{openErr === r.vmId ? '닫기' : '보기'}</button>
                    : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} style={{ color: 'var(--text-faint)' }}>표시할 서버가 없습니다.</td></tr>}
          </tbody>
        </STable>
        </div>
        {openErr && (() => {
          const r = rows.find((x) => x.vmId === openErr);
          if (!r) return null;
          const adv = kindAdvice(r.kind);
          return (
            <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--panel)' }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{r.name || r.vmId} — {kindLabelOf(r.kind, labels)}</div>
              {adv.text && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'normal', lineHeight: 1.55 }}><BoldText text={adv.text} /></div>}
              {r.error && <pre style={{ marginTop: 6, fontSize: 11.5, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{r.error}</pre>}
            </div>
          );
        })()}
        {!!skip.total && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}>
            대상 아님 {skip.total}대 — {skip.rows.map((x) => `${x.text} (${x.n}대)`).join(' / ')}
          </div>
        )}
      </div>

      {/* 추이 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>추이 {picked ? `— ${cur?.vcenterName || picked}` : '— 전체'}</span>
          {DAYS.map((d) => (
            <button key={d} className={d === days ? 'login-btn' : 'tab'} style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => { setDays(d); loadHist(d, picked); }}>{d}일</button>
          ))}
          <button className="tab" style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => loadHist(days, picked)}>불러오기</button>
        </div>
        {histErr && <ErrorBox error={histErr} inline />}
        {since && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 6, whiteSpace: 'normal' }}><BoldText text={since.text} /></div>}
        {hist?.unknownRows > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 6, whiteSpace: 'normal' }}>
            확인한 서버가 0대였던 시각 {hist.unknownRows}개는 선을 끊었습니다 — 0명이 아니라 확인 불가입니다.
          </div>
        )}
        {hist?.rows?.length ? (
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart data={hist.rows.map((r) => ({ ...r, t: whenText(r.ts) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="users" name="고유 사용자" stroke="var(--accent)" dot={false} />
                <Line type="monotone" dataKey="usersActive" name="활성 사용자" stroke="var(--green)" dot={false} />
                <Line type="monotone" dataKey="sessions" name="세션" stroke="var(--amber)" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{hist ? '이 기간에 저장된 표본이 없습니다.' : '기간을 골라 불러오세요.'}</div>
        )}
      </div>

      {/* 배포 안내 */}
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>게스트 발행기 배포 방법 (게스트 계정 없이 동작하는 이유)</summary>
        <ol style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.7, paddingLeft: 20 }}>
          {guide.map((g, i) => <li key={i} style={{ whiteSpace: 'normal' }}><BoldText text={g} /></li>)}
        </ol>
      </details>

      <CollectActivity
        path="/tools/curuser/activity"
        title="📋 현재 사용자 수집 작업"
        emptyText="아직 수집 기록이 없습니다."
        metricCols={[
          { key: 'vms', label: '서버', render: (e) => (e.vms == null ? '—' : `${e.vms}대`), sort: (e) => String(e.vms ?? -1) },
          { key: 'users', label: '고유 사용자', render: (e) => (e.users == null ? '—' : `${e.users}명`), sort: (e) => String(e.users ?? -1) },
        ]}
      />

      {setOpen && (
        <Modal title="현재 사용자 — 수집 설정" onClose={() => { setSetOpen(false); reload(); }} width={980}>
          <CurrentUsersSettings onSaved={() => reload()} />
        </Modal>
      )}
    </div>
  );
}

/**
 * '전체' 탭 — Windows ∪ Horizon(VDI) 고유 사용자.
 *
 * ⚠ 서버(`/tools/current-users/combined`)가 **판정까지** 해서 내려준다(`curuser/combine.js`).
 *   여기서 두 숫자를 더하지 말 것 — 겹친 사람을 두 번 세어 '전체 사용자' 가 거짓이 된다.
 */
function CombinedPanel() {
  const { loading, data, error } = usePolling('/tools/current-users/combined', {}, POLL_MS);
  const c = data?.combined;
  const src = data?.sources || {};
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} inline />}
      {c?.partial && (
        <div style={{ border: '1px solid var(--amber)', borderRadius: 8, padding: '10px 12px', background: 'var(--panel)' }}>
          <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 4 }}>전체가 아닙니다</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'normal', lineHeight: 1.55 }}><BoldText text={partialNote(c)} /></div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {/* v2.598: 읽은 출처가 하나도 없으면 서버가 null 을 준다 — '0명' 으로 채우지 않는다. */}
        <Card label="전체 고유 사용자(합집합)" value={c?.union == null ? '—' : `${c.union}명`} meta={c?.union == null ? '읽은 출처가 없어 확인 불가' : (c?.partial ? '⚠ 일부 출처 누락 — 하한' : 'Windows ∪ VDI')} accent="var(--accent)" />
        <Card label="양쪽 동시" value={c?.both == null ? '—' : `${c.both}명`} meta="Windows 서버와 VDI 에 모두 접속" />
        <Card label="Windows 서버만" value={c?.onlyWindows == null ? '—' : `${c.onlyWindows}명`} meta={SOURCE_STATE_LABEL[src.windows?.state] || ''} />
        <Card label="VDI 만" value={c?.onlyVdi == null ? '—' : `${c.onlyVdi}명`} meta={SOURCE_STATE_LABEL[src.vdi?.state] || ''} />
      </div>
      {c && <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal', lineHeight: 1.6 }}><BoldText text={combinedNote(c)} /></div>}
      {c?.nameFormNote && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal', lineHeight: 1.55 }}><BoldText text={c.nameFormNote} /></div>}

      <div className="table-wrap">
        <STable className="v3-table">
          <thead><tr><th>출처</th><th>상태</th><th>고유 사용자</th><th>세션</th><th data-nosort>비고</th></tr></thead>
          <tbody>
            <tr>
              <td><b>Windows 서버</b></td>
              <td>{SOURCE_STATE_LABEL[src.windows?.state] || src.windows?.state || '—'}</td>
              <td data-sort={String(src.windows?.detail?.users ?? -1)}>{src.windows?.detail?.users ?? '—'}</td>
              <td data-sort={String(src.windows?.detail?.sessions ?? -1)}>{src.windows?.detail?.sessions ?? '—'}</td>
              {/* ⚠ 서버 문구에 `**강조**` 가 들어 있다 — 그대로 뿌리면 별표가 화면에 샌다
                  (v2.439/2.440/2.505 실제 사고. v2.525 Chromium 판독에서 또 발견했다). */}
              <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{src.windows?.reason ? <BoldText text={src.windows.reason} /> : '—'}</td>
            </tr>
            <tr>
              <td><b>Horizon(VDI)</b></td>
              <td>{SOURCE_STATE_LABEL[src.vdi?.state] || src.vdi?.state || '—'}</td>
              <td data-sort={String(src.vdi?.detail?.users ?? -1)}>{src.vdi?.detail?.users ?? '—'}</td>
              <td data-sort={String(src.vdi?.detail?.sessions ?? -1)}>{src.vdi?.detail?.sessions ?? '—'}</td>
              <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{src.vdi?.reason ? <BoldText text={src.vdi.reason} /> : (src.vdi?.detail?.stateBlind ? '세션 상태 필드를 읽지 못해 접속 중 인원은 셀 수 없습니다.' : '—')}</td>
            </tr>
          </tbody>
        </STable>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal' }}>
        <BoldText text="계정 목록은 각 소스 탭에서 봅니다 — 이 탭은 **겹치는 인원**을 드러내는 것이 목적입니다." />
      </div>
    </div>
  );
}

const SOURCES = [
  { key: 'all', label: '전체(합집합)' },
  { key: 'windows', label: 'Windows 서버' },
  { key: 'vdi', label: 'Horizon(VDI)' },
];

/**
 * 소스 탭 셸(v2.525). 탭 선택만 담당하고 수치·판정은 각 패널이 갖는다.
 * ⚠ 탭 키를 바꾸지 말 것 — 사용자가 새로고침해도 같은 탭으로 돌아오게 `localStorage` 에 둔다
 *   (프라이빗 창에서 throw 하므로 **반드시 try/catch** — V4 규약).
 */
export function CurrentUsers({ scope }) {
  const [tab, setTab] = useState(() => {
    try { const v = localStorage.getItem('curuser.source'); return SOURCES.some((s) => s.key === v) ? v : 'windows'; }
    catch { return 'windows'; }
  });
  const pick = (k) => { setTab(k); try { localStorage.setItem('curuser.source', k); } catch { /* 프라이빗 창 */ } };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SOURCES.map((s) => (
          <button key={s.key} className={tab === s.key ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 13px', fontSize: 12.5 }}
            onClick={() => pick(s.key)}>{s.label}</button>
        ))}
      </div>
      {tab === 'all' && <CombinedPanel />}
      {tab === 'windows' && <WindowsUsersPanel scope={scope} />}
      {tab === 'vdi' && <HorizonSessionsPanel />}
    </div>
  );
}

export default CurrentUsers;
