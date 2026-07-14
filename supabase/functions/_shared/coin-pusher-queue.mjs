import { COIN_PUSHER_START_DELAY_MS } from "./coin-pusher-physics.mjs";

export const COIN_PUSHER_QUEUE_LIMIT = 3;
export const COIN_PUSHER_QUEUE_GAP_MS = 250;

export function coinPusherQueueAdmission(scheduled, userId) {
  const queue = Array.isArray(scheduled) ? scheduled : [];
  if (queue.length >= COIN_PUSHER_QUEUE_LIMIT) return { ok: false, reason: "full" };
  if (queue.some((item) => String(item?.user_id || item?.userId || "") === String(userId || ""))) {
    return { ok: false, reason: "already_queued" };
  }
  return { ok: true, position: queue.length + 1 };
}

export function coinPusherScheduleStartMs({ nowMs, busyUntilMs = 0 }) {
  const now = Number(nowMs);
  const tail = Number(busyUntilMs) || 0;
  if (!Number.isFinite(now)) throw new Error("Invalid queue clock");
  const earliest = now + COIN_PUSHER_START_DELAY_MS;
  return Math.max(earliest, tail > now ? tail + COIN_PUSHER_QUEUE_GAP_MS : 0);
}
