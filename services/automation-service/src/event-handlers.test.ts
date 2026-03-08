import { describe, it, expect } from 'vitest';
import {
  evaluateCondition,
  type AutomationEventPayload,
} from './event-handlers';

function event(data: Record<string, unknown> = {}): AutomationEventPayload {
  return {
    id: 'ev-1',
    type: 'lead.stage.changed',
    organizationId: 'org-1',
    userId: 'user-1',
    data: { ...data },
  };
}

describe('evaluateCondition', () => {
  it('eq: matches when event value equals condition value', () => {
    expect(evaluateCondition(
      { field: 'leadId', operator: 'eq', value: 'lead-123' },
      event({ leadId: 'lead-123' })
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'leadId', operator: 'eq', value: 'lead-123' },
      event({ leadId: 'lead-456' })
    )).toBe(false);
  });

  it('ne: matches when not equal', () => {
    expect(evaluateCondition(
      { field: 'leadId', operator: 'ne', value: 'other' },
      event({ leadId: 'lead-123' })
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'leadId', operator: 'ne', value: 'lead-123' },
      event({ leadId: 'lead-123' })
    )).toBe(false);
  });

  it('gt / lt: numeric comparison', () => {
    expect(evaluateCondition(
      { field: 'daysInStage', operator: 'gt', value: 5 },
      event({ daysInStage: 10 })
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'daysInStage', operator: 'gt', value: 5 },
      event({ daysInStage: 3 })
    )).toBe(false);
    expect(evaluateCondition(
      { field: 'daysInStage', operator: 'lt', value: 10 },
      event({ daysInStage: 5 })
    )).toBe(true);
  });

  it('contains: string includes', () => {
    expect(evaluateCondition(
      { field: 'reason', operator: 'contains', value: 'timeout' },
      event({ reason: 'SLA timeout exceeded' })
    )).toBe(true);
    expect(evaluateCondition(
      { field: 'reason', operator: 'contains', value: 'x' },
      event({ reason: 'abc' })
    )).toBe(false);
  });

  it('returns false for unknown operator', () => {
    expect(evaluateCondition(
      { field: 'x', operator: 'unknown', value: 1 },
      event({ x: 1 })
    )).toBe(false);
  });

  it('handles missing field in event', () => {
    expect(evaluateCondition(
      { field: 'missing', operator: 'eq', value: 'x' },
      event({})
    )).toBe(false);
  });
});
