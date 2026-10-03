using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace HorizonUagMonitor;

public enum TargetState { Ok, SameAsCurrent, Invalid, NotWritable, HasExistingDb, InsufficientSpace }

/// <summary>새 저장 폴더를 쓰기 전에 본 점검 결과.</summary>
public sealed record TargetCheck(TargetState State, string Message, string FullPath, long NeedBytes, long? FreeBytes);

public sealed record MigrationResult(bool Ok, string Message, string? NewDbPath, IReadOnlyList<string> Notes);

/// <summary>
/// 저장 폴더 변경 시 자동 이동. 순서가 곧 안전장치다:
///  1) 점검(경로·쓰기·여유 공간·대상 폴더의 기존 DB) — 문제면 아무것도 바꾸지 않고 끝낸다.
///  2) 복사(점검·화면은 계속 동작) → 3) 따라잡기·검증 → 4) 새 위치 기록 → 5) 연결 전환 → 6) 예전 파일 삭제.
///  검증이 통과하기 전에는 예전 파일을 절대 지우지 않고, 어느 단계가 실패해도 예전 DB 로 계속 동작한다.
/// 대상 폴더에 이미 monitor.db 가 있으면 덮어쓰지 않는다 — 그 DB 로 전환(예전 폴더는 그대로)하거나 취소만 가능.
/// </summary>
public static class DataMigrator
{
    private static readonly string[] LogFiles = { AppLog.ErrorFile, AppLog.AlarmFile };

    public static TargetCheck Check(string currentDbPath, string newDirInput)
    {
        string full;
        try
        {
            if (string.IsNullOrWhiteSpace(newDirInput) || !Path.IsPathFullyQualified(newDirInput.Trim()))
                return new TargetCheck(TargetState.Invalid, "폴더는 드라이브부터 시작하는 전체 경로로 입력하세요. (예: D:\\UagMonitorData)", newDirInput ?? "", 0, null);
            full = Path.GetFullPath(newDirInput.Trim());
        }
        catch (Exception ex)
        {
            return new TargetCheck(TargetState.Invalid, "경로를 해석할 수 없습니다: " + ex.Message, newDirInput ?? "", 0, null);
        }

        var curDir = Path.GetDirectoryName(Path.GetFullPath(currentDbPath))!;
        if (DataLocation.SamePath(curDir, full))
            return new TargetCheck(TargetState.SameAsCurrent, "현재 사용 중인 폴더입니다.", full, 0, null);

        var why = DataLocation.ProbeWritable(full);
        if (why != null)
            return new TargetCheck(TargetState.NotWritable, "이 폴더에 쓸 수 없습니다: " + why, full, 0, null);

        var target = DataLocation.DbPathIn(full);
        if (File.Exists(target))
            return new TargetCheck(TargetState.HasExistingDb, $"이 폴더에 이미 {DataLocation.DbFileName} 가 있습니다.", full, 0, null);

        long need = 0;
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            var f = currentDbPath + suffix;
            if (File.Exists(f)) need += new FileInfo(f).Length;
        }
        need = (long)(need * 1.2) + 64L * 1024 * 1024; // 사본 + 여유
        long? free = null;
        try
        {
            var root = Path.GetPathRoot(full);
            if (!string.IsNullOrEmpty(root) && !root.StartsWith(@"\\", StringComparison.Ordinal))
                free = new DriveInfo(root).AvailableFreeSpace;
        }
        catch { /* 네트워크·특수 경로는 여유 공간을 알 수 없다 — 건너뛴다 */ }
        if (free is long f2 && f2 < need)
            return new TargetCheck(TargetState.InsufficientSpace,
                $"여유 공간이 부족합니다 (필요 약 {Mb(need)} MB, 남은 {Mb(f2)} MB).", full, need, free);

        return new TargetCheck(TargetState.Ok, "이동할 수 있습니다.", full, need, free);
    }

    /// <summary>
    /// 저장 폴더를 옮긴다. <paramref name="useExistingTargetDb"/> 는 대상 폴더에 이미 있는 DB 로 전환(복사 없음).
    /// 호출 스레드를 오래 잡으므로 UI 에서는 백그라운드로 부를 것.
    /// </summary>
    public static MigrationResult Migrate(Database db, DataLocation loc, string newDirInput,
        bool useExistingTargetDb = false, Action<string>? progress = null)
    {
        void P(string m) { try { progress?.Invoke(m); } catch { /* 진행 표시 실패 무시 */ } }

        var oldDb = db.DbPath;
        var oldDir = Path.GetDirectoryName(Path.GetFullPath(oldDb))!;
        var check = Check(oldDb, newDirInput);
        var okToGo = check.State == TargetState.Ok || (check.State == TargetState.HasExistingDb && useExistingTargetDb);
        if (!okToGo)
            return new MigrationResult(false, check.Message, null, Array.Empty<string>());

        var newDir = check.FullPath;
        var newDb = DataLocation.DbPathIn(newDir);
        var notes = new List<string>();

        try
        {
            if (check.State == TargetState.HasExistingDb)
            {
                P("대상 폴더의 기존 데이터베이스로 전환하는 중…");
                db.SwitchTo(newDb, () => loc.SaveDataDir(newDir));
                AppLog.Dir = newDir;
                notes.Add($"예전 폴더({oldDir})의 데이터는 그대로 남아 있습니다.");
                return new MigrationResult(true, "기존 데이터베이스로 전환했습니다.", newDb, notes);
            }

            var tmp = newDb + ".migrating";
            try
            {
                P("데이터베이스를 복사하는 중… (점검은 계속 동작합니다)");
                db.Checkpoint();
                db.ExportCopyTo(tmp);

                P("복사 중 쌓인 점검 결과를 반영하고 검증하는 중…");
                db.FinishMigration(tmp, newDb, () => loc.SaveDataDir(newDir));
            }
            catch
            {
                TryDelete(tmp);
                throw;
            }
            AppLog.Dir = newDir;
        }
        catch (Exception ex)
        {
            return new MigrationResult(false, "이동에 실패해 예전 폴더를 그대로 사용합니다: " + ex.Message, null, notes);
        }

        // 여기까지 오면 새 DB 로 전환이 끝났다. 이후는 정리 — 실패해도 데이터는 안전하다.
        P("로그 파일을 옮기는 중…");
        foreach (var name in LogFiles)
        {
            var src = Path.Combine(oldDir, name);
            if (!File.Exists(src)) continue;
            try
            {
                File.Copy(src, Path.Combine(newDir, name), overwrite: true);
                File.Delete(src);
            }
            catch (Exception ex) { notes.Add($"{name} 를 옮기지 못했습니다: {ex.Message}"); }
        }

        P("예전 폴더의 데이터베이스 파일을 정리하는 중…");
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            var f = oldDb + suffix;
            if (!File.Exists(f)) continue;
            try { File.Delete(f); }
            catch (Exception ex) { notes.Add($"예전 파일 {Path.GetFileName(f)} 를 지우지 못했습니다(직접 지워도 됩니다): {ex.Message}"); }
        }
        return new MigrationResult(true, $"'{newDir}' 로 이동했습니다.", newDb, notes);
    }

    private static void TryDelete(string f) { try { if (File.Exists(f)) File.Delete(f); } catch { /* ignore */ } }
    private static long Mb(long bytes) => bytes / (1024 * 1024);
}
