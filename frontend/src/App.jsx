import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Cable,
  CircleStop,
  Database,
  Download,
  Eraser,
  Play,
  Radio,
  Server,
  Settings,
  Sliders,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// ─────────────────────────── Constants ───────────────────────────

const MAX_CHART_POINTS = 180;

const UNIT_MAP = {
  mpu_temp: '°C',
  temp: '°C',
  tof: 'mm',
  sr04: 'cm',
  mpu_accX: 'g',
  mpu_accY: 'g',
  mpu_accZ: 'g',
  mpu_gyroX: '°/s',
  mpu_gyroY: '°/s',
  mpu_gyroZ: '°/s',
};

const EXPORT_INTERVAL_PRESETS = [
  { value: '60000', label: '1 dk' },
  { value: '300000', label: '5 dk' },
  { value: '900000', label: '15 dk' },
  { value: '3600000', label: '1 saat' },
  { value: 'custom', label: 'Custom' },
];

const CUSTOM_UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
};

const MIN_AUTO_EXPORT_MS = 10 * 1000;

// ─────────────────────────── Utilities ───────────────────────────

function getWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function formatRelative(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('tr-TR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatNum(v, dec) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const d = dec !== undefined ? dec : Math.abs(n) >= 100 ? 1 : 2;
  return n.toFixed(d);
}

function resolveAutoExportIntervalMs(preset, customValue, customUnit) {
  if (preset !== 'custom') return Math.max(MIN_AUTO_EXPORT_MS, Number(preset) || 300000);
  const value = Math.max(1, Number(customValue) || 1);
  const unitMs = CUSTOM_UNIT_MS[customUnit] || CUSTOM_UNIT_MS.minute;
  return Math.max(MIN_AUTO_EXPORT_MS, Math.round(value * unitMs));
}

function formatDuration(ms) {
  const totalSeconds = Math.round((Number(ms) || 0) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sn`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} dk`;
  const hours = totalMinutes / 60;
  return Number.isInteger(hours) ? `${hours} saat` : `${hours.toFixed(1)} saat`;
}

function toFlatRow(sample) {
  const row = {
    timestamp: sample.timestamp,
    device_id: sample.device_id,
    session_id: sample.session_id,
    session_name: sample.session_name,
    ...(sample.sensors || {}),
  };
  if (sample.label != null && sample.label !== '') row.label = sample.label;
  return row;
}

function getSensorKeys(rows) {
  const skip = new Set(['timestamp', 'device_id', 'session_id', 'session_name', 'label', 'collecting']);
  const keys = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => { if (!skip.has(k) && typeof r[k] === 'number') keys.add(k); }));
  return Array.from(keys).sort();
}

function computeStats(rows, key) {
  const vals = rows.map(r => r[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { last: null, prev: null, avg: null, min: null, max: null, count: 0 };
  const sum = vals.reduce((a, v) => a + v, 0);
  return { last: vals.at(-1), prev: vals.length > 1 ? vals.at(-2) : null, avg: sum / vals.length, min: Math.min(...vals), max: Math.max(...vals), count: vals.length };
}

// ─────────────────────────── Sub-components ───────────────────────────

function ConnDot({ on }) {
  return <span className={`conn-dot ${on ? 'conn-dot--on' : 'conn-dot--off'}`} />;
}

function StatusBadge({ on, label, value }) {
  return (
    <div className={`status-badge ${on ? 'status-badge--on' : ''}`}>
      <ConnDot on={on} />
      <span className="status-badge__label">{label}</span>
      <span className="status-badge__value">{value}</span>
    </div>
  );
}

function SectionLabel({ icon: Icon, children }) {
  return (
    <div className="section-label">
      {Icon && <Icon size={12} aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

function LabelBadge({ label }) {
  if (!label) return <span className="cell-empty">—</span>;
  return <span className={`label-badge label-badge--${label}`}>{label}</span>;
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="empty-state" role="status">
      <div className="empty-state__icon"><Icon size={22} aria-hidden="true" /></div>
      <strong>{title}</strong>
      {sub && <span>{sub}</span>}
    </div>
  );
}

function RecordingPill({ active, rows }) {
  if (!active) return (
    <div className="rec-pill rec-pill--idle" aria-label="Recording stopped">
      <CircleStop size={12} aria-hidden="true" />
      <span>Idle</span>
    </div>
  );
  return (
    <div className="rec-pill rec-pill--active" aria-label={`Recording — ${rows} rows`}>
      <span className="rec-pulse" aria-hidden="true" />
      <span>{(rows || 0).toLocaleString()} rows</span>
    </div>
  );
}

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip" role="tooltip">
      <div className="chart-tooltip__time">{label}</div>
      <div className="chart-tooltip__val">
        {formatNum(payload[0]?.value)}
        {unit && <span className="chart-tooltip__unit"> {unit}</span>}
      </div>
    </div>
  );
}

function MetricStrip({ stats, unit, sensor, trend }) {
  if (!sensor || stats.count === 0) return null;
  return (
    <div className="metric-strip" role="region" aria-label="Sensor statistics">
      <div className="metric-card metric-card--accent">
        <span className="metric-card__label">Current</span>
        <span className="metric-card__val">
          {formatNum(stats.last)}
          {unit && <span className="metric-card__unit">{unit}</span>}
        </span>
        {trend !== 0 && (
          <span className={`metric-card__trend ${trend > 0 ? 'trend--up' : 'trend--down'}`} aria-label={trend > 0 ? 'Rising' : 'Falling'}>
            {trend > 0 ? <TrendingUp size={11} aria-hidden="true" /> : <TrendingDown size={11} aria-hidden="true" />}
          </span>
        )}
      </div>
      {[
        { label: 'Average', val: formatNum(stats.avg) },
        { label: 'Min', val: formatNum(stats.min) },
        { label: 'Max', val: formatNum(stats.max) },
        { label: 'Samples', val: stats.count.toLocaleString() },
      ].map(({ label, val }) => (
        <div className="metric-card" key={label}>
          <span className="metric-card__label">{label}</span>
          <span className="metric-card__val">{val}{unit && label !== 'Samples' && <span className="metric-card__unit">{unit}</span>}</span>
        </div>
      ))}
    </div>
  );
}

// Custom recharts ticks (SVG text with mono font via className)
function YTick({ x, y, payload }) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" className="axis-tick">
      {payload.value}
    </text>
  );
}
function XTick({ x, y, payload }) {
  return (
    <text x={x} y={y} dy={13} textAnchor="middle" className="axis-tick">
      {payload.value}
    </text>
  );
}

// ─────────────────────────── Main App ───────────────────────────

export default function App() {
  const [serverState, setServerState] = useState(null);
  const [rows, setRows] = useState([]);
  const [selectedSensor, setSelectedSensor] = useState('');
  const [sessionName, setSessionName] = useState('experiment_01');
  const [thresholdEnabled, setThresholdEnabled] = useState(false);
  const [thresholdSensor, setThresholdSensor] = useState('');
  const [thresholdValue, setThresholdValue] = useState('');
  const [thresholdNotificationEnabled, setThresholdNotificationEnabled] = useState(false);
  const [autoExportEnabled, setAutoExportEnabled] = useState(false);
  const [autoExportPreset, setAutoExportPreset] = useState('300000');
  const [autoExportCustomValue, setAutoExportCustomValue] = useState('10');
  const [autoExportCustomUnit, setAutoExportCustomUnit] = useState('minute');
  const [autoExportStatus, setAutoExportStatus] = useState(null);
  const [autoExportBusy, setAutoExportBusy] = useState(false);
  const [tableLabelFilter, setTableLabelFilter] = useState('all');
  const [tableSessionFilter, setTableSessionFilter] = useState('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sensorSettings, setSensorSettings] = useState({});
  const [wsConnected, setWsConnected] = useState(false);
  const [flash, setFlash] = useState(null); // { type: 'ok'|'err', msg }
  const [loading, setLoading] = useState(true);
  const tickRef = useRef(null);

  // ── Init ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [sr, rr] = await Promise.all([fetch('/api/state'), fetch('/api/recent?limit=80')]);
        setServerState(await sr.json());
        const r = await rr.json();
        setRows(Array.isArray(r) ? r : []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    refreshAutoExportStatus();
  }, []);

  // ── WebSocket ─────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket(getWsUrl());
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.state) {
        setServerState({ ...msg.state });
        if (msg.state.autoExport) setAutoExportStatus({ ...msg.state.autoExport });
      }
      if (msg.type === 'telemetry' && msg.sample) {
        setRows(prev => [...prev.slice(-(MAX_CHART_POINTS - 1)), toFlatRow(msg.sample)]);
      }
    };
    return () => ws.close();
  }, []);

  // ── Clock tick for relative time ──────────────────────────────
  useEffect(() => {
    tickRef.current = setInterval(() => setServerState(p => p ? { ...p } : p), 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  // ── Derived ───────────────────────────────────────────────────
  const sensorKeys = useMemo(() => getSensorKeys(rows), [rows]);

  useEffect(() => {
    if (!selectedSensor && sensorKeys.length) setSelectedSensor(sensorKeys[0]);
    if (selectedSensor && !sensorKeys.includes(selectedSensor) && sensorKeys.length) setSelectedSensor(sensorKeys[0]);
  }, [sensorKeys, selectedSensor]);

  useEffect(() => {
    if (!thresholdSensor && sensorKeys.length) setThresholdSensor(selectedSensor || sensorKeys[0]);
    if (thresholdSensor && !sensorKeys.includes(thresholdSensor) && sensorKeys.length) setThresholdSensor(sensorKeys[0]);
  }, [sensorKeys, selectedSensor, thresholdSensor]);

  useEffect(() => {
    const th = serverState?.session?.threshold;
    if (!serverState?.session?.active || !th) return;

    setThresholdEnabled(Boolean(th.enabled));
    setThresholdSensor(th.sensorKey || '');
    setThresholdValue(th.value ?? '');
    setThresholdNotificationEnabled(Boolean(th.notificationEnabled));
  }, [serverState?.session?.id, serverState?.session?.active]);

  const unit = UNIT_MAP[selectedSensor] || sensorSettings[selectedSensor]?.unit || '';
  const thresholdReady = thresholdEnabled && thresholdSensor && thresholdValue !== '' && Number.isFinite(Number(thresholdValue));
  const thresholdNum = thresholdReady ? Number(thresholdValue) : null;
  const autoExportIntervalMs = useMemo(
    () => resolveAutoExportIntervalMs(autoExportPreset, autoExportCustomValue, autoExportCustomUnit),
    [autoExportPreset, autoExportCustomValue, autoExportCustomUnit]
  );
  const autoExportActive = Boolean(autoExportStatus?.active);
  const autoExportDownloadUrl = autoExportStatus?.lastFile ? `/exports/${autoExportStatus.lastFile}` : '';

  const chartData = useMemo(() => {
    if (!selectedSensor) return [];
    return rows.filter(r => typeof r[selectedSensor] === 'number').slice(-MAX_CHART_POINTS)
      .map(r => ({ time: formatTime(r.timestamp), value: r[selectedSensor] }));
  }, [rows, selectedSensor]);

  const hasLabel = useMemo(() => rows.some(r => r.label != null && r.label !== ''), [rows]);

  const tableRows = useMemo(() => rows
    .filter(r => !hasLabel || tableLabelFilter === 'all' || r.label === tableLabelFilter)
    .filter(r => tableSessionFilter === 'all' || r.session_id === tableSessionFilter)
    .slice(-50).reverse(), [rows, hasLabel, tableLabelFilter, tableSessionFilter]);

  const availableLabels = useMemo(() => {
    const s = new Set(); rows.forEach(r => r.label && s.add(r.label)); return [...s].sort();
  }, [rows]);

  const availableSessions = useMemo(() => {
    const s = new Set();
    rows.forEach(r => r.session_id && s.add(r.session_id));
    if (serverState?.session?.id) s.add(serverState.session.id);
    return [...s];
  }, [rows, serverState]);

  const session = serverState?.session || {};
  const selStats = useMemo(() => computeStats(rows, selectedSensor), [rows, selectedSensor]);
  const trend = selStats.last != null && selStats.prev != null
    ? selStats.last > selStats.prev ? 1 : selStats.last < selStats.prev ? -1 : 0 : 0;

  // ── Actions ───────────────────────────────────────────────────
  function showFlash(type, msg) {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 3500);
  }

  async function refreshAutoExportStatus() {
    try {
      const res = await fetch('/api/auto-export/status');
      const status = await res.json();
      setAutoExportStatus(status);
      setAutoExportEnabled(Boolean(status?.active));
    } catch (error) {
      console.error(error);
    }
  }

  async function startAutoExport() {
    try {
      setAutoExportBusy(true);
      const res = await fetch('/api/auto-export/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intervalMs: autoExportIntervalMs,
          sessionId: session?.id || '',
          includeLabel: hasLabel || thresholdEnabled,
        }),
      });
      if (!res.ok) throw new Error('Auto export start failed');
      const status = await res.json();
      setAutoExportStatus(status);
      setAutoExportEnabled(true);
      showFlash('ok', `Auto export started — every ${formatDuration(status.intervalMs)}`);
    } catch (error) {
      console.error(error);
      showFlash('err', 'Failed to start auto export');
    } finally {
      setAutoExportBusy(false);
    }
  }

  async function stopAutoExport() {
    try {
      setAutoExportBusy(true);
      const res = await fetch('/api/auto-export/stop', { method: 'POST' });
      if (!res.ok) throw new Error('Auto export stop failed');
      const status = await res.json();
      setAutoExportStatus(status);
      setAutoExportEnabled(false);
      showFlash('ok', 'Auto export stopped');
    } catch (error) {
      console.error(error);
      showFlash('err', 'Failed to stop auto export');
    } finally {
      setAutoExportBusy(false);
    }
  }

  async function runAutoExportNow() {
    try {
      setAutoExportBusy(true);
      const res = await fetch('/api/auto-export/run-once', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session?.id || '',
          includeLabel: hasLabel || thresholdEnabled,
        }),
      });
      if (!res.ok) throw new Error('Auto export run once failed');
      const status = await res.json();
      setAutoExportStatus(status);
      showFlash('ok', `CSV saved — ${status.lastRowCount || 0} rows`);
    } catch (error) {
      console.error(error);
      showFlash('err', 'Failed to create CSV file');
    } finally {
      setAutoExportBusy(false);
    }
  }

  async function startSession() {
    try {
      const res = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionName,
          thresholdEnabled: thresholdReady,
          thresholdSensor,
          thresholdValue: thresholdReady ? Number(thresholdValue) : null,
          thresholdNotificationEnabled: thresholdReady && thresholdNotificationEnabled,
        }),
      });
      const ns = await res.json();
      setServerState(p => ({ ...(p || {}), session: ns, collectedRows: 0 }));
      showFlash(
        'ok',
        `Session "${ns.name}" started${thresholdReady && thresholdNotificationEnabled ? ' — ESP32 buzzer active' : ''}`
      );
    } catch { showFlash('err', 'Failed to start session'); }
  }

  async function stopSession() {
    try {
      const res = await fetch('/api/session/stop', { method: 'POST' });
      const ss = await res.json();
      setServerState(p => ({ ...(p || {}), session: ss }));
      showFlash('ok', 'Session stopped — data flushed to InfluxDB');
    } catch { showFlash('err', 'Failed to stop session'); }
  }

  async function clearData() {
    await fetch('/api/session/clear', { method: 'DELETE' });
    setRows([]);
    showFlash('ok', 'Live buffer cleared');
  }

  function downloadCsv() {
    const p = new URLSearchParams();
    if (session?.id) p.set('session_id', session.id);
    if (hasLabel) p.set('include_label', 'true');
    window.location.href = `/api/export.csv?${p.toString()}`;
  }

  function updateSetting(key, patch) {
    setSensorSettings(p => ({ ...p, [key]: { ...(p[key] || {}), ...patch } }));
  }

  // ─────────────────────────── Render ───────────────────────────
  return (
    <div className="shell">

      {/* ═══ HEADER ═══════════════════════════════════════════════ */}
      <header className="topbar" role="banner">
        <div className="topbar__brand">
          <div className="brand-icon" aria-hidden="true"><Activity size={16} /></div>
          <div>
            <span className="brand-name">SensorForge</span>
            <span className="brand-sub">IoT Dataset Platform</span>
          </div>
        </div>

        <div className="topbar__status" role="status" aria-label="System status">
          <StatusBadge on={Boolean(serverState?.arduinoConnected)} label="Device"
            value={serverState?.arduinoConnected ? 'Connected' : 'Waiting'} />
          <StatusBadge on={Boolean(serverState?.mqttConnected)} label="MQTT"
            value={serverState?.mqttConnected ? 'Online' : 'Offline'} />
          <StatusBadge on={wsConnected} label="Stream"
            value={wsConnected ? 'Live' : 'Disconnected'} />

          <div className="topbar__divider" aria-hidden="true" />

          <RecordingPill active={session?.active} rows={serverState?.collectedRows} />

          <div className="topbar__meta">
            <span className="meta-label">Last packet</span>
            <span className="meta-val">{loading ? '…' : formatRelative(serverState?.lastDataAt)}</span>
          </div>

          <div className="topbar__meta">
            <span className="meta-label">Session</span>
            <span className="meta-val">{session?.id || '—'}</span>
          </div>

          <button className="btn btn--ghost btn--sm" onClick={() => setSettingsOpen(true)}
            aria-label="Open sensor settings">
            <Settings size={13} aria-hidden="true" />
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* Flash feedback */}
      {flash && (
        <div className={`flash flash--${flash.type}`} role="alert" aria-live="polite">
          {flash.type === 'ok' ? <Zap size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
          <span>{flash.msg}</span>
        </div>
      )}

      {/* ═══ WORKSPACE ════════════════════════════════════════════ */}
      <div className="workspace">

        {/* ─── LEFT SIDEBAR: Session control ─────────────────── */}
        <aside className="sidebar sidebar--left" aria-label="Session controls">

          {/* Collection */}
          <div className="panel">
            <SectionLabel icon={Cable}>Data Collection</SectionLabel>

            <div className="form-field">
              <label className="form-label" htmlFor="session-name">Session name</label>
              <input id="session-name" className="form-input" value={sessionName}
                onChange={e => setSessionName(e.target.value)}
                placeholder="experiment_01" disabled={session?.active} />
            </div>

            <div className="panel-divider" />

            <SectionLabel icon={Sliders}>Threshold labeling</SectionLabel>

            <label className="toggle-row">
              <input type="checkbox" checked={thresholdEnabled}
                onChange={e => setThresholdEnabled(e.target.checked)} disabled={session?.active} />
              <span>Auto-label normal / anomaly</span>
            </label>

            {thresholdEnabled && (
              <>
                <div className="form-field">
                  <label className="form-label" htmlFor="th-sensor">Sensor channel</label>
                  <select id="th-sensor" className="form-input" value={thresholdSensor}
                    onChange={e => setThresholdSensor(e.target.value)}
                    disabled={session?.active || !sensorKeys.length}>
                    {!sensorKeys.length && <option value="">Awaiting data…</option>}
                    {sensorKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>

                <div className="form-field">
                  <label className="form-label" htmlFor="th-value">Threshold value</label>
                  <input id="th-value" className="form-input" type="number" step="any"
                    value={thresholdValue} onChange={e => setThresholdValue(e.target.value)}
                    placeholder="e.g. 200" disabled={session?.active} />
                </div>

                <label className="toggle-row toggle-row--sub">
                  <input type="checkbox"
                    checked={thresholdNotificationEnabled}
                    onChange={e => setThresholdNotificationEnabled(e.target.checked)}
                    disabled={session?.active || !thresholdReady} />
                  <span>
                    <Bell size={12} aria-hidden="true" />
                    ESP32 buzzer notification
                  </span>
                </label>
                <p className="threshold-help">
                  Opsiyonel: açıkken threshold aşılırsa ESP32 üzerindeki buzzer MQTT config ile uyarı verir.
                </p>

                {thresholdReady && (
                  <div className="threshold-preview" aria-label="Threshold rule summary">
                    <div className="threshold-preview__row">
                      <span className="label-badge label-badge--anomaly">anomaly</span>
                      <span className="th-rule">{thresholdSensor} ≥ {thresholdValue}</span>
                    </div>
                    <div className="threshold-preview__row">
                      <span className="label-badge label-badge--normal">normal</span>
                      <span className="th-rule">{thresholdSensor} &lt; {thresholdValue}</span>
                    </div>
                    <div className="threshold-preview__row">
                      <span className={`notify-badge ${thresholdNotificationEnabled ? 'notify-badge--on' : ''}`}>
                        buzzer {thresholdNotificationEnabled ? 'on' : 'off'}
                      </span>
                      <span className="th-rule">MQTT: {thresholdSensor}/threshold config → ESP32</span>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="panel-divider" />

            <div className="btn-col">
              <button className="btn btn--primary" onClick={startSession}
                disabled={session?.active} aria-label="Start recording session">
                <Play size={14} aria-hidden="true" />
                Start Session
              </button>
              <button className="btn btn--danger" onClick={stopSession}
                disabled={!session?.active} aria-label="Stop recording session">
                <CircleStop size={14} aria-hidden="true" />
                Stop Recording
              </button>
            </div>

            {session?.active && (
              <dl className="session-info" aria-label="Active session details">
                <div className="session-info__row">
                  <dt>Session ID</dt>
                  <dd><code>{session.id}</code></dd>
                </div>
                <div className="session-info__row">
                  <dt>Started</dt>
                  <dd>{formatTime(session.startedAt)}</dd>
                </div>
                <div className="session-info__row">
                  <dt>Rows</dt>
                  <dd className="session-info__count">{(serverState?.collectedRows || 0).toLocaleString()}</dd>
                </div>
              </dl>
            )}
          </div>

          {/* Export */}
          <div className="panel">
            <SectionLabel icon={Download}>Export</SectionLabel>

            <dl className="export-meta" aria-label="Export metadata">
              <div className="export-meta__row"><dt>Format</dt><dd>CSV · UTF-8</dd></div>
              <div className="export-meta__row"><dt>Label column</dt><dd>{hasLabel ? 'Included' : 'None'}</dd></div>
              <div className="export-meta__row"><dt>Session</dt><dd>{session?.id || 'All data'}</dd></div>
              {session?.stoppedAt && (
                <div className="export-meta__row"><dt>Stopped</dt><dd>{formatTime(session.stoppedAt)}</dd></div>
              )}
            </dl>

            <div className="auto-export-box">
              <label className="toggle-row">
                <input type="checkbox"
                  checked={autoExportEnabled || autoExportActive}
                  onChange={e => {
                    const checked = e.target.checked;
                    setAutoExportEnabled(checked);
                    if (!checked && autoExportActive) stopAutoExport();
                  }} />
                <span>Periodic CSV export</span>
              </label>

              {(autoExportEnabled || autoExportActive) && (
                <>
                  <div className="form-field">
                    <label className="form-label" htmlFor="auto-export-interval">Interval</label>
                    <select id="auto-export-interval" className="form-input"
                      value={autoExportPreset}
                      onChange={e => setAutoExportPreset(e.target.value)}
                      disabled={autoExportActive}>
                      {EXPORT_INTERVAL_PRESETS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>

                  {autoExportPreset === 'custom' && (
                    <div className="auto-export-custom">
                      <div className="form-field">
                        <label className="form-label" htmlFor="auto-export-custom-value">Value</label>
                        <input id="auto-export-custom-value" className="form-input" type="number" min="1" step="1"
                          value={autoExportCustomValue}
                          onChange={e => setAutoExportCustomValue(e.target.value)}
                          disabled={autoExportActive} />
                      </div>
                      <div className="form-field">
                        <label className="form-label" htmlFor="auto-export-custom-unit">Unit</label>
                        <select id="auto-export-custom-unit" className="form-input"
                          value={autoExportCustomUnit}
                          onChange={e => setAutoExportCustomUnit(e.target.value)}
                          disabled={autoExportActive}>
                          <option value="second">sn</option>
                          <option value="minute">dk</option>
                          <option value="hour">saat</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="auto-export-summary">
                    <span>Every</span>
                    <strong>{formatDuration(autoExportStatus?.active ? autoExportStatus.intervalMs : autoExportIntervalMs)}</strong>
                    <span>· {session?.id ? 'current session' : 'all data'}</span>
                  </div>

                  {autoExportStatus?.lastFile && (
                    <a className="auto-export-link" href={autoExportDownloadUrl} download>
                      Last file: {autoExportStatus.lastFile}
                    </a>
                  )}

                  <dl className="auto-export-status" aria-label="Auto export status">
                    <div><dt>Status</dt><dd>{autoExportActive ? 'Running' : 'Ready'}</dd></div>
                    <div><dt>Last export</dt><dd>{formatDateTime(autoExportStatus?.lastExportAt)}</dd></div>
                    <div><dt>Next export</dt><dd>{formatDateTime(autoExportStatus?.nextExportAt)}</dd></div>
                    <div><dt>Rows</dt><dd>{(autoExportStatus?.lastRowCount || 0).toLocaleString()}</dd></div>
                  </dl>

                  <div className="btn-col">
                    <button className="btn btn--secondary" onClick={autoExportActive ? stopAutoExport : startAutoExport}
                      disabled={autoExportBusy}>
                      <Download size={14} aria-hidden="true" />
                      {autoExportActive ? 'Stop Auto Export' : 'Start Auto Export'}
                    </button>
                    <button className="btn btn--ghost" onClick={runAutoExportNow}
                      disabled={autoExportBusy}>
                      Export Once Now
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="btn-col">
              <button className="btn btn--secondary" onClick={downloadCsv}
                aria-label="Download dataset as CSV">
                <Download size={14} aria-hidden="true" />
                Download CSV
              </button>
              <button className="btn btn--ghost" onClick={clearData}
                aria-label="Clear live data buffer">
                <Eraser size={13} aria-hidden="true" />
                Clear Live Buffer
              </button>
            </div>
          </div>
        </aside>

        {/* ─── CENTER COLUMN: Chart + Table ───────────────────── */}
        <main className="center-col" aria-label="Main content">

          {/* Live chart */}
          <section className="panel chart-panel" aria-label="Live signal chart">
            <div className="chart-panel__header">
              <div>
                <SectionLabel icon={Activity}>Live Signal</SectionLabel>
                <p className="panel-sub">Last {MAX_CHART_POINTS} samples · auto-streaming</p>
              </div>
              <div className="chart-channel-select">
                <label className="form-label" htmlFor="sensor-select">Channel</label>
                <select id="sensor-select" className="form-input form-input--sm"
                  value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)}
                  aria-label="Select sensor channel to display">
                  {!sensorKeys.length && <option value="">Awaiting data…</option>}
                  {sensorKeys.map(k => (
                    <option key={k} value={k}>
                      {sensorSettings[k]?.name || k}{UNIT_MAP[k] ? ` (${UNIT_MAP[k]})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Stats strip */}
            <MetricStrip stats={selStats} unit={unit} sensor={selectedSensor} trend={trend} />

            {/* Chart */}
            <div className="chart-box" aria-label="Signal chart visualization">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="0" horizontal vertical={false}
                      stroke="var(--chart-grid)" />
                    <XAxis dataKey="time" minTickGap={44} tick={<XTick />}
                      axisLine={false} tickLine={false} />
                    <YAxis width={60} tick={<YTick />} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip unit={unit} />}
                      cursor={{ stroke: 'var(--chart-cursor)', strokeWidth: 1 }} />
                    {thresholdNum !== null && thresholdSensor === selectedSensor && (
                      <ReferenceLine y={thresholdNum}
                        stroke="var(--threshold-line)" strokeDasharray="5 3"
                        label={{ value: `threshold ${thresholdNum}`, fill: 'var(--threshold-label)', fontSize: 10, position: 'insideTopRight' }} />
                    )}
                    <Line type="monotone" dataKey="value" dot={false} strokeWidth={1.5}
                      stroke="var(--accent)" isAnimationActive={false} strokeLinecap="round" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={Wifi} title="Awaiting telemetry"
                  sub="Chart populates when ESP32 publishes to MQTT" />
              )}
            </div>
          </section>

          {/* Data table */}
          <section className="panel table-panel" aria-label="Collected data records">
            <div className="table-panel__header">
              <div>
                <SectionLabel icon={Database}>Collected Records</SectionLabel>
                <p className="panel-sub">Last 50 rows · most recent first</p>
              </div>
              <div className="table-filters">
                {hasLabel && (
                  <div className="filter-group">
                    <label className="form-label" htmlFor="label-filter">Label</label>
                    <select id="label-filter" className="form-input form-input--sm"
                      value={tableLabelFilter} onChange={e => setTableLabelFilter(e.target.value)}>
                      <option value="all">All labels</option>
                      {availableLabels.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                )}
                <div className="filter-group">
                  <label className="form-label" htmlFor="session-filter">Session</label>
                  <select id="session-filter" className="form-input form-input--sm"
                    value={tableSessionFilter} onChange={e => setTableSessionFilter(e.target.value)}>
                    <option value="all">All sessions</option>
                    {availableSessions.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="table-scroll" role="region" aria-label="Data table" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Session</th>
                    {hasLabel && <th scope="col">Label</th>}
                    {sensorKeys.map(k => (
                      <th key={k} scope="col">
                        {sensorSettings[k]?.name || k}
                        {(UNIT_MAP[k] || sensorSettings[k]?.unit) ? ` (${UNIT_MAP[k] || sensorSettings[k]?.unit})` : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!tableRows.length ? (
                    <tr><td colSpan={2 + (hasLabel ? 1 : 0) + sensorKeys.length} className="table-empty">
                      No records collected
                    </td></tr>
                  ) : tableRows.map((row, i) => (
                    <tr key={`${row.timestamp}-${i}`}>
                      <td className="td-mono">{formatTime(row.timestamp)}</td>
                      <td className="td-mono td-muted">{row.session_id}</td>
                      {hasLabel && <td><LabelBadge label={row.label} /></td>}
                      {sensorKeys.map(k => (
                        <td key={k} className="td-mono">
                          {typeof row[k] === 'number' ? formatNum(row[k]) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>

        {/* ─── RIGHT SIDEBAR: Devices + Sensor channels ─────── */}
        <aside className="sidebar sidebar--right" aria-label="Sensor channels">

          {/* Devices */}
          <div className="panel">
            <SectionLabel icon={Server}>Devices</SectionLabel>
            {!Object.keys(serverState?.devices || {}).length ? (
              <EmptyState icon={WifiOff} title="No devices" sub="Waiting for MQTT status" />
            ) : (
              <div className="device-list">
                {Object.values(serverState.devices).map(d => (
                  <div className="device-card" key={d.id}>
                    <div className="device-card__top">
                      <ConnDot on={d.status === 'online'} />
                      <strong className="device-card__id">{d.id}</strong>
                      <span className={`device-status ${d.status === 'online' ? 'device-status--on' : ''}`}>
                        {d.status}
                      </span>
                    </div>
                    {d.sensor_keys?.length > 0 && (
                      <div className="device-chips">
                        {d.sensor_keys.map(k => <span className="sensor-chip" key={k}>{k}</span>)}
                      </div>
                    )}
                    <span className="device-card__when">
                      {formatRelative(d.lastTelemetryAt || d.lastStatusAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sensor cards */}
          <div className="panel panel--flex">
            <SectionLabel icon={Radio}>Sensor Channels</SectionLabel>
            {!sensorKeys.length ? (
              <EmptyState icon={Activity} title="No channels" sub="First packet will populate channels" />
            ) : (
              <div className="sensor-grid">
                {sensorKeys.map(key => {
                  const stats = computeStats(rows, key);
                  const cardUnit = UNIT_MAP[key] || sensorSettings[key]?.unit || '';
                  const active = key === selectedSensor;
                  const range = (stats.max ?? 0) - (stats.min ?? 0);
                  const fill = range > 0 && stats.last != null
                    ? Math.max(0, Math.min(100, ((stats.last - (stats.min ?? 0)) / range) * 100))
                    : 50;

                  return (
                    <div key={key}
                      className={`sensor-card ${active ? 'sensor-card--active' : ''}`}
                      onClick={() => setSelectedSensor(key)}
                      role="button" tabIndex={0}
                      aria-pressed={active}
                      aria-label={`${sensorSettings[key]?.name || key} sensor — click to view chart`}
                      onKeyDown={e => e.key === 'Enter' && setSelectedSensor(key)}>
                      <div className="sensor-card__top">
                        <span className="sensor-card__key">{sensorSettings[key]?.name || key}</span>
                        {cardUnit && <span className="sensor-card__unit">{cardUnit}</span>}
                      </div>
                      <div className="sensor-card__val" aria-label={`Current value: ${formatNum(stats.last)} ${cardUnit}`}>
                        {formatNum(stats.last)}
                      </div>
                      <div className="sensor-card__bar" aria-hidden="true">
                        <div className="sensor-card__bar-fill" style={{ width: `${fill}%` }} />
                      </div>
                      <div className="sensor-card__stats">
                        <span><span className="sc-label">avg</span>{formatNum(stats.avg)}</span>
                        <span><span className="sc-label">min</span>{formatNum(stats.min)}</span>
                        <span><span className="sc-label">max</span>{formatNum(stats.max)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ═══ SETTINGS MODAL ═══════════════════════════════════════ */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}
          role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal__header">
              <div>
                <h2 id="settings-title" className="modal__title">Sensor Settings</h2>
                <p className="panel-sub">Display customisation — raw keys are preserved in InfluxDB</p>
              </div>
              <button className="btn btn--ghost btn--sm btn--icon" onClick={() => setSettingsOpen(false)}
                aria-label="Close settings">
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {!sensorKeys.length ? (
              <p className="panel-sub" style={{ marginTop: '12px' }}>No sensor data yet — settings available after first packet.</p>
            ) : (
              <div className="settings-list" role="list">
                <div className="settings-list__header" role="row" aria-hidden="true">
                  <span>Key</span><span>Display name</span><span>Unit</span>
                </div>
                {sensorKeys.map(key => (
                  <div className="settings-row" key={key} role="listitem">
                    <code className="settings-row__key">{key}</code>
                    <input className="form-input" placeholder="Display name"
                      value={sensorSettings[key]?.name || ''}
                      onChange={e => updateSetting(key, { name: e.target.value })}
                      aria-label={`Display name for ${key}`} />
                    <input className="form-input" placeholder="Unit"
                      value={sensorSettings[key]?.unit || UNIT_MAP[key] || ''}
                      onChange={e => updateSetting(key, { unit: e.target.value })}
                      aria-label={`Unit for ${key}`} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}