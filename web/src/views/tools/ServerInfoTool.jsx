/**
 * ServerInfoTool.jsx — 특수 기능 ‘서버 정보’(v3.25 · 서버 접속 2단계 — 설계 docs/design/server-access ⑦ Reads).
 * 등록된 서버(베어메탈 스토리지 · 서버 접속과 같은 목록)의 기본 구성 + 디스크를 **누를 때만** 읽어 보인다(주기 수집 없음).
 * 계정 · 로그인은 설정 › 보안 › 서버 접속(SSH · Windows)이 정한다 — 이 화면은 계정을 고르지 않는다.
 * 못 읽은 칸은 ‘— 못 읽음 · 권한’ 처럼 이유를 보이고 0 으로 채우지 않는다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { fmtAgo, fmtTime } from '../../util/fmt.js';
import { cellText, bytesText, kbText, CODE_TEXT, codeTone, sourceText, summaryText, osText, shownOf } from './serverInfoText.js';
import { Chip } from '../sshAccessParts.jsx';   // 서버 접속 화면과 같은 칩(같은 CSS)
import { toneVar } from './toneVar.js';
import '../sshAccess.css';

const BASE_ROWS = [
  ['os', 'OS'], ['kernel', '커널 · 빌드'], ['hostname', '호스트 이름'], ['vendor', '제조사'], ['model', '모델'], ['serial', '시리얼'], ['bios', 'BIOS'],
  ['cpuModel', 'CPU'], ['cpuSockets', '소켓'], ['cpuCores', '코어'], ['cpuThreads', '스레드'], ['memBytes', '메모리', bytesText], ['swapBytes', '스왑', bytesText],
];

function Detail({ s, onClose }) {
  const r = s.result;
  const sh = shownOf(r);
  const src = sh?.src || null;
  return (
    <section className="ssa-sec" aria-label={`${s.name} 서버 정보`}>
      <div className="ssa-acts">
        <h4 style={{ margin: 0 }}>{s.name}</h4><Chip>{osText(s.os)}</Chip>
        {r && <Chip tone={codeTone(r.code)}>{CODE_TEXT[r.code] || r.code}</Chip>}
        {src?.at && <span className="ssa-sub">읽음 {fmtTime(src.at)}{src.auth?.account ? ` · 계정 ${src.auth.account}` : ''}{src.via ? ` · ${src.via.toUpperCase()}` : ''}{src.demo ? ' · 데모 값' : ''}</span>}
        <button className="btn btn-sm" type="button" onClick={onClose}>닫기</button>
      </div>
      {r && !r.ok && <p className="ssa-note" style={{ color: toneVar(codeTone(r.code)) }}>{r.reason || CODE_TEXT[r.code]}{sh?.kind === 'last' ? ` — 아래는 ${fmtTime(r.lastOk.at)} 에 읽은 지난 값입니다(지금 값이 아닙니다).` : (sh?.kind === 'partial' ? ' — 아래는 이번에 받은 칸만입니다(못 받은 칸은 ‘—’).' : '')}</p>}
      {!src ? <p className="ssa-note">아직 읽은 값이 없습니다.</p> : (
        <>
          <dl className="sah-dl">
            {BASE_ROWS.map(([k, label, fmt]) => <React.Fragment key={k}><dt>{label}</dt><dd>{cellText(src.base?.[k], fmt)}</dd></React.Fragment>)}
          </dl>
          <h4>디스크</h4>
          {src.disks == null ? <p className="ssa-note">— 못 읽음</p> : (
            <STable minWidth={640} className="ssa-t sah-t">
              <thead><tr><th>장치</th><th>모델</th><th>종류</th><th className="right">크기</th><th>연결</th><th>시리얼</th>{src.os === 'windows' && <th>상태</th>}</tr></thead>
              <tbody>
                {src.disks.map((d) => (
                  <tr key={d.dev}>
                    <td><code>{d.dev}</code></td><td>{d.model || '—'}</td><td>{d.media || '—'}</td>
                    <td className="right" data-sort={d.sizeBytes ?? ''}>{bytesText(d.sizeBytes)}</td><td>{d.tran || '—'}</td><td><code>{d.serial || '—'}</code></td>
                    {src.os === 'windows' && <td>{d.health || '—'}</td>}
                  </tr>
                ))}
                {!src.disks.length && <tr><td colSpan={7} className="ssa-sub">디스크가 없습니다(목록이 비어 있음).</td></tr>}
              </tbody>
            </STable>
          )}
          <h4>파일시스템</h4>
          {src.fs == null ? <p className="ssa-note">— 못 읽음</p> : (
            <STable minWidth={640} className="ssa-t sah-t">
              <thead><tr><th>마운트</th><th>형식</th><th className="right">크기</th><th className="right">사용</th><th className="right">남음</th><th className="right">사용률</th></tr></thead>
              <tbody>
                {src.fs.map((f) => (
                  <tr key={f.mount}>
                    <td><code>{f.mount}</code></td><td>{f.type || '—'}</td>
                    <td className="right" data-sort={f.sizeKB ?? ''}>{kbText(f.sizeKB)}</td><td className="right" data-sort={f.usedKB ?? ''}>{kbText(f.usedKB)}</td>
                    <td className="right" data-sort={f.availKB ?? ''}>{kbText(f.availKB)}</td><td className="right" data-sort={f.usePct ?? ''}>{f.usePct == null ? '—' : `${f.usePct}%`}</td>
                  </tr>
                ))}
                {!src.fs.length && <tr><td colSpan={6} className="ssa-sub">파일시스템이 없습니다.</td></tr>}
              </tbody>
            </STable>
          )}
        </>
      )}
    </section>
  );
}

export default function ServerInfoTool() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => { try { setV(await fetchJson('/tools/server-info')); setErr(null); } catch (e) { setErr(e); } }, []);
  useEffect(() => { load(); }, [load]);
  // 일괄은 서버가 백그라운드로 돈다(202) — 도는 동안만 4초마다 다시 읽는다(끝나면 멈춘다 · 상시 폴링 없음)
  const running = !!v?.job;
  useEffect(() => { if (!running) return undefined; const id = setTimeout(load, 4000); return () => clearTimeout(id); }, [running, v, load]);
  const servers = useMemo(() => v?.servers || [], [v]);
  const readable = useMemo(() => servers.filter((s) => !s.agent && s.enabled), [servers]);
  const counts = useMemo(() => ({
    all: servers.length, ok: servers.filter((s) => s.result?.ok).length, failed: servers.filter((s) => s.result && !s.result.ok).length, never: servers.filter((s) => !s.result && !s.agent).length,
  }), [servers]);
  if (err) return <ErrorBox error={err} />;
  if (!v) return <Loading />;
  const max = v.limits?.batch || 50;
  const read = async (ids) => {
    if (!ids.length) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/server-info/read', { ids });
      if (!r?.ok) setMsg({ tone: 'bad', text: r?.reason || '읽지 못했습니다.' });
      else setMsg({ tone: 'ok', text: `${r.total}대 읽기를 시작했습니다 — 끝나면 표가 바뀝니다(응답 없는 서버가 섞이면 몇 분 걸립니다).` });
    } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e) }); }
    setBusy(false); load();
  };
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickedIds = [...picked].filter((id) => readable.some((s) => s.id === id));
  const cur = servers.find((s) => s.id === open);
  return (
    <div className="ssa">
      <div className="ssa-head">
        <div className="ssa-title">
          <h3>서버 정보</h3>
          <p className="ssa-note">등록된 서버의 OS · 하드웨어 · CPU · 메모리 · 디스크 · 파일시스템을 <b>누를 때만</b> 읽습니다(읽기 전용 명령 · 설정을 바꾸지 않음 · sudo 를 쓰지 않음 — 권한이 필요한 칸은 ‘못 읽음 · 권한’). 계정은 설정 › 보안 › 서버 접속(SSH · Windows)에서 정합니다.</p>
        </div>
        <button className="btn btn-sm" type="button" onClick={load}>다시 읽기(화면)</button>
      </div>
      <div className="ssa-acts">
        <Chip>서버 {counts.all}대</Chip><Chip tone="ok">읽음 {counts.ok}</Chip><Chip tone={counts.failed ? 'bad' : 'muted'}>실패 {counts.failed}</Chip><Chip>아직 안 읽음 {counts.never}</Chip>
        {v.storeError && <Chip tone="warn" title="보관 파일을 읽지 못해 지난 값이 비었습니다 — 다시 읽으면 채워집니다">보관 파일 {v.storeError}</Chip>}
      </div>
      <div className="ssa-acts">
        <button className="btn btn-sm primary" type="button" disabled={busy || running || !pickedIds.length || pickedIds.length > max} onClick={() => read(pickedIds)}>{running ? `읽는 중 ${v.job.done}/${v.job.total}대…` : `고른 서버 읽기(${pickedIds.length}대)`}</button>
        {pickedIds.length > max && <span className="ssa-sub" style={{ color: toneVar('warn') }}>한 번에 {max}대까지입니다.</span>}
        {msg && <span className="ssa-sub" style={{ color: toneVar(msg.tone) }}>{msg.text}</span>}
      </div>
      <STable minWidth={860} className="ssa-t sah-t" limit={300}>
        <thead><tr>
          <th data-nosort><input type="checkbox" aria-label="읽을 수 있는 서버 모두 고르기" checked={readable.length > 0 && readable.every((s) => picked.has(s.id))} onChange={() => setPicked(readable.every((s) => picked.has(s.id)) ? new Set() : new Set(readable.map((s) => s.id)))} /></th>
          <th>서버</th><th>OS</th><th>계정이 오는 곳</th><th>마지막 읽음</th><th>요약</th><th data-nosort>동작</th>
        </tr></thead>
        <tbody>
          {servers.map((s) => {
            const st = sourceText(s);
            const r = s.result;
            return (
              <tr key={s.id}>
                <td data-nosort>{s.agent || !s.enabled ? null : <input type="checkbox" aria-label={`${s.name} 고르기`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />}</td>
                <td data-sort={s.name}><b>{s.name}</b><div className="ssa-sub"><code>{s.host}{s.port !== 22 ? `:${s.port}` : ''}</code>{s.corp ? ` · ${s.corp}` : ''}</div></td>
                <td data-sort={s.os}>{osText(s.os)}</td>
                <td data-sort={st.label}><Chip tone={st.tone}>{st.label}</Chip>{!s.enabled && <div><Chip tone="warn">수집 꺼짐</Chip></div>}</td>
                <td data-sort={r?.at || 0}>{s.reading ? <Chip tone="muted">읽는 중</Chip> : r ? <><Chip tone={codeTone(r.code)}>{CODE_TEXT[r.code] || r.code}</Chip><div className="ssa-sub">{fmtAgo(r.at)}</div></> : <span className="ssa-sub">—</span>}</td>
                <td>{summaryText(r)}</td>
                <td data-nosort>
                  <div className="ssa-acts sah-stack">
                    <button className="btn btn-sm" type="button" onClick={() => setOpen(open === s.id ? '' : s.id)}>{open === s.id ? '접기' : '자세히'}</button>
                    {!s.agent && s.enabled && <button className="btn btn-sm" type="button" disabled={busy || running} onClick={() => read([s.id])}>읽기</button>}
                  </div>
                </td>
              </tr>
            );
          })}
          {!servers.length && <tr><td colSpan={7} className="ssa-sub">등록된 서버가 없습니다 — 베어메탈 스토리지 · 서버 등록(온보딩)에서 서버를 등록합니다.</td></tr>}
        </tbody>
      </STable>
      {cur && <Detail s={cur} onClose={() => setOpen('')} />}
    </div>
  );
}
