using System;
using System.IO;
using System.Text;
using System.Text.Json;

namespace HorizonUagMonitor;

/// <summary>
/// 데이터·로그 저장 폴더(monitor.db · error.log · alarm.log) 위치.
/// 위치 자체는 DB 안에 둘 수 없다(DB 를 열려면 위치를 먼저 알아야 한다) — 그래서 항상 같은 곳
/// (%LOCALAPPDATA%\HorizonUagMonitor\location.json)의 작은 파일에 둔다. 파일이 없거나 읽을 수 없으면 기본 폴더.
/// </summary>
public sealed class DataLocation
{
    public const string DbFileName = "monitor.db";
    public const string BootstrapFileName = "location.json";

    /// <summary>location.json 이 있는 고정 폴더(기본 데이터 폴더와 같다).</summary>
    public string BaseDir { get; }

    public DataLocation(string baseDir) { BaseDir = baseDir; }

    public static DataLocation Default { get; } = new(DefaultBaseDir());

    /// <summary>--db 옵션으로 DB 파일을 직접 지정해 실행했는가. 그러면 설정 화면에서 저장 폴더를 바꾸지 못한다.</summary>
    public static bool CommandLineOverride { get; set; }

    public static string DefaultBaseDir()
        => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HorizonUagMonitor");

    public string BootstrapPath => Path.Combine(BaseDir, BootstrapFileName);

    public static string DbPathIn(string dir) => Path.Combine(dir, DbFileName);

    public static bool SamePath(string a, string b)
    {
        static string N(string p) => Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        try { return string.Equals(N(a), N(b), cmp); } catch { return false; }
    }

    /// <summary>저장된 폴더(없거나 깨졌거나 절대경로가 아니면 기본 폴더). 폴더가 실제로 쓸 수 있는지는 보지 않는다.</summary>
    public string ResolveDataDir()
    {
        try
        {
            if (!File.Exists(BootstrapPath)) return BaseDir;
            using var doc = JsonDocument.Parse(File.ReadAllText(BootstrapPath));
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("dataDir", out var v)
                && v.ValueKind == JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrWhiteSpace(s) && Path.IsPathFullyQualified(s)) return s;
            }
        }
        catch { /* 깨진 파일은 기본 폴더로 */ }
        return BaseDir;
    }

    public bool IsCustom => !SamePath(ResolveDataDir(), BaseDir);

    /// <summary>
    /// 시작 시 쓸 폴더. 지정 폴더를 쓸 수 없으면(드라이브 분리·네트워크 끊김·권한) 기본 폴더로 떨어지고
    /// <paramref name="warning"/> 에 사유를 돌려준다. location.json 은 건드리지 않는다(연결이 돌아오면 다시 쓴다).
    /// </summary>
    public string ResolveForStartup(out string? warning)
    {
        warning = null;
        var dir = ResolveDataDir();
        if (SamePath(dir, BaseDir)) return dir;
        var why = ProbeWritable(dir);
        if (why == null) return dir;
        warning = $"저장 폴더 '{dir}' 를 쓸 수 없어 기본 폴더로 시작합니다.\n사유: {why}\n(설정에서 지정한 폴더 값은 그대로 두었습니다. 폴더가 다시 연결되면 프로그램을 다시 시작하세요.)";
        return BaseDir;
    }

    /// <summary>폴더를 만들고 임시 파일을 써 본다. 문제가 없으면 null, 있으면 사유.</summary>
    public static string? ProbeWritable(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, ".write-test-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(probe, "x");
            File.Delete(probe);
            return null;
        }
        catch (Exception ex) { return ex.Message; }
    }

    /// <summary>저장 폴더를 기록한다(임시 파일 후 교체 — 쓰는 도중 꺼져도 이전 값이 남는다). 기본 폴더면 파일을 지운다.</summary>
    public void SaveDataDir(string dir)
    {
        Directory.CreateDirectory(BaseDir);
        if (SamePath(dir, BaseDir))
        {
            if (File.Exists(BootstrapPath)) File.Delete(BootstrapPath);
            return;
        }
        var tmp = BootstrapPath + ".tmp";
        using (var stream = File.Create(tmp))
        using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Indented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            w.WriteStartObject();
            w.WriteString("dataDir", Path.GetFullPath(dir));
            w.WriteEndObject();
        }
        File.Move(tmp, BootstrapPath, overwrite: true);
    }
}
