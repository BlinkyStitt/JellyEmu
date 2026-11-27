using JellyEmu.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace JellyEmu.Controllers
{
    /// <summary>Describes the files needed for an offline EmulatorJS game.</summary>
    public class JellyEmuOfflineController : JellyEmuBaseController
    {
        private readonly JellyEmuInputService _inputService;

        public JellyEmuOfflineController(ILibraryManager libraryManager, IApplicationPaths appPaths,
            ILogger<JellyEmuOfflineController> logger, JellyEmuEjsManager ejsManager,
            JellyEmuSessionService sessionService, IHttpClientFactory httpClientFactory, JellyEmuInputService inputService)
            : base(libraryManager, appPaths, logger, ejsManager, sessionService, httpClientFactory)
        {
            _inputService = inputService;
        }

        /// <summary>Lists every file needed to launch a single-ROM game without the server.</summary>
        [HttpGet("/jellyemu/offline/{itemId}/manifest")]
        public IActionResult DownloadManifest(string itemId, [FromQuery] string userId, [FromQuery] string? core)
        {
            if (!IsValidId(itemId) || !IsValidId(userId)) return BadRequest("Invalid item or user ID.");
            if (!VerifyUser(userId)) return Forbid();
            var item = LibraryManager.GetItemById(itemId);
            if (item == null || string.IsNullOrEmpty(item.Path)) return NotFound();
            var resolvedCore = ResolveCore(item, userId, core);
            if (string.IsNullOrEmpty(resolvedCore) || resolvedCore is "play" or "pico8" ||
                item.Path?.EndsWith(".j3u", StringComparison.OrdinalIgnoreCase) == true)
                return UnprocessableEntity("Offline downloads require a single-ROM EmulatorJS game.");
            if (!EjsManager.IsReady) return Conflict("Emulator files are still downloading on the server. Try again later.");

            var files = GetRuntimeFiles(EjsManager.LocalRoot, resolvedCore);
            if (!files.Any(p => p.StartsWith("cores/", StringComparison.Ordinal) && p.EndsWith(".data")))
                return Conflict("The selected emulator core is missing from the server.");
            var runtimeRoot = ToAppUrl("jellyemu/ejs/");
            var runtimeUrls = files.Select(p => runtimeRoot +
                string.Join('/', p.Split('/').Select(Uri.EscapeDataString))).ToArray();
            var filename = JellyEmuPlayController.CleanCosmeticFilename(Path.GetFileName(item.Path) ?? itemId);
            var romUrl = ToAppUrl($"jellyemu/rom/{itemId}/{Uri.EscapeDataString(filename)}?userId={userId}");
            var bios = HttpContext.RequestServices.GetService(typeof(JellyEmuBiosService)) as JellyEmuBiosService;
            var biosPath = bios?.ResolveBiosRelativePath(ResolvePlatformTag(item), resolvedCore);
            var biosUrl = string.IsNullOrEmpty(biosPath) ? null : ToAppUrl("jellyemu/bios/file/" + biosPath);
            var controlScheme = _inputService.GetScheme(ResolvePlatformTag(item) ?? resolvedCore).Id;
            return Ok(new { name = item.Name, userId, core = resolvedCore, controlScheme, runtimeRoot, runtimeUrls, romUrl, biosUrl });
        }

        /// <summary>Includes common runtime files and only the selected core's bundles.</summary>
        internal static string[] GetRuntimeFiles(string root, string core)
        {
            return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Select(p => Path.GetRelativePath(root, p).Replace('\\', '/'))
                .Where(p => !p.StartsWith('.') && (!p.StartsWith("cores/", StringComparison.Ordinal) ||
                    Path.GetFileName(p).StartsWith(core + "-", StringComparison.Ordinal) ||
                    Path.GetFileName(p).StartsWith(core + ".", StringComparison.Ordinal)))
                .OrderBy(p => p, StringComparer.Ordinal).ToArray();
        }
    }
}
