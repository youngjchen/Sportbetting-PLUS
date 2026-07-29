'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function loadHealthModule() {
  try {
    return require('../failover_health.js');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND'
        && String(error.message).includes('failover_health.js')) {
      return {};
    }
    throw error;
  }
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const slotAtMs = Date.parse('2026-07-29T22:00:00+08:00');
const oldUpdateMs = Date.parse('2026-07-29T18:00:00+08:00');

test('healthy cloud run is not declared overdue during its 40-minute completion grace period', () => {
  const { expertRescueReason } = loadHealthModule();
  assert.equal(typeof expertRescueReason, 'function');

  assert.deepEqual(expertRescueReason({
    qualified: 239,
    updatedMs: oldUpdateMs,
    slotAtMs,
    nowMs: slotAtMs + 39 * MINUTE,
  }), { blocked: false, overdue: false, rescue: false });
});

test('unchanged expert data becomes overdue after the completion grace period', () => {
  const { expertRescueReason } = loadHealthModule();
  assert.equal(typeof expertRescueReason, 'function');

  assert.deepEqual(expertRescueReason({
    qualified: 239,
    updatedMs: oldUpdateMs,
    slotAtMs,
    nowMs: slotAtMs + 40 * MINUTE,
  }), { blocked: false, overdue: true, rescue: true });
});

test('fresh qualified-zero output remains an immediate WAF failure fingerprint', () => {
  const { expertRescueReason } = loadHealthModule();
  assert.equal(typeof expertRescueReason, 'function');

  assert.deepEqual(expertRescueReason({
    qualified: 0,
    updatedMs: slotAtMs + MINUTE,
    slotAtMs,
    nowMs: slotAtMs + 2 * MINUTE,
  }), { blocked: true, overdue: false, rescue: true });
});

test('a completed cloud wave never becomes overdue after the grace period', () => {
  const { expertRescueReason } = loadHealthModule();
  assert.equal(typeof expertRescueReason, 'function');

  assert.deepEqual(expertRescueReason({
    qualified: 239,
    updatedMs: slotAtMs + 6 * MINUTE,
    slotAtMs,
    nowMs: slotAtMs + 2 * HOUR,
  }), { blocked: false, overdue: false, rescue: false });
});

test('dense schedules select the newest wave whose completion grace has elapsed', () => {
  const { latestEligibleSlot } = loadHealthModule();
  assert.equal(typeof latestEligibleSlot, 'function');

  const slots = [
    { at: slotAtMs, label: '00:00' },
    { at: slotAtMs + 30 * MINUTE, label: '00:30' },
    { at: slotAtMs + 60 * MINUTE, label: '01:00' },
  ];
  assert.deepEqual(
    latestEligibleSlot(slots, slotAtMs + 40 * MINUTE),
    slots[0]
  );
});

test('WAF fingerprint selects the latest passed wave without waiting for completion grace', () => {
  const { selectExpertRescueSlot } = loadHealthModule();
  assert.equal(typeof selectExpertRescueSlot, 'function');

  const slots = [
    { at: slotAtMs, label: '22:00' },
    { at: slotAtMs + 30 * MINUTE, label: '22:30' },
  ];
  assert.deepEqual(
    selectExpertRescueSlot(slots, slotAtMs + 31 * MINUTE, true),
    slots[1]
  );
});
