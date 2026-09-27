// Thin wrapper over Amplify Auth (Cognito user pool, email + password, SRP).
import { Amplify } from "aws-amplify";
import {
  signUp, confirmSignUp, resendSignUpCode, autoSignIn,
  signIn, signOut, resetPassword, confirmResetPassword,
  getCurrentUser, fetchUserAttributes
} from "aws-amplify/auth";

export const PASSWORD_RULES = "At least 10 characters, with an uppercase letter, a lowercase letter and a number.";

export function configureAuth(cfg) {
  if (!cfg.userPoolId || !cfg.userPoolClientId) return false;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.userPoolId,
        userPoolClientId: cfg.userPoolClientId,
        loginWith: { email: true },
        signUpVerificationMethod: "code",
        passwordFormat: { minLength: 10, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSpecialCharacters: false }
      }
    }
  });
  return true;
}

const norm = (email) => String(email || "").trim().toLowerCase();

export async function currentUser() {
  try {
    await getCurrentUser();
    const attrs = await fetchUserAttributes();
    return { email: attrs.email, sub: attrs.sub };
  } catch {
    return null;
  }
}

export async function createAccount(email, password) {
  const res = await signUp({
    username: norm(email),
    password,
    options: { userAttributes: { email: norm(email) }, autoSignIn: true }
  });
  return res.nextStep.signUpStep; // "CONFIRM_SIGN_UP" | "DONE" | "COMPLETE_AUTO_SIGN_IN"
}

export async function verifyEmail(email, code) {
  const res = await confirmSignUp({ username: norm(email), confirmationCode: code.trim() });
  if (res.nextStep.signUpStep === "COMPLETE_AUTO_SIGN_IN") {
    try { await autoSignIn(); return "SIGNED_IN"; } catch { return "SIGN_IN"; }
  }
  return "SIGN_IN";
}

export const resendCode = (email) => resendSignUpCode({ username: norm(email) });

export async function logIn(email, password) {
  const res = await signIn({ username: norm(email), password });
  return res.nextStep.signInStep; // "DONE" | "CONFIRM_SIGN_UP" | "RESET_PASSWORD" | …
}

export const logOut = () => signOut();

export async function startReset(email) {
  await resetPassword({ username: norm(email) });
}

export const finishReset = (email, code, newPassword) =>
  confirmResetPassword({ username: norm(email), confirmationCode: code.trim(), newPassword });

/** Turns Cognito/Amplify errors into a sentence for the person on screen. */
export function explain(err) {
  const name = err?.name || "";
  const msg = String(err?.message || "");
  if (name === "UserLambdaValidationException") {
    return msg.replace(/^PreSignUp failed with error\s*/i, "").replace(/\.?$/, ".");
  }
  const map = {
    UsernameExistsException: "An account with this email already exists. Sign in instead, or reset your password.",
    NotAuthorizedException: "That email and password don't match. Check them and try again.",
    UserNotFoundException: "That email and password don't match. Check them and try again.",
    UserNotConfirmedException: "Verify your email first. We've sent you a new code.",
    CodeMismatchException: "That code isn't right. Check the latest email and try again.",
    ExpiredCodeException: "That code has expired. Send a new one and try again.",
    InvalidPasswordException: "That password is too weak. " + PASSWORD_RULES,
    LimitExceededException: "Too many attempts. Wait a few minutes, then try again.",
    TooManyRequestsException: "Too many attempts. Wait a few minutes, then try again.",
    CodeDeliveryFailureException: "We couldn't send the email. Check the address and try again.",
    EmptySignInUsername: "Enter your email.",
    EmptySignInPassword: "Enter your password.",
    EmptySignUpUsername: "Enter your email.",
    EmptySignUpPassword: "Enter a password.",
    EmptyConfirmSignUpCode: "Enter the code from your email.",
    EmptyResetPasswordUsername: "Enter your email.",
    EmptyConfirmResetPasswordConfirmationCode: "Enter the code from your email.",
    EmptyConfirmResetPasswordNewPassword: "Enter a new password.",
    NetworkError: "You appear to be offline. Check your connection and try again."
  };
  return map[name] || msg || "Something went wrong. Try again.";
}
