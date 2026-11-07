/**
 * 리눅스 성능 6단계 — **공유 링크 복사 · 캡처 PNG** 버튼(설계 PROFILES §16 B). 링크는 권한을 주지 않는다(bmShare.SHARE_HONEST) ·
 * 캡처는 브라우저가 만든다(bmCapture — 새 의존성 없음) · 결과 · 실패는 버튼 옆 한 줄로 말한다.
 */
import React, { useState } from 'react';
import { getCurrentUser } from '../../api.js';
import { toneVar } from './toneVar.js';
import { shareUrlOf, SHARE_HONEST, captureFooter } from './bmShare.js';
import { captureNodePng, downloadBlob, captureName } from './bmCapture.js';

/**
 * @param {{state:()=>object, node:()=>HTMLElement|null, context:()=>object, kind:string}} p
 *   state — 공유 상태(bmShare.shareHashOf 입력) · node — 캡처할 조각 · context — 각주 재료(servers · corps · from · to · cursor · source)
 */
export default function BmShareButtons({ state, node, context, kind = 'view' }) {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  async function copy() {
    const url = shareUrlOf(state());
    try { await navigator.clipboard.writeText(url); setMsg({ tone: 'ok', text: '링크를 복사했습니다 — 여는 사람의 권한으로 보입니다.', url }); }
    catch { setMsg({ tone: 'warn', text: '클립보드에 쓰지 못했습니다 — 아래 링크를 직접 복사하세요.', url }); }
  }
  async function capture() {
    setBusy(true); setMsg(null);
    try {
      const u = getCurrentUser();
      const footer = captureFooter({ ...context(), by: u?.username || u?.name || '', at: Date.now() });
      const blob = await captureNodePng(node(), { footer });
      downloadBlob(blob, captureName(kind));
      setMsg({ tone: 'ok', text: `캡처했습니다(PNG · 2배 · 각주에 서버 · 기간 · 생성자). 크기 ${Math.round(blob.size / 1024)}KB.` });
    } catch (e) { setMsg({ tone: 'bad', text: `캡처하지 못했습니다: ${e?.message || e}` }); }
    finally { setBusy(false); }
  }
  // data-export-hide — 캡처 코어(reportExport)가 그림에서 빼는 표지: 버튼 자신(‘캡처하는 중…’)이 결과에 찍히지 않게(Chromium 판독 r2).
  return (
    <>
      <button type="button" className="btn btn-sm bmp-touch" onClick={copy} title={SHARE_HONEST} data-export-hide="1">링크 복사</button>
      <button type="button" className="btn btn-sm bmp-touch" disabled={busy} onClick={capture} data-export-hide="1">{busy ? '캡처하는 중…' : '캡처 PNG'}</button>
      {msg && (
        <span className="bmo-note" data-export-hide="1" style={{ margin: 0, color: toneVar(msg.tone), flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere' }}>
          {msg.text}{msg.url && msg.tone !== 'ok' ? <input className="input" readOnly value={msg.url} onFocus={(e) => e.target.select()} style={{ width: '100%' }} aria-label="공유 링크" /> : null}
        </span>
      )}
    </>
  );
}
