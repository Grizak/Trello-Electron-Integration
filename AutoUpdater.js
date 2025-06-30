// Auto-Update System for Trello Electron Integration
// This system checks for updates from GitHub releases API

const https = require("https");
const fs = require("fs");
const path = require("path");
const { app, dialog, shell } = require("electron");
const { spawn } = require("child_process");

class AutoUpdater {
  constructor(options = {}) {
    this.repoOwner = options.repoOwner || "Grizak";
    this.repoName = options.repoName || "Trello-Electron-Integration";
    this.currentVersion = options.currentVersion || app.getVersion();
    this.checkInterval = options.checkInterval || 24 * 60 * 60 * 1000; // 24 hours
    this.autoDownload = options.autoDownload || false;
    this.autoInstall = options.autoInstall || false;

    this.apiUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
    this.updateCheckTimer = null;

    // Events
    this.callbacks = {
      "checking-for-update": [],
      "update-available": [],
      "update-not-available": [],
      "download-progress": [],
      "update-downloaded": [],
      error: [],
    };
  }

  // Event emitter methods
  on(event, callback) {
    if (this.callbacks[event]) {
      this.callbacks[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event].forEach((callback) => callback(data));
    }
  }

  // Start automatic update checking
  startAutoCheck() {
    this.checkForUpdates();
    this.updateCheckTimer = setInterval(() => {
      this.checkForUpdates();
    }, this.checkInterval);
  }

  // Stop automatic update checking
  stopAutoCheck() {
    if (this.updateCheckTimer) {
      clearInterval(this.updateCheckTimer);
      this.updateCheckTimer = null;
    }
  }

  // Check for updates
  async checkForUpdates() {
    try {
      this.emit("checking-for-update");

      const releaseData = await this.fetchLatestRelease();
      const latestVersion = this.parseVersion(releaseData.tag_name);
      const currentVersion = this.parseVersion(this.currentVersion);

      if (this.isNewerVersion(latestVersion, currentVersion)) {
        const updateInfo = {
          version: releaseData.tag_name,
          releaseNotes: releaseData.body,
          publishedAt: releaseData.published_at,
          assets: releaseData.assets,
          downloadUrl: this.getDownloadUrl(releaseData.assets),
        };

        this.emit("update-available", updateInfo);

        if (this.autoDownload) {
          this.downloadUpdate(updateInfo);
        }
      } else {
        this.emit("update-not-available");
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  // Fetch latest release from GitHub API
  fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "api.github.com",
        path: `/repos/${this.repoOwner}/${this.repoName}/releases/latest`,
        method: "GET",
        headers: {
          "User-Agent": `${this.repoName}-AutoUpdater`,
          Accept: "application/vnd.github.v3+json",
        },
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const releaseData = JSON.parse(data);
            if (res.statusCode === 200) {
              resolve(releaseData);
            } else {
              reject(
                new Error(
                  `GitHub API Error: ${res.statusCode} - ${releaseData.message}`
                )
              );
            }
          } catch (error) {
            reject(new Error("Failed to parse GitHub API response"));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.end();
    });
  }

  // Parse version string (remove 'v' prefix if present)
  parseVersion(versionString) {
    return versionString.replace(/^v/, "");
  }

  // Compare versions (basic semantic versioning)
  isNewerVersion(latest, current) {
    const latestParts = latest.split(".").map(Number);
    const currentParts = current.split(".").map(Number);

    for (
      let i = 0;
      i < Math.max(latestParts.length, currentParts.length);
      i++
    ) {
      const latestPart = latestParts[i] || 0;
      const currentPart = currentParts[i] || 0;

      if (latestPart > currentPart) return true;
      if (latestPart < currentPart) return false;
    }

    return false;
  }

  // Get appropriate download URL based on platform
  getDownloadUrl(assets) {
    const platform = process.platform;

    // For Windows - look for .exe files
    if (platform === "win32") {
      // Prefer setup file over portable exe
      const setupAsset = assets.find(
        (asset) =>
          asset.name.toLowerCase().includes("setup") &&
          asset.name.endsWith(".exe")
      );
      if (setupAsset) return setupAsset.browser_download_url;

      // Fallback to any .exe file
      const exeAsset = assets.find((asset) => asset.name.endsWith(".exe"));
      if (exeAsset) return exeAsset.browser_download_url;
    }

    // For macOS - look for .dmg or .pkg files
    if (platform === "darwin") {
      const macAsset = assets.find(
        (asset) => asset.name.endsWith(".dmg") || asset.name.endsWith(".pkg")
      );
      if (macAsset) return macAsset.browser_download_url;
    }

    // For Linux - look for .AppImage, .deb, .rpm, etc.
    if (platform === "linux") {
      const linuxAsset = assets.find(
        (asset) =>
          asset.name.endsWith(".AppImage") ||
          asset.name.endsWith(".deb") ||
          asset.name.endsWith(".rpm")
      );
      if (linuxAsset) return linuxAsset.browser_download_url;
    }

    return null;
  }

  // Download update file
  async downloadUpdate(updateInfo) {
    if (!updateInfo.downloadUrl) {
      throw new Error("No compatible download URL found for your platform");
    }

    const downloadPath = path.join(
      app.getPath("appData"),
      "updates",
      `update-${updateInfo.version}`
    );
    const fileName = path.basename(updateInfo.downloadUrl.split("?")[0]);
    const filePath = path.join(downloadPath, fileName);

    // Create updates directory
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);

      https
        .get(updateInfo.downloadUrl, (response) => {
          const totalSize = parseInt(response.headers["content-length"], 10);
          let downloadedSize = 0;

          response.pipe(file);

          response.on("data", (chunk) => {
            downloadedSize += chunk.length;
            const progress = (downloadedSize / totalSize) * 100;

            this.emit("download-progress", {
              percent: progress,
              transferred: downloadedSize,
              total: totalSize,
            });
          });

          file.on("finish", () => {
            file.close();
            this.emit("update-downloaded", {
              ...updateInfo,
              filePath: filePath,
            });

            if (this.autoInstall) {
              this.installUpdate(filePath);
            }

            resolve(filePath);
          });
        })
        .on("error", (error) => {
          fs.unlink(filePath, () => {}); // Delete partial file
          reject(error);
        });
    });
  }

  // Install update (platform-specific)
  installUpdate(filePath) {
    const platform = process.platform;

    if (platform === "win32") {
      // For Windows, run the installer
      spawn(filePath, [], { detached: true, stdio: "ignore" });
      app.quit();
    } else if (platform === "darwin") {
      // For macOS, open the .dmg file
      shell.openPath(filePath);
    } else if (platform === "linux") {
      // For Linux, depends on the package type
      if (filePath.endsWith(".AppImage")) {
        // Make AppImage executable and run it
        fs.chmodSync(filePath, "755");
        spawn(filePath, [], { detached: true, stdio: "ignore" });
        app.quit();
      } else {
        // For .deb/.rpm, just open the file manager
        shell.showItemInFolder(filePath);
      }
    }
  }

  // Show update dialog to user
  async showUpdateDialog(updateInfo) {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Update Available",
      message: `A new version (${updateInfo.version}) is available!`,
      detail: `Current version: ${this.currentVersion}\nNew version: ${updateInfo.version}\n\nWould you like to download and install the update?`,
      buttons: ["Download & Install", "Download Only", "Later"],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 0) {
      // Download and install
      const filePath = await this.downloadUpdate(updateInfo);
      this.installUpdate(filePath);
    } else if (result.response === 1) {
      // Download only
      await this.downloadUpdate(updateInfo);
    }
  }
}

// Usage example
function initializeAutoUpdater(options) {
  const updater = new AutoUpdater({
    ...options,
  });

  // Set up event listeners
  updater.on("checking-for-update", () => {
    console.log("Checking for updates...");
  });

  updater.on("update-available", (updateInfo) => {
    console.log("Update available:", updateInfo.version);
    updater.showUpdateDialog(updateInfo);
  });

  updater.on("update-not-available", () => {
    console.log("No updates available");
  });

  updater.on("download-progress", (progress) => {
    console.log(`Download progress: ${progress.percent.toFixed(1)}%`);
  });

  updater.on("update-downloaded", (updateInfo) => {
    console.log("Update downloaded:", updateInfo.filePath);
  });

  updater.on("error", (error) => {
    console.error("Update error:", error);
  });

  // Start checking for updates
  updater.startAutoCheck();

  return updater;
}

module.exports = { AutoUpdater, initializeAutoUpdater };
