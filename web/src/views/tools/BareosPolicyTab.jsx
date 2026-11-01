/**
 * Bareos '정책 · 일정' 탭(v2.839 백업 메뉴 개편 2차-a — 시안 ③ · 사용자 결정 '실제 출력 먼저 · show 추가 + 선택 명령').
 *   값은 GET /api/tools/bareos-summary/policy(routes/api/bareosPolicy.js — **Director 에 접속하지 않는다**: 하루 1회 수집한 수집본 + 원장 + 그룹 + 백업 표시).
 *   '지금 수집' 은 관리 도구 권한(bareos-backup · admin)일 때만 — POST 뒤 서버가 뒤에서 돌고, 수집 중인 동안만 5초마다 다시 읽는다(평소에는 폴링하지 않는다).
 *   판정은 서버 하나 — 글자는 bareosPolicyText.js. 못 읽은 값은 '—'(0 이 아니다) · Director 가 싣지 않은 JobDefs 칸은 '기본'.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import BareosTabs from './BareosTabs.jsx';
import { saveBareosHandoff } from './bareosViewText.js';
import { saveBareosGroupHandoff, fmtNum, shortTs } from './backupViewText.js';
import {
  POLICY_CMD_LABEL, POLICY_CMD_KEYS, codeText, directorResult, VERDICT, retentionText, defText, weekLevels, nextRunText, filterSchedules, filterVms, srcText, poolText, keepText,
} from './bareosPolicyText.js';

const WRAP = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 };
const PAD = { padding: '7px 8px' };
const VPAD = { padding: '7px 5px' };   // VM 표는 열이 11개 — 1440 카드 안에 들어가게 여백을 줄인다(Chromium 확인)
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', muted: 'var(--text-dim)' };
const linkBtn = { background: 'none', border: 0, padding: 0, color: '#93c5fd', font: 'inherit', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' };
const WD = ['일', '월', '화', '수', '목', '금', '토'];
// 기본 tbody td 는 nowrap(styles.css) — 긴 글이 옆 칸을 덮지 않게 이 상자들은 줄바꿈한다(Chromium 1440 확인)
const WRAPBOX = (minW, maxW) => ({ minWidth: minW, maxWidth: maxW, whiteSpace: 'normal', overflowWrap: 'anywhere' });
const DETAIL_VC_KEY = 'backup-detail-vc';

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
      <b style={{ fontSize: 14 }}>{title}</b>
      {sub && <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>{sub}</span>}
      {right && <span className="flex wrap" style={{ marginLeft: 'auto', gap: 6 }}>{right}</span>}
    </div>
    {children}
  </section>
);
const Chip = ({ on, onClick, children }) => <button type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} onClick={onClick} style={{ padding: '3px 11px', fontSize: 12 }}>{children}</button>;

export default function BareosPolicyTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sKind, setSKind] = useState('all');
  const [verdict, setVerdict] = useState('');
  const [os, setOs] = useState('');
  const [allVms, setAllVms] = useState(false);
  const gen = useRef(0);
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/bareos-summary/policy')
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, []);
  useEffect(() => { load(); return () => { gen.current++; }; }, [load]);
  // 수집 중인 동안만 5초마다 다시 읽는다(끝나면 멈춘다 — 평소 폴링 없음)
  const busy = !!(data?.collect?.busy || (data?.directors || []).some((d) => d.collecting));
  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [busy, data, load]);

  const canCollect = !!data?.canCollect && toolAllowed('bareos-backup');
  const collect = async (directorIds) => {
    setMsg(null);
    try {
      const r = await postJson('/tools/bareos-backup/policy/collect', directorIds ? { directorIds } : {});
      setMsg(r?.ok ? { tone: 'ok', text: `수집을 시작했습니다 — Director ${r.started?.length || 0}개 · 끝나면 아래 값이 바뀝니다.` } : { tone: 'bad', text: r?.reason || '시작하지 못했습니다.' });
      load();
    } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e).slice(0, 200) }); }
  };

  const head = (
    <>
      <VeeamHeader active="bareos" desc="Bareos — 법인마다 Director 하나 · 정책 · 일정을 Director 에서 하루 한 번 수집해 보여 줍니다(이 화면은 Director 에 접속하지 않습니다)."
        actions={<>
          {data?.at && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>기준 {shortTs(data.at)}</span>}
          {canCollect && <button type="button" className="tab active" disabled={busy} onClick={() => collect(null)} title="범위 안 Director 전부(수집을 끈 Director 는 빼고) — Director 마다 1분에 한 번" style={{ padding: '6px 14px' }}>{busy ? '수집 중…' : '지금 수집'}</button>}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
      <BareosTabs active="policy" />
    </>
  );
  if (!data && error) return <div style={WRAP}>{head}<ErrorBox error={error} /></div>;
  if (!data) return <div style={WRAP}>{head}<Loading /></div>;

  const k = data.kpis || {};
  const dirs = data.directors || [];
  const collected = dirs.filter((d) => d.at != null).length;
  const anyDenied = dirs.some((d) => directorResult(d)?.denied);
  const sch = filterSchedules(data.schedules, sKind);
  const vms = filterVms(data.vms, { verdict, os });
  const now = data.at || Date.now();
  const canBareos = toolAllowed('bareos-backup');
  const act = (r) => {
    if (r.verdict === 'unregistered' && canBareos) return { text: '대상 추가', go: () => { saveBareosHandoff(r.vc, [r.vmId]); window.location.hash = '#/tools/bareos-backup/targets'; } };
    if (r.verdict === 'manual' && canBareos) return { text: '그룹에 넣기', go: () => { saveBareosGroupHandoff(r.vc, [r.vmId]); window.location.hash = '#/tools/bareos-backup/groups'; } };
    if (r.verdict === 'mismatch') return { text: 'Detail', go: () => { try { localStorage.setItem(DETAIL_VC_KEY, r.vc); } catch { /* 첫 법인으로 열린다 */ } window.location.hash = '#/tools/backup-detail'; } };
    return null;
  };

  return (
    <div data-bareos-policy="" style={WRAP}>
      {head}
      {data.demo && <div className="banner warn">데모 Director 입니다 — 실제 Bareos 에 접속하지 않은 합성 결과입니다.</div>}
      {data.loadError && <div className="banner bad">정책 수집본 파일을 읽지 못했습니다(손상본 보존) — 다음 수집이 다시 채웁니다.</div>}
      {data.registryUnreadable && <div className="banner bad">Bareos 백업 대상 원장을 읽지 못해 VM 적용 정책을 모릅니다(—).</div>}
      {data.marksUnreadable && <div className="banner bad">백업 표시 파일을 읽지 못해 미등록 · 방식 불일치를 판정하지 않았습니다.</div>}
      {msg && <div role="status" className="card" style={{ padding: '8px 12px', fontSize: 12.5, color: TONE[msg.tone] }}>{msg.text}</div>}

      <Section title="Director 정책 수집" data-policy-collect=""
        sub={`하루 1회${data.collect?.time ? ` ${data.collect.time}(포탈 시각)` : ''}${data.collect?.enabled === false ? ' — 꺼짐(설정 › 정책 수집)' : ''} · 읽기 전용 명령(status scheduler · llist pools · list volumes · show schedules/jobdefs/filesets · llist clients) · Director 마다 시한`}>
        {dirs.length ? (
          <div style={{ overflowX: 'auto' }}>
            <STable minWidth={760}>
              <thead><tr>{['Director', '법인', '경로', '마지막 수집', '결과', '실패 · 비고'].map((h) => <th key={h} style={PAD}>{h}</th>)}{canCollect && <th data-nosort style={PAD}>수집</th>}</tr></thead>
              <tbody>
                {dirs.map((d) => {
                  const r = directorResult(d);
                  return (
                    <tr key={d.id}>
                      <td data-sort={d.name} style={PAD}><b>{d.name}</b>{d.version ? <span className="muted" style={{ fontSize: 11 }}> {d.version}</span> : null}</td>
                      <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(160, 320)}>{d.vcNames.length ? d.vcNames.join(', ') : <span className="muted">매핑 없음</span>}</div></td>
                      <td style={PAD}>{d.via === 'edge' ? '엣지 대행' : '중앙'}</td>
                      <td data-sort={d.at ?? ''} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{d.collecting ? '수집 중…' : d.at ? shortTs(d.at) : '수집 전'}</td>
                      <td data-sort={r ? r.ok : ''} style={{ ...PAD, whiteSpace: 'nowrap', fontWeight: 700, color: !r ? TONE.muted : r.ok === r.total ? TONE.ok : r.ok ? TONE.warn : TONE.bad }}>{r ? `${r.ok}/${r.total}` : '—'}</td>
                      <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(180, 360)}>
                        {d.off ? '수집 끔(설정) · ' : ''}{r?.bad.length ? r.bad.join(' · ') : r ? '전부 성공' : ''}{d.error?.message ? ` — ${d.error.message}` : d.error?.code ? ` — ${codeText(d.error.code)}` : ''}
                      </div></td>
                      {canCollect && <td style={PAD}><button type="button" onClick={() => collect([d.id])} disabled={busy} style={linkBtn}>지금</button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>범위 안에 Director 가 없습니다 — 설정 › 법인별 Director 와 매핑을 확인하세요.</div>}
        {anyDenied && <div style={{ padding: '8px 14px', fontSize: 12, color: TONE.warn, borderTop: '1px solid var(--border-soft)' }}>‘권한 없음’ — 포탈 콘솔 Profile 의 Command ACL 에 show 가 없습니다. 자동 설정을 다시 돌리거나 Profile 에 show 를 더하면 Run 줄 · JobDefs · FileSet 이 보입니다(나머지 값은 그대로 수집됩니다).</div>}
      </Section>

      <div data-policy-kpis="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, calc(50% - 5px)), 1fr))', gap: 10 }}>
        <Kpi label="스케줄" value={k.schedules?.director == null ? `— · ${fmtNum(k.schedules?.group)}` : fmtNum((k.schedules.director || 0) + (k.schedules.group || 0))}
          sub={`Director ${k.schedules?.director == null ? '—(수집 전)' : fmtNum(k.schedules.director)} · 포탈 그룹 예약 ${fmtNum(k.schedules?.group)}${k.schedules?.unused ? ` · 아무 잡도 안 씀 ${fmtNum(k.schedules.unused)}` : ''}`} />
        <Kpi label="JobDefs · FileSet" value={`${k.jobdefs == null ? '—' : fmtNum(k.jobdefs)} · ${k.filesets == null ? '—' : fmtNum(k.filesets)}`}
          sub={k.jobdefs == null ? (anyDenied ? 'show 권한 없음 — 위 안내' : '수집 전') : `Always Incremental 쓰는 JobDefs ${fmtNum(k.ai)}`} />
        <Kpi label="풀 · 볼륨" value={k.pools ? `${fmtNum(k.pools.n)} · ${k.pools.vols == null ? '—' : fmtNum(k.pools.vols)}` : '—'}
          color={k.pools?.full ? TONE.bad : undefined}
          sub={k.pools ? `가장 높은 사용 ${k.pools.maxPct == null ? '—' : `${k.pools.maxPct}%`} · 가득 참 ${fmtNum(k.pools.full)} · 오류 볼륨 ${fmtNum(k.pools.errorVols)}` : '수집 전'} />
        <Kpi label="VM 적용 정책" value={k.vm?.total == null ? '—' : `${fmtNum(k.vm.policy)} / ${fmtNum(k.vm.total)}`} color={k.vm?.unregistered || k.vm?.mismatch ? TONE.warn : undefined}
          sub={k.vm?.total == null ? '원장을 읽지 못함' : `수동만 ${fmtNum(k.vm.manual)} · 미등록 ${fmtNum(k.vm.unregistered)} · 불일치 ${fmtNum(k.vm.mismatch)}${k.vm.unknown ? ` · 모름 ${fmtNum(k.vm.unknown)}` : ''}`} />
      </div>

      <Section title="다음 7일 예정" sub="Director 스케줄(status scheduler 미리보기 × 쓰는 잡) + 포탈 그룹 회차(× VM) · 레벨별">
        <div data-policy-week="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 8, padding: '10px 14px', fontSize: 12 }}>
          {(data.week || []).map((w, i) => {
            const d = new Date(w.day + 12 * 3_600_000);
            return (
              <div key={w.day} style={{ background: 'var(--panel-deep)', borderRadius: 8, padding: '7px 9px', minWidth: 0 }}>
                <div className="muted">{i === 0 ? `오늘(${WD[d.getDay()]})` : `${WD[d.getDay()]} ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`}</div>
                <b>잡 {fmtNum(w.jobs)}</b>
                <div style={{ color: w.F ? '#f59e0b' : 'var(--text-dim)' }}>{weekLevels(w)}</div>
              </div>
            );
          })}
        </div>
        {collected === 0 && <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12 }}>Director 수집본이 없어 포탈 그룹 회차만 셉니다.</div>}
      </Section>

      <Section title={`스케줄 ${fmtNum(sch.length)}`} sub="Director 스케줄의 Run 줄(show schedules 원문 그대로) + 포탈 그룹 예약 · 쓰는 잡 수 · 다음 실행 · 겹침(같은 Director 의 그룹 회차와 1시간 안)"
        right={<>{[['all', '전체'], ['director', 'Director 스케줄'], ['group', '포탈 그룹 예약'], ['unused', '아무 잡도 안 씀']].map(([kk, t]) => <Chip key={kk} on={sKind === kk} onClick={() => setSKind(kk)}>{t}</Chip>)}</>}>
        {sch.length ? (
          <div style={{ overflowX: 'auto' }}>
            <STable minWidth={900} limit={50}>
              <thead><tr>{['스케줄', 'Director · 법인', '출처', 'Run 줄', '쓰는 잡', '다음 실행', '겹침'].map((h) => <th key={h} style={PAD}>{h}</th>)}</tr></thead>
              <tbody>
                {sch.map((r) => (
                  <tr key={`${r.src}|${r.directorId}|${r.name}`}>
                    <td data-sort={r.name} style={PAD}><b>{r.name}</b>{r.enabled === false ? <span className="muted" style={{ fontSize: 11 }}> 꺼짐</span> : null}</td>
                    <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(120, 210)}>{r.director || '—'}{r.vcNames?.length ? <span className="muted"> · {r.vcNames.join(', ')}</span> : null}</div></td>
                    <td style={PAD}>{r.src === 'group' ? '포탈 그룹' : 'Director'}</td>
                    <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(200, 320)}>
                      {r.run ? r.run.map((x, i) => <div key={i}>{x.text}{x.pool ? <span className="muted"> · pool={x.pool}</span> : null}</div>) : <span className="muted">Run 줄 모름(show 권한 없음 · 수집 전)</span>}
                      {r.description ? <div className="muted" style={{ fontSize: 11 }}>{r.description}</div> : null}
                    </div></td>
                    <td data-sort={r.jobs} style={PAD} title={r.jobNames?.length ? r.jobNames.join(', ') : undefined}>{r.jobs ? fmtNum(r.jobs) : <span style={{ ...WRAPBOX(60, 100), display: 'inline-block', color: TONE.warn }}>0 — 아무 잡도 안 씀</span>}</td>
                    <td data-sort={r.next?.at ?? ''} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{nextRunText(r.next, now)}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{r.overlap?.length ? <span style={{ color: TONE.warn }}>{r.overlap.join(', ')}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{collected ? '조건에 맞는 스케줄이 없습니다.' : 'Director 수집 전입니다 — 포탈 그룹 예약이 없으면 비어 있습니다.'}</div>}
      </Section>

      <Section title={`JobDefs ${data.jobdefs?.length ? fmtNum(data.jobdefs.length) : ''}`} sub="레벨 · 스케줄 · FileSet · Storage · Pool · Full/Incr 풀 · Always Incremental · 우선순위 · 동시 — 값이 없으면 Bareos 기본값(‘기본’)">
        {data.jobdefs?.length ? (
          <div style={{ overflowX: 'auto' }}>
            <STable minWidth={900} limit={30}>
              <thead><tr>{['JobDefs', 'Director', '레벨 · 스케줄', 'FileSet', 'Storage · Pool', 'Full / Incr 풀', 'Always Incremental', '우선순위 · 동시'].map((h) => <th key={h} style={PAD}>{h}</th>)}</tr></thead>
              <tbody>
                {data.jobdefs.map((j) => (
                  <tr key={`${j.directorId}|${j.name}`}>
                    <td data-sort={j.name} style={PAD}><b>{j.name}</b>{j.type && j.type !== 'Backup' ? <span className="muted" style={{ fontSize: 11 }}> {j.type}</span> : null}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{j.director}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{defText(j.level)} · {defText(j.schedule)}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{defText(j.fileset)}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{defText(j.storage)} · {defText(j.pool)}</td>
                    <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(90, 170)}>{defText(j.fullPool)} / {defText(j.incPool)}</div></td>
                    <td style={{ ...PAD, fontSize: 12 }}><div style={WRAPBOX(90, 190)}>{j.ai?.on ? <span style={{ color: TONE.ok }}>예{j.ai.retention ? ` · Job Retention ${j.ai.retention}` : ''}{j.ai.keep != null ? ` · Keep ${j.ai.keep}` : ''}{j.ai.maxFullAge ? ` · Max Full Age ${j.ai.maxFullAge}` : ''}</span> : '아니오'}</div></td>
                    <td style={{ ...PAD, fontSize: 12, whiteSpace: 'nowrap' }}>{defText(j.priority)} · {defText(j.maxJobs)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{anyDenied ? 'show 권한이 없어 수집하지 못했습니다 — 위 안내를 보세요.' : '수집 전입니다.'}</div>}
      </Section>

      <Section title={`FileSet ${data.filesets?.length ? fmtNum(data.filesets.length) : ''}`} sub="플러그인 문자열 · 경로 · 옵션(요약 — 원문 전체는 Director 설정 파일)">
        {data.filesets?.length ? (
          <div style={{ overflowX: 'auto' }}>
            <STable minWidth={760} limit={30}>
              <thead><tr>{['FileSet', 'Director', '내용', '옵션'].map((h) => <th key={h} style={PAD}>{h}</th>)}</tr></thead>
              <tbody>
                {data.filesets.map((f) => (
                  <tr key={`${f.directorId}|${f.name}`}>
                    <td data-sort={f.name} style={PAD}><b>{f.name}</b>{f.description ? <div className="muted" style={{ ...WRAPBOX(120, 260), fontSize: 11 }}>{f.description}</div> : null}</td>
                    <td style={{ ...PAD, fontSize: 12 }}>{f.director}</td>
                    <td style={{ ...PAD, fontSize: 12 }}><div style={{ ...WRAPBOX(200, 420), fontFamily: 'var(--mono)' }}>{[...(f.plugins || []), ...(f.files || [])].join(' · ') || '—'}{f.exclude ? <span className="muted"> · 제외 {f.exclude}</span> : null}</div></td>
                    <td style={{ ...PAD, fontSize: 12 }}>{[f.signature && `signature=${f.signature}`, f.compression && `compression=${f.compression}`].filter(Boolean).join(' · ') || '기본'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{anyDenied ? 'show 권한이 없어 수집하지 못했습니다 — 위 안내를 보세요.' : '수집 전입니다.'}</div>}
      </Section>

      <Section title={`VM 별 적용 정책 ${k.vm?.total == null ? '' : fmtNum(k.vm.total)}`} sub="잡 → 일정(그룹 예약 또는 Director 스케줄) → JobDefs → 풀 → 보존을 한 줄로 · 판정: 정책 있음 · 수동만 · 미등록 · 방식 불일치"
        right={<>
          {[['', '전체'], ['manual', `수동만 ${fmtNum(k.vm?.manual)}`], ['unregistered', `미등록 ${fmtNum(k.vm?.unregistered)}`], ['mismatch', `불일치 ${fmtNum(k.vm?.mismatch)}`], ...(k.vm?.unknown ? [['unknown', `모름 ${fmtNum(k.vm.unknown)}`]] : [])].map(([kk, t]) => <Chip key={kk || 'all'} on={verdict === kk} onClick={() => setVerdict(kk)}>{t}</Chip>)}
          {[['windows', 'Windows'], ['linux', 'Linux']].map(([kk, t]) => <Chip key={kk} on={os === kk} onClick={() => setOs((v) => (v === kk ? '' : kk))}>{t}</Chip>)}
        </>}>
        {vms.length ? (
          <div style={{ overflowX: 'auto' }} data-policy-vms="">
            <STable minWidth={1040} limit={allVms ? 0 : 50}>
              <thead><tr>{['VM', '법인', '잡', '일정 출처', '레벨 규칙 · 시각', '풀(Full / Incr)', '보존', '마지막 성공', '다음 예정', '판정'].map((h) => <th key={h} style={VPAD}>{h}</th>)}<th data-nosort style={VPAD}>조치</th></tr></thead>
              <tbody>
                {vms.map((r) => {
                  const v = VERDICT[r.verdict] || VERDICT.unknown; const a = act(r);
                  return (
                    <tr key={`${r.vc}|${r.vmId}`}>
                      <td data-sort={r.vm} style={{ ...VPAD, whiteSpace: 'nowrap' }}><div style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.vm}><b>{r.vm}</b>{r.os === 'windows' || r.os === 'linux' ? <span className="muted" style={{ fontSize: 11 }}> {r.os === 'windows' ? 'Windows' : 'Linux'}</span> : null}</div></td>
                      <td style={{ ...VPAD, fontSize: 12 }}><div title={r.vcName} style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.vcName}</div></td>
                      <td style={{ ...VPAD, fontSize: 12 }}><div style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.job}>{r.job || '—'}{r.enabled === false ? <span className="muted"> 꺼짐</span> : null}</div></td>
                      <td style={{ ...VPAD, fontSize: 12 }}><div style={WRAPBOX(90, 150)}>{r.verdict === 'unregistered' ? '—' : srcText(r.src)}{r.dup && <div style={{ color: TONE.warn, fontSize: 11 }}>Director {r.dup} 에도 — 두 번 돌 수 있음</div>}</div></td>
                      <td style={{ ...VPAD, fontSize: 12 }}><div style={WRAPBOX(130, 180)}>{r.src?.text || '—'}</div></td>
                      <td style={{ ...VPAD, fontSize: 12 }}><div style={WRAPBOX(90, 150)}>{r.verdict === 'unregistered' ? '—' : poolText(r)}</div></td>
                      <td style={{ ...VPAD, fontSize: 12 }}><div style={WRAPBOX(100, 150)}>{keepText(r)}</div></td>
                      <td data-sort={r.lastOk ?? ''} style={{ ...VPAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{r.lastOk ? shortTs(r.lastOk) : '—'}{r.failing ? <span style={{ color: TONE.bad }}> 실패</span> : null}</td>
                      <td data-sort={r.next?.at ?? ''} style={{ ...VPAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{nextRunText(r.next, now)}</td>
                      <td data-sort={r.verdict} style={{ ...VPAD, whiteSpace: 'nowrap', fontWeight: 700, color: v.color }}>{v.text}</td>
                      <td style={VPAD}>{a ? <button type="button" onClick={a.go} style={linkBtn}>{a.text}</button> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{k.vm?.total ? '조건에 맞는 VM 이 없습니다.' : 'Bareos 잡이 있거나 백업 정책이 Bareos 인 VM 이 없습니다.'}</div>}
        {vms.length > 50 && (
          <div className="flex" style={{ padding: '6px 14px', fontSize: 12, alignItems: 'center', gap: 8 }}>
            <span className="muted">{fmtNum(vms.length)}대 중 {fmtNum(allVms ? vms.length : 50)}대 · 열 제목으로 정렬{data.vmsTruncated ? ' · 서버가 앞 5,000대만 보냈습니다(수는 전부)' : ''}</span>
            <button type="button" className="tab" onClick={() => setAllVms((x) => !x)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{allVms ? '50대만 보기' : '전부 보기'}</button>
          </div>
        )}
      </Section>

      <div className="card muted" data-policy-source="" style={{ padding: '10px 14px', fontSize: 11.5, lineHeight: 1.6 }}>
        <b style={{ color: 'var(--text)' }}>값 출처</b> — {POLICY_CMD_KEYS.map((kk) => POLICY_CMD_LABEL[kk]).join(' · ')}: Director 콘솔(하루 1회 · 명령마다 마지막 성공 값을 둡니다) · 원장 · 그룹 · 백업 정책: 포탈 ·
        다음 실행은 Director 미리보기(절대 시각)와 그룹 예약 · 길이를 몰라 겹침은 1시간 창으로 봅니다 · 판정: 정책 있음 = 그룹 예약 또는 Director 스케줄에 든 잡 · 수동만 = 잡은 있는데 둘 다 없음 ·
        미등록 = 백업 정책 Bareos 인데 잡 없음 · 방식 불일치 = 잡은 있는데 정책이 Bareos 가 아님 · 수집본이 없으면 ‘모름’(0 이 아닙니다).
      </div>
    </div>
  );
}
