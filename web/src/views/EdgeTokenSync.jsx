/**
 * views/EdgeTokenSync.jsx — 설정 › 수집 서버 › **엣지 토큰 맞추기**(v2.825 — 사용자 요청 "토큰 맞추는 기능을 설정에 서브메뉴로 별도로 만들어줘").
 *   개별 토큰 자동 적용(v2.776)은 Veeam 백업 서버 화면 안에만 있었다. 등록된 엣지 전체의 개별 central 토큰 상태를 한 표로 보이고,
 *   공유 토큰 엣지마다 같은 자동 적용(EdgeTokenApply — 발급 → 엣지 전달 → 중앙 확인 → 배포 기록 맞춤)을 연다. 서버 API 는 그대로다.
 *  · 판정은 edgeTokenSyncText.js 하나(테스트 고정) · 토큰 목록을 못 읽으면 '모름'(없음으로 칠하지 않는다).
 *  · 상시 폴링 없음(마운트 1회 + 새로 읽기 + 작업이 끝나면 다시 읽기) · 늦게 온 이전 응답은 버린다(세대 번호).
 *  · 403(범위 제한 관리자 — 서버 fleetOnly)은 ErrorBox 가 권한 안내로. 실행은 설정 소유자만(서버 requireSettingsOwner).
 * ⚠ 훅은 조기 return 위에. 백틱 금지(BoldText).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import EdgeTokenApply from './EdgeTokenApply.jsx';
import { readFailText, fileUnreadableText } from './readFailText.js';
import { syncRows, syncSummary, orphanTokens, SYNC_STATE } from './edgeTokenSyncText.js';
import { JOB_STATE, dhms } from './edgeTokenApplyText.js';

const TONE = { ok: '#4ade80', bad: '#f87171', warn: 'var(--amber)', muted: 'var(--text-dim)' };
const when = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR') : '—');

export default function EdgeTokenSync() {
  const [cols, setCols] = useState(null);      // GET /admin/collectors
  const [colErr, setColErr] = useState(null);
  const [tok, setTok] = useState(null);        // GET /admin/central/agent-tokens
  const [tokErr, setTokErr] = useState(null);
  const [jobs, setJobs] = useState(null);      // GET /admin/central/token-apply/jobs
  const [jobsErr, setJobsErr] = useState(null);
  const [sel, setSel] = useState('');          // 자동 적용 칸을 연 엣지
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    const [c, t, j] = await Promise.allSettled([
      fetchJson('/admin/collectors'),
      fetchJson('/admin/central/agent-tokens'),
      fetchJson('/admin/central/token-apply/jobs'),
    ]);
    if (g !== gen.current) return; // 늦게 온 이전 응답
    if (c.status === 'fulfilled') { setCols(c.value); setColErr(null); } else setColErr(c.reason?.message || String(c.reason));
    if (t.status === 'fulfilled') { setTok(t.value); setTokErr(null); } else { setTok(null); setTokErr(t.reason?.message || String(t.reason)); }
    if (j.status === 'fulfilled') { setJobs(Array.isArray(j.value?.jobs) ? j.value.jobs : []); setJobsErr(null); } else { setJobs(null); setJobsErr(j.reason?.message || String(j.reason)); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); const g = gen; return () => { g.current++; }; }, [load]); // 떠난 뒤 온 응답은 버린다

  if (!cols && colErr) return <ErrorBox message={colErr} />;
  if (!cols) return <Loading />;

  // 토큰 목록을 못 읽었거나 파일이 손상됐으면 null — 행은 '모름'
  const tokens = tok && !tok.loadError && Array.isArray(tok.tokens) ? tok.tokens : null;
  const rows = syncRows(cols.collectors, tokens);
  const orphans = orphanTokens(cols.collectors, tokens);
  const selRow = rows.find((r) => r.agent === sel) || null;

  return (
    <div style={{ minWidth: 0 }}>
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🔑 엣지 토큰 맞추기</div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
          엣지(수집 서버)가 중앙에 접속할 때 쓰는 central 토큰을 엣지마다 따로 둔 <b>개별 토큰</b>으로 맞춥니다.
          공유 토큰 하나만 쓰면 엣지 1대가 침해될 때 다른 사이트의 자격증명까지 인출될 수 있고, Veeam 위임처럼 개별 토큰만 받는 기능은 403 이 됩니다.
          <br />공유 토큰 엣지의 <b>자동 적용</b>은 발급 → 엣지 전달(수집 토큰 통로, 안 되면 SSH) → 중앙 확인 → 배포 기록 맞춤을 한 번에 하고 단계마다 기록을 남깁니다.
          실패해도 공유 토큰은 그대로 받으므로 수집은 끊기지 않습니다. 실행은 설정 소유자만 할 수 있습니다.
        </div>
        <div className="flex gap wrap" style={{ marginTop: 8, alignItems: 'center' }}>
          <button className="tab" disabled={loading} onClick={load}>{loading ? '읽는 중…' : '새로 읽기'}</button>
          <button className="tab" onClick={() => { window.location.hash = '#/tools/portal-check'; }} title="특수 기능 › 포탈 점검 › 토큰 점검 — 중복·통신·저장값 일치를 점검합니다(고치지는 않습니다)">🔎 토큰 점검 열기</button>
          <button className="tab" onClick={() => { window.location.hash = '#/settings/collectors'; }} title="개별 토큰 수동 발급·재발급(회전)·회수는 수집 서버(원격) 화면에 있습니다">수집 서버(원격) 열기</button>
        </div>
      </div>

      {tok?.auth?.requireAgentToken && (
        <div className="banner warn" style={{ marginBottom: 10 }}>🔒 강화 모드(CENTRAL_REQUIRE_AGENT_TOKEN=true) — 중앙이 공유 토큰을 거부합니다. 공유 토큰 엣지는 지금 중앙에 접속하지 못합니다.</div>
      )}
      {cols.loadError && (
        <div className="banner warn" style={{ marginBottom: 10 }}>{fileUnreadableText(cols.loadError, '수집 서버 등록부(collectors.json)', { notMeaning: '등록된 엣지가 없다는 뜻이 아닙니다' })}</div>
      )}
      {colErr && <div className="banner warn" style={{ marginBottom: 10 }}>{readFailText('수집 서버 목록', colErr, { stale: true })}</div>}
      {tokErr && <div className="banner warn" style={{ marginBottom: 10 }}>{readFailText('개별 토큰 발급 현황', tokErr, { notMeaning: '발급된 토큰이 없다는 뜻이 아닙니다 — 표의 상태는 모름입니다' })}</div>}
      {tok?.loadError && (
        <div className="banner warn" style={{ marginBottom: 10 }}>{fileUnreadableText(tok.loadError, '엣지 개별 토큰 파일(central-agent-tokens.json)', { notMeaning: '발급된 토큰이 없다는 뜻이 아니며, 그동안 개별 토큰 엣지의 요청은 503 으로 답합니다' })}</div>
      )}

      <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 6px' }}>{syncSummary(rows)}</div>
      {rows.length > 0 && (
        // 좁은 화면(400px)은 가로 스크롤 — 판단에 필요한 엣지·상태·작업을 앞에 둔다(Chromium 400 판독: 주소가 앞이면 상태·버튼이 화면 밖이었다)
        <STable minWidth={760}>
          <thead><tr><th>엣지</th><th>상태</th><th data-nosort="">작업</th><th>발급</th><th>마지막 사용</th><th>수집 서버 주소</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = SYNC_STATE[r.state];
              return (
                <tr key={r.agent || r.url}>
                  <td><b>{r.agent || '—'}</b></td>
                  <td className="nowrap" data-sort={r.state} title={r.hint || undefined}><span style={{ color: TONE[st.tone], fontWeight: 600 }}>{st.text}</span></td>
                  <td className="nowrap">
                    {r.canApply
                      ? <button className="tab" onClick={() => setSel(sel === r.agent ? '' : r.agent)}>{sel === r.agent ? '닫기' : '자동 적용'}</button>
                      : <span className="muted" style={{ fontSize: 12 }} title={r.hint || undefined}>—</span>}
                  </td>
                  <td className="muted" data-sort={r.createdAt ?? ''}>{when(r.createdAt)}</td>
                  <td className="muted" data-sort={r.lastUsedAt ?? ''} title="중앙이 그 토큰을 본 마지막 시각(이름 검사 전 기록 — 받아들였다는 증거는 아닙니다)">{when(r.lastUsedAt)}</td>
                  <td className="muted" style={{ overflowWrap: 'anywhere' }}>{r.url || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
      {rows.some((r) => r.state === 'unused') && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>‘사용 기록 없음’(개별 토큰 발급됨): {rows.find((r) => r.state === 'unused').hint}</div>
      )}
      {orphans.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>등록부에 없는 엣지의 개별 토큰 {orphans.length}건: {orphans.join(', ')} — 지운 수집 서버의 토큰이면 수집 서버(원격) 화면에서 회수하세요.</div>
      )}

      {selRow && (
        <div className="card" style={{ padding: '10px 14px', marginTop: 12, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>엣지 ‘{selRow.agent}’ 개별 토큰 자동 적용</div>
          <EdgeTokenApply key={selRow.agent} agent={selRow.agent} canRun={selRow.canApply} onDone={load} />
        </div>
      )}

      <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 0 6px' }}>자동 적용 작업 기록 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(서버 저장 최근분 — 토큰 값 없음, 지문만)</span></div>
      {jobsErr && <div className="banner warn" style={{ marginBottom: 8 }}>{readFailText('자동 적용 작업 기록', jobsErr, { notMeaning: '작업이 없었다는 뜻이 아닙니다' })}</div>}
      {jobs && jobs.length === 0 && <div className="muted" style={{ fontSize: 12 }}>아직 자동 적용 작업이 없습니다.</div>}
      {jobs && jobs.length > 0 && (
        <STable minWidth={760} limit={20}>
          <thead><tr><th>시작</th><th>엣지</th><th>결과</th><th>통로</th><th>실행자</th><th>요약</th></tr></thead>
          <tbody>
            {jobs.map((j) => {
              const st = JOB_STATE[j.state];
              return (
                <tr key={j.id}>
                  <td className="nowrap" data-sort={j.startedAt ?? ''}>{dhms(j.startedAt) || '—'}</td>
                  <td><b>{j.agent || '—'}</b></td>
                  <td style={{ color: TONE[st?.tone] || 'inherit', fontWeight: 600 }}>{st?.text || j.state || '—'}</td>
                  <td className="muted">{j.path === 'ssh' ? 'SSH' : j.path === 'edge-api' ? '수집 토큰' : '—'}</td>
                  <td className="muted">{j.by || '—'}</td>
                  <td style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{j.summary || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
    </div>
  );
}
