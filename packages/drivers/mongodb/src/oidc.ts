// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the package's own declarations are unreachable through its exports, and every project compiling this file needs these
/// <reference path="./oidc-plugin.d.ts" />
import { spawn } from 'node:child_process';

import { QuerybaraError } from '@querybara/core';
import type { MongoDBOIDCPlugin } from '@mongodb-js/oidc-plugin';
import type { MongoClientOptions } from 'mongodb';

/**
 * MONGODB-OIDC signed in through the browser: the identity provider's sign-in page opens in the
 * system browser, which comes back to a local port (the Authorization Code flow, at the redirect
 * address MongoDB's tools share, http://localhost:27097/redirect). One plugin per profile in
 * this process, so the profile's connections share the tokens and their refreshes, and the
 * browser opens once; a shell worker starts from the host's tokens (`oidcState`). The plugin
 * (with its ESM-only OpenID client) loads only when a profile signs in this way.
 */

const plugins = new Map<string, MongoDBOIDCPlugin>();
let pluginModule: Promise<typeof import('@mongodb-js/oidc-plugin')> | undefined;

/** Opens an http(s) address in the system browser. */
export function openInBrowser({ url }: { readonly url: string }): Promise<void> {
  const { protocol } = new URL(url);
  if (protocol !== 'https:' && protocol !== 'http:') {
    return Promise.reject(
      new QuerybaraError({
        code: 'AUTH_FAILED',
        message: `The identity provider's sign-in address is not a web page (${protocol})`,
      }),
    );
  }
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** The sign-in plugin of a profile, made on first use (from `state`, tokens another process holds). */
async function pluginFor(profileId: string, state?: string): Promise<MongoDBOIDCPlugin> {
  const known = plugins.get(profileId);
  if (known !== undefined) return known;
  const { createMongoDBOIDCPlugin } = await (pluginModule ??= import('@mongodb-js/oidc-plugin'));
  // Another connection of the profile may have made it meanwhile.
  let plugin = plugins.get(profileId);
  if (plugin === undefined) {
    plugin = createMongoDBOIDCPlugin({
      openBrowser: openInBrowser,
      allowedFlows: ['auth-code'],
      ...(state !== undefined ? { serializedState: state } : {}),
    });
    plugins.set(profileId, plugin);
  }
  return plugin;
}

/** The driver options that sign a profile in through the browser (OIDC_HUMAN_CALLBACK). */
export async function oidcSignInOptions(
  profileId: string,
  options: MongoClientOptions,
  state?: string,
): Promise<MongoClientOptions> {
  const plugin = await pluginFor(profileId, state);
  return {
    ...options,
    authMechanismProperties: {
      ...options.authMechanismProperties,
      ...plugin.mongoClientOptions.authMechanismProperties,
    },
  };
}

/** The tokens a profile's sign-in holds in this process, for a shell worker to start from. */
export async function oidcState(profileId: string): Promise<string | undefined> {
  return plugins.get(profileId)?.serialize();
}

/** Ends a profile's sign-in in this process (its tokens are forgotten). */
export async function forgetOidcSignIn(profileId: string): Promise<void> {
  const plugin = plugins.get(profileId);
  plugins.delete(profileId);
  await plugin?.destroy();
}
