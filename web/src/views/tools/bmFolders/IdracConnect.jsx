/**
 * 물리서버 폴더 — iDRAC 주소 접속(v3.3.0 · 사용자 요청 'iDRAC IP 클릭하면 SSH/웹 선택해서 접속').
 * 주소를 누르면 작은 상자에서 고른다:
 *   · 웹 — https://<주소>/ 새 탭(내 PC 브라우저가 iDRAC 망에 닿아야 한다)
 *   · SSH(포탈 웹 터미널) — 기존 원격 접속(중계 프록시 경유 · 'remote.access' 권한 · 대상 범위는 서버가 판정)
 *   · SSH(내 PC 프로그램) — ssh://계정@주소 링크(내 PC 에 등록된 SSH 프로그램) · 명령 복사
 * 주소는 서버가 관리자 판본에만 싣는다(addr) — 이 컴포넌트는 받은 주소만 쓴다. 표의 행을 누르면 옆 패널이 열리므로 이 칸 안의 클릭은 여기서 멈춘다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { can } from '../../../api.js';
import { VmRemoteButton } from '../../../components/VmRemote.jsx';
import { idracLinks, SSH_USER_KEY } from './hwText.js';

const readUser = () => { try { return localStorage.getItem(SSH_USER_KEY) || 'root'; } catch { return 'root'; } };
const saveUser = (v) => { try { localStorage.setItem(SSH_USER_KEY, v); } catch { /* 저장 못 해도 이번 화면에서는 쓴다 */ } };
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* 아래 대체 */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
  } catch { return false; }
}

export function IdracConnect({ addr, name, corp, small = false }) {
  const [pos, setPos] = useState(null);
  const [user, setUser] = useState(readUser);
  const [note, setNote] = useState('');
  const [remote, setRemote] = useState(false);   // 포탈 웹 SSH 창 — 고른 뒤에만 그린다(그리는 순간 도달성 점검이 나간다)
  const ref = useRef(null); const btn = useRef(null);
  const open = !!pos;
  const links = idracLinks(addr, user);
  useEffect(() => {
    if (!open) return undefined;
    // Esc 는 이 상자만 닫는다 — 캡처 단계에서 받고 전파를 멈춰 옆 패널(EscClose)까지 닫지 않게(WhyTip 과 같은 처리)
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setPos(null); btn.current?.focus?.(); } };
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) setPos(null); };
    const away = () => setPos(null);
    document.addEventListener('keydown', key, true); document.addEventListener('mousedown', click);
    window.addEventListener('scroll', away, true); window.addEventListener('resize', away);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', click); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away); };
  }, [open]);
  if (!addr) return null;
  if (!links) return <span className="mono muted" style={{ fontSize: small ? 11 : 12 }} title="접속 주소 형식이 아닙니다">{addr}</span>;
  const toggle = () => {
    if (open) { setPos(null); return; }
    setNote('');
    const r = btn.current?.getBoundingClientRect?.();
    const vw = window.innerWidth || 1024; const vh = window.innerHeight || 768;
    const w = Math.min(320, vw - 16); const h = 270;
    if (!r) { setPos({ left: 8, top: 8, width: w }); return; }
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const top = r.bottom + 4 + h > vh ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    setPos({ left, top, width: w });
  };
  const canRemote = can('remote.access');
  const copy = async (text, what) => setNote((await copyText(text)) ? `${what} 복사했습니다.` : `${what} 복사하지 못했습니다 — 직접 선택해 복사하십시오: ${text}`);
  return (
    <span className="bmf-idc" ref={ref} onClick={(e) => e.stopPropagation()} role="presentation">
      <button ref={btn} type="button" className={`bmf-idc-b mono${small ? ' sm' : ''}`} aria-expanded={open} aria-haspopup="dialog"
        title="iDRAC 접속 — 웹 · SSH 고르기" onClick={(e) => { e.stopPropagation(); toggle(); }}>{addr}</button>
      {open ? (
        <span className="bmf-idc-pop" role="dialog" aria-label={`iDRAC 접속 — ${addr}`} style={{ left: pos.left, top: pos.top, width: pos.width }}>
          <b>iDRAC 접속 <span className="mono" style={{ fontWeight: 400 }}>{addr}</span></b>
          <a className="bmf-idc-i" href={links.web} target="_blank" rel="noopener noreferrer" onClick={() => setPos(null)}>
            <span>웹 콘솔 열기</span><span className="muted mono">{links.web}</span>
          </a>
          <button type="button" className="bmf-idc-i" disabled={canRemote === false} onClick={() => { setPos(null); setRemote(true); }}
            title={canRemote === false ? '원격 접속 권한(remote.access)이 없습니다' : '포탈의 원격 접속(중계 프록시 경유 브라우저 SSH 터미널)'}>
            <span>SSH — 포탈 웹 터미널</span><span className="muted">{canRemote === false ? '권한 없음' : '중계 프록시 경유'}</span>
          </button>
          <a className="bmf-idc-i" href={links.ssh} onClick={() => setPos(null)}>
            <span>SSH — 내 PC 프로그램</span><span className="muted mono">{links.ssh}</span>
          </a>
          <span className="bmf-idc-row">
            <label className="muted" htmlFor={`idc-u-${addr}`}>계정</label>
            <input id={`idc-u-${addr}`} className="input" value={user} maxLength={32} spellCheck={false} autoComplete="off"
              onChange={(e) => { const v = e.target.value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32); setUser(v); saveUser(v || 'root'); }} />
            <button type="button" className="logout-btn" onClick={() => copy(links.cmd, '명령을')}>명령 복사</button>
            <button type="button" className="logout-btn" onClick={() => copy(addr, '주소를')}>주소 복사</button>
          </span>
          {note ? <span className="muted" role="status">{note}</span> : null}
          <span className="muted bmf-idc-n">웹 · 내 PC SSH 는 이 PC 가 iDRAC 망에 닿아야 합니다. Windows 는 ssh:// 를 여는 프로그램이 없으면 ‘명령 복사’ 를 쓰십시오.</span>
        </span>
      ) : null}
      {/* 웹 SSH 창은 body 에 그린다(표 래퍼 · 옆 패널 안에서 잘리거나 위치가 틀어지지 않게) — React 이벤트는 이 칸으로 올라와 행 클릭을 막는다 */}
      {remote ? createPortal(
        <VmRemoteButton item={{ name: `${name || addr} (iDRAC)`, ipAddresses: [links.sshHost], vcenterId: corp || '', guestOS: '' }} startOpen hideButton onClose={() => setRemote(false)} />,
        document.body,
      ) : null}
    </span>
  );
}
