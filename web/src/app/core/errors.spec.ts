import { explain } from './errors';

describe('explain', () => {
  it('maps Cognito errors to plain sentences', () => {
    expect(explain({ name: 'NotAuthorizedException', message: 'Incorrect username or password.' })).toMatch(/don't match/);
    expect(explain({ name: 'UserLambdaValidationException', message: 'PreSignUp failed with error This email has no invite' })).toBe('This email has no invite.');
  });
  it('falls back to the message, then a generic sentence', () => {
    expect(explain(new Error('Boom'))).toBe('Boom');
    expect(explain(null)).toBe('Something went wrong. Try again.');
  });
});
