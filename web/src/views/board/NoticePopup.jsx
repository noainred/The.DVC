/**
 * NoticePopup — 로그인(접속) 뒤 한 번 공지를 띄운다(v2.722).
 * 로그인 전 화면에는 띄우지 않는다(무인증 면을 늘리지 않는다 — v2.565). 폴링하지 않는다(마운트 1회).
 * 조회가 실패하면 조용히 띄우지 않는다 — 공지는 게시판 › 공지 탭에서도 볼 수 있다.
 */
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import { readHides, writeHides, withHidden, visibleNotices, LEVEL_TEXT, LEVEL_TONE, timeText, windowText } from './bulletinText.js';

const store = () => { try { return window.localStorage; } catch { return null; } };

export default function NoticePopup({ username = '' }) {
  const [notices, setNotices] = useState(null);
  const [shown, setShown] = useState([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchJson('/notices/active', {}, undefined, { retries: 1 })
      .then((r) => {
        if (!alive) return;
        const list = Array.isArray(r?.notices) ? r.notices : [];
        setNotices(list);
        setShown(visibleNotices(list, readHides(store())));
        setIdx(0);
      })
      .catch(() => { if (alive) setNotices([]); });
    return () => { alive = false; };
  }, [username]);

  if (!notices || !shown.length) return null;
  const n = shown[Math.min(idx, shown.length - 1)];
  const close = () => setShown([]);
  const hide = (how, all = false) => {
    const revs = all ? shown.map((x) => x.rev) : [n.rev];
    writeHides(store(), withHidden(readHides(store()), revs, how, notices.map((x) => x.rev)));
    const rest = shown.filter((x) => !revs.includes(x.rev));
    setShown(rest);
    setIdx((i) => Math.min(i, Math.max(0, rest.length - 1)));
  };
  const tone = LEVEL_TONE[n.level] || LEVEL_TONE.info;

  return (
    <div className="modal-overlay notice-popup-overlay" role="dialog" aria-modal="true" aria-label="공지사항">
      <EscClose onClose={close} />
      <div className="modal card notice-popup" style={{ borderTop: `4px solid ${tone}` }}>
        <div className="flex between" style={{ gap: 8, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              <span className="notice-level" style={{ color: tone, borderColor: tone }}>{LEVEL_TEXT[n.level] || '안내'}</span>
              {' '}공지사항{shown.length > 1 ? ` · ${idx + 1}/${shown.length}` : ''}
            </div>
            <b className="notice-title">{n.title}</b>
          </div>
          <button className="logout-btn" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} onClick={close} aria-label="닫기">닫기</button>
        </div>
        {n.body ? <div className="notice-body">{n.body}</div> : null}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          게시 {timeText(n.updatedAt)}{n.by ? ` · ${n.by}` : ''} · 노출 {windowText(n)}
        </div>
        <div className="notice-actions">
          {shown.length > 1 && (
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>이전</button>
              <button className="btn btn-sm" disabled={idx >= shown.length - 1} onClick={() => setIdx((i) => i + 1)}>다음</button>
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => hide('today')}>오늘 하루 보지 않기</button>
          <button className="btn btn-sm" onClick={() => hide('forever')}>다시 보지 않기</button>
          <button className="btn btn-sm primary" onClick={close}>확인</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          ‘보지 않기’ 는 이 브라우저에만 저장됩니다. 공지 내용이 바뀌면 다시 보입니다. 지난 공지는 상단 ‘게시판’ › 공지에서 볼 수 있습니다.
        </div>
      </div>
    </div>
  );
}
