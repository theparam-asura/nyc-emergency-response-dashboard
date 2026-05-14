const socket = io();

const nycCenter = [40.7128, -74.006];
const map = L.map("map", { zoomControl: false }).setView(nycCenter, 12);
const incidents = new Map();
const markers = new Map();
const accuracyCircles = new Map();
const facilityMarkers = new Map();
const dispatchMarkers = new Map();
const dispatchRoutes = new Map();

const layerState = {
  facilities: true,
  dispatch: true,
  accuracy: true
};

const loginGate = document.querySelector("#loginGate");
const loginForm = document.querySelector("#loginForm");
const accessCode = document.querySelector("#accessCode");
const incidentList = document.querySelector("#incidentList");
const activeCount = document.querySelector("#activeCount");
const highestPriority = document.querySelector("#highestPriority");
const lastUpdated = document.querySelector("#lastUpdated");
const selectedTitle = document.querySelector("#selectedTitle");
const selectedBadges = document.querySelector("#selectedBadges");
const selectedDetails = document.querySelector("#selectedDetails");
const transcriptList = document.querySelector("#transcriptList");
const guidancePanel = document.querySelector("#guidancePanel");
const facilityList = document.querySelector("#facilityList");
const timelineList = document.querySelector("#timelineList");
const callLog = document.querySelector("#callLog");
const dispatchPanel = document.querySelector("#dispatchPanel");
const dispatcherMessageForm = document.querySelector("#dispatcherMessageForm");
const dispatcherMessage = document.querySelector("#dispatcherMessage");
const speakMessage = document.querySelector("#speakMessage");

let selectedIncidentId = null;

L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

if (localStorage.getItem("dispatcherAccess") === "true") {
  loginGate.hidden = true;
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (accessCode.value.trim().toLowerCase() === "dispatcher") {
    localStorage.setItem("dispatcherAccess", "true");
    loginGate.hidden = true;
  } else {
    accessCode.value = "";
    accessCode.placeholder = "Wrong code";
  }
});

document.querySelectorAll("[data-layer]").forEach((input) => {
  input.addEventListener("change", (event) => {
    layerState[event.target.dataset.layer] = event.target.checked;
    redrawAllMapLayers();
  });
});

dispatcherMessageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = dispatcherMessage.value.trim();
  if (!selectedIncidentId || !text) return;

  socket.emit("dispatcher:message", {
    id: selectedIncidentId,
    text,
    speak: speakMessage.checked
  });
  dispatcherMessage.value = "";
});

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
  removeIncidentLayers(id);
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

  redrawIncidentLayers(incident);
}

function renderIncidents() {
  const sortedIncidents = Array.from(incidents.values()).sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );

  activeCount.textContent = sortedIncidents.filter((incident) => incident.status === "active").length;
  highestPriority.textContent = getHighestPriority(sortedIncidents);
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
      <span class="incident-meta ${priorityClass(incident.priority)}">${escapeHtml(incident.priority)}</span>
      <strong>${escapeHtml(incident.emergencyType)}</strong>
      <span>${escapeHtml(incident.callerName)} - ${formatTime(incident.updatedAt)}</span>
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
    selectedBadges.innerHTML = "";
    selectedDetails.textContent = "Open the caller page, send a help request, and allow location access to see live tracking here.";
    setEmptyPanels();
    return;
  }

  selectedTitle.textContent = `${incident.emergencyType} - ${incident.callerName}`;
  selectedBadges.innerHTML = `
    <span class="${priorityClass(incident.priority)}">${escapeHtml(incident.priority)}</span>
    <span>${escapeHtml(incident.status)}</span>
  `;
  selectedDetails.innerHTML = `
    <div class="detail-kpis">
      <article><span>Phone</span><strong>${escapeHtml(incident.callerPhone)}</strong></article>
      <article><span>GPS</span><strong>${incident.location ? formatCoordinates(incident.location) : "waiting"}</strong></article>
      <article><span>Created</span><strong>${formatTime(incident.createdAt)}</strong></article>
    </div>
    <p>${escapeHtml(incident.notes || "No initial notes provided.")}</p>
    <div class="dispatch-actions">
      <button class="dispatch-button" type="button" data-unit-type="ems">Dispatch EMS</button>
      <button class="dispatch-button" type="button" data-unit-type="fire">Dispatch Fire</button>
      <button class="dispatch-button" type="button" data-unit-type="police">Dispatch Police</button>
      <button class="resolve-button" type="button" data-id="${incident.id}">Resolve</button>
    </div>
  `;

  selectedDetails.querySelector(".resolve-button").addEventListener("click", () => {
    socket.emit("incident:resolve", incident.id);
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
  renderTimeline(incident);
  renderCallLog(incident);
  renderDispatchPanel(incident);
}

function setEmptyPanels() {
  transcriptList.textContent = "No caller transcript yet.";
  transcriptList.className = "transcript-list empty-state";
  guidancePanel.textContent = "Waiting for incident details.";
  guidancePanel.className = "guidance-panel empty-state";
  facilityList.textContent = "Waiting for caller GPS.";
  facilityList.className = "facility-list empty-state";
  timelineList.textContent = "No timeline events yet.";
  timelineList.className = "timeline-list empty-state";
  callLog.textContent = "No call messages yet.";
  dispatchPanel.textContent = "No unit assigned yet.";
  dispatchPanel.className = "dispatch-panel empty-state";
}

function renderTranscript(incident) {
  const transcript = incident.transcript || [];
  if (!transcript.length) {
    transcriptList.textContent = "No caller transcript yet.";
    transcriptList.className = "transcript-list empty-state";
    return;
  }

  transcriptList.className = "transcript-list";
  transcriptList.innerHTML = transcript.slice(-8).map((entry) => `
    <article>
      <span>${escapeHtml(entry.speaker || "caller")} - ${formatTime(entry.timestamp)}</span>
      <p>${escapeHtml(entry.text)}</p>
    </article>
  `).join("");
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
      <span class="${priorityClass(guidance.priority)}">${escapeHtml(guidance.priority)}</span>
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
  facilityList.innerHTML = facilities.slice(0, 6).map((facility) => `
    <article>
      <strong>${escapeHtml(facility.name)}</strong>
      <span>${escapeHtml(formatFacilityType(facility.type))} - ${formatDistance(facility.distanceMeters)}</span>
    </article>
  `).join("");
}

function renderTimeline(incident) {
  const timeline = incident.timeline || [];
  if (!timeline.length) {
    timelineList.textContent = "No timeline events yet.";
    timelineList.className = "timeline-list empty-state";
    return;
  }

  timelineList.className = "timeline-list";
  timelineList.innerHTML = timeline.slice(-10).reverse().map((event) => `
    <article>
      <span>${formatTime(event.timestamp)}</span>
      <p>${escapeHtml(event.message)}</p>
    </article>
  `).join("");
}

function renderCallLog(incident) {
  const messages = incident.messages || [];
  if (!messages.length) {
    callLog.textContent = "No call messages yet.";
    return;
  }

  callLog.innerHTML = messages.slice(-10).map((message) => `
    <article class="${message.sender}">
      <span>${escapeHtml(message.sender)} - ${formatTime(message.timestamp)}</span>
      <p>${escapeHtml(message.text)}</p>
    </article>
  `).join("");
}

function renderDispatchPanel(incident) {
  const dispatch = incident.dispatch;
  if (!dispatch) {
    dispatchPanel.textContent = "No unit assigned yet.";
    dispatchPanel.className = "dispatch-panel empty-state";
    return;
  }

  dispatchPanel.className = "dispatch-panel";
  dispatchPanel.innerHTML = `
    <div class="priority-line">
      <span>${escapeHtml(dispatch.status)}</span>
      <strong>${escapeHtml(dispatch.unitName)}</strong>
    </div>
    <p>Origin: ${escapeHtml(dispatch.originName)}</p>
    <p>ETA ${dispatch.etaMinutes} min - ${formatDistance(dispatch.remainingMeters)} remaining</p>
    <div class="dispatch-status-controls">
      ${["Assigned", "En route", "Arrived", "Transporting", "Cleared"].map((status) => `
        <button type="button" data-status="${status}">${status}</button>
      `).join("")}
    </div>
  `;

  dispatchPanel.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", (event) => {
      socket.emit("dispatch:status", {
        id: incident.id,
        status: event.target.dataset.status
      });
    });
  });
}

function redrawAllMapLayers() {
  Array.from(incidents.values()).forEach(redrawIncidentLayers);
}

function redrawIncidentLayers(incident) {
  renderAccuracyCircle(incident);
  renderFacilityMarkers(incident);
  renderDispatchLayers(incident);
}

function renderAccuracyCircle(incident) {
  const circle = accuracyCircles.get(incident.id);
  if (circle) {
    circle.remove();
    accuracyCircles.delete(incident.id);
  }

  if (!layerState.accuracy || !incident.location) return;

  const nextCircle = L.circle([incident.location.lat, incident.location.lng], {
    radius: Math.max(incident.location.accuracy || 25, 25),
    color: "#1769aa",
    fillColor: "#1769aa",
    fillOpacity: 0.08,
    weight: 1
  }).addTo(map);
  accuracyCircles.set(incident.id, nextCircle);
}

function renderFacilityMarkers(incident) {
  for (const [id, marker] of facilityMarkers.entries()) {
    if (id.startsWith(`${incident.id}:`)) {
      marker.remove();
      facilityMarkers.delete(id);
    }
  }
  if (!layerState.facilities) return;

  (incident.facilities || []).forEach((facility) => {
    const markerId = `${incident.id}:${facility.id}`;
    const marker = L.circleMarker([facility.lat, facility.lng], {
      radius: 7,
      color: getFacilityColor(facility.type),
      fillColor: getFacilityColor(facility.type),
      fillOpacity: 0.82,
      weight: 2
    }).addTo(map).bindPopup(`${facility.name} (${formatFacilityType(facility.type)})`);
    facilityMarkers.set(markerId, marker);
  });
}

function renderDispatchLayers(incident) {
  removeDispatchLayers(incident.id);
  if (!layerState.dispatch || !incident.dispatch?.location || !incident.dispatch?.destination) return;

  const unitLocation = [incident.dispatch.location.lat, incident.dispatch.location.lng];
  const destination = [incident.dispatch.destination.lat, incident.dispatch.destination.lng];
  const color = getDispatchColor(incident.dispatch.unitType);

  const marker = L.circleMarker(unitLocation, {
    radius: 10,
    color,
    fillColor: color,
    fillOpacity: 0.95,
    weight: 3
  }).addTo(map).bindPopup(`${incident.dispatch.unitName}: ${incident.dispatch.status}`);

  const route = L.polyline([unitLocation, destination], {
    color,
    weight: 4,
    opacity: 0.8,
    dashArray: incident.dispatch.status === "Arrived" ? null : "8 8"
  }).addTo(map);

  dispatchMarkers.set(incident.id, marker);
  dispatchRoutes.set(incident.id, route);
}

function removeIncidentLayers(id) {
  markers.get(id)?.remove();
  markers.delete(id);
  accuracyCircles.get(id)?.remove();
  accuracyCircles.delete(id);
  for (const [markerId, marker] of facilityMarkers.entries()) {
    if (markerId.startsWith(`${id}:`)) {
      marker.remove();
      facilityMarkers.delete(markerId);
    }
  }
  removeDispatchLayers(id);
}

function removeDispatchLayers(id) {
  dispatchMarkers.get(id)?.remove();
  dispatchMarkers.delete(id);
  dispatchRoutes.get(id)?.remove();
  dispatchRoutes.delete(id);
}

function renderMiniList(title, values = []) {
  if (!values.length) return "";
  return `
    <div class="mini-list">
      <strong>${title}</strong>
      <ul>${values.slice(0, 4).map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>
    </div>
  `;
}

function getHighestPriority(values) {
  const order = ["Critical", "High", "Medium", "Low"];
  return order.find((priority) => values.some((incident) => incident.priority === priority)) || "None";
}

function priorityClass(priority = "") {
  return `priority-${priority.toLowerCase().replaceAll(" ", "-")}`;
}

function formatCoordinates(location) {
  return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} (${Math.round(location.accuracy)}m)`;
}

function formatDistance(meters = 0) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatFacilityType(type) {
  return String(type).replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTime(value) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function getFacilityColor(type) {
  return { hospital: "#1f7a4d", police: "#1769aa", fire_station: "#c62828" }[type] || "#596579";
}

function getDispatchColor(unitType) {
  return { ems: "#1f7a4d", fire: "#c62828", police: "#1769aa" }[unitType] || "#596579";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
