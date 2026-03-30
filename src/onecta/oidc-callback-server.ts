
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server as HttpServer,
    type ServerResponse,
} from 'node:http';

import { resolve } from 'node:path';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';

import { address } from 'ip';

import { OnectaClientConfig, onecta_oidc_auth_thank_you_html } from './oidc-utils.js';
import { AddressInfo } from 'node:net';

export class OnectaOIDCCallbackServer {

    #config: OnectaClientConfig;
    #server: HttpServer | HttpsServer | null;
    #redirectUri: string | null;

    constructor(config: OnectaClientConfig) {
        this.#config = config;
        this.#server = null;
        this.#redirectUri = null;
    }

    #getCallbackProtocol(): 'http' | 'https' {
        const protocol = this.#config.oidcCallbackServerProtocol
            ?? (this.#config.oidcCallbackServerBaseUrl
                ? new URL(this.#config.oidcCallbackServerBaseUrl).protocol.replace(':', '')
                : 'https');
        if (protocol !== 'http' && protocol !== 'https') {
            throw new Error(`Unsupported callback server protocol: ${protocol}`);
        }
        return protocol;
    }

    async listen(): Promise<string> {
        const config = this.#config;
        const protocol = this.#getCallbackProtocol();
        const server = protocol === 'http'
            ? createHttpServer()
            : createHttpsServer({
                key: await readFile(
                    config.certificatePathKey
                        ?? resolve(__dirname, '..', '..', 'cert', 'cert.key'),
                ),
                cert: await readFile(
                    config.certificatePathCert
                        ?? resolve(__dirname, '..', '..', 'cert', 'cert.pem'),
                ),
            });
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                server.removeListener('listening', onListening);
                server.removeListener('error', onError);
            };
            const onListening = () => {
                cleanup();
                resolve();
            }
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            server.on('listening', onListening);
            server.on('error', onError);
            server.listen(
                config.oidcCallbackServerPort ?? 0,
                config.oidcCallbackServerBindAddr ?? '0.0.0.0',
            );
        });
        let callbackUrl = config.oidcCallbackServerBaseUrl;
        if (!callbackUrl) {
            const oidcHostname = config.oidcCallbackServerExternalAddress ?? address('public');
            const oidcPort = config.oidcCallbackServerPort ?? (server.address() as AddressInfo).port;
            callbackUrl = `${protocol}://${oidcHostname}:${oidcPort}`;
        }
        this.#server = server;
        this.#redirectUri = callbackUrl;
        return callbackUrl;
    }

    async waitForAuthCodeAndClose(oidc_state: string, auth_url: string): Promise<string> {
        const config = this.#config;
        const server = this.#server;
        if (!server?.listening) {
            throw new Error('server is not listening');
        }
        return await new Promise<string>((resolve, reject) => {
            let timeout: NodeJS.Timeout;
            const cleanup = () => {
                clearTimeout(timeout);
                server.removeListener('request', onRequest);
                server.removeListener('error', onError);
                server.closeAllConnections();
                server.close();
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            const onTimeout = () => {
                cleanup();
                reject(new Error('Authorization time out'));
            };
            const onAuthCode = (code: string) => {
                cleanup();
                resolve(code);
            };
            const onAuthFailure = (err: Error) => {
                cleanup();
                reject(err);
            };
            const onRequest = (req: IncomingMessage, res: ServerResponse) => {
                const url = new URL(req.url ?? '/', this.#redirectUri!);
                const expectedPathname = new URL(this.#redirectUri!).pathname;
                const pathname = url.pathname;
                const resState = url.searchParams.get('state');
                const authCode = url.searchParams.get('code');
                const oidcError = url.searchParams.get('error');
                const oidcErrorDescription = url.searchParams.get('error_description');
                if (resState === oidc_state && authCode) {
                    res.statusCode = 200;
                    res.write(config.onectaOidcAuthThankYouHtml ?? onecta_oidc_auth_thank_you_html);
                    res.once('finish', () => onAuthCode(authCode));
                } else if (oidcError) {
                    const detail = oidcErrorDescription ? ` (${oidcErrorDescription})` : '';
                    res.statusCode = 400;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.write(`OIDC authorization failed: ${oidcError}${detail}`);
                    res.once('finish', () => onAuthFailure(new Error(`OIDC authorization failed: ${oidcError}${detail}`)));
                } else if (!resState && !authCode && pathname === expectedPathname) {
                    // Redirect to auth_url
                    res.writeHead(302, {
                        'Location': auth_url,
                    });
                }
                else {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.write(
                        `Invalid callback request. Expected path "${expectedPathname}" and query params "state" and "code". `
                        + `Received path "${pathname}", has state=${resState ? 'yes' : 'no'}, `
                        + `has code=${authCode ? 'yes' : 'no'}, has error=${oidcError ? 'yes' : 'no'}.`,
                    );
                }
                res.end();
            };
            timeout = setTimeout(onTimeout, (config.oidcAuthorizationTimeoutS || 300) * 1000);
            server.on('request', onRequest);
            server.on('error', onError);
        });
    }

}
