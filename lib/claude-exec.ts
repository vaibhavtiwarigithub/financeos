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
export async function execClaude(prompt: string, timeoutMs = 90000): Promise<string> {
  const promptPath = join(
    tmpdir(),
    `fos_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
  );

  await writeFile(promptPath, prompt, "utf8");

  const psCommand = `Get-Content -Raw "${promptPath}" | & claude.cmd --dangerously-skip-permissions --output-format json`;
  const psArgs = ["-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand];
  const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync("powershell.exe", psArgs, opts);
      if (stderr) console.error(`[execClaude] stderr:`, stderr.slice(0, 300));
      await unlink(promptPath).catch(() => {});
      return stdout;
    } catch (err) {
      lastErr = err;
      // Cold-start: claude.cmd takes ~10s to init MCP on first call — retry after brief wait
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }

  await unlink(promptPath).catch(() => {});
  throw lastErr;
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
