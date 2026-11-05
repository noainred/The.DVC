/**
 * Bareos 재해 복구 2차 — 복구 순서(시안 ② Disaster2 '3. 복구 순서' · 사용자 결정 '두 번에 나눠').
 *   DrRunBuilder: 단계(이름 · 동시 복원 수 · 켜 보기) 만들기 → 계획 확인(POST dr/runs/check — 묶음 복원과 같은 판정) → 법인 확인 + 본인 OTP → 시작(POST dr/runs).
 *   DrRunCard: 이 법인의 회차 진행(GET dr/runs — 포탈 파일만 읽는 가벼운 조회 · 진행 중일 때만 15초마다) · 멈추기 · 계속(본인 OTP).
 *   보내기 · 단계 넘기기 · 끝맺음 대기는 서버 실행기(bareos/drRunner.js)가 한다 — 화면을 닫아도 계속 돈다.
 */
import React, { useState } from 'react';
import { postJson } from '../../api.js';
import { requireChanged } from '../changeResult.js';
import { ErrorBox } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { Note } from './BareosBits.jsx';
import { whenText } from './bareosText.js';
import { DR_CHUNK, DR_WAVES_MAX, DR_RUN_STATE, DR_ITEM_STATE, drNewWave, drWaveOf, drRemoveWave, drWaveLabel, drWaveCountsText, drRunActive } from './bareosDrText.js';

const BASE = '/tools/bareos-backup';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const FIELD = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', info: '#93c5fd', muted: 'var(--text-muted, #94a3b8)' };
const CHIP = { padding: '2px 8px', borderRadius: 999, border: '1px solid var(--border-soft)', fontSize: 11.5, overflowWrap: 'anywhere' };

/**
 * 동작 오류 — 틀린 OTP(403)는 문구로(ErrorBox 는 403 을 '권한이 없습니다' 화면으로 그린다 · 버그 점검 B5-03), 상태 파일 못 읽음(503 state-unreadable)도 사유 그대로(B5-06).
 *   그 밖(진짜 권한 403 · 5xx)은 ErrorBox 의 안내를 그대로 쓴다.
 */
export function DrActErr({ error }) {
  if (!error) return null;
  const code = error?.body?.code || '';
  if ((error.status === 403 && /OTP/.test(String(error.message || ''))) || code === 'state-unreadable' || code === 'registry-unreadable' || error.changeRejected) {
    return <Note tone="bad">{String(error.message || error.body?.reason || '요청이 거부됐습니다')}</Note>;
  }
  return <ErrorBox error={error} />;
}

/** 단계 만들기 — waves · assign 은 부모 상태(표의 단계 칸과 함께 쓴다). rows 는 고른 행(why 없음). */
export function DrRunBuilder({ waves, setWaves, assign, setAssign, rows, shownPicked, disabled }) {
  const [moveTo, setMoveTo] = useState(0);
  const count = waves.length;
  const per = waves.map((_, i) => rows.filter((r) => drWaveOf(assign, r.id, count) === i));
  const setW = (i, patch) => setWaves((ws) => ws.map((w, k) => (k === i ? { ...w, ...patch } : w)));
  const add = () => setWaves((ws) => (ws.length >= DR_WAVES_MAX ? ws : [...ws, drNewWave(ws.length, 10)]));
  const remove = (i) => { const r = drRemoveWave(waves, assign, i); setWaves(r.waves); setAssign(r.assign); setMoveTo(0); };
  const move = () => setAssign((a) => { const o = { ...a }; for (const r of shownPicked) o[r.id] = Math.min(Number(moveTo) || 0, count - 1); return o; });
  return (
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }} data-dr-waves="">
      <div style={ROW}>
        <b style={{ fontSize: 13.5 }}>4. 복구 순서</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0 }}>앞 단계가 모두 끝나야(네트워크 끊기 · 켜 보기까지) 다음 단계를 보냅니다 · 단계마다 동시에 복원할 대수</span>
        <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }} disabled={disabled || count >= DR_WAVES_MAX} onClick={add}>단계 추가</button>
      </div>
      <div style={{ ...ROW, fontSize: 12 }}>
        <span className="muted">위 표에서 찾은 것 중 고른 <b>{shownPicked.length}</b>대를</span>
        <Select sort={false} className="input" style={{ minWidth: 0, maxWidth: 200 }} value={String(Math.min(Number(moveTo) || 0, count - 1))} onChange={(e) => setMoveTo(Number(e.target.value))} aria-label="옮길 단계" disabled={disabled}>
          {waves.map((w, i) => <option key={i} value={String(i)}>{drWaveLabel(w, i)}</option>)}
        </Select>
        <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12 }} disabled={disabled || !shownPicked.length} onClick={move}>로 옮기기</button>
        <span className="muted">(VM 마다 표의 단계 칸에서도 바꿀 수 있습니다)</span>
      </div>
      {waves.map((w, i) => {
        const list = per[i];
        return (
          <div key={i} data-dr-wave={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 10, minWidth: 0 }}>
            <div style={ROW}>
              <b style={{ fontSize: 12.5 }}>{i + 1}단계</b>
              <input className="input" style={{ minWidth: 0, width: 150 }} value={w.name} maxLength={40} onChange={(e) => setW(i, { name: e.target.value })} aria-label={`${i + 1}단계 이름`} disabled={disabled} />
              <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}>동시
                <input className="input" type="number" min={1} max={DR_CHUNK} style={{ minWidth: 0, width: 70 }} value={w.concurrency} onChange={(e) => setW(i, { concurrency: e.target.value === '' ? '' : Math.floor(Number(e.target.value)) })} aria-label={`${i + 1}단계 동시 복원 수`} disabled={disabled} />대
              </label>
              <span className="muted" style={{ fontSize: 12 }}>{list.length}대</span>
              <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }} disabled={disabled || count <= 1} onClick={() => remove(i)}>단계 지우기</button>
            </div>
            <div style={{ ...ROW, gap: 6 }}>
              {list.slice(0, 8).map((r) => <span key={r.id} style={CHIP}>{r.at.vmName}</span>)}
              {list.length > 8 && <span className="muted" style={{ fontSize: 12 }}>+{list.length - 8}대</span>}
              {!list.length && <span style={{ fontSize: 12, color: TONE.warn }}>VM 이 없습니다 — 옮기거나 단계를 지우세요</span>}
            </div>
            <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, minWidth: 0 }}>
              <input type="checkbox" checked={w.verify === true} onChange={(e) => setW(i, { verify: e.target.checked })} disabled={disabled} style={{ flex: 'none', marginTop: 2 }} />
              <span style={{ minWidth: 0 }}>복원 뒤 켜 보기(네트워크는 끊긴 채 켜서 VMware Tools 응답을 확인하고 끕니다 · 지우지 않습니다)</span>
            </label>
          </div>
        );
      })}
    </section>
  );
}

/** 회차 진행 카드. */
export function DrRunCard({ run, err, onRefresh, onChanged }) {
  const [stopAsk, setStopAsk] = useState(false);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState(null);
  const [warn, setWarn] = useState('');
  if (!run && !err) return null;
  if (!run) return <section className="card" style={{ padding: 12 }} data-dr-run=""><DrActErr error={err} /></section>;
  const [label, tone] = DR_RUN_STATE[run.state] || [run.state, 'muted'];
  const active = drRunActive(run);
  const act = async (path, body) => {
    setBusy(true); setActErr(null); setWarn('');
    // 409(멈춤 아님 · 엣지 노드 · 전제)는 postJson 이 던지지 않고 본문을 돌려준다 — requireChanged 로 오류로 바꾼다(버그 점검 B5-01)
    try { const r = requireChanged(await postJson(`${BASE}/dr/runs/${encodeURIComponent(run.id)}/${path}`, body)); if (r?.warning) setWarn(String(r.warning)); setStopAsk(false); onChanged?.(); } catch (e) { setActErr(e); onRefresh?.(); } finally { setBusy(false); setOtp(''); }
  };
  const bad = [];
  run.waves.forEach((w, wi) => { for (const it of w.items || []) if (it.state === 'failed' || it.state === 'unknown') bad.push({ ...it, wave: wi }); });
  const cur = run.waves[run.cur] || null;
  const going = (cur?.items || []).filter((it) => it.state === 'sent' || it.state === 'sending');
  return (
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, borderColor: run.state === 'paused' ? '#92400e' : undefined }} data-dr-run="">
      <div style={ROW}>
        <b style={{ fontSize: 13.5 }}>복구 순서 진행</b>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: TONE[tone] }}>{label}</span>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>시작 {whenText(run.at)} · {run.by || '—'}{run.before ? ` · 기준 시각 ${String(run.before).replace('T', ' ')} 이전` : ''}</span>
        <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }} onClick={onRefresh} disabled={busy}>새로 고침</button>
      </div>
      {run.reason && <Note tone={run.state === 'paused' ? 'warn' : 'info'}>{run.reason}</Note>}
      {warn && <Note tone="warn">{warn}</Note>}
      {err && <DrActErr error={err} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {run.waves.map((w, i) => {
          // 멈춘 회차의 지금 단계는 ▶(진행)가 아니라 ■ — 남은 VM 은 '대기' 가 아니라 '보내지 않음'(버그 점검 B5-12)
          const mk = i < run.cur || run.state === 'done' ? '✓' : i === run.cur ? (run.state === 'stopped' ? '■' : '▶') : '·';
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', gap: 8, alignItems: 'start', fontSize: 12.5 }}>
              <span style={{ textAlign: 'center', fontWeight: 800, color: i === run.cur && active ? TONE.info : undefined }}>{mk}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><b>{i + 1}. {w.name}</b> <span className="muted">· 동시 {w.concurrency}대{w.verify ? ' · 켜 보기' : ''}</span> — {drWaveCountsText(w, run.state)}</span>
            </div>
          );
        })}
      </div>
      {going.length > 0 && (
        <div style={{ ...ROW, gap: 6, fontSize: 12 }}>
          <span className="muted">지금 복원 중:</span>
          {going.slice(0, 12).map((it) => <span key={it.id} style={CHIP}>{it.name || it.vmName}{it.rid ? ` · jobid ${it.rid}` : ''}</span>)}
          {going.length > 12 && <span className="muted">+{going.length - 12}대</span>}
        </div>
      )}
      {bad.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 22, fontSize: 12, lineHeight: 1.6 }}>
          {bad.slice(0, 50).map((it) => <li key={`${it.wave}-${it.id}`} style={{ overflowWrap: 'anywhere', color: TONE[DR_ITEM_STATE[it.state]?.[1] || 'bad'] }}><b>{it.wave + 1}단계 · {it.name || it.vmName}</b> — {DR_ITEM_STATE[it.state]?.[0]} · {it.reason || '사유 미상'}</li>)}
          {bad.length > 50 && <li className="muted">외 {bad.length - 50}대</li>}
        </ul>
      )}
      {actErr && <DrActErr error={actErr} />}
      {active && run.writable === false && <span className="muted" style={{ fontSize: 12 }}>이 법인은 쓰기 권한이 없어 멈추기 · 계속을 할 수 없습니다.</span>}
      {active && run.writable !== false && (
        <div style={ROW}>
          {run.state === 'paused' && (
            <>
              <label className="muted" style={{ ...FIELD, width: 160 }}>본인 OTP(6자리)
                <input className="input" style={{ minWidth: 0, width: '100%' }} inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="복구 순서 계속 OTP" />
              </label>
              <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', alignSelf: 'flex-end' }} disabled={busy || !/^\d{6}$/.test(otp)} onClick={() => act('resume', { otp })}>확인했습니다 · 계속</button>
            </>
          )}
          <span style={{ flex: '1 1 auto' }} />
          {!stopAsk && <button type="button" className="logout-btn" style={{ padding: '6px 14px', alignSelf: 'flex-end' }} disabled={busy} onClick={() => setStopAsk(true)}>멈추기</button>}
          {stopAsk && (
            <span style={{ ...ROW, gap: 6, alignSelf: 'flex-end' }}>
              <span style={{ fontSize: 12, color: TONE.warn }}>남은 VM 은 보내지 않습니다(보낸 복원은 계속 돕니다) · 다시 이어 갈 수 없습니다</span>
              <button type="button" className="logout-btn" style={{ padding: '6px 14px' }} disabled={busy} onClick={() => act('stop', {})}>멈추기 확인</button>
              <button type="button" className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={busy} onClick={() => setStopAsk(false)}>취소</button>
            </span>
          )}
        </div>
      )}
    </section>
  );
}
