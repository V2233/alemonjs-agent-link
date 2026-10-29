import { createHash } from 'node:crypto';
import { localDay } from './options';
import { proactiveScopeId, type ProactiveScope } from './control';

export const browseWindow = (value: unknown): [number, number] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || value.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23) || value[0] === value[1]) {
    throw new Error('每日阅读窗口需要两个不同的 0–23 整点小时。');
  }

  return [value[0], value[1]];
};

/** Stable per scope and activity day; never reroll the wake-up minute on restart. */
export const dailyBrowseSlot = (scope: ProactiveScope, now: number, timezone: string, window?: [number, number]): { day: string; due: boolean } => {
  let day = localDay(now, timezone);

  if (!window) return { day, due: true };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
  const [start, end] = window.map(hour => hour * 60);
  const duration = (end - start + 1440) % 1440;
  const elapsed = (minute - start + 1440) % 1440;

  if (elapsed >= duration) return { day, due: false };
  if (end < start && minute < end) day = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const fraction =
    createHash('sha256')
      .update(JSON.stringify([proactiveScopeId(scope), day, window]))
      .digest()
      .readUInt32BE(0) / 0x100000000;

  return { day, due: elapsed >= Math.floor(fraction * duration) };
};
