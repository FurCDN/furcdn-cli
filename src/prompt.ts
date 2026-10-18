import { once } from "node:events";
import { createInterface } from "node:readline/promises";

export async function promptText(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    // stdin 被關閉（管線結束、stdin 為 /dev/null）時 readline 只會發 close，
    // question 的 promise 永遠不會 settle；跟 close 事件賽跑，關閉時視同空回答。
    const answer = await Promise.race([
      rl.question(question),
      once(rl, "close").then(() => ""),
    ]);
    return answer.trim();
  } finally {
    rl.close();
  }
}

// 終端機下用原始模式關掉字元回顯來遮蔽密碼；非 TTY（管線 / CI）時退回明文讀取，
// 這樣 `echo pass | furcdn login` 這種用法仍然可行。
export function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return promptText(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (char: string) => {
      switch (char) {
        case "\n":
        case "\r":
        case "":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
          break;
        case "": // Ctrl+C
          stdin.setRawMode(false);
          process.exit(130);
          break;
        case "": // backspace
        case "\b":
          input = input.slice(0, -1);
          break;
        default:
          input += char;
          break;
      }
    };
    stdin.on("data", onData);
  });
}

export async function promptConfirm(question: string): Promise<boolean> {
  // 非互動環境（CI、stdin 被關閉、管線）下 readline 永遠等不到輸入，
  // 與其卡住不如直接告訴使用者該加 --yes。
  if (!process.stdin.isTTY) {
    throw new Error("非互動環境請加 --yes");
  }
  const answer = await promptText(`${question} (y/N) `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
