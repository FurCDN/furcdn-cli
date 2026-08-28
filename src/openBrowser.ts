import { spawn } from "node:child_process";

// 盡力嘗試自動開啟瀏覽器；失敗一律靜默 fallback（網址已經印在終端機上了，
// 不能讓「開瀏覽器失敗」變成整個 login 失敗）。不引入額外相依套件，
// 直接呼叫各平台原生指令。
export function openInBrowser(url: string): void {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", '""', url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // 常見於無 GUI 的伺服器 / 容器環境，忽略即可
    });
    child.unref();
  } catch {
    // 同上：靜默忽略
  }
}
