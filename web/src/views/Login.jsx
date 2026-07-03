import React, { useEffect, useRef, useState } from 'react';
import { login, getToken } from '../api.js';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import geoData from 'world-atlas/countries-110m.json';

// 브라우저에 남아있는 SSO 토큰(JWT)의 payload를 디코드해 표시 이름을 추출(서명검증 아님 — 인사말 표시용).
function nameFromToken() {
  try {
    const t = getToken(); if (!t) return '';
    const p = JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
    return p?.name || p?.username || p?.sub || '';
  } catch { return ''; }
}

// ---- 도트 월드맵 배경 (Davinci Login 디자인) --------------------------------
// world-atlas 육지 실루엣을 오프스크린 캔버스에 그린 뒤, 그리드 샘플링으로 육지 위치에만
// 점을 찍는다(하프톤 도트 맵). 글로우 마커(주요 사이트)는 같은 투영으로 좌표를 계산해
// DOM 오버레이(펄스 애니메이션)로 얹는다. 마운트/리사이즈 시에만 계산 — 런타임 부하 없음.
const SITES = [
  { code: 'PDX', lon: -122.68, lat: 45.52 },
  { code: 'IAD', lon: -77.45, lat: 38.95 },
  { code: 'GRU', lon: -46.47, lat: -23.43 },
  { code: 'LHR', lon: -0.45, lat: 51.47 },
  { code: 'FRA', lon: 8.57, lat: 50.03 },
  { code: 'ICN', lon: 126.45, lat: 37.46 },
  { code: 'NRT', lon: 140.39, lat: 35.77 },
];

function DotMap() {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [markers, setMarkers] = useState([]);

  useEffect(() => {
    const land = feature(geoData, geoData.objects.countries);
    const draw = () => {
      const wrap = wrapRef.current, canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;

      // 화면을 꽉 채우도록 지도를 살짝 오버스캔(디자인처럼 가장자리가 잘려 보이게).
      const projection = geoEquirectangular().fitExtent([[-w * 0.06, -h * 0.14], [w * 1.06, h * 1.34]], { type: 'Sphere' });

      // 육지 실루엣 → 픽셀 샘플링
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const path = geoPath(projection, octx);
      octx.fillStyle = '#fff';
      octx.beginPath(); path(land); octx.fill();
      const img = octx.getImageData(0, 0, w, h).data;

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const step = Math.max(7, Math.round(w / 225));
      for (let y = Math.floor(step / 2); y < h; y += step) {
        for (let x = Math.floor(step / 2); x < w; x += step) {
          if (!img[(y * w + x) * 4 + 3]) continue; // 바다 → skip
          // 결정적 의사난수(리사이즈에도 패턴이 안정적이게) — 크기/밝기에 미세 변화.
          const rnd = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          const a = 0.2 + ((rnd % 100) / 100) * 0.3;
          const r = step * (0.2 + ((rnd >> 8) % 60) / 100 * 0.12);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(125, 150, 175, ${a.toFixed(2)})`;
          ctx.fill();
        }
      }
      setMarkers(SITES.map((s) => {
        const [mx, my] = projection([s.lon, s.lat]) || [0, 0];
        return { ...s, x: mx, y: my };
      }).filter((m) => m.x > 8 && m.x < w - 8 && m.y > 8 && m.y < h - 8));
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="dv-map" aria-hidden="true">
      <canvas ref={canvasRef} />
      {markers.map((m) => (
        <div key={m.code} className="dv-marker" style={{ left: m.x, top: m.y }}>
          <span className="dv-marker-ring" />
          <span className="dv-marker-dot" />
          <span className="dv-marker-label">{m.code}</span>
        </div>
      ))}
    </div>
  );
}

// 좌측 하단 라이브 로그 티커(정적 3줄 — 렌더 시각 기준 UTC 타임스탬프).
function tickerLines() {
  const fmt = (msAgo) => {
    const d = new Date(Date.now() - msAgo);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  };
  return [
    { t: fmt(4_000), msg: 'icn-03 · rack B7 · thermal nominal' },
    { t: fmt(9_000), msg: 'fra-01 · failover drill complete' },
    { t: fmt(25_000), msg: 'sin-02 · uptime 99.99% · 31d window' },
  ];
}

const DV_CSS = `
.dv-root { position: fixed; inset: 0; overflow: auto; background: #0a0e15; color: #e6edf3;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace; }
.dv-map { position: absolute; inset: 0; pointer-events: none; }
.dv-map canvas { display: block; }
.dv-root::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 30% 40%, transparent 40%, rgba(5, 8, 13, .55) 100%); }
.dv-marker { position: absolute; transform: translate(-50%, -50%); }
.dv-marker-dot { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%;
  background: #2dd4bf; box-shadow: 0 0 10px 2px rgba(45, 212, 191, .7); }
.dv-marker-ring { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid rgba(45, 212, 191, .55); animation: dvPulse 2.6s ease-out infinite; }
.dv-marker-label { position: absolute; left: 12px; top: -7px; font-size: 10px; letter-spacing: .12em; color: #9fb6c9; }
@keyframes dvPulse { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(1.9); opacity: 0; } }

.dv-topbar { position: relative; z-index: 2; display: flex; justify-content: space-between; align-items: flex-start;
  padding: 26px 40px 0; }
.dv-brand { display: flex; gap: 14px; align-items: center; }
.dv-logo { width: 40px; height: 40px; border: 1px solid rgba(45, 212, 191, .55); border-radius: 9px;
  display: flex; align-items: center; justify-content: center; }
.dv-logo i { width: 12px; height: 12px; background: #2dd4bf; transform: rotate(45deg); border-radius: 2px;
  box-shadow: 0 0 12px rgba(45, 212, 191, .8); }
.dv-brand-title { font-size: 14px; font-weight: 700; letter-spacing: .38em; color: #fff; }
.dv-brand-sub { margin-top: 4px; font-size: 9.5px; letter-spacing: .32em; color: #5b6b7f; }
.dv-net { font-size: 10.5px; letter-spacing: .25em; color: #5b6b7f; display: flex; align-items: center; gap: 8px; padding-top: 6px; }
.dv-net i { width: 7px; height: 7px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 8px rgba(45,212,191,.8); }

.dv-main { position: relative; z-index: 2; display: flex; align-items: center; gap: 64px;
  max-width: 1560px; margin: 0 auto; padding: 72px 56px 56px; min-height: calc(100vh - 92px); box-sizing: border-box; }
.dv-hero { flex: 1; min-width: 0; }
.dv-hero-label { font-size: 11.5px; letter-spacing: .3em; color: #8ea0b5; }
.dv-hero-label b { color: #2dd4bf; margin-right: 10px; font-weight: 400; }
.dv-hero h1 { margin: 26px 0 0; font-size: clamp(38px, 4.6vw, 62px); font-weight: 700; line-height: 1.18;
  letter-spacing: -0.01em; color: #fff; }
.dv-hero p { margin: 26px 0 0; max-width: 480px; font-size: 14.5px; line-height: 1.85; color: #8ea0b5; }
.dv-ticker { margin-top: 44px; font-size: 12.5px; line-height: 2.2; color: #55677c; }
.dv-ticker b { color: #2dd4bf; font-weight: 400; padding: 0 6px; }

.dv-card { position: relative; width: 430px; flex: none; background: rgba(13, 20, 28, .93);
  border: 1px solid #223140; border-radius: 10px; box-shadow: 0 30px 90px rgba(0, 0, 0, .55); }
.dv-card-head { display: flex; justify-content: space-between; padding: 13px 20px; border-bottom: 1px solid #1c2937;
  font-size: 10.5px; letter-spacing: .18em; color: #64748b; }
.dv-card-head b { color: #2dd4bf; font-weight: 400; margin-right: 8px; }
.dv-card-body { padding: 26px 26px 22px; }
.dv-card h2 { margin: 4px 0 0; font-size: 23px; font-weight: 700; color: #fff; letter-spacing: -0.01em; }
.dv-card-sub { margin-top: 8px; font-size: 12.5px; color: #8ea0b5; }
.dv-field-label { margin: 22px 0 8px; font-size: 10.5px; letter-spacing: .22em; color: #64748b; }
.dv-input-wrap { position: relative; }
.dv-input { width: 100%; box-sizing: border-box; background: #0a1017; border: 1px solid #223140; border-radius: 6px;
  padding: 12px 14px; color: #e6edf3; font: inherit; font-size: 14px; }
.dv-input::placeholder { color: #3d4e60; }
.dv-input:focus { outline: none; border-color: #2dd4bf; box-shadow: 0 0 0 2px rgba(45, 212, 191, .15); }
.dv-show { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none;
  cursor: pointer; font: inherit; font-size: 10.5px; letter-spacing: .18em; color: #64748b; padding: 4px 6px; }
.dv-show:hover { color: #2dd4bf; }
.dv-row { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; }
.dv-keep { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 10.5px; letter-spacing: .18em; color: #94a3b8; user-select: none; }
.dv-keep input { position: absolute; opacity: 0; }
.dv-check { width: 16px; height: 16px; flex: none; border: 1px solid #2dd4bf; border-radius: 3px;
  display: flex; align-items: center; justify-content: center; font-size: 11px; color: #06251d; }
.dv-keep input:checked + .dv-check { background: #2dd4bf; }
.dv-keep input:checked + .dv-check::after { content: '✓'; font-weight: 700; }
.dv-forgot { background: none; border: none; cursor: pointer; font: inherit; font-size: 10.5px; letter-spacing: .18em; color: #64748b; padding: 0; }
.dv-forgot:hover { color: #2dd4bf; }
.dv-auth-btn { width: 100%; margin-top: 22px; padding: 15px; border: none; border-radius: 6px; cursor: pointer;
  background: #34e0b4; color: #052e25; font: inherit; font-size: 12.5px; font-weight: 700; letter-spacing: .3em; }
.dv-auth-btn:hover:not(:disabled) { filter: brightness(1.08); }
.dv-auth-btn:disabled { opacity: .45; cursor: default; }
.dv-restrict { margin-top: 22px; padding-top: 16px; border-top: 1px solid #1c2937; font-size: 10.5px;
  line-height: 1.9; letter-spacing: .04em; color: #54657a; }
.dv-error { margin-top: 14px; font-size: 12px; color: #f87171; line-height: 1.6; }
.dv-notice { margin-top: 12px; font-size: 12px; color: #fbbf24; line-height: 1.6; }
.dv-welcome { margin-top: 12px; font-size: 12px; color: #2dd4bf; }
.dv-hint { margin-top: 10px; font-size: 11px; color: #64748b; line-height: 1.7; }

@media (max-width: 1080px) {
  .dv-main { flex-direction: column; align-items: stretch; gap: 40px; padding: 48px 24px 40px; }
  .dv-card { width: 100%; max-width: 460px; margin: 0 auto; }
  .dv-hero p { max-width: none; }
}
`;

export default function Login({ onSuccess, notice }) {
  const [welcome] = useState(nameFromToken);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [keep, setKeep] = useState(true);
  const [forgotInfo, setForgotInfo] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState(0);
  const [warn, setWarn] = useState(false); // 3회 실패 경고창
  const [ticker] = useState(tickerLines);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password, { keep });
      setFails(0);
      onSuccess(user);
    } catch (err) {
      setError(err.message);
      // updater 안에서 setWarn을 호출하지 않는다(React updater는 순수해야 하며 StrictMode에서
      // 이중 호출됨). 다음 실패 횟수를 밖에서 계산해 상태를 갱신한다.
      const c = fails + 1;
      setFails(c);
      if (c >= 3) setWarn(true); // 3회 연속 실패 → 법적 경고
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dv-root">
      <style>{DV_CSS}</style>
      <DotMap />

      {warn && (
        <div className="modal-overlay" style={{ zIndex: 50 }} onClick={(e) => { if (e.target === e.currentTarget) setWarn(false); }}>
          <div className="modal card" style={{ maxWidth: 460, border: '1px solid var(--red,#ef4444)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 22 }}>⚠️</span>
              <b style={{ fontSize: 16, color: 'var(--red,#ef4444)' }}>접근 경고</b>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              로그인이 <b>{fails}회</b> 실패했습니다.<br />
              <b>인가되지 않은 접근은 법적인 책임이 있습니다.</b><br />
              접속하신 <b>IP</b> 와 <b>SSO 계정</b>은 기록됩니다.
            </div>
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} onClick={() => setWarn(false)}>확인</button>
            </div>
          </div>
        </div>
      )}

      <div className="dv-topbar">
        <div className="dv-brand">
          <div className="dv-logo"><i /></div>
          <div>
            <div className="dv-brand-title">THE DAVINCI</div>
            <div className="dv-brand-sub">GLOBAL INFRASTRUCTURE MONITOR</div>
          </div>
        </div>
        <div className="dv-net"><i />NETWORK STATUS · NOMINAL</div>
      </div>

      <div className="dv-main">
        <div className="dv-hero">
          <div className="dv-hero-label"><b>▸</b>GLOBAL INFRASTRUCTURE CONSOLE</div>
          <h1>Eyes on every rack,<br />in every region.</h1>
          <p>
            The Davinci streams live telemetry from 5,800+ VMs and 650+ servers
            across 28 vCenters worldwide — one console, zero blind spots.
          </p>
          <div className="dv-ticker">
            {ticker.map((l) => <div key={l.msg}>{l.t}<b>▸</b>{l.msg}</div>)}
          </div>
        </div>

        <form className="dv-card" onSubmit={submit}>
          <div className="dv-card-head"><span><b>&gt;_</b>SECURE ACCESS // AUTH-01</span><span>TLS 1.3</span></div>
          <div className="dv-card-body">
            <h2>Operator Sign In</h2>
            <div className="dv-card-sub">Authenticate to enter the monitoring console.</div>

            {welcome && !notice && <div className="dv-welcome"><b>{welcome}</b>님 환영합니다 👋</div>}
            {notice && <div className="dv-notice">{notice}</div>}

            <div className="dv-field-label">OPERATOR ID</div>
            <input className="dv-input" autoFocus autoComplete="username" value={username}
              onChange={(e) => setUsername(e.target.value)} placeholder="admin" />

            <div className="dv-field-label">PASSWORD</div>
            <div className="dv-input-wrap">
              <input className="dv-input" style={{ paddingRight: 62 }} type={showPw ? 'text' : 'password'}
                autoComplete="one-time-code" value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="비밀번호 또는 6자리 OTP" />
              <button type="button" className="dv-show" onClick={() => setShowPw((v) => !v)}>{showPw ? 'HIDE' : 'SHOW'}</button>
            </div>

            <div className="dv-row">
              <label className="dv-keep">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                <span className="dv-check" />
                KEEP SESSION · 8H
              </label>
              <button type="button" className="dv-forgot" onClick={() => setForgotInfo((v) => !v)}>FORGOT PASSWORD?</button>
            </div>
            {forgotInfo && <div className="dv-hint">비밀번호 초기화는 포탈 관리자에게 요청하세요 (사용자 관리 → 비밀번호 재설정). 체크 해제 시 브라우저를 닫으면 자동 로그아웃됩니다.</div>}

            {error && <div className="dv-error">{error}</div>}

            <button className="dv-auth-btn" type="submit" disabled={busy || !username || !password}>
              {busy ? 'AUTHENTICATING…' : 'AUTHENTICATE →'}
            </button>

            <div className="dv-restrict">
              RESTRICTED SYSTEM — Authorized operators only. All authentication
              attempts and sessions are logged and audited. OTP 등록 계정은 Google OTP
              6자리 코드로 로그인합니다.
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
