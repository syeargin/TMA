/**
 * Amplify's sign-in functions, kept in their own file so the site loads them only when it needs them:
 * someone who has never signed in on this browser can open the landing page, help or sign-in screens
 * without downloading them (AuthService checks for a stored sign-in first).
 */
import { Amplify } from 'aws-amplify';
import {
  autoSignIn, confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, fetchMFAPreference, fetchUserAttributes,
  getCurrentUser, resendSignUpCode, resetPassword, setUpTOTP, signIn, signOut, signUp, updateMFAPreference, verifyTOTPSetup
} from 'aws-amplify/auth';

export const amplifyAuth = {
  autoSignIn, confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, fetchMFAPreference, fetchUserAttributes,
  getCurrentUser, resendSignUpCode, resetPassword, setUpTOTP, signIn, signOut, signUp, updateMFAPreference, verifyTOTPSetup
};
export type AmplifyAuth = typeof amplifyAuth;

/** Points Amplify at the user pool, then hands back its functions. */
export function configureAmplify(userPoolId?: string, userPoolClientId?: string): AmplifyAuth {
  if (!userPoolId || !userPoolClientId) return amplifyAuth; // not set up here (see AuthService.configured)
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId, userPoolClientId,
        loginWith: { email: true },
        signUpVerificationMethod: 'code',
        passwordFormat: { minLength: 10, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSpecialCharacters: false }
      }
    }
  });
  return amplifyAuth;
}
