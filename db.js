const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "emergency-dashboard.sqlite");

let db;

async function initDb() {
  fs.mkdirSync(dataDir, { recursive: true });

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      emergency_type TEXT NOT NULL,
      caller_name TEXT,
      caller_phone TEXT,
      notes TEXT,
      caller_socket_id TEXT,
      location_json TEXT,
      guidance_json TEXT,
      facilities_json TEXT,
      dispatch_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      speak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dispatch_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      status TEXT NOT NULL,
      dispatch_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error("Database has not been initialized");
  return db;
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function saveIncident(incident) {
  const database = getDb();
  await database.run(
    `
      INSERT INTO incidents (
        id, status, priority, emergency_type, caller_name, caller_phone, notes,
        caller_socket_id, location_json, guidance_json, facilities_json, dispatch_json,
        created_at, updated_at, resolved_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        priority = excluded.priority,
        emergency_type = excluded.emergency_type,
        caller_name = excluded.caller_name,
        caller_phone = excluded.caller_phone,
        notes = excluded.notes,
        caller_socket_id = excluded.caller_socket_id,
        location_json = excluded.location_json,
        guidance_json = excluded.guidance_json,
        facilities_json = excluded.facilities_json,
        dispatch_json = excluded.dispatch_json,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `,
    [
      incident.id,
      incident.status,
      incident.priority,
      incident.emergencyType,
      incident.callerName,
      incident.callerPhone,
      incident.notes,
      incident.callerSocketId,
      toJson(incident.location),
      toJson(incident.guidance),
      toJson(incident.facilities || []),
      toJson(incident.dispatch),
      incident.createdAt,
      incident.updatedAt,
      incident.resolvedAt || null
    ]
  );
}

async function addEvent(incidentId, type, message, metadata = {}) {
  await getDb().run(
    "INSERT INTO incident_events (incident_id, type, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [incidentId, type, message, toJson(metadata), new Date().toISOString()]
  );
}

async function addTranscript(incidentId, speaker, text, isFinal = true) {
  await getDb().run(
    "INSERT INTO transcripts (incident_id, speaker, text, is_final, created_at) VALUES (?, ?, ?, ?, ?)",
    [incidentId, speaker, text, isFinal ? 1 : 0, new Date().toISOString()]
  );
}

async function addCallMessage(incidentId, sender, text, speak = false) {
  await getDb().run(
    "INSERT INTO call_messages (incident_id, sender, text, speak, created_at) VALUES (?, ?, ?, ?, ?)",
    [incidentId, sender, text, speak ? 1 : 0, new Date().toISOString()]
  );
}

async function addDispatchUpdate(incidentId, dispatch) {
  await getDb().run(
    "INSERT INTO dispatch_updates (incident_id, unit_type, status, dispatch_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [incidentId, dispatch.unitType, dispatch.status, toJson(dispatch), new Date().toISOString()]
  );
}

async function loadActiveIncidents() {
  const rows = await getDb().all("SELECT * FROM incidents WHERE status != 'resolved' ORDER BY updated_at DESC");
  const incidents = [];

  for (const row of rows) {
    const [events, transcripts, messages] = await Promise.all([
      getDb().all("SELECT type, message, metadata_json, created_at FROM incident_events WHERE incident_id = ? ORDER BY id ASC", row.id),
      getDb().all("SELECT speaker, text, is_final, created_at FROM transcripts WHERE incident_id = ? ORDER BY id ASC", row.id),
      getDb().all("SELECT sender, text, speak, created_at FROM call_messages WHERE incident_id = ? ORDER BY id ASC", row.id)
    ]);

    incidents.push({
      id: row.id,
      callerSocketId: row.caller_socket_id,
      status: row.status,
      priority: row.priority,
      emergencyType: row.emergency_type,
      callerName: row.caller_name,
      callerPhone: row.caller_phone,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      location: fromJson(row.location_json, null),
      guidance: fromJson(row.guidance_json, null),
      facilities: fromJson(row.facilities_json, []),
      dispatch: fromJson(row.dispatch_json, null),
      timeline: events.map((event) => ({
        type: event.type,
        message: event.message,
        metadata: fromJson(event.metadata_json, {}),
        timestamp: event.created_at
      })),
      transcript: transcripts.map((entry) => ({
        speaker: entry.speaker,
        text: entry.text,
        isFinal: Boolean(entry.is_final),
        timestamp: entry.created_at
      })),
      messages: messages.map((message) => ({
        sender: message.sender,
        text: message.text,
        speak: Boolean(message.speak),
        timestamp: message.created_at
      }))
    });
  }

  return incidents;
}

module.exports = {
  initDb,
  saveIncident,
  addEvent,
  addTranscript,
  addCallMessage,
  addDispatchUpdate,
  loadActiveIncidents,
  dbPath
};
