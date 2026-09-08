import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAgyEnv } from './session.js';

export interface AgyStatusInfo {
  installed: boolean;
  version: string;
  agyPath: string;
  scratchDir: string;
  hasCachedAuth: boolean;
  authenticated?: boolean;
}

export async function detectAgyStatus(agyPath: string, scratchDir: string): Promise<AgyStatusInfo> {
  const geminiDir = join(homedir(), '.gemini');
  const hasCachedAuth = existsSync(geminiDir);

  try {
    if (!existsSync(scratchDir)) {
      mkdirSync(scratchDir, { recursive: true });
    }
  } catch {
    // Ignore mkdir error during status check
  }

  return new Promise((resolve) => {
    execFile(agyPath, ['--version'], { timeout: 4000, env: buildAgyEnv() }, (error, stdout) => {
      if (error) {
        resolve({
          installed: false,
          version: '',
          agyPath,
          scratchDir,
          hasCachedAuth,
        });
      } else {
        const version = stdout.trim();
        resolve({
          installed: true,
          version,
          agyPath,
          scratchDir,
          hasCachedAuth,
        });
      }
    });
  });
}

export function openLoginTerminal(agyPath: string): { started: boolean; error?: string } {
  try {
    const os = platform();
    if (os === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', agyPath], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
      child.unref();
      return { started: true };
    } else if (os === 'darwin') {
      const child = spawn('open', ['-a', 'Terminal', agyPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { started: true };
    } else {
      // Linux fallback
      const child = spawn('x-terminal-emulator', ['-e', agyPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { started: true };
    }
  } catch (err) {
    return {
      started: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 验证用看门狗上限。判定以 stdout 的 result 事件为准，不依赖进程退出，
 * 所以这个上限只兜底僵尸进程，给足余量即可；ping 实际耗时（含启动与
 * 模型请求）实测常态 13s 起，网络慢时更久，短硬超时会误杀慢请求。
 */
const VERIFY_TIMEOUT_MS = 90_000;

/**
 * 真实跑一次 `agy -p ping` 确认凭据有效（消耗一次模型请求，做成显式动作）。
 *
 * 不用 execFile：它默认给子进程一根从不关闭的 stdin 管道——agy 会话模式在
 * stdin 未 EOF 时会出完 `result` 仍空等（Windows 实测，与 4.7 的 agy models
 * 结论同源），execFile 必须等进程退出才回调，等于把判定绑在进程寿命上；
 * 再叠 20s 固定超时，慢请求一过线就被杀，宿主侧报 `Command failed: agy -p ping
 * ...`（此时 stdout 里的 result 往往已是 SUCCESS），设置页误报「凭据验证未通过」。
 *
 * 改为 spawn + 流式读事件：stdin 置 NUL（verify 不发送任何输入，关 stdin 即优雅
 * 结束会话），逐行解析 stdout，以 `result` 事件本身判定成败，判定后立即结束
 * 进程，不再等待退出；进程未出 result 就退出或触发看门狗时如实报错。
 */
export async function verifyCredentials(agyPath: string, scratchDir: string): Promise<{ authenticated: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!existsSync(scratchDir)) {
      mkdirSync(scratchDir, { recursive: true });
    }

    let child;
    try {
      child = spawn(
        agyPath,
        [
          '-p',
          'ping',
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
          '--print-timeout',
          '15s',
        ],
        {
          cwd: scratchDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: buildAgyEnv(),
        },
      );
    } catch (err) {
      resolve({
        authenticated: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let settled = false;
    let stderrTail = '';
    let watchdog: NodeJS.Timeout | null = null;

    const finish = (value: { authenticated: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch {
          // 进程已退出，忽略 kill 失败
        }
      }
      resolve(value);
    };

    watchdog = setTimeout(() => {
      finish({
        authenticated: false,
        error: `Antigravity CLI ping timed out after ${VERIFY_TIMEOUT_MS}ms`,
      });
    }, VERIFY_TIMEOUT_MS);
    watchdog.unref?.();

    child.on('error', (err: Error) => {
      finish({ authenticated: false, error: err.message });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let data: any;
      try {
        data = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行（进度输出等）跳过
      }
      if (data.event !== 'result') return;
      if (data.result?.status === 'SUCCESS') {
        finish({ authenticated: true });
      } else {
        finish({
          authenticated: false,
          error: data.result?.error?.message || `Returned ${data.result?.status ?? 'unknown'} status`,
        });
      }
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      const detail = stderrTail.trim().split(/\r?\n/).pop();
      finish({
        authenticated: false,
        error: detail || `Antigravity CLI exited with code ${code} before returning a result`,
      });
    });
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers['origin'];
  const host = req.headers['host'];
  if (!origin || !host) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host;
  } catch {
    return false;
  }
}
