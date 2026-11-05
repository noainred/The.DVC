// views/vms/VmsAttention.jsx — 가상화 서버 '조치 필요' 탭(v2.909 · 시안 docs/design/vm-screen ④).
//   신호 판정은 서버 하나(inventory/vmSignals.js) — 카드 개수는 /vms?signals=1 의 signalCounts(KPI 집합 기준),
//   목록은 /vms?signal=<키>(서버가 거르고 CPU 높은 순으로 정렬). 15초 폴링 금지 — 탭을 열 때·신호를 바꿀 때 1회 + '다시 읽기'.
//   늦게 온 이전 신호의 응답은 버린다(요청 번호). 목록 상한(LIST_LIMIT)을 넘으면 그 사실을 말한다(조용한 상한 금지).
//   '유휴 후보' 는 신호가 아니다 — 1주 평균 CPU 는 'VM 정밀 검색' 도구가 vCenter 성능 조회로 계산한다(링크 카드).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, toolAllowed } from '../../api.js';
import { Loading, ErrorBox, DataTable } from '../../components/ui.jsx';
import { VmUsageBar, VmNameCell } from '../VmDistPanels.jsx';
import { specText, specSort } from '../vmDistText.js';
import { toolsStatusBadge } from '../vcd/objTabs.js';
import { attentionCards, signalText, fmtN, SIGNAL_ORDER } from './vmHubText.js';
import { numOrNull } from '../../numOrNull.js';

const LIST_LIMIT = 500;
const DAY = 86_400_000;

export default function VmsAttention({ filters, onOpen, onVisible, initial = 'overload' }) {
  const [signal, setSignal] = useState(SIGNAL_ORDER.includes(initial) ? initial : 'overload');
  const [counts, setCounts] = useState({ data: null, error: null });
  const [list, setList] = useState({ data: null, error: null, loading: true });
  const seqC = useRef(0);
  const seqL = useRef(0);
  const fKey = JSON.stringify(filters || {});

  const loadCounts = useCallback(async () => {
    const my = ++seqC.current;
    try {
      const d = await fetchJson('/vms', { ...(filters || {}), signals: '1', limit: 1 });
      if (my === seqC.current) setCounts({ data: d, error: null });
    } catch (e) { if (my === seqC.current) setCounts((s) => ({ data: s.data, error: e?.message || String(e) })); }
  }, [fKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadList = useCallback(async () => {
    const my = ++seqL.current;
    setList((s) => ({ ...s, loading: true, error: null }));
    try {
      const d = await fetchJson('/vms', { ...(filters || {}), signal, signals: '1', sortBy: 'cpuUsagePct', order: 'desc', limit: LIST_LIMIT });
      if (my === seqL.current) setList({ data: d, error: null, loading: false });
    } catch (e) { if (my === seqL.current) setList((s) => ({ data: s.data?.signal === signal ? s.data : null, error: e?.message || String(e), loading: false })); }
  }, [fKey, signal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { loadList(); }, [loadList]);

  const sc = counts.data?.signalCounts || null;
  const days = sc?.snapAgeDays ?? null;
  const cards = attentionCards(sc);
  const cur = signalText(signal, { days });
  const rows = list.data?.signal === signal ? (list.data?.items || []) : [];
  const total = list.data?.signal === signal ? numOrNull(list.data?.total) : null;
  const now = Date.now();
  const columns = [
    { key: 'name', label: 'VM', render: (v) => <VmNameCell vm={v} onOpen={(x) => onOpen && onOpen(x, rows)} /> },
    // 호스트는 드로어에 있다 — 1440 에서 마지막 열이 가로 스크롤 밖으로 밀리지 않게 표에서는 뺐다(v2.909 Chromium 확인).
    { key: 'vcenterId', label: '법인 · vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'signals', label: '사유', sortValue: (v) => (v.signals || []).length, render: (v) => (
      <span className="vmh-sig">{(v.signals || []).map((k) => { const s = signalText(k, { days }); return <span key={k} className={`vmh-badge ${s.badge}`} title={s.desc}>{s.short}</span>; })}</span>
    ) },
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <VmUsageBar pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <VmUsageBar pct={v.memUsagePct} /> },
    { key: 'spec', label: 'vCPU · RAM', align: 'right', sortValue: specSort, render: (v) => <span className="tabular">{specText(v)}</span> },
    { key: 'toolsVersionStatus', label: 'Tools', render: (v) => { const [b, t] = toolsStatusBadge(v.toolsVersionStatus); return <span className={`badge ${b}`}>{t}</span>; } },
    { key: 'snapshotOldestTs', label: '스냅샷', sortValue: (v) => (numOrNull(v.snapshotOldestTs) ? -v.snapshotOldestTs : 0), render: (v) => {
      const n = numOrNull(v.snapshotCount) || 0;
      if (!n) return <span className="muted">없음</span>;
      const ts = numOrNull(v.snapshotOldestTs);
      return <span className="tabular">{n}개{ts ? ` · ${Math.max(0, Math.floor((now - ts) / DAY))}일` : ' · 생성일 모름'}</span>;
    } },
  ];

  return (
    <>
      {counts.error && <div className="badge red" style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal' }}>⚠ 신호 개수를 읽지 못했습니다({counts.error}).</div>}
      <section className="vmh-sigcards" aria-label="신호별 개수 — 누르면 아래 목록이 바뀝니다">
        {cards.map((c) => (
          <button key={c.key} type="button" className="vmh-sigcard" aria-pressed={signal === c.key} onClick={() => setSignal(c.key)}>
            <span className="lb"><span>{c.label}</span><span className={`vmh-badge ${c.badge}`}>{c.short}</span></span>
            <span className="val" style={{ color: c.count > 0 && c.tone !== 'none' ? (c.tone === 'crit' ? 'var(--vmh-crit-text)' : 'var(--vmh-warn-text)') : undefined }}>{fmtN(c.count)}</span>
            <span className="sub">{c.desc}</span>
          </button>
        ))}
        <div className="vmh-sigcard link">
          <span className="lb"><span>유휴 후보</span><span className="vmh-badge blue">비용</span></span>
          <span className="val muted">—</span>
          <span className="sub">
            1주 평균 CPU 로 판정합니다 — vCenter 성능 조회가 필요해 이 탭에서는 세지 않습니다.{' '}
            {toolAllowed('vmfinder') ? <a href="#/tools/vmfinder">‘VM 정밀 검색 / 유휴 VM’ 에서 찾기 →</a> : '‘VM 정밀 검색 / 유휴 VM’ 도구 권한이 없습니다.'}
          </span>
        </div>
      </section>

      <section className="vmd" aria-label={`${cur.label} VM 목록`}>
        <div className="vmh-card-head">
          <b>{cur.label}</b>
          {total != null && <span className="vmh-badge red">{fmtN(total)}대</span>}
          <span className="vmh-note">이번 스냅샷 기준 · CPU 사용률 높은 순 · 열 제목을 누르면 이 목록 안에서 정렬</span>
          <span className="vmh-grow" />
          {list.loading && <span className="muted" style={{ fontSize: 12 }} role="status">불러오는 중…</span>}
          <button type="button" className="tab" style={{ flex: 'none', padding: '6px 11px' }} onClick={() => { loadCounts(); loadList(); }} disabled={list.loading}>다시 읽기</button>
        </div>
        <div style={{ padding: '10px 14px 12px' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8, whiteSpace: 'normal' }}>{cur.desc}</div>
          {list.error && !rows.length ? <ErrorBox message={list.error} />
            : !list.data && list.loading ? <Loading />
              : (
                <>
                  {list.error && <div className="badge red" style={{ display: 'block', marginBottom: 8, padding: '6px 10px', whiteSpace: 'normal' }}>⚠ 다시 읽지 못했습니다 — 직전 목록입니다({list.error}).</div>}
                  <DataTable columns={columns} rows={rows} className="vmd-table" initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} onVisible={onVisible}
                    emptyText={list.loading ? '불러오는 중…' : `${cur.label} 에 해당하는 VM 이 없습니다.`} />
                  {list.data?.hasMore && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 8, whiteSpace: 'normal' }}>
                      CPU 높은 순 앞 {fmtN(list.data.returned)}대만 보여 줍니다(전체 {fmtN(total)}대) — 위 필터(법인 · 검색)로 좁히거나 ‘현황’ 탭에서 페이지로 넘겨 보세요.
                    </div>
                  )}
                </>
              )}
        </div>
      </section>
    </>
  );
}
