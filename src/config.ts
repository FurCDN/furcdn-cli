import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  apiKey?: string;
  apiBase?: string;
}

const DEFAULT_API_BASE = "https://www.furcdn.us";

function configDir(): string {
  return path.join(os.homedir(), ".config", "furcdn");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

function sessionPath(): string {
  return path.join(configDir(), "session.json");
}

export interface SessionData {
  token: string;
  username?: string;
  role?: string;
  savedAt: string;
}

export function readSession(): SessionData | null {
  try {
    const raw = fs.readFileSync(sessionPath(), "utf8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export function writeSession(data: SessionData): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath(), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function clearSession(): void {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    // 本來就沒有 session 檔，視為已登出
  }
}

// 環境變數優先於本機 session 檔。
export function resolveSessionToken(): string | undefined {
  return process.env.FURCDN_SESSION_TOKEN || readSession()?.token;
}

export function readStoredConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function writeStoredConfig(cfg: CliConfig): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

// 環境變數優先於設定檔，方便 CI / 一次性覆蓋而不動到本機設定檔。
export function resolveApiKey(): string | undefined {
  return process.env.FURCDN_API_KEY || readStoredConfig().apiKey;
}

export function resolveApiBase(): string {
  return (
    process.env.FURCDN_API_BASE ||
    readStoredConfig().apiBase ||
    DEFAULT_API_BASE
  );
}

export function setApiKey(key: string): void {
  const cfg = readStoredConfig();
  cfg.apiKey = key;
  writeStoredConfig(cfg);
}

export function setApiBase(base: string): void {
  const cfg = readStoredConfig();
  cfg.apiBase = base.replace(/\/+$/, "");
  writeStoredConfig(cfg);
}

export function getConfigPath(): string {
  return configPath();
}
