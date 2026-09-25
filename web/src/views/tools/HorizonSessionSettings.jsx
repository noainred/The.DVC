/**
 * views/tools/HorizonSessionSettings.jsx — Horizon 실시간 사용자 수집 설정(v2.525).
 *
 * 설계 의도
 *  · **자격증명을 여기서 받지 않는다** — Connection Server 와 계정은 설정 › Horizon 등록이
 *    이미 갖고 있고 이 기능은 그것을 재사용한다(자격증명 스토어를 하나 더 만들면 비밀 승계·
 *    SSRF 가드를 두 곳에서 지켜야 한다 — v2.503 규칙). 여기서는 **어느 서버를 수집할지**와
 *    주기·상한만 정한다.
 *  · 숫자 한계는 서버가 준 `limits` 를 쓴다(하드코딩 금지 — CLAUDE.md 규칙).
 *  · 저장은 admin 만(서버가 집행). 비-admin 은 값만 보이고 버튼이 막힌다 — 403 을 눌러 보게
 *    만들지 않는다(프론트 게이팅은 UX 일 뿐이고 진실의 원천은 서버다).
 * ⚠ 훅은 전부 조기 return 위에(React #310 — v2.202 실제 크래시).
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, sendJson, hasRole } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { blankOr } from '../blankOr.js';
import { hostText } from './addressHiddenText.js'; // v2.600 AUTHZ-2600-05

const MIN = 60_000;

function NumRow({ label, value, onChange, lim, unit = '분', hint }) {
  const toUnit = (ms) => (ms == null ? '' : unit === '분' ? Math.round(ms / MIN) : unit === '초' ? Math.round(ms / 1000) : ms);
  // v2.599 LO2599-01: 빈 칸은 undefined(보내지 않음) — Number('') 가 0 이 되어 서버가 기본값으로 저장하던 것.
  const fromUnit = (raw) => { const v = blankOr(raw); return v === undefined ? undefined : unit === '분' ? Math.round(v * MIN) : unit === '초' ? Math.round(v * 1000) : v; };
  return (
    // ⚠ `minWidth: 0` 이 없으면 라벨 칸이 **설명문의 max-content 폭**으로 자라 옆 칸과 겹친다
    //   (v2.520 스크린샷 판독으로 발견한 결함과 같은 유형).
    <label style={{ display: 'grid', gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'normal' }}>{label}</span>
      <input type="number" className="input" style={{ width: 130 }}
        value={toUnit(value)} min={lim ? toUnit(lim.min) : undefined} max={lim ? toUnit(lim.max) : undefined}
        onChange={(e) => onChange(fromUnit(e.target.value))} />
      {(hint || lim) && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.45 }}>
          {hint}{lim ? `${hint ? ' · ' : ''}허용 ${toUnit(lim.min)}~${toUnit(lim.max)}${unit}` : ''}
        </span>
      )}
    </label>
  );
}

export function HorizonSessionSettings({ onClose }) {
  const [src, setSrc] = useState(null);
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const isAdmin = hasRole('admin'); // v2.613 WEB2613-01: 역할은 App 이 채운 현재 사용자 객체에서 읽는다(화면이 /auth/me 를 다시 부르지 않는다).

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = await fetchJson('/tools/horizon-sessions/settings');
        if (!live) return;
        setSrc(d); setS(d.settings);
      } catch (e) { if (live) setErr(e?.message || String(e)); }
    })();
    return () => { live = false; };
  }, []);

  const save = async () => {
    if (busy || !s) return;
    setBusy(true); setMsg('');
    try {
      const r = await sendJson('/tools/horizon-sessions/settings', 'PUT', s);
      if (r?.ok === false) setMsg(`저장 실패: ${r.reason}`);
      else { setS(r.settings); setMsg('저장했습니다.'); }
    } catch (e) { setMsg(`저장 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const body = (() => {
    if (err) return <ErrorBox error={err} />;
    if (!src || !s) return <Loading />;
    const lim = src.limits || {};
    const setServer = (id, on) => setS((p) => ({ ...p, servers: { ...(p.servers || {}), [id]: { enabled: on } } }));
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700 }}>
          <input type="checkbox" checked={s.enabled === true} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          Horizon 실시간 사용자 수집 켜기
        </label>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal', lineHeight: 1.55 }}>
          <BoldText text="기본은 **꺼짐**입니다 — 켜면 주기마다 각 Connection Server 에 로그인·세션 조회·로그아웃 왕복이 발생합니다. 계정·비밀번호는 **설정 › Horizon 등록**의 값을 그대로 씁니다(여기서 따로 받지 않습니다)." />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <NumRow label="수집 주기" value={s.intervalMs} lim={lim.intervalMs} unit="분" onChange={(v) => setS({ ...s, intervalMs: v })}
            hint="포탈이 Horizon 에 세션 목록을 물어보는 주기" />
          <NumRow label="서버당 시한" value={s.timeoutMs} lim={lim.timeoutMs} unit="초" onChange={(v) => setS({ ...s, timeoutMs: v })}
            hint="고지연 회선이면 늘리세요" />
          <NumRow label="보존 기간" value={s.retentionDays} lim={lim.retentionDays} unit="일" onChange={(v) => setS({ ...s, retentionDays: v })}
            hint="추이 DB 보존일. 이 경계보다 오래된 자료는 지워집니다" />
          <NumRow label="동시 수집" value={s.concurrency} lim={lim.concurrency} unit="대" onChange={(v) => setS({ ...s, concurrency: v })}
            hint="여러 Connection Server 를 동시에 조회하는 수" />
          <NumRow label="페이지 크기" value={s.pageSize} lim={lim.pageSize} unit="건" onChange={(v) => setS({ ...s, pageSize: v })}
            hint="한 번에 받을 세션 수(Horizon size 파라미터)" />
          <NumRow label="페이지 상한" value={s.maxPages} lim={lim.maxPages} unit="회" onChange={(v) => setS({ ...s, maxPages: v })}
            hint="이 수를 넘으면 '일부만 읽었다' 고 화면에 표시합니다" />
          <NumRow label="계정 목록 상한" value={s.maxUsers} lim={lim.maxUsers} unit="명" onChange={(v) => setS({ ...s, maxUsers: v })}
            hint="저장·표시할 계정 수. 수치(고유 사용자 수)에는 상한이 적용되지 않습니다" />
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={s.showNamesInList === true} onChange={(e) => setS({ ...s, showNamesInList: e.target.checked })} />
          <span style={{ fontSize: 12.5 }}>목록에 계정명을 항상 표시(기본은 가림 — 개인정보)</span>
        </label>

        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>수집 대상 Connection Server</div>
          {!src.servers?.length && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'normal' }}>
              등록된 Horizon 서버가 없습니다 — <b>설정 › Horizon 등록</b>에서 추가하세요(CSV·자유텍스트로 한꺼번에 등록할 수도 있습니다).
            </div>
          )}
          {src.servers?.length > 0 && (
            <div className="table-wrap">
              <STable className="v3-table">
                <thead><tr><th data-nosort>수집</th><th>서버</th><th>주소</th><th>등록 상태</th></tr></thead>
                <tbody>
                  {src.servers.map((x) => {
                    const on = s.servers?.[x.id]?.enabled !== false;
                    return (
                      <tr key={x.id}>
                        <td data-sort={on ? 1 : 0}><input type="checkbox" checked={on} onChange={(e) => setServer(x.id, e.target.checked)} /></td>
                        <td><b>{x.name}</b> <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{x.id}</span></td>
                        <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{hostText(x.host)}</td>
                        <td style={{ fontSize: 11.5 }}>{x.enabled ? '활성' : '비활성(Horizon 등록에서 꺼짐)'}{x.hasPassword ? '' : ' · 비밀번호 없음'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy || !isAdmin} onClick={save}
            title={isAdmin ? '' : '설정 저장은 관리자만 가능합니다'}>{busy ? '저장 중…' : '저장'}</button>
          {!isAdmin && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>설정 저장은 관리자만 가능합니다(값은 볼 수 있습니다).</span>}
          {msg && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{msg}</span>}
        </div>
      </div>
    );
  })();

  return <Modal title="Horizon 실시간 사용자 — 수집 설정" onClose={onClose} width={900}>{body}</Modal>;
}

export default HorizonSessionSettings;
