import { describe, it, expect } from 'vitest';
import { classifySpamBotReply } from './spambot-check';

describe('classifySpamBotReply', () => {
  it('classifies English all-clear as clear', () => {
    expect(
      classifySpamBotReply(
        'Good news, no limits are currently applied to your account. You\'re free as a bird!'
      )
    ).toBe('clear');
  });

  it('classifies official Russian all-clear as clear', () => {
    expect(
      classifySpamBotReply('Ваш аккаунт свободен от каких-либо ограничений.')
    ).toBe('clear');
  });

  it('classifies explicit restriction as restricted', () => {
    expect(
      classifySpamBotReply(
        'Your account is limited: you cannot send messages to people who do not have your phone number in their contacts.'
      )
    ).toBe('restricted');
  });

  it('classifies Russian restriction wording as restricted', () => {
    expect(
      classifySpamBotReply('К вашему аккаунту применены ограничения за нарушение правил.')
    ).toBe('restricted');
  });
});
