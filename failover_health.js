'use strict';

const EP_FRESH_H = 3;
const EP_COMPLETION_GRACE_MIN = 40;

function latestEligibleSlot(slots, nowMs, completionGraceMin = EP_COMPLETION_GRACE_MIN) {
  const cutoff = Number(nowMs) - completionGraceMin * 60e3;
  return (slots || [])
    .filter(slot => slot && Number.isFinite(Number(slot.at)) && Number(slot.at) <= cutoff)
    .sort((a, b) => Number(b.at) - Number(a.at))[0] || null;
}

function selectExpertRescueSlot(slots, nowMs, blocked) {
  return latestEligibleSlot(slots, nowMs, blocked ? 0 : EP_COMPLETION_GRACE_MIN);
}

function expertRescueReason({
  qualified,
  updatedMs,
  slotAtMs,
  nowMs,
  freshHours = EP_FRESH_H,
  completionGraceMin = EP_COMPLETION_GRACE_MIN,
}) {
  const updated = Number(updatedMs);
  const slot = Number(slotAtMs);
  const now = Number(nowMs);
  const blocked = Number(qualified) === 0
    && Number.isFinite(updated)
    && updated > 0
    && now >= updated
    && now - updated < freshHours * 3600e3;
  const overdue = Number.isFinite(slot)
    && slot > 0
    && Number.isFinite(now)
    && now >= slot + completionGraceMin * 60e3
    && (!Number.isFinite(updated) || updated <= 0 || updated < slot);
  return { blocked, overdue, rescue: blocked || overdue };
}

module.exports = {
  EP_COMPLETION_GRACE_MIN,
  EP_FRESH_H,
  expertRescueReason,
  latestEligibleSlot,
  selectExpertRescueSlot,
};
