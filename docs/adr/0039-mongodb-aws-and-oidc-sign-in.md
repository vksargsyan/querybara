# 0039. MongoDB sign-in with AWS IAM and OIDC

- Status: Accepted
- Date: 2026-10-28

## Context

Querybara signed in to MongoDB with SCRAM, LDAP (PLAIN) and X.509. Studio 3T also offers:

- **AWS IAM** (MONGODB-AWS), which Atlas clusters use for applications and people with AWS
  identities;
- **OIDC** (MONGODB-OIDC), for Atlas and Enterprise servers that trust an identity provider
  such as Entra ID or Okta;
- **Kerberos** (GSSAPI).

ADR 0036 left them open.

Driver 7 is particular about both:

- MONGODB-AWS takes no user or password. Credentials come from a provider, and the driver loads
  the AWS SDK's `@aws-sdk/credential-providers` for every AWS sign-in, even when the provider is
  the application's own. The build kept that package out (one of the driver's optional peers).
- MONGODB-OIDC either takes a token from the workload it runs on (Azure, GCP, Kubernetes) or
  calls the application back to sign a person in. The driver sends that person's token only to
  hosts in its allowed list (Atlas and localhost by default), so that a server cannot ask for a
  token from an identity provider the person trusts.

## Decision

**The mechanisms sit beside SCRAM and LDAP.** They are chosen in the profile's mechanism
(`auth.mechanism`, under the user-and-password method), as a connection string's `authMechanism`
names them. A pasted connection string fills the same fields. Both sign in through `$external`.

**AWS IAM: an access key, or the AWS credential chain.**

- The user is the access key ID and the password is the secret access key, kept like any
  password.
- The driver gets them through its `AWS_CREDENTIAL_PROVIDER` property, since it takes no user or
  password for AWS.
- Without an access key ID, the AWS SDK's chain applies: environment variables, shared
  credential and config files (SSO profiles included), and the instance's or container's role.
  Temporary credentials with a session token come through the chain too.
- The build now bundles `@aws-sdk/credential-providers`.

**OIDC: a workload's identity, or a sign-in in the browser.**

- **A workload.** The profile names the workload (`oidcEnvironment`: azure, gcp or k8s) and, for
  Azure and GCP, the token's audience (`oidcTokenResource`). On Azure, the user names the managed
  identity. These map to the driver's `ENVIRONMENT` and `TOKEN_RESOURCE` properties.
- **A person.**
  - Without a workload, MongoDB's `@mongodb-js/oidc-plugin` signs the person in with the
    Authorization Code flow: the identity provider's page opens in the system browser and comes
    back to `http://localhost:27097/redirect`, the address MongoDB's tools register with
    identity providers.
  - The connection host keeps one sign-in per profile, so the profile's sessions share its
    tokens and refreshes. An IntelliShell's worker thread starts from the host's tokens, which
    it receives with its connection.
  - Tokens live in memory only and are gone when the app quits.
- **Where a token may go.** A person's token goes only to the driver's default hosts and the
  hosts the profile names; for an SRV name, that includes the hosts of its domain, where the SRV
  records must point.
- **The browser.** It is opened with the system's own opener (`open`, `xdg-open`, or Windows'
  URL handler), from the connection host, for http and https addresses only.

**Kerberos is not offered.** GSSAPI needs the native `kerberos` module, built for each platform
and Electron version. The profile refuses the mechanism with a message naming the ones it
supports.

## Consequences

- The connection host's bundle grows by the AWS SDK's credential providers and the OIDC
  plugin.
- A job (export, import, transfer) runs in the job runner, a process of its own. For a browser
  OIDC profile it signs in there once more; the browser usually completes this without asking
  again.
- A replica set whose members announce names other than the profile's hosts needs those names
  in the profile (a host list), or the browser sign-in is refused for them.
- The X.509 subject name and a SCRAM user without a password now reach the driver in the form
  it accepts. Before, it refused them as malformed credentials.
