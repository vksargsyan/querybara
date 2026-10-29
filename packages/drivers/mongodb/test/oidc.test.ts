import { afterEach, describe, expect, it } from 'vitest';

import { forgetOidcSignIn, openInBrowser } from '../src';
import { oidcSignInOptions, oidcState } from '../src/oidc';

/** The browser sign-in for MONGODB-OIDC: one per profile, its tokens handed to a shell worker. */
describe('OIDC browser sign-in', () => {
  afterEach(async () => {
    await forgetOidcSignIn('a');
    await forgetOidcSignIn('b');
  });

  it('keeps one sign-in per profile, whose tokens another process can start from', async () => {
    const first = await oidcSignInOptions('a', {
      authMechanismProperties: { ALLOWED_HOSTS: ['h'] },
    });
    const again = await oidcSignInOptions('a', {});
    const other = await oidcSignInOptions('b', {});
    const callback = first.authMechanismProperties?.OIDC_HUMAN_CALLBACK;
    expect(first.authMechanismProperties?.ALLOWED_HOSTS).toEqual(['h']);
    expect(again.authMechanismProperties?.OIDC_HUMAN_CALLBACK).toBe(callback);
    expect(other.authMechanismProperties?.OIDC_HUMAN_CALLBACK).not.toBe(callback);

    const state = await oidcState('a');
    expect(typeof state).toBe('string');
    await forgetOidcSignIn('a');
    expect(await oidcState('a')).toBeUndefined();
    // A worker's plugin starts from the host's state.
    const restored = await oidcSignInOptions('a', {}, state);
    expect(typeof restored.authMechanismProperties?.OIDC_HUMAN_CALLBACK).toBe('function');
  });

  it('opens only web addresses', async () => {
    await expect(openInBrowser({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    await expect(openInBrowser({ url: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
