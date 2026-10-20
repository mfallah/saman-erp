/**
 * Pure notification policy: template rendering, preferences and quiet hours.
 * No IO so it is fully unit-tested.
 */
export interface TemplateVariables {
  readonly [name: string]: string;
}

export class TemplateRenderError extends Error {
  constructor(readonly missing: readonly string[]) {
    super('template_variable_missing');
    this.name = 'TemplateRenderError';
  }
}

/** Persian-safe `{{token}}` substitution; unknown placeholders fail closed. */
export function renderTemplate(body: string, variables: TemplateVariables): string {
  const missing = new Set<string>();
  const rendered = body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, token: string) => {
    const value = variables[token];
    if (value === undefined) {
      missing.add(token);
      return '';
    }
    return value;
  });
  if (missing.size > 0) throw new TemplateRenderError([...missing]);
  return rendered;
}

export function extractTemplateVariables(body: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    if (match[1] !== undefined) tokens.add(match[1]);
  }
  return [...tokens];
}

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface QuietHours {
  /** `HH:MM` in Asia/Tehran. */
  readonly from: string;
  readonly to: string;
}

export interface PreferenceRow {
  readonly eventType: string;
  readonly channel: string;
  readonly enabled: boolean;
}

export interface PreferenceDecision {
  readonly allowed: boolean;
  readonly reason: 'allowed' | 'disabled' | 'quiet_hours';
}

const QUIET_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateQuietHours(value: QuietHours): QuietHours {
  if (!QUIET_PATTERN.test(value.from) || !QUIET_PATTERN.test(value.to)) {
    throw new TemplateRenderError(['quietHours']);
  }
  return value;
}

function minutesOfDay(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Quiet-hours comparison handles windows that cross midnight. */
export function isWithinQuietHours(quiet: QuietHours, minutes: number): boolean {
  const from = minutesOfDay(quiet.from);
  const to = minutesOfDay(quiet.to);
  if (from === to) return false;
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}

export function minutesInTimeZone(now: Date, timeZone = 'Asia/Tehran'): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

/**
 * Preference resolution:
 * - default allow (opt-out, not opt-in);
 * - explicit `enabled=false` for the channel/event wins;
 * - quiet hours suppress `sms`/`email`/`push` (critical priority bypasses), but
 *   never the in-app inbox.
 */
export function resolvePreference(input: {
  preferences: readonly PreferenceRow[];
  eventType: string;
  channel: NotificationChannel;
  priority: 'low' | 'normal' | 'high' | 'critical';
  quietHours?: QuietHours | null;
  now: Date;
}): PreferenceDecision {
  const explicit = input.preferences.find(
    (row) =>
      (row.eventType === input.eventType || row.eventType === '*') &&
      (row.channel === input.channel || row.channel === '*'),
  );
  if (explicit !== undefined && !explicit.enabled) {
    return { allowed: false, reason: 'disabled' };
  }
  if (input.channel !== 'in_app' && input.priority !== 'critical' && input.quietHours != null) {
    if (isWithinQuietHours(input.quietHours, minutesInTimeZone(input.now))) {
      return { allowed: false, reason: 'quiet_hours' };
    }
  }
  return { allowed: true, reason: 'allowed' };
}
