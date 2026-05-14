const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const activeIncidents = new Map();

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
      location: null
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
