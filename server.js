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
  resetDemoData,
  loadActiveIncidents,
  loadIncidentHistory,
  loadIncidentReport,
  loadOperationsStats,
  dbPath
} = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const activeIncidents = new Map();
const dispatchTimers = new Map();
const busyFacilities = new Map();

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

app.get("/api/incidents/history", async (req, res) => {
  try {
    res.json(await loadIncidentHistory(req.query.limit));
  } catch (error) {
    console.error("History load failed:", error);
    res.status(500).json({ error: "Unable to load incident history" });
  }
});

app.get("/api/incidents/:id/report", async (req, res) => {
  try {
    const report = await loadIncidentReport(req.params.id);
    if (!report) {
      res.status(404).json({ error: "Incident not found" });
      return;
    }
    res.json(report);
  } catch (error) {
    console.error("Report load failed:", error);
    res.status(500).json({ error: "Unable to load incident report" });
  }
});

app.get("/api/operations/stats", async (req, res) => {
  try {
    res.json(await loadOperationsStats());
  } catch (error) {
    console.error("Stats load failed:", error);
    res.status(500).json({ error: "Unable to load operations stats" });
  }
});

app.post("/api/demo/reset", async (req, res) => {
  try {
    activeIncidents.clear();
    dispatchTimers.forEach((timer) => clearInterval(timer));
    dispatchTimers.clear();
    busyFacilities.clear();
    await resetDemoData();
    io.emit("incidents:snapshot", []);
    res.json({ ok: true });
  } catch (error) {
    console.error("Demo reset failed:", error);
    res.status(500).json({ error: "Unable to reset demo data" });
  }
});

app.post("/api/demo/seed", async (req, res) => {
  try {
    const seeded = [];
    for (const scenario of getSeedScenarios()) {
      const incident = await createScenarioIncident(scenario, `seed-${Date.now()}-${seeded.length}`);
      seeded.push(incident);
    }
    res.json({ ok: true, count: seeded.length, incidents: seeded });
  } catch (error) {
    console.error("Demo seed failed:", error);
    res.status(500).json({ error: "Unable to seed demo incidents" });
  }
});

app.post("/api/incidents/:id/reopen", async (req, res) => {
  const incident = activeIncidents.get(req.params.id) || await loadIncidentReport(req.params.id);
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }
  const reopened = {
    ...incident,
    status: "accepted",
    resolvedAt: null,
    updatedAt: new Date().toISOString()
  };
  addTimeline(reopened, "incident_reopened", "Incident reopened by operator");
  activeIncidents.set(reopened.id, reopened);
  await persistIncident(reopened);
  io.emit("incident:updated", reopened);
  res.json(reopened);
});

io.on("connection", (socket) => {
  socket.emit("incidents:snapshot", Array.from(activeIncidents.values()));

  socket.on("caller:start", async (incident) => {
    const id = incident.id || socket.id;
    const now = new Date().toISOString();
    const notes = incident.notes || "";
    const landmark = String(incident.landmark || "").slice(0, 220);
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
      callerLandmark: landmark,
      verifiedLocation: landmark,
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
      dispatch: null,
      dispatches: []
    };

    addTimeline(startedIncident, "call_started", "Emergency request received", { emergencyType, priority, landmark });
    activeIncidents.set(id, startedIncident);
    socket.join(id);
    socket.join(`call:${id}`);
    await persistIncident(startedIncident);
    io.emit("incident:created", startedIncident);
  });

  socket.on("scenario:create", async () => {
    const scenarios = getSeedScenarios();
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    await createScenarioIncident(scenario, `scenario-${Date.now()}`);
  });

  socket.on("dispatcher:join", (id) => {
    if (!activeIncidents.has(id)) return;
    socket.join(id);
  });

  socket.on("incident:accept", async (payload) => {
    const id = typeof payload === "string" ? payload : payload?.id;
    const incident = activeIncidents.get(id);
    if (!incident) return;

    const acceptedIncident = {
      ...incident,
      status: "accepted",
      assignedOperator: payload?.operator || "Dashboard operator",
      updatedAt: new Date().toISOString()
    };

    addTimeline(acceptedIncident, "incident_accepted", `${acceptedIncident.assignedOperator} accepted the request`);
    activeIncidents.set(id, acceptedIncident);
    await persistIncident(acceptedIncident);
    io.emit("incident:updated", acceptedIncident);
  });

  socket.on("incident:update-details", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident) return;

    const notes = String(payload.notes ?? incident.notes ?? "").slice(0, 1000);
    const emergencyType = detectEmergencyType(`${payload.emergencyType || incident.emergencyType} ${notes}`);
    const priority = payload.priority || calculatePriority(`${emergencyType} ${notes}`);
    const updatedIncident = {
      ...incident,
      callerName: String(payload.callerName || incident.callerName || "Unknown caller").slice(0, 120),
      callerPhone: String(payload.callerPhone || incident.callerPhone || "Not provided").slice(0, 80),
      emergencyType,
      priority,
      notes,
      operatorNotes: String(payload.operatorNotes || incident.operatorNotes || "").slice(0, 1000),
      verifiedLocation: String(payload.verifiedLocation || incident.verifiedLocation || "").slice(0, 220),
      updatedAt: new Date().toISOString(),
      guidance: buildRuleBasedGuidance(notes, emergencyType)
    };

    addTimeline(updatedIncident, "details_updated", "Dashboard operator updated request details", {
      emergencyType,
      priority,
      verifiedLocation: updatedIncident.verifiedLocation
    });
    activeIncidents.set(payload.id, updatedIncident);
    await persistIncident(updatedIncident);
    io.emit("incident:updated", updatedIncident);
  });

  socket.on("call:join", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident) return;

    socket.join(`call:${payload.id}`);
    socket.to(`call:${payload.id}`).emit("call:peer-ready", {
      id: payload.id,
      role: payload.role || "operator"
    });
    socket.emit("call:joined", { id: payload.id });
    if (payload.role === "caller") {
      socket.emit("call:peer-ready", { id: payload.id, role: "dispatcher" });
    }

    addTimeline(incident, "call_connected", `${payload.role || "operator"} joined the live audio room`);
    await persistIncident(incident);
    io.emit("incident:updated", incident);
  });

  socket.on("call:request-offer", (payload) => {
    if (!payload.id) return;
    socket.to(`call:${payload.id}`).emit("call:request-offer", {
      id: payload.id,
      role: payload.role || "dispatcher"
    });
  });

  socket.on("call:signal", (payload) => {
    if (!payload.id || !payload.signal) return;
    socket.to(`call:${payload.id}`).emit("call:signal", {
      id: payload.id,
      signal: payload.signal
    });
  });

  socket.on("call:end", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (incident) {
      addTimeline(incident, "call_ended", `${payload.role || "participant"} left the live audio room`);
      await persistIncident(incident);
      io.emit("incident:updated", incident);
    }
    socket.to(`call:${payload.id}`).emit("call:ended", {
      id: payload.id,
      role: payload.role || "participant"
    });
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

  socket.on("operator:log", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident || !payload.message) return;

    const updatedIncident = {
      ...incident,
      updatedAt: new Date().toISOString()
    };

    addTimeline(updatedIncident, "operator_log", String(payload.message).slice(0, 220));
    activeIncidents.set(payload.id, updatedIncident);
    await persistIncident(updatedIncident);
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

  socket.on("caller:landmark", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident || !payload.landmark) return;
    const landmark = String(payload.landmark).slice(0, 220);
    const updatedIncident = {
      ...incident,
      callerLandmark: landmark,
      verifiedLocation: incident.verifiedLocation || landmark,
      updatedAt: new Date().toISOString()
    };
    addTimeline(updatedIncident, "caller_landmark", "Caller shared a nearby landmark", { landmark });
    activeIncidents.set(payload.id, updatedIncident);
    await persistIncident(updatedIncident);
    io.emit("incident:updated", updatedIncident);
  });

  socket.on("dispatch:start", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident?.location) return;
    const result = await startSimulatedDispatch(payload.id, payload.unitType || getDefaultUnitType(incident), payload.origin || null);
    if (!result?.ok) {
      socket.emit("dispatch:error", {
        id: payload.id,
        message: result?.message || "Selected station is not available."
      });
    }
  });

  socket.on("dispatch:status", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if ((!incident?.dispatch && !incident?.dispatches?.length) || !payload.status) return;

    const currentDispatch = payload.dispatchId
      ? (incident.dispatches || []).find((item) => item.id === payload.dispatchId)
      : incident.dispatch;
    if (!currentDispatch) return;
    const dispatch = {
      ...currentDispatch,
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
    releaseIncidentFacility(id);
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
      if (incident.callerSocketId === socket.id && ["active", "accepted"].includes(incident.status)) {
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
  restoredIncidents.forEach((incident) => {
    activeIncidents.set(incident.id, incident);
    (incident.dispatches || [incident.dispatch]).filter(Boolean).forEach((dispatch) => {
      if (dispatch.originFacilityId && !["Arrived", "Cleared"].includes(dispatch.status)) {
        busyFacilities.set(dispatch.originFacilityId, incident.id);
      }
    });
  });

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

function getSeedScenarios() {
  return [
    {
      emergencyType: "Police",
      callerName: "Avery Morgan",
      callerPhone: "(626) 320-0230",
      notes: "Caller reports a domestic dispute and is locked in a bathroom. Possible weapon mentioned.",
      landmark: "Apartment block lobby near the north gate",
      location: { lat: 40.7549, lng: -73.984, accuracy: 34 }
    },
    {
      emergencyType: "Fire",
      callerName: "Riley Chen",
      callerPhone: "(212) 555-0147",
      notes: "Smoke filling apartment hallway. Caller can see flames near stairwell.",
      landmark: "Third floor stairwell, east side",
      location: { lat: 40.7306, lng: -73.9866, accuracy: 28 }
    },
    {
      emergencyType: "Traffic accident",
      callerName: "Jordan Lee",
      callerPhone: "(917) 555-0192",
      notes: "Two-car crash with one person bleeding and trapped near intersection.",
      landmark: "Near the traffic signal by the market",
      location: { lat: 40.7061, lng: -74.0086, accuracy: 42 }
    },
    {
      emergencyType: "Medical",
      callerName: "Param Rajput",
      callerPhone: "+91 9302927686",
      notes: "Caller reports chest pain and dizziness near a residential lane.",
      landmark: "Beside the main road shop row",
      location: { lat: 23.18586, lng: 77.45762, accuracy: 80 }
    }
  ];
}

async function createScenarioIncident(scenario, id) {
  const now = new Date().toISOString();
  const emergencyType = detectEmergencyType(`${scenario.emergencyType} ${scenario.notes}`);
  const priority = calculatePriority(`${emergencyType} ${scenario.notes}`);
  const incident = {
    id,
    callerSocketId: null,
    status: "active",
    priority,
    emergencyType,
    callerName: scenario.callerName,
    callerPhone: scenario.callerPhone,
    notes: scenario.notes,
    callerLandmark: scenario.landmark || "",
    verifiedLocation: scenario.landmark || "",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    location: {
      ...scenario.location,
      speed: null,
      heading: null,
      timestamp: now
    },
    transcript: [{
      speaker: "caller",
      text: scenario.notes,
      isFinal: true,
      timestamp: now
    }],
    messages: [],
    timeline: [],
    guidance: buildRuleBasedGuidance(scenario.notes, emergencyType),
    facilities: [],
    facilitiesUpdatedAt: null,
    dispatch: null,
    dispatches: []
  };

  addTimeline(incident, "scenario_created", "Demo incident generated by operator", { emergencyType, priority });
  addTimeline(incident, "gps_received", "Caller GPS location received", incident.location);
  activeIncidents.set(id, incident);
  await addTranscript(id, "caller", scenario.notes, true);
  await persistIncident(incident);
  io.emit("incident:created", incident);
  maybeUpdateNearbyFacilities(id, incident);
  return incident;
}

async function findNearbyFacilities(lat, lng) {
  const radiusMeters = 25000;
  const query = `
    [out:json][timeout:18];
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
          distanceMeters: getDistanceMeters(lat, lng, placeLat, placeLng),
          etaMinutes: estimateEtaMinutes(getDistanceMeters(lat, lng, placeLat, placeLng)),
          available: !busyFacilities.has(`${place.type}-${place.id}`),
          assignedIncidentId: busyFacilities.get(`${place.type}-${place.id}`) || null
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 60);
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

async function startSimulatedDispatch(id, unitType, origin = null) {
  const incident = activeIncidents.get(id);
  if (!incident?.location) return { ok: false, message: "Caller GPS is required before dispatch." };

  if (origin?.facilityId && busyFacilities.has(origin.facilityId) && busyFacilities.get(origin.facilityId) !== id) {
    return { ok: false, message: `${origin.name || "Selected station"} is already assigned to another incident.` };
  }

  const start = chooseDispatchStart(incident, unitType, origin);
  if (start.facilityId) busyFacilities.set(start.facilityId, id);
  const destination = { lat: incident.location.lat, lng: incident.location.lng };
  const totalDistanceMeters = getDistanceMeters(start.lat, start.lng, destination.lat, destination.lng);

  const dispatch = {
    id: `${id}:unit-${Date.now()}-${unitType}`,
    unitType,
    unitName: getUnitName(unitType),
    status: "Assigned",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    originName: start.name,
    originFacilityId: start.facilityId || null,
    stationAvailable: false,
    progress: 0,
    totalDistanceMeters,
    remainingMeters: totalDistanceMeters,
    etaMinutes: estimateEtaMinutes(totalDistanceMeters),
    location: { lat: start.lat, lng: start.lng },
    destination
  };

  await updateIncidentDispatch(id, dispatch, `${dispatch.unitName} assigned`);

  const timer = setInterval(async () => {
    const latest = activeIncidents.get(id);
    const latestDispatch = (latest?.dispatches || []).find((item) => item.id === dispatch.id) || latest?.dispatch;
    if (!latestDispatch || latest.status === "resolved") {
      stopDispatchTimer(dispatch.id);
      return;
    }

    const nextProgress = Math.min(1, latestDispatch.progress + 0.08);
    const nextLocation = interpolateLocation(start, destination, nextProgress);
    const remainingMeters = getDistanceMeters(nextLocation.lat, nextLocation.lng, destination.lat, destination.lng);
    const status = nextProgress >= 1 ? "Arrived" : latestDispatch.status === "Assigned" ? "En route" : latestDispatch.status;
    const nextDispatch = {
      ...latestDispatch,
      status,
      updatedAt: new Date().toISOString(),
      progress: nextProgress,
      remainingMeters,
      etaMinutes: nextProgress >= 1 ? 0 : Math.max(1, Math.ceil(remainingMeters / 500)),
      location: nextLocation
    };

    await updateIncidentDispatch(id, nextDispatch, `${nextDispatch.unitName} ${status.toLowerCase()}`);
    if (nextProgress >= 1) stopDispatchTimer(dispatch.id);
  }, 2500);

  dispatchTimers.set(dispatch.id, timer);
  return { ok: true, dispatch };
}

async function updateIncidentDispatch(id, dispatch, eventMessage = "Dispatch updated") {
  const incident = activeIncidents.get(id);
  if (!incident) return;
  if (["Cleared", "Cancelled"].includes(dispatch.status) && dispatch.originFacilityId) {
    busyFacilities.delete(dispatch.originFacilityId);
  }

  const updatedIncident = {
    ...incident,
    dispatch,
    status: incident.status === "active" ? "accepted" : incident.status,
    dispatches: upsertDispatch(incident.dispatches || [], dispatch),
    facilities: markFacilityAvailability(incident.facilities || []),
    updatedAt: new Date().toISOString()
  };

  addTimeline(updatedIncident, "dispatch_update", eventMessage, dispatch);
  activeIncidents.set(id, updatedIncident);
  await addDispatchUpdate(id, dispatch);
  await persistIncident(updatedIncident);
  io.emit("incident:updated", updatedIncident);
}

function upsertDispatch(dispatches, dispatch) {
  return dispatches.some((item) => item.id === dispatch.id)
    ? dispatches.map((item) => item.id === dispatch.id ? dispatch : item)
    : [...dispatches, dispatch];
}

function markFacilityAvailability(facilities = []) {
  return facilities.map((facility) => ({
    ...facility,
    available: !busyFacilities.has(facility.id),
    assignedIncidentId: busyFacilities.get(facility.id) || null
  }));
}

function stopDispatchTimer(id) {
  for (const [timerId, timer] of dispatchTimers.entries()) {
    if (timerId === id || timerId.startsWith(`${id}:`) || timerId.includes(id)) {
      clearInterval(timer);
      dispatchTimers.delete(timerId);
    }
  }
}

function releaseIncidentFacility(incidentId) {
  for (const [facilityId, assignedIncidentId] of busyFacilities.entries()) {
    if (assignedIncidentId === incidentId) busyFacilities.delete(facilityId);
  }
}

function chooseDispatchStart(incident, unitType, origin = null) {
  if (origin?.lat && origin?.lng) {
    return {
      name: String(origin.name || `${getUnitName(unitType)} station`).slice(0, 120),
      facilityId: origin.facilityId || null,
      lat: Number(origin.lat),
      lng: Number(origin.lng)
    };
  }

  const preferredType = getFacilityTypeForUnit(unitType);
  const facility = (incident.facilities || []).find((item) => item.type === preferredType)
    || (incident.facilities || [])[0];
  if (facility) return { name: facility.name, facilityId: facility.id, lat: facility.lat, lng: facility.lng };
  return {
    name: `${getUnitName(unitType)} staging point`,
    facilityId: null,
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

function estimateEtaMinutes(meters = 0) {
  return Math.max(2, Math.ceil((meters || 0) / 430));
}

function interpolateLocation(start, end, progress) {
  return {
    lat: start.lat + (end.lat - start.lat) * progress,
    lng: start.lng + (end.lng - start.lng) * progress
  };
}
