/**
 * UAG Monitor 데스크톱 앱(Electron 메인 프로세스).
 *
 * 구조: 동봉된 uagmon 서버(app/server.js)를 ELECTRON_RUN_AS_NODE 자식 프로세스로
 * 127.0.0.1 임의 포트(--port 0)에 띄우고, 그 주소를 자체 창(BrowserWindow)으로 연다.
 * 브라우저가 필요 없고, 창을 모두 닫으면 서버도 함께 종료된다.
 *
 * 데이터(등록 UAG·자격증명)는 OS 표준 사용자 데이터 폴더에 저장되어 앱을 교체해도 유지된다:
 *   macOS  ~/Library/Application Support/uag-monitor/data
 *   Windows %APPDATA%/uag-monitor/data
 * 렌더러는 로컬 서버의 웹 UI 그대로이며 nodeIntegration 없이 격리된다.
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let serverChild = null;
let mainWin = null;

function startServer() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const dataDir = path.join(app.getPath('userData'), 'data');
    serverChild = spawn(process.execPath, [
      path.join(__dirname, 'app', 'server.js'),
      '--host', '127.0.0.1', '--port', '0', '--data', dataDir,
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += String(d);
      const m = /UAGMON_LISTENING port=(\d+)/.exec(out);
      if (m) done(resolve, Number(m[1]));
    };
    serverChild.stdout.on('data', onData);
    serverChild.stderr.on('data', onData);
    serverChild.on('error', (err) => done(reject, err));
    serverChild.on('exit', (code) => done(reject, new Error(`내장 서버가 종료됨(code ${code})\n${out.slice(-500)}`)));
    setTimeout(() => done(reject, new Error(`내장 서버 응답 없음(10s)\n${out.slice(-500)}`)), 10_000);
  });
}

async function createWindow() {
  const port = await startServer();
  mainWin = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'UAG Monitor',
    autoHideMenuBar: true, // Windows/Linux 메뉴바 숨김(macOS 는 앱 메뉴 유지)
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 외부 링크는 앱 창이 아니라 기본 브라우저로.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWin.loadURL(`http://127.0.0.1:${port}/`);
  console.log(`UAGMON_WINDOW_READY port=${port}`); // 자동화 검증용
}

app.whenReady().then(createWindow).catch((err) => {
  dialog.showErrorBox('UAG Monitor 시작 실패', String(err?.message || err));
  app.quit();
});

// 창을 모두 닫으면(맥 포함) 모니터+내장 서버를 완전히 종료한다 — 상주형 앱이 아니다.
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { try { serverChild?.kill(); } catch { /* 이미 종료 */ } });
