/**
 * The part of @mongodb-js/oidc-plugin the driver uses. The package's `exports` leave its own
 * declarations unreachable under the repo's module resolution, so they are restated here.
 */
declare module '@mongodb-js/oidc-plugin' {
  import type { OIDCCallbackFunction } from 'mongodb';

  export interface MongoDBOIDCPluginOptions {
    readonly openBrowser?: (options: {
      readonly url: string;
      readonly signal: AbortSignal;
    }) => Promise<void>;
    readonly allowedFlows?: readonly ('auth-code' | 'device-auth')[];
    readonly serializedState?: string;
  }

  export interface MongoDBOIDCPlugin {
    readonly mongoClientOptions: {
      readonly authMechanismProperties: { readonly OIDC_HUMAN_CALLBACK: OIDCCallbackFunction };
    };
    serialize(): Promise<string>;
    destroy(): Promise<void>;
  }

  export function createMongoDBOIDCPlugin(options: MongoDBOIDCPluginOptions): MongoDBOIDCPlugin;
}
