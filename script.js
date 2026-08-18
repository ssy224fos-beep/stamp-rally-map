const map = L.map("map", {
  zoomControl: true,
  minZoom: 4,
  maxZoom: 18
}).setView([36.2, 138.0], 5);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const rallyLayers = {};

function createCheckpointIcon(visited) {
  return L.divIcon({
    className: "",
    html: `<div class="checkpoint-marker ${visited ? "visited" : "unvisited"}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12]
  });
}

function createPopup(rally, checkpoint) {
  return `
    <div class="popup-title">${checkpoint.name}</div>
    <div class="popup-row">${checkpoint.prefecture}</div>
    <div class="popup-row">ラリー：${rally.name}</div>
    <div class="popup-status ${checkpoint.visited ? "visited" : "unvisited"}">
      ${checkpoint.visited ? "✓ 訪問済み" : "● 未訪問"}
    </div>
  `;
}

function buildLayers() {
  stampRallies.forEach(rally => {
    const layer = L.layerGroup();

    rally.checkpoints.forEach(checkpoint => {
      const marker = L.marker(
        [checkpoint.lat, checkpoint.lng],
        { icon: createCheckpointIcon(checkpoint.visited) }
      );

      marker.bindPopup(createPopup(rally, checkpoint));
      marker.addTo(layer);
    });

    layer.addTo(map);
    rallyLayers[rally.id] = layer;
  });
}

function buildFilters() {
  const container = document.getElementById("rallyFilters");

  stampRallies.forEach(rally => {
    const label = document.createElement("label");
    label.className = "rally-filter";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.rallyId = rally.id;

    input.addEventListener("change", () => {
      const layer = rallyLayers[rally.id];

      if (input.checked) {
        layer.addTo(map);
      } else {
        map.removeLayer(layer);
      }
    });

    const text = document.createElement("span");
    text.textContent = rally.name;

    label.appendChild(input);
    label.appendChild(text);
    container.appendChild(label);
  });
}

function buildProgress() {
  const container = document.getElementById("rallyProgress");
  container.innerHTML = "";

  let overallVisited = 0;
  let overallTotal = 0;

  stampRallies.forEach(rally => {
    const total = rally.checkpoints.length;
    const visited = rally.checkpoints.filter(cp => cp.visited).length;
    const percent = total === 0 ? 0 : Math.round((visited / total) * 100);

    overallVisited += visited;
    overallTotal += total;

    const card = document.createElement("div");
    card.className = "rally-progress-card";
    card.innerHTML = `
      <div class="top-row">
        <span class="name">${rally.name}</span>
        <span class="count">${visited} / ${total}</span>
      </div>
      <div class="progress-track">
        <div class="progress-bar" style="width:${percent}%"></div>
      </div>
    `;
    container.appendChild(card);
  });

  document.getElementById("overallCount").textContent =
    `${overallVisited} / ${overallTotal}`;

  const overallPercent =
    overallTotal === 0 ? 0 : Math.round((overallVisited / overallTotal) * 100);

  document.getElementById("overallProgressBar").style.width =
    `${overallPercent}%`;
}

buildLayers();
buildFilters();
buildProgress();
