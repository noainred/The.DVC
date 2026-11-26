/**
 * 물리서버 원격 전원 조작 · 위치 LED 켜기/끄기 구역(v3.52 · 시안 docs/design/bm-feature-proposals ⑦ ⑥) — 드로어 안. **장비 상태를 바꾼다.**
 *  · 기본 꺼짐 — 켜기 스위치(/tools/bm-folders/power-state)가 꺼져 있으면 쓸 수 있는 계정에게만 한 줄 안내 · 조회 계정에는 구역 자체를 그리지 않는다.
 *    설정 파일을 못 읽었으면 ‘꺼짐’ 이라 단정하지 않고 그렇게 밝힌다 · 상태를 못 읽었으면 그 사실을 한 줄로(반증 B10 · B16).
 *  · 전원 단추는 전체 범위 관리자(canPower — 설계 ⑦)에게만. LED 는 운영자 이상 · **그 서버 법인의 쓰기 범위**(writable — 드로어가 넘긴다 · 미분류 서버는 전체 범위 관리자만 — 반증 B14).
 *  · 전원: 단추 → 같은 자리에 확인 칸(서버 이름 그대로 · 사유 · 본인 OTP) → 보내기. 강제 동작은 허용됐을 때만 · 빨간 단추 · 경고 문구. Esc 는 확인 칸만 닫는다(드로어를 닫지 않는다 — 반증 B18).
 *  · 요청은 다시 보내지 않는다(retries 0). 진행 중 잠금 · 마지막 결과는 **서버 열쇠마다 모듈에** 둔다 — ↑↓ 로 다른 서버에 갔다 와도 풀리거나 사라지지 않는다(반증 B8).
 *  · 응답을 못 받은 실패(연결 끊김 · 게이트웨이 · 시한)는 ‘닿았는지 모름’ 으로 쓰고 그 서버는 잠시 잠근다(반증 B5).
 *  · 훅은 조기 return 위에 둔다.
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import { POWER_NOTE, POWER_OFF_NOTE, FORCE_NOTE, powerButtons, confirmIssue, powerResultText, powerFailText, POWER_UNKNOWN_HOLD_MS } from './powerText.js';

const LED_BTNS = [['on', '켜기'], ['blink', '깜빡임'], ['off', '끄기']];
const WAIT = { timeoutMs: 75_000, retries: 0 };   // 엣지 당김 시한(45초) · 장비 시한(30초)보다 길게 · 다시 보내지 않는다
const _inflight = new Set();       // 서버 열쇠 — 보내는 중
const _results = new Map();        // 서버 열쇠 → 마지막 결과 { ok, text, at }
const _holdUntil = new Map();      // 서버 열쇠 → ‘모름’ 뒤 잠금 끝 시각
export function _resetPowerUiForTest() { _inflight.clear(); _results.clear(); _holdUntil.clear(); }

export default function PowerSection({ r, writable = false, initial = null, initialPick = null, initialForm = null }) {
  const isBm = r?.kind === 'bm';
  const key = r?.key || '';
  const [ps, setPs] = useState(initial);
  const [psErr, setPsErr] = useState('');
  const [pick, setPick] = useState(initialPick);   // 고른 전원 동작 { k, label, force }
  const [f, setF] = useState(initialForm || { confirm: '', reason: '', otp: '' });
  const [, bump] = useState(0);
  const busy = _inflight.has(key);
  const res = _results.get(key) || null;
  const held = (_holdUntil.get(key) || 0) > Date.now();
  useEffect(() => {
    if (!isBm || initial) return undefined;
    let on = true;
    fetchJson('/tools/bm-folders/power-state').then((d) => { if (on) setPs(d); }).catch((e) => { if (on) { setPs(null); setPsErr(opErrorText(e)); } });
    return () => { on = false; };
  }, [isBm, initial]);
  useEffect(() => {   // ‘모름’ 잠금이 풀리면 다시 그린다
    if (!held) return undefined;
    const t = setTimeout(() => bump((x) => x + 1), Math.max(0, (_holdUntil.get(key) || 0) - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [held, key]);
  if (!isBm) return null;
  if (psErr && !ps) return <section className="vmh-sec" aria-label="원격 전원 · 위치 LED"><div className="sh"><h3>원격 전원 · 위치 LED</h3></div><div className="muted bmd-note">원격 전원 · LED 상태를 읽지 못했습니다 — {psErr}</div></section>;
  if (!ps || ps.canUse !== true) return null;
  if (!ps.enabled) return <section className="vmh-sec" aria-label="원격 전원 · 위치 LED"><div className="sh"><h3>원격 전원 · 위치 LED</h3></div><div className="muted bmd-note">{ps.unreadable ? '원격 전원 설정 파일을 읽지 못해 꺼짐으로 봅니다(서비스 점검에서 확인).' : POWER_OFF_NOTE}</div></section>;
  const btns = powerButtons(ps);
  const ledOk = r.corp ? !!writable : ps.canPower === true;
  const issue = pick ? confirmIssue(f, r.name, ps.otpRequired === true) : '';
  const locked = busy || held;
  const closeConfirm = () => { setPick(null); setF({ confirm: '', reason: '', otp: '' }); };
  const escOnly = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent?.stopPropagation?.(); closeConfirm(); } };
  const send = async (kind, body, label) => {
    if (_inflight.has(key)) return;
    _inflight.add(key); _results.delete(key); bump((x) => x + 1);
    try {
      const d = await postJson(`/tools/bm-folders/${kind}`, { key, ...body }, WAIT);
      _results.set(key, { ...powerResultText(d, label), at: Date.now() });
      if (kind === 'power' && d?.ok) closeConfirm();
      else if (kind === 'power') setF((x) => ({ ...x, otp: '' }));   // OTP 는 한 번 쓰면 다시 받는다
      if (d?.status === 'timeout' || d?.status === 'edge-fail') _holdUntil.set(key, Date.now() + POWER_UNKNOWN_HOLD_MS);
    } catch (e) {
      const ft = powerFailText(e, label);
      _results.set(key, { ok: false, text: ft.text, at: Date.now() });
      if (ft.unknown) _holdUntil.set(key, Date.now() + POWER_UNKNOWN_HOLD_MS);
      if (kind === 'power') setF((x) => ({ ...x, otp: '' }));   // 틀린 OTP(403)도 비운다(반증 B11)
    } finally { _inflight.delete(key); bump((x) => x + 1); }
  };
  return (
    <section className="vmh-sec" aria-label="원격 전원 · 위치 LED">
      <div className="sh"><h3>원격 전원 · 위치 LED</h3></div>
      <div className="flex wrap gap bmd-pw-row" style={{ alignItems: 'center' }}>
        <span className="muted bmd-pw-lb">위치 LED</span>
        {ledOk ? LED_BTNS.map(([k, lb]) => <button key={k} type="button" className="logout-btn" disabled={locked} onClick={() => send('led', { state: k }, `위치 LED ${lb}`)}>{lb}</button>)
          : <span className="muted" style={{ fontSize: 12 }}>{r.corp ? '이 법인은 조회 전용이라 LED 를 바꿀 수 없습니다.' : '법인이 정해지지 않은 서버는 전체 범위 관리자만 다룹니다.'}</span>}
      </div>
      {ps.canPower === true ? (
        <div className="flex wrap gap bmd-pw-row" style={{ alignItems: 'center' }}>
          <span className="muted bmd-pw-lb">전원</span>
          {btns.map((b) => (
            <button key={b.k} type="button" className={`logout-btn${b.force ? ' bmd-pw-force' : ''}`} aria-pressed={pick?.k === b.k} disabled={locked}
              onClick={() => { setPick(pick?.k === b.k ? null : b); _results.delete(key); setF({ confirm: '', reason: '', otp: '' }); }}>{b.label}</button>
          ))}
        </div>
      ) : null}
      {pick && ps.canPower === true ? (
        <div className={`bmd-pw-confirm${pick.force ? ' force' : ''}`} role="group" aria-label={`${pick.label} 확인`} onKeyDown={escOnly}>
          <div className="bmd-pw-h"><b>{pick.label}</b> — {r.name}</div>
          {pick.force ? <div className="bmd-pw-warn">{FORCE_NOTE}</div> : null}
          <label className="muted bmd-pw-f">서버 이름을 그대로 입력<input className="input" value={f.confirm} maxLength={200} autoComplete="off" onChange={(e) => setF({ ...f, confirm: e.target.value })} aria-label="서버 이름 확인" /></label>
          <label className="muted bmd-pw-f">사유(감사 로그)<input className="input" value={f.reason} maxLength={200} onChange={(e) => setF({ ...f, reason: e.target.value })} aria-label="사유" /></label>
          {ps.otpRequired ? <label className="muted bmd-pw-f">본인 OTP(6자리)<input className="input" inputMode="numeric" autoComplete="one-time-code" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value.replace(/\D/g, '').slice(0, 6) })} aria-label="OTP" /></label> : null}
          <div className="flex wrap gap" style={{ alignItems: 'center' }}>
            <button type="button" className={`login-btn bmd-btn${pick.force ? ' bmd-pw-go-force' : ''}`} disabled={locked || !!issue}
              onClick={() => { if (!issue) send('power', { action: pick.k, confirm: f.confirm, reason: f.reason, otp: f.otp }, pick.label); }}>{busy ? '보내는 중…' : `${pick.label} 보내기`}</button>
            <button type="button" className="logout-btn" disabled={busy} onClick={closeConfirm}>취소</button>
            {issue ? <span className="muted" style={{ fontSize: 12, minWidth: 0 }}>{issue}</span> : null}
          </div>
        </div>
      ) : null}
      {res ? <div className={`bmd-note ${res.ok ? '' : 'bmd-pw-bad'}`} role={res.ok ? 'status' : 'alert'}>{res.text}</div> : null}
      {held ? <div className="muted bmd-note">결과를 모르는 요청 뒤라 이 서버의 단추를 잠시 잠갔습니다 — 상태를 확인하는 동안 같은 동작이 두 번 나가지 않게.</div> : null}
      <div className="muted bmd-note">{POWER_NOTE}</div>
    </section>
  );
}
