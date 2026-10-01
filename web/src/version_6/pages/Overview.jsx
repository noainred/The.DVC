import React from 'react';
import { usePolling, can, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { loadPhase, loadText } from '../../version_4/loadState.js';
import { agoText } from '../../views/tools/relTime.js';
import { statusTiles, usageGauges, siteCards, siteToneCounts, recentAlarms, actionLinks, SITE_GROUPS, siteGroupCounts, filterSiteGroup, emptyGroupText } from '../v6Data.js';
import { WARN_PCT, CRIT_PCT } from '../../console/consoleData.js';

/**
 * V6 Overview(v2.623) — **지금 상태**만 둔다(핸드오프: Overview = 연결·상태·알람·사용률·법인별 상태·조치 필요).
 * 자원 총량·할당은 Summary 가, 서버 합계·물리 전용 표는 서버 메뉴가 소유한다(두 화면에 같은 KPI 를 두지 않는다).
 * 폴링: /overview 15초 · /alarms 30초(inv.alarms 권한이 있을 때만 — 권한 없는 API 는 부르지 않는다).
 * '조치 필요' 는 개수를 세지 않는 바로가기다 — 각 도구 API 를 Overview 마다 부르면 그 자체가 부하다(정직: 개수는 도착 화면이 말한다).
 */
const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US'));
const TONE_LABEL = { ok: '정상', warn: '주의', crit: '위험', none: '판정 대기' };
// 법인 구분 선택은 이 브라우저의 편의 설정이다(localStorage — 프라이빗 창에서는 throw 하므로 try/catch, 못 읽으면 '전체').
const GROUP_KEY = 'v6.siteGroup';
function readGroup() { try { const v = globalThis.localStorage?.getItem(GROUP_KEY); return v === 'davinci' || v === 'irs' ? v : 'all'; } catch { return 'all'; } }
function writeGroup(v) { try { globalThis.localStorage?.setItem(GROUP_KEY, v); } catch { /* 저장 못 해도 화면은 동작한다 */ } }

export default function V6Overview({ health, healthError, onSelectSite }) {
  const { data: ov, error } = usePolling('/overview', {}, 15_000);
  const canAlarms = can('inv.alarms');
  // v2.628 WEB2628-03: 오류를 받지 않으면 실패(403 이면 폴링이 멈춘다)가 영원히 '불러오는 중…' 으로 보였다.
  const { data: alarms, error: alarmsErr } = usePolling(canAlarms ? '/alarms' : '', {}, 30_000);
  const [group, setGroupState] = React.useState(readGroup); // 훅은 조기 return 위(React #310)
  const setGroup = (v) => { setGroupState(v); writeGroup(v); };
  if (error && !ov) return <ErrorBox message={error} />;
  if (!ov) return <Loading label="Overview" />;
  // v2.675: 첫 병합 전 골격(ov.initial — 인벤토리를 아직 읽지 않았다)도 타일에 0 을 그리지 않고 같은 '수집 준비 중' 안내를 쓴다.
  if (!ov.global || ov.initial) {
    const t = loadText(loadPhase({ health, healthError, poll: { data: null, error } }), { health, pollError: error });
    return <div className="v6-panel"><b>수집 준비 중</b><div className="v6-note">{t.long}</div></div>;
  }
  const g = ov.global;
  const tiles = statusTiles(g, ov.sites);
  const gauges = usageGauges(g);
  const allCards = siteCards(ov.sites);
  const groupCounts = siteGroupCounts(allCards);
  const cards = filterSiteGroup(allCards, group);
  const counts = siteToneCounts(cards);
  const recent = canAlarms ? recentAlarms(alarms, 6) : null;
  const actions = actionLinks(toolAllowed);
  const genMs = Date.parse(ov.generatedAt || '');

  return (
    <div className="v6-ov">
      {error && <div className="v6-banner warn">갱신 실패(직전 데이터 표시 중): {String(error?.message || error)}</div>}
      <div className="v6-console">
        <span><b>▸</b> GLOBAL OPERATIONS · 지금 상태</span>
        <span className="v6-console-r"><i className="v6-pulse" />{Number.isFinite(genMs) ? `갱신 ${agoText(genMs)}` : '갱신 시각 없음'}</span>
      </div>

      <div className="v6-tiles">
        {tiles.map((t) => (
          <a key={t.id} className="v6-tile" href={t.go} style={{ '--acc': t.accent }} title={`${t.goLabel} 메뉴로`}>
            <div className="v6-tile-top"><span>{t.label}</span><span className="v6-tile-link">{t.goLabel} →</span></div>
            <div className="v6-tile-value">{t.value == null ? '—' : typeof t.value === 'number' ? fmt(t.value) : t.value}</div>
            <div className="v6-tile-parts">
              {t.parts.map((p) => <span key={p.k}><i className={`tone-${p.tone}`} />{p.k} <b>{fmt(p.v)}</b></span>)}
            </div>
            {t.note && <div className="v6-tile-note">{t.note}</div>}
          </a>
        ))}
      </div>

      <div className="v6-gauges">
        {gauges.map((x) => (
          <div key={x.id} className="v6-gauge">
            <div className="v6-gauge-top"><b>{x.label}</b><span className={`v6-gauge-pct tone-${x.tone}`}>{x.pct == null ? '—' : `${x.pct}%`}</span></div>
            <div className="v6-gauge-bar" aria-label={`${x.label} 사용률`}>
              <span className={`tone-${x.tone}`} style={{ width: `${Math.min(100, x.pct ?? 0)}%` }} />
              <em style={{ left: `${WARN_PCT}%` }} /><em style={{ left: `${CRIT_PCT}%` }} />
            </div>
            <div className="v6-gauge-sub">{x.used}{x.note && <> · <span className="v6-warn">{x.note}</span></>}</div>
          </div>
        ))}
      </div>

      <div className="v6-panel">
        <div className="v6-panel-head">
          <b>법인별 상태</b>
          <span>정상 {counts.ok} · 주의 {counts.warn} · 위험 {counts.crit}{counts.none ? ` · 판정 대기 ${counts.none}` : ''} — 이름순 · 상태 점은 CPU·메모리·스토리지 중 가장 높은 값(75% 주의 · 90% 위험)</span>
        </div>
        <div className="v6-segbar" role="group" aria-label="법인 구분">
          {SITE_GROUPS.map((x) => (
            <button key={x.id} type="button" className={`v6-segbtn${group === x.id ? ' on' : ''}`} aria-pressed={group === x.id}
              onClick={() => setGroup(x.id)} title={x.id === 'irs' ? "이름에 'IRS' 가 들어간 법인" : x.id === 'davinci' ? "이름에 'IRS' 가 없는 법인" : '모든 법인'}>
              {x.label} <b>{groupCounts[x.id]}</b>
            </button>
          ))}
        </div>
        {cards.length === 0 ? <div className="v6-note">{emptyGroupText(group)}</div> : (
        <div className="v6-sites">
          {cards.map((c) => (
            <button key={c.id} type="button" className="v6-site" onClick={() => onSelectSite?.(c.id)} title={`${c.name} 호스트 목록으로`}>
              <div className="v6-site-top"><i className={`tone-${c.tone}`} title={TONE_LABEL[c.tone]} /><b>{c.name}</b><span>{c.region}</span></div>
              <div className="v6-site-meta">알람 {c.alarms == null ? '—' : fmt(c.alarms)} · 호스트 {fmt(c.hosts)} · VM {fmt(c.vms)}</div>
              {c.bars.map((b) => (
                <div key={b.k} className="v6-mini"><span>{b.k}</span><div><i className={`tone-${b.tone}`} style={{ width: `${Math.min(100, b.v ?? 0)}%` }} /></div><em className={b.v != null && b.v >= WARN_PCT ? `tone-${b.tone}` : ''}>{b.v == null ? '—' : `${Math.round(b.v)}%`}</em></div>
              ))}
            </button>
          ))}
        </div>
        )}
      </div>

      <div className="v6-two">
        <div className="v6-panel">
          <div className="v6-panel-head"><b>최근 알람</b>{canAlarms && <a href="#/alarms">알람 전체 →</a>}</div>
          {alarmsErr && alarms && <div className="v6-banner warn">알람 갱신 실패(직전 목록 표시 중)</div>}
          {recent == null ? <div className="v6-note">알람 조회 권한(inv.alarms)이 없어 표시하지 않습니다.</div>
            : alarmsErr && !alarms ? <ErrorBox message={alarmsErr} />
            : recent.length === 0 ? <div className="v6-note">{alarms ? '활성 알람이 없습니다.' : '불러오는 중…'}</div>
              : recent.map((a) => (
                <div key={a.id} className={`v6-alarm sev-${a.sev}`}>
                  <span className={`v6-badge-s sev-${a.sev}`}>{a.sevLabel}</span>
                  <div><div className="v6-alarm-msg">{a.message}</div><div className="v6-alarm-sub">{a.entity} · {a.vcenterId}{a.ts ? ` · ${agoText(a.ts)}` : ''}</div></div>
                </div>
              ))}
        </div>
        <div className="v6-panel">
          <div className="v6-panel-head"><b>조치 필요</b><span>개수는 각 화면에서 확인합니다</span></div>
          {actions.length === 0 ? <div className="v6-note">열 수 있는 점검 화면이 없습니다.</div>
            : actions.map((a) => (
              <a key={a.k} className="v6-action" href={a.hash}><div><b>{a.label}</b><span>{a.desc}</span></div><em>열기 →</em></a>
            ))}
        </div>
      </div>
    </div>
  );
}
