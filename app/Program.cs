using System;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Paraphe
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
            {
                Installer.Uninstall();
                return 0;
            }

            Updater.CleanUp();
            if (args.Contains("--updated", StringComparer.OrdinalIgnoreCase))
            {
                // The previous version may still be closing: try again once it's gone.
                System.Threading.Tasks.Task.Run(async () =>
                {
                    await System.Threading.Tasks.Task.Delay(5000);
                    Updater.CleanUp();
                });
                // New version, same place: refresh the Start menu entry and Settings > Apps.
                if (Installer.IsRunningInstalled)
                {
                    try { Installer.Install(); } catch { }
                }
            }

            // The first argument that is an existing file is the PDF to open
            // (Explorer passes it as "%1").
            string file = args.FirstOrDefault(a => !a.StartsWith("--") && File.Exists(a));
            bool devTools = args.Contains("--devtools", StringComparer.OrdinalIgnoreCase);

            Application.Run(new MainForm(file == null ? null : Path.GetFullPath(file), devTools));
            return 0;
        }
    }
}
