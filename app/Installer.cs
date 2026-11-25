using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Paraphe
{
    /// <summary>
    /// Per-user install, no admin rights: copies the app to
    /// %LOCALAPPDATA%\Programs\Paraphe, adds a Start menu shortcut, registers
    /// Paraphe as a PDF app (Windows still asks the user to choose the default)
    /// and adds an entry to Settings > Apps for uninstalling.
    /// </summary>
    internal static class Installer
    {
        private const string ProgId = "Paraphe.PDF";
        private const string AppName = "Paraphe";
        private const string CapabilitiesKey = @"Software\Paraphe\Capabilities";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Paraphe";

        public static string InstallDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Paraphe");

        private static string ShortcutPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Paraphe.lnk");

        private static string AppDir => AppContext.BaseDirectory.TrimEnd('\\');

        public static bool IsRunningInstalled =>
            string.Equals(Path.GetFullPath(AppDir), Path.GetFullPath(InstallDir), StringComparison.OrdinalIgnoreCase);

        /// <summary>Install (or refresh) and register. Returns the installed exe path.</summary>
        public static string Install()
        {
            if (!IsRunningInstalled)
            {
                try
                {
                    CopyDirectory(AppDir, InstallDir);
                }
                catch (IOException)
                {
                    throw new IOException("Close other Paraphe windows and try again.");
                }
            }
            string exe = Path.Combine(InstallDir, "Paraphe.exe");
            CreateShortcut(exe);
            Register(exe);
            return exe;
        }

        public static void Uninstall()
        {
            var answer = MessageBox.Show("Remove Paraphe from this computer?", AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
            bool wipeData = MessageBox.Show("Also delete your saved signatures and settings?", AppName,
                MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;

            Unregister();
            TryDelete(ShortcutPath);
            var toDelete = new System.Collections.Generic.List<string>();
            if (Directory.Exists(InstallDir)) toDelete.Add(InstallDir);
            if (wipeData) toDelete.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Paraphe"));
            if (toDelete.Count > 0)
            {
                // This exe may live in the folder being removed: delete after it exits.
                string rm = string.Join(" & ", toDelete.ConvertAll(d => $"rmdir /s /q \"{d}\""));
                Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 >nul & {rm}")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetTempPath(),
                });
            }
            MessageBox.Show("Paraphe has been removed.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        public static void OpenDefaultAppsSettings()
        {
            Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=" + AppName) { UseShellExecute = true });
        }

        private static void Register(string exe)
        {
            string open = $"\"{exe}\" \"%1\"";
            using (var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
            {
                k.SetValue("", "PDF document");
                k.SetValue("FriendlyTypeName", "PDF document");
                using (var icon = k.CreateSubKey("DefaultIcon")) icon.SetValue("", $"\"{exe}\",0");
                using (var cmd = k.CreateSubKey(@"shell\open\command")) cmd.SetValue("", open);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.pdf\OpenWithProgids"))
                k.SetValue(ProgId, new byte[0], RegistryValueKind.None);
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Paraphe.exe"))
            {
                k.SetValue("FriendlyAppName", AppName);
                using (var types = k.CreateSubKey("SupportedTypes")) types.SetValue(".pdf", "");
                using (var cmd = k.CreateSubKey(@"shell\open\command")) cmd.SetValue("", open);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(CapabilitiesKey))
            {
                k.SetValue("ApplicationName", AppName);
                k.SetValue("ApplicationDescription", "Fill and sign PDFs");
                k.SetValue("ApplicationIcon", $"\"{exe}\",0");
                using (var fa = k.CreateSubKey("FileAssociations")) fa.SetValue(".pdf", ProgId);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
                k.SetValue(AppName, CapabilitiesKey);
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", Application.ProductVersion);
                k.SetValue("Publisher", "Joris Decombe");
                k.SetValue("DisplayIcon", $"\"{exe}\",0");
                k.SetValue("InstallLocation", Path.GetDirectoryName(exe));
                k.SetValue("UninstallString", $"\"{exe}\" --uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)(DirSize(Path.GetDirectoryName(exe)) / 1024), RegistryValueKind.DWord);
            }
            NotifyAssociationsChanged();
        }

        private static void Unregister()
        {
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{ProgId}", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\Paraphe.exe", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Paraphe", false);
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\.pdf\OpenWithProgids", true))
                k?.DeleteValue(ProgId, false);
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true))
                k?.DeleteValue(AppName, false);
            NotifyAssociationsChanged();
        }

        private static void CopyDirectory(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
                Directory.CreateDirectory(Path.Combine(to, dir.Substring(from.Length + 1)));
            foreach (string file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
                File.Copy(file, Path.Combine(to, file.Substring(from.Length + 1)), true);
        }

        private static long DirSize(string dir)
        {
            long total = 0;
            foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) total += new FileInfo(f).Length;
            return total;
        }

        private static void CreateShortcut(string exe)
        {
            // WScript.Shell is the simplest way to write a .lnk without extra dependencies.
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object link = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { ShortcutPath });
                Type lt = link.GetType();
                lt.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { exe });
                lt.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(exe) });
                lt.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { "Fill and sign PDFs" });
                lt.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, link, new object[] { exe + ",0" });
                lt.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, link, null);
                Marshal.FinalReleaseComObject(link);
            }
            finally
            {
                Marshal.FinalReleaseComObject(shell);
            }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        [DllImport("shell32.dll")]
        private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

        private static void NotifyAssociationsChanged() => SHChangeNotify(0x08000000 /* SHCNE_ASSOCCHANGED */, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
