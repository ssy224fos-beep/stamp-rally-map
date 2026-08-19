const VISITED_STORAGE_KEY = "stampRallyMapVisitedShared_v2";
const CUSTOM_STORAGE_KEY = "stampRallyMapCustomCheckpoints_v2";
const RALLY_STORAGE_KEY = "stampRallyMapRallies_v2";

const LEGACY_CUSTOM_STORAGE_KEY = "stampRallyMapCustomCheckpoints_v1";
const LEGACY_RALLY_STORAGE_KEY = "stampRallyMapRallies_v1";

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

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const MIN_AREA_SEARCH_ZOOM = 11;
const MAX_AREA_SEARCH_RESULTS = 120;

function loadRallySettings() {
  try {
    const currentRaw = localStorage.getItem(RALLY_STORAGE_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_RALLY_STORAGE_KEY);
    const saved = JSON.parse(currentRaw || legacyRaw || "{}");
    const customRallies = Array.isArray(saved.customRallies) ? saved.customRallies : [];

    stampRallies.splice(0, stampRallies.length);

    customRallies.forEach(item => {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string") return;

      stampRallies.push({
        id: item.id,
        name: item.name.trim() || "名称未設定ラリー",
        checkpoints: []
      });
    });
  } catch (error) {
    console.warn("ラリー設定を読み込めませんでした。", error);
  }
}

function saveRallySettings() {
  const customRallies = stampRallies.map(rally => ({
    id: rally.id,
    name: rally.name
  }));

  localStorage.setItem(
    RALLY_STORAGE_KEY,
    JSON.stringify({ customRallies })
  );
}

function makeNewRallyId() {
  return `rally-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}


function makeStationKey(osmType, osmId) {
  return `${osmType || "unknown"}:${osmId || ""}`;
}

function makeCustomCheckpointId(rallyId, osmType, osmId) {
  return `custom-${rallyId}-${osmType}-${osmId}`;
}

function loadCustomCheckpoints() {
  try {
    const currentRaw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_CUSTOM_STORAGE_KEY);
    const saved = JSON.parse(currentRaw || legacyRaw || "[]");

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
          osmId: item.osmId,
          stationKey: item.stationKey || makeStationKey(item.osmType, item.osmId)
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
        osmId: cp.osmId,
        stationKey: cp.stationKey || makeStationKey(cp.osmType, cp.osmId)
      });
    });
  });

  localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(custom));
}

function getCheckpointVisitKey(checkpoint) {
  return checkpoint.stationKey ||
    makeStationKey(checkpoint.osmType, checkpoint.osmId) ||
    checkpoint.id;
}

function loadSavedVisitedStates() {
  try {
    const saved = JSON.parse(localStorage.getItem(VISITED_STORAGE_KEY) || "{}");

    stampRallies.forEach(rally => {
      rally.checkpoints.forEach(checkpoint => {
        const key = getCheckpointVisitKey(checkpoint);
        if (Object.prototype.hasOwnProperty.call(saved, key)) {
          checkpoint.visited = Boolean(saved[key]);
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
      data[getCheckpointVisitKey(checkpoint)] = checkpoint.visited;
    });
  });

  localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify(data));
  saveCustomCheckpoints();
}

function setSharedVisited(checkpoint, visited) {
  const key = getCheckpointVisitKey(checkpoint);

  stampRallies.forEach(rally => {
    rally.checkpoints.forEach(cp => {
      if (getCheckpointVisitKey(cp) === key) {
        cp.visited = visited;
        updateMarker(rally, cp);
      }
    });
  });

  saveVisitedStates();
  buildProgress();
  buildRegisteredStationList();
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
  const customEditor = checkpoint.custom ? `
      <div class="custom-edit-panel">
        <label>
          表示名
          <input
            type="text"
            class="custom-edit-name"
            value="${escapeHtml(checkpoint.name)}"
            maxlength="80"
          >
        </label>

        <label>
          所属ラリー
          <select class="custom-edit-rally">
            ${stampRallies.map(item =>
              `<option value="${item.id}" ${item.id === rally.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`
            ).join("")}
          </select>
        </label>

        <div class="custom-edit-actions">
          <button
            type="button"
            class="custom-edit-save"
            data-rally-id="${rally.id}"
            data-checkpoint-id="${checkpoint.id}"
          >
            変更を保存
          </button>

          <button
            type="button"
            class="custom-edit-delete"
            data-rally-id="${rally.id}"
            data-checkpoint-id="${checkpoint.id}"
          >
            削除
          </button>
        </div>

        <div class="custom-edit-hint">
          駅検索から追加したポイントのみ編集・削除できます。
        </div>
      </div>
  ` : "";

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

      ${customEditor}

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

  const { checkpoint } = result;
  const newVisited = !checkpoint.visited;

  setSharedVisited(checkpoint, newVisited);

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
    input.checked = Boolean(rallyLayers[rally.id] && map.hasLayer(rallyLayers[rally.id]));
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

function refreshSearchRallySelects() {
  // 検索候補内のラリー選択欄は検索結果を再表示した際に最新化されます。
}


function buildRallyManager() {
  const container = document.getElementById("rallyManagerList");
  if (!container) return;

  container.innerHTML = "";

  stampRallies.forEach(rally => {
    const card = document.createElement("div");
    card.className = "rally-manager-card";

    const count = rally.checkpoints.length;

    card.innerHTML = `
      <div class="rally-manager-meta">
        <span class="rally-type-badge custom">ラリー</span>
        <span>${count}地点</span>
      </div>

      <input
        type="text"
        class="rally-manager-name"
        value="${escapeHtml(rally.name)}"
        maxlength="60"
      >

      <div class="rally-manager-actions">
        <button
          type="button"
          class="rally-manager-save"
          data-rally-id="${rally.id}"
        >
          名称を保存
        </button>

        <button
          type="button"
          class="rally-manager-delete"
          data-rally-id="${rally.id}"
        >
          削除
        </button>
      </div>
    `;

    container.appendChild(card);
  });

}

function createRally() {
  const input = document.getElementById("newRallyName");
  if (!input) return;

  const name = input.value.trim();
  if (!name) {
    alert("新しいラリー名を入力してください。");
    input.focus();
    return;
  }

  const rally = {
    id: makeNewRallyId(),
    name,
    checkpoints: []
  };

  stampRallies.push(rally);
  rallyLayers[rally.id] = L.layerGroup().addTo(map);

  saveRallySettings();
  buildRallyManager();
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
  refreshSearchRallySelects();

  input.value = "";
  input.focus();
}

function renameRally(button) {
  const rallyId = button.dataset.rallyId;
  const rally = stampRallies.find(item => item.id === rallyId);
  if (!rally) return;

  const card = button.closest(".rally-manager-card");
  const input = card?.querySelector(".rally-manager-name");
  if (!input) return;

  const newName = input.value.trim();
  if (!newName) {
    alert("ラリー名を入力してください。");
    input.focus();
    return;
  }

  rally.name = newName;

  rally.checkpoints.forEach(checkpoint => {
    updateMarker(rally, checkpoint);
  });

  saveRallySettings();
  buildRallyManager();
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
  refreshSearchRallySelects();
}

function deleteRally(button) {
  const rallyId = button.dataset.rallyId;
  const rallyIndex = stampRallies.findIndex(item => item.id === rallyId);
  if (rallyIndex < 0) return;

  if (stampRallies.length <= 1) {
    alert("ラリーは少なくとも1つ残してください。");
    return;
  }

  const rally = stampRallies[rallyIndex];
  const count = rally.checkpoints.length;
  const message = count > 0
    ? `「${rally.name}」を削除しますか？\n登録されている ${count} 地点もこのラリーから削除されます。`
    : `「${rally.name}」を削除しますか？`;

  if (!confirm(message)) return;

  rally.checkpoints.forEach(checkpoint => {
    removeCheckpointMarker(checkpoint.id, rally.id);
    removeVisitedStateKey(checkpoint.id);
  });

  if (rallyLayers[rally.id]) {
    map.removeLayer(rallyLayers[rally.id]);
    delete rallyLayers[rally.id];
  }

  stampRallies.splice(rallyIndex, 1);

  saveRallySettings();
  saveCustomCheckpoints();
  saveVisitedStates();

  buildRallyManager();
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
  refreshSearchRallySelects();

  document.getElementById("searchPanel")?.classList.add("hidden");
  searchLayer.clearLayers();
}

function buildRegisteredStationList() {
  const container = document.getElementById("registeredStationList");
  if (!container) return;

  container.innerHTML = "";

  if (stampRallies.length === 0) {
    container.innerHTML = `
      <div class="empty-station-list">
        ラリーがまだありません。先にラリーを作成してください。
      </div>
    `;
    return;
  }

  let anyStation = false;

  stampRallies.forEach(rally => {
    if (rally.checkpoints.length === 0) return;
    anyStation = true;

    const group = document.createElement("div");
    group.className = "registered-rally-group";

    const rows = [...rally.checkpoints]
      .sort((a, b) => a.name.localeCompare(b.name, "ja"))
      .map(checkpoint => `
        <div class="registered-station-row">
          <span class="registered-station-status ${checkpoint.visited ? "visited" : "unvisited"}"></span>
          <div>
            <div class="registered-station-name">${escapeHtml(checkpoint.name)}</div>
            <div class="registered-station-prefecture">${escapeHtml(checkpoint.prefecture || "")}</div>
          </div>
          <button
            type="button"
            class="registered-station-show"
            data-rally-id="${rally.id}"
            data-checkpoint-id="${checkpoint.id}"
          >
            地図で表示
          </button>
        </div>
      `).join("");

    group.innerHTML = `
      <div class="registered-rally-header">
        <span>${escapeHtml(rally.name)}</span>
        <span>${rally.checkpoints.length}駅</span>
      </div>
      ${rows}
    `;

    container.appendChild(group);
  });

  if (!anyStation) {
    container.innerHTML = `
      <div class="empty-station-list">
        まだ駅が登録されていません。駅検索から追加してください。
      </div>
    `;
  }
}

function showRegisteredStation(rallyId, checkpointId) {
  const result = findCheckpoint(rallyId, checkpointId);
  if (!result) return;

  const { rally, checkpoint } = result;
  const layer = rallyLayers[rally.id];

  if (layer && !map.hasLayer(layer)) {
    layer.addTo(map);
    buildFilters();
  }

  map.setView([checkpoint.lat, checkpoint.lng], 15);

  const marker = checkpointMarkers[checkpoint.id];
  if (marker) marker.openPopup();
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


function getOverpassElementLatLng(element) {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return { lat: element.lat, lng: element.lon };
  }

  if (element.center &&
      typeof element.center.lat === "number" &&
      typeof element.center.lon === "number") {
    return { lat: element.center.lat, lng: element.center.lon };
  }

  return null;
}

function overpassElementToSearchResult(element) {
  const point = getOverpassElementLatLng(element);
  if (!point) return null;

  const tags = element.tags || {};
  const name =
    tags["name:ja"] ||
    tags.name ||
    tags["official_name:ja"] ||
    tags.official_name ||
    "名称不明の駅";

  const addressParts = [
    tags["addr:province"],
    tags["addr:city"],
    tags["addr:suburb"],
    tags["addr:quarter"]
  ].filter(Boolean);

  return {
    lat: String(point.lat),
    lon: String(point.lng),
    name,
    display_name: addressParts.length > 0
      ? `${name}, ${addressParts.join(", ")}`
      : name,
    category: "railway",
    type: "station",
    osm_type: element.type || "node",
    osm_id: element.id,
    namedetails: { name },
    address: {
      province: tags["addr:province"] || "",
      state: tags["addr:province"] || ""
    }
  };
}

function dedupeStations(results) {
  const seen = new Set();
  const unique = [];

  results.forEach(result => {
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    const name = (result.namedetails?.name || result.name || "").trim();
    const key = `${name}|${lat.toFixed(5)}|${lng.toFixed(5)}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(result);
    }
  });

  return unique;
}

async function searchStationsInCurrentArea() {
  const button = document.getElementById("areaStationSearchButton");
  const panel = document.getElementById("searchPanel");
  const status = document.getElementById("searchStatus");
  const resultsContainer = document.getElementById("stationSearchResults");

  panel.classList.remove("hidden");
  searchLayer.clearLayers();
  resultsContainer.innerHTML = "";

  if (map.getZoom() < MIN_AREA_SEARCH_ZOOM) {
    status.textContent =
      `地図をもう少し拡大してください。ズーム ${MIN_AREA_SEARCH_ZOOM} 以上で検索できます。`;
    return;
  }

  const bounds = map.getBounds();
  const south = bounds.getSouth().toFixed(6);
  const west = bounds.getWest().toFixed(6);
  const north = bounds.getNorth().toFixed(6);
  const east = bounds.getEast().toFixed(6);

  const query = `
[out:json][timeout:20];
(
  node["railway"="station"](${south},${west},${north},${east});
  way["railway"="station"](${south},${west},${north},${east});
  relation["railway"="station"](${south},${west},${north},${east});
);
out center tags;
`;

  status.textContent = "現在の地図範囲から駅を検索中...";
  button.disabled = true;

  try {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "application/json"
      },
      body: new URLSearchParams({ data: query })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    const stations = dedupeStations(
      (data.elements || [])
        .map(overpassElementToSearchResult)
        .filter(Boolean)
        .filter(result => {
          const name = result.namedetails?.name || result.name || "";
          return name !== "名称不明の駅";
        })
    );

    if (stations.length === 0) {
      status.textContent =
        "この範囲には駅が見つかりませんでした。地図を移動するか、少し範囲を広げてください。";
      return;
    }

    const limited = stations.slice(0, MAX_AREA_SEARCH_RESULTS);

    status.textContent =
      stations.length > MAX_AREA_SEARCH_RESULTS
        ? `${stations.length}件見つかりました。負荷を抑えるため先頭${MAX_AREA_SEARCH_RESULTS}件を表示します。`
        : `${stations.length}件の駅が見つかりました。青いマーカーまたは一覧から選べます。`;

    renderStationResults(limited);
    showAreaSearchMarkers(limited);

    const note = document.createElement("div");
    note.className = "area-search-note";
    note.textContent =
      "検索結果は一時表示です。「＋ ラリーに追加」を押した駅だけが保存されます。";
    resultsContainer.prepend(note);
  } catch (error) {
    console.error(error);
    status.textContent =
      "範囲検索に失敗しました。Overpass APIが混雑している可能性があります。少し時間をおいて再度お試しください。";
  } finally {
    button.disabled = false;
  }
}


function buildRallySelectOptions(selectedRallyId = "") {
  return stampRallies.map(rally =>
    `<option value="${rally.id}" ${rally.id === selectedRallyId ? "selected" : ""}>${escapeHtml(rally.name)}</option>`
  ).join("");
}

function buildRallyCheckboxOptions(namePrefix, selectedIds = []) {
  if (stampRallies.length === 0) {
    return `<div class="no-rallies-note">先に右側の「ラリー管理」からラリーを作成してください。</div>`;
  }

  return stampRallies.map(rally => `
    <label class="rally-multi-option">
      <input
        type="checkbox"
        name="${escapeHtml(namePrefix)}"
        value="${rally.id}"
        ${selectedIds.includes(rally.id) ? "checked" : ""}
      >
      <span>${escapeHtml(rally.name)}</span>
    </label>
  `).join("");
}


function createSearchResultPopup(result, name) {
  const prefecture = getPrefecture(result);
  const osmType = result.osm_type || "unknown";
  const osmId = String(result.osm_id || "");
  const lat = Number(result.lat);
  const lng = Number(result.lon);

  return `
    <div class="popup-content">
      <div class="popup-title">${escapeHtml(name)}</div>
      <div class="popup-row">${escapeHtml(prefecture || "駅検索結果")}</div>

      <div class="search-popup-controls">
        <div>追加先ラリー（複数選択可）</div>
        <div class="rally-multi-select">
          ${buildRallyCheckboxOptions(`popup-${osmType}-${osmId}`)}
        </div>

        <button
          type="button"
          class="search-popup-add-button"
          data-name="${escapeHtml(name)}"
          data-prefecture="${escapeHtml(prefecture)}"
          data-lat="${lat}"
          data-lng="${lng}"
          data-osm-type="${escapeHtml(osmType)}"
          data-osm-id="${escapeHtml(osmId)}"
          ${stampRallies.length === 0 ? "disabled" : ""}
        >
          ＋ 選択したラリーに追加
        </button>
      </div>
    </div>
  `;
}

function addStationFromSearchPopup(button) {
  const popupContent = button.closest(".popup-content");
  if (!popupContent) return;

  const selectedIds = [...popupContent.querySelectorAll(
    '.rally-multi-select input[type="checkbox"]:checked'
  )].map(input => input.value);

  if (selectedIds.length === 0) {
    alert("追加先ラリーを1つ以上選択してください。");
    return;
  }

  const stationBase = {
    name: button.dataset.name,
    prefecture: button.dataset.prefecture || "",
    lat: Number(button.dataset.lat),
    lng: Number(button.dataset.lng),
    osmType: button.dataset.osmType || "unknown",
    osmId: button.dataset.osmId || `${Date.now()}`
  };

  let added = 0;

  selectedIds.forEach(rallyId => {
    if (addStationToRally({ ...stationBase, rallyId }, null)) {
      added++;
    }
  });

  button.textContent = added > 0 ? `${added}件追加しました` : "すべて追加済み";
  buildRegisteredStationList();
}


function showAreaSearchMarkers(results) {
  searchLayer.clearLayers();

  results.forEach(result => {
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    const name = result.namedetails?.name || normalizeStationName(result);

    const marker = L.marker([lat, lng], {
      icon: createSearchIcon(),
      title: name
    }).addTo(searchLayer);

    marker.bindPopup(createSearchResultPopup(result, name));
  });
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


    card.innerHTML = `
      <div class="station-result-name">${escapeHtml(name)}</div>
      <div class="station-result-address">${escapeHtml(addressText)}</div>

      <div class="rally-multi-select station-card-rallies">
        ${buildRallyCheckboxOptions(`card-${osmType}-${osmId}`)}
      </div>

      <div class="station-result-actions">
        <div></div>
        <button type="button" class="add-station-button" ${stampRallies.length === 0 ? "disabled" : ""}>
          ＋ 選択したラリーに追加
        </button>
      </div>

      <div class="station-result-subactions">
        <button type="button" class="show-station-button">地図で表示</button>
      </div>
    `;

    const showButton = card.querySelector(".show-station-button");
    const addButton = card.querySelector(".add-station-button");

    showButton.addEventListener("click", () => {
      showSearchResultOnMap(result, name);
    });

    addButton.addEventListener("click", () => {
      const selectedIds = [...card.querySelectorAll(
        '.station-card-rallies input[type="checkbox"]:checked'
      )].map(input => input.value);

      if (selectedIds.length === 0) {
        alert("追加先ラリーを1つ以上選択してください。");
        return;
      }

      let added = 0;

      selectedIds.forEach(rallyId => {
        if (addStationToRally({
          rallyId,
          name,
          prefecture,
          lat,
          lng,
          osmType,
          osmId
        }, null)) {
          added++;
        }
      });

      addButton.textContent = added > 0 ? `${added}件追加しました` : "すべて追加済み";
      buildRegisteredStationList();
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

  marker.bindPopup(createSearchResultPopup(result, name)).openPopup();

  map.setView([lat, lng], 15);
}

function addStationToRally(station, button) {
  const rally = stampRallies.find(r => r.id === station.rallyId);
  if (!rally) return false;

  const id = makeCustomCheckpointId(station.rallyId, station.osmType, station.osmId);
  const stationKey = makeStationKey(station.osmType, station.osmId);

  if (rally.checkpoints.some(cp => cp.id === id)) {
    if (button) {
      button.textContent = "追加済み";
      button.disabled = true;
    }
    return false;
  }

  const sharedVisitedCheckpoint = stampRallies
    .flatMap(r => r.checkpoints)
    .find(cp => getCheckpointVisitKey(cp) === stationKey);

  const checkpoint = {
    id,
    name: station.name,
    prefecture: station.prefecture,
    lat: station.lat,
    lng: station.lng,
    visited: sharedVisitedCheckpoint ? sharedVisitedCheckpoint.visited : false,
    custom: true,
    osmType: station.osmType,
    osmId: station.osmId,
    stationKey
  };

  rally.checkpoints.push(checkpoint);
  addCheckpointMarker(rally, checkpoint);

  saveCustomCheckpoints();
  saveVisitedStates();
  buildProgress();
  buildRallyManager();
  buildRegisteredStationList();

  if (button) {
    button.textContent = "追加しました";
    button.disabled = true;
  }

  map.setView([checkpoint.lat, checkpoint.lng], 15);

  const marker = checkpointMarkers[checkpoint.id];
  if (marker) marker.openPopup();

  return true;
}

document.addEventListener("click", event => {
  const visitButton = event.target.closest(".visit-toggle-button");
  if (visitButton) {
    toggleVisited(visitButton.dataset.rallyId, visitButton.dataset.checkpointId);
    return;
  }

  const editSaveButton = event.target.closest(".custom-edit-save");
  if (editSaveButton) {
    saveCustomCheckpointEdit(editSaveButton);
    return;
  }

  const checkpointDeleteButton = event.target.closest(".custom-edit-delete");
  if (checkpointDeleteButton) {
    deleteCustomCheckpoint(checkpointDeleteButton);
    return;
  }

  const rallySaveButton = event.target.closest(".rally-manager-save");
  if (rallySaveButton) {
    renameRally(rallySaveButton);
    return;
  }

  const rallyDeleteButton = event.target.closest(".rally-manager-delete");
  if (rallyDeleteButton) {
    deleteRally(rallyDeleteButton);
    return;
  }

  const registeredShowButton = event.target.closest(".registered-station-show");
  if (registeredShowButton) {
    showRegisteredStation(
      registeredShowButton.dataset.rallyId,
      registeredShowButton.dataset.checkpointId
    );
    return;
  }

  const searchAddButton = event.target.closest(".search-popup-add-button");
  if (searchAddButton) {
    addStationFromSearchPopup(searchAddButton);
  }
});

document.getElementById("createRallyButton").addEventListener("click", createRally);

document.getElementById("newRallyName").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    createRally();
  }
});


document.getElementById("stationSearchButton").addEventListener("click", searchStations);
document.getElementById("areaStationSearchButton").addEventListener("click", searchStationsInCurrentArea);

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

loadRallySettings();
loadCustomCheckpoints();
loadSavedVisitedStates();
buildLayers();
buildRallyManager();
buildFilters();
buildProgress();
buildRegisteredStationList();
