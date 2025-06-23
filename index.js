// main.js - Main Electron process with OAuth
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
  globalShortcut,
} = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const crypto = require("crypto");
const { URL } = require("url");
const os = require("os");

// Your Trello App credentials - replace these with your actual values
const TRELLO_APP_KEY = "15fe0c1c225786c3f1200698035f4571"; // Get from https://trello.com/app-key
const TRELLO_APP_NAME = "Trello Task Manager";
const TRELLO_SCOPE = "read";
const TRELLO_EXPIRATION = "never";

function isPortableFunc() {
  const exeDir = path.dirname(app.getPath("exe"));
  const portableDataPath = path.join(exeDir, "data");
  return fs.existsSync(portableDataPath);
}

const isDev = !app.isPackaged;

if (!isDev && isPortableFunc()) {
  const portableUserData = path.join(path.dirname(app.getPath("exe")), "data");
  app.setPath("userData", portableUserData);
  app.setPath("appData", portableUserData);
}

const isPortable = !isDev && app.getPath("appData").includes(path.sep + "data");

let configPath;
if (isDev) {
  configPath = path.join(__dirname, "dev_user_data");
} else {
  configPath = path.join(
    app.getPath("appData"),
    isPortable ? "" : app.getName()
  );
}

class TrelloTaskManager {
  constructor() {
    this.tray = null;
    this.window = null;
    this.oauthWindow = null;
    this.configPath = path.join(configPath, "config.json");

    if (!fs.existsSync(this.configPath)) {
      if (!fs.existsSync(path.dirname(this.configPath))) {
        fs.mkdirSync(path.dirname(this.configPath));
      }
      const defaultConfig = {
        apiKey: TRELLO_APP_KEY,
        token: "",
        boardId: "",
        listIds: [],
        theme: "dark",
        isAuthenticated: false,
      };
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
    }

    this.config = this.loadConfig();

    // Ensure API key is set
    if (!this.config.apiKey) {
      this.config.apiKey = TRELLO_APP_KEY;
      this.saveConfig();
    }

    if (process.platform === "win32") {
      app.setAppUserModelId(app.getName());
    }
  }

  loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    } catch (error) {
      return {
        apiKey: TRELLO_APP_KEY,
        token: "",
        boardId: "",
        listIds: [],
        theme: "dark",
        isAuthenticated: false,
      };
    }
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  createWindow() {
    this.window = new BrowserWindow({
      width: 500,
      height: 600,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    this.window.loadFile("renderer.html");

    // Position window near system tray
    this.positionWindow();

    // Hide window when it loses focus
    this.window.on("blur", () => {
      this.window.hide();
    });
  }

  positionWindow() {
    const { screen } = require("electron");
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    // Position in bottom-right corner
    this.window.setPosition(width - 520, height - 620);
  }

  createTray() {
    // Create tray icon
    const iconPath = this.createTrayIcon();
    this.tray = new Tray(iconPath);

    this.tray.setToolTip("Trello Task Manager - What's Next?");

    // Single click to show next task
    this.tray.on("click", () => {
      this.showNextTask();
    });

    // Right click for context menu
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "🎯 What's Next?",
        click: () => this.showNextTask(),
      },
      {
        label: "⚙️ Settings",
        click: () => this.showSettings(),
      },
      { type: "separator" },
      {
        label: "🔄 Refresh",
        click: () => this.refreshTasks(),
      },
      { type: "separator" },
      {
        label: "🔐 Re-authenticate",
        click: () => this.startOAuthFlow(),
      },
      { type: "separator" },
      {
        label: "❌ Exit",
        click: () => app.quit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  createTrayIcon() {
    // Create a simple tray icon programmatically
    const iconSize = 16;
    const canvas = require("canvas").createCanvas(iconSize, iconSize);
    const ctx = canvas.getContext("2d");

    // Draw checklist icon
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, iconSize, iconSize);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.strokeRect(2, 2, iconSize - 4, iconSize - 4);

    // Checkmark
    ctx.strokeStyle = "#00aa00";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(4, 8);
    ctx.lineTo(6, 10);
    ctx.lineTo(10, 6);
    ctx.stroke();

    // Save as temporary file
    const iconPath = path.join(
      isPortable ? __dirname : os.tmpdir(),
      "temp-icon.png"
    );
    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(iconPath, buffer);

    return iconPath;
  }

  async showNextTask() {
    if (!this.config.isAuthenticated || !this.config.token) {
      this.showSettings();
      return;
    }

    // Fix: Check if window exists and is not destroyed
    if (!this.window || this.window.isDestroyed()) {
      this.createWindow();
    }

    try {
      const task = await this.getNextTask();
      this.window.webContents.send("show-task", task);
      this.window.show();
      this.window.focus();
    } catch (error) {
      console.error("Error fetching task:", error);
      if (error.response && error.response.status === 401) {
        // Token expired or invalid
        this.config.isAuthenticated = false;
        this.config.token = "";
        this.saveConfig();
        this.window.webContents.send(
          "show-error",
          "Authentication expired. Please re-authenticate in settings."
        );
      } else {
        this.window.webContents.send(
          "show-error",
          "Failed to fetch tasks. Check your connection."
        );
      }
      this.window.show();
    }
  }

  showSettings() {
    this.window.webContents.send("show-settings", this.config);
    this.window.show();
    this.window.focus();
  }

  // Improved OAuth handling in your main.js
  async startOAuthFlow() {
    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(32).toString("hex");

      // Build OAuth URL
      const authUrl = new URL("https://trello.com/1/authorize");
      authUrl.searchParams.set("key", TRELLO_APP_KEY);
      authUrl.searchParams.set("name", TRELLO_APP_NAME);
      authUrl.searchParams.set("scope", TRELLO_SCOPE);
      authUrl.searchParams.set("expiration", TRELLO_EXPIRATION);
      authUrl.searchParams.set("response_type", "token");
      authUrl.searchParams.set("state", state);
      // Add return_url to help with redirect detection
      authUrl.searchParams.set(
        "return_url",
        "https://trello.com/1/token/approve"
      );

      this.oauthWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      this.oauthWindow.loadURL(authUrl.toString());

      // Monitor ALL navigation events
      const handleNavigation = (event, navigationUrl) => {
        console.log("Navigation to:", navigationUrl); // Debug log
        this.handleOAuthRedirect(navigationUrl, state, resolve, reject);
      };

      this.oauthWindow.webContents.on("did-navigate", handleNavigation);
      this.oauthWindow.webContents.on("did-navigate-in-page", handleNavigation);
      this.oauthWindow.webContents.on("did-finish-load", () => {
        this.oauthWindow.webContents
          .executeJavaScript("window.location.hash")
          .then((hash) => {
            if (hash && hash.includes("token=")) {
              const params = new URLSearchParams(hash.substring(1));
              const token = params.get("token");
              // Trello does NOT return state in the hash, so don't check it here
              if (token) {
                this.completeOAuth(token, resolve, reject);
              }
            }
          });
      });

      // Also check for title changes (Trello changes the title on success)
      this.oauthWindow.webContents.on("page-title-updated", (event, title) => {
        console.log("Title changed to:", title); // Debug log
        if (title.includes("approved") || title.includes("success")) {
          // Inject script to get the token from the page
          this.oauthWindow.webContents
            .executeJavaScript(
              `
          // Check URL hash
          if (window.location.hash) {
            window.location.hash;
          } else if (document.body.textContent.includes('token')) {
            // Sometimes Trello shows the token in the page content
            document.body.textContent;
          } else {
            null;
          }
        `
            )
            .then((result) => {
              if (result) {
                console.log("JavaScript result:", result); // Debug log
                this.extractTokenFromContent(result, state, resolve, reject);
              }
            })
            .catch((err) => {
              console.error("JavaScript execution error:", err);
            });
        }
      });

      this.oauthWindow.on("closed", () => {
        this.oauthWindow = null;
        reject(new Error("OAuth window was closed"));
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.oauthWindow) {
          this.oauthWindow.close();
          reject(new Error("OAuth timeout"));
        }
      }, 300000);
    });
  }

  handleOAuthRedirect(url, expectedState, resolve, reject) {
    try {
      console.log("Handling redirect for URL:", url); // Debug log

      const urlObj = new URL(url);

      // Check hash fragment first
      if (urlObj.hash && urlObj.hash.includes("token=")) {
        const hashParams = new URLSearchParams(urlObj.hash.substring(1));
        const token = hashParams.get("token");
        // Trello does NOT return state in the hash
        if (token) {
          this.completeOAuth(token, resolve, reject);
          return;
        }
      }

      // Check query parameters as fallback
      if (urlObj.searchParams.has("token")) {
        const token = urlObj.searchParams.get("token");
        const state = urlObj.searchParams.get("state");

        if (state === expectedState && token) {
          this.completeOAuth(token, resolve, reject);
          return;
        }
      }

      // Check if we're on Trello's success page
      if (
        url.includes("trello.com") &&
        (url.includes("approve") || url.includes("success"))
      ) {
        // Try to extract token from the page content
        this.oauthWindow.webContents
          .executeJavaScript(
            `
        // Look for token in various places
        const bodyText = document.body.textContent || document.body.innerText;
        const tokenMatch = bodyText.match(/token["\s:=]+([a-f0-9]{64})/i);
        tokenMatch ? tokenMatch[1] : null;
      `
          )
          .then((token) => {
            if (token) {
              console.log("Found token in page content:", "Yes"); // Debug log
              this.completeOAuth(token, resolve, reject);
            }
          })
          .catch((err) => {
            console.error("Error extracting token from page:", err);
          });
      }
    } catch (error) {
      console.error("Error handling OAuth redirect:", error);
    }
  }

  extractTokenFromContent(content, expectedState, resolve, reject) {
    try {
      // Try to extract token from hash
      if (content.startsWith("#")) {
        const hashParams = new URLSearchParams(content.substring(1));
        const token = hashParams.get("token");
        const state = hashParams.get("state");

        if (state === expectedState && token) {
          this.completeOAuth(token, resolve, reject);
          return;
        }
      }

      // Try regex extraction
      const tokenMatch = content.match(/token["\s:=]+([a-f0-9]{64})/i);
      if (tokenMatch) {
        this.completeOAuth(tokenMatch[1], resolve, reject);
      }
    } catch (error) {
      console.error("Error extracting token from content:", error);
    }
  }

  completeOAuth(token, resolve, reject) {
    console.log("Completing OAuth with token"); // Debug log

    // Save the token
    this.config.token = token;
    this.config.isAuthenticated = true;
    this.saveConfig();

    // Close OAuth window
    if (this.oauthWindow) {
      this.oauthWindow.close();
      this.oauthWindow = null;
    }

    // Notify the renderer
    this.window.webContents.send("oauth-success");

    resolve(token);
  }

  async getNextTask() {
    const baseUrl = "https://api.trello.com/1";
    const auth = {
      key: this.config.apiKey,
      token: this.config.token,
    };

    // Check each list in priority order
    for (const listId of this.config.listIds) {
      try {
        const response = await axios.get(`${baseUrl}/lists/${listId}/cards`, {
          params: { ...auth, fields: "name,desc,due,shortUrl,labels" },
        });

        if (response.data.length > 0) {
          const card = response.data[0];

          // Get list name
          const listResponse = await axios.get(`${baseUrl}/lists/${listId}`, {
            params: { ...auth, fields: "name" },
          });

          return {
            listName: listResponse.data.name,
            name: card.name,
            description: card.desc || "No description",
            due: card.due,
            url: card.shortUrl,
            labels: card.labels || [],
          };
        }
      } catch (error) {
        console.error(`Error fetching from list ${listId}:`, error);
        throw error; // Re-throw to handle authentication errors
      }
    }

    return {
      listName: "All Done!",
      name: "No tasks found",
      description: "🎉 You're all caught up! Time for a break.",
      due: null,
      url: null,
      labels: [],
    };
  }

  async refreshTasks() {
    this.showNextTask();
  }

  createShortCuts() {
    const showTaskRegistered = globalShortcut.register("Ctrl+Alt+T", () => {
      this.showNextTask();
    });
    if (!showTaskRegistered) {
      console.error("Shortcut Ctrl/Cmd+Alt+T registration failed.");
    }

    const refreshRegistered = globalShortcut.register("Ctrl+Alt+R", () => {
      this.refreshTasks();
    });
    if (!refreshRegistered) {
      console.error("Shortcut Ctrl/Cmd+Alt+R registration failed.");
    }
  }
}

// IPC handlers
ipcMain.handle("save-config", (event, config) => {
  const manager = global.taskManager;
  manager.config = { ...manager.config, ...config };
  manager.saveConfig();
  return true;
});

ipcMain.handle("start-oauth", async () => {
  const manager = global.taskManager;
  try {
    await manager.startOAuthFlow();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-boards", async () => {
  const manager = global.taskManager;
  if (!manager.config.apiKey || !manager.config.token) return [];

  try {
    const response = await axios.get(
      "https://api.trello.com/1/members/me/boards",
      {
        params: {
          key: manager.config.apiKey,
          token: manager.config.token,
          fields: "name,id",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching boards:", error);
    return [];
  }
});

ipcMain.handle("get-lists", async (event, boardId) => {
  const manager = global.taskManager;
  if (!manager.config.apiKey || !manager.config.token || !boardId) return [];

  try {
    const response = await axios.get(
      `https://api.trello.com/1/boards/${boardId}/lists`,
      {
        params: {
          key: manager.config.apiKey,
          token: manager.config.token,
          fields: "name,id",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching lists:", error);
    return [];
  }
});

ipcMain.handle("logout", () => {
  const manager = global.taskManager;
  manager.config.token = "";
  manager.config.isAuthenticated = false;
  manager.config.boardId = "";
  manager.config.listIds = [];
  manager.saveConfig();
  return true;
});

ipcMain.handle("get-config", () => {
  const manager = global.taskManager;
  return manager.config;
});

ipcMain.handle("refresh-task", async () => {
  const manager = global.taskManager;
  await manager.refreshTasks();
});

// App initialization
app.whenReady().then(() => {
  global.taskManager = new TrelloTaskManager();
  global.taskManager.createWindow();
  global.taskManager.createTray();
  global.taskManager.createShortCuts();

  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
  });
});

app.on("window-all-closed", (e) => {
  e.preventDefault(); // Keep app running in tray
});

app.on("before-quit", () => {
  // Cleanup temp files
  const iconPath = path.join(__dirname, "temp-icon.png");
  if (fs.existsSync(iconPath)) {
    fs.unlinkSync(iconPath);
  }
});

// Handle app activation (macOS)
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    global.taskManager.createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
