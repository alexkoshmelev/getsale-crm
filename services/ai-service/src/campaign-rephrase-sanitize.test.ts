import { describe, it, expect } from 'vitest';
import {
  normalizeDashes,
  alignParagraphsToInput,
  sanitizeCampaignRephraseOutput,
} from './campaign-rephrase-sanitize';

describe('campaign-rephrase-sanitize', () => {
  it('normalizeDashes replaces em and en dashes', () => {
    expect(normalizeDashes('foo\u2014bar\u2013baz')).toBe('foo-bar-baz');
  });

  it('alignParagraphsToInput keeps output when paragraph count matches', () => {
    const orig = 'First para.\n\nSecond para.';
    const out = 'A.\n\nB.';
    expect(alignParagraphsToInput(orig, out)).toBe('A.\n\nB.');
  });

  it('alignParagraphsToInput splits one paragraph into two when original had two', () => {
    const orig = 'One block here.\n\nTwo block here.';
    const out = 'All text was merged into one line without breaks.';
    const got = alignParagraphsToInput(orig, out);
    expect(got.includes('\n\n')).toBe(true);
    const parts = got.split(/\n{2,}/);
    expect(parts.length).toBe(2);
  });

  it('sanitizeCampaignRephraseOutput strips meta prefix and dashes', () => {
    const orig = 'Hello\u2014friend';
    const ai = "Here's the rephrased text:\n\nHi\u2014there";
    const got = sanitizeCampaignRephraseOutput(orig, ai);
    expect(got.includes('\u2014')).toBe(false);
    expect(got.toLowerCase()).not.toContain("here's");
  });
});
