/**
 * 물리서버 폴더 — 맵 보기(v2.987 · 시안 ② Map.dc.html). 칸 하나 = 서버 한 대 · 묶기(폴더 · 법인 · 모델) · 색(CPU · 메모리 · 전력 · 장애).
 * 칸은 button(키보드 · aria-label) — 누르면 옆 패널. 색만으로 뜻을 전하지 않는다(장애는 테두리 · 못 읽음은 점선 빈 칸 · 꺼짐은 회색 + 이름표).
 * 판정(색 단계 · 묶음)은 bmFoldersText.js(cellTone · mapGroups · aggregate) — 여기는 그리기만.
 */
import React, { useMemo } from 'react';
import Select from '../../../components/Select.jsx';
import { STable } from '../../../components/STable.jsx';
import { mapGroups, cellTone, aggregate, pctText, wattsText } from '../bmFoldersText.js';
import { UsageBar } from './parts.jsx';

const GROUP_LABEL = { folder: '폴더', corp: '법인', model: '모델' };
const COLOR_LABEL = { cpu: 'CPU 사용률', mem: '메모리 사용률', watts: '전력', fault: '부품 장애' };
const CELL_MAX = 400;   // 묶음 하나에 그리는 칸 상한 — 넘치면 개수를 밝힌다(조용히 자르지 않는다)

export default function MapView({ rows, groupBy, setGroupBy, colorBy, setColorBy, corpName, onPick, picked }) {
  const groups = useMemo(() => mapGroups(rows, groupBy, corpName), [rows, groupBy, corpName]);
  // 폴더로 묶었는데 법인이 여럿이면 같은 이름 폴더가 법인마다 따로 서므로 법인 이름을 앞에 붙인다
  const multiCorp = useMemo(() => groupBy === 'folder' && new Set(rows.map((r) => r.corp)).size > 1, [rows, groupBy]);
  const labelOf = (g) => (multiCorp && g.corp !== undefined ? `${g.corp ? corpName(g.corp) : '(법인 미지정)'} › ${g.label}` : g.label);
  const maxW = useMemo(() => rows.reduce((m, r) => (r.watts > m ? r.watts : m), 0) || null, [rows]);
  const summary = useMemo(() => groups.map((g) => ({ g, a: aggregate(g.rows) })), [groups]);
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '8px 14px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
        <span className="muted" style={{ fontSize: 12 }}>묶기</span>
        <Select className="select" sort={false} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label="묶기" style={{ maxWidth: 120 }}>
          {Object.entries(GROUP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <span className="muted" style={{ fontSize: 12 }}>색</span>
        <Select className="select" sort={false} value={colorBy} onChange={(e) => setColorBy(e.target.value)} aria-label="색 기준" style={{ maxWidth: 150 }}>
          {Object.entries(COLOR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <span className="flex wrap" style={{ gap: '4px 10px', fontSize: 11.5, alignItems: 'center' }} aria-label="범례">
          {colorBy === 'fault' ? (
            <><span className="bmf-lg"><i className="bmf-hx u1" />장애 없음</span><span className="bmf-lg"><i className="bmf-hx u5" />장애</span></>
          ) : (
            <span className="bmf-lg">{colorBy === 'watts' ? '낮음' : '0%'}<span className="flex" style={{ gap: 2 }}>{['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => <i key={u} className={`bmf-hx ${u}`} style={{ width: 14, height: 9 }} />)}</span>{colorBy === 'watts' ? '높음' : '100%'}</span>
          )}
          <span className="bmf-lg"><i className="bmf-hx na" />못 읽음</span>
          <span className="bmf-lg"><i className="bmf-hx off" />꺼짐</span>
          <span className="bmf-lg"><i className="bmf-hx u2 bad" />부품 장애</span>
        </span>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>칸 하나 = 서버 한 대 · 누르면 옆 패널</span>
      </div>
      {!rows.length ? <div className="muted" style={{ padding: 16 }}>서버가 없습니다.</div> : (
        <div className="bmf-map">
          {groups.map((g) => (
            <div key={g.key} className={`bmf-grp${g.un ? ' un' : ''}`}>
              <div className="bmf-gh">
                <span className="nm" title={labelOf(g)}>{labelOf(g)}</span>
                <span className="muted">{g.rows.length}</span>
              </div>
              <div className="bmf-hxs">
                {g.rows.slice(0, CELL_MAX).map((r) => {
                  const t = cellTone(r, colorBy, maxW);
                  return (
                    <button key={r.key} type="button" className={`bmf-hx ${t.tone}${t.bad ? ' bad' : ''}${picked === r.key ? ' pick' : ''}`}
                      aria-label={`${r.name} — ${t.label}`} title={`${r.name} — ${t.label}`} onClick={() => onPick(r.key)} />
                  );
                })}
              </div>
              {g.rows.length > CELL_MAX ? <div className="muted" style={{ fontSize: 12 }}>앞 {CELL_MAX}대만 그렸습니다(전체 {g.rows.length}대 — 목록 보기에서 거르십시오).</div> : null}
            </div>
          ))}
        </div>
      )}
      {summary.length ? (
        <STable className="table bmf-t" minWidth={620}>
          <thead><tr><th>{GROUP_LABEL[groupBy]}</th><th>서버</th><th>CPU(용량 가중)</th><th>메모리(용량 가중)</th><th>전력</th><th>부품 장애</th><th>참고</th></tr></thead>
          <tbody>
            {summary.map(({ g, a }) => (
              <tr key={g.key}>
                <td data-sort={g.un ? '\uffff' : labelOf(g)}><b style={g.un ? { color: '#fbbf24' } : undefined}>{labelOf(g)}</b></td>
                <td data-sort={a.n}>{a.n}</td>
                <td data-sort={a.cpu ?? ''}><UsageBar v={a.cpu} w={70} /></td>
                <td data-sort={a.mem ?? ''}><UsageBar v={a.mem} w={70} /></td>
                <td data-sort={a.watts ?? ''} style={{ whiteSpace: 'nowrap' }}>{wattsText(a.watts)}</td>
                <td data-sort={a.faults}>{a.faults ? <span className="badge red">{a.faults}</span> : a.faultsUnknown === a.n && a.n ? <span className="muted">—</span> : 0}</td>
                <td className="muted" style={{ fontSize: 12 }}>{[a.usageMissing ? `못 읽음 ${a.usageMissing}` : '', a.off ? `꺼짐 ${a.off}` : '', a.faultsUnknown ? `장애 모름 ${a.faultsUnknown}` : ''].filter(Boolean).join(' · ') || (a.usageN ? `${a.usageN}대 기준 ${pctText(a.cpu)}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      ) : null}
    </div>
  );
}
