import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  UPGRADE_TITLE, UPGRADE_SUB, CHANGES_HEAD, summarize, loadSince, loadedVersion, serverVersion, subscribeUpgrade, isStale, noticeShown, markNoticeShown,
} from '../upgradeNotice.js';

/**
 * components/UpgradeNotice.jsx — '프로그램이 업그레이드되었으니 새로고침 하세요' 상자(v2.999 · 설계 docs/design/upgrade-reload ①③).
 * 오류 경계(ErrorBoundary)가 '이 창의 판 ≠ 서버의 판' 이거나 화면 조각을 못 받은 오류일 때 그린다.
 * ⚠ 주 번들에 둔다(lazy 금지) — 옛 판 창은 새 서버에서 옛 청크를 못 받는다. 판정 · 문구는 upgradeNotice.js 하나.
 */

// 서버 렌더(테스트의 renderToStaticMarkup)에서는 useLayoutEffect 가 경고만 내므로 useEffect 로 대신한다.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const snap = () => `${loadedVersion() || ''}|${serverVersion() || ''}|${noticeShown() ? 1 : 0}`;

/** 이 창의 판 · 서버의 판 · 다른가 · 안내 상자가 떠 있는가(구독 — App 폴링이 서버 판을 넣거나 상자가 뜨고 지면 다시 그린다). */
export function useUpgradeVersions() {
  const key = useSyncExternalStore(subscribeUpgrade, snap, snap);
  const [loaded, server, shown] = key.split('|');
  return { loaded: loaded || null, server: server || null, stale: isStale(loaded, server), noticeOpen: shown === '1' };
}

/** 이 창의 판보다 새 판들의 릴리스 노트(한 번만 부른다 · 못 읽으면 null). from/to 가 없으면 부르지 않는다. */
export function useSinceNotes(from, to) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    if (!from || !to) return () => { alive = false; };
    loadSince(from, to).then((v) => { if (alive) setData(v); });
    return () => { alive = false; };
  }, [from, to]);
  return data;
}

const RefreshIcon = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
  </svg>
);
export { RefreshIcon };

/**
 * 바뀐 것 — 접힘: 새 판부터 앞 3줄(줄마다 한 줄 말줄임) + More · 펼침: 판별(버전 칩 + 제목) 전체 문장 · 상자 안 스크롤 + 접기.
 * More 는 줄이 3줄을 넘거나 보이는 줄이 잘렸을 때 보인다(잘린 문장을 끝까지 읽을 길). 자료가 없으면 아무것도 그리지 않는다(지어내지 않는다).
 */
export function UpgradeChanges({ data, open = false, onToggle }) {
  const s = summarize(data);
  const listRef = useRef(null);
  const [clipped, setClipped] = useState(false);
  useIsoLayoutEffect(() => {
    if (open) return;
    const ul = listRef.current;
    if (!ul) return;
    const c = [...ul.children].some((li) => li.scrollWidth > li.clientWidth + 1);
    if (c !== clipped) setClipped(c);
  });
  if (!s.total) return null;
  const showMore = s.more > 0 || clipped;
  return (
    <div className="upg-chg">
      <div className="upg-chg-h">
        <span>{CHANGES_HEAD}</span>
        <span className="upg-chg-n">{s.versions}개 판 · {s.total}줄{data?.truncated ? ` · 오래된 판 ${data.truncated}개 생략` : ''}</span>
      </div>
      {!open ? (
        <>
          <ul className="upg-list clamp" ref={listRef}>
            {s.head.map((x, i) => <li key={`${x.version}-${i}`} title={x.text}>{x.text}</li>)}
          </ul>
          {showMore && (
            <button type="button" className="upg-more" aria-expanded="false" onClick={onToggle}>
              More{s.more > 0 ? <span className="n">· {s.more}줄 더</span> : null}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="upg-scroll">
            {data.notes.filter((g) => g.lines.length).map((g) => (
              <section key={g.version}>
                <div className="upg-ver"><span className="upg-chip">v{g.version}</span>{g.title ? <span className="t" title={g.title}>{g.title}</span> : null}</div>
                <ul className="upg-list">{g.lines.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </section>
            ))}
          </div>
          <button type="button" className="upg-more" aria-expanded="true" onClick={onToggle}>접기</button>
        </>
      )}
    </div>
  );
}

/** 오류 경계가 그리는 상자. versions 를 주면 그 값(테스트 · 고정), 없으면 저장소 값. */
export default function UpgradeNotice({ versions = null, notes = undefined }) {
  const live = useUpgradeVersions();
  const v = versions || live;
  const fetched = useSinceNotes(notes === undefined && v.stale ? v.loaded : null, notes === undefined && v.stale ? v.server : null);
  const data = notes === undefined ? fetched : notes;
  const [open, setOpen] = useState(false);
  useEffect(() => markNoticeShown(), []);   // 떠 있는 동안 App 은 같은 말을 하는 알림을 숨긴다(배지는 남는다)
  return (
    <div className="upg-box" role="alert">
      <span className="upg-ico"><RefreshIcon /></span>
      <div className="upg-title">{UPGRADE_TITLE}</div>
      <div className="upg-sub">{UPGRADE_SUB}</div>
      {v.stale && (
        <div className="upg-verline">
          <span>이 창</span><span className="upg-chip">v{v.loaded}</span>
          <span aria-hidden="true">→</span>
          <span>지금</span><span className="upg-chip new">v{v.server}</span>
        </div>
      )}
      <UpgradeChanges data={data} open={open} onToggle={() => setOpen((o) => !o)} />
      <button type="button" className="login-btn upg-reload" onClick={() => window.location.reload()}><RefreshIcon size={16} />새로고침</button>
    </div>
  );
}
