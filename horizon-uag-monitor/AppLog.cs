using System;
using System.IO;
using System.Text;

namespace HorizonUagMonitor;

/// <summary>
/// 텍스트 로그(error.log · alarm.log) — 설정에서 지정한 데이터 폴더에 쓴다.
/// 폴더가 바뀌면(마이그레이션) <see cref="Dir"/> 를 갱신해 이후 줄이 새 폴더로 간다.
/// 로그 기록 실패가 앱 동작을 막지 않게 모든 예외를 삼킨다(트레이 상주 특성).
/// </summary>
public static class AppLog
{
    public const string ErrorFile = "error.log";
    public const string AlarmFile = "alarm.log";
    /// <summary>한 파일 상한. 넘으면 .1 로 넘기고 새로 시작한다(디스크를 채우지 않게).</summary>
    public const long MaxBytes = 5L * 1024 * 1024;

    private static readonly object Gate = new();
    private static string? _dir;

    public static string Dir
    {
        get { lock (Gate) return _dir ?? DataLocation.Default.ResolveDataDir(); }
        set { lock (Gate) _dir = value; }
    }

    public static void Write(string file, string line)
    {
        lock (Gate)
        {
            try
            {
                var dir = _dir ?? DataLocation.Default.ResolveDataDir();
                Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, file);
                Rotate(path);
                File.AppendAllText(path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {line}\r\n", new UTF8Encoding(false));
            }
            catch { /* 로그 실패는 무시 */ }
        }
    }

    public static void Error(string kind, Exception? ex) => Write(ErrorFile, $"{kind}: {ex}");

    private static void Rotate(string path)
    {
        try
        {
            var fi = new FileInfo(path);
            if (!fi.Exists || fi.Length < MaxBytes) return;
            var old = path + ".1";
            if (File.Exists(old)) File.Delete(old);
            File.Move(path, old);
        }
        catch { /* 회전 실패 시 계속 추가 */ }
    }
}
