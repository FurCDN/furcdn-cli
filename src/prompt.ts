import readline from "node:readline";

export function promptText(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
  const answer = await promptText(`${question} (y/N) `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
