/**
 * '빈 인벤토리' / 'MOCK' 배지 클릭 → **상태 · 로그 · 해결방법**(v2.560).
 *
 * 사용자 요청(2026-09-18): "빈 인벤터리로 나올때 상태와 로그, 해결방법을 클릭하면 나오게 해줘".
 *
 * ── 새 네트워크 허용이 필요 없다 ─────────────────────────────────────────────
 * 엣지 상태·로그는 v2.549 의 **엣지 로그 pull** 을 그대로 쓴다(`POST /tools/edge-log/fetch`) —
 * `collector/puller.js` 가 이미 60초마다 쓰는 **같은 url·같은 토큰**이다. 새 엔드포인트를
 * 만들지 않았고, 상시 폴링도 없다(사람이 누를 때만 나간다 — v2.508 V4 규약).
 *
 * ⚠ **원인을 단정하지 않는다** — 판정은 `emptyInvText.js` 가 소유하고, 엣지 상태를 가져오기
 *   전에는 `확정하지 못했습니다` 라고 말한다(v2.493 규약).
 * ⚠ 열자마자 엣지로 나가지 않는다 — 먼저 **중앙이 이미 아는 것**을 보여주고, 사람이 버튼을
 *   눌러야 엣지로 간다(모달을 여는 것만으로 28곳에 요청이 나가면 그게 사고다).
 * ⚠ 문구는 `BoldText` 로 렌더한다(`**강조**` 가 별표로 새는 사고 — v2.439·2.440·2.505).
 */
import React, { useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import BoldText from '../../components/boldText.jsx';
import { STable } from '../../components/STable.jsx';
import {
  diagnoseEmptyInventory, headline, CAUSE_WHY, CAUSE_FIX, CAUSE_WAITING,
  statusValue, relevantLogs,
} from './emptyInvText.js';

const ago = (ts) => {
  if (ts == null || ts === '') return '—';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = Math.max(0, Math.round((Date.now() - n) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
};

const FETCH_KIND_TEXT = Object.freeze({
  auth: '수집 서버 토큰이 거부됐습니다 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요(특수기능 › 포탈 점검 › 토큰 점검). **다시 눌러도 같습니다.**',
  disabled: '그 엣지에 COLLECTOR_TOKEN 이 설정돼 있지 않습니다 — 엣지의 수집 기능 자체가 꺼진 상태입니다.',
  'old-version': '그 엣지가 **구버전**이라 로그 조회 경로가 없습니다 — 업그레이드해야 읽을 수 있습니다.',
  unreachable: '중앙이 그 엣지에 닿지 못했습니다 — 요청을 등록해 두었고, 엣지가 스스로 인출해 회신하면 여기에 나타납니다.',
  timeout: '응답이 시한을 넘겼습니다 — 요청을 등록해 두었고, 엣지가 스스로 인출해 회신하면 여기에 나타납니다.',
  'not-registered': '이 이름이 수집 서버 등록부에 없습니다 — 설정 › 수집 서버에서 등록하세요.',
  'disabled-central': '중앙에서 이 수집 서버를 비활성으로 두었습니다.',
  'no-url': '이 수집 서버에 URL 이 없습니다.',
  'bad-body': '응답 형식이 달랐습니다 — 그 주소가 정말 엣지 포탈인지 확인하세요.',
});

export default function EmptyInvModal({ agent, push, onClose }) {
  // ⚠ 훅은 전부 조기 return 위에(React #310 — v2.202 실제 사고).
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fetchNote, setFetchNote] = useState('');
  const [showAllLogs, setShowAllLogs] = useState(false);

  const statusItems = snap?.status || null;
  const d = diagnoseEmptyInventory({ push, statusItems });
  const inv = statusValue(statusItems, 'collect.inventory');
  const pushSt = statusValue(statusItems, 'push.inventory');
  const logs = snap?.logs?.items || [];
  const shown = showAllLogs ? logs : relevantLogs(logs);

  const pull = async () => {
    setBusy(true); setFetchNote('');
    try {
      const r = await postJson('/tools/edge-log/fetch', { agent, limit: 300, withStatus: true });
      if (r?.snap) setSnap(r.snap);
      if (!r?.ok) {
        const base = FETCH_KIND_TEXT[r?.kind] || `가져오지 못했습니다${r?.reason ? ` — ${r.reason}` : ''}.`;
        // ⚠ 폴백 등록 사실을 **한 번만** 말한다(v2.549 초판이 두 번 띄웠다).
        setFetchNote(r?.snap ? `${base} 아래는 ${ago(r.snap.at)} 가져온 **보관분**입니다.` : base);
      } else {
        setFetchNote('');
      }
    } catch (e) {
      setFetchNote(`가져오지 못했습니다 — ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  const loadStored = async () => {
    setBusy(true); setFetchNote('');
    try {
      const r = await fetchJson(`/tools/edge-log/${encodeURIComponent(agent)}`);
      if (r?.snap) { setSnap(r.snap); setFetchNote(`아래는 ${ago(r.snap.at)} 가져온 **보관분**입니다(지금 값이 아닙니다).`); }
      else setFetchNote('보관된 로그가 없습니다 — 아직 한 번도 가져오지 않았습니다(이상이 아닙니다. 이 기능은 누를 때만 엣지로 갑니다).');
    } catch (e) { setFetchNote(`보관분 조회 실패 — ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal" style={{ maxWidth: 820, width: '100%', maxHeight: '86vh', overflow: 'auto', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>{agent} — 인벤토리가 비어 있는 이유</b>
          <button className="logout-btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={onClose}>닫기</button>
        </div>

        {/* ① 원인 — 확정 여부를 말로 밝힌다 */}
        <div className="card" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}><BoldText text={headline(d)} /></div>
          <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--muted)' }}>
            <BoldText text={CAUSE_WHY[d.kind] || CAUSE_WHY.unknown} />
          </div>
          {/* '기다리면 되는가' 를 명시한다 — 이 한 줄이 이 모달의 존재 이유다(v2.517 규약). */}
          <div style={{ fontSize: 12, marginTop: 6, color: CAUSE_WAITING[d.kind] ? 'var(--green)' : 'var(--amber)' }}>
            {CAUSE_WAITING[d.kind] ? '기다리면 채워집니다.' : '기다려도 채워지지 않습니다 — 아래 조치가 필요합니다.'}
          </div>
        </div>

        {/* ② 근거 — 중앙이 본 것 + 엣지가 말한 것 */}
        <div className="card" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 12 }}>근거</b>
          <ul style={{ fontSize: 12, lineHeight: 1.8, margin: '4px 0 0', paddingLeft: 18 }}>
            <li>
              중앙이 받은 마지막 push: {push?.endpoint || '—'}
              {push?.vcenterId ? ` · ${push.vcenterId}` : ''}
              {push?.hosts != null ? ` · 호스트 ${push.hosts} · VM ${push.vms}` : ''}
              {push?.gzip ? ' · gzip' : ' · 무압축'}
            </li>
            {d.evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>

        {/* ③ 상태 — 엣지가 말한 vCenter 별 상태 */}
        <div className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <b style={{ fontSize: 12 }}>엣지 상태 · 로그</b>
            <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={pull} disabled={busy}>
              {busy ? '가져오는 중…' : '엣지 상태·로그 가져오기'}
            </button>
            <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={loadStored} disabled={busy}>보관분 보기</button>
            {snap?.at ? <span className="muted" style={{ fontSize: 11 }}>{ago(snap.at)} · 엣지 v{snap?.node?.version || '?'}</span> : null}
          </div>
          {fetchNote && <div style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 6 }}><BoldText text={fetchNote} /></div>}
          {!snap && !fetchNote && (
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
              {/* ⚠ 열자마자 엣지로 나가지 않는다 — 그 사실을 말한다. */}
              아직 가져오지 않았습니다. 버튼을 누르면 그 엣지의 vCenter 수집 상태와 최근 로그를 그때그때 읽어 옵니다(상시 트래픽은 없습니다).
            </div>
          )}
          {inv && (
            <div>
              {/* v2.575 IMP-05: 웹에 마지막으로 남아 있던 raw `<table>` — 사용자 상시 요구
                  '모든 표는 제목 클릭 정렬'(v2.422)의 유일한 예외였다. STable 이 가로 스크롤
                  래퍼까지 만든다(minWidth 와 짝) — 바깥 overflowX div 는 이제 필요 없다. */}
              <STable minWidth={460} style={{ fontSize: 11.5, borderCollapse: 'collapse' }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                  <th style={{ padding: '2px 8px 2px 0' }}>vCenter</th><th style={{ padding: '2px 8px' }}>상태</th>
                  <th style={{ padding: '2px 8px' }}>호스트</th><th style={{ padding: '2px 8px' }}>VM</th>
                  <th style={{ padding: '2px 8px' }}>수집 방식</th><th style={{ padding: '2px 0 2px 8px' }}>오류</th>
                </tr></thead>
                <tbody>
                  {(inv.vcenters || []).map((v) => (
                    <tr key={v.id}>
                      <td style={{ padding: '2px 8px 2px 0' }}>{v.id}{v.mock ? ' (mock)' : ''}</td>
                      <td style={{ padding: '2px 8px', color: v.status === 'unreachable' ? 'var(--red)' : v.status === 'pending' ? 'var(--amber)' : undefined }}>{v.status}</td>
                      {/* ⚠ null 은 0 이 아니다 — 못 읽은 것을 '0대' 라고 말하지 않는다. */}
                      <td style={{ padding: '2px 8px' }}>{v.hosts == null ? '—' : v.hosts}</td>
                      <td style={{ padding: '2px 8px' }}>{v.vms == null ? '—' : v.vms}</td>
                      <td style={{ padding: '2px 8px' }}>{v.collectMode || '직접'}</td>
                      <td style={{ padding: '2px 0 2px 8px', whiteSpace: 'normal' }}>{v.error || ''}</td>
                    </tr>
                  ))}
                  {(inv.vcenters || []).length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ padding: '4px 0' }}>이 엣지에 등록된 vCenter 가 없습니다.</td></tr>
                  )}
                </tbody>
              </STable>
              {inv.truncated && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>목록이 상한으로 잘렸습니다 — {inv.omitted}개 더 있습니다.</div>}
              {inv.lastError && <div style={{ fontSize: 11.5, marginTop: 4, color: 'var(--red)' }}>마지막 수집 오류: {inv.lastError}</div>}
            </div>
          )}
          {pushSt && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.7 }}>
              인벤토리 push: {pushSt.enabled ? '켜짐' : '꺼짐'}
              {pushSt.last ? ` · 마지막 ${ago(pushSt.last.at)} · 전송 ${pushSt.last.sent}곳`
                + (pushSt.last.skippedMock ? ` · mock 제외 ${pushSt.last.skippedMock}곳` : '')
                + (pushSt.last.errors?.length ? ` · 실패 ${pushSt.last.errors.length}건` : '') : ' · 아직 보낸 적 없음'}
            </div>
          )}
          {snap && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <b style={{ fontSize: 11.5 }}>최근 로그 {shown.length}줄</b>
                <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={showAllLogs} onChange={(e) => setShowAllLogs(e.target.checked)} /> 전체 보기
                </label>
                {snap.logs?.truncated ? <span className="muted" style={{ fontSize: 11 }}>엣지에서 {snap.logs.omitted}줄이 상한으로 잘렸습니다</span> : null}
              </div>
              {/* 원문은 선택·복사 가능하게 <pre> 로(툴팁에만 두지 말 것 — v2.516 규약). */}
              <pre style={{ fontSize: 11, lineHeight: 1.5, maxHeight: 260, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {shown.length ? shown.map((e) => `${new Date(e.time).toLocaleTimeString('ko-KR')} [${e.level}] ${e.msg}`).join('\n')
                  : '이 조건에 맞는 로그 줄이 없습니다(콘솔 링버퍼는 상한이 있고 재시작하면 비워집니다 — 아무 일도 없었다는 뜻은 아닙니다).'}
              </pre>
              <div className="muted" style={{ fontSize: 10.5, marginTop: 4, lineHeight: 1.6 }}>
                로그의 비밀 값은 엣지에서 가린 뒤 보냅니다. 다만 자유 문자열이라 <b>완전하지는 않습니다</b> —
                외부에 공유하기 전에 직접 확인하세요.
              </div>
            </div>
          )}
        </div>

        {/* ④ 해결 방법 — 그 원인에 맞는 것만(틀린 조언은 무음 실패보다 나쁘다) */}
        <div className="card">
          <b style={{ fontSize: 12 }}>해결 방법</b>
          <ol style={{ fontSize: 12, lineHeight: 1.8, margin: '4px 0 0', paddingLeft: 18 }}>
            {(CAUSE_FIX[d.kind] || CAUSE_FIX.unknown).map((f, i) => <li key={i}>{f}</li>)}
          </ol>
        </div>
      </div>
    </div>
  );
}
