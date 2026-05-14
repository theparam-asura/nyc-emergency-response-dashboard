const socket = io();

const nycCenter = [40.7128, -74.006];
const map = L.map("map", { zoomControl: false }).setView(nycCenter, 12);
const incidents = new Map();
const markers = new Map();

const incidentList = document.querySelector("#incidentList");
const activeCount = document.querySelector("#activeCount");
const lastUpdated = document.querySelector("#lastUpdated");
const selectedTitle = document.querySelector("#selectedTitle");
const selectedDetails = document.querySelector("#selectedDetails");

let selectedIncidentId = null;

L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

socket.on("incidents:snapshot", (snapshot) => {
  snapshot.forEach(upsertIncident);
  renderIncidents();
});

socket.on("incident:created", (incident) => {
  upsertIncident(incident);
  renderIncidents();
});

socket.on("incident:updated", (incident) => {
  upsertIncident(incident);
  renderIncidents();
});

socket.on("incident:removed", (id) => {
  incidents.delete(id);
  const marker = markers.get(id);
  if (marker) {
    marker.remove();
    markers.delete(id);
  }
  if (selectedIncidentId === id) selectedIncidentId = null;
  renderIncidents();
});

function upsertIncident(incident) {
  incidents.set(incident.id, incident);

  if (incident.location) {
    const latLng = [incident.location.lat, incident.location.lng];
    const label = `${incident.emergencyType} - ${incident.callerName}`;

    if (markers.has(incident.id)) {
      markers.get(incident.id).setLatLng(latLng).bindPopup(label);
    } else {
      const marker = L.marker(latLng).addTo(map).bindPopup(label);
      marker.on("click", () => selectIncident(incident.id));
      markers.set(incident.id, marker);
    }

    if (!selectedIncidentId) {
      selectIncident(incident.id);
      map.setView(latLng, 16);
    }
  }
}

function renderIncidents() {
  const sortedIncidents = Array.from(incidents.values()).sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );

  activeCount.textContent = sortedIncidents.filter((incident) => incident.status === "active").length;
  lastUpdated.textContent = sortedIncidents[0] ? formatTime(sortedIncidents[0].updatedAt) : "Never";

  if (!sortedIncidents.length) {
    incidentList.innerHTML = `<p class="empty-state">No active emergency calls.</p>`;
    renderSelectedIncident();
    return;
  }

  incidentList.innerHTML = "";
  sortedIncidents.forEach((incident) => {
    const button = document.createElement("button");
    button.className = `incident-card ${incident.id === selectedIncidentId ? "selected" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span class="incident-meta">${incident.status}</span>
      <strong>${escapeHtml(incident.emergencyType)}</strong>
      <span>${escapeHtml(incident.callerName)} · ${formatTime(incident.updatedAt)}</span>
      <small>${incident.location ? formatCoordinates(incident.location) : "Waiting for GPS"}</small>
    `;
    button.addEventListener("click", () => selectIncident(incident.id));
    incidentList.appendChild(button);
  });

  renderSelectedIncident();
}

function selectIncident(id) {
  selectedIncidentId = id;
  const incident = incidents.get(id);
  if (incident?.location) {
    map.setView([incident.location.lat, incident.location.lng], 16);
    markers.get(id)?.openPopup();
  }
  renderIncidents();
}

function renderSelectedIncident() {
  const incident = selectedIncidentId ? incidents.get(selectedIncidentId) : null;

  if (!incident) {
    selectedTitle.textContent = "No active caller selected";
    selectedDetails.textContent = "Open the caller page, send a help request, and allow location access to see live tracking here.";
    return;
  }

  selectedTitle.textContent = `${incident.emergencyType} - ${incident.callerName}`;
  selectedDetails.innerHTML = `
    Phone: ${escapeHtml(incident.callerPhone)} |
    Status: ${escapeHtml(incident.status)} |
    GPS: ${incident.location ? formatCoordinates(incident.location) : "waiting"} |
    Notes: ${escapeHtml(incident.notes || "none")}
    <button class="resolve-button" type="button" data-id="${incident.id}">Mark Resolved</button>
  `;

  selectedDetails.querySelector(".resolve-button").addEventListener("click", (event) => {
    socket.emit("incident:resolve", event.target.dataset.id);
  });
}

function formatCoordinates(location) {
  return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} (${Math.round(location.accuracy)}m)`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
