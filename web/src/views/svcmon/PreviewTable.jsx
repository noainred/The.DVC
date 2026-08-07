import React from 'react';

/**
 * 성능점검 대량 작업 미리보기 — CSV 가져오기·대량 자동등록·템플릿 적용이 **같은 계약**으로 쓴다.
 *
 * 표를 정렬하지 않는다: 행 번호가 CSV 행과 1:1 로 대응해야 오류를 찾을 수 있고,
 * 표본은 '앞 20 + 끝 5 + 건너뜀'이라 순서 자체가 정보다.
 *
 * 계약(서버 응답)
 *   summary  { rows, create, update, skip, error, newFolders, newTests }
 *   after    { targets, tests, folders }   limits { maxTargets, maxTotalTests, maxFolders }
 *   capacity { verdict:'ok'|'warn'|'reject', reasons[], requiredPerSec, capablePerSec, ... }
 *   sample[] { verdict:'create'|'update'|'skip', row, kind, path, name, host, enabled, tests, testSummary, newFolders, reason }
 *   errors[] { row, name, reason }        blocked[] { ip, reason }
 */

const VERDICT = {
  create: ['등록', 'green'],
  update: ['갱신', 'amber'],
  skip: ['건너뜀', 'gray'],
  error: ['오류', 'red'],
};

function Bar({ label, used, max }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const cls = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
  return (
    <div className="svc-lim">
      <div className="svc-lim-top">
        <span>{label}</span>
        <b>{used.toLocaleString()} / {max.toLocaleString()} ({pct.toFixed(1)}%)</b>
      </div>
      <div className="svc-lim-bar"><i className={cls} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default function PreviewTable({ result, title = '미리보기' }) {
  if (!result) return null;
  const s = result.summary || {};
  const after = result.after || {};
  const lim = result.limits || {};
  const cap = result.capacity || null;
  const sample = result.sample || [];
  const errors = result.errors || [];
  const blocked = result.blocked || [];
  const warnings = result.warnings || [];
  const unknown = result.unknownColumns || [];

  return (
    <div className="card" style={{ padding: 14, marginTop: 12 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <b>{title}</b>
        <div className="flex gap wrap" style={{ fontSize: 12 }}>
          {s.rows !== undefined && <span className="muted">입력 {s.rows.toLocaleString()}행</span>}
          <span className="badge green">등록 {(s.create || 0).toLocaleString()}</span>
          {s.update ? <span className="badge amber">갱신 {s.update.toLocaleString()}</span> : null}
          {s.skip ? <span className="badge gray">건너뜀 {s.skip.toLocaleString()}</span> : null}
          {s.error ? <span className="badge red">오류 {s.error.toLocaleString()}</span> : null}
          <span className="muted">신규 점검 {(s.newTests || 0).toLocaleString()} · 신규 폴더 {(s.newFolders || 0).toLocaleString()}</span>
        </div>
      </div>

      {/* 상한 잔여 — 커밋이 거부될 조건을 미리 보여준다 */}
      {after.targets !== undefined && (
        <div className="svc-lims">
          <Bar label="대상" used={after.targets} max={lim.maxTargets || 20000} />
          <Bar label="전체 점검" used={after.tests} max={lim.maxTotalTests || 200000} />
          <Bar label="폴더" used={after.folders} max={lim.maxFolders || 5000} />
        </div>
      )}

      {/* 용량 판정 — 등록은 되는데 지정 주기로 돌지 않는 상태를 미리 알린다 */}
      {cap && (
        <div className={`svc-cap ${cap.verdict}`}>
          <div>
            <b>
              {cap.verdict === 'reject' ? '⛔ 처리 불가 — 등록할 수 없습니다'
                : cap.verdict === 'warn' ? '⚠ 처리량 주의' : '✔ 처리량 여유'}
            </b>
            <span className="muted" style={{ marginLeft: 8 }}>
              필요 {cap.requiredPerSec}/s · 추정 가능 {cap.capablePerSec}/s(워커 {cap.workers}개)
              {cap.requiredProcPerSec ? ` · ping/trace ${cap.requiredProcPerSec}/s(가능 ${cap.procPerSec}/s)` : ''}
              · 틱 천장 {cap.tickCeilingPerSec}/s
            </span>
          </div>
          {(cap.reasons || []).map((r, i) => <div key={i} className="svc-cap-why">{r}</div>)}
          {cap.suggestIntervalSec ? (
            <div className="svc-cap-why">권장 주기: 약 {cap.suggestIntervalSec}초 이상</div>
          ) : null}
          {cap.logGbPerDay > 0.5 && (
            <div className="svc-cap-why">
              로그 예상 {cap.logGbPerDay} GB/일 — 분할·보관 설정을 확인하세요(초과분은 오래된 행부터 폐기됩니다).
            </div>
          )}
          <div className="svc-cap-src">기준: {cap.source}</div>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="svc-warn">
          알 수 없는 컬럼 {unknown.length}개는 무시됩니다 — 오타일 수 있습니다: <b>{unknown.join(', ')}</b>
        </div>
      )}
      {warnings.map((w, i) => <div key={i} className="svc-warn">{w}</div>)}

      {blocked.length > 0 && (
        <div className="svc-err">
          <b>차단된 주소 {blocked.length}개</b> — 루프백·링크로컬·메타데이터 주소는 점검 대상이 될 수 없습니다.
          <ul>
            {blocked.slice(0, 20).map((b, i) => <li key={i}><code>{b.ip}</code> — {b.reason}</li>)}
            {blocked.length > 20 && <li className="muted">… 외 {blocked.length - 20}개</li>}
          </ul>
        </div>
      )}

      {errors.length > 0 && (
        <div className="svc-err">
          <b>오류 {errors.length}건</b> — 한 건이라도 있으면 등록하지 않습니다(부분 등록 없음).
          <ul>
            {errors.slice(0, 50).map((e, i) => (
              <li key={i}>{e.row ? `${e.row}행` : '전체'}{e.name ? ` · ${e.name}` : ''} — {e.reason}</li>
            ))}
            {errors.length > 50 && <li className="muted">… 외 {errors.length - 50}건</li>}
          </ul>
        </div>
      )}

      {sample.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>
            표본 {sample.length}건{result.truncatedSample || result.truncated?.sample ? ' (앞 20 + 끝 5 + 건너뜀 일부만 표시)' : ''}
          </div>
          <div className="table-wrap" style={{ maxHeight: '48vh' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 52 }}>#</th>
                  <th style={{ width: 68 }}>판정</th>
                  <th>경로</th>
                  <th>대상 이름</th>
                  <th>호스트</th>
                  <th style={{ width: 60 }}>사용</th>
                  <th style={{ width: 56, textAlign: 'right' }}>점검</th>
                  <th>점검 요약 / 사유</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((r, i) => {
                  const [label, cls] = VERDICT[r.verdict] || [r.verdict, 'gray'];
                  return (
                    <tr key={`${r.verdict}-${r.row}-${i}`}>
                      <td className="muted">{r.row ?? '—'}</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td><code>{r.path}</code>{r.newFolders > 0 && <span className="badge amber" style={{ marginLeft: 4 }}>신규 폴더 {r.newFolders}</span>}</td>
                      <td>{r.name}</td>
                      <td><code>{r.host || '—'}</code></td>
                      <td>{r.enabled === undefined ? '—' : (r.enabled ? '사용' : '중지')}</td>
                      <td style={{ textAlign: 'right' }}>{r.tests ?? '—'}</td>
                      <td className="muted">{r.reason || r.testSummary || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
