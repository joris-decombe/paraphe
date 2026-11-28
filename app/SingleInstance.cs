using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Paraphe
{
    /// <summary>
    /// With tabs on (Settings), a PDF opened from Explorer while Paraphe is
    /// already running goes to that window as a new tab instead of starting a
    /// second window. The second process hands over the file's path through a
    /// pipe that only the current user can use, then exits.
    /// </summary>
    internal static class SingleInstance
    {
        private static Mutex _mutex;

        /// <summary>True when this process is the one that other Paraphe windows hand their files to.</summary>
        public static bool Owner { get; private set; }

        private static string PipeName => "Paraphe.Open." + WindowsIdentity.GetCurrent().User.Value;

        /// <summary>True for the first Paraphe of this Windows session.</summary>
        public static bool IsFirst()
        {
            _mutex = new Mutex(true, "Local\\Paraphe.SingleInstance", out bool created);
            Owner = created;
            return created;
        }

        /// <summary>Gives the path to the running Paraphe. False if none answers.</summary>
        public static bool TrySend(string path)
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    client.Connect(1500);
                    byte[] bytes = Encoding.UTF8.GetBytes(path + "\n");
                    client.Write(bytes, 0, bytes.Length);
                    client.Flush();
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Calls onPath (on a background thread) for each PDF another Paraphe hands over.</summary>
        public static void Listen(Action<string> onPath)
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            Task.Run(() =>
            {
                while (true)
                {
                    try
                    {
                        using (var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte,
                            PipeOptions.None, 4096, 4096, security))
                        {
                            server.WaitForConnection();
                            string path;
                            using (var reader = new StreamReader(server, Encoding.UTF8))
                                path = reader.ReadLine();
                            // Only an existing PDF is ever opened.
                            if (!string.IsNullOrEmpty(path) && path.Length < 32768 &&
                                path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) && File.Exists(path))
                            {
                                onPath(Path.GetFullPath(path));
                            }
                        }
                    }
                    catch
                    {
                        Thread.Sleep(500);
                    }
                }
            });
        }
    }
}
