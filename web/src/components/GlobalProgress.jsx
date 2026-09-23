import React, { useEffect, useState } from 'react';
import { inflightSnapshot, subscribeInflight, detailThresholdMs } from '../perfClient.js';
import { normPath } from '../perfClientLogic.js';
import { visibleProgress, secText } from './taskLabel.js';
import { pollLoadingServerStatus } from '../api.js';
import TaskWho from './TaskWho.jsx';

/**
 * 전역 진행 표시(v2.501) — 사용자 요구: "대기가 3초 이상이면 구체적으로 어떤 작업을 하는지
 * 진행상태를 보여줄 것."
 *
 * `<Loading/>` 은 **화면 첫 로딩**만 덮는다. 그런데 사용자가 실제로 기다리는 시간의 상당 부분은
 * 버튼 동작(저장·연결 테스트·엑셀 생성·배포·즉시 점검)이고, 그건 각 뷰가 자기 방식으로
 * '저장 중…' 을 그린다(경과 시간도, 무슨 작업인지도 없다). 호출부 100여 곳을 고치는 대신
 * 요청 등록부(perfClient)를 구독해 **한 곳에서** 보여준다 — 새 화면에도 자동으로 적용된다.
 *
 * 원칙:
 *  · 3초(서버 설정 `clientDetailMs`) 미만은 아무것도 그리지 않는다 — 빠른 요청에 깜빡임을 만들지 않는다.
 *  · 작업 이름은 경로 대신 사람 말로(`taskLabel`). 표에 없는 경로는 **지어내지 않고** 경로를 다듬어 보인다.
 *  · 설계상 오래 걸리는 작업은 그 사실을 밝힌다 — '느리다' 와 '고장' 을 구분하게.
 *  · 진행률(%)은 만들지 않는다. 서버가 단계를 주지 않는 작업에 가짜 막대를 그리지 않는다.
 */
export default function GlobalProgress() {
  const [tick, setTick] = useState(0);
  const [hasWork, setHasWork] = useState(false);

  // 요청이 등록/해제될 때마다 깨어난다(요청이 없으면 타이머도 돌지 않는다).
  useEffect(() => subscribeInflight(() => setHasWork(inflightSnapshot(1).length > 0)), []);

  // 진행 중일 때만 0.5초 tick — 경과 시간을 갱신한다.
  useEffect(() => {
    if (!hasWork) return undefined;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      // v2.583: 문턱을 넘긴 요청이 있으면 서버 쪽 상태를 묻는다(자체 조절 — 5초에 1번 · 한 번에 하나).
      if (inflightSnapshot(1)[0]?.ms >= detailThresholdMs()) { try { pollLoadingServerStatus(); } catch { /* 무시 */ } }
    }, 500);
    return () => clearInterval(id);
  }, [hasWork]);

  const p = visibleProgress(inflightSnapshot(10), { detailMs: detailThresholdMs(), normalize: normPath });
  if (!p.show) return null;
  void tick; // tick 은 리렌더 트리거 전용(값 자체는 쓰지 않는다)

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 60, maxWidth: 360,
        background: 'var(--card, #1e293b)', color: 'var(--text, #e2e8f0)',
        border: '1px solid var(--border, #334155)', borderRadius: 10,
        padding: '10px 12px', boxShadow: '0 6px 24px rgba(0,0,0,.35)', fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>진행 중 ({secText(p.oldestMs)} 경과)</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {p.tasks.map((x) => (
          <li key={x.label} style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
            {x.label}
            {x.count > 1 ? ` ×${x.count}` : ''}
            {' · '}
            {secText(x.ms)}
            {x.slow && <span className="muted" style={{ marginLeft: 6 }}>(오래 걸리는 것이 정상)</span>}
            <TaskWho task={x} />
          </li>
        ))}
      </ul>
    </div>
  );
}
