/**
 * HoldList.jsx — 스냅샷 화면의 ‘보류’ 탭(v3.35.0 · 시안 docs/design/snapshot-holds ⑫ 1440 · ⑬ 400 · 사용자 '시안 권장안대로 구현해줘').
 *
 * 왜: 보류는 VM 줄에서만 걸고 풀 수 있어, VM 이 인벤토리에서 사라지면(지워짐 · 옮겨짐 · vCenter 등록 삭제) 기한(최대 90일)까지 풀 길이 없었다(153회차가 남긴 것).
 *   이 탭은 범위 안 보류 전부를 지금 상태와 함께 보여 주고, 관리자는 여기서 풀고(여러 건 한 번에) 스냅샷이 있는 VM 은 연장한다.
 * 정한 것(시안 권장안): 자리 = 표 위 탭 · 사라진 VM 의 보류 = 사람이 목록에서 푼다(자동으로 지우지 않는다) · 여러 건 풀기 = 넣는다.
 * 지금 상태는 서버(snaphist/view.js holdRows)가 정한다 — ‘확인 못 함’(그 vCenter 를 지금 못 읽음)을 ‘VM 없음’ 으로 단정하지 않는다.
 * 좁은 화면(720px 이하)은 표 대신 카드로 쌓는다(가로로 밀지 않음 · 여러 건 고르기는 넓은 화면에서만).
 */
import React, { useMemo, useState } from 'react';
import { postJson } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import { useNarrowScreen } from '../../../components/useNarrowScreen.js';
import { requireChanged } from '../../changeResult.js';
import { numOrNull } from '../../../numOrNull.js';
import { HOLD_VIEWS, HOLD_STATE_CLS, holdMatch, holdSummary, holdStateText, holdLeftDays, holdSort, holdKeyOf, holdPlaceText, dateText } from './snapText.js';

/**
 * 연장 창의 기본 기간(반증 r3350 D2): 창은 ‘오늘부터 N일’ 로 다시 건다 — 고정 30일이면 80일 남은 보류의 ‘연장’ 이 기간을 줄였다.
 *   남은 일수 이상인 가장 짧은 선택지(7 · 14 · 30 · 60 · 90)를 기본으로 둔다(남은 일수를 모르면 30).
 */
export function extendDays(h, now = Date.now()) {
  const left = holdLeftDays(h, now);
  if (left == null) return 30;
  return [7, 14, 30, 60, 90].find((d) => d >= left) ?? 90;
}

/** 보류 풀기 요청 → 안내 글. 여러 건 · 한 건 모두 이 한 경로(서버가 하나라도 걸리면 아무것도 풀지 않는다). */
export function releaseHoldKeys(keys, post = postJson) {
  return post('/tools/snapshots/holds/release', { keys: keys.map((k) => ({ vcenterId: k.vcenterId, vmId: k.vmId })) })
    .then((r) => { requireChanged(r); return `${numOrNull(r.released) ?? keys.length}건의 보류를 풀었습니다 — 다음 판정부터 사내 기준으로 다시 봅니다.`; });
}

function LeftBar({ h, now, daysMax, short = false }) {   // short = 표(끝나는 날 칸이 이미 노란색 — 칸 폭을 아낀다 · Chromium 1440 판독)
  const left = holdLeftDays(h, now);
  const soon = left != null && left <= 7;
  const pct = left == null ? 0 : Math.max(2, Math.min(100, Math.round((left / (daysMax || 90)) * 100)));
  return (
    <span className="snp-hleft" title={`남은 기간 — 막대 끝은 ${daysMax || 90}일`}>
      <span className="snp-track"><i style={{ width: `${pct}%`, background: soon ? '#fbbf24' : '#60a5fa' }} /></span>
      <b className={soon ? 'soon' : ''}>{left == null ? '—' : `${left}일${soon && !short ? ' · 곧 끝남' : ''}`}</b>
    </span>
  );
}

/**
 * @param {object} p
 * @param {object[]} p.rows      서버 holdRows(이미 고른 법인 카드로 거른 것)
 * @param {boolean} p.isAdmin    풀기 · 연장 · 고르기 · 건 사람 칸
 * @param {boolean} p.unreadable 보류 파일을 읽지 못함 — 풀기 · 연장을 잠근다
 * @param {Function} p.ExtendForm 연장 창(SnapshotTool 의 HoldForm — 같은 저장 경로 saveHold)
 */
export default function HoldList({ rows, isAdmin, unreadable = false, daysMax = 90, max = null, total = null, now = Date.now(), onChanged, ExtendForm }) {
  const narrow = useNarrowScreen('(max-width: 720px)');
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});
  const [ask, setAsk] = useState(null);      // { keys, label }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ext, setExt] = useState(null);      // 연장 창 { key, vcenterId, vmId, days, reason }
  const sum = holdSummary(rows, now);
  const ql = q.trim().toLowerCase();
  const shown = useMemo(() => holdSort(rows).filter((h) => holdMatch(h, view, now))
    .filter((h) => !ql || [h.vmName, h.heldName, h.corpName, h.vcName, h.reason, h.cluster].some((s) => s && String(s).toLowerCase().includes(ql))), [rows, view, ql, now]);
  const canWrite = isAdmin && !unreadable;
  // 반증 r3350: 쓰기 범위 밖 보류(서버 holdRows writable:false)는 풀기 · 고르기를 잠근다 — 섞어 고르면 서버가 전부 거절(403)한다.
  const rowWrite = (h) => canWrite && h.writable !== false;
  const selKeys = (rows || []).filter((h) => rowWrite(h) && sel[holdKeyOf(h)]);
  const pickable = shown.filter(rowWrite);
  const allOn = pickable.length > 0 && pickable.every((h) => sel[holdKeyOf(h)]);
  const showBy = isAdmin && (rows || []).some((h) => h.by);

  const askRelease = (hs, label) => { setErr(''); setExt(null); setAsk({ keys: hs, label }); };
  const doRelease = () => {
    if (!ask) return;
    setBusy(true); setErr('');
    releaseHoldKeys(ask.keys).then((m) => { setBusy(false); setAsk(null); setSel({}); onChanged?.(m); })
      .catch((e) => { setBusy(false); setErr(e.message); });
  };
  const releaseLabel = (h) => (h.state === 'gone' ? `‘${h.vmName}’ 은 VM 이 없어 보류만 지웁니다.` : `‘${h.vmName}’ 의 보류를 풉니다 — 다음 판정부터 사내 기준으로 다시 봅니다.`);
  const actions = (h) => canWrite && (!rowWrite(h) ? <span className="snp-note">쓰기 범위 밖</span> :
    <span className="snp-hact">
      {h.state === 'has' && ExtendForm && (
        <button type="button" className="snp-btn sm" onClick={() => { setAsk(null); setExt(ext?.key === holdKeyOf(h) ? null : { key: holdKeyOf(h), vcenterId: h.vcenterId, vmId: h.vmId, days: extendDays(h, now), reason: h.reason || '' }); }}>연장…</button>
      )}
      <button type="button" className="snp-btn sm" onClick={() => askRelease([h], releaseLabel(h))}>풀기</button>
    </span>
  );
  const extRow = ext && (rows || []).find((h) => holdKeyOf(h) === ext.key);

  return (
    <div className="snp-holds">
      {unreadable && <div className="snp-note warn">보류 목록 파일을 읽지 못했습니다 — 마지막으로 읽은 목록을 보여 줍니다(원본은 그대로 · 다시 읽음). 그동안 풀기 · 연장은 잠급니다.</div>}
      <div className="snp-hkpis" aria-label="보류 요약">
        <div className="snp-kp"><span className="l">보류 중</span><span className="v">{sum.n.toLocaleString('en-US')}</span>
          <span className="s">법인 {sum.corps}곳{max ? ` · 상한 ${max.toLocaleString('en-US')}건${total != null ? `(전체 ${total.toLocaleString('en-US')}건)` : ''}` : ''}</span></div>
        <div className="snp-kp"><span className="l">7일 안에 끝남</span><span className="v" style={{ color: sum.soon ? '#fbbf24' : undefined }}>{sum.soon}</span>
          <span className="s">끝나면 다시 판정에 들어옵니다</span></div>
        <div className="snp-kp"><span className="l">대상이 사라진 보류</span><span className="v" style={{ color: sum.gone ? '#fca5a5' : undefined }}>{sum.gone}</span>
          <span className="s">VM 이 인벤토리에 없음</span></div>
        <div className="snp-kp"><span className="l">스냅샷이 없는 VM 의 보류</span><span className="v" style={{ color: sum.none ? '#fcd34d' : undefined }}>{sum.none}</span>
          <span className="s">이미 정리됨 — 보류만 남음{sum.unknown ? ` · 확인 못 함 ${sum.unknown}건은 따로` : ''}</span></div>
      </div>
      <div className="snp-flt">
        <span className="lb">빠른 보기</span>
        {HOLD_VIEWS.filter(([k]) => k !== 'unknown' || sum.unknown).map(([k, label]) => (
          <button key={k} type="button" className={`snp-chip${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => setView(k)}>
            {label}<b>{(rows || []).filter((h) => holdMatch(h, k, now)).length}</b>
          </button>
        ))}
        <input className="snp-find" type="search" aria-label="보류 찾기 — VM · 법인 · 사유" placeholder="VM · 법인 · 사유" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {sum.gone > 0 && (
        <div className="snp-hwarn">대상이 사라진 보류 <b>{sum.gone}건</b> — VM 이 인벤토리에 없습니다(지워졌거나 다른 vCenter 로 옮겨짐 · vCenter 등록 삭제). 기한이 지나면 스스로 빠지지만 그때까지 상한에 들어갑니다.
          {canWrite ? ' 아래에서 바로 풀 수 있습니다.' : isAdmin ? '' : ' 관리자가 풀 수 있습니다.'}</div>
      )}
      {canWrite && !narrow && selKeys.length > 0 && (
        <div className="snp-selbar" aria-live="polite">
          <span>고른 보류 {selKeys.length}건</span>
          <button type="button" className="snp-btn sm" onClick={() => askRelease(selKeys, `고른 보류 ${selKeys.length}건을 풉니다 — 다음 판정부터 사내 기준으로 다시 봅니다.`)}>고른 것 풀기</button>
          <button type="button" className="snp-btn sm" onClick={() => setSel({})}>선택 풀기</button>
        </div>
      )}
      {ask && (
        <div className="snp-hask" role="alertdialog" aria-label="보류 풀기 확인">
          <span>{ask.label}</span>
          <button type="button" className="snp-btn sm" onClick={doRelease} disabled={busy}>{busy ? '푸는 중…' : '풀기'}</button>
          <button type="button" className="snp-btn sm" onClick={() => { setAsk(null); setErr(''); }} disabled={busy}>닫기</button>
          {err && <span className="snp-note warn">풀지 못했습니다 — {err}</span>}
        </div>
      )}
      {/* 연장 창은 표 밖(위)에 — 표 줄 사이에 끼우면 제목 정렬(STable — tbody 의 줄을 다시 배열)이 짝을 잃는다 */}
      {extRow && ExtendForm && (
        <div className="snp-hext" aria-label={`${extRow.vmName} 보류 연장`}>
          <span><b>{extRow.vmName}</b> 연장 — 오늘부터 고른 기간 · 사유는 그대로 채워 둡니다</span>
          <ExtendForm form={ext} setForm={setExt} held onDone={(m) => { setExt(null); onChanged?.(m); }} />
        </div>
      )}
      {narrow ? (
        <div className="snp-hcards">
          {shown.map((h) => (
            <div key={holdKeyOf(h)} className={`snp-hcard${h.state === 'gone' ? ' gone' : ''}`}>
              <div className="hd"><span className="nm"><b>{h.vmName}</b><span className="snp-note">{holdPlaceText(h, false)}</span></span>
                <em className={`snp-tg ${HOLD_STATE_CLS[h.state] || 'x'}`}>{holdStateText(h)}</em></div>
              <div className="rs">{h.reason || '—'}</div>
              <div className="ft"><LeftBar h={h} now={now} daysMax={daysMax} /><span className="snp-mono">{dateText(h.until)}</span></div>
              {showBy && h.by && <div className="snp-note">건 사람 {h.by} · {dateText(h.at)}</div>}
              {actions(h)}
            </div>
          ))}
        </div>
      ) : (
        <STable className="snp-tbl" minWidth={1100}>
          <thead>
            <tr>
              {canWrite && <th className="nos"><button type="button" className={`snp-ck${allOn ? ' on' : ''}`} aria-pressed={allOn} aria-label="보이는 보류 모두 고르기"
                onClick={() => setSel((s) => { const n = { ...s }; for (const h of pickable) { if (allOn) delete n[holdKeyOf(h)]; else n[holdKeyOf(h)] = true; } return n; })}>{allOn ? '✓' : ''}</button></th>}
              <th>VM</th><th>지금 상태</th><th>사유</th>{showBy && <th>건 사람</th>}<th>건 날</th><th>끝나는 날</th><th>남은 기간</th>{canWrite && <th className="nos r" data-nosort>동작</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((h) => {
              const k = holdKeyOf(h);
              const left = holdLeftDays(h, now);
              return (
                  <tr key={k} className={`vm${sel[k] ? ' open' : ''}`}>
                    {canWrite && <td>{rowWrite(h) && <button type="button" className={`snp-ck${sel[k] ? ' on' : ''}`} aria-pressed={!!sel[k]} aria-label={`${h.vmName} 고르기`}
                      onClick={() => setSel((s) => { const n = { ...s }; if (n[k]) delete n[k]; else n[k] = true; return n; })}>{sel[k] ? '✓' : ''}</button>}</td>}
                    <td data-sort={h.vmName}><b className="snp-hvm">{h.vmName}</b>
                      <span className="snp-sub" title={holdPlaceText(h, true)}>{holdPlaceText(h, true)}</span></td>
                    <td data-sort={h.state}><em className={`snp-tg ${HOLD_STATE_CLS[h.state] || 'x'}`}>{holdStateText(h)}</em></td>
                    <td className="snp-hrs">{h.reason || '—'}</td>
                    {showBy && <td className="snp-mono">{h.by || '—'}</td>}
                    <td className="snp-mono" data-sort={numOrNull(h.at) ?? ''}>{dateText(h.at)}</td>
                    <td className="snp-mono" data-sort={numOrNull(h.until) ?? ''} style={{ color: left != null && left <= 7 ? '#fbbf24' : undefined }}>{dateText(h.until)}</td>
                    <td data-sort={left ?? ''}><LeftBar h={h} now={now} daysMax={daysMax} short /></td>
                    {canWrite && <td className="r">{actions(h)}</td>}
                  </tr>
              );
            })}
          </tbody>
        </STable>
      )}
      {!shown.length && <div className="snp-empty">{(rows || []).length ? '이 조건에 맞는 보류가 없습니다.' : '보류한 VM 이 없습니다.'}</div>}
      <div className="snp-note">보류는 기한이 있는 예외입니다(1 ~ {daysMax}일 · 사유 필수){isAdmin ? ' · 풀기 · 연장은 관리자만 할 수 있고 감사 기록에 남습니다' : ' · 풀기 · 연장은 관리자만 할 수 있습니다'} · 연장하면 건 사람 · 건 날이 연장한 사람 · 오늘로 바뀝니다.</div>
    </div>
  );
}
