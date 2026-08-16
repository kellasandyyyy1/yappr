/**
 * Shared types and helpers for the Firestore → Supabase migration.
 *
 * Design rule throughout: nothing is ever dropped silently. Every record that
 * cannot be placed is written to the issue log with its source path and the
 * reason, and the run reports a non-zero count at the end.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const DATA_DIR = path.join(process.cwd(), 'migration-data');
export const RAW_DIR = path.join(DATA_DIR, 'firestore');
export const OUT_DIR = path.join(DATA_DIR, 'postgres');
export const FILES_DIR = path.join(DATA_DIR, 'storage');

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, RAW_DIR, OUT_DIR, FILES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing input file: ${file}. Run the previous step first.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

// --- Issue log ---------------------------------------------------------------

export type Severity = 'warning' | 'error';

export interface Issue {
  sourcePath: string;
  targetTable?: string;
  severity: Severity;
  reason: string;
  payload?: unknown;
}

export class IssueLog {
  private issues: Issue[] = [];

  add(issue: Issue): void {
    this.issues.push(issue);
  }

  warn(sourcePath: string, reason: string, payload?: unknown, targetTable?: string): void {
    this.add({ sourcePath, reason, payload, targetTable, severity: 'warning' });
  }

  error(sourcePath: string, reason: string, payload?: unknown, targetTable?: string): void {
    this.add({ sourcePath, reason, payload, targetTable, severity: 'error' });
  }

  get all(): Issue[] {
    return this.issues;
  }

  get errorCount(): number {
    return this.issues.filter((i) => i.severity === 'error').length;
  }

  get warningCount(): number {
    return this.issues.filter((i) => i.severity === 'warning').length;
  }

  /** Prints a grouped summary so a thousand identical orphans read as one line. */
  report(label: string): void {
    if (this.issues.length === 0) {
      console.log(`  ${label}: no issues`);
      return;
    }
    const byReason = new Map<string, { count: number; severity: Severity; sample: string }>();
    for (const issue of this.issues) {
      const key = `${issue.severity}:${issue.reason}`;
      const entry = byReason.get(key);
      if (entry) entry.count++;
      else byReason.set(key, { count: 1, severity: issue.severity, sample: issue.sourcePath });
    }
    console.log(`  ${label}: ${this.errorCount} error(s), ${this.warningCount} warning(s)`);
    for (const [key, { count, severity, sample }] of byReason) {
      const reason = key.slice(key.indexOf(':') + 1);
      const mark = severity === 'error' ? 'ERROR' : 'warn ';
      console.log(`    [${mark}] ${count.toString().padStart(5)} × ${reason}`);
      console.log(`            e.g. ${sample}`);
    }
  }

  save(file: string): void {
    writeJson(file, this.issues);
  }
}

// --- ID mapping --------------------------------------------------------------

/**
 * Deterministic Firestore-id → UUID mapping.
 *
 * Deterministic rather than random so the transform can be re-run and produce
 * identical output, which makes the import idempotent and lets you diff two
 * runs. Seeded per namespace so a post and a comment with the same Firestore
 * id do not collide.
 */
export class IdMap {
  private map = new Map<string, string>();

  constructor(private namespace: string) {}

  get(firebaseId: string): string {
    const key = `${this.namespace}:${firebaseId}`;
    let uuid = this.map.get(key);
    if (!uuid) {
      uuid = deterministicUuid(key);
      this.map.set(key, uuid);
    }
    return uuid;
  }

  has(firebaseId: string): boolean {
    return this.map.has(`${this.namespace}:${firebaseId}`);
  }

  /** Only ids explicitly registered are considered resolvable. */
  register(firebaseId: string): string {
    return this.get(firebaseId);
  }

  get size(): number {
    return this.map.size;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(
      [...this.map].map(([k, v]) => [k.slice(this.namespace.length + 1), v])
    );
  }
}

/** UUIDv5-style deterministic id derived from a string (SHA-1, namespaced). */
export function deterministicUuid(input: string): string {
  const hash = createHash('sha1').update(input).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

export { randomUUID };

// --- Value coercion ----------------------------------------------------------

/**
 * Firestore timestamps arrive in several shapes depending on how they were
 * written and exported: a Timestamp object, `{_seconds,_nanoseconds}`, an ISO
 * string, or epoch millis. Returns null for anything unparseable rather than
 * inventing `now()`, so a missing date stays visibly missing.
 */
export function toTimestamp(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v._seconds === 'number') {
      return new Date(v._seconds * 1000 + Number(v._nanoseconds ?? 0) / 1e6).toISOString();
    }
    if (typeof v.seconds === 'number') {
      return new Date(v.seconds * 1000 + Number(v.nanoseconds ?? 0) / 1e6).toISOString();
    }
    if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
      return (v as { toDate: () => Date }).toDate().toISOString();
    }
  }

  if (typeof value === 'number') {
    // Heuristic: values below this are seconds, above are milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

export function toText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

export function toNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalises a Firestore username into the schema's constraint
 * (^[a-z0-9_]{3,30}$). Returns null when nothing usable remains, so the caller
 * can log it rather than insert a row that violates the check.
 */
export function normalizeUsername(raw: unknown): string | null {
  const base = toText(raw).toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (base.length < 3) return null;
  return base.slice(0, 30);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
