/**
 * Bareos '보존 · 풀' 탭(v2.840 백업 메뉴 개편 2차-b — 시안 ③ · 사용자 결정 '두 릴리스 · 표준 검증').
 *   값은 GET /api/tools/bareos-summary/pools(routes/api/bareosPolicy.js — **Director 에 접속하지 않는다**: 하루 1회 수집한 풀 · 볼륨 요약 · 클라이언트 보존).
 *   풀을 누르면 저장된 볼륨 요약을 보이고, 관리 도구 권한(bareos-backup · admin)이면 그 풀의 볼륨 목록을 Director 에서 바로 읽는다
 *   (GET /api/tools/bareos-backup/policy/volumes — Director · 풀마다 1분 · 그 안에는 같은 결과).
 *   판정(가득 참 · 사용 % · 쓰는 잡 수)은 서버 하나 — 글자는 bareosPolicyText.js. 못 읽은 값은 '—'(0 이 아니다).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import BareosTabs from './BareosTabs.jsx';
import { fmtNum, shortTs } from './backupViewText.js';
import { bytesText } from './bareosText.js';
import {
  codeText, retentionText, volStatusText, limitText, onOff, usedText, usedRefs, poolTags, filterPools, mdhm, VOL_SHORT,
} from './bareosPolicyText.js';

const WRAP = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 };
const PAD = { padding: '7px 7px' };
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', muted: 'var(--text-dim)' };
const TAG_BG = { bad: 'rgba(239,68,68,.16)', warn: 'rgba(245,158,11,.16)', muted: 'rgba(148,163,184,.12)' };
// 기본 tbody td 는 nowrap(styles.css) — 긴 글이 옆 칸을 덮지 않게 이 상자들은 줄바꿈한다
const WRAPBOX = (minW, maxW) => ({ minWidth: minW, maxWidth: maxW, whiteSpace: 'normal', overflowWrap: 'anywhere' });
const VOL_WAIT = { retries: 0, timeoutMs: 150_000 };   // 엣지 대행 Director 는 엣지가 가져가 회신할 때까지 — 서버가 먼저 끊는다

function Kpi({ label, value, sub, color }) {
  return (
    <div className="card" style={{ padding: '12px 14px', minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2, overflowWrap: 'anywhere', lineHeight: 1.45 }}>{sub}</div>}
    </div>
  );
}
const Section = ({ title, sub, right, children, ...rest }) => (
  <section className="card" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }} {...rest}>
    <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 10px', padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
      <b style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{title}</b>
      {sub && <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>{sub}</span>}
      {right && <span className="flex wrap" style={{ marginLeft: 'auto', gap: 6 }}>{right}</span>}
    </div>
    {children}
  </section>
);
const Chip = ({ on, onClick, children }) => <button type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} onClick={onClick} style={{ padding: '3px 11px', fontSize: 12 }}>{children}</button>;
const Tag = ({ tone = 'muted', children }) => <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 99, fontSize: 11, fontWeight: 700, color: TONE[tone], background: TAG_BG[tone], marginLeft: 6, whiteSpace: 'nowrap' }}>{children}</span>;
const cmdText = (c) => (!c ? '수집 전' : c.ok === null ? '끔' : c.ok ? `성공 ${shortTs(c.last)}` : `${codeText(c.code)}${c.last ? ` · 마지막 성공 ${shortTs(c.last)}` : ''}${c.message ? ` — ${c.message}` : ''}`);
const cmdTone = (c) => (!c || c.ok === null ? TONE.muted : c.ok ? TONE.ok : TONE.bad);

export default function BareosPoolsTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dirF, setDirF] = useState('');
  const [stateF, setStateF] = useState('');
  const [sel, setSel] = useState(null);   // `${directorId}|${name}`
  const gen = useRef(0);
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/bareos-summary/pools')
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, []);
  useEffect(() => { load(); const g = gen; return () => { g.current++; }; }, [load]);

  const head = (
    <>
      <VeeamHeader active="bareos" desc="Bareos — 풀 · 볼륨 · 보존을 Director 에서 하루 한 번 수집해 보여 줍니다(이 화면은 Director 에 접속하지 않습니다 · 볼륨 목록 즉시 조회는 관리자만)."
        actions={<>
          {data?.at && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>기준 {shortTs(data.at)}</span>}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
      <BareosTabs active="pools" />
    </>
  );
  if (!data && error) return <div style={WRAP}>{head}<ErrorBox error={error} /></div>;
  if (!data) return <div style={WRAP}>{head}<Loading /></div>;

  const k = data.kpis || {};
  const dirs = data.directors || [];
  const collected = dirs.filter((d) => d.at != null).length;
  const pools = filterPools(data.pools, { director: dirF, state: stateF });
  const picked = (data.pools || []).find((p) => `${p.directorId}|${p.name}` === sel) || null;
  const canQuery = !!data.canQuery && toolAllowed('bareos-backup');
  const multiDir = dirs.length > 1;

  return (
    <div data-bareos-pools="" style={WRAP}>
      {head}
      {data.demo && <div className="banner warn">데모 Director 입니다 — 실제 Bareos 에 접속하지 않은 합성 결과입니다.</div>}
      {data.loadError && <div className="banner bad">정책 수집본 파일을 읽지 못했습니다(손상본 보존) — 다음 수집이 다시 채웁니다.</div>}
      {data.registryUnreadable && <div className="banner bad">Bareos 백업 대상 원장을 읽지 못해 쓰는 잡 수를 세지 못했습니다(포탈 잡 0 으로 보이는 칸도 모름입니다).</div>}

      <div data-pools-kpis="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(180px, calc(50% - 5px)), 1fr))', gap: 10 }}>
        <Kpi label="풀" value={k.pools == null ? '—' : fmtNum(k.pools)} sub={`Director ${fmtNum(collected)}/${fmtNum(dirs.length)} 수집`} />
        <Kpi label="볼륨" value={k.vols == null ? '—' : fmtNum(k.vols)} sub="풀 행의 NumVols 합" />
        <Kpi label="가득 참" value={k.full == null ? '—' : fmtNum(k.full)} color={k.full > 0 ? TONE.bad : undefined}
          sub={`새 잡을 받을 볼륨이 없는 풀${k.unknownFull ? ` · 판정 모름 ${fmtNum(k.unknownFull)}` : ''}`} />
        <Kpi label="오류 볼륨" value={k.errorVols == null ? '—' : fmtNum(k.errorVols)} color={k.errorVols > 0 ? TONE.bad : undefined} sub="VolStatus Error" />
        <Kpi label="최대 사용 %" value={k.maxPct == null ? '—' : `${k.maxPct}%`} sub="MaxVols × MaxVolBytes 를 알 때만" />
        <Kpi label="클라이언트" value={k.clients == null ? '—' : fmtNum(k.clients)} sub={k.clients == null ? '수집 전 · 명령 꺼짐 · 실패' : 'File · Job Retention'} />
      </div>

      <Section title="Director 수집 상태" sub="풀 · 볼륨 · 클라이언트 보존 명령의 마지막 결과(정책 · 일정 탭의 수집과 같은 회차)">
        {dirs.length ? (
          <div style={{ overflowX: 'auto' }}>
            <STable minWidth={720}>
              <thead><tr>{['Director', '법인', '풀', '볼륨', '클라이언트'].map((h) => <th key={h} style={PAD}>{h}</th>)}</tr></thead>
              <tbody>
                {dirs.map((d) => (
                  <tr key={d.id}>
                    <td data-sort={d.name} style={PAD}><b>{d.name}</b>{d.via === 'edge' ? <span className="muted" style={{ fontSize: 11 }}> 엣지 대행</span> : null}</td>
                    <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(120, 260)}>{d.vcNames.length ? d.vcNames.join(', ') : <span className="muted">매핑 없음</span>}</div></td>
                    {['pools', 'volumes', 'clients'].map((key) => (
                      <td key={key} style={{ ...PAD, fontSize: 12, color: cmdTone(d.cmds?.[key]) }}><div style={WRAPBOX(140, 280)}>{cmdText(d.cmds?.[key])}{key === 'pools' && d.fallback ? ' · 짧은 목록(보존 · 상한 모름)' : ''}</div></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>범위 안에 Director 가 없습니다 — 설정 › 법인별 Director 와 매핑을 확인하세요.</div>}
      </Section>

      <Section title={`풀 ${fmtNum(pools.length)}개`} data-pools-table=""
        sub="행을 누르면 볼륨 요약 · 볼륨 A Append · F Full · U Used · P Purged · E Error"
        right={<>
          {multiDir && (
            <Select className="input" sort={false} value={dirF} onChange={(e) => setDirF(e.target.value)} aria-label="Director" style={{ minWidth: 0, width: 'auto', fontSize: 12 }}>
              <option value="">Director 전체</option>
              {dirs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          )}
          {[['', '전체'], ['full', '가득 참'], ['error', '오류 볼륨'], ['unknown', '판정 모름']].map(([v, t]) => <Chip key={v || 'all'} on={stateF === v} onClick={() => setStateF(v)}>{t}</Chip>)}
        </>}>
        {data.pools?.length ? (
          <div style={{ overflowX: 'auto' }}>
            <STable minWidth={1120}>
              <thead><tr>
                {['풀', '타입', 'Volume Retention', 'AutoPrune · Recycle', 'Max Vol Jobs · Bytes', '볼륨'].map((h) => <th key={h} style={PAD}>{h}</th>)}
                <th className="right" style={PAD}>사용량</th>
                {['가장 오래된', '쓰는 잡'].map((h) => <th key={h} style={PAD}>{h}</th>)}
              </tr></thead>
              <tbody>
                {pools.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 14 }}>조건에 맞는 풀이 없습니다.</td></tr>}
                {pools.map((p) => {
                  const key = `${p.directorId}|${p.name}`;
                  const on = key === sel;
                  return (
                    <tr key={key} onClick={() => setSel(on ? null : key)} aria-selected={on} style={{ cursor: 'pointer', background: on ? 'rgba(59,130,246,.10)' : undefined }}>
                      <td data-sort={p.name} style={PAD}><div style={WRAPBOX(140, 240)}>
                        <b>{p.name}</b>{poolTags(p).map((t) => <Tag key={t.text} tone={t.tone}>{t.text}</Tag>)}
                        {multiDir && <div className="muted" style={{ fontSize: 11 }}>{p.director}</div>}
                      </div></td>
                      <td style={{ ...PAD, fontSize: 12 }}>{p.type || '—'}</td>
                      <td data-sort={p.volRetentionSec ?? p.vol?.retentionSec ?? ''} style={{ ...PAD, fontSize: 12 }}>
                        {p.volRetentionSec != null ? retentionText(p.volRetentionSec) : p.vol?.retentionSec != null ? <span title="풀 행에 보존 칸이 없어(짧은 목록) 볼륨 보존의 최빈값으로 보였습니다">{retentionText(p.vol.retentionSec)}(볼륨)</span> : '—'}
                      </td>
                      <td style={{ ...PAD, fontSize: 12 }}>{onOff(p.autoPrune)} · {onOff(p.recycle)}</td>
                      <td style={{ ...PAD, fontSize: 12 }}>{limitText(p.maxVolJobs)} · {limitText(p.maxVolBytes, bytesText)}</td>
                      <td data-sort={p.numVols ?? ''} style={{ ...PAD, fontSize: 12 }}>
                        <div><b>{p.numVols == null ? '—' : fmtNum(p.numVols)}</b><span className="muted"> / {limitText(p.maxVols, fmtNum)}</span></div>
                        <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{volStatusText(p.vol)}</div>
                      </td>
                      <td className="right" data-sort={p.vol?.bytesN ? p.vol.bytes : ''} style={{ ...PAD, fontSize: 12 }}>
                        {p.vol?.bytesN ? bytesText(p.vol.bytes) : '—'}
                        {p.pct != null && <div style={{ fontSize: 11, color: p.pct >= 90 ? TONE.bad : p.pct >= 75 ? TONE.warn : TONE.muted }}>{p.pct}%</div>}
                      </td>
                      <td data-sort={p.vol?.oldest ?? ''} style={{ ...PAD, fontSize: 12, fontFamily: 'var(--mono)' }}>{mdhm(p.vol?.oldest)}</td>
                      <td data-sort={p.used?.jobs ?? ''} style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(110, 220)}>
                        {usedText(p.used)}{usedRefs(p.used) && <div className="muted" style={{ fontSize: 11 }}>{usedRefs(p.used)}</div>}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{collected ? '수집한 풀이 없습니다 — Director 수집 상태의 풀 명령 결과를 보세요.' : '아직 수집하지 않았습니다 — 정책 · 일정 탭의 지금 수집(관리자) 또는 설정한 시각의 수집을 기다리세요.'}</div>}
        <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, lineHeight: 1.55, borderTop: '1px solid var(--border-soft)' }}>
          가득 참 = MaxVols 가 정해져 있고 볼륨 수가 상한에 닿았으며 쓸 수 있는 볼륨(Append · Recycle · Purged)이 없고 Scratch 풀도 비어 새 잡을 받을 볼륨이 없는 상태입니다.
          사용 % = 볼륨 바이트 합 ÷ (MaxVols × MaxVolBytes) — 둘 중 하나라도 0(제한 없음)이거나 모르면 보이지 않습니다(SD 디스크 여유는 카탈로그에 없습니다).
          쓰는 잡 = 포탈 잡의 풀(그룹 풀 → 잡 풀)과 JobDefs 의 레벨별 풀로 센 추정치이고 Director 자체 잡은 세지 않습니다. 가장 오래된 시각은 Director 현지 시각입니다.
        </div>
      </Section>

      {picked && <PoolDetail key={sel} p={picked} canQuery={canQuery} gapSec={data.queryGapSec} onClose={() => setSel(null)} />}

      <ClientTable data={data} multiDir={multiDir} />
    </div>
  );
}

/** 고른 풀 — 저장된 볼륨 요약 + (관리자) 볼륨 목록 즉시 조회. */
function PoolDetail({ p, canQuery, gapSec, onClose }) {
  const [vols, setVols] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const query = () => {
    setBusy(true); setErr(null);
    fetchJson('/tools/bareos-backup/policy/volumes', { directorId: p.directorId, pool: p.name }, undefined, VOL_WAIT)
      .then((r) => { if (alive.current) setVols(r); })
      .catch((e) => { if (alive.current) setErr(e); })
      .finally(() => { if (alive.current) setBusy(false); });
  };
  const v = p.vol;
  const st = v?.status || {};
  const known = new Set(VOL_SHORT.map(([x]) => x));
  const extra = Object.entries(st).filter(([x]) => !known.has(x));
  return (
    <Section title={`풀 ${p.name} — 볼륨`} data-pool-detail="" sub={`${p.director} · 요약은 ${p.volAt ? `${shortTs(p.volAt)} 수집` : '수집 전'}`}
      right={<>
        {canQuery && p.queryable && <button type="button" className="tab active" disabled={busy} onClick={query} title={`Director 에 list volumes pool= 한 번(읽기 전용) · ${gapSec || 60}초 안에 다시 누르면 같은 결과`} style={{ padding: '4px 12px', fontSize: 12 }}>{busy ? '읽는 중…' : vols ? '다시 조회' : '볼륨 목록 지금 조회'}</button>}
        <button type="button" className="tab" onClick={onClose} style={{ padding: '4px 12px', fontSize: 12 }}>닫기</button>
      </>}>
      <div style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '8px 16px', fontSize: 12.5 }}>
        <div><span className="muted">볼륨 수 </span><b>{v ? fmtNum(v.n) : '—'}</b>{p.numVols != null && v && p.numVols !== v.n ? <span className="muted"> (풀 행 NumVols {fmtNum(p.numVols)})</span> : null}</div>
        <div><span className="muted">상태 </span>{v ? [...VOL_SHORT.map(([x]) => [x, st[x] || 0]), ...extra].map(([x, c]) => `${x} ${fmtNum(c)}`).join(' · ') + (v.other ? ` · 기타 ${fmtNum(v.other)}` : '') : '—'}</div>
        <div><span className="muted">사용량 </span>{v?.bytesN ? `${bytesText(v.bytes)}${v.bytesN < v.n ? ` (바이트를 아는 볼륨 ${fmtNum(v.bytesN)}개)` : ''}` : '—'}</div>
        <div><span className="muted">기록 </span>{v ? `${mdhm(v.oldest)} ~ ${mdhm(v.newest)}` : '—'}</div>
        <div><span className="muted">볼륨 보존(최빈값) </span>{v ? retentionText(v.retentionSec) : '—'}</div>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><span className="muted">오류 볼륨 </span>{v?.errors?.length ? <span style={{ color: TONE.bad }}>{v.errors.join(', ')}{(st.Error || 0) > v.errors.length ? ` 외 ${fmtNum(st.Error - v.errors.length)}개` : ''}</span> : (st.Error ? `${fmtNum(st.Error)}개` : '없음')}</div>
      </div>
      {!p.queryable && canQuery && <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12 }}>이 풀 이름에는 공백 · 따옴표 같은 글자가 있어 즉시 조회를 지원하지 않습니다 — Director 에서 직접 확인하세요.</div>}
      {!canQuery && <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12 }}>볼륨 하나하나의 목록은 관리 도구(Bareos 백업) 권한이 있는 관리자가 이 자리에서 바로 조회할 수 있습니다.</div>}
      {err && <div style={{ padding: '0 14px 10px' }}><ErrorBox error={err} /></div>}
      {vols && (
        <>
          <div className="muted" style={{ padding: '0 14px 6px', fontSize: 12 }}>
            {vols.cached ? `1분 안에 다시 눌러 앞의 결과를 보입니다(${vols.nextSec}초 뒤 새로 읽을 수 있음) · ` : ''}{shortTs(vols.at)} Director 에서 읽음 · {fmtNum(vols.rows?.length || 0)}개{vols.truncated ? ` (전체 ${fmtNum(vols.total)}개 중 앞부분 — 상한)` : ''} · 마지막 기록 시각은 Director 현지 시각
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '50vh', overflowY: 'auto' }}>
            <STable minWidth={860}>
              <thead><tr>
                {['볼륨', '상태'].map((h) => <th key={h} style={PAD}>{h}</th>)}
                <th className="right" style={PAD}>사용량</th>
                {['보존', '마지막 기록', 'Recycle', '스토리지 · 미디어', 'Slot'].map((h) => <th key={h} style={PAD}>{h}</th>)}
              </tr></thead>
              <tbody>
                {!vols.rows?.length && <tr><td colSpan={8} className="center muted" style={{ padding: 14 }}>볼륨이 없습니다.</td></tr>}
                {(vols.rows || []).map((r) => (
                  <tr key={`${r.id ?? ''}-${r.name}`}>
                    <td data-sort={r.name} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12 }}>{r.name}{r.enabled === false && <Tag>꺼짐</Tag>}</td>
                    <td style={{ ...PAD, fontSize: 12, color: r.status === 'Error' ? TONE.bad : r.status === 'Append' ? TONE.ok : undefined }}>{r.status || '—'}</td>
                    <td className="right" data-sort={r.bytes ?? ''} style={{ ...PAD, fontSize: 12 }}>{r.bytes == null ? '—' : bytesText(r.bytes)}</td>
                    <td data-sort={r.retentionSec ?? ''} style={{ ...PAD, fontSize: 12 }}>{retentionText(r.retentionSec)}</td>
                    <td data-sort={r.lastWritten ?? ''} style={{ ...PAD, fontSize: 12, fontFamily: 'var(--mono)' }}>{mdhm(r.lastWritten)}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{onOff(r.recycle)}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{[r.storage, r.mediaType].filter(Boolean).join(' · ') || '—'}</td>
                    <td data-sort={r.slot ?? ''} style={{ ...PAD, fontSize: 12 }}>{r.slot == null ? '—' : r.slot}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </>
      )}
    </Section>
  );
}

/** 클라이언트(FD) 보존 — 카탈로그 Client 행(그 FD 의 잡이 돌 때 설정 값으로 갱신된다 — 설정을 바꾼 뒤 잡이 아직 안 돌았으면 옛 값). */
function ClientTable({ data, multiDir }) {
  const rows = data.clients || [];
  const anyCollected = (data.directors || []).some((d) => d.cmds?.clients?.last);
  return (
    <Section title="클라이언트 보존" data-pools-clients="" sub="File Retention · Job Retention — 카탈로그 값(그 FD 의 잡이 돌 때 Director 설정으로 갱신 · 그 뒤 설정을 바꿨으면 다음 잡까지 옛 값)">
      {rows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <STable minWidth={640}>
            <thead><tr>
              {[...(multiDir ? ['Director'] : []), 'FD(클라이언트)', 'File Retention', 'Job Retention', 'AutoPrune'].map((h) => <th key={h} style={PAD}>{h}</th>)}
              <th className="right" style={PAD}>포탈 잡</th>
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={`${c.directorId}|${c.name}`}>
                  {multiDir && <td style={{ ...PAD, fontSize: 12 }}>{c.director}</td>}
                  <td data-sort={c.name} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12 }}>{c.name}</td>
                  <td data-sort={c.fileRetentionSec ?? ''} style={{ ...PAD, fontSize: 12 }}>{retentionText(c.fileRetentionSec)}</td>
                  <td data-sort={c.jobRetentionSec ?? ''} style={{ ...PAD, fontSize: 12 }}>{retentionText(c.jobRetentionSec)}</td>
                  <td style={{ ...PAD, fontSize: 12 }}>{onOff(c.autoPrune)}</td>
                  <td className="right" data-sort={c.jobs} style={{ ...PAD, fontSize: 12 }}>{fmtNum(c.jobs)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{anyCollected ? '보일 클라이언트가 없습니다(범위 계정은 자기 법인 잡이 쓰는 FD 만 보입니다).' : '수집 전이거나 클라이언트 보존 명령(llist clients)이 꺼져 있거나 실패했습니다 — 위 수집 상태를 보세요.'}</div>}
    </Section>
  );
}
