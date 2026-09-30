/** Structured logging interface. The engine depends only on this. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bound: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly pretty: boolean = true,
    private readonly bound: LogFields = {},
  ) {}

  private log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const all: LogFields = { ...this.bound, ...fields };
    const ts = new Date().toISOString();
    if (this.pretty) {
      const parts = Object.entries(all)
        .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
        .map(([k, v]) => `${k}=${format(v)}`);
      const line = [ts, level.toUpperCase().padEnd(5), message, ...parts].join(" ");
      process.stderr.write(line + "\n");
    } else {
      process.stderr.write(JSON.stringify({ ts, level, message, ...all }) + "\n");
    }
  }

  debug(message: string, fields?: LogFields): void { this.log("debug", message, fields); }
  info(message: string, fields?: LogFields): void { this.log("info", message, fields); }
  warn(message: string, fields?: LogFields): void { this.log("warn", message, fields); }
  error(message: string, fields?: LogFields): void { this.log("error", message, fields); }

  child(bound: LogFields): Logger {
    return new ConsoleLogger(this.level, this.pretty, { ...this.bound, ...bound });
  }
}

export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger { return this; }
}

export function createLogger(opts: { enabled: boolean; level: LogLevel; pretty: boolean }): Logger {
  return opts.enabled ? new ConsoleLogger(opts.level, opts.pretty) : new NoopLogger();
}

function format(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "string" && /[\s"']/.test(v)) return JSON.stringify(v);
  return String(v);
}
