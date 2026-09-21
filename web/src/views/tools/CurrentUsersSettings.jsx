/**
 * views/tools/CurrentUsersSettings.jsx — '현재 사용자' 수집 설정(v2.520).
 *
 * 사용자 요청의 "**설정에서 지정한 폴더**" · "**설정에서 지정한 시간**마다" 를 담당한다.
 *
 * 설계 의도
 *  · **폴더 후보는 Windows VM 이 실제로 들어 있는 폴더만** 보여 준다(전 폴더를 나열하면 수백 줄).
 *    각 폴더에 Windows 가 몇 대인지 함께 적어 관리자가 고를 수 있게 한다.
 *  · **주기가 두 개**라는 사실을 화면이 설명한다 — 포탈이 읽는 주기와, 게스트 스케줄 작업이
 *    발행하는 주기. 포탈은 후자를 강제할 수 없다(각 서버의 schtasks 가 정한다).
 *  · 저장은 admin 만(서버가 집행). 비-admin 은 값만 보이고 버튼이 막힌다 — 403 을 눌러 보게
 *    만들지 않는다.
 *  · 숫자 한계는 서버가 준 `limits` 를 쓴다(하드코딩 금지).
 * ⚠ 훅은 전부 조기 return 위에.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, sendJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { intervalText } from './curUserText.js';

const MIN = 60_000;

function NumRow({ label, value, onChange, lim, unit = '분', hint }) {
  const toUnit = (ms) => (unit === '분' ? Math.round(ms / MIN) : ms);
  const fromUnit = (v) => (unit === '분' ? Math.round(Number(v) * MIN) : Number(v));
  return (
    // ⚠ `minWidth: 0` 이 없으면 라벨 칸이 **설명문의 max-content 폭**으로 자라 옆 칸과 겹친다
    //   (v2.520 스크린샷 판독으로 발견 — 수치로는 안 잡혔다. 숫자 6개가 서로 침범했다).
    <label style={{ display: 'grid', gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'normal' }}>{label}</span>
      <input
        type="number" className="input" style={{ width: 130 }}
        value={toUnit(value)}
        min={lim ? toUnit(lim.min) : undefined}
        max={lim ? toUnit(lim.max) : undefined}
        onChange={(e) => onChange(fromUnit(e.target.value))}
      />
      {(hint || lim) && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.45 }}>
          {hint}{lim ? `${hint ? ' · ' : ''}허용 ${toUnit(lim.min)}~${toUnit(lim.max)}${unit}` : ''}
        </span>
      )}
    </label>
  );
}

export function CurrentUsersSettings({ onSaved }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState('');
  const [s, setS] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 저장은 서버가 admin 으로 집행한다 — 화면은 버튼을 미리 막아 '눌러 보고 403' 을 만들지 않는다
  // (프론트 게이팅은 UX 일 뿐이고 진실의 원천은 서버다 — server/CLAUDE.md).
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let live = true;
    fetchJson('/tools/curuser/settings')
      .then((d) => { if (live) { setSrc(d); setS(d.settings); } })
      .catch((e) => live && setErr(e?.message || String(e)));
    fetchJson('/auth/me').then((m) => live && setIsAdmin(m?.user?.role === 'admin')).catch(() => {});
    return () => { live = false; };
  }, []);

  const folders = src?.folders || [];
  const vcenters = src?.vcenters || [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return folders.filter((f) => !needle || `${f.folder} ${f.vcenterId}`.toLowerCase().includes(needle));
  }, [folders, q]);
  const resolved = useMemo(() => new Map((src?.resolved || []).map((r) => [r.vcenterId, r])), [src]);

  if (err && !src) return <ErrorBox error={err} />;
  if (!src || !s) return <Loading />;

  const vcOf = (id) => (s.vcenters || {})[id] || { enabled: false, folders: [], excludeFolders: [], includeSubfolders: true };
  const setVc = (id, patch) => setS({ ...s, vcenters: { ...s.vcenters, [id]: { ...vcOf(id), ...patch } } });
  const toggleFolder = (id, folder) => {
    const cur = vcOf(id);
    const list = cur.folders.includes(folder) ? cur.folders.filter((x) => x !== folder) : [...cur.folders, folder];
    setVc(id, { folders: list });
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await sendJson('/tools/curuser/settings', 'PUT', s);
      setS(r.settings); setMsg('저장했습니다.');
      onSaved?.();
    } catch (e) { setMsg(`저장 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const enabledVc = Object.entries(s.vcenters || {}).filter(([, v]) => v.enabled && (v.folders || []).length).map(([id]) => id);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
      {!isAdmin && <div style={{ fontSize: 12, color: 'var(--amber)' }}>보기 전용입니다 — 저장은 관리자만 할 수 있습니다.</div>}
      {src.db?.available === false && (
        <div style={{ fontSize: 12, color: 'var(--red)', whiteSpace: 'normal' }}>
          이 런타임에서 내장 SQLite(node:sqlite)를 쓸 수 없어 **추이가 저장되지 않습니다**{src.db.error ? ` — ${src.db.error}` : ''}.
        </div>
      )}

      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
        <span style={{ fontWeight: 700 }}>수집 켜기</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>기본 꺼짐 — 폴더를 지정하지 않으면 아무것도 수집하지 않습니다(전체 VM 으로 확대하지 않습니다).</span>
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, alignItems: 'start' }}>
        <NumRow label="포탈이 읽는 주기" value={s.intervalMs} lim={src.limits?.intervalMs} onChange={(v) => setS({ ...s, intervalMs: v })} hint="vCenter 구성에서 값을 읽어 DB 에 저장하는 주기" />
        <NumRow label="게스트 발행 주기(신고값)" value={s.guestPublishMs} lim={src.limits?.guestPublishMs} onChange={(v) => setS({ ...s, guestPublishMs: v })} hint="각 Windows 서버의 스케줄 작업 주기. 포탈이 강제할 수 없어 신선도 판정·스크립트 기본값에만 씁니다" />
        <NumRow label="오래됨 판정 배수" value={s.staleFactor} lim={src.limits?.staleFactor} unit="배" onChange={(v) => setS({ ...s, staleFactor: v })} hint={`발행 주기 × 배수 = ${intervalText(src.staleAfterMs)} 이상이면 '값이 오래됨'`} />
        <NumRow label="추이 보존" value={s.retentionDays} lim={src.limits?.retentionDays} unit="일" onChange={(v) => setS({ ...s, retentionDays: v })} />
        <NumRow label="한 주기 대상 상한" value={s.maxVms} lim={src.limits?.maxVms} unit="대" onChange={(v) => setS({ ...s, maxVms: v })} hint="넘는 대상은 제외되고 그 개수를 화면이 밝힙니다" />
        <NumRow label="법인 동시 조회" value={s.concurrency} lim={src.limits?.concurrency} unit="개" onChange={(v) => setS({ ...s, concurrency: v })} />
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!s.showNamesInList} onChange={(e) => setS({ ...s, showNamesInList: e.target.checked })} />
        <span style={{ fontSize: 12.5 }}>목록에서 계정명을 기본으로 표시</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>꺼도 상세 펼침에서는 보입니다(개인정보성).</span>
      </label>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>법인별 수집</div>
        <div className="table-wrap">
        <STable className="v3-table">
          <thead><tr><th>법인</th><th data-nosort>수집</th><th data-nosort>하위 폴더 포함</th><th>지정 폴더</th><th>현재 대상</th><th>대상 아님</th></tr></thead>
          <tbody>
            {vcenters.map((v) => {
              const c = vcOf(v.id); const r = resolved.get(v.id);
              return (
                <tr key={v.id}>
                  <td>{v.name}{v.collectSource === 'site' ? <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}> (엣지 위임)</span> : null}</td>
                  <td><input type="checkbox" checked={!!c.enabled} onChange={(e) => setVc(v.id, { enabled: e.target.checked })} /></td>
                  <td><input type="checkbox" checked={c.includeSubfolders !== false} onChange={(e) => setVc(v.id, { includeSubfolders: e.target.checked })} /></td>
                  <td data-sort={String((c.folders || []).length)}>{(c.folders || []).length}개</td>
                  <td data-sort={String(r?.targets || 0)}>{r?.targets || 0}대</td>
                  <td data-sort={String(r?.skipped || 0)}>{r?.skipped || 0}대</td>
                </tr>
              );
            })}
            {!vcenters.length && <tr><td colSpan={6} style={{ color: 'var(--text-faint)' }}>표시할 법인이 없습니다.</td></tr>}
          </tbody>
        </STable>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontWeight: 700 }}>폴더 선택</span>
          <SearchBox value={q} onChange={setQ} placeholder="폴더 경로 검색" />
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Windows VM 이 있는 폴더만 나옵니다({folders.length}개).</span>
        </div>
        <div style={{ maxHeight: 280, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
          <STable className="v3-table">
            <thead><tr><th data-nosort>선택</th><th>법인</th><th>폴더</th><th>Windows</th><th>전체 VM</th></tr></thead>
            <tbody>
              {rows.map((f) => {
                const c = vcOf(f.vcenterId);
                const on = (c.folders || []).includes(f.folder);
                return (
                  <tr key={`${f.vcenterId}|${f.folder}`}>
                    <td><input type="checkbox" checked={on} onChange={() => toggleFolder(f.vcenterId, f.folder)} /></td>
                    <td>{vcenters.find((v) => v.id === f.vcenterId)?.name || f.vcenterId}</td>
                    <td style={{ fontSize: 11.5 }}>{f.folder}</td>
                    <td data-sort={String(f.windows)}>{f.windows}</td>
                    <td data-sort={String(f.vms)}>{f.vms}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={5} style={{ color: 'var(--text-faint)' }}>폴더 후보가 없습니다(스냅샷에 Windows VM 이 없거나 아직 수집 전).</td></tr>}
            </tbody>
          </STable>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal', lineHeight: 1.6 }}>
        <BoldText text={`게스트 발행기 등록 명령: ‘${src.installCommand}’ — 각 Windows 서버에서 **관리자 권한**으로 한 번만 실행합니다. 포탈로 나가는 방화벽 허용은 필요하지 않습니다.`} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="login-btn" onClick={save} disabled={!isAdmin || busy}>{busy ? '저장 중…' : '저장'}</button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{msg}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>수집 대상 법인 {enabledVc.length}곳</span>
      </div>
    </div>
  );
}

export default CurrentUsersSettings;
