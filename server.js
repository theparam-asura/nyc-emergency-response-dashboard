const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const activeIncidents = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

io.on("connection", (socket) => {
  socket.emit("incidents:snapshot", Array.from(activeIncidents.values()));

  socket.on("caller:start", (incident) => {
    const id = incident.id || socket.id;
    const startedIncident = {
      id,
      callerSocketId: socket.id,
      status: "active",
      emergencyType: incident.emergencyType || "Medical",
      callerName: incident.callerName || "Unknown caller",
      callerPhone: incident.callerPhone || "Not provided",
      notes: incident.notes || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      location: null,
      transcript: [],
      guidance: buildRuleBasedGuidance(incident.notes || "", incident.emergencyType || "Medical"),
      facilities: [],
      facilitiesUpdatedAt: null
    };

    activeIncidents.set(id, startedIncident);
    socket.join(id);
    io.emit("incident:created", startedIncident);
  });

  socket.on("caller:location", (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident) return;

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

    activeIncidents.set(payload.id, updatedIncident);
    io.emit("incident:updated", updatedIncident);

    maybeUpdateNearbyFacilities(payload.id, updatedIncident);
  });

  socket.on("caller:transcript", async (payload) => {
    const incident = activeIncidents.get(payload.id);
    if (!incident || !payload.text) return;

    const entry = {
      text: String(payload.text).slice(0, 600),
      isFinal: Boolean(payload.isFinal),
      timestamp: new Date().toISOString()
    };

    const transcript = [...(incident.transcript || []), entry].slice(-30);
    const transcriptText = transcript.map((item) => item.text).join(" ");
    const guidance = await buildAiGuidance(transcriptText, incident);

    const updatedIncident = {
      ...incident,
      transcript,
      guidance,
      updatedAt: new Date().toISOString()
    };

    activeIncidents.set(payload.id, updatedIncident);
    io.emit("incident:updated", updatedIncident);
  });

  socket.on("incident:resolve", (id) => {
    const incident = activeIncidents.get(id);
    if (!incident) return;

    const resolvedIncident = {
      ...incident,
      status: "resolved",
      updatedAt: new Date().toISOString()
    };

    activeIncidents.set(id, resolvedIncident);
    io.emit("incident:updated", resolvedIncident);

    setTimeout(() => {
      activeIncidents.delete(id);
      io.emit("incident:removed", id);
    }, 5000);
  });

  socket.on("disconnect", () => {
    for (const [id, incident] of activeIncidents.entries()) {
      if (incident.callerSocketId === socket.id && incident.status === "active") {
        const disconnectedIncident = {
          ...incident,
          status: "connection lost",
          updatedAt: new Date().toISOString()
        };
        activeIncidents.set(id, disconnectedIncident);
        io.emit("incident:updated", disconnectedIncident);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`NYC 911 prototype running at http://localhost:${PORT}`);
  console.log(`Responder dashboard: http://localhost:${PORT}/dashboard`);
});

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

  activeIncidents.set(id, updatedIncident);
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
  const lower = text.toLowerCase();
  const isFire = lower.includes("fire") || emergencyType === "Fire";
  const isPolice = lower.includes("weapon") || lower.includes("attack") || lower.includes("break in") || emergencyType === "Police";
  const isMedical = lower.includes("hurt") || lower.includes("bleeding") || lower.includes("unconscious") || lower.includes("breathing") || emergencyType === "Medical";

  return {
    priority: lower.includes("unconscious") || lower.includes("weapon") || lower.includes("fire") ? "High" : "Assessing",
    summary: text ? summarizeText(text) : "Waiting for caller transcript.",
    recommendedUnit: isFire ? "Fire + EMS" : isPolice ? "Police + EMS standby" : isMedical ? "EMS" : emergencyType,
    questions: [
      "Confirm exact location and nearest landmark.",
      "Ask if the caller is in immediate danger.",
      "Ask how many people need help."
    ],
    actions: [
      "Keep the caller connected and continue location tracking.",
      "Verify callback number and incident type.",
      "Use nearest emergency facilities list for dispatch planning."
    ],
    risks: [
      isFire ? "Fire or smoke exposure reported." : "No fire keywords detected yet.",
      isPolice ? "Possible safety threat reported." : "No weapon or violence keywords detected yet.",
      isMedical ? "Possible medical emergency reported." : "Medical condition unclear."
    ]
  };
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
