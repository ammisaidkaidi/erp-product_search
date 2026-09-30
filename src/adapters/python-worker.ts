import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { ModelUnavailableError } from "../core/errors.js";
import type { Logger } from "../logging/logger.js";

/**
 * JSONL-over-stdio client for adapters/python/model_worker.py.
 *
 * Chosen over a network service deliberately: no ports, no HTTP overhead,
 * works offline on Windows. See adapters/python/README.md for the protocol.
 *
 * Failure semantics (never silent):
 *  - spawn failure / repeated crashes  -> ModelUnavailableError (caller falls back)
 *  - request timeout                   -> process killed + ModelUnavailableError
 *  - worker reports UNAVAILABLE        -> surfaced as an error result
 *  - stderr lines                      -> forwarded to the logger (warn/error)
 */
export interface PythonModelWorkerOptions {
  pythonPath: string;
  workerPath: string;
  /** Extra CLI args for the worker (e.g. ["--model", "X", "--backend", "llm"]). */
  args?: string[];
  /** Per-request timeout. */
  timeoutMs: number;
  /** Startup timeout (first model load can be slow). */
  warmupTimeoutMs: number;
  logger: Logger;
}

export interface WorkerErrorInfo {
  code: "UNAVAILABLE" | "INVALID_INPUT" | "INTERNAL" | string;
  message: string;
}

export type WorkerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: WorkerErrorInfo };

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  timer: NodeJS.Timeout;
}

export class PythonModelWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = "";
  private seq = 0;
  private starting: Promise<void> | null = null;
  private crashed = false;
  private crashReason: string | null = null;
  private stderrTail: string[] = [];
  private readonly events = new EventEmitter();

  constructor(private readonly options: PythonModelWorkerOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.crashed;
  }

  /** Spawn + ping. Throws ModelUnavailableError when the worker cannot serve. */
  async start(): Promise<void> {
    if (this.child && !this.crashed) return;
    if (this.crashed) {
      throw new ModelUnavailableError(
        `python model worker previously crashed: ${this.crashReason}`,
        "python-worker",
        "Check the logs; the worker stays disabled for this process once crashed twice.",
      );
    }
    if (!this.starting) {
      this.starting = this.spawnAndPing().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async spawnAndPing(): Promise<void> {
    const args = [this.options.workerPath, ...(this.options.args ?? [])];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.pythonPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      throw new ModelUnavailableError(
        `failed to spawn python worker (${this.options.pythonPath} ${args.join(" ")})`,
        "python-worker",
        "install Python 3.10+ and set reranking.von.python_path",
        e,
      );
    }
    this.child = child;
    this.wire(child);

    try {
      const pong = await this.request("ping", {}, this.options.warmupTimeoutMs);
      if (!pong.ok) {
        this.kill();
        throw new ModelUnavailableError(
          `python worker ping failed: ${pong.error.message}`,
          "python-worker",
        );
      }
      this.options.logger.info("python model worker ready", {
        python: this.options.pythonPath,
        args: args.join(" "),
      });
    } catch (e) {
      this.kill();
      if (e instanceof ModelUnavailableError) throw e;
      throw new ModelUnavailableError(
        `python worker did not become ready within ${this.options.warmupTimeoutMs}ms: ${(e as Error).message}`,
        "python-worker",
        "First model download can be slow; raise reranking.von.warmup_timeout_ms.",
        e,
      );
    }
  }

  private wire(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of String(chunk).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        // model load chatter is normal; surface everything at debug, errors at warn
        this.options.logger.warn("python worker stderr", { line: trimmed.slice(0, 500) });
      }
    });
    child.on("error", (e) => this.onCrash(`process error: ${e.message}`));
    child.on("exit", (code, signal) => this.onCrash(`exit code=${code} signal=${signal}`));
  }

  private onCrash(reason: string): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    const error: WorkerResponse = {
      ok: false,
      error: { code: "INTERNAL", message: `worker crashed: ${reason}` },
    };
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(error);
    }
    this.pending.clear();
    this.options.logger.error("python model worker crashed", {
      reason,
      stderr: this.stderrTail.join(" | ").slice(-1000),
    });
    this.child = null;
    this.events.emit("crash");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.logger.warn("python worker sent invalid JSON", { line: line.slice(0, 200) });
      return;
    }
    const response = parsed as { id?: string; ok?: boolean };
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok === true) {
      pending.resolve({ ok: true, result: (parsed as { result: unknown }).result });
    } else {
      const error = (parsed as { error?: WorkerErrorInfo }).error ?? {
        code: "INTERNAL",
        message: "unknown worker error",
      };
      pending.resolve({ ok: false, error });
    }
  }

  /** Send one request; resolves with the worker's response (ok or error). */
  request(op: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<WorkerResponse> {
    const timeout = timeoutMs ?? this.options.timeoutMs;
    if (!this.child || this.crashed) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: this.crashed
            ? `python worker unavailable: ${this.crashReason}`
            : "python worker not started",
        },
      });
    }
    const id = `r${++this.seq}`;
    return new Promise<WorkerResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.options.logger.error("python worker request timeout", { op, timeout_ms: timeout });
        resolve({
          ok: false,
          error: { code: "INTERNAL", message: `request '${op}' timed out after ${timeout}ms` },
        });
      }, timeout);
      this.pending.set(id, { resolve, timer });
      const line = `${JSON.stringify({ id, op, payload })}\n`;
      this.child!.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          resolve({ ok: false, error: { code: "INTERNAL", message: `stdin write failed: ${err.message}` } });
        }
      });
    });
  }

  kill(): void {
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill();
      this.child = null;
    }
  }

  async dispose(): Promise<void> {
    this.kill();
  }
}
