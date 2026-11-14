/**
 * 서버 상세 ‘진단 스냅샷’ 탭(리눅스 성능 4단계 · 설계 README §4.1 · 아트보드 Server.dc.html 진단 스냅샷 · 상태 9종 ④ ‘권한 부족’).
 * 실행 버튼(operator 이상 — 서버가 다시 검사) · 사유(필수 · 감사 기록) · 진행 · 결과(CPU · 메모리 · I/O 상위 · ss -s · dmesg · iDRAC 순간값/최근 이벤트) · 보관분 목록(7일).
 * ⚠ 서버가 정한 code 를 문장으로 바꾸기만 한다(bmOpsText SNAP_CODE_TEXT). sudo 를 시도하지 않는다는 사실 · 권한 부족은 상태 문구(bmPerfText STATE_TEXT.perm)로.
 * ⚠ 폴링 없음 — 탭을 열 때 목록 1회 · 실행은 사람이 누를 때 1회(그 사이 버튼 잠금 — 이 서버만).
 */
import React, { useRef, useState } from 'react';
import { postJson, fetchJson, hasRole } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { useOpsLoad, OpsError } from './BmTuningTab.jsx';
import { perfPath } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 요청에 법인을 싣는다
import { STATE_TEXT } from './bmPerfText.js';
import { SNAP_CODE_TEXT, SNAP_STATE_TEXT, snapPermState, bpsText, kbText, snapResultNote, snapCodeShort, snapTrimNote, snapRunGate, SNAP_NOTE, SNAP_PS_NOTE, shortStamp } from './bmOpsText.js';
import './bmOps.css';

const SNAP_REASON_CODES = Object.freeze(['ssh-error', 'auth', 'host-key', 'timeout', 'not-linux', 'edge', 'daily-cap', 'store-unavailable']);

function ProcTable({ rows = [], kind = 'cpu' }) {
  if (!rows.length) return <p className="bmo-note">—</p>;
  return (
    <STable minWidth={360} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>프로세스(이름)</th><th className="right">PID</th>{kind !== 'io' && <th>사용자</th>}{kind === 'io' ? [<th key="r" className="right">읽기</th>, <th key="w" className="right">쓰기</th>] : [<th key="c" className="right">%CPU</th>, <th key="m" className="right">RSS</th>]}</tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={`${p.pid}|${p.name}`}>
            <td data-sort={p.name}>{p.name}</td>
            <td className="right" data-sort={p.pid ?? ''}>{p.pid ?? '—'}</td>
            {kind !== 'io' && <td data-sort={p.user || ''}>{p.user || '—'}</td>}
            {kind === 'io'
              ? [<td key="r" className="right" data-sort={p.readBps ?? ''}>{bpsText(p.readBps)}</td>, <td key="w" className="right" data-sort={p.writeBps ?? ''}>{bpsText(p.writeBps)}</td>]
              : [<td key="c" className="right" data-sort={p.cpuPct ?? ''}>{p.cpuPct == null ? '—' : `${p.cpuPct}%`}</td>, <td key="m" className="right" data-sort={p.rssKb ?? ''}>{kbText(p.rssKb)}</td>]}
          </tr>
        ))}
      </tbody>
    </STable>
  );
}

export function SnapshotResult({ snap }) {
  const r = snap?.result || null;
  const code = SNAP_CODE_TEXT[snap?.code] || SNAP_CODE_TEXT['ssh-error'];
  const st = r?.states || {};
  const perm = snapPermState(r);
  const stateNote = (k) => (st[k] && st[k] !== 'ok' ? SNAP_STATE_TEXT[st[k]] : '');
  // OS 칸은 SSH 출력을 하나라도 읽었을 때만(실패한 실행 · 보관분은 결과가 { error } 뿐이다 — 빈 칸 여섯 개를 그리지 않는다 · Chromium r9 판독).
  const osRead = !!r && ['cpu', 'mem', 'io', 'ss', 'dmesg'].some((k) => st[k] && st[k] !== 'missing');
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div className="bmo-band" style={{ borderLeftColor: toneVar(code.tone) }}>
        <div><b style={{ color: toneVar(code.tone) }}>{code.text}</b> {snap?.at ? <span className="bmo-sub">{shortStamp(snap.at)}</span> : null}</div>
        {snapResultNote(snap || {}) && <div style={{ fontSize: 12 }}><BoldText text={snapResultNote(snap)} /></div>}
        {/* 서버 사유는 실행 실패 · 상한일 때만(원인 · 횟수가 담긴다) — 정책 거부(사유 없음 · 경로 없음 · 권한)는 위 문장과 같은 말이라 겹쳐 쓰지 않는다(Chromium 판독). */}
        {snap?.userReason && <div className="bmo-sub" style={{ overflowWrap: 'anywhere' }}>실행 사유: {snap.userReason}</div>}
        {(snap?.reason && SNAP_REASON_CODES.includes(snap.code)) && <div className="bmo-sub" style={{ overflowWrap: 'anywhere' }}>{snap.reason}</div>}
        {r?.error && <div className="bmo-sub" style={{ overflowWrap: 'anywhere' }}>{r.error}</div>}
        {r?.authStoppedBefore && <div className="bmo-sub">이 서버는 인증 실패로 주기 수집이 멈춰 있던 상태였습니다(수동 실행은 막지 않습니다).</div>}
        {r?.truncated && <div className="bmo-sub">출력이 상한에서 잘려 뒤쪽 구획은 받지 못했습니다(‘받지 못함’ 으로 표시).</div>}
        {snapTrimNote(r) && <div className="bmo-sub">{snapTrimNote(r)}</div>}
      </div>
      {perm && (
        <div className="bmp-state" style={{ borderLeftColor: toneVar(STATE_TEXT.perm.tone) }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{STATE_TEXT.perm.title}</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)' }}><BoldText text={`${STATE_TEXT.perm.body} 프로세스별 I/O 는 root 또는 CAP_SYS_PTRACE 가 필요할 수 있습니다${r?.pids != null && r?.ioReadable != null ? `(읽힌 프로세스 ${r.ioReadable}/${r.pids})` : ''}.`} /></div>
        </div>
      )}
      {osRead && (
        <div className="bmo-snapgrid">
          <section className="bmo-card"><h5 className="bmo-h">CPU 상위</h5>{stateNote('cpu') && <div className="bmo-sub">{stateNote('cpu')}</div>}<ProcTable rows={r.cpuTop} /></section>
          <section className="bmo-card"><h5 className="bmo-h">메모리 상위(RSS)</h5>{stateNote('mem') && <div className="bmo-sub">{stateNote('mem')}</div>}<ProcTable rows={r.memTop} /></section>
          <section className="bmo-card"><h5 className="bmo-h">I/O 상위(/proc/&lt;pid&gt;/io · 2초)</h5>{stateNote('io') && <div className="bmo-sub" style={{ color: toneVar('warn') }}>{stateNote('io')}</div>}
            {st.io === 'perm' ? <p className="bmo-note">확인 불가 — 권한 부족(0 이 아닙니다)</p> : <ProcTable rows={r.ioTop} kind="io" />}
            {st.io === 'ok' && !(r.ioTop || []).length && <p className="bmo-note">2초 동안 디스크 I/O 를 일으킨 프로세스가 없습니다.</p>}
          </section>
          <section className="bmo-card"><h5 className="bmo-h">소켓 요약(ss -s)</h5>{stateNote('ss') && <div className="bmo-sub">{stateNote('ss')}</div>}
            {r.ssTcp && <div style={{ fontSize: 12 }}>TCP {r.ssTcp.total ?? '—'} · estab {r.ssTcp.estab ?? '—'} · timewait {r.ssTcp.timewait ?? '—'} · orphaned {r.ssTcp.orphaned ?? '—'}</div>}
            <pre className="bmo-pre">{(r.ss || []).join('\n') || '—'}</pre>
          </section>
          <section className="bmo-card bmo-wide"><h5 className="bmo-h">커널 로그(dmesg --level=err,warn 최근)</h5>
            {st.dmesg === 'missing' && <div className="bmo-sub">{SNAP_STATE_TEXT.missing}</div>}
            {st.dmesg === 'perm' ? <p className="bmo-note" style={{ color: toneVar('warn') }}>권한 부족 — dmesg 를 읽지 못했습니다(kernel.dmesg_restrict). sudo 를 시도하지 않았습니다.</p>
              : st.dmesg === 'absent' ? <p className="bmo-note">오류 · 경고 줄이 없습니다.</p>
                : <pre className="bmo-pre">{(r.dmesg || []).join('\n') || '—'}</pre>}
            {r.dmesgTotal > (r.dmesg || []).length && <div className="bmo-sub">받은 {r.dmesgTotal}줄 중 최근 {(r.dmesg || []).length}줄만 보입니다(설정 상한).</div>}
          </section>
        </div>
      )}
      {r && (
        <div className="bmo-snapgrid">
          <section className="bmo-card bmo-wide"><h5 className="bmo-h">iDRAC 순간값 · 최근 이벤트(이미 가진 값 — Redfish 추가 호출 없음)</h5>
            {r.idrac ? (
              <>
                <div style={{ fontSize: 12 }}>전력 {r.idrac.powerW == null ? '—' : `${r.idrac.powerW}W`} · CPU {r.idrac.cpuPct == null ? '—' : `${r.idrac.cpuPct}%`} · {(r.idrac.temps || []).map((x) => `${x.name} ${x.c == null ? '—' : `${x.c}℃`}`).join(' · ') || '온도 —'}</div>
                <pre className="bmo-pre">{(r.idrac.events || []).map((e) => `[${e.at || '—'}] ${e.severity} ${e.message}`).join('\n') || '최근 이벤트 없음(인벤토리 기준)'}</pre>
              </>
            ) : <p className="bmo-note">iDRAC 경로 없음 — 이 서버는 iDRAC 등록이 없거나 이 노드가 그 값을 갖고 있지 않습니다.</p>}
          </section>
        </div>
      )}
      {osRead && <p className="bmo-note">{SNAP_PS_NOTE}</p>}
    </div>
  );
}

/** 보관분 표(그리기만) — 결과 칸은 code 원문이 아니라 짧은 낱말(반증 W3 · snapCodeShort). */
export function SnapshotListTable({ snaps = [], selId = '', onOpen = () => {} }) {
  const withBy = snaps.some((x) => x.by);
  return (
    <STable minWidth={560} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>시각</th><th>결과</th><th>사유</th>{withBy && <th>실행자</th>}<th className="right">소요</th><th data-nosort /></tr></thead>
      <tbody>
        {snaps.map((s) => (
          <tr key={s.id} style={{ background: selId === s.id ? 'rgba(255,255,255,0.04)' : undefined }}>
            <td data-sort={s.at ?? ''}>{shortStamp(s.at)}</td>
            <td data-sort={snapCodeShort(s.code)}><span style={{ color: toneVar((SNAP_CODE_TEXT[s.code] || {}).tone) }}>{snapCodeShort(s.code)}</span></td>
            <td data-sort={s.reason} className="bmo-wrap">{s.reason}</td>
            {withBy && <td data-sort={s.by || ''}>{s.by || '—'}</td>}
            <td className="right" data-sort={s.ms ?? ''}>{s.ms == null ? '—' : `${(s.ms / 1000).toFixed(1)}초`}</td>
            <td data-nosort><button className="btn btn-sm bmp-touch" onClick={() => onOpen(s.id)}>보기</button></td>
          </tr>
        ))}
      </tbody>
    </STable>
  );
}

export default function BmSnapshotTab({ itemKey, vc = '' }) {
  const list = useOpsLoad((k, v) => perfPath(k, v, '/snapshots'), itemKey, vc);
  const [reason, setReason] = useState('');
  const [run, setRun] = useState({ busy: false, resp: null, err: null });
  const [sel, setSel] = useState({ id: '', resp: null, err: null });
  const selGen = useRef(0);
  // 반증 W4: 역할(operator 이상)과 쓰기 범위(서버 GET 의 writable — 조회만 되는 법인이면 false) 둘 다 있어야 실행 칸을 연다. 서버도 403.
  const gate = snapRunGate({ roleOk: hasRole('admin', 'operator'), writable: list.resp?.writable });
  const canRun = gate === 'ok';
  const doRun = async () => {
    // 반증 W1: 보관분 ‘보기’ 상태를 비운다 — 그렇지 않으면 새 실행 결과 대신 예전 보관분이 계속 보였다. 진행 중인 ‘보기’ 응답도 버린다.
    selGen.current += 1;
    setSel({ id: '', resp: null, err: null });
    setRun({ busy: true, resp: null, err: null });
    try {
      const r = await postJson(perfPath(itemKey, vc, '/snapshot'), { reason }, { timeoutMs: 120_000 });
      setRun({ busy: false, resp: r, err: null });
      list.reload();
    } catch (e) {
      // 403 · 404 · 429 · 503 — 서버 본문의 code 로 문장을 고른다(없으면 ErrorBox).
      if (e?.body?.code) setRun({ busy: false, resp: { ...e.body, ok: false }, err: null });
      else setRun({ busy: false, resp: null, err: e });
    }
  };
  // 반증 W2: ‘보기’ 연타 — 늦게 온 이전 응답이 화면을 덮지 않게 세대로 거른다(루트 CLAUDE.md ‘늦게 온 이전 응답은 버린다’).
  const open = async (id) => {
    const gen = ++selGen.current;
    setSel({ id, resp: null, err: null });
    try {
      const resp = await fetchJson(perfPath(itemKey, vc, `/snapshots/${encodeURIComponent(id)}`), {}, undefined, { timeoutMs: 60_000 });
      if (gen === selGen.current) setSel({ id, resp, err: null });
    } catch (e) { if (gen === selGen.current) setSel({ id, resp: null, err: e }); }
  };
  const snaps = list.resp?.snapshots || [];
  // 보관분의 reason 은 사람이 적은 실행 사유다(실행 응답의 reason 은 서버 사유) — 섞지 않게 이름을 바꿔 넘긴다(Chromium r9 판독).
  const shown = sel.resp?.snapshot ? { ...sel.resp.snapshot, userReason: sel.resp.snapshot.reason || '', reason: undefined } : (run.resp || null);
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <p className="bmo-note"><BoldText text={SNAP_NOTE} /></p>
      <section className="bmo-card">
        <h5 className="bmo-h">진단 스냅샷 실행</h5>
        {canRun ? (
          <div className="bmo-tagrow">
            <input className="input bmo-input" type="text" maxLength={300} placeholder="사유(필수 — 감사 기록에 남습니다)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn bmp-touch" disabled={run.busy || reason.trim().length < 2} onClick={doRun}>{run.busy ? '실행 중… (SSH 1회 · 최대 1분)' : '진단 스냅샷 실행'}</button>
          </div>
        ) : gate === 'role' ? <p className="bmo-note">실행은 운영자(operator) 이상만 할 수 있습니다 — 아래 보관분은 볼 수 있습니다.</p>
          : <p className="bmo-note">{SNAP_CODE_TEXT.forbidden.text} 아래 보관분은 볼 수 있습니다.</p>}
        {run.err && <ErrorBox error={run.err} />}
      </section>
      {shown && <SnapshotResult snap={shown} />}
      {sel.err && <ErrorBox error={sel.err} />}
      <section className="bmo-card">
        <h5 className="bmo-h">보관분(이 서버를 수집하는 노드 · {list.resp?.keepDays ?? 7}일)</h5>
        <OpsError err={list.err} />
        {list.resp && list.resp.ok === false && <p className="bmo-note">{SNAP_CODE_TEXT[list.resp.code]?.text || list.resp.reason || '보관분을 읽지 못했습니다.'}{list.resp.reason ? ` (${list.resp.reason})` : ''}</p>}
        {list.resp?.running && <p className="bmo-note">지금 이 서버의 스냅샷이 실행 중입니다.</p>}
        {snaps.length ? <SnapshotListTable snaps={snaps} selId={sel.id} onOpen={open} />
          : (list.resp && list.resp.ok !== false && <p className="bmo-note">보관된 스냅샷이 없습니다.</p>)}
      </section>
    </div>
  );
}
