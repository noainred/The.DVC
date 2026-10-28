// ESXi 호스트 화면 '법인별' 보기(v2.810 — 승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x).
// 법인 × 지표 표(정렬 · 다빈치/IRS · '지금 확인' 칩은 흐리게) + 고른 법인의 패널(클러스터 자세 · 호스트 칸 · 펼치면 호스트 표).
// 숫자·판정은 서버 /hosts/corp, 글자·색은 hostCorpText.js. 호스트 칸·표는 부모(Hosts)가 이미 폴링하는 /hosts 행을 쓴다(같은 판정 — hostTriage.cpuBucket).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, UsageCell, StateBadge } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { hostUsagePct } from './vcdOverview.js';
import { CPU_BUCKETS, cpuBucket } from './hostTriage.js';
import { kwText } from './hostChecksText.js';
import {
  SEV_LABEL, SEV_BADGE, SEV_COLOR, REGION_COLOR, RATIO_STEPS, fmtN, pctText, ratioText, gbText, stepTone, TONE_TEXT, TONE_BAR,
  rttCell, corpMark, collectText, placeText, corpSortKey, chipList, corpView, clusterTags, bucketSegs, corpKpis,
} from './hostCorpText.js';

const BUCKET_KEYS = CPU_BUCKETS.map((b) => b.key);
const HOST_ROWS = 8;   // 펼친 클러스터의 호스트 표 — 나머지는 '호스트별 보기에서'(개수를 말한다)
const KPI_TONE = { crit: '#f87171', warn: '#fbbf24', ok: 'var(--text)' };
const GROUPS = [['all', '전체'], ['davinci', '다빈치'], ['irs', 'IRS']];

function Mini({ value, steps, max, text, title }) {
  const tone = stepTone(value, steps);
  const w = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="hc-mini" title={title}>
      <span className="tabular" style={{ color: TONE_TEXT[tone] }}>{text}</span>
      <span className="hc-mini-bar" aria-hidden="true">
        <i style={{ width: `${w}%`, background: TONE_BAR[tone] }} />
        {steps.map((s) => <b key={s} style={{ left: `${(s / max) * 100}%` }} />)}
      </span>
    </span>
  );
}

function Segs({ buckets, height = 8, width = 84 }) {
  const segs = bucketSegs(buckets, BUCKET_KEYS);
  return (
    <span className="hc-segs" style={{ width, height }} aria-hidden="true">
      {segs.map((s) => <i key={s.key} className={`ht-b-${s.key}`} style={{ width: `${s.pct}%` }} />)}
    </span>
  );
}

export default function HostsCorp({ filters, rows, onOpenCluster }) {
  const { data, error, loading } = usePolling('/hosts/corp', filters, 60_000);
  const [sel, setSel] = useState(null);
  const [chip, setChip] = useState(null);
  const [group, setGroup] = useState('all');
  const [open, setOpen] = useState(undefined);   // undefined = 첫 클러스터 자동 펼침 · null = 모두 접음
  const panelRef = useRef(null);
  const byId = useMemo(() => new Map((rows || []).map((h) => [h.id, h])), [rows]);
  const corps = data?.corps || [];
  const selId = sel && corps.some((c) => c.id === sel) ? sel : (corps.find((c) => c.sev === 'crit') || corps[0])?.id || null;
  useEffect(() => { setOpen(undefined); }, [selId]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  const now = Date.now();
  const cfgOk = data?.access?.cluster === true;
  const view = corpView(corps, { group, chip });
  const chips = chipList(data?.totals, data?.access);
  const kpis = corpKpis(data);
  const R = corps.find((c) => c.id === selId) || null;
  const pick = (id) => {
    setSel(id);
    // 패널이 표 아래로 내려간 좁은 폭에서는 고른 법인 패널을 보이게 한다(넓은 폭은 옆에 있으므로 움직이지 않는다).
    requestAnimationFrame(() => {
      const el = panelRef.current;
      if (el && el.getBoundingClientRect().top > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <>
      {error && <div className="badge red" style={{ display: 'block', marginBottom: 10, padding: '6px 10px' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}
      {data?.initial && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>첫 수집이 끝나지 않았습니다 — 값이 비어 있는 법인은 채워지는 중입니다.</div>}

      <div className="ht-kpis" aria-label="법인 요약">
        {kpis.map((k) => (
          <div key={k.key} className="ht-kpi">
            <span className="ht-kpi-l">{k.label}</span>
            <span className="ht-kpi-v"><b style={{ color: KPI_TONE[k.tone] || 'var(--text)' }}>{k.value}</b></span>
            <span className="ht-kpi-s" title={k.sub}>{k.sub}</span>
          </div>
        ))}
      </div>

      <section className="card ht-checks" aria-label="지금 확인">
        <div className="ht-head">
          <b>지금 확인</b>
          <span className="muted">누르면 그 사유가 있는 법인만 밝게 보입니다(다른 법인은 흐리게 — 자리는 그대로) · 다시 누르면 해제</span>
        </div>
        <div className="ht-chips">
          {chips.map((c) => (
            <button key={c.key} type="button" className={`ht-chipbtn${chip === c.key ? ' ht-on' : ''}`} onClick={() => setChip(chip === c.key ? null : c.key)}
              disabled={!c.n} aria-pressed={chip === c.key} title={c.n ? '눌러서 이 법인만 밝게(다시 누르면 해제)' : '해당 법인 없음'}>
              <i className="ht-gdot" style={{ background: c.tone === 'red' ? 'var(--red)' : 'var(--amber)' }} aria-hidden="true" />
              <span>{c.label}</span>
              <b className="tabular" style={{ color: c.n ? (c.tone === 'red' ? '#f87171' : '#fbbf24') : 'var(--text-dim)' }}>{fmtN(c.n)}곳</b>
            </button>
          ))}
        </div>
      </section>

      <div className="hc-body">
        <section className="card hc-matrix" aria-label="법인 × 지표">
          <div className="ht-head">
            <b>법인 × 지표</b>
            <div className="hc-seg" role="group" aria-label="법인 묶음">
              {GROUPS.map(([k, label]) => (
                <button key={k} type="button" className={group === k ? 'hc-seg-on' : ''} aria-pressed={group === k} onClick={() => setGroup(k)}>
                  {label} <span className="tabular">{k === 'all' ? corps.length : corps.filter((c) => c.group === k).length}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="ht-legend hc-legend">
            {CPU_BUCKETS.map((b) => <span key={b.key}><i className={`ht-cell ht-b-${b.key}`} />{b.label}</span>)}
          </div>
          <STable className="hc-table" minWidth={cfgOk ? 960 : 820}>
            <thead>
              <tr>
                <th>법인</th>
                <th>호스트</th>
                <th>클러스터</th>
                <th>CPU 분포 · 90%↑</th>
                <th>vCore : 물리</th>
                <th>RAM 할당</th>
                <th>여유 메모리</th>
                {cfgOk && <th>HA · DRS</th>}
                {cfgOk && <th>N+1</th>}
                <th>수집 · RTT</th>
              </tr>
            </thead>
            <tbody>
              {view.map(({ corp: c, dim }) => {
                const m = corpMark(c, now);
                const on = c.id === selId;
                const rtt = rttCell(c.rtt);
                const faded = m.stale ? ' hc-stale' : '';
                return (
                  <tr key={c.id} className={`${on ? 'hc-on' : ''}${dim ? ' hc-dim' : ''}`}>
                    <td data-sort={corpSortKey(c)}>
                      <button type="button" className="hc-corp" onClick={() => pick(c.id)} aria-pressed={on} title={`${c.name} — 오른쪽(또는 아래) 패널에 클러스터·호스트`}>
                        <i className="hc-dot" style={{ background: SEV_COLOR[c.sev] }} aria-hidden="true" />
                        <span className="hc-corp-t">
                          <b>{c.name}</b>
                          <span className="muted">
                            <i className="hc-region" style={{ background: REGION_COLOR[c.region] || 'var(--text-faint)' }} aria-hidden="true" />
                            {c.region || '리전 없음'}{placeText(c) ? ` · ${placeText(c)}` : ''}
                          </span>
                        </span>
                        {m.mark && <span className={`badge ${m.mark === '연결 실패' || m.mark === '인증 정지' ? 'red' : m.mark === '낡은 값' ? 'amber' : 'gray'} hc-mark`} title={m.title || undefined}>{m.mark}</span>}
                      </button>
                    </td>
                    <td data-sort={c.hosts ?? '—'} className={faded}>
                      <span className="hc-stack">
                        <span className="tabular">{fmtN(c.hosts)}{c.maint ? <span style={{ color: '#fbbf24' }}> · 점검 {c.maint}</span> : null}{c.down ? <span style={{ color: '#f87171' }}> · 끊김 {c.down}</span> : null}</span>
                        {c.hosts ? (
                          <span className="hc-segs" style={{ width: 64, height: 4 }} aria-hidden="true">
                            <i style={{ width: `${(c.connected / c.hosts) * 100}%`, background: 'var(--green)' }} />
                            <i style={{ width: `${(c.maint / c.hosts) * 100}%`, background: 'var(--amber)' }} />
                            <i style={{ width: `${(c.down / c.hosts) * 100}%`, background: 'var(--red)' }} />
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td data-sort={c.hosts == null ? '—' : c.clusterCount} className={`tabular${faded}`}>{c.hosts == null ? '—' : c.clusterCount}{c.standalone ? <span className="muted"> · 독립 {c.standalone}</span> : null}</td>
                    <td data-sort={c.hot ?? '—'} title={CPU_BUCKETS.map((b) => `${b.label} ${c.buckets?.[b.key] ?? 0}`).join(' · ')}>
                      <span className="hc-row"><Segs buckets={c.buckets} /><b className="tabular" style={{ color: c.hot >= 5 ? '#f87171' : c.hot > 0 ? '#fbbf24' : 'var(--text-dim)' }}>{fmtN(c.hot)}</b></span>
                    </td>
                    <td data-sort={c.vcpuPerCore ?? '—'} className={faded}>
                      <Mini value={c.vcpuPerCore} steps={RATIO_STEPS.vcpu} max={5} text={ratioText(c.vcpuPerCore)} title={c.capUnknown ? `용량을 못 읽은 호스트 ${c.capUnknown}대 — 비율을 내지 않습니다` : `할당 vCore ${fmtN(c.vcpu)} / 물리 코어 ${fmtN(c.cores)} · 템플릿 제외 · 눈금 2.5 · 4`} />
                    </td>
                    <td data-sort={c.ramPct ?? '—'} className={faded}>
                      <Mini value={c.ramPct} steps={RATIO_STEPS.ram} max={200} text={pctText(c.ramPct)} title={`VM 메모리 할당 ${gbText(c.vmMemGB)} / 물리 ${gbText(c.memTotalGB)} · 눈금 100% · 150%`} />
                    </td>
                    <td data-sort={c.headroomGB ?? '—'} className={`tabular${faded}`} title={`정격 메모리의 90% 에서 지금 사용 중인 양을 뺀 합${c.headroomExcluded ? ` — 사용률을 못 읽은 호스트 ${c.headroomExcluded}대 제외` : ''}`}>
                      <span style={{ color: c.headroomGB != null && c.headroomGB < 0 ? '#f87171' : undefined }}>{gbText(c.headroomGB)}</span>
                    </td>
                    {cfgOk && (
                      <td data-sort={c.cfg ? c.cfg.haOff * 100 + c.cfg.acOff * 10 + c.cfg.drsWeak : '—'}>
                        {c.cfg && c.clusterCount ? (
                          <span className="hc-stack tabular" style={{ fontSize: 11.5 }}>
                            <span style={{ color: c.cfg.haOff ? '#f87171' : undefined }}>HA {c.cfg.haOn}/{c.clusterCount}</span>
                            {c.cfg.acOff ? <span style={{ color: '#fbbf24' }}>수용 제어 꺼짐 {c.cfg.acOff}</span> : null}
                            <span className="muted" style={{ color: c.cfg.drsWeak ? '#fbbf24' : undefined }}>DRS 자동 {c.cfg.drsAuto}/{c.clusterCount}</span>
                          </span>
                        ) : '—'}
                      </td>
                    )}
                    {cfgOk && (
                      <td data-sort={c.cfg && c.clusterCount ? c.cfg.n1Fail : '—'} className="tabular">
                        {c.cfg && c.clusterCount ? <span style={{ color: c.cfg.n1Fail ? '#f87171' : 'var(--green)' }} title={`N+1 가능 ${c.cfg.n1Ok} · 불가 ${c.cfg.n1Fail} · 판정 안 함 ${c.cfg.n1Unknown}`}>{c.cfg.n1Fail ? `불가 ${c.cfg.n1Fail}` : `가능 ${c.cfg.n1Ok}/${c.clusterCount}`}</span> : '—'}
                      </td>
                    )}
                    <td data-sort={c.rtt?.rttMs ?? '—'} title={rtt.title}>
                      <span className="hc-stack" style={{ fontSize: 11.5 }}>
                        <span className="muted">{collectText(c)}</span>
                        <span className="tabular" style={{ color: TONE_TEXT[rtt.tone], opacity: rtt.stale ? 0.6 : 1 }}>{rtt.text}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          <div className="muted ht-note">‘—’ 는 읽지 못한 값입니다(0 이 아닙니다). 낡은 값 · 연결 실패 법인은 마지막으로 받은 값을 흐리게 보입니다. CPU 분포는 호스트 대수 비율이고, 90%↑ 는 정격 용량 대비 90% 를 넘은 호스트 수입니다. RTT 는 핑 모니터가 중앙에서 잰 마지막 값입니다.{cfgOk ? '' : ' HA · DRS · N+1 은 클러스터 HA·DRS 점검 권한이 있어야 보입니다.'}</div>
        </section>

        <aside ref={panelRef} className="card hc-panel" aria-label="고른 법인">
          {!R ? <div className="muted">법인이 없습니다.</div> : <CorpPanel c={R} cfgOk={cfgOk} byId={byId} open={open} setOpen={setOpen} onOpenCluster={onOpenCluster} now={now} />}
        </aside>
      </div>
    </>
  );
}

function CorpPanel({ c, cfgOk, byId, open, setOpen, onOpenCluster, now }) {
  const m = corpMark(c, now);
  const rtt = rttCell(c.rtt);
  const maxB = Math.max(1, ...BUCKET_KEYS.map((k) => c.buckets?.[k] || 0));
  const openKey = open === undefined ? c.clusters[0]?.key ?? null : open;
  return (
    <>
      <div className="hc-p-head">
        <i className="hc-dot" style={{ background: SEV_COLOR[c.sev], width: 10, height: 10 }} aria-hidden="true" />
        <b className="hc-p-name">{c.name}</b>
        <span className="muted">{[placeText(c), c.region].filter(Boolean).join(' · ')}</span>
        <span className={`badge ${SEV_BADGE[c.sev]}`}>{SEV_LABEL[c.sev]}</span>
        {m.mark && <span className="badge amber" title={m.title || undefined}>{m.mark}</span>}
      </div>
      <div className="muted hc-p-meta tabular">vCenter {c.version || '—'} · {collectText(c)}{c.collectedBy ? `(${c.collectedBy})` : ''} · RTT {rtt.text}</div>
      <div className="hc-p-counts">
        {[
          ['호스트', fmtN(c.hosts), `점검 ${fmtN(c.maint)} · 끊김 ${fmtN(c.down)}`],
          ['클러스터', c.hosts == null ? '—' : fmtN(c.clusterCount), cfgOk && c.cfg ? `N+1 불가 ${c.cfg.n1Fail}` : `독립 호스트 ${fmtN(c.standalone)}`],
          ['VM', fmtN(c.vms), `vCore ${ratioText(c.vcpuPerCore)}`],
          ['전력', c.powerKw > 0 ? `${c.powerKw} kW` : '—', `물리 코어 ${fmtN(c.cores)}`],
        ].map(([l, v, s]) => (
          <span key={l} className="hc-p-count"><span className="muted">{l}</span><b className="tabular">{v}</b><span className="muted">{s}</span></span>
        ))}
      </div>
      <div className="hc-p-dist" aria-label="호스트 CPU 분포">
        {CPU_BUCKETS.map((b) => (
          <span key={b.key} className="hc-p-bar">
            <span className="muted">{b.label}</span>
            <span className="ht-bar"><i className={`ht-b-${b.key}`} style={{ width: `${((c.buckets?.[b.key] || 0) / maxB) * 100}%` }} /></span>
            <span className="tabular">{fmtN(c.buckets?.[b.key] ?? 0)}</span>
          </span>
        ))}
      </div>

      <div className="ht-head hc-p-sub"><b>클러스터 <span className="tabular muted">{fmtN(c.clusters.length)}</span></b><span className="muted">위험 → 주의 → 정상 · 그 안에서 최대 CPU 순</span></div>
      {c.clusters.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{c.hosts == null ? '호스트를 아직 모릅니다(0대가 아닙니다).' : '클러스터에 속한 호스트가 없습니다.'}</div>}
      <div className="hc-clusters">
        {c.clusters.map((cl) => {
          const isOpen = openKey === cl.key;
          const hosts = cl.hostIds.map((id) => byId.get(id)).filter(Boolean)
            .sort((a, b) => (hostUsagePct(b, 'cpuUsagePct') ?? 999) - (hostUsagePct(a, 'cpuUsagePct') ?? 999));
          return (
            <div key={cl.key} className={`hc-cl hc-cl-${cl.sev}`}>
              <button type="button" className="hc-cl-btn" onClick={() => setOpen(isOpen ? null : cl.key)} aria-expanded={isOpen}>
                <span className="hc-cl-h">
                  <b>{cl.label}</b>
                  <span className="muted tabular">호스트 {cl.hosts} · VM {fmtN(cl.vms)}</span>
                  <span className={`badge ${SEV_BADGE[cl.sev]}`}>{SEV_LABEL[cl.sev]}</span>
                  <span className="muted hc-caret">{isOpen ? '접기' : '호스트'}</span>
                </span>
                <span className="ht-cells" aria-hidden="true">
                  {hosts.map((h) => {
                    const mt = h.connectionState === 'MAINTENANCE';
                    return <i key={h.id} className={`ht-cell ${mt ? 'hc-cell-maint' : `ht-b-${cpuBucket(h)}`}`} title={`${h.name} — ${mt ? '점검 · ' : ''}CPU ${pctText(hostUsagePct(h, 'cpuUsagePct'))}`} />;
                  })}
                </span>
                <span className="muted tabular hc-cl-f">CPU 평균 {pctText(cl.cpuAvg)} · 최대 <b style={{ color: cl.cpuMax > 90 ? '#f87171' : cl.cpuMax >= 75 ? '#fbbf24' : 'var(--text)' }}>{pctText(cl.cpuMax)}</b> · vCore {ratioText(cl.vcpuPerCore)} · RAM 할당 {pctText(cl.ramPct)} · 여유 {gbText(cl.headroomGB)}</span>
                <span className="hc-tags">{clusterTags(cl, cfgOk).map((t) => <span key={t.label} className={`badge ${t.tone}`}>{t.label}</span>)}</span>
              </button>
              {isOpen && (
                <div className="hc-cl-body">
                  <STable className="hc-htable" limit={HOST_ROWS} minWidth={520}>
                    <thead><tr><th>호스트</th><th>상태</th><th>CPU</th><th>메모리</th><th>VM</th><th>전력</th></tr></thead>
                    <tbody>
                      {hosts.map((h) => (
                        <tr key={h.id}>
                          <td><a className="cell-link" href={`#/hosts/${encodeURIComponent(h.id)}`}>{String(h.name || '').split('.')[0]}</a></td>
                          <td><StateBadge state={h.connectionState} /></td>
                          <td data-sort={hostUsagePct(h, 'cpuUsagePct') ?? '—'}><UsageCell pct={hostUsagePct(h, 'cpuUsagePct')} /></td>
                          <td data-sort={hostUsagePct(h, 'memUsagePct') ?? '—'}><UsageCell pct={hostUsagePct(h, 'memUsagePct')} /></td>
                          <td className="tabular">{fmtN(h.vmCount)}</td>
                          <td className="tabular">{kwText(h.powerWatts)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                  <button type="button" className="btn hc-more" onClick={() => onOpenCluster?.(cl.vcenterId, cl.name)}>
                    {hosts.length > HOST_ROWS ? `호스트 ${hosts.length}대 모두 보기 — 호스트별 보기로` : '호스트별 보기에서 이 클러스터 열기'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
