import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';

/**
 * 성능점검 로그 설정 — 저장 경로·분할 단위·보관 기간·용량 상한.
 *
 * 성능점검 화면의 모달과 **같은 API**(`/svcmon/log`)를 쓴다. 설정 화면에 다시 두는 이유:
 * 로그 경로·보관 정책은 점검을 보다가 고치는 값이 아니라 설치·증설 때 정하는 값이라
 * 설정 묶음(템플릿·대량등록·배정) 옆에 있어야 찾는다.
 *
 * '보관 기간'은 파일 수(keepFiles)로 구현된다 — 분할 단위 × 보관 파일 수 = 실질 기간.
 * 이 환산을 화면이 대신 계산해 보여준다(사용자가 곱셈을 하게 두지 않는다).
 */

const UNIT_DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30, quarter: 91 };

function fmtDays(days) {
  if (days >= 365) return `약 ${(days / 365).toFixed(1)}년`;
  if (days >= 30) return `약 ${Math.round(days / 30)}개월`;
  if (days >= 1) return `약 ${Math.round(days)}일`;
  return `약 ${Math.round(days * 24)}시간`;
}

export default function LogSettingsTab({ isAdmin }) {
  // 로그 설정 변경 라우트는 admin 전용이다(경로·보관은 시스템 수준 설정). operator 에게
  // 편집 UI 를 열어 두면 저장에서 403 만 만난다 — 처음부터 잠근다.
  const canEdit = isAdmin;
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    setErr('');
    try { setCfg(await fetchJson('/svcmon/log')); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (!cfg && !err) return <Loading />;
  if (!cfg) return <ErrorBox message={err} />;

  const set = (k, v) => setCfg({ ...cfg, [k]: v });
  const retentionDays = (UNIT_DAYS[cfg.rotate] || 1) * (Number(cfg.keepFiles) || 0);

  const save = async () => {
    setBusy('save'); setErr(''); setDone('');
    try {
      const r = await putJson('/svcmon/log', {
        enabled: cfg.enabled, mode: cfg.mode, rotate: cfg.rotate,
        keepFiles: Number(cfg.keepFiles), maxFileMB: Number(cfg.maxFileMB),
        maxTotalMB: Number(cfg.maxTotalMB), dirPath: String(cfg.dirPath || '').trim(),
      });
      if (r.error) { setErr(r.error); return; }
      setCfg(r);
      setDone('저장했습니다. 다음 기록부터 적용됩니다(진행 중인 파일은 그대로 이어 씁니다).');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const prune = async () => {
    if (!window.confirm('보관 정책을 지금 즉시 적용해 초과 파일을 삭제할까요?\n(가장 오래된 results-*.csv 부터 지웁니다)')) return;
    setBusy('prune'); setErr('');
    try {
      const r = await postJson('/svcmon/log/prune', {});
      setDone(`오래된 로그 ${r.removed}개를 삭제했습니다.`);
      setCfg(r);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  return (
    <div className="flex col gap">
      {err && <ErrorBox message={err} />}
      {done && <div className="svc-ok">{done}</div>}

      <div className="card" style={{ padding: 14 }}>
        <b>기록</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>로그 기록</span>
            <select className="select" value={cfg.enabled ? '1' : '0'} onChange={(e) => set('enabled', e.target.value === '1')} disabled={!canEdit}>
              <option value="1">사용</option><option value="0">중지</option>
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>기록 범위</span>
            <select className="select" value={cfg.mode} onChange={(e) => set('mode', e.target.value)} disabled={!canEdit}>
              <option value="all">모든 결과</option>
              <option value="changes">상태가 바뀐 시점만</option>
            </select>
          </label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          '상태가 바뀐 시점만'으로 바꾸면 로그량이 보통 1/100 이하로 줄지만, 정상 구간의
          응답시간 추이는 남지 않습니다(로그 분석의 평균 ms 가 전이 시점 값만 반영).
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <b>저장 경로</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 320 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              절대 경로 (비우면 기본: 설정 디렉터리 아래 <code>{cfg.dirName || 'svcmon-logs'}</code>)
            </span>
            <input className="input" value={cfg.dirPath || ''} onChange={(e) => set('dirPath', e.target.value)}
              placeholder="예: /data/svcmon-logs (대용량 볼륨)" disabled={!isAdmin}
              style={{ fontFamily: 'ui-monospace, monospace' }} />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          현재 사용 중: <code>{cfg.dir}</code> · 파일 {cfg.fileCount}개 · 합계 {(cfg.totalBytes / 1048576).toFixed(1)} MB
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          저장 시 그 경로에 실제 쓰기 시험을 합니다 — 통과하지 못하면 저장되지 않습니다(오타
          경로에서 로그가 조용히 유실되는 것을 막습니다). 경로를 바꿔도 기존 파일은 옮기지
          않습니다 — 이전 경로의 파일은 그대로 남고, 새 기록만 새 경로에 쌓입니다.
          {!isAdmin && ' (경로 변경은 admin 전용입니다.)'}
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <b>분할 · 보관 기간</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>파일 분할 단위</span>
            <select className="select" value={cfg.rotate} onChange={(e) => set('rotate', e.target.value)} disabled={!canEdit}>
              {(cfg.rotateUnits || ['hour', 'day', 'week', 'month', 'quarter']).map((u) => (
                <option key={u} value={u}>{(cfg.rotateLabels || {})[u] || u}</option>
              ))}
            </select>
          </label>
          <label className="flex col" style={{ gap: 4, width: 130 }}>
            <span className="muted" style={{ fontSize: 11 }}>보관 파일 수</span>
            <input className="input" value={cfg.keepFiles} onChange={(e) => set('keepFiles', e.target.value)} disabled={!canEdit} />
          </label>
          <div className="svc-cap ok" style={{ margin: 0, padding: '8px 12px' }}>
            실질 보관 기간 ≈ <b>{fmtDays(retentionDays)}</b>
            <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>(분할 단위 × 보관 수)</span>
          </div>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, width: 150 }}>
            <span className="muted" style={{ fontSize: 11 }}>파일 최대 크기(MB)</span>
            <input className="input" value={cfg.maxFileMB} onChange={(e) => set('maxFileMB', e.target.value)} disabled={!canEdit} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 170 }}>
            <span className="muted" style={{ fontSize: 11 }}>전체 상한(MB, 0=무제한)</span>
            <input className="input" value={cfg.maxTotalMB} onChange={(e) => set('maxTotalMB', e.target.value)} disabled={!canEdit} />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          한 파일이 최대 크기를 넘으면 같은 구간에서 -p02 로 이어 씁니다. 전체 상한을 넘으면
          가장 오래된 파일부터 지웁니다 — 보관 기간보다 상한이 먼저 걸리면 기간이 줄어듭니다.
        </div>
      </div>

      <div className="flex gap">
        <button className="login-btn" disabled={!canEdit || busy === 'save'} onClick={save}>
          {busy === 'save' ? '저장 중…' : '저장'}
        </button>
        <button className="tab" disabled={!isAdmin || busy === 'prune'} onClick={prune}
          title="보관 정책을 지금 즉시 적용해 초과 파일을 삭제합니다">
          {busy === 'prune' ? '정리 중…' : '지금 정리'}
        </button>
        <button className="tab" onClick={load}>새로 고침</button>
      </div>
    </div>
  );
}
