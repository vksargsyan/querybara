import { createCipheriv } from 'node:crypto';

/** Builders for Navicat `.ncx` files in tests. */

/** What Navicat 12 and later write for a saved password. */
export function navicatPassword(plain: string): string {
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from('libcckeylibcckey'),
    Buffer.from('libcciv libcciv '),
  );
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

/** One `<Connection>` element with Navicat's attributes (most left at their defaults). */
export function connection(attrs: Record<string, string>): string {
  const all: Record<string, string> = {
    ConnectionName: 'conn',
    ConnType: 'MYSQL',
    Host: 'localhost',
    Port: '3306',
    Database: '',
    UserName: 'root',
    Password: '',
    SavePassword: 'false',
    NamedPipe: 'false',
    NamedPipeSocket: '',
    SSL: 'false',
    SSL_PGSSLMode: 'REQUIRE',
    SSL_ClientKey: '',
    SSL_ClientCert: '',
    SSL_CACert: '',
    SSL_AllowInvalidHostName: 'false',
    SSL_PEMClientKeyPassword: '',
    SSH: 'false',
    SSH_Host: '',
    SSH_Port: '22',
    SSH_UserName: '',
    SSH_AuthenMethod: 'PASSWORD',
    SSH_Password: '',
    SSH_SavePassword: 'false',
    SSH_PrivateKey: '',
    SSH_Passphrase: '',
    SSH_SavePassphrase: 'false',
    HTTP: 'false',
    ...attrs,
  };
  const escape = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `  <Connection ${Object.entries(all)
    .map(([k, v]) => `${k}="${escape(v)}"`)
    .join(' ')}/>`;
}

export function ncx(...connections: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Connections Ver="1.5">\n${connections.join('\n')}\n</Connections>\n`;
}
