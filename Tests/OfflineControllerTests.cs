using System.Text.Json;
using JellyEmu.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace JellyEmu.Tests
{
    public class OfflineControllerTests
    {
        [Fact]
        public void RuntimeFiles_IncludeCommonFilesAndSelectedCoreOnly()
        {
            var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
            Directory.CreateDirectory(Path.Combine(root, "cores"));
            try
            {
                foreach (var file in new[] { "loader.js", ".version", "cores/genesis_plus_gx-wasm.data",
                    "cores/genesis_plus_gx-thread-wasm.data", "cores/genesis_plus_gx.json", "cores/snes9x-wasm.data" })
                    File.WriteAllText(Path.Combine(root, file), "asset");
                Assert.Equal(new[] { "cores/genesis_plus_gx-thread-wasm.data", "cores/genesis_plus_gx-wasm.data",
                    "cores/genesis_plus_gx.json", "loader.js" },
                    JellyEmuOfflineController.GetRuntimeFiles(root, "genesis_plus_gx"));
            }
            finally { Directory.Delete(root, true); }
        }

        [Theory]
        [InlineData("")]
        [InlineData("/jellyfin")]
        public void LibraryAndWebManifest_RespectServerBasePath(string pathBase)
        {
            var controller = new JellyEmuOfflineController(null!, null!, null!, null!, null!, null!)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
            };
            controller.Request.PathBase = pathBase;
            controller.Request.Host = new HostString("localhost");
            var html = Assert.IsType<ContentResult>(controller.Library()).Content;
            Assert.Contains(pathBase + "/jellyemu/assets/ejs.offline.js", html);
            var manifest = Assert.IsType<JsonResult>(controller.WebManifest());
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(manifest.Value));
            Assert.Equal(pathBase + "/jellyemu/offline/", json.RootElement.GetProperty("start_url").GetString());
            Assert.Equal(pathBase + "/", json.RootElement.GetProperty("scope").GetString());
        }

        [Fact]
        public void DownloadManifest_RejectsAnotherUsersIdBeforeReadingLibrary()
        {
            var controller = new JellyEmuOfflineController(null!, null!, null!, null!, null!, null!)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
            };
            Assert.IsType<ForbidResult>(controller.DownloadManifest(Guid.NewGuid().ToString("N"),
                Guid.NewGuid().ToString("N"), null));
        }
    }
}
