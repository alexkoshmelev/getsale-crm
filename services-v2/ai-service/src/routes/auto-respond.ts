import { FastifyInstance } from 'fastify';
import { Logger } from '@getsale/logger';
import { requireUser, validate, AppError, ErrorCodes } from '@getsale/service-framework';
import { AIRateLimiter } from '../rate-limiter';
import { resolveOpenRouterAutoRespondModel } from '../openrouter-models';
import { AiAutoRespondSchema } from '../validation';
import { callOpenRouter, extractOpenRouterContent, OpenRouterError } from '../openai-client';

const AUTO_REPLY_SYSTEM_HINT = `You are replying in a Telegram business chat outside working hours.
Follow the user's system instructions closely. Be concise, friendly, and helpful.
Output ONLY the message text to send — no quotes, no preamble. Same language as the conversation.`;

interface Deps {
  log: Logger;
  rateLimiter: AIRateLimiter;
}

function buildUserPayload(
  history: { role: string; content: string; date?: string }[],
  incoming: string,
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

export function registerAutoRespondRoutes(app: FastifyInstance, { log, rateLimiter }: Deps): void {
  app.post(
    '/api/ai/auto-respond',
    { preHandler: [requireUser, validate(AiAutoRespondSchema)] },
    async (request) => {
      const { organizationId } = request.user!;
      const { systemPrompt, conversationHistory, incomingMessage } = request.body as {
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
          ErrorCodes.SERVICE_UNAVAILABLE,
        );
      }

      const rateCheck = await rateLimiter.check(organizationId);
      if (!rateCheck.allowed) {
        throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
      }

      try {
        const data = await callOpenRouter({
          model,
          messages: [
            { role: 'system', content: `${AUTO_REPLY_SYSTEM_HINT}\n\n${systemPrompt}` },
            { role: 'user', content: buildUserPayload(conversationHistory, incomingMessage) },
          ],
          max_tokens: 1024,
          temperature: 0.65,
          reasoning: { effort: 'none' },
        });

        const text = extractOpenRouterContent(data);
        if (!text) {
          throw new AppError(502, 'Empty AI response', ErrorCodes.INTERNAL_ERROR);
        }

        await rateLimiter.increment(organizationId);
        return { text };
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('timed out') || msg.includes('AbortError')) {
          throw new AppError(504, 'AI request timed out', ErrorCodes.INTERNAL_ERROR);
        }
        if (err instanceof OpenRouterError && err.httpStatus === 429) {
          log.warn({ message: 'auto-respond rate-limited upstream', model });
          throw new AppError(429, 'AI provider is temporarily rate-limited. Please try again in a few seconds.', ErrorCodes.RATE_LIMITED);
        }
        log.warn({ message: 'auto-respond failed', error: msg, model });
        throw new AppError(502, `AI request failed: ${msg.slice(0, 200)}`, ErrorCodes.INTERNAL_ERROR);
      }
    },
  );
}
