import { AppError, ErrorCodes } from '@getsale/service-core';

function readErrMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function readErrCode(err: unknown): string | undefined {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

/**
 * Map known Telegram MTProto send errors to a stable 400 AppError (before generic peer-not-found mapping).
 * Matches both GramJS string messages (e.g. "403: PRIVACY_PREMIUM_REQUIRED") and .code when present.
 */
export function telegramSendErrorToAppError(sendErr: unknown): AppError | undefined {
  const errMsg = readErrMessage(sendErr);
  const code = readErrCode(sendErr);
  const upper = errMsg.toUpperCase();
  const codeStr = typeof code === 'string' ? code.toUpperCase() : '';

  if (codeStr === 'PRIVACY_PREMIUM_REQUIRED' || upper.includes('PRIVACY_PREMIUM_REQUIRED')) {
    return new AppError(
      400,
      'Telegram: recipient only accepts messages from Premium accounts (privacy). Use a Premium sender or ask the contact to change who can message them.',
      ErrorCodes.BAD_REQUEST
    );
  }
  if (codeStr === 'USER_PRIVACY_RESTRICTED' || upper.includes('USER_PRIVACY_RESTRICTED')) {
    return new AppError(
      400,
      "Telegram: recipient's privacy settings block messages from your account.",
      ErrorCodes.BAD_REQUEST
    );
  }
  if (codeStr === 'CHAT_WRITE_FORBIDDEN' || upper.includes('CHAT_WRITE_FORBIDDEN')) {
    return new AppError(400, 'Telegram: sending to this chat is not allowed (write forbidden).', ErrorCodes.BAD_REQUEST);
  }
  if (codeStr === 'USER_NOT_MUTUAL_CONTACT' || upper.includes('USER_NOT_MUTUAL_CONTACT')) {
    return new AppError(
      400,
      'Telegram: cannot message this user (not a mutual contact per their privacy settings).',
      ErrorCodes.BAD_REQUEST
    );
  }
  if (codeStr === 'PREMIUM_ACCOUNT_REQUIRED' || upper.includes('PREMIUM_ACCOUNT_REQUIRED')) {
    return new AppError(
      400,
      'Telegram: Premium is required for this action or recipient.',
      ErrorCodes.BAD_REQUEST
    );
  }
  return undefined;
}
