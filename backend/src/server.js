require('dotenv').config();

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const { WebSocketServer } = require('ws');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const PORT = Number(process.env.PORT || 4000);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_TELEMETRY_TOPIC = process.env.MQTT_TELEMETRY_TOPIC || '+/telemetry';
const MQTT_STATUS_TOPIC = process.env.MQTT_STATUS_TOPIC || '+/status';
const MQTT_DEVICE_CONFIG_TOPIC_SUFFIX = process.env.MQTT_DEVICE_CONFIG_TOPIC_SUFFIX || 'config';
const MQTT_CONFIG_RETAIN = process.env.MQTT_CONFIG_RETAIN !== 'false';

const INFLUX_URL = process.env.INFLUX_URL || 'http://localhost:8086';
const INFLUX_TOKEN = process.env.INFLUXDB_TOKEN;
const INFLUX_ORG = process.env.INFLUXDB_ORG;
const INFLUX_BUCKET = process.env.INFLUXDB_BUCKET;
const INFLUX_MEASUREMENT = process.env.INFLUX_MEASUREMENT || 'sensor_data';

const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');
const MIN_AUTO_EXPORT_MS = Number(process.env.MIN_AUTO_EXPORT_MS || 10000);

if (!INFLUX_TOKEN || !INFLUX_ORG || !INFLUX_BUCKET) {
  console.warn('[WARN] InfluxDB env eksik. INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET değerlerini kontrol et.');
}

const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = influx.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ms', {
  batchSize: 100,
  flushInterval: 1000,
});
const queryApi = influx.getQueryApi(INFLUX_ORG);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/exports', express.static(EXPORT_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const state = {
  arduinoConnected: false,
  mqttConnected: false,
  lastDataAt: null,
  collectedRows: 0,
  devices: {},
  session: {
    active: false,
    id: null,
    name: null,
    threshold: {
      enabled: false,
      sensorKey: '',
      value: null,
      notificationEnabled: false,
      normalLabel: 'normal',
      anomalyLabel: 'anomaly',
    },
    startedAt: null,
    stoppedAt: null,
  },
  autoExport: {
    active: false,
    intervalMs: null,
    sessionId: null,
    includeLabel: false,
    lastExportAt: null,
    nextExportAt: null,
    lastFile: null,
    lastRowCount: 0,
    error: null,
  },
  thresholdMqtt: {
    lastPublishedAt: null,
    lastDeviceCount: 0,
    lastPayload: null,
    error: null,
  },
};

let recentBuffer = [];
let autoExportTimer = null;
let autoExportRunning = false;
const MAX_BUFFER_ROWS = 500;

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function slugifySessionName(input) {
  const clean = String(input || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '');
  return clean || `session_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
}

function flattenSensors(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;

  for (const [key, value] of Object.entries(obj)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
    const nextKey = prefix ? `${prefix}_${safeKey}` : safeKey;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenSensors(value, nextKey, out);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[nextKey] = value;
    }
  }

  return out;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';

  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

function rowsToCsv(rows, { includeLabel = false } = {}) {
  const allKeys = new Set(['timestamp', 'device_id', 'session_id', 'session_name']);
  const hasLabel =
    includeLabel ||
    rows.some((row) => row.label !== undefined && row.label !== null && row.label !== '');

  if (hasLabel) allKeys.add('label');

  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (key === 'label' && !hasLabel) return;
      allKeys.add(key);
    });
  });

  const headers = Array.from(allKeys);
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }

  return lines.join('\n');
}

function fluxString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeFilePart(value) {
  return String(value || 'all')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '') || 'all';
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function addMsToNow(ms) {
  return new Date(Date.now() + Number(ms || 0)).toISOString();
}

async function ensureExportDir() {
  await fs.mkdir(EXPORT_DIR, { recursive: true });
}

async function exportCsvToFile({ sessionId, label, includeLabel = false, reason = 'auto' } = {}) {
  await ensureExportDir();

  try {
    await writeApi.flush();
  } catch (error) {
    console.error('[Influx] auto-export flush error:', error.message);
  }

  const rows = await queryRecent({
    limit: 100000,
    sessionId,
    label,
    maxLimit: 500000,
  });

  const shouldIncludeLabel =
    includeLabel ||
    rows.some((row) => row.label !== undefined && row.label !== null && row.label !== '');

  const csv = rowsToCsv(rows, { includeLabel: shouldIncludeLabel });

  const fileName = `sensor_dataset_${safeFilePart(sessionId || 'all')}_${reason}_${compactTimestamp()}.csv`;
  const filePath = path.join(EXPORT_DIR, fileName);

  await fs.writeFile(filePath, csv, 'utf8');

  const meta = {
    lastExportAt: nowIso(),
    lastFile: fileName,
    lastRowCount: rows.length,
    error: null,
  };

  state.autoExport = {
    ...state.autoExport,
    ...meta,
  };

  return meta;
}

function clearAutoExportTimer() {
  if (autoExportTimer) clearInterval(autoExportTimer);
  autoExportTimer = null;
}

function startAutoExportTimer() {
  clearAutoExportTimer();

  if (!state.autoExport.active || !state.autoExport.intervalMs) return;

  state.autoExport.nextExportAt = addMsToNow(state.autoExport.intervalMs);

  autoExportTimer = setInterval(async () => {
    if (autoExportRunning) return;

    autoExportRunning = true;

    try {
      await exportCsvToFile({
        sessionId: state.autoExport.sessionId,
        includeLabel: state.autoExport.includeLabel,
        reason: 'auto',
      });

      state.autoExport.nextExportAt = addMsToNow(state.autoExport.intervalMs);
    } catch (error) {
      console.error('[AutoExport] error:', error.message);
      state.autoExport.error = error.message;
    } finally {
      autoExportRunning = false;
      broadcast({ type: 'auto_export', state });
    }
  }, state.autoExport.intervalMs);
}

async function queryRecent({ limit = 50, sessionId, label, maxLimit = 1000 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, maxLimit));

  const filters = [
    `r._measurement == "${fluxString(INFLUX_MEASUREMENT)}"`,
  ];

  if (sessionId) filters.push(`r.session_id == "${fluxString(sessionId)}"`);
  if (label) filters.push(`r.label == "${fluxString(label)}"`);

  const flux = `
from(bucket: "${fluxString(INFLUX_BUCKET)}")
  |> range(start: -365d)
  |> filter(fn: (r) => ${filters.join(' and ')})
  |> pivot(rowKey:["_time"], columnKey:["_field"], valueColumn:"_value")
  |> sort(columns:["_time"], desc:true)
  |> limit(n:${safeLimit})
`;

  const rows = [];

  return new Promise((resolve, reject) => {
    queryApi.queryRows(flux, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        rows.push(normalizeInfluxRow(o));
      },
      error(error) {
        reject(error);
      },
      complete() {
        resolve(rows.reverse());
      },
    });
  });
}

function normalizeInfluxRow(row) {
  const normalized = {
    timestamp: row._time,
    device_id: row.device_id,
    session_id: row.session_id,
    session_name: row.session_name,
  };

  if (row.label !== undefined && row.label !== null && row.label !== '') {
    normalized.label = row.label;
  }

  for (const [key, value] of Object.entries(row)) {
    if (
      key.startsWith('_') ||
      [
        'result',
        'table',
        'device_id',
        'session_id',
        'session_name',
        'label',
        'threshold_sensor',
        'threshold_value',
      ].includes(key)
    ) {
      continue;
    }

    if (typeof value === 'number') normalized[key] = value;
  }

  return normalized;
}

function parseThresholdConfig(body = {}) {
  const thresholdEnabled = Boolean(body.thresholdEnabled);
  const sensorKey = String(body.thresholdSensor || body.thresholdSensorKey || '').trim();
  const notificationEnabled = Boolean(
    body.thresholdNotificationEnabled ||
    body.thresholdNotifyEnabled ||
    body.buzzerEnabled
  );

  const valueRaw = body.thresholdValue;
  const value =
    valueRaw === '' || valueRaw === null || valueRaw === undefined
      ? null
      : Number(valueRaw);

  const enabled = thresholdEnabled && sensorKey && Number.isFinite(value);

  return {
    enabled,
    sensorKey: enabled ? sensorKey : '',
    value: enabled ? value : null,
    notificationEnabled: enabled ? notificationEnabled : false,
    normalLabel: 'normal',
    anomalyLabel: 'anomaly',
  };
}

function getKnownDeviceIds() {
  return Object.keys(state.devices || {}).filter(Boolean);
}

function buildThresholdMqttPayload(threshold = {}) {
  const enabled = Boolean(threshold.enabled && threshold.sensorKey && Number.isFinite(Number(threshold.value)));

  return {
    type: 'threshold_config',
    enabled,
    sensorKey: enabled ? threshold.sensorKey : '',
    value: enabled ? Number(threshold.value) : null,
    notificationEnabled: Boolean(enabled && threshold.notificationEnabled),
    updatedAt: nowIso(),
  };
}

function publishThresholdConfigToDevices(threshold = {}, { deviceIds = getKnownDeviceIds() } = {}) {
  const payloadObject = buildThresholdMqttPayload(threshold);
  const payload = JSON.stringify(payloadObject);
  const results = [];

  for (const deviceId of deviceIds) {
    const topic = `${deviceId}/${MQTT_DEVICE_CONFIG_TOPIC_SUFFIX}`;

    mqttClient.publish(
      topic,
      payload,
      { qos: 0, retain: MQTT_CONFIG_RETAIN },
      (error) => {
        if (error) {
          console.error(`[MQTT] threshold config publish failed: ${topic}`, error.message);
          state.thresholdMqtt.error = error.message;
        }
      }
    );

    results.push({
      deviceId,
      topic,
      published: true,
    });
  }

  state.thresholdMqtt = {
    lastPublishedAt: nowIso(),
    lastDeviceCount: results.length,
    lastPayload: payloadObject,
    error: null,
  };

  console.log('[MQTT] threshold config published:', payload, results);

  return {
    payload: payloadObject,
    results,
  };
}

function computeThresholdLabel(sensors, threshold) {
  if (!threshold || !threshold.enabled) return undefined;

  const value = sensors[threshold.sensorKey];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;

  return value >= threshold.value ? threshold.anomalyLabel : threshold.normalLabel;
}

function sampleToRow(sample) {
  const row = {
    timestamp: sample.timestamp,
    device_id: sample.device_id,
    session_id: sample.session_id,
    session_name: sample.session_name,
    ...sample.sensors,
  };

  if (sample.label !== undefined && sample.label !== null && sample.label !== '') {
    row.label = sample.label;
  }

  return row;
}

function writeSampleToInflux(sample) {
  const point = new Point(INFLUX_MEASUREMENT)
    .tag('device_id', sample.device_id)
    .tag('session_id', sample.session_id)
    .tag('session_name', sample.session_name)
    .timestamp(new Date(sample.timestamp));

  if (sample.label !== undefined && sample.label !== null && sample.label !== '') {
    point.tag('label', sample.label);
  }

  if (sample.threshold && sample.threshold.enabled) {
    point.tag('threshold_sensor', sample.threshold.sensorKey);
    point.tag('threshold_value', String(sample.threshold.value));
  }

  for (const [key, value] of Object.entries(sample.sensors)) {
    point.floatField(key, value);
  }

  writeApi.writePoint(point);
}

const mqttClient = mqtt.connect(MQTT_URL, {
  reconnectPeriod: 2000,
  clean: true,
});

mqttClient.on('connect', () => {
  state.mqttConnected = true;

  mqttClient.subscribe([MQTT_TELEMETRY_TOPIC, MQTT_STATUS_TOPIC], (err) => {
    if (err) {
      console.error('[MQTT] subscribe error:', err.message);
    } else {
      console.log(`[MQTT] subscribed: ${MQTT_TELEMETRY_TOPIC}, ${MQTT_STATUS_TOPIC}`);
    }
  });

  if (state.session.active) {
    publishThresholdConfigToDevices(state.session.threshold);
  }

  broadcast({ type: 'state', state });
});

mqttClient.on('offline', () => {
  state.mqttConnected = false;
  broadcast({ type: 'state', state });
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] error:', err.message);
});

mqttClient.on('message', (topic, payloadBuffer) => {
  const topicParts = topic.split('/');
  const deviceFromTopic = topicParts[0];
  const kind = topicParts[topicParts.length - 1];

  let payload;

  try {
    payload = JSON.parse(payloadBuffer.toString());
  } catch (error) {
    console.warn('[MQTT] JSON parse edilemedi:', topic, error.message);
    return;
  }

  if (kind === 'status') {
    const deviceId = deviceFromTopic;

    state.devices[deviceId] = {
      ...(state.devices[deviceId] || {}),
      id: deviceId,
      status: payload.status || 'unknown',
      active_sensors: payload.active_sensors || [],
      lastStatusAt: nowIso(),
    };

    state.arduinoConnected = Object.values(state.devices).some((d) => d.status === 'online');

    if (state.session.active) {
      publishThresholdConfigToDevices(state.session.threshold, { deviceIds: [deviceId] });
    }

    broadcast({ type: 'status', state });
    return;
  }

  if (kind !== 'telemetry') return;

  const sensors = flattenSensors(payload.sensors || {});
  if (Object.keys(sensors).length === 0) return;

  const deviceId = payload.id || deviceFromTopic;
  const timestamp = nowIso();

  const threshold = state.session.active ? state.session.threshold : { enabled: false };
  const computedLabel = computeThresholdLabel(sensors, threshold);

  const sample = {
    timestamp,
    device_id: deviceId,
    session_id: state.session.active ? state.session.id : 'preview',
    session_name: state.session.active ? state.session.name : 'preview',
    collecting: state.session.active,
    sensors,
    threshold,
  };

  if (computedLabel !== undefined) {
    sample.label = computedLabel;
  }

  state.lastDataAt = timestamp;
  state.arduinoConnected = true;

  state.devices[deviceId] = {
    ...(state.devices[deviceId] || {}),
    id: deviceId,
    status: 'online',
    lastTelemetryAt: timestamp,
    sensor_keys: Object.keys(sensors),
  };

  recentBuffer.push(sample);

  if (recentBuffer.length > MAX_BUFFER_ROWS) {
    recentBuffer = recentBuffer.slice(-MAX_BUFFER_ROWS);
  }

  if (state.session.active) {
    state.collectedRows += 1;

    try {
      writeSampleToInflux(sample);
    } catch (error) {
      console.error('[Influx] write error:', error.message);
    }
  }

  broadcast({ type: 'telemetry', sample, state });
});

app.get('/api/auto-export/status', (req, res) => {
  res.json(state.autoExport);
});

app.post('/api/auto-export/start', (req, res) => {
  const intervalMs = Math.max(MIN_AUTO_EXPORT_MS, Number(req.body.intervalMs) || 300000);
  const sessionId = String(req.body.sessionId || '').trim() || null;
  const includeLabel = Boolean(req.body.includeLabel);

  state.autoExport = {
    ...state.autoExport,
    active: true,
    intervalMs,
    sessionId,
    includeLabel,
    nextExportAt: addMsToNow(intervalMs),
    error: null,
  };

  startAutoExportTimer();

  broadcast({ type: 'auto_export', state });
  res.json(state.autoExport);
});

app.post('/api/auto-export/stop', (req, res) => {
  clearAutoExportTimer();

  state.autoExport = {
    ...state.autoExport,
    active: false,
    nextExportAt: null,
  };

  broadcast({ type: 'auto_export', state });
  res.json(state.autoExport);
});

app.post('/api/auto-export/run-once', async (req, res) => {
  try {
    const sessionId =
      String(req.body.sessionId || '').trim() ||
      state.autoExport.sessionId ||
      null;

    const includeLabel = Boolean(req.body.includeLabel ?? state.autoExport.includeLabel);

    await exportCsvToFile({
      sessionId,
      includeLabel,
      reason: 'manual',
    });

    broadcast({ type: 'auto_export', state });
    res.json(state.autoExport);
  } catch (error) {
    console.error('[API] auto-export run-once error:', error.message);
    state.autoExport.error = error.message;
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/session/start', (req, res) => {
  const name = String(req.body.sessionName || req.body.name || '').trim();
  const id = slugifySessionName(name);
  const threshold = parseThresholdConfig(req.body);

  state.session = {
    active: true,
    id,
    name: name || id,
    threshold,
    startedAt: nowIso(),
    stoppedAt: null,
  };

  state.collectedRows = 0;

  const thresholdPublish = publishThresholdConfigToDevices(threshold);

  broadcast({ type: 'session', state, thresholdPublish });
  res.json({ ...state.session, thresholdPublish });
});

app.post('/api/session/stop', async (req, res) => {
  const disabledThreshold = {
    ...state.session.threshold,
    enabled: false,
    sensorKey: '',
    value: null,
    notificationEnabled: false,
  };

  state.session = {
    ...state.session,
    active: false,
    threshold: disabledThreshold,
    stoppedAt: nowIso(),
  };

  const thresholdPublish = publishThresholdConfigToDevices(disabledThreshold);

  try {
    await writeApi.flush();
  } catch (error) {
    console.error('[Influx] flush error:', error.message);
  }

  broadcast({ type: 'session', state, thresholdPublish });
  res.json({ ...state.session, thresholdPublish });
});

app.delete('/api/session/clear', (req, res) => {
  recentBuffer = [];
  state.collectedRows = 0;

  broadcast({ type: 'state', state });

  res.json({
    ok: true,
    message: 'Canlı tampon temizlendi. InfluxDB geçmiş verisi silinmedi.',
  });
});

app.get('/api/recent', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const label = req.query.label;
    const limit = req.query.limit || 50;

    if (!sessionId && !label && recentBuffer.length > 0) {
      const rows = recentBuffer.slice(-Number(limit || 50)).map(sampleToRow);
      res.json(rows);
      return;
    }

    const rows = await queryRecent({ limit, sessionId, label });
    res.json(rows);
  } catch (error) {
    console.error('[API] recent error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export.csv', async (req, res) => {
  try {
    const rows = await queryRecent({
      limit: req.query.limit || 100000,
      sessionId: req.query.session_id,
      label: req.query.label,
      maxLimit: 500000,
    });

    const includeLabel =
      req.query.include_label === 'true' ||
      rows.some((row) => row.label !== undefined && row.label !== null && row.label !== '');

    const csv = rowsToCsv(rows, { includeLabel });
    const fileName = `sensor_dataset_${req.query.session_id || 'all'}_${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  } catch (error) {
    console.error('[API] export error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state }));
});

process.on('SIGINT', async () => {
  clearAutoExportTimer();

  try {
    await writeApi.close();
  } catch (_) {}

  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`API/WebSocket listening on http://localhost:${PORT}`);
  console.log(`MQTT broker: ${MQTT_URL}`);
  console.log(`InfluxDB: ${INFLUX_URL}, bucket=${INFLUX_BUCKET}, org=${INFLUX_ORG}`);
  console.log(`CSV export dir: ${EXPORT_DIR}`);
});