import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Executes a Claude CLI prompt safely on Windows.
// Problem: execFile('claude.cmd') → EINVAL (Windows can't exec .cmd without shell)
//          execFile with shell:true → shell interprets | < > " in prompt as operators
// Solution: write prompt to temp file, pipe via PowerShell (a real .exe, no escaping needed)
export async function execClaude(prompt: string, timeoutMs = 60000): Promise<string> {
  const promptPath = join(
    tmpdir(),
    `fos_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
  );

  await writeFile(promptPath, prompt, "utf8");

  try {
    // Pipe via stdin — avoids all Windows command-line escaping issues with quotes/newlines
    const psCommand = `Get-Content -Raw "${promptPath}" | & claude.cmd --dangerously-skip-permissions --output-format json`;

    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-Command", psCommand],
      { timeout: timeoutMs, windowsHide: true }
    );
    if (stderr) console.error(`[execClaude] stderr for prompt:`, stderr.slice(0, 300));
    return stdout;
  } finally {
    await unlink(promptPath).catch(() => {});
  }
}

// Parse Claude CLI JSON output → extract result text
export function parseClaudeOutput(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result ?? stdout;
  } catch {
    return stdout;
  }
}
