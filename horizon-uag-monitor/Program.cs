using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace HorizonUagMonitor;

internal static class Program
{
    private static Mutex? _singleInstance;

    [STAThread]
    private static void Main(string[] args)
    {
        // 단일 인스턴스 — 중복 실행 방지(트레이에 이미 상주 중이면 새로 뜨지 않게).
        _singleInstance = new Mutex(true, @"Global\HorizonUagMonitor.SingleInstance", out var isNew);
        if (!isNew)
        {
            MessageBox.Show("Horizon UAG Monitor가 이미 실행 중입니다.\n트레이 아이콘을 확인하세요.",
                "Horizon UAG Monitor", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // 예기치 못한 예외를 로그로 남기고 최대한 계속 실행(트레이 상주 특성).
        Application.ThreadException += (_, e) => Log("ThreadException", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log("UnhandledException", e.ExceptionObject as Exception);

        string? dbPath = null;      // --db 로 직접 지정하면 저장 폴더 설정보다 우선(설정 화면에서 폴더 변경 불가)
        bool startHidden = false;
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i].ToLowerInvariant();
            if (a is "--hidden" or "-h" or "/hidden") startHidden = true;
            else if ((a == "--db" || a == "/db") && i + 1 < args.Length) dbPath = args[++i];
        }

        // 설정에서 지정한 데이터·로그 폴더. 쓸 수 없으면(드라이브 분리 등) 기본 폴더로 시작하고 사유를 알린다.
        string? folderWarning = null;
        if (dbPath == null)
        {
            var dir = DataLocation.Default.ResolveForStartup(out folderWarning);
            dbPath = DataLocation.DbPathIn(dir);
            AppLog.Dir = dir;
        }
        else
        {
            DataLocation.CommandLineOverride = true;
            AppLog.Dir = Path.GetDirectoryName(Path.GetFullPath(dbPath))!;
        }
        if (folderWarning != null)
            MessageBox.Show(folderWarning, "Horizon UAG Monitor", MessageBoxButtons.OK, MessageBoxIcon.Warning);

        try
        {
            Application.Run(new TrayAppContext(dbPath, startHidden));
        }
        finally
        {
            try { _singleInstance?.ReleaseMutex(); } catch { /* ignore */ }
        }
    }

    private static void Log(string kind, Exception? ex) => AppLog.Error(kind, ex);
}
