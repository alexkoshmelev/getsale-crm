/**
 * Post-process AI campaign rephrase output: dash normalization, meta strip, paragraph alignment to input.
 */

const META_PREFIX_PATTERNS = [
  /^here(?:'s| is) (?:the )?re(?:-)?phrased[^:]*:\s*/i,
  /^okay[, ]*(?:let me|here)[^.]*\.\s*/i,
  /^sure[, ]*here[^:]*:\s*/i,
  /^rephrased (?:message|text):\s*/i,
];

/** Normalize typographic dashes to ASCII hyphen (Telegram / user preference). */
export function normalizeDashes(text: string): string {
  return text.replace(/[\u2014\u2013\u2212]/g, '-');
}

function stripMetaCommentary(text: string): string {
  let t = text.trim();
  for (const re of META_PREFIX_PATTERNS) {
    t = t.replace(re, '');
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('«') && t.endsWith('»'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function splitParagraphs(text: string): string[] {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * If AI collapsed or exploded paragraph breaks vs input, redistribute output text into N paragraphs
 * proportional to input paragraph character lengths.
 */
export function alignParagraphsToInput(original: string, output: string): string {
  const origParas = splitParagraphs(original);
  const trimmedOut = output.trim();
  if (origParas.length <= 1) return trimmedOut;

  const outParas = splitParagraphs(trimmedOut);
  if (outParas.length === origParas.length) {
    return outParas.join('\n\n');
  }

  const flat = trimmedOut.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return trimmedOut;

  const total = origParas.reduce((sum, p) => sum + p.length, 0) || 1;
  const chunks: string[] = [];
  let start = 0;

  for (let i = 0; i < origParas.length; i++) {
    if (i === origParas.length - 1) {
      chunks.push(flat.slice(start).trim());
      break;
    }
    const ratio = origParas[i]!.length / total;
    let end = start + Math.max(1, Math.floor(ratio * flat.length));
    if (end >= flat.length) end = Math.max(start + 1, flat.length - 1);
    let slice = flat.slice(start, end);
    const rel = slice.lastIndexOf(' ');
    if (rel > 10) {
      slice = slice.slice(0, rel);
      end = start + rel;
    }
    chunks.push(slice.trim());
    start = end;
    while (start < flat.length && flat[start] === ' ') start++;
  }

  return chunks.join('\n\n');
}

/** Full pipeline: meta strip, dashes, paragraph repair vs original. */
export function sanitizeCampaignRephraseOutput(originalText: string, aiOutput: string): string {
  let s = stripMetaCommentary(aiOutput);
  s = normalizeDashes(s);
  s = alignParagraphsToInput(originalText, s);
  s = normalizeDashes(s);
  return s.trim();
}
