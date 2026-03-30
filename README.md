# daikin-sensory

Fork of [daikin-controller-cloud](https://github.com/Apollon77/daikin-controller-cloud) that reads Daikin Onecta cloud device details and publishes normalized sensor data to MQTT every 15 minutes. The library uses the new Daikin Europe Developer cloud API since v2.0.0.

## Disclaimer
**All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal.**
**Daikin is a trademark of DAIKIN INDUSTRIES, LTD.**

## Description
This project uses the upstream OIDC and Daikin Onecta API integration to query
device information and publish selected sensory values to MQTT in a stable format, for example:

```js
{
   timestamp: '2026-03-27T11:01:59.057Z',
   name: 'AC',
   state: 'off',
   operationMode: 'auto',
   indoorTemperature: 21,
   outdoorTemperature: 12,
   targetTemperature: 20
}
```

The default polling interval is 15 minutes to stay within the Daikin API rate
limits.

The newer Daikin devices sold since 2020 contain a newer Wifi Adapter
(e.g. BRP069C4x) which only connects to the Daikin Cloud and is no longer
reachable locally. These devices are only controllable through the Daikin
Onecta API, which uses the OpenID Connect (OIDC) protocol for client
authentication and authorization purposes.
Note: For devices with older WLAN-Adapters like **BRP069A4x** which can only be
used by the Daikin Controller App please use the
[Daikin-Controller](https://github.com/Apollon77/daikin-controller) lib instead.

## IMPORTANT information and best practices

The Onecta API limits each client application to 200 requests per day. Please make sure to not exceed this limit, as the API will block further requests for the day.

Because of this we propose the following usage limits to be implemented by the applications using this library:
* DO NOT generate more requests while being rate limited because else the unblock time increases! Use the `retryAfter` property of the RateLimitError to determine how long to wait for the next request.
* Better always read the full device details rather than single devices to make best use of the rate limit
* A default polling interval of 15 minutes should be sufficient for most use cases while leaving some space for controlling the devices too.
* Consider using a (longer) slow polling interval for timeframes where updated data are not that important - with this the normal polling interval could be faster.
* After you have "set" a value, wait at least 1-2 minutes before you read the updated values again because executing commands and updating the cloud data can take some time
* Ideally have at least 10 minutes time between switching the device power status because else thats bad for the moving parts of the devices

## Pre-requisites

This library acts as an OIDC client towards the Onecta API and uses OIDC's
`Authorization` grant to obtain the initial pair of OIDC tokens.  As such, 
you'll have to provide the following:

1. The `Client ID` and `Client Secret` of a registered application tied to your
   Daiking Developer account. If you do not have such an account, yet, you can
   create one in the [Daikin Developer Portal][p1]
2. The ability for the process that uses this library to listen on a local TCP
   port (configurable) in order to start an HTTP server that your browser will
   be redirected to at the end of the `Authorization` grant flow
3. A domain name or an IP that resolves to the machine that hosts the process using this
   library (if running locally you will not be able to use `localhost` or `127.0.0.1`
   as it is rejected by the Onecta API)

You will have to combine the port (point 2.) and domain name (point 3.) to
create the URL to be set as the application's `Redirect URI` in the
[Daikin Developer portal][p1]. Note that the same URL **must** also be passed
as a configuration parameter of the `DaikinCloudController` class or is build 
automatically from the provided values. Also note  that the `Redirect URI` must 
use the secure `https:` protocol and that this library ships with its own self-signed 
SSL/TLS certificate, which will cause your browser to present you with a security warning.

[p1]: https://developer.cloud.daikineurope.com

## Run instructions

Set the environment variables: 

```bash
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
OIDC_TOKEN_SET_FILE_PATH=.daikin-controller-cloud-tokenset
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_USERNAME=optional_user
MQTT_PASSWORD=optional_password
MQTT_TOPIC_PREFIX=daikin/sensory
```

### Build and run

```bash
npm run build
npm run start
```

On first start, complete the Onecta browser authorization flow shown in the terminal output.

## DaikinControllerCloud options overview

| Option                              | Required?       | Description                                                                                                                                                                                                                       | Default                           |
|-------------------------------------|-----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------|
| `oidcClientId`                      | Yes             | The client ID of the registered Daikin Developer Account application                                                                                                                                                              |                                   |
| `oidcClientSecret`                  | Yes             | The client secret of the registered Daikin Developer Account application                                                                                                                                                          |                                   |
| `oidcCallbackServerExternalAddress` | Maybe, see desc | The external address (domainname/IP) of the machine running the library, ot external Docker IP or such when using docker. Mandatory if `oidcCallbackServerBaseUrl` or `customOidcCodeReceiver` is not provided.                   |                                   |
| `oidcCallbackServerBaseUrl`         | Maybe, see desc | The full externally reachable callback URl including protocol, domain/ip/basepath. If not provided will be build internally using `oidcCallbackServerExternalAddress`or `oidcCallbackServerBindAddr` and `oidcCallbackServerPort` |                                   |
| `oidcCallbackServerPort`            | Maybe, see desc | The port the callback server listens on, required when `customOidcCodeReceiver` is not used.                                                                                                                                      |                                   |
| `oidcCallbackServerBindAddr`        | No              | The address the callback server listens on, required when `customOidcCodeReceiver` is not used.                                                                                                                                   | `                                 |
| `oidcCallbackServerProtocol`        | No              | The callback protocol. To run the server on `http` of `https`.                                                           | `                                 |
| `oidcAuthorizationTimeoutS`         | Yes             | The timeout in seconds for the OIDC authorization flow                                                                                                                                                                            |                                   |
| `oidcTokenSetFilePath`              | No              | The path to a file where the token set is stored. When not set the tokens are _not_ persisted and application need to listen to "token_updated" event and store and restore itself!                                               |                                   |
| `certificatePathCert`               | No              | The path to the SSL certificate                                                                                                                                                                                                   | `./cert/cert.key` in library root |
| `certificatePathKey`                | No              | The path to the SSL key                                                                                                                                                                                                           | `./cert/cert.pem` in library root |
| `onectaOidcAuthThankYouHtml`        | No              | The HTML content to be displayed after successful OIDC authorization, requiored when `customOidcCodeReceiver` is not used                                                                                                         |                                   |
| `customOidcCodeReceiver`            | No              | A custom function to receive the OIDC code. WHen this is used the library donot start any Webservcer and application needs to handle this.                                                                                        |                                   |
| `tokenSet`                          | No              | A token set to be used initially when no token file is stored                                                                                                                                                                     |                                   |
