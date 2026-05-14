const socket = io();

const nycCenter = [40.7128, -74.006];
const map = L.map("map", { zoomControl: false }).setView(nycCenter, 12);
const incidents = new Map();
const markers = new Map();
const facilityMarkers = new Map();
const dispatchMarkers = new Map();
const dispatchRoutes = new Map();

const incidentList = document.querySelector("#incidentList");
const activeCount = document.querySelector("#activeCount");
const lastUpdated = document.querySelector("#lastUpdated");
const selectedTitle = document.querySelector("#selectedTitle");
const selectedDetails = document.querySelector("#selectedDetails");
const transcriptList = document.querySelector("#transcriptList");
const guidancePanel = document.querySelector("#guidancePanel");
const facilityList = document.querySelector("#facilityList");

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
  for (const [markerId, facilityMarker] of facilityMarkers.entries()) {
    if (markerId.startsWith(`${id}:`)) {
      facilityMarker.remove();
      facilityMarkers.delete(markerId);
    }
  }
  removeDispatchLayers(id);
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

  renderFacilityMarkers(incident);
  renderDispatchLayers(incident);
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
    transcriptList.textContent = "No caller transcript yet.";
    transcriptList.className = "transcript-list empty-state";
    guidancePanel.textContent = "Waiting for incident details.";
    guidancePanel.className = "guidance-panel empty-state";
    facilityList.textContent = "Waiting for caller GPS.";
    facilityList.className = "facility-list empty-state";
    return;
  }

  selectedTitle.textContent = `${incident.emergencyType} - ${incident.callerName}`;
  selectedDetails.innerHTML = `
    Phone: ${escapeHtml(incident.callerPhone)} |
    Status: ${escapeHtml(incident.status)} |
    GPS: ${incident.location ? formatCoordinates(incident.location) : "waiting"} |
    Notes: ${escapeHtml(incident.notes || "none")}
    ${renderDispatchSummary(incident)}
    ${renderDispatchButtons(incident)}
    <button class="resolve-button" type="button" data-id="${incident.id}">Mark Resolved</button>
  `;

  selectedDetails.querySelector(".resolve-button").addEventListener("click", (event) => {
    socket.emit("incident:resolve", event.target.dataset.id);
  });
  selectedDetails.querySelectorAll(".dispatch-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      socket.emit("dispatch:start", {
        id: incident.id,
        unitType: event.target.dataset.unitType
      });
    });
  });

  renderTranscript(incident);
  renderGuidance(incident);
  renderFacilities(incident);
}

function renderDispatchSummary(incident) {
  if (!incident.dispatch) {
    return `<div class="dispatch-summary">Dispatch: waiting for assignment</div>`;
  }

  return `
    <div class="dispatch-summary">
      Dispatch: ${escapeHtml(incident.dispatch.unitName)} ${escapeHtml(incident.dispatch.status)}
      from ${escapeHtml(incident.dispatch.originName)}
      - ETA ${incident.dispatch.etaMinutes} min
      - ${formatDistance(incident.dispatch.remainingMeters)} remaining
    </div>
  `;
}

function renderDispatchButtons(incident) {
  if (!incident.location) {
    return `<div class="dispatch-actions">Waiting for GPS before dispatch.</div>`;
  }

  return `
    <div class="dispatch-actions">
      <button class="dispatch-button" type="button" data-unit-type="ems">Dispatch EMS</button>
      <button class="dispatch-button" type="button" data-unit-type="fire">Dispatch Fire</button>
      <button class="dispatch-button" type="button" data-unit-type="police">Dispatch Police</button>
    </div>
  `;
}

function renderTranscript(incident) {
  const transcript = incident.transcript || [];

  if (!transcript.length) {
    transcriptList.textContent = "No caller transcript yet.";
    transcriptList.className = "transcript-list empty-state";
    return;
  }

  transcriptList.className = "transcript-list";
  transcriptList.innerHTML = transcript
    .slice(-8)
    .map((entry) => `
      <article>
        <span>${formatTime(entry.timestamp)}</span>
        <p>${escapeHtml(entry.text)}</p>
      </article>
    `)
    .join("");
}

function renderGuidance(incident) {
  const guidance = incident.guidance;

  if (!guidance) {
    guidancePanel.textContent = "Waiting for incident details.";
    guidancePanel.className = "guidance-panel empty-state";
    return;
  }

  guidancePanel.className = "guidance-panel";
  guidancePanel.innerHTML = `
    <div class="priority-line">
      <span>${escapeHtml(guidance.priority)}</span>
      <strong>${escapeHtml(guidance.recommendedUnit)}</strong>
    </div>
    <p>${escapeHtml(guidance.summary)}</p>
    ${renderMiniList("Questions", guidance.questions)}
    ${renderMiniList("Actions", guidance.actions)}
    ${renderMiniList("Risks", guidance.risks)}
  `;
}

function renderFacilities(incident) {
  const facilities = incident.facilities || [];

  if (!facilities.length) {
    facilityList.textContent = incident.location ? "Searching nearby places..." : "Waiting for caller GPS.";
    facilityList.className = "facility-list empty-state";
    return;
  }

  facilityList.className = "facility-list";
  facilityList.innerHTML = facilities
    .slice(0, 6)
    .map((facility) => `
      <article>
        <strong>${escapeHtml(facility.name)}</strong>
        <span>${escapeHtml(formatFacilityType(facility.type))} - ${formatDistance(facility.distanceMeters)}</span>
      </article>
    `)
    .join("");
}

function renderFacilityMarkers(incident) {
  for (const [id, marker] of facilityMarkers.entries()) {
    if (id.startsWith(`${incident.id}:`)) {
      marker.remove();
      facilityMarkers.delete(id);
    }
  }

  (incident.facilities || []).forEach((facility) => {
    const markerId = `${incident.id}:${facility.id}`;
    const marker = L.circleMarker([facility.lat, facility.lng], {
      radius: 7,
      color: getFacilityColor(facility.type),
      fillColor: getFacilityColor(facility.type),
      fillOpacity: 0.82,
      weight: 2
    })
      .addTo(map)
      .bindPopup(`${facility.name} (${formatFacilityType(facility.type)})`);

    facilityMarkers.set(markerId, marker);
  });
}

function renderDispatchLayers(incident) {
  removeDispatchLayers(incident.id);

  if (!incident.dispatch?.location || !incident.dispatch?.destination) return;

  const unitLocation = [incident.dispatch.location.lat, incident.dispatch.location.lng];
  const destination = [incident.dispatch.destination.lat, incident.dispatch.destination.lng];
  const color = getDispatchColor(incident.dispatch.unitType);

  const marker = L.circleMarker(unitLocation, {
    radius: 10,
    color,
    fillColor: color,
    fillOpacity: 0.95,
    weight: 3
  })
    .addTo(map)
    .bindPopup(`${incident.dispatch.unitName}: ${incident.dispatch.status}`);

  const route = L.polyline([unitLocation, destination], {
    color,
    weight: 4,
    opacity: 0.8,
    dashArray: incident.dispatch.status === "arrived" ? null : "8 8"
  }).addTo(map);

  dispatchMarkers.set(incident.id, marker);
  dispatchRoutes.set(incident.id, route);
}

function removeDispatchLayers(id) {
  const marker = dispatchMarkers.get(id);
  if (marker) {
    marker.remove();
    dispatchMarkers.delete(id);
  }

  const route = dispatchRoutes.get(id);
  if (route) {
    route.remove();
    dispatchRoutes.delete(id);
  }
}

function renderMiniList(title, values = []) {
  if (!values.length) return "";

  return `
    <div class="mini-list">
      <strong>${title}</strong>
      <ul>
        ${values.slice(0, 4).map((value) => `<li>${escapeHtml(value)}</li>`).join("")}
      </ul>
    </div>
  `;
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

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

function formatFacilityType(type) {
  return String(type).replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function getFacilityColor(type) {
  const colors = {
    hospital: "#1f7a4d",
    police: "#1769aa",
    fire_station: "#c62828"
  };

  return colors[type] || "#596579";
}

function getDispatchColor(unitType) {
  const colors = {
    ems: "#1f7a4d",
    fire: "#c62828",
    police: "#1769aa"
  };

  return colors[unitType] || "#596579";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
