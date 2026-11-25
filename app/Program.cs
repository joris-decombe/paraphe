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

            // The first argument that is an existing file is the PDF to open
            // (Explorer passes it as "%1").
            string file = args.FirstOrDefault(a => !a.StartsWith("--") && File.Exists(a));
            bool devTools = args.Contains("--devtools", StringComparer.OrdinalIgnoreCase);

            Application.Run(new MainForm(file == null ? null : Path.GetFullPath(file), devTools));
            return 0;
        }
    }
}
