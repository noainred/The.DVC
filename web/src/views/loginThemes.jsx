import React, { useEffect, useRef, useState } from 'react';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import geoData from 'world-atlas/countries-110m.json';

// ─────────────────────────────────────────────────────────────────────────────
// 로그인 화면 테마 10종 — 로그인마다 랜덤으로 하나가 표시된다(재미 요소).
// 공통 입력/제출 로직은 Login.jsx 가 소유하고, 각 테마에는 폼 바인딩 객체 f 만 넘긴다.
// 시각 차이는 배경 + CSS 변수(팔레트/폰트/라운드)로 낸다. 공통 필드는 AuthFields 로 재사용.
// ─────────────────────────────────────────────────────────────────────────────

const RESTRICT = 'RESTRICTED SYSTEM — Authorized operators only. 모든 인증 시도와 세션은 기록·감사됩니다. OTP 등록 계정은 Google OTP 6자리 코드로 로그인합니다.';

// 공통 입력 블록 — 모든 테마가 동일한 계정/비번/세션유지/제출을 공유(스타일만 테마별).
export function AuthFields({ f, title = 'Operator Sign In', sub = 'Authenticate to enter the monitoring console.', btn = 'AUTHENTICATE', idLabel = 'OPERATOR ID', pwLabel = 'PASSWORD', head }) {
  return (
    <>
      {head && <div className="lt-head">{head}</div>}
      <div className="lt-card-body">
        <h2 className="lt-title">{title}</h2>
        <div className="lt-sub">{sub}</div>

        {f.welcome && !f.notice && <div className="lt-welcome"><b>{f.welcome}</b>님 환영합니다 👋</div>}
        {f.notice && <div className="lt-notice">{f.notice}</div>}

        <label className="lt-lab">{idLabel}</label>
        <input className="lt-input" autoFocus autoComplete="username" value={f.username}
          onChange={(e) => f.setUsername(e.target.value)} placeholder="admin" />

        <label className="lt-lab">{pwLabel}</label>
        <div className="lt-pw">
          <input className="lt-input" style={{ paddingRight: 62 }} type={f.showPw ? 'text' : 'password'}
            autoComplete="one-time-code" value={f.password}
            onChange={(e) => f.setPassword(e.target.value)} placeholder="비밀번호 또는 6자리 OTP" />
          <button type="button" className="lt-show" onClick={() => f.setShowPw((v) => !v)}>{f.showPw ? 'HIDE' : 'SHOW'}</button>
        </div>

        <div className="lt-row">
          <label className="lt-keep">
            <input type="checkbox" checked={f.keep} onChange={(e) => f.setKeep(e.target.checked)} />
            <span className="lt-check" />KEEP SESSION · 8H
          </label>
          <button type="button" className="lt-forgot" onClick={f.toggleForgot}>FORGOT PASSWORD?</button>
        </div>
        {f.forgotInfo && <div className="lt-hint">비밀번호 초기화는 포탈 관리자에게 요청하세요 (사용자 관리 → 비밀번호 재설정). 체크 해제 시 브라우저를 닫으면 자동 로그아웃됩니다.</div>}

        {f.error && <div className="lt-error">{f.error}</div>}

        <button className="lt-btn" type="submit" disabled={f.busy || !f.username || !f.password}>
          {f.busy ? 'AUTHENTICATING…' : `${btn} →`}
        </button>

        <div className="lt-restrict">{RESTRICT}</div>
      </div>
    </>
  );
}

// 카드 하나를 화면 중앙에 놓는 공통 래퍼(대부분의 테마가 사용).
function Centered({ cls, bg, children, f, fields }) {
  return (
    <div className={`lt ${cls}`}>
      {bg}
      <form className="lt-card" onSubmit={f.submit}>{fields}</form>
      {children}
    </div>
  );
}

/* ───────────────────────── 배경 컴포넌트 ───────────────────────── */

// ① 도트 월드맵(Davinci 오리지널) — 육지 실루엣을 하프톤 도트로, 주요 사이트는 펄스 마커.
const SITES = [
  { code: 'PDX', lon: -122.68, lat: 45.52 }, { code: 'IAD', lon: -77.45, lat: 38.95 },
  { code: 'GRU', lon: -46.47, lat: -23.43 }, { code: 'LHR', lon: -0.45, lat: 51.47 },
  { code: 'FRA', lon: 8.57, lat: 50.03 }, { code: 'ICN', lon: 126.45, lat: 37.46 },
  { code: 'NRT', lon: 140.39, lat: 35.77 },
];
function DotMap() {
  const wrapRef = useRef(null); const canvasRef = useRef(null);
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
      const projection = geoEquirectangular().fitExtent([[-w * 0.06, -h * 0.14], [w * 1.06, h * 1.34]], { type: 'Sphere' });
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const path = geoPath(projection, octx);
      octx.fillStyle = '#fff'; octx.beginPath(); path(land); octx.fill();
      const img = octx.getImageData(0, 0, w, h).data;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const step = Math.max(7, Math.round(w / 225));
      for (let y = Math.floor(step / 2); y < h; y += step) {
        for (let x = Math.floor(step / 2); x < w; x += step) {
          if (!img[(y * w + x) * 4 + 3]) continue;
          const rnd = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          const a = 0.2 + ((rnd % 100) / 100) * 0.3;
          const r = step * (0.2 + ((rnd >> 8) % 60) / 100 * 0.12);
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(125, 150, 175, ${a.toFixed(2)})`; ctx.fill();
        }
      }
      setMarkers(SITES.map((s) => { const [mx, my] = projection([s.lon, s.lat]) || [0, 0]; return { ...s, x: mx, y: my }; })
        .filter((m) => m.x > 8 && m.x < w - 8 && m.y > 8 && m.y < h - 8));
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
          <span className="dv-marker-ring" /><span className="dv-marker-dot" /><span className="dv-marker-label">{m.code}</span>
        </div>
      ))}
    </div>
  );
}

// ② 매트릭스 코드 레인.
function MatrixRain({ color = '#22c55e' }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf, cols, drops, w, h; const font = 16;
    const chars = 'アカサタナ0123456789ABCDEFﾊﾋﾌﾍﾎ01'.split('');
    const resize = () => {
      w = canvas.width = canvas.clientWidth; h = canvas.height = canvas.clientHeight;
      cols = Math.ceil(w / font); drops = Array.from({ length: cols }, () => Math.floor(Math.random() * -20));
    };
    resize();
    let last = 0;
    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 55) return; last = t; // ~18fps (부하 최소)
      ctx.fillStyle = 'rgba(0,0,0,0.09)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = color; ctx.font = `${font}px monospace`;
      for (let i = 0; i < cols; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(ch, i * font, drops[i] * font);
        if (drops[i] * font > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize); ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [color]);
  return <canvas ref={ref} className="lt-canvas" aria-hidden="true" />;
}

// ③ 스타필드(별이 흐르는 우주).
function Starfield() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf, w, h, stars;
    const resize = () => {
      w = canvas.width = canvas.clientWidth; h = canvas.height = canvas.clientHeight;
      stars = Array.from({ length: Math.min(220, Math.round(w * h / 9000)) }, () => ({
        x: Math.random() * w, y: Math.random() * h, z: Math.random() * 1 + 0.2, r: Math.random() * 1.3 + 0.3,
      }));
    };
    resize();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.y += s.z * 0.35; if (s.y > h) { s.y = 0; s.x = Math.random() * w; }
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(199,210,254,${0.25 + s.z * 0.5})`; ctx.fill();
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize); ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="lt-canvas" aria-hidden="true" />;
}

/* ───────────────────────── 10개 테마 ───────────────────────── */

// 좌측 히어로 + 우측 카드(도트맵) — Davinci 오리지널.
function ThemeDavinci({ f }) {
  return (
    <div className="lt lt-davinci lt-split">
      <DotMap />
      <div className="lt-topbar">
        <div className="lt-brand"><div className="lt-logo"><i /></div>
          <div><div className="lt-brand-title">THE DAVINCI</div><div className="lt-brand-sub">GLOBAL INFRASTRUCTURE MONITOR</div></div>
        </div>
        <div className="lt-netstat"><i />NETWORK STATUS · NOMINAL</div>
      </div>
      <div className="lt-split-main">
        <div className="lt-hero">
          <div className="lt-hero-label"><b>▸</b>GLOBAL INFRASTRUCTURE CONSOLE</div>
          <h1>Eyes on every rack,<br />in every region.</h1>
          <p>The Davinci streams live telemetry from 5,800+ VMs and 650+ servers across 28 vCenters worldwide — one console, zero blind spots.</p>
        </div>
        <form className="lt-card" onSubmit={f.submit}>
          <AuthFields f={f} head={<><span><b>&gt;_</b>SECURE ACCESS // AUTH-01</span><span>TLS 1.3</span></>} />
        </form>
      </div>
    </div>
  );
}

// 오로라 글래스.
function ThemeAurora({ f }) {
  return <Centered cls="lt-aurora" f={f} bg={<div className="lt-bg lt-aurora-bg" aria-hidden />}
    fields={<AuthFields f={f} title="Welcome back" sub="오로라 콘솔에 접속합니다." btn="SIGN IN" />} />;
}

// 레트로 터미널(CRT).
function ThemeTerminal({ f }) {
  return <Centered cls="lt-terminal" f={f} bg={<div className="lt-scan" aria-hidden />}
    fields={<AuthFields f={f} head="root@davinci:~# ./login --secure" title="ACCESS TERMINAL" sub="// awaiting operator credentials_" btn="CONNECT" idLabel="LOGIN" pwLabel="SECRET" />} />;
}

// 블루프린트 그리드.
function ThemeBlueprint({ f }) {
  return <Centered cls="lt-blueprint" f={f} bg={<div className="lt-bg lt-grid" aria-hidden />}
    fields={<AuthFields f={f} head={<><span>DWG · AUTH-SCHEMATIC</span><span>REV 2.1</span></>} title="Access Blueprint" sub="시스템 도면에 서명하여 진입합니다." btn="AUTHORIZE" />} />;
}

// 미니멀 라이트(코퍼레이트).
function ThemeMinimal({ f }) {
  return <Centered cls="lt-minimal" f={f} bg={null}
    fields={<AuthFields f={f} head={<span className="lt-mini-brand">◆ THE DAVINCI</span>} title="Sign in" sub="Monitoring console 로 로그인하세요." btn="CONTINUE" />} />;
}

// 네온 사이버펑크.
function ThemeNeon({ f }) {
  return <Centered cls="lt-neon" f={f} bg={<div className="lt-neon-floor" aria-hidden />}
    fields={<AuthFields f={f} head={<><span>◈ NIGHT CITY NODE</span><span>ONLINE</span></>} title="JACK IN" sub="네온 그리드에 연결합니다." btn="JACK IN" idLabel="HANDLE" />} />;
}

// 스타필드(우주).
function ThemeStarfield({ f }) {
  return <Centered cls="lt-star" f={f} bg={<Starfield />}
    fields={<AuthFields f={f} head={<><span>✦ ORBITAL CONTROL</span><span>SYNC OK</span></>} title="Mission Control" sub="궤도 관제 콘솔에 접속합니다." btn="LAUNCH" />} />;
}

// 매트릭스 레인.
function ThemeMatrix({ f }) {
  return <Centered cls="lt-matrix" f={f} bg={<MatrixRain color="#22c55e" />}
    fields={<AuthFields f={f} head="wake up, operator..." title="THE MATRIX" sub="follow the white rabbit_" btn="ENTER" idLabel="OPERATOR" pwLabel="KEY" />} />;
}

// 선셋 그라디언트.
function ThemeSunset({ f }) {
  return <Centered cls="lt-sunset" f={f} bg={<div className="lt-bg lt-sunset-bg" aria-hidden />}
    fields={<AuthFields f={f} title="Good to see you" sub="따뜻하게 맞이합니다 — 로그인하세요." btn="LET ME IN" />} />;
}

// 브루탈리스트(흑백).
function ThemeBrutalist({ f }) {
  return <Centered cls="lt-brutal" f={f} bg={null}
    fields={<AuthFields f={f} head="THE DAVINCI // NO NONSENSE" title="LOG IN." sub="계정과 비밀번호. 그게 전부." btn="GO" />} />;
}

export const THEMES = [
  { id: 'davinci', name: 'Davinci Map', Comp: ThemeDavinci },
  { id: 'aurora', name: 'Aurora Glass', Comp: ThemeAurora },
  { id: 'terminal', name: 'Retro Terminal', Comp: ThemeTerminal },
  { id: 'blueprint', name: 'Blueprint', Comp: ThemeBlueprint },
  { id: 'minimal', name: 'Minimal Light', Comp: ThemeMinimal },
  { id: 'neon', name: 'Neon City', Comp: ThemeNeon },
  { id: 'starfield', name: 'Orbital', Comp: ThemeStarfield },
  { id: 'matrix', name: 'Matrix Rain', Comp: ThemeMatrix },
  { id: 'sunset', name: 'Sunset', Comp: ThemeSunset },
  { id: 'brutalist', name: 'Brutalist', Comp: ThemeBrutalist },
];

/* ───────────────────────── 공통 + 테마별 CSS ───────────────────────── */
export const THEMES_CSS = `
.lt { position: fixed; inset: 0; overflow: auto; display: grid; place-items: center; padding: 40px 20px;
  box-sizing: border-box; color: var(--lt-text,#e6edf3);
  font-family: var(--lt-font, 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace); }
.lt * { box-sizing: border-box; }
.lt-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.lt-card { position: relative; z-index: 3; width: 100%; max-width: 420px; background: var(--lt-card, rgba(13,20,28,.93));
  border: 1px solid var(--lt-border,#223140); border-radius: var(--lt-radius,10px);
  box-shadow: var(--lt-shadow, 0 30px 90px rgba(0,0,0,.55)); backdrop-filter: var(--lt-blur, none); -webkit-backdrop-filter: var(--lt-blur, none); }
.lt-head { display: flex; justify-content: space-between; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--lt-border,#1c2937);
  font-size: 10.5px; letter-spacing: .16em; color: var(--lt-dim,#64748b); }
.lt-head b { color: var(--lt-accent,#2dd4bf); font-weight: 400; margin-right: 6px; }
.lt-card-body { padding: 26px 26px 22px; }
.lt-title { margin: 0; font-size: 23px; font-weight: 700; color: var(--lt-title,#fff); letter-spacing: -.01em; }
.lt-sub { margin-top: 8px; font-size: 12.5px; color: var(--lt-dim,#8ea0b5); }
.lt-lab { display: block; margin: 20px 0 7px; font-size: 10.5px; letter-spacing: .22em; color: var(--lt-dim,#64748b); text-transform: uppercase; }
.lt-input { width: 100%; background: var(--lt-input,#0a1017); border: 1px solid var(--lt-border,#223140);
  border-radius: var(--lt-input-radius,6px); padding: 12px 14px; color: var(--lt-text,#e6edf3); font: inherit; font-size: 14px; }
.lt-input::placeholder { color: var(--lt-ph,#3d4e60); }
.lt-input:focus { outline: none; border-color: var(--lt-accent,#2dd4bf); box-shadow: 0 0 0 2px var(--lt-glow, rgba(45,212,191,.18)); }
.lt-pw { position: relative; }
.lt-show { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer;
  font: inherit; font-size: 10.5px; letter-spacing: .16em; color: var(--lt-dim,#64748b); padding: 4px 6px; }
.lt-show:hover { color: var(--lt-accent,#2dd4bf); }
.lt-row { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; gap: 10px; }
.lt-keep { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 10.5px; letter-spacing: .14em; color: var(--lt-dim,#94a3b8); user-select: none; }
.lt-keep input { position: absolute; opacity: 0; }
.lt-check { width: 16px; height: 16px; flex: none; border: 1px solid var(--lt-accent,#2dd4bf); border-radius: 3px;
  display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--lt-accent-ink,#04120e); }
.lt-keep input:checked + .lt-check { background: var(--lt-accent,#2dd4bf); }
.lt-keep input:checked + .lt-check::after { content: '✓'; font-weight: 700; }
.lt-forgot { background: none; border: none; cursor: pointer; font: inherit; font-size: 10.5px; letter-spacing: .14em; color: var(--lt-dim,#64748b); padding: 0; }
.lt-forgot:hover { color: var(--lt-accent,#2dd4bf); }
.lt-btn { width: 100%; margin-top: 20px; padding: 14px; border: none; border-radius: var(--lt-btn-radius,6px); cursor: pointer;
  background: var(--lt-accent,#34e0b4); color: var(--lt-accent-ink,#052e25); font: inherit; font-size: 12.5px; font-weight: 700; letter-spacing: .28em; }
.lt-btn:hover:not(:disabled) { filter: brightness(1.08); }
.lt-btn:disabled { opacity: .45; cursor: default; }
.lt-restrict { margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--lt-border,#1c2937);
  font-size: 10px; line-height: 1.85; letter-spacing: .03em; color: var(--lt-faint,#54657a); }
.lt-error { margin-top: 13px; font-size: 12px; color: #f87171; line-height: 1.6; }
.lt-notice { margin-top: 12px; font-size: 12px; color: #fbbf24; line-height: 1.6; }
.lt-welcome { margin-top: 12px; font-size: 12px; color: var(--lt-accent,#2dd4bf); }
.lt-hint { margin-top: 10px; font-size: 11px; color: var(--lt-dim,#64748b); line-height: 1.7; }
/* ── 1) Davinci: 좌 히어로 + 우 카드 + 도트맵 ── */
.lt-davinci { --lt-card: rgba(13,20,28,.93); --lt-accent: #34e0b4; --lt-accent-ink: #052e25; --lt-glow: rgba(45,212,191,.15);
  display: block; background: #0a0e15; }
.lt-split .dv-map { position: absolute; inset: 0; pointer-events: none; }
.lt-split .dv-map canvas { display: block; }
.lt-split::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 30% 40%, transparent 40%, rgba(5,8,13,.55) 100%); }
.dv-marker { position: absolute; transform: translate(-50%,-50%); }
.dv-marker-dot { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 10px 2px rgba(45,212,191,.7); }
.dv-marker-ring { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(45,212,191,.55); animation: dvPulse 2.6s ease-out infinite; }
.dv-marker-label { position: absolute; left: 12px; top: -7px; font-size: 10px; letter-spacing: .12em; color: #9fb6c9; }
@keyframes dvPulse { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(1.9); opacity: 0; } }
.lt-topbar { position: relative; z-index: 2; display: flex; justify-content: space-between; align-items: flex-start; padding: 26px 40px 0; }
.lt-brand { display: flex; gap: 14px; align-items: center; }
.lt-logo { width: 40px; height: 40px; border: 1px solid rgba(45,212,191,.55); border-radius: 9px; display: flex; align-items: center; justify-content: center; }
.lt-logo i { width: 12px; height: 12px; background: #2dd4bf; transform: rotate(45deg); border-radius: 2px; box-shadow: 0 0 12px rgba(45,212,191,.8); }
.lt-brand-title { font-size: 14px; font-weight: 700; letter-spacing: .38em; color: #fff; }
.lt-brand-sub { margin-top: 4px; font-size: 9.5px; letter-spacing: .32em; color: #5b6b7f; }
.lt-netstat { font-size: 10.5px; letter-spacing: .25em; color: #5b6b7f; display: flex; align-items: center; gap: 8px; padding-top: 6px; }
.lt-netstat i { width: 7px; height: 7px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 8px rgba(45,212,191,.8); }
.lt-split-main { position: relative; z-index: 2; display: flex; align-items: center; gap: 64px; max-width: 1560px;
  margin: 0 auto; padding: 60px 56px 56px; min-height: calc(100vh - 92px); }
.lt-split .lt-hero { flex: 1; min-width: 0; }
.lt-hero-label { font-size: 11.5px; letter-spacing: .3em; color: #8ea0b5; }
.lt-hero-label b { color: #2dd4bf; margin-right: 10px; font-weight: 400; }
.lt-hero h1 { margin: 26px 0 0; font-size: clamp(38px,4.6vw,62px); font-weight: 700; line-height: 1.18; letter-spacing: -.01em; color: #fff; }
.lt-hero p { margin: 26px 0 0; max-width: 480px; font-size: 14.5px; line-height: 1.85; color: #8ea0b5; }
.lt-split .lt-card { width: 430px; flex: none; }
@media (max-width: 1080px) { .lt-split-main { flex-direction: column; align-items: stretch; gap: 36px; padding: 40px 22px; }
  .lt-split .lt-card { width: 100%; max-width: 460px; margin: 0 auto; } .lt-hero p { max-width: none; } }

/* ── 2) Aurora glass ── */
.lt-aurora { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #c084fc; --lt-accent-ink: #1a0733; --lt-glow: rgba(192,132,252,.25);
  --lt-card: rgba(30,22,48,.55); --lt-border: rgba(192,132,252,.28); --lt-input: rgba(10,6,20,.5); --lt-blur: blur(14px);
  --lt-radius: 18px; --lt-title: #f5edff; --lt-text: #ede9fe; --lt-dim: #b9a9d9; --lt-shadow: 0 30px 90px rgba(60,20,110,.5); background: #120a1f; }
.lt-aurora-bg { position: absolute; inset: -20%; filter: blur(70px); opacity: .8;
  background: radial-gradient(40% 40% at 25% 30%, #7c3aed 0%, transparent 60%),
    radial-gradient(45% 45% at 78% 28%, #db2777 0%, transparent 60%),
    radial-gradient(50% 50% at 60% 85%, #2563eb 0%, transparent 60%); animation: auFloat 16s ease-in-out infinite alternate; }
@keyframes auFloat { 0% { transform: translate(-4%,-3%) scale(1); } 100% { transform: translate(5%,4%) scale(1.12); } }

/* ── 3) Retro terminal (CRT) ── */
.lt-terminal { --lt-accent: #33ff77; --lt-accent-ink: #00160a; --lt-glow: rgba(51,255,119,.25); --lt-card: rgba(0,14,6,.9);
  --lt-border: #12401f; --lt-input: #00160a; --lt-text: #7dffa8; --lt-title: #b8ffcf; --lt-dim: #3f9d63; --lt-faint: #2f7a4c;
  --lt-radius: 4px; --lt-input-radius: 2px; --lt-btn-radius: 2px; background: #000308; }
.lt-terminal .lt-card { box-shadow: 0 0 40px rgba(51,255,119,.12), inset 0 0 60px rgba(51,255,119,.04); }
.lt-terminal .lt-title { text-shadow: 0 0 12px rgba(51,255,119,.5); }
.lt-scan { position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background: repeating-linear-gradient(rgba(51,255,119,.05) 0 1px, transparent 1px 3px); }

/* ── 4) Blueprint grid ── */
.lt-blueprint { --lt-accent: #38bdf8; --lt-accent-ink: #04121f; --lt-glow: rgba(56,189,248,.22); --lt-card: rgba(9,25,48,.92);
  --lt-border: #1e456f; --lt-input: rgba(5,16,32,.8); --lt-text: #dbeafe; --lt-title: #eaf4ff; --lt-dim: #7fa8d0; --lt-radius: 6px;
  background: #081a34; }
.lt-grid { position: absolute; inset: 0;
  background-image: linear-gradient(rgba(56,189,248,.10) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,.10) 1px, transparent 1px);
  background-size: 26px 26px; mask-image: radial-gradient(ellipse at center, #000 55%, transparent 100%); }

/* ── 5) Minimal light (corporate) ── */
.lt-minimal { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #2563eb; --lt-accent-ink: #fff; --lt-glow: rgba(37,99,235,.15);
  --lt-card: #ffffff; --lt-border: #e2e8f0; --lt-input: #f8fafc; --lt-text: #0f172a; --lt-title: #0f172a; --lt-dim: #64748b; --lt-faint: #94a3b8;
  --lt-ph: #94a3b8; --lt-radius: 14px; --lt-shadow: 0 20px 60px rgba(15,23,42,.12); background: #eef2f7; }
.lt-minimal .lt-head { color: #475569; }
.lt-mini-brand { font-weight: 700; letter-spacing: .16em; color: #2563eb; }

/* ── 6) Neon cyberpunk ── */
.lt-neon { --lt-accent: #ff2bd6; --lt-accent-ink: #1a0016; --lt-glow: rgba(255,43,214,.3); --lt-card: rgba(14,4,24,.82);
  --lt-border: rgba(255,43,214,.4); --lt-input: rgba(5,1,10,.7); --lt-text: #f5d0ff; --lt-title: #fff; --lt-dim: #b98ecf; --lt-radius: 8px;
  background: #05010a; overflow: hidden; }
.lt-neon .lt-card { box-shadow: 0 0 30px rgba(255,43,214,.25), 0 0 60px rgba(34,211,238,.12); }
.lt-neon::before { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(55% 40% at 50% 100%, rgba(255,43,214,.22), transparent 70%),
    radial-gradient(40% 30% at 20% 0%, rgba(34,211,238,.14), transparent 70%); }
.lt-neon-floor { position: absolute; left: -30%; right: -30%; bottom: 0; height: 55%; pointer-events: none;
  background-image: linear-gradient(rgba(34,211,238,.9) 2px, transparent 2px), linear-gradient(90deg, rgba(255,43,214,.8) 2px, transparent 2px);
  background-size: 46px 46px; transform: perspective(340px) rotateX(60deg); transform-origin: 50% 100%;
  mask-image: linear-gradient(transparent 0%, #000 45%); opacity: .55; }

/* ── 7) Orbital starfield ── */
.lt-star { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #818cf8; --lt-accent-ink: #0b1030; --lt-glow: rgba(129,140,248,.28);
  --lt-card: rgba(15,20,42,.68); --lt-border: rgba(129,140,248,.3); --lt-input: rgba(8,10,25,.6); --lt-blur: blur(10px);
  --lt-text: #e0e7ff; --lt-title: #fff; --lt-dim: #a5b4d6; --lt-radius: 16px;
  background: radial-gradient(ellipse at 50% 20%, #1e2a5a 0%, #070a18 60%); }

/* ── 8) Matrix rain ── */
.lt-matrix { --lt-accent: #22c55e; --lt-accent-ink: #04120a; --lt-glow: rgba(34,197,94,.25); --lt-card: rgba(0,12,4,.8);
  --lt-border: #0f3d22; --lt-input: rgba(0,20,8,.7); --lt-text: #9bf6c0; --lt-title: #d6ffe6; --lt-dim: #3f9d63; --lt-faint: #2f7a4c;
  --lt-radius: 4px; background: #000; }
.lt-matrix .lt-card { box-shadow: 0 0 40px rgba(34,197,94,.14); }

/* ── 9) Sunset gradient ── */
.lt-sunset { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #fb923c; --lt-accent-ink: #3a1600; --lt-glow: rgba(251,146,60,.28);
  --lt-card: rgba(40,20,32,.5); --lt-border: rgba(255,190,150,.28); --lt-input: rgba(20,10,16,.42); --lt-blur: blur(12px);
  --lt-text: #ffe8d6; --lt-title: #fff; --lt-dim: #e6b6a2; --lt-radius: 18px; --lt-shadow: 0 30px 90px rgba(120,40,60,.4); background: #2a1020; }
.lt-sunset-bg { position: absolute; inset: 0; background: linear-gradient(135deg, #f97316 0%, #db2777 42%, #7c3aed 100%); opacity: .85; }
.lt-sunset-bg::after { content: ''; position: absolute; inset: 0; background: radial-gradient(60% 50% at 70% 15%, rgba(255,220,120,.6), transparent 60%); }

/* ── 10) Brutalist mono ── */
.lt-brutal { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #ef4444; --lt-accent-ink: #fff; --lt-glow: rgba(239,68,68,.2);
  --lt-card: #ffffff; --lt-border: #111111; --lt-input: #fff; --lt-text: #111; --lt-title: #111; --lt-dim: #555; --lt-faint: #777;
  --lt-ph: #999; --lt-radius: 0; --lt-input-radius: 0; --lt-btn-radius: 0; --lt-shadow: 10px 10px 0 #111; background: #f5f5f0; }
.lt-brutal .lt-card { border-width: 2px; }
.lt-brutal .lt-head { border-bottom-width: 2px; font-weight: 700; color: #111; }
.lt-brutal .lt-title { font-size: 30px; font-weight: 800; letter-spacing: -.02em; }
.lt-brutal .lt-input { border-width: 2px; }
.lt-brutal .lt-btn { border: 2px solid #111; }
`;
