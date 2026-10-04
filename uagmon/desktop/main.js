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
let quitting = false;     // 사용자가 끄는 중이면 자식 종료는 정상이다(알림·재시작 안 함)
let restarts = 0;         // 기동 뒤 죽은 서버의 자동 재시작 횟수(1회까지)
const RESTART_MAX = 1;
const OUT_MAX = 64 * 1024; // 자식 stdout/stderr 누적 상한 — 오래 돌면 로그가 무한히 쌓인다

// 단일 인스턴스(v2.689): 두 번 실행하면 서버가 둘 떠 같은 uag-config.json 을 각자 메모리에 들고
// 통째로 덮어써 한쪽 변경이 사라지고, UAG 로그인도 두 배가 된다 → 두 번째 실행은 기존 창을 앞으로.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const dataDir = path.join(app.getPath('userData'), 'data');
    const child = spawn(process.execPath, [
      path.join(__dirname, 'app', 'server.js'),
      '--host', '127.0.0.1', '--port', '0', '--data', dataDir,
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild = child;
    let out = '';
    const onData = (d) => {
      out += String(d);
      if (out.length > OUT_MAX) out = out.slice(-OUT_MAX);
      if (!ready) {
        const m = /UAGMON_LISTENING port=(\d+)/.exec(out);
        if (m) { ready = true; done(resolve, Number(m[1])); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => done(reject, err));
    child.on('exit', (code, signal) => {
      done(reject, new Error(`내장 서버가 종료됨(code ${code})\n${out.slice(-500)}`));
      // 기동 뒤에 죽은 경우 — 예전에는 promise 가 이미 settled 라 아무 알림 없이 빈 창만 남았다.
      if (ready && !quitting && child === serverChild) onServerDied(code, signal, out);
    });
    setTimeout(() => done(reject, new Error(`내장 서버 응답 없음(10s)\n${out.slice(-500)}`)), 10_000);
  });
}

async function onServerDied(code, signal, out) {
  const tail = String(out || '').slice(-800);
  if (restarts >= RESTART_MAX) {
    dialog.showErrorBox('UAG Monitor 내장 서버 종료',
      `내장 서버가 다시 종료되었습니다(code ${code}${signal ? `, ${signal}` : ''}). 앱을 다시 실행하세요.\n\n${tail}`);
    app.quit();
    return;
  }
  restarts += 1;
  dialog.showErrorBox('UAG Monitor 내장 서버 종료',
    `내장 서버가 종료되었습니다(code ${code}${signal ? `, ${signal}` : ''}). 확인을 누르면 한 번 다시 시작합니다.\n\n${tail}`);
  try {
    const port = await startServer();
    if (mainWin && !mainWin.isDestroyed()) await mainWin.loadURL(`http://127.0.0.1:${port}/`);
  } catch (err) {
    dialog.showErrorBox('UAG Monitor 재시작 실패', String(err?.message || err));
    app.quit();
  }
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
  mainWin.on('closed', () => { mainWin = null; });
  // 창은 http://127.0.0.1:<포트>/ 로 연다 — 서버의 로컬 모드 Host 검사(127.0.0.1/localhost/[::1])와
  // 상태 변경 API 의 Origin 검사(Origin http://127.0.0.1:<포트> == Host)를 그대로 통과한다.
  await mainWin.loadURL(`http://127.0.0.1:${port}/`);
  console.log(`UAGMON_WINDOW_READY port=${port}`); // 자동화 검증용
}

if (gotLock) {
  app.whenReady().then(createWindow).catch((err) => {
    dialog.showErrorBox('UAG Monitor 시작 실패', String(err?.message || err));
    app.quit();
  });
}

// 창을 모두 닫으면(맥 포함) 모니터+내장 서버를 완전히 종료한다 — 상주형 앱이 아니다.
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; });
app.on('quit', () => { quitting = true; try { serverChild?.kill(); } catch { /* 이미 종료 */ } });
