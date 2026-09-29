export const PASSWORD_RULES = 'At least 10 characters, with an uppercase letter, a lowercase letter and a number.';

const COGNITO_MESSAGES: Record<string, string> = {
  UsernameExistsException: 'An account with this email already exists. Sign in instead, or reset your password.',
  NotAuthorizedException: "That email and password don't match. Check them and try again.",
  UserNotFoundException: "That email and password don't match. Check them and try again.",
  UserNotConfirmedException: "Verify your email first. We've sent you a new code.",
  CodeMismatchException: "That code isn't right. Check the latest email and try again.",
  ExpiredCodeException: 'That code has expired. Send a new one and try again.',
  InvalidPasswordException: 'That password is too weak. ' + PASSWORD_RULES,
  LimitExceededException: 'Too many attempts. Wait a few minutes, then try again.',
  TooManyRequestsException: 'Too many attempts. Wait a few minutes, then try again.',
  CodeDeliveryFailureException: "We couldn't send the email. Check the address and try again.",
  EmptySignInUsername: 'Enter your email.',
  EmptySignInPassword: 'Enter your password.',
  EmptySignUpUsername: 'Enter your email.',
  EmptySignUpPassword: 'Enter a password.',
  EmptyConfirmSignUpCode: 'Enter the code from your email.',
  EmptyResetPasswordUsername: 'Enter your email.',
  EmptyConfirmResetPasswordConfirmationCode: 'Enter the code from your email.',
  EmptyConfirmResetPasswordNewPassword: 'Enter a new password.',
  NetworkError: 'You appear to be offline. Check your connection and try again.'
};

/** Turns Cognito, Amplify and API errors into a sentence for the person on screen. */
export function explain(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name ?? '';
  const msg = String(e?.message ?? '');
  if (name === 'UserLambdaValidationException') {
    return msg.replace(/^PreSignUp failed with error\s*/i, '').replace(/\.?$/, '.');
  }
  return COGNITO_MESSAGES[name] || msg || 'Something went wrong. Try again.';
}
