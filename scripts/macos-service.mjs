import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.codex-pocket.server";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const LAUNCH_AGENTS = path.join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS, `${LABEL}.plist`);
const LOG_DIR = path.join(HOME, "Library", "Logs", "Codex Pocket");
const ENV_FILE = path.join(ROOT, ".env");
const SERVER_FILE = path.join(ROOT, "src", "server.mjs");

if (process.platform !== "darwin") {
  console.error("macOS LaunchAgent commands are only supported on macOS.");
  process.exit(1);
}

const action = process.argv[2] ?? "install";
const uid = String(process.getuid?.() ?? "");
const domain = `gui/${uid}`;
const service = `${domain}/${LABEL}`;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistValue(value) {
  if (Array.isArray(value)) return `<array>${value.map((entry) => plistValue(entry)).join("")}</array>`;
  if (value && typeof value === "object") {
    return `<dict>${Object.entries(value).map(([key, entry]) => `<key>${xml(key)}</key>${plistValue(entry)}`).join("")}</dict>`;
  }
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  return `<string>${xml(value)}</string>`;
}

async function buildPlist() {
  const node = process.execPath;
  const argumentsList = [node];
  try {
    await fs.access(ENV_FILE);
    argumentsList.push(`--env-file=${ENV_FILE}`);
  } catch {
    // The server can still start with its built-in defaults when .env is absent.
  }
  argumentsList.push(SERVER_FILE);
  const entries = {
    Label: LABEL,
    ProgramArguments: argumentsList,
    WorkingDirectory: ROOT,
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Interactive",
    ThrottleInterval: 5,
    StandardOutPath: path.join(LOG_DIR, "server.log"),
    StandardErrorPath: path.join(LOG_DIR, "server.log"),
    EnvironmentVariables: {
      HOME,
      PATH: [path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .filter((entry, index, entries) => entries.indexOf(entry) === index)
        .join(":"),
    },
  };
  const body = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key>${plistValue(value)}`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

function launchctl(args, allowFailure = false) {
  try {
    execFileSync("launchctl", args, { stdio: "inherit" });
    return true;
  } catch (error) {
    if (!allowFailure) throw error;
    return false;
  }
}

async function install() {
  await fs.mkdir(LAUNCH_AGENTS, { recursive: true, mode: 0o700 });
  await fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(PLIST_PATH, await buildPlist(), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(PLIST_PATH, 0o600);
  console.log(`Wrote ${PLIST_PATH}`);
}

async function start() {
  await install();
  launchctl(["bootout", domain, PLIST_PATH], true);
  launchctl(["bootstrap", domain, PLIST_PATH]);
  launchctl(["kickstart", "-k", service], true);
  console.log(`Started ${LABEL}`);
}

function stop() {
  launchctl(["bootout", domain, PLIST_PATH], true);
  console.log(`Stopped ${LABEL}`);
}

async function uninstall() {
  stop();
  await fs.rm(PLIST_PATH, { force: true });
  console.log(`Removed ${PLIST_PATH}`);
}

switch (action) {
  case "install":
    await install();
    break;
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "status":
    launchctl(["print", service]);
    break;
  default:
    console.error(`Unknown action: ${action}. Use install, start, stop, uninstall, or status.`);
    process.exit(1);
}
