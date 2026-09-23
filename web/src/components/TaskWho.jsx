import React from 'react';
import { serverStateText } from '../perfClientLogic.js';

/**
 * '불러오는 중' 의 한 작업 줄 아래에 **누가 지연시키는가** 를 보인다(v2.583) — 사용자 요청:
 * "불러오는 중… 이라는 메시지 나올 때 누가 이 메시지의 지연을 발생시켰는지 ID 도 같이 보여줘."
 *
 *  · 실제 요청(메서드 + 식별자를 가린 경로) — '관리 설정 조회' 같은 묶음 이름이 무엇인지 드러낸다.
 *  · 요청 ID — 설정 › Log › 서버 성능 측정(느린 요청·hang)과 진단·로그의 라이브 로그 줄(`#ID`)에
 *    같은 값이 찍혀 눈으로 대조할 수 있다.
 *  · 서버 쪽 상태 — 서버가 아직 처리 중인지 / 이미 응답했는지 / 기록이 없는지. 지연의 주체가
 *    서버인지 전송·브라우저인지가 여기서 갈린다(문구·판정은 perfClientLogic.serverStateText 하나).
 * Loading 과 GlobalProgress 가 같이 쓴다(두 곳이 각자 그리면 문구가 갈라진다).
 */
const TONE_COLOR = { busy: 'var(--amber)', done: 'var(--green)', unknown: 'var(--red)', pending: undefined };

export default function TaskWho({ task }) {
  if (!task) return null;
  const st = serverStateText(task.server);
  const path = task.path ? `/api${task.path}` : '';
  return (
    <div style={{ fontSize: 11, marginTop: 1, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
      {(task.method || path) && (
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{task.method} {path}</span>
      )}
      {task.rid && (
        <span title="이 ID 로 설정 › Log › 서버 성능 측정(느린 요청)과 진단·로그의 라이브 로그에서 같은 요청을 찾을 수 있습니다.">
          {' · 요청 ID '}
          <b style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', userSelect: 'all' }}>{task.rid}</b>
        </span>
      )}
      <div style={{ color: TONE_COLOR[st.tone] }}>{st.text}</div>
    </div>
  );
}
