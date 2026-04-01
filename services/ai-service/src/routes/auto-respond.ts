import { Router } from 'express';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { AIRateLimiter } from '../rate-limiter';
import { resolveOpenRouterAutoRespondModel } from '../openrouter-models';
import { AiAutoRespondSchema } from '../validation';

interface Deps {
  log: Logger;
  rateLimiter: AIRateLimiter;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

const AUTO_REPLY_SYSTEM_HINT = `You are replying in a Telegram business chat outside working hours.
Follow the user's system instructions closely. Be concise, friendly, and helpful.
Output ONLY the message text to send — no quotes, no preamble. Same language as the conversation.`;

function parseTimeoutMs(): number {
  const n = parseInt(String(process.env.OPENROUTER_TIMEOUT_MS || '55000'), 10);
  if (Number.isNaN(n)) return 55_000;
  return Math.min(120_000, Math.max(10_000, n));
}

function extractText(data: {
  choices?: Array<{ message?: { content?: string | null } }>;
}): string | undefined {
  const c = data?.choices?.[0]?.message?.content?.trim();
  return c || undefined;
}

function buildUserPayload(
  history: { role: string; content: string; date?: string }[],
  incoming: string
): string {
  const lines: string[] = ['Conversation (oldest first):'];
  for (const h of history) {
    const who = h.role === 'assistant' ? 'Us' : 'Contact';
    const when = h.date ? ` [${h.date}]` : '';
    lines.push(`${who}${when}: ${h.content}`);
  }
  lines.push('');
  lines.push(`Latest incoming message from contact: ${incoming}`);
  lines.push('');
  lines.push('Write our reply.');
  return lines.join('\n');
}

export function autoRespondRouter({ log, rateLimiter }: Deps): Router {
  const router = Router();

  router.post('/auto-respond', validate(AiAutoRespondSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { systemPrompt, conversationHistory, incomingMessage } = req.body as {
      systemPrompt: string;
      conversationHistory: { role: 'user' | 'assistant'; content: string; date?: string }[];
      incomingMessage: string;
    };

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = resolveOpenRouterAutoRespondModel();

    if (!apiKey) {
      throw new AppError(
        503,
        'AI is not configured. Set OPENROUTER_API_KEY in ai-service.',
        ErrorCodes.SERVICE_UNAVAILABLE
      );
    }

    const rateCheck = await rateLimiter.check(organizationId);
    if (!rateCheck.allowed) {
      throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parseTimeoutMs());

    try {
      const response = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: `${AUTO_REPLY_SYSTEM_HINT}\n\n${systemPrompt}` },
            { role: 'user', content: buildUserPayload(conversationHistory, incomingMessage) },
          ],
          max_tokens: 1024,
          temperature: 0.65,
          reasoning: { effort: 'none' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        log.warn({ message: 'auto-respond OpenRouter error', httpStatus: response.status, body: errText.slice(0, 500) });
        throw new AppError(
          502,
          'AI provider error',
          ErrorCodes.INTERNAL_ERROR
        );
      }

      const data = (await response.json()) as Parameters<typeof extractText>[0];
      const text = extractText(data);
      if (!text) {
        throw new AppError(502, 'Empty AI response', ErrorCodes.INTERNAL_ERROR);
      }

      await rateLimiter.increment(organizationId);
      res.json({ text });
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof AppError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'AbortError' || (err as Error)?.name === 'AbortError') {
        throw new AppError(504, 'AI request timed out', ErrorCodes.INTERNAL_ERROR);
      }
      log.warn({ message: 'auto-respond failed', error: msg });
      throw new AppError(502, 'AI request failed', ErrorCodes.INTERNAL_ERROR);
    }
  }));

  return router;
}
