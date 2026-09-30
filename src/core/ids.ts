import { randomUUID } from "node:crypto";

/** Generates a short, unique, URL-safe request id for observability. */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
