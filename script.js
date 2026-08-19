const VISITED_STORAGE_KEY = "stampRallyMapVisited_v1";
const CUSTOM_STORAGE_KEY = "stampRallyMapCustomCheckpoints_v1";

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
const checkpointMarkers = {};
const searchLayer = L.layerGroup().addTo(map);

function makeCustomCheckpointId(rallyId, osmType, osmId) {
  return `custom-${rallyId}-${osmType}-${osmId}`;
}

function loadCustomCheckpoints() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_STORAGE_KEY) || "[]");

    saved.forEach(item => {
      const rally = stampRallies.find(r => r.id === item.rallyId);
      if (!rally) return;

      if (!rally.checkpoints.some(cp => cp.id === item.id)) {
        rally.checkpoints.push({
          id: item.id,
          name: item.name,
          prefecture: item.prefecture || "",
          lat: item.lat,
          lng: item.lng,
          visited: Boolean(item.visited),
          custom: true,
          osmType: item.osmType,
          osmId: item.osmId
        });
      }
    });
  } catch (error) {
    console.warn("追加済み駅データを読み込めませんでした。", error);
  }
}

function saveCustomCheckpoints() {
  const custom = [];

  stampRallies.forEach(rally => {
    rally.checkpoints.forEach(cp => {
      if (!cp.custom) return;

      custom.push({
        id: cp.id,
        rallyId: rally.id,
        name: cp.name,
        prefecture: cp.prefecture || "",
        lat: cp.lat,
        lng: cp.lng,
        visited: cp.visited,
        osmType: cp.osmType,
        osmId: cp.osmId
      });
    });
  });

  localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(custom));
}

function loadSavedVisitedStates() {
  try {
    const saved = JSON.parse(localStorage.getItem(VISITED_STORAGE_KEY) || "{}");

    stampRallies.forEach(rally => {
      rally.checkpoints.forEach(checkpoint => {
        if (Object.prototype.hasOwnProperty.call(saved, checkpoint.id)) {
          checkpoint.visited = Boolean(saved[checkpoint.id]);
        }
      });
    });
  } catch (error) {
    console.warn("訪問済みデータを読み込めませんでした。", error);
  }
}

function saveVisitedStates() {
  const data = {};

  stampRallies.forEach(rally => {
    rally.checkpoints.forEach(checkpoint => {
      data[checkpoint.id] = checkpoint.visited;
    });
  });

  localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify(data));
  saveCustomCheckpoints();
}

function createCheckpointIcon(visited) {
  return L.divIcon({
    className: "",
    html: `<div class="checkpoint-marker ${visited ? "visited" : "unvisited"}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12]
  });
}

function createSearchIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="search-result-marker"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12]
  });
}

function createPopup(rally, checkpoint) {
  return `
    <div class="popup-content">
      <div class="popup-title">${escapeHtml(checkpoint.name)}</div>
      <div class="popup-row">${escapeHtml(checkpoint.prefecture || "")}</div>
      <div class="popup-row">ラリー：${escapeHtml(rally.name)}</div>
      <div class="popup-status ${checkpoint.visited ? "visited" : "unvisited"}">
        ${checkpoint.visited ? "✓ 訪問済み" : "● 未訪問"}
      </div>

      <button
        type="button"
        class="visit-toggle-button ${checkpoint.visited ? "mark-unvisited" : "mark-visited"}"
        data-rally-id="${rally.id}"
        data-checkpoint-id="${checkpoint.id}"
      >
        ${checkpoint.visited ? "未訪問に戻す" : "✓ 訪問済みにする"}
      </button>

      <div class="save-note">変更内容はこのブラウザに自動保存されます</div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function findCheckpoint(rallyId, checkpointId) {
  const rally = stampRallies.find(r => r.id === rallyId);
  if (!rally) return null;

  const checkpoint = rally.checkpoints.find(cp => cp.id === checkpointId);
  if (!checkpoint) return null;

  return { rally, checkpoint };
}

function updateMarker(rally, checkpoint) {
  const marker = checkpointMarkers[checkpoint.id];
  if (!marker) return;

  marker.setIcon(createCheckpointIcon(checkpoint.visited));
  marker.setPopupContent(createPopup(rally, checkpoint));
}

function toggleVisited(rallyId, checkpointId) {
  const result = findCheckpoint(rallyId, checkpointId);
  if (!result) return;

  const { rally, checkpoint } = result;
  checkpoint.visited = !checkpoint.visited;

  saveVisitedStates();
  updateMarker(rally, checkpoint);
  buildProgress();

  const marker = checkpointMarkers[checkpoint.id];
  if (marker) marker.openPopup();
}

function addCheckpointMarker(rally, checkpoint) {
  const marker = L.marker([checkpoint.lat, checkpoint.lng], {
    icon: createCheckpointIcon(checkpoint.visited),
    title: checkpoint.name
  });

  marker.bindPopup(createPopup(rally, checkpoint));
  marker.addTo(rallyLayers[rally.id]);

  checkpointMarkers[checkpoint.id] = marker;
}

function buildLayers() {
  stampRallies.forEach(rally => {
    const layer = L.layerGroup();
    rallyLayers[rally.id] = layer;

    rally.checkpoints.forEach(checkpoint => {
      addCheckpointMarker(rally, checkpoint);
    });

    layer.addTo(map);
  });
}

function buildFilters() {
  const container = document.getElementById("rallyFilters");
  container.innerHTML = "";

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
        <span class="name">${escapeHtml(rally.name)}</span>
        <span class="count">${visited} / ${total}</span>
      </div>
      <div class="progress-track">
        <div class="progress-bar" style="width:${percent}%"></div>
      </div>
    `;
    container.appendChild(card);
  });

  document.getElementById("overallCount").textContent = `${overallVisited} / ${overallTotal}`;

  const overallPercent =
    overallTotal === 0 ? 0 : Math.round((overallVisited / overallTotal) * 100);

  document.getElementById("overallProgressBar").style.width = `${overallPercent}%`;
}

function normalizeStationName(result) {
  return result.name ||
    result.display_name?.split(",")[0] ||
    "名称不明の駅";
}

function getPrefecture(result) {
  const address = result.address || {};
  return address.province ||
    address.state ||
    address.region ||
    "";
}

function isLikelyStation(result) {
  const type = String(result.type || "").toLowerCase();
  const category = String(result.category || "").toLowerCase();
  const display = String(result.display_name || "");

  return category === "railway" ||
    type === "station" ||
    type === "halt" ||
    type === "tram_stop" ||
    display.includes("駅") ||
    display.toLowerCase().includes("station");
}

async function searchStations() {
  const input = document.getElementById("stationSearchInput");
  const button = document.getElementById("stationSearchButton");
  const panel = document.getElementById("searchPanel");
  const status = document.getElementById("searchStatus");
  const resultsContainer = document.getElementById("stationSearchResults");

  const query = input.value.trim();
  if (!query) {
    panel.classList.remove("hidden");
    status.textContent = "駅名を入力してください。";
    resultsContainer.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  status.textContent = "検索中...";
  resultsContainer.innerHTML = "";
  button.disabled = true;

  try {
    const q = query.endsWith("駅") ? query : `${query}駅`;
    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      addressdetails: "1",
      namedetails: "1",
      limit: "10",
      countrycodes: "jp",
      "accept-language": "ja"
    });

    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: {
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const rawResults = await response.json();
    const stations = rawResults.filter(isLikelyStation);

    if (stations.length === 0) {
      status.textContent = "駅候補が見つかりませんでした。駅名を少し変えて再検索してください。";
      return;
    }

    status.textContent = `${stations.length}件の候補が見つかりました。`;
    renderStationResults(stations);
  } catch (error) {
    console.error(error);
    status.textContent = "駅検索に失敗しました。少し時間をおいて再度お試しください。";
  } finally {
    button.disabled = false;
  }
}

function renderStationResults(results) {
  const container = document.getElementById("stationSearchResults");
  container.innerHTML = "";

  results.forEach((result, index) => {
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    const name = result.namedetails?.name || normalizeStationName(result);
    const prefecture = getPrefecture(result);
    const addressText = result.display_name || "";
    const osmType = result.osm_type || "unknown";
    const osmId = String(result.osm_id || `${Date.now()}-${index}`);

    const card = document.createElement("div");
    card.className = "station-result-card";

    const options = stampRallies.map(rally =>
      `<option value="${rally.id}" ${rally.id === "station" ? "selected" : ""}>${escapeHtml(rally.name)}</option>`
    ).join("");

    card.innerHTML = `
      <div class="station-result-name">${escapeHtml(name)}</div>
      <div class="station-result-address">${escapeHtml(addressText)}</div>

      <div class="station-result-actions">
        <select class="rally-select" aria-label="追加先ラリー">
          ${options}
        </select>
        <button type="button" class="add-station-button">＋ ラリーに追加</button>
      </div>

      <div class="station-result-subactions">
        <button type="button" class="show-station-button">地図で表示</button>
      </div>
    `;

    const showButton = card.querySelector(".show-station-button");
    const addButton = card.querySelector(".add-station-button");
    const select = card.querySelector(".rally-select");

    showButton.addEventListener("click", () => {
      showSearchResultOnMap(result, name);
    });

    addButton.addEventListener("click", () => {
      addStationToRally({
        rallyId: select.value,
        name,
        prefecture,
        lat,
        lng,
        osmType,
        osmId
      }, addButton);
    });

    container.appendChild(card);
  });
}

function showSearchResultOnMap(result, name) {
  const lat = Number(result.lat);
  const lng = Number(result.lon);

  searchLayer.clearLayers();

  const marker = L.marker([lat, lng], {
    icon: createSearchIcon(),
    title: name
  }).addTo(searchLayer);

  marker.bindPopup(`
    <div class="popup-content">
      <div class="popup-title">${escapeHtml(name)}</div>
      <div class="popup-row">駅検索結果</div>
    </div>
  `).openPopup();

  map.setView([lat, lng], 15);
}

function addStationToRally(station, button) {
  const rally = stampRallies.find(r => r.id === station.rallyId);
  if (!rally) return;

  const id = makeCustomCheckpointId(station.rallyId, station.osmType, station.osmId);

  if (rally.checkpoints.some(cp => cp.id === id)) {
    button.textContent = "追加済み";
    button.disabled = true;
    return;
  }

  const checkpoint = {
    id,
    name: station.name,
    prefecture: station.prefecture,
    lat: station.lat,
    lng: station.lng,
    visited: false,
    custom: true,
    osmType: station.osmType,
    osmId: station.osmId
  };

  rally.checkpoints.push(checkpoint);
  addCheckpointMarker(rally, checkpoint);

  saveCustomCheckpoints();
  saveVisitedStates();
  buildProgress();

  button.textContent = "追加しました";
  button.disabled = true;

  map.setView([checkpoint.lat, checkpoint.lng], 15);

  const marker = checkpointMarkers[checkpoint.id];
  if (marker) marker.openPopup();
}

document.addEventListener("click", event => {
  const button = event.target.closest(".visit-toggle-button");
  if (!button) return;

  toggleVisited(button.dataset.rallyId, button.dataset.checkpointId);
});

document.getElementById("stationSearchButton").addEventListener("click", searchStations);

document.getElementById("stationSearchInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchStations();
  }
});

document.getElementById("closeSearchPanel").addEventListener("click", () => {
  document.getElementById("searchPanel").classList.add("hidden");
  searchLayer.clearLayers();
});

loadCustomCheckpoints();
loadSavedVisitedStates();
buildLayers();
buildFilters();
buildProgress();
