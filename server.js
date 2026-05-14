const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const {
  initDb,
  saveIncident,
  addEvent,
  addTranscript,
  addCallMessage,
  addDispatchUpdate,
  loadActiveIncidents,
  dbPath
} = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const activeIncidents = new Map();
const dispatchTimers = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/incidents", (req, res) => {
  res.json(Array.from(activeIncidents.values()));
});

io.on("connection", (socket) => {
  socket.emit("incidents:snapshot", Array.from(activeIncidents.values()));

  socket.on("caller:start", async (incident) => {
    const id = incident.id || socket.id;
    const now = new Date().toISOString();
    const notes = incident.notes || "";
    const emergencyType = detectEmergencyType(`${incident.emergencyType || ""} ${notes}`);
    const priority = calculatePriority(`${emergencyType} ${notes}`);
    const startedIncident = {
      id,
      callerSocketId: socket.id,
      status: "active",
      priority,
      emergencyType,
      callerName: incident.callerName || "Unknown caller",
      callerPhone: incident.callerPhone || "Not provided",
      notes,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      location: null,
      transcript: [],
      messages: [],
      timeline: [],
      guidance: buildRuleBasedGuidance(notes, emergencyType),
      facilities: [],
      facilitiesUpdatedAt: null,
      dispatch: null
    };

    addTimeline(startedIncident, "call_started", "Emergency request received", { emergencyType, priority });
    activeIncidents.set(id, startedIncident);
    socket.join(id);
    await persistIncident(startedIncident);
    io.emit("incident:created", startedIncident);
  });

  socket.on("caller:location", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident) return;

    const hadLocation = Boolean(incident.location);
    const updatedIncident = {
      ...incident,
      updatedAt: new Date().toISOString(),
      location: {
        lat: Number(payload.lat),
        lng: Number(payload.lng),
        accuracy: Number(payload.accuracy || 0),
        speed: payload.speed === null ? null : Number(payload.speed || 0),
        heading: payload.heading === null ? null : Number(payload.heading || 0),
        timestamp: payload.timestamp || new Date().toISOString()
      }
    };

    if (!hadLocation) {
      addTimeline(updatedIncident, "gps_received", "Caller GPS location received", updatedIncident.location);
    }

    activeIncidents.set(payload.id, updatedIncident);
    await persistIncident(updatedIncident);
    io.emit("incident:updated", updatedIncident);

    maybeUpdateNearbyFacilities(payload.id, updatedIncident);
  });

  socket.on("caller:transcript", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident || !payload.text) return;

    const text = String(payload.text).slice(0, 600);
    const entry = {
      speaker: "caller",
      text,
      isFinal: Boolean(payload.isFinal),
      timestamp: new Date().toISOString()
    };

    const transcript = [...(incident.transcript || []), entry].slice(-50);
    const transcriptText = transcript.map((item) => item.text).join(" ");
    const emergencyType = detectEmergencyType(`${incident.emergencyType} ${transcriptText}`);
    const priority = calculatePriority(`${incident.notes} ${transcriptText}`);
    const guidance = await buildAiGuidance(transcriptText, { ...incident, emergencyType });

    const updatedIncident = {
      ...incident,
      emergencyType,
      priority,
      transcript,
      guidance,
      updatedAt: new Date().toISOString()
    };

    addTimeline(updatedIncident, "transcript_updated", "Caller speech transcript updated", { text });
    activeIncidents.set(payload.id, updatedIncident);
    await addTranscript(payload.id, "caller", text, payload.isFinal);
    await persistIncident(updatedIncident);
    io.emit("incident:updated", updatedIncident);
  });

  socket.on("dispatcher:message", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident || !payload.text) return;

    const message = {
      sender: "dispatcher",
      text: String(payload.text).slice(0, 500),
      speak: Boolean(payload.speak),
      timestamp: new Date().toISOString()
    };
    const updatedIncident = {
      ...incident,
      messages: [...(incident.messages || []), message].slice(-50),
      updatedAt: new Date().toISOString()
    };

    addTimeline(updatedIncident, "dispatcher_message", "Dispatcher sent a caller message", { text: message.text });
    activeIncidents.set(payload.id, updatedIncident);
    await addCallMessage(payload.id, "dispatcher", message.text, message.speak);
    await addTranscript(payload.id, "dispatcher", message.text, true);
    await persistIncident(updatedIncident);
    io.to(payload.id).emit("dispatcher:message", message);
    io.emit("incident:updated", updatedIncident);
  });

  socket.on("caller:message", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident || !payload.text) return;

    const message = {
      sender: "caller",
      text: String(payload.text).slice(0, 500),
      speak: false,
      timestamp: new Date().toISOString()
    };
    const updatedIncident = {
      ...incident,
      messages: [...(incident.messages || []), message].slice(-50),
      updatedAt: new Date().toISOString()
    };

    addTimeline(updatedIncident, "caller_message", "Caller sent a text message", { text: message.text });
    activeIncidents.set(payload.id, updatedIncident);
    await addCallMessage(payload.id, "caller", message.text, false);
    await persistIncident(updatedIncident);
    io.emit("incident:updated", updatedIncident);
  });

  socket.on("dispatch:start", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident?.location) return;
    await startSimulatedDispatch(payload.id, payload.unitType || getDefaultUnitType(incident));
  });

  socket.on("dispatch:status", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident?.dispatch || !payload.status) return;

    const dispatch = {
      ...incident.dispatch,
      status: String(payload.status).slice(0, 40),
      updatedAt: new Date().toISOString()
    };
    await updateIncidentDispatch(payload.id, dispatch, `Dispatch status changed to ${dispatch.status}`);
  });

  socket.on("incident:resolve", async (id) => {
    const incident = activeIncidents.get(id);
    if (!incident) return;

    const resolvedIncident = {
      ...incident,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    addTimeline(resolvedIncident, "incident_resolved", "Incident marked resolved");
    activeIncidents.set(id, resolvedIncident);
    await persistIncident(resolvedIncident);
    io.emit("incident:updated", resolvedIncident);

    setTimeout(() => {
      stopDispatchTimer(id);
      activeIncidents.delete(id);
      io.emit("incident:removed", id);
    }, 5000);
  });

  socket.on("disconnect", async () => {
    for (const [id, incident] of activeIncidents.entries()) {
      if (incident.callerSocketId === socket.id && incident.status === "active") {
        const disconnectedIncident = {
          ...incident,
          status: "connection lost",
          updatedAt: new Date().toISOString()
        };
        addTimeline(disconnectedIncident, "connection_lost", "Caller browser disconnected");
        activeIncidents.set(id, disconnectedIncident);
        await persistIncident(disconnectedIncident);
        io.emit("incident:updated", disconnectedIncident);
      }
    }
  });
});

startServer();

async function startServer() {
  await initDb();
  const restoredIncidents = await loadActiveIncidents();
  restoredIncidents.forEach((incident) => activeIncidents.set(incident.id, incident));

  server.listen(PORT, () => {
    console.log(`NYC emergency dashboard running at http://localhost:${PORT}`);
    console.log(`Responder dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`SQLite database: ${dbPath}`);
  });
}

async function persistIncident(incident) {
  await saveIncident(incident);
}

function addTimeline(incident, type, message, metadata = {}) {
  const event = {
    type,
    message,
    metadata,
    timestamp: new Date().toISOString()
  };
  incident.timeline = [...(incident.timeline || []), event].slice(-100);
  addEvent(incident.id, type, message, metadata).catch((error) => {
    console.warn("Timeline save failed:", error.message);
  });
}

async function maybeUpdateNearbyFacilities(id, incident) {
  const lastUpdated = incident.facilitiesUpdatedAt ? Date.parse(incident.facilitiesUpdatedAt) : 0;
  if (Date.now() - lastUpdated < 60000) return;

  const facilities = await findNearbyFacilities(incident.location.lat, incident.location.lng);
  const latestIncident = activeIncidents.get(id);
  if (!latestIncident) return;

  const updatedIncident = {
    ...latestIncident,
    facilities,
    facilitiesUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  addTimeline(updatedIncident, "facilities_updated", "Nearby emergency facilities updated", { count: facilities.length });
  activeIncidents.set(id, updatedIncident);
  await persistIncident(updatedIncident);
  io.emit("incident:updated", updatedIncident);
}

async function findNearbyFacilities(lat, lng) {
  const radiusMeters = 3000;
  const query = `
    [out:json][timeout:10];
    (
      node["amenity"="police"](around:${radiusMeters},${lat},${lng});
      way["amenity"="police"](around:${radiusMeters},${lat},${lng});
      relation["amenity"="police"](around:${radiusMeters},${lat},${lng});
      node["amenity"="fire_station"](around:${radiusMeters},${lat},${lng});
      way["amenity"="fire_station"](around:${radiusMeters},${lat},${lng});
      relation["amenity"="fire_station"](around:${radiusMeters},${lat},${lng});
      node["amenity"="hospital"](around:${radiusMeters},${lat},${lng});
      way["amenity"="hospital"](around:${radiusMeters},${lat},${lng});
      relation["amenity"="hospital"](around:${radiusMeters},${lat},${lng});
    );
    out center 20;
  `;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query })
    });

    if (!response.ok) throw new Error(`Overpass returned ${response.status}`);

    const data = await response.json();
    return data.elements
      .map((place) => {
        const placeLat = place.lat || place.center?.lat;
        const placeLng = place.lon || place.center?.lon;
        if (!placeLat || !placeLng) return null;

        const type = place.tags?.amenity || "emergency";
        return {
          id: `${place.type}-${place.id}`,
          name: place.tags?.name || formatFacilityType(type),
          type,
          lat: placeLat,
          lng: placeLng,
          distanceMeters: getDistanceMeters(lat, lng, placeLat, placeLng)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 10);
  } catch (error) {
    console.warn("Nearby facility lookup failed:", error.message);
    return [];
  }
}

async function buildAiGuidance(transcriptText, incident) {
  if (!process.env.OPENAI_API_KEY) {
    return buildRuleBasedGuidance(transcriptText, incident.emergencyType);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "You assist a simulated emergency dispatcher. Return concise JSON only with keys priority, summary, recommendedUnit, questions, actions, and risks. Do not provide medical treatment instructions beyond basic safety prompts like move away from immediate danger if safe."
          },
          {
            role: "user",
            content: JSON.stringify({
              emergencyType: incident.emergencyType,
              notes: incident.notes,
              transcript: transcriptText
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "dispatch_guidance",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                priority: { type: "string" },
                summary: { type: "string" },
                recommendedUnit: { type: "string" },
                questions: { type: "array", items: { type: "string" } },
                actions: { type: "array", items: { type: "string" } },
                risks: { type: "array", items: { type: "string" } }
              },
              required: ["priority", "summary", "recommendedUnit", "questions", "actions", "risks"]
            }
          }
        }
      })
    });

    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);

    const data = await response.json();
    return JSON.parse(getResponseText(data));
  } catch (error) {
    console.warn("AI guidance failed:", error.message);
    return buildRuleBasedGuidance(transcriptText, incident.emergencyType);
  }
}

function getResponseText(data) {
  if (data.output_text) return data.output_text;
  const message = data.output
    ?.flatMap((item) => item.content || [])
    ?.find((content) => content.type === "output_text" || content.text);
  return message?.text || "{}";
}

function buildRuleBasedGuidance(text, emergencyType = "Medical") {
  const priority = calculatePriority(`${emergencyType} ${text}`);
  return {
    priority,
    summary: text ? summarizeText(text) : "Waiting for caller transcript.",
    recommendedUnit: getRecommendedUnit(emergencyType, text),
    questions: [
      "Confirm exact location and nearest landmark.",
      "Ask if the caller is in immediate danger.",
      "Ask how many people need help.",
      "Confirm whether the caller can safely stay on the line."
    ],
    actions: [
      "Keep the caller connected and continue location tracking.",
      "Verify callback number and incident type.",
      "Review nearest emergency facilities for dispatch planning.",
      "Send clear caller instructions through the two-way channel."
    ],
    risks: getRisks(text, emergencyType)
  };
}

function calculatePriority(text = "") {
  const lower = text.toLowerCase();
  const critical = ["unconscious", "not breathing", "shooting", "stabbed", "trapped", "explosion"];
  const high = ["fire", "weapon", "bleeding", "chest pain", "attack", "smoke", "crash"];
  const medium = ["injury", "hurt", "accident", "fall", "sick"];

  if (critical.some((word) => lower.includes(word))) return "Critical";
  if (high.some((word) => lower.includes(word))) return "High";
  if (medium.some((word) => lower.includes(word))) return "Medium";
  return "Low";
}

function detectEmergencyType(text = "") {
  const lower = text.toLowerCase();
  if (lower.includes("fire") || lower.includes("smoke") || lower.includes("explosion")) return "Fire";
  if (lower.includes("weapon") || lower.includes("attack") || lower.includes("break in") || lower.includes("police")) return "Police";
  if (lower.includes("crash") || lower.includes("accident") || lower.includes("traffic")) return "Traffic accident";
  if (lower.includes("other")) return "Other";
  return "Medical";
}

function getRecommendedUnit(emergencyType, text = "") {
  const lower = `${emergencyType} ${text}`.toLowerCase();
  if (lower.includes("fire") || lower.includes("smoke")) return "Fire + EMS";
  if (lower.includes("weapon") || lower.includes("attack")) return "Police + EMS standby";
  if (lower.includes("crash") || lower.includes("accident")) return "EMS + Police";
  return "EMS";
}

function getRisks(text, emergencyType) {
  const lower = `${emergencyType} ${text}`.toLowerCase();
  return [
    lower.includes("fire") || lower.includes("smoke") ? "Fire or smoke exposure reported." : "No fire keywords detected yet.",
    lower.includes("weapon") || lower.includes("attack") ? "Possible safety threat reported." : "No weapon or violence keywords detected yet.",
    lower.includes("unconscious") || lower.includes("bleeding") || lower.includes("breathing") ? "Possible serious medical emergency reported." : "Medical severity unclear."
  ];
}

function summarizeText(text) {
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function formatFacilityType(type) {
  return type.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const toRadians = (value) => value * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function startSimulatedDispatch(id, unitType) {
  stopDispatchTimer(id);

  const incident = activeIncidents.get(id);
  if (!incident?.location) return;

  const start = chooseDispatchStart(incident, unitType);
  const destination = { lat: incident.location.lat, lng: incident.location.lng };
  const totalDistanceMeters = getDistanceMeters(start.lat, start.lng, destination.lat, destination.lng);

  const dispatch = {
    id: `unit-${Date.now()}`,
    unitType,
    unitName: getUnitName(unitType),
    status: "Assigned",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    originName: start.name,
    progress: 0,
    totalDistanceMeters,
    remainingMeters: totalDistanceMeters,
    etaMinutes: Math.max(1, Math.ceil(totalDistanceMeters / 500)),
    location: { lat: start.lat, lng: start.lng },
    destination
  };

  await updateIncidentDispatch(id, dispatch, `${dispatch.unitName} assigned`);

  const timer = setInterval(async () => {
    const latest = activeIncidents.get(id);
    if (!latest?.dispatch || latest.status === "resolved") {
      stopDispatchTimer(id);
      return;
    }

    const nextProgress = Math.min(1, latest.dispatch.progress + 0.08);
    const nextLocation = interpolateLocation(start, destination, nextProgress);
    const remainingMeters = getDistanceMeters(nextLocation.lat, nextLocation.lng, destination.lat, destination.lng);
    const status = nextProgress >= 1 ? "Arrived" : latest.dispatch.status === "Assigned" ? "En route" : latest.dispatch.status;
    const nextDispatch = {
      ...latest.dispatch,
      status,
      updatedAt: new Date().toISOString(),
      progress: nextProgress,
      remainingMeters,
      etaMinutes: nextProgress >= 1 ? 0 : Math.max(1, Math.ceil(remainingMeters / 500)),
      location: nextLocation
    };

    await updateIncidentDispatch(id, nextDispatch, `${nextDispatch.unitName} ${status.toLowerCase()}`);
    if (nextProgress >= 1) stopDispatchTimer(id);
  }, 2500);

  dispatchTimers.set(id, timer);
}

async function updateIncidentDispatch(id, dispatch, eventMessage = "Dispatch updated") {
  const incident = activeIncidents.get(id);
  if (!incident) return;

  const updatedIncident = {
    ...incident,
    dispatch,
    updatedAt: new Date().toISOString()
  };

  addTimeline(updatedIncident, "dispatch_update", eventMessage, dispatch);
  activeIncidents.set(id, updatedIncident);
  await addDispatchUpdate(id, dispatch);
  await persistIncident(updatedIncident);
  io.emit("incident:updated", updatedIncident);
}

function stopDispatchTimer(id) {
  const timer = dispatchTimers.get(id);
  if (timer) clearInterval(timer);
  dispatchTimers.delete(id);
}

function chooseDispatchStart(incident, unitType) {
  const preferredType = getFacilityTypeForUnit(unitType);
  const facility = (incident.facilities || []).find((item) => item.type === preferredType)
    || (incident.facilities || [])[0];
  if (facility) return { name: facility.name, lat: facility.lat, lng: facility.lng };
  return {
    name: `${getUnitName(unitType)} staging point`,
    lat: incident.location.lat + 0.012,
    lng: incident.location.lng - 0.012
  };
}

function getDefaultUnitType(incident) {
  const type = incident.emergencyType.toLowerCase();
  if (type.includes("fire")) return "fire";
  if (type.includes("police")) return "police";
  return "ems";
}

function getFacilityTypeForUnit(unitType) {
  return { ems: "hospital", fire: "fire_station", police: "police" }[unitType] || "hospital";
}

function getUnitName(unitType) {
  return { ems: "EMS Unit", fire: "Fire Unit", police: "Police Unit" }[unitType] || "Response Unit";
}

function interpolateLocation(start, end, progress) {
  return {
    lat: start.lat + (end.lat - start.lat) * progress,
    lng: start.lng + (end.lng - start.lng) * progress
  };
}
