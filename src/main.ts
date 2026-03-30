import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { connect, IClientOptions, MqttClient } from 'mqtt';
import { DaikinCloudController, RateLimitedError } from './index.js';

type DaikinSensoryPayload = {
    timestamp: string;
    name: string;
    state: 'on' | 'off' | 'unknown';
    operationMode: string;
    indoorTemperature?: number;
    outdoorTemperature?: number;
    targetTemperature?: number;
};

const POLL_INTERVAL_MS = 15 * 60 * 1000;

function normalizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function toPrimitive(value: unknown): unknown {
    if (!value || typeof value !== 'object') {
        return value;
    }
    const valueRecord = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(valueRecord, 'value')) {
        return valueRecord.value;
    }
    return value;
}

function findFirstByCandidate(device: unknown, candidates: string[]): unknown {
    const wanted = new Set(candidates.map((key) => normalizeKey(key)));
    const queue: unknown[] = [device];

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') {
            continue;
        }

        const currentRecord = current as Record<string, unknown>;
        for (const [key, value] of Object.entries(currentRecord)) {
            const primitiveValue = toPrimitive(value);
            if (wanted.has(normalizeKey(key)) && primitiveValue !== undefined && primitiveValue !== null) {
                return primitiveValue;
            }
            if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return undefined;
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function asString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return null;
}

function asState(value: unknown): 'on' | 'off' | 'unknown' {
    if (typeof value === 'boolean') {
        return value ? 'on' : 'off';
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['on', 'true', 'enabled', 'running'].includes(normalized)) {
            return 'on';
        }
        if (['off', 'false', 'disabled', 'stopped'].includes(normalized)) {
            return 'off';
        }
    }
    return 'unknown';
}

function sanitizeTopicPart(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '');
}

function mapDeviceToPayload(device: Record<string, unknown>): DaikinSensoryPayload {
    const timestamp = asString(findFirstByCandidate(device, ['timestamp', 'lastUpdateReceived'])) ?? new Date().toISOString();

    const name =
        asString(findFirstByCandidate(device, ['name', 'deviceName', 'climateName'])) ??
        asString(device.id) ??
        'unknown-device';

    const state = asState(findFirstByCandidate(device, ['onOffMode', 'power', 'state']));

    const operationMode =
        asString(findFirstByCandidate(device, ['operationMode', 'mode', 'hvacMode']))?.toLowerCase() ??
        'unknown';

    const indoorTemperature = asNumber(
        findFirstByCandidate(device, ['indoorTemperature', 'insideTemperature', 'roomTemperature'])
    );

    const outdoorTemperature = asNumber(
        findFirstByCandidate(device, ['outdoorTemperature', 'outsideTemperature'])
    );

    const targetTemperature = asNumber(
        findFirstByCandidate(device, ['targetTemperature', 'targetTemp', 'setpointTemperature'])
    );

    const payload: DaikinSensoryPayload = { timestamp, name, state, operationMode };
    if (indoorTemperature !== null) payload.indoorTemperature = indoorTemperature;
    if (outdoorTemperature !== null) payload.outdoorTemperature = outdoorTemperature;
    if (targetTemperature !== null) payload.targetTemperature = targetTemperature;
    return payload;
}

function getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

async function publishDevicePayload(mqttClient: MqttClient, topic: string, payload: DaikinSensoryPayload): Promise<void> {
    const message = JSON.stringify(payload);
    await new Promise<void>((resolvePublish, rejectPublish) => {
        mqttClient.publish(topic, message, { qos: 1, retain: true }, (error?: Error) => {
            if (error) {
                rejectPublish(error);
                return;
            }
            resolvePublish();
        });
    });
}

async function main(): Promise<void> {
    const oidcClientId = getRequiredEnv('OIDC_CLIENT_ID');
    const oidcClientSecret = getRequiredEnv('OIDC_CLIENT_SECRET');
    const daikinTokenFile = process.env.OIDC_TOKEN_SET_FILE_PATH ?? resolve(homedir(), '.daikin-controller-cloud-tokenset');
    const mqttUrl = getRequiredEnv('MQTT_URL');
    const mqttTopicPrefix = process.env.MQTT_TOPIC_PREFIX ?? 'daikin/sensory';

    const mqttUsername = process.env.MQTT_USERNAME;
    const mqttPassword = process.env.MQTT_PASSWORD;

    const mqttOptions: IClientOptions = {
        username: mqttUsername,
        password: mqttPassword,
        reconnectPeriod: 5000,
    };

    const mqttClient = connect(mqttUrl, mqttOptions);
    await new Promise<void>((resolveConnect, rejectConnect) => {
        mqttClient.once('connect', () => resolveConnect());
        mqttClient.once('error', (error) => rejectConnect(error));
    });

    const controller = new DaikinCloudController({
        oidcClientId,
        oidcClientSecret,
        oidcCallbackServerPort: 8765,
        // oidcCallbackServerProtocol: 'http',
        oidcCallbackServerBaseUrl: 'https://dev.lvdbrink.nl/redirect/oauth',
        oidcTokenSetFilePath: daikinTokenFile,
        oidcAuthorizationTimeoutS: 120,
        certificatePathKey: resolve(__dirname, '..', 'cert', 'cert.key'),
        certificatePathCert: resolve(__dirname, '..', 'cert', 'cert.pem'),
    });

    controller.on('authorization_request', (url) => {
        console.log(`Open this URL in a browser to authorize access: ${url}`);
    });

    controller.on('rate_limit_status', (status) => {
        console.log('Rate limit status:', status);
    });

    let pollInProgress = false;

    const runPollCycle = async () => {
        if (pollInProgress) {
            console.log('Skipping poll because previous cycle is still running.');
            return;
        }
        pollInProgress = true;
        try {
            const devices = await controller.getCloudDeviceDetails();
            if (!Array.isArray(devices)) {
                throw new Error('Unexpected response: getCloudDeviceDetails did not return an array');
            }

            for (const device of devices) {
                if (!device || typeof device !== 'object') {
                    continue;
                }

                const payload = mapDeviceToPayload(device as Record<string, unknown>);
                const topic = `${mqttTopicPrefix}/${sanitizeTopicPart(payload.name)}`;
                await publishDevicePayload(mqttClient, topic, payload);
                console.log(`Published MQTT message to ${topic}: ${JSON.stringify(payload)}`);
            }
        } catch (error) {
            if (error instanceof RateLimitedError) {
                console.error('Rate limited by Onecta API.', {
                    retryAfter: error.retryAfter,
                    message: error.message,
                });
            } else {
                console.error('Polling cycle failed:', error);
            }
        } finally {
            pollInProgress = false;
        }
    };

    await runPollCycle();
    setInterval(runPollCycle, POLL_INTERVAL_MS);
    console.log('Daikin sensory publisher started. Poll interval: 15 minutes.');
}

void main().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
});
