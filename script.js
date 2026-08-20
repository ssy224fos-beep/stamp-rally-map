const VISITED_STORAGE_KEY = "stampRallyMapVisitedShared_v2";
const CUSTOM_STORAGE_KEY = "stampRallyMapCustomCheckpoints_v2";
const RALLY_STORAGE_KEY = "stampRallyMapRallies_v2";
const RALLY_STATION_ENTRY_COMPLETE_STORAGE_KEY = "stampRallyMapStationEntryComplete_v1";
const SEARCH_RESULTS_STORAGE_KEY = "stampRallyMapSearchResults_v1";
const IGNORED_STATIONS_STORAGE_KEY = "stampRallyMapIgnoredStations_v1";

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

// 作成直後の空ラリーは、このページを開いている間だけ右ペインに残す。
// リロードすると自然に空になり、「この範囲の駅を検索」実行時にもクリアする。
const newlyCreatedEmptyRallyIds = new Set();

// ラリーカードの展開状態を再描画後も維持する。
const openRallyCardIds = new Set();

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

function loadStationEntryCompleteStates() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(RALLY_STATION_ENTRY_COMPLETE_STORAGE_KEY) || "{}"
    );
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    console.warn("駅登録完了状態を読み込めませんでした。", error);
    return {};
  }
}

function saveStationEntryCompleteStates(states) {
  try {
    localStorage.setItem(
      RALLY_STATION_ENTRY_COMPLETE_STORAGE_KEY,
      JSON.stringify(states)
    );
  } catch (error) {
    console.warn("駅登録完了状態を保存できませんでした。", error);
  }
}

function isStationEntryComplete(rallyId) {
  const states = loadStationEntryCompleteStates();
  return Boolean(states[rallyId]);
}

function setStationEntryComplete(rallyId, completed) {
  const states = loadStationEntryCompleteStates();

  if (completed) {
    states[rallyId] = true;
  } else {
    delete states[rallyId];
  }

  saveStationEntryCompleteStates(states);

  // チェック操作中のカードを閉じない。
  openRallyCardIds.add(rallyId);

  buildRallyDashboard();
}

function deleteStationEntryCompleteState(rallyId) {
  const states = loadStationEntryCompleteStates();
  if (Object.prototype.hasOwnProperty.call(states, rallyId)) {
    delete states[rallyId];
    saveStationEntryCompleteStates(states);
  }
}

function makeNewRallyId() {
  return `rally-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}


function makeStationKey(osmType, osmId) {
  return `${osmType || "unknown"}:${osmId || ""}`;
}

function buildKnownStationMetadataMap() {
  const mapByKey = new Map();

  const addCheckpointItems = raw => {
    try {
      const items = JSON.parse(raw || "[]");
      if (!Array.isArray(items)) return;

      items.forEach(item => {
        const key =
          item.stationKey ||
          makeStationKey(item.osmType, item.osmId);

        if (!key) return;

        const current = mapByKey.get(key) || {};
        mapByKey.set(key, {
          name: item.name || current.name || "",
          prefecture: item.prefecture || current.prefecture || "",
          result: current.result || {
            lat: String(item.lat ?? ""),
            lon: String(item.lng ?? ""),
            name: item.name || "",
            display_name: item.name || "",
            category: "railway",
            type: "station",
            osm_type: item.osmType || "unknown",
            osm_id: String(item.osmId || ""),
            namedetails: { name: item.name || "" },
            address: item.prefecture ? { province: item.prefecture } : {}
          }
        });
      });
    } catch (error) {
      console.warn("駅名復元用データの読み込みに失敗しました。", error);
    }
  };

  addCheckpointItems(localStorage.getItem(CUSTOM_STORAGE_KEY));
  addCheckpointItems(localStorage.getItem(LEGACY_CUSTOM_STORAGE_KEY));

  try {
    const searchResults = JSON.parse(
      localStorage.getItem(SEARCH_RESULTS_STORAGE_KEY) || "[]"
    );

    if (Array.isArray(searchResults)) {
      searchResults.forEach(result => {
        const key = getSearchResultStationKey(result);
        if (!key) return;

        const current = mapByKey.get(key) || {};
        mapByKey.set(key, {
          name:
            result.namedetails?.name ||
            result.name ||
            result.display_name?.split(",")[0] ||
            current.name ||
            "",
          prefecture: getPrefecture(result) || current.prefecture || "",
          result
        });
      });
    }
  } catch (error) {
    console.warn("駅名復元用の検索データを読み込めませんでした。", error);
  }

  return mapByKey;
}

function enrichIgnoredStations(items) {
  const known = buildKnownStationMetadataMap();
  let changed = false;

  const enriched = items.map(item => {
    const meta = known.get(item.key);
    if (!meta) return item;

    const looksLikeCode =
      !item.name ||
      item.name === item.key ||
      /^[a-z]+:\d+$/i.test(item.name);

    const next = {
      ...item,
      name: looksLikeCode && meta.name ? meta.name : item.name,
      prefecture: item.prefecture || meta.prefecture || "",
      result: item.result || meta.result || null
    };

    if (
      next.name !== item.name ||
      next.prefecture !== item.prefecture ||
      next.result !== item.result
    ) {
      changed = true;
    }

    return next;
  });

  if (changed) {
    saveIgnoredStations(enriched);
  }

  return enriched;
}

function loadIgnoredStations() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(IGNORED_STATIONS_STORAGE_KEY) || "[]"
    );

    if (!Array.isArray(saved)) return [];

    // Phase 8.5 以前の ["node:123", ...] 形式も引き継ぐ
    return saved.map(item => {
      if (typeof item === "string") {
        return {
          key: item,
          name: item,
          prefecture: "",
          result: null
        };
      }

      return {
        key: item.key || "",
        name: item.name || item.key || "駅",
        prefecture: item.prefecture || "",
        result: item.result || null
      };
    }).filter(item => item.key);
  } catch (error) {
    console.warn("登録不要駅データを読み込めませんでした。", error);
    return [];
  }
}

function saveIgnoredStations(items) {
  try {
    localStorage.setItem(
      IGNORED_STATIONS_STORAGE_KEY,
      JSON.stringify(items)
    );
  } catch (error) {
    console.warn("登録不要駅データを保存できませんでした。", error);
  }
}

function loadIgnoredStationKeys() {
  return new Set(loadIgnoredStations().map(item => item.key));
}

function saveIgnoredStationKeys(set) {
  const existing = loadIgnoredStations();
  const byKey = new Map(existing.map(item => [item.key, item]));

  const items = [...set].map(key =>
    byKey.get(key) || {
      key,
      name: key,
      prefecture: "",
      result: null
    }
  );

  saveIgnoredStations(items);
}


function getSearchResultStationKey(result) {
  return makeStationKey(
    result.osm_type || result.osmType || "unknown",
    String(result.osm_id || result.osmId || "")
  );
}

function isIgnoredStation(result) {
  const ignored = loadIgnoredStationKeys();
  return ignored.has(getSearchResultStationKey(result));
}

function removeSearchResultFromPersistentStorage(stationKey) {
  const saved = loadPersistentSearchResults();
  const filtered = saved.filter(result => getSearchResultStationKey(result) !== stationKey);
  savePersistentSearchResults(filtered);
}

function markStationIgnored(result, marker = null) {
  const key = getSearchResultStationKey(result);

  const ignoredItems = loadIgnoredStations()
    .filter(item => item.key !== key);

  ignoredItems.push({
    key,
    name:
      result.namedetails?.name ||
      result.name ||
      result.display_name?.split(",")[0] ||
      "駅",
    prefecture: getPrefecture(result),
    result: sanitizeSearchResultForStorage(result)
  });

  saveIgnoredStations(ignoredItems);

  // 選択直後だけグレー表示
  if (marker) {
    marker.setIcon(L.divIcon({
      className: "",
      html: `<div class="search-result-marker ignored"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -12]
    }));

    marker.setPopupContent(`
      <div class="popup-content">
        <div class="popup-title">${escapeHtml(
          result.namedetails?.name ||
          result.name ||
          result.display_name?.split(",")[0] ||
          "駅"
        )}</div>
        <div class="popup-row">登録不要に設定しました。</div>
        <div class="popup-row">右ペインの「登録不要駅」から元に戻せます。</div>
      </div>
    `);
  }

  removeSearchResultFromPersistentStorage(key);
  buildIgnoredStationList();
}


function makeCustomCheckpointId(rallyId, osmType, osmId) {
  return `custom-${rallyId}-${osmType}-${osmId}`;
}

function loadCustomCheckpoints() {
  try {
    const currentRaw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_CUSTOM_STORAGE_KEY);
    const saved = JSON.parse(currentRaw || legacyRaw || "[]");

    const ignoredKeys = loadIgnoredStationKeys();

    saved.forEach(item => {
      const itemStationKey =
        item.stationKey || makeStationKey(item.osmType, item.osmId);

      // 登録不要になっている駅は、古い保存データが残っていても復元しない。
      if (ignoredKeys.has(itemStationKey)) return;

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

function normalizeStationLabel(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[（）()]/g, "")
    .toLowerCase();
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function findExistingStationMatch(stationLike) {
  const osmType = stationLike.osmType || stationLike.osm_type || "unknown";
  const osmId = String(stationLike.osmId || stationLike.osm_id || "");
  const exactKey = makeStationKey(osmType, osmId);

  const lat = Number(stationLike.lat);
  const lng = Number(stationLike.lng ?? stationLike.lon);
  const name = normalizeStationLabel(
    stationLike.name ||
    stationLike.namedetails?.name ||
    stationLike.display_name?.split(",")[0]
  );

  const all = stampRallies.flatMap(rally =>
    rally.checkpoints.map(checkpoint => ({ rally, checkpoint }))
  );

  const exact = all.find(item => getCheckpointVisitKey(item.checkpoint) === exactKey);
  if (exact) return exact;

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
    return null;
  }

  return all.find(item => {
    const checkpointName = normalizeStationLabel(item.checkpoint.name);
    if (checkpointName !== name) return false;

    return distanceMeters(
      lat,
      lng,
      Number(item.checkpoint.lat),
      Number(item.checkpoint.lng)
    ) <= 120;
  }) || null;
}

function getStationMembershipRallyIds(stationLike) {
  const existing = findExistingStationMatch(stationLike);
  if (!existing) return [];

  const key = getCheckpointVisitKey(existing.checkpoint);

  return stampRallies
    .filter(rally =>
      rally.checkpoints.some(checkpoint =>
        getCheckpointVisitKey(checkpoint) === key
      )
    )
    .map(rally => rally.id);
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

function createExistingStationAddPanel(rally, checkpoint) {
  const stationKey = getCheckpointVisitKey(checkpoint);

  const registeredRallyIds = stampRallies
    .filter(item =>
      item.checkpoints.some(cp => getCheckpointVisitKey(cp) === stationKey)
    )
    .map(item => item.id);

  // 現在地図範囲で追加候補になるラリーに加えて、
  // すでに登録済みのラリーは範囲外でも必ず表示する。
  const candidateMap = new Map();

  getRalliesAvailableForStationAddition().forEach(item => {
    candidateMap.set(item.id, item);
  });

  stampRallies
    .filter(item => registeredRallyIds.includes(item.id))
    .forEach(item => {
      candidateMap.set(item.id, item);
    });

  const candidates = sortRalliesJapanese([...candidateMap.values()]);

  if (candidates.length === 0) {
    return `
      <div class="existing-rally-add-panel">
        <div class="existing-rally-add-title">ラリー登録</div>
        <div class="custom-edit-hint">追加・削除できるラリーがありません。</div>
      </div>
    `;
  }

  const options = candidates.map(item => `
    <label class="rally-multi-option">
      <input
        type="checkbox"
        class="existing-rally-membership-checkbox"
        value="${item.id}"
        ${registeredRallyIds.includes(item.id) ? "checked" : ""}
      >
      <span>${escapeHtml(item.name)}</span>
      ${
        registeredRallyIds.includes(item.id)
          ? '<span class="registered-label">登録済み</span>'
          : ""
      }
    </label>
  `).join("");

  return `
    <div class="existing-rally-add-panel">
      <div class="existing-rally-add-title">ラリー登録</div>
      <div class="custom-edit-hint">
        チェックを付けると追加、外すとそのラリーから削除します。
      </div>

      <div class="rally-multi-select">
        ${options}
      </div>

      <button
        type="button"
        class="existing-rally-sync-button"
        data-rally-id="${rally.id}"
        data-checkpoint-id="${checkpoint.id}"
      >
        選択内容を反映
      </button>
    </div>
  `;
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

      <button
        type="button"
        class="registered-remove-button"
        data-rally-id="${rally.id}"
        data-checkpoint-id="${checkpoint.id}"
      >
        このラリーから削除
      </button>

      <button
        type="button"
        class="registered-ignore-button"
        data-rally-id="${rally.id}"
        data-checkpoint-id="${checkpoint.id}"
      >
        登録不要に変更
      </button>

      ${createExistingStationAddPanel(rally, checkpoint)}

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


function purgeStationFromCustomStorage(stationKey) {
  try {
    const currentRaw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    const saved = JSON.parse(currentRaw || "[]");

    if (!Array.isArray(saved)) return;

    const filtered = saved.filter(item => {
      const itemKey =
        item.stationKey || makeStationKey(item.osmType, item.osmId);
      return itemKey !== stationKey;
    });

    localStorage.setItem(
      CUSTOM_STORAGE_KEY,
      JSON.stringify(filtered)
    );
  } catch (error) {
    console.warn("登録駅データの削除に失敗しました。", error);
  }
}

function createIgnoredPreviewMarker(checkpoint) {
  const marker = L.marker(
    [checkpoint.lat, checkpoint.lng],
    {
      icon: L.divIcon({
        className: "",
        html: `<div class="search-result-marker ignored"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12]
      }),
      title: checkpoint.name
    }
  ).addTo(searchLayer);

  marker.bindPopup(`
    <div class="popup-content">
      <div class="popup-title">${escapeHtml(checkpoint.name)}</div>
      <div class="popup-row">登録不要に変更しました。</div>
      <div class="popup-row">
        次回の再読み込みや「この範囲の駅を検索」では表示されません。
      </div>
      <div class="popup-row">
        右ペインの「登録不要駅」から元に戻せます。
      </div>
    </div>
  `).openPopup();

  return marker;
}

function removeStationFromCurrentRally(button) {
  const rallyId = button.dataset.rallyId;
  const checkpointId = button.dataset.checkpointId;
  const result = findCheckpoint(rallyId, checkpointId);
  if (!result) return;

  const { rally, checkpoint } = result;
  const stationKey = getCheckpointVisitKey(checkpoint);

  const ok = confirm(
    `「${checkpoint.name}」を「${rally.name}」から削除しますか？\n` +
    `他のラリーに登録されている場合は、そちらには残ります。`
  );
  if (!ok) return;

  const index = rally.checkpoints.findIndex(cp => cp.id === checkpointId);
  if (index >= 0) {
    rally.checkpoints.splice(index, 1);
  }

  removeCheckpointMarker(checkpointId, rallyId);

  const stillRegisteredElsewhere = stampRallies.some(otherRally =>
    otherRally.checkpoints.some(cp =>
      getCheckpointVisitKey(cp) === stationKey
    )
  );

  if (!stillRegisteredElsewhere) {
    try {
      const savedVisited = JSON.parse(
        localStorage.getItem(VISITED_STORAGE_KEY) || "{}"
      );
      delete savedVisited[stationKey];
      localStorage.setItem(
        VISITED_STORAGE_KEY,
        JSON.stringify(savedVisited)
      );
    } catch (error) {
      console.warn("訪問済みデータの整理に失敗しました。", error);
    }
  }

  saveCustomCheckpoints();
  saveVisitedStates();

  buildRallyManager();
  buildFilters();
  buildProgress();
  buildRegisteredStationList();

  map.closePopup();
}

function changeRegisteredStationToIgnored(button) {
  const rallyId = button.dataset.rallyId;
  const checkpointId = button.dataset.checkpointId;
  const result = findCheckpoint(rallyId, checkpointId);
  if (!result) return;

  const { checkpoint } = result;
  const stationKey = getCheckpointVisitKey(checkpoint);

  const checkpointSnapshot = {
    name: checkpoint.name,
    prefecture: checkpoint.prefecture || "",
    lat: checkpoint.lat,
    lng: checkpoint.lng,
    osmType: checkpoint.osmType || "unknown",
    osmId: String(checkpoint.osmId || ""),
    stationKey
  };

  const ok = confirm(
    `「${checkpoint.name}」を登録不要に変更しますか？\n` +
    `この駅は、登録されているすべてのラリーから削除されます。`
  );
  if (!ok) return;

  // まず検索候補レイヤーを整理し、あとでグレーの一時表示を1個だけ出す。
  searchLayer.clearLayers();

  // 同じ駅をすべてのラリーから削除。
  stampRallies.forEach(rally => {
    for (let i = rally.checkpoints.length - 1; i >= 0; i--) {
      const cp = rally.checkpoints[i];
      if (getCheckpointVisitKey(cp) !== stationKey) continue;

      removeCheckpointMarker(cp.id, rally.id);
      rally.checkpoints.splice(i, 1);
    }
  });

  // 保存済み登録駅データからも直接削除。
  purgeStationFromCustomStorage(stationKey);

  // 訪問済み共有データから削除。
  try {
    const savedVisited = JSON.parse(
      localStorage.getItem(VISITED_STORAGE_KEY) || "{}"
    );
    delete savedVisited[stationKey];
    localStorage.setItem(
      VISITED_STORAGE_KEY,
      JSON.stringify(savedVisited)
    );
  } catch (error) {
    console.warn("訪問済みデータの整理に失敗しました。", error);
  }

  // 登録不要として保存。
  const ignoredItems = loadIgnoredStations()
    .filter(item => item.key !== stationKey);

  ignoredItems.push({
    key: stationKey,
    name: checkpointSnapshot.name,
    prefecture: checkpointSnapshot.prefecture,
    result: sanitizeSearchResultForStorage({
      lat: checkpointSnapshot.lat,
      lon: checkpointSnapshot.lng,
      name: checkpointSnapshot.name,
      display_name: checkpointSnapshot.name,
      category: "railway",
      type: "station",
      osm_type: checkpointSnapshot.osmType,
      osm_id: checkpointSnapshot.osmId,
      namedetails: { name: checkpointSnapshot.name },
      address: checkpointSnapshot.prefecture
        ? { province: checkpointSnapshot.prefecture }
        : {}
    })
  });

  saveIgnoredStations(ignoredItems);

  // 念のため現在状態から保存データを再構築。
  saveCustomCheckpoints();
  saveVisitedStates();

  // 青検索結果の永続保存からも取り除く。
  removeSearchResultFromPersistentStorage(stationKey);

  buildRallyManager();
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
  buildIgnoredStationList();

  // 変更直後だけグレーで確認できるようにする。
  createIgnoredPreviewMarker(checkpointSnapshot);
}

function syncExistingStationRallies(button) {
  const sourceRallyId = button.dataset.rallyId;
  const checkpointId = button.dataset.checkpointId;
  const result = findCheckpoint(sourceRallyId, checkpointId);
  if (!result) return;

  const popup = button.closest(".popup-content");
  if (!popup) return;

  const sourceCheckpoint = result.checkpoint;
  const stationKey = getCheckpointVisitKey(sourceCheckpoint);

  const selectedRallyIds = new Set(
    [...popup.querySelectorAll(
      '.existing-rally-membership-checkbox:checked'
    )].map(input => input.value)
  );

  const currentlyRegisteredRallies = stampRallies.filter(rally =>
    rally.checkpoints.some(cp =>
      getCheckpointVisitKey(cp) === stationKey
    )
  );

  const currentlyRegisteredIds = new Set(
    currentlyRegisteredRallies.map(rally => rally.id)
  );

  // 新しくチェックされたラリーへ追加。
  selectedRallyIds.forEach(rallyId => {
    if (currentlyRegisteredIds.has(rallyId)) return;

    addStationToRally({
      rallyId,
      name: sourceCheckpoint.name,
      prefecture: sourceCheckpoint.prefecture,
      lat: sourceCheckpoint.lat,
      lng: sourceCheckpoint.lng,
      osmType: sourceCheckpoint.osmType,
      osmId: sourceCheckpoint.osmId
    }, null);
  });

  // チェックを外された登録済みラリーから削除。
  currentlyRegisteredRallies.forEach(rally => {
    if (selectedRallyIds.has(rally.id)) return;

    const index = rally.checkpoints.findIndex(cp =>
      getCheckpointVisitKey(cp) === stationKey
    );

    if (index < 0) return;

    const [removed] = rally.checkpoints.splice(index, 1);
    removeCheckpointMarker(removed.id, rally.id);
  });

  const stillRegistered = stampRallies.some(rally =>
    rally.checkpoints.some(cp =>
      getCheckpointVisitKey(cp) === stationKey
    )
  );

  // どのラリーにも残らなかった場合は共有訪問済み状態も削除。
  if (!stillRegistered) {
    try {
      const savedVisited = JSON.parse(
        localStorage.getItem(VISITED_STORAGE_KEY) || "{}"
      );
      delete savedVisited[stationKey];
      localStorage.setItem(
        VISITED_STORAGE_KEY,
        JSON.stringify(savedVisited)
      );
    } catch (error) {
      console.warn("訪問済みデータの整理に失敗しました。", error);
    }
  }

  saveCustomCheckpoints();
  saveVisitedStates();

  buildRallyDashboard();
  buildIgnoredStationList();

  map.closePopup();

  // まだいずれかのラリーに登録されている場合は、
  // そのうち1つのマーカーを開き直して最新状態を表示。
  if (stillRegistered) {
    const remaining = stampRallies
      .flatMap(rally =>
        rally.checkpoints.map(cp => ({ rally, cp }))
      )
      .find(item =>
        getCheckpointVisitKey(item.cp) === stationKey
      );

    if (remaining) {
      openRallyCardIds.add(remaining.rally.id);

      const marker = checkpointMarkers[remaining.cp.id];
      if (marker) {
        marker.setPopupContent(
          createPopup(remaining.rally, remaining.cp)
        );
        marker.openPopup();
      }
    }
  }
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


function updateVisibleRalliesMasterCheckbox() {
  const master = document.getElementById("visibleRalliesMasterCheckbox");
  if (!master) return;

  const rallies = getViewportFilteredRallies();

  if (rallies.length === 0) {
    master.checked = false;
    master.indeterminate = false;
    master.disabled = true;
    return;
  }

  master.disabled = false;

  const selectedCount = rallies.filter(rally =>
    rallyLayers[rally.id] && map.hasLayer(rallyLayers[rally.id])
  ).length;

  master.checked = selectedCount === rallies.length;
  master.indeterminate =
    selectedCount > 0 && selectedCount < rallies.length;
}

function setAllVisibleRalliesMapVisibility(visible) {
  const rallies = getViewportFilteredRallies();

  rallies.forEach(rally => {
    const layer = rallyLayers[rally.id];
    if (!layer) return;

    if (visible) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map);
      }
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  });

  buildRallyDashboard();
}

function buildRallyDashboard() {
  const container = document.getElementById("rallyDashboardList");
  if (!container) return;

  const rallies = getViewportFilteredRallies();
  const rawFilter = getRallyListFilterValue();
  const achievement = getRallyAchievementFilterValue();

  container.innerHTML = "";

  if (stampRallies.length === 0) {
    container.innerHTML = `
      <div class="rally-dashboard-empty">
        まだラリーがありません。「新しいラリー名」を入力して作成してください。
      </div>
    `;
  } else if (rallies.length === 0) {
    container.innerHTML = `
      <div class="rally-dashboard-empty">
        表示条件に一致するラリーはありません。
      </div>
    `;
  }

  rallies.forEach(rally => {
    const total = rally.checkpoints.length;
    const visited = rally.checkpoints.filter(cp => cp.visited).length;
    const percent = total === 0 ? 0 : Math.round((visited / total) * 100);
    const stationEntryComplete = isStationEntryComplete(rally.id);

    const card = document.createElement("div");
    card.className = "rally-dashboard-card";
    if (openRallyCardIds.has(rally.id)) {
      card.classList.add("open");
    }
    card.dataset.rallyId = rally.id;

    const stationRows = rally.checkpoints.length === 0
      ? `<div class="rally-dashboard-empty">登録駅はまだありません。</div>`
      : rally.checkpoints.map((checkpoint, index) => `
          <div class="registered-station-row">
            <span class="registered-station-status ${checkpoint.visited ? "visited" : "unvisited"}"></span>

            <div class="registered-station-main">
              <div class="registered-station-name">${escapeHtml(checkpoint.name)}</div>
              <div class="registered-station-prefecture">${escapeHtml(checkpoint.prefecture || "")}</div>
            </div>

            <div class="registered-station-order">
              <button
                type="button"
                class="registered-station-move"
                data-direction="up"
                data-rally-id="${rally.id}"
                data-checkpoint-id="${checkpoint.id}"
                ${index === 0 ? "disabled" : ""}
                title="1つ上へ"
              >↑</button>

              <button
                type="button"
                class="registered-station-move"
                data-direction="down"
                data-rally-id="${rally.id}"
                data-checkpoint-id="${checkpoint.id}"
                ${index === rally.checkpoints.length - 1 ? "disabled" : ""}
                title="1つ下へ"
              >↓</button>
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

    card.innerHTML = `
      <div class="rally-dashboard-header">
        <div class="rally-dashboard-top">
          <input
            type="checkbox"
            class="rally-dashboard-visible"
            data-rally-id="${rally.id}"
            ${rallyLayers[rally.id] && map.hasLayer(rallyLayers[rally.id]) ? "checked" : ""}
            aria-label="${escapeHtml(rally.name)}を地図に表示"
          >

          <div class="rally-dashboard-name" title="${escapeHtml(rally.name)}">
            ${escapeHtml(rally.name)}
            ${isTransientNewEmptyRally(rally) ? '<span class="new-rally-note">（新規・0駅）</span>' : ""}
          </div>

          <div class="rally-dashboard-status">
            ${stationEntryComplete ? '<span class="station-entry-complete-badge">駅登録完了</span>' : ""}
          </div>

          <div class="rally-dashboard-count">${visited} / ${total}</div>

          <button
            type="button"
            class="rally-dashboard-toggle"
            aria-label="${escapeHtml(rally.name)}の詳細を開閉"
          >⌄</button>
        </div>

        <div class="rally-dashboard-progress">
          <div class="progress-track">
            <div class="progress-bar" style="width:${percent}%"></div>
          </div>
        </div>
      </div>

      <div class="rally-dashboard-body">
        <div class="rally-dashboard-management">
          <input
            type="text"
            class="rally-manager-name"
            value="${escapeHtml(rally.name)}"
            maxlength="60"
          >

          <button
            type="button"
            class="rally-manager-save"
            data-rally-id="${rally.id}"
          >
            名称保存
          </button>

          <button
            type="button"
            class="rally-manager-delete"
            data-rally-id="${rally.id}"
          >
            削除
          </button>
        </div>

        <label class="station-entry-complete-control">
          <input
            type="checkbox"
            class="station-entry-complete-checkbox"
            data-rally-id="${rally.id}"
            ${stationEntryComplete ? "checked" : ""}
          >
          <span>駅登録完了</span>
        </label>

        <div class="rally-dashboard-stations">
          ${stationRows}
        </div>
      </div>
    `;

    const visibleCheckbox = card.querySelector(".rally-dashboard-visible");
    visibleCheckbox.addEventListener("change", () => {
      const layer = rallyLayers[rally.id];
      if (!layer) return;

      if (visibleCheckbox.checked) {
        layer.addTo(map);
      } else {
        map.removeLayer(layer);
      }

      updateVisibleRalliesMasterCheckbox();
    });

    const toggle = card.querySelector(".rally-dashboard-toggle");
    toggle.addEventListener("click", () => {
      card.classList.toggle("open");

      if (card.classList.contains("open")) {
        openRallyCardIds.add(rally.id);
      } else {
        openRallyCardIds.delete(rally.id);
      }
    });

    const stationEntryCheckbox = card.querySelector(".station-entry-complete-checkbox");
    stationEntryCheckbox.addEventListener("change", () => {
      setStationEntryComplete(rally.id, stationEntryCheckbox.checked);
    });

    container.appendChild(card);
  });

  const summary = document.getElementById("rallyFilterSummary");
  if (summary) {
    const hasFilter =
      Boolean(rawFilter) ||
      achievement !== "all" ||
      !shouldShowAllRallies();

    summary.textContent = hasFilter
      ? `${rallies.length} / ${stampRallies.length} 件を表示`
      : `${stampRallies.length} 件のラリー`;
  }

  let overallVisited = 0;
  let overallTotal = 0;

  rallies.forEach(rally => {
    overallVisited += rally.checkpoints.filter(cp => cp.visited).length;
    overallTotal += rally.checkpoints.length;
  });

  const overallCount = document.getElementById("overallCount");
  if (overallCount) {
    overallCount.textContent = `${overallVisited} / ${overallTotal}`;
  }

  const overallProgressBar = document.getElementById("overallProgressBar");
  if (overallProgressBar) {
    const percent =
      overallTotal === 0
        ? 0
        : Math.round((overallVisited / overallTotal) * 100);

    overallProgressBar.style.width = `${percent}%`;
  }

  updateVisibleRalliesMasterCheckbox();
}

function buildFilters() {
  buildRallyDashboard();
}

function refreshSearchRallySelects() {
  // 検索候補内のラリー選択欄は検索結果を再表示した際に最新化されます。
}


function normalizeRallyFilterText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function getRallyListFilterValue() {
  const input = document.getElementById("rallyListFilter");
  return input ? input.value.trim() : "";
}


const japaneseRallyCollator = new Intl.Collator("ja", {
  usage: "sort",
  sensitivity: "base",
  numeric: true
});

function sortRalliesJapanese(rallies) {
  return [...rallies].sort((a, b) =>
    japaneseRallyCollator.compare(a.name, b.name)
  );
}

function shouldShowAllRallies() {
  const checkbox = document.getElementById("showAllRalliesCheckbox");
  return Boolean(checkbox?.checked);
}

function isTransientNewEmptyRally(rally) {
  return rally.checkpoints.length === 0 &&
    newlyCreatedEmptyRallyIds.has(rally.id);
}

function rallyHasCheckpointInCurrentMap(rally) {
  if (!map || !map.getBounds) return true;

  const bounds = map.getBounds();

  return rally.checkpoints.some(checkpoint =>
    bounds.contains([checkpoint.lat, checkpoint.lng])
  );
}

function getRallyAchievementFilterValue() {
  const select = document.getElementById("rallyAchievementFilter");
  return select ? select.value : "all";
}

function isRallyCompleted(rally) {
  return rally.checkpoints.length > 0 &&
    rally.checkpoints.every(checkpoint => checkpoint.visited);
}

function getFilteredRallies() {
  const rawFilter = getRallyListFilterValue();
  const normalizedFilter = normalizeRallyFilterText(rawFilter);
  const achievement = getRallyAchievementFilterValue();

  const result = stampRallies.filter(rally => {
    const nameMatches = !normalizedFilter ||
      normalizeRallyFilterText(rally.name).includes(normalizedFilter);

    const completed = isRallyCompleted(rally);
    const statusMatches =
      achievement === "all" ||
      (achievement === "completed" && completed) ||
      (achievement === "incomplete" && !completed);

    return nameMatches && statusMatches;
  });

  return sortRalliesJapanese(result);
}

function getViewportFilteredRallies() {
  const filtered = getFilteredRallies();

  if (shouldShowAllRallies()) {
    return sortRalliesJapanese(filtered);
  }

  return sortRalliesJapanese(
    filtered.filter(rally =>
      rallyHasCheckpointInCurrentMap(rally) ||
      isTransientNewEmptyRally(rally)
    )
  );
}

function getRalliesAvailableForStationAddition() {
  return sortRalliesJapanese(
    stampRallies.filter(rally =>
      rally.checkpoints.length === 0 ||
      rallyHasCheckpointInCurrentMap(rally)
    )
  );
}


function applyRallyFiltersEverywhere() {
  buildRallyManager();
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
}

function buildRallyManager() {
  buildRallyDashboard();
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
  newlyCreatedEmptyRallyIds.add(rally.id);

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
  newlyCreatedEmptyRallyIds.delete(rallyId);
  openRallyCardIds.delete(rallyId);
  deleteStationEntryCompleteState(rallyId);

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
  buildRallyDashboard();
}

function moveRegisteredStation(rallyId, checkpointId, direction) {
  const rally = stampRallies.find(item => item.id === rallyId);
  if (!rally) return;

  const currentIndex = rally.checkpoints.findIndex(
    checkpoint => checkpoint.id === checkpointId
  );
  if (currentIndex < 0) return;

  const targetIndex =
    direction === "up"
      ? currentIndex - 1
      : currentIndex + 1;

  if (targetIndex < 0 || targetIndex >= rally.checkpoints.length) {
    return;
  }

  const [checkpoint] = rally.checkpoints.splice(currentIndex, 1);
  rally.checkpoints.splice(targetIndex, 0, checkpoint);

  // 操作中のラリーは展開状態を維持する。
  openRallyCardIds.add(rallyId);

  // checkpoints 配列の順序そのものを保存する。
  saveCustomCheckpoints();

  // 統合ラリーカードを再描画。
  buildRallyDashboard();
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

let ignoredStationNameResolveInProgress = false;

function isIgnoredStationNameCode(item) {
  const name = String(item?.name || "");
  return !name ||
    name === item.key ||
    /^(node|way|relation):\d+$/i.test(name);
}

function ignoredStationHasCoordinates(item) {
  const lat = Number(item?.result?.lat);
  const lng = Number(item?.result?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function ignoredStationIsInCurrentMap(item) {
  if (!ignoredStationHasCoordinates(item)) return false;

  return map.getBounds().contains([
    Number(item.result.lat),
    Number(item.result.lon)
  ]);
}

function osmKeyToNominatimId(key) {
  const match = String(key || "").match(/^(node|way|relation):(\d+)$/i);
  if (!match) return null;

  const prefix = {
    node: "N",
    way: "W",
    relation: "R"
  }[match[1].toLowerCase()];

  return `${prefix}${match[2]}`;
}

async function resolveLegacyIgnoredStationNames() {
  if (ignoredStationNameResolveInProgress) return;

  const items = loadIgnoredStations();
  const unresolved = items.filter(item =>
    isIgnoredStationNameCode(item) ||
    !ignoredStationHasCoordinates(item)
  );

  const lookupTargets = unresolved
    .map(item => ({
      item,
      osmLookupId: osmKeyToNominatimId(item.key)
    }))
    .filter(entry => entry.osmLookupId)
    .slice(0, 40);

  if (lookupTargets.length === 0) return;

  ignoredStationNameResolveInProgress = true;

  try {
    const params = new URLSearchParams({
      osm_ids: lookupTargets.map(entry => entry.osmLookupId).join(","),
      format: "jsonv2",
      addressdetails: "1",
      namedetails: "1",
      "accept-language": "ja"
    });

    const response = await fetch(
      `https://nominatim.openstreetmap.org/lookup?${params.toString()}`,
      { headers: { "Accept": "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const results = await response.json();
    const byKey = new Map();

    results.forEach(result => {
      const key = makeStationKey(
        result.osm_type || "unknown",
        String(result.osm_id || "")
      );
      byKey.set(key, result);
    });

    let changed = false;

    const updated = items.map(item => {
      const result = byKey.get(item.key);
      if (!result) return item;

      const stationName =
        result.namedetails?.name ||
        result.name ||
        result.display_name?.split(",")[0] ||
        item.name;

      const next = {
        ...item,
        name: stationName,
        prefecture: getPrefecture(result) || item.prefecture || "",
        result: sanitizeSearchResultForStorage(result)
      };

      if (
        next.name !== item.name ||
        next.prefecture !== item.prefecture ||
        !item.result
      ) {
        changed = true;
      }

      return next;
    });

    if (changed) {
      saveIgnoredStations(updated);
    }
  } catch (error) {
    console.warn("登録不要駅の駅名取得に失敗しました。", error);
  } finally {
    ignoredStationNameResolveInProgress = false;
    buildIgnoredStationList(false);
  }
}

function buildIgnoredStationList(resolveNames = true) {
  const container = document.getElementById("ignoredStationList");
  if (!container) return;

  const allItems = enrichIgnoredStations(loadIgnoredStations());

  const items = allItems
    .filter(item => ignoredStationIsInCurrentMap(item))
    .sort((a, b) =>
      japaneseRallyCollator.compare(a.name || "", b.name || "")
    );

  if (items.length === 0) {
    const unresolvedCount = allItems.filter(
      item => !ignoredStationHasCoordinates(item)
    ).length;

    container.innerHTML = `
      <div class="ignored-station-empty">
        ${
          unresolvedCount > 0
            ? "現在の地図範囲に表示できる登録不要駅はありません。旧データの駅名・位置情報を確認中です。"
            : "現在の地図範囲に登録不要駅はありません。"
        }
      </div>
    `;
  } else {
    container.innerHTML = items.map(item => `
      <div class="ignored-station-card">
        <div class="ignored-station-name">${escapeHtml(item.name || "駅")}</div>
        <div class="ignored-station-meta">${escapeHtml(item.prefecture || "")}</div>
        <button
          type="button"
          class="ignored-station-restore"
          data-station-key="${escapeHtml(item.key)}"
        >
          登録候補に戻す
        </button>
      </div>
    `).join("");
  }

  if (resolveNames) {
    const needsResolve = allItems.some(item =>
      isIgnoredStationNameCode(item) ||
      !ignoredStationHasCoordinates(item)
    );

    if (needsResolve) {
      resolveLegacyIgnoredStationNames();
    }
  }
}

function restoreIgnoredStation(stationKey) {
  const items = loadIgnoredStations();
  const target = items.find(item => item.key === stationKey);

  saveIgnoredStations(
    items.filter(item => item.key !== stationKey)
  );

  if (target?.result) {
    const existingResults = loadPersistentSearchResults()
      .filter(result => getSearchResultStationKey(result) !== stationKey);

    existingResults.push(target.result);
    savePersistentSearchResults(existingResults);
    showAreaSearchMarkers(existingResults, false);

    const lat = Number(target.result.lat);
    const lng = Number(target.result.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.setView([lat, lng], Math.max(map.getZoom(), 14));
    }
  }

  buildIgnoredStationList();
}

function buildProgress() {
  buildRallyDashboard();
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
  newlyCreatedEmptyRallyIds.clear();
  applyRallyFiltersEverywhere();

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
        .filter(result => !isIgnoredStation(result))
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
  return getRalliesAvailableForStationAddition().map(rally =>
    `<option value="${rally.id}" ${rally.id === selectedRallyId ? "selected" : ""}>${escapeHtml(rally.name)}</option>`
  ).join("");
}

function buildRallyCheckboxOptions(namePrefix, selectedIds = [], disabledIds = []) {
  const availableRallies = getRalliesAvailableForStationAddition();

  if (availableRallies.length === 0) {
    return `<div class="no-rallies-note">先に右側の「ラリー管理」からラリーを作成してください。</div>`;
  }

  return availableRallies.map(rally => {
    const isDisabled = disabledIds.includes(rally.id);
    const isChecked = selectedIds.includes(rally.id) || isDisabled;

    return `
      <label class="rally-multi-option ${isDisabled ? "already-registered" : ""}">
        <input
          type="checkbox"
          name="${escapeHtml(namePrefix)}"
          value="${rally.id}"
          ${isChecked ? "checked" : ""}
          ${isDisabled ? "disabled" : ""}
        >
        <span>${escapeHtml(rally.name)}</span>
        ${isDisabled ? '<span class="registered-label">登録済み</span>' : ""}
      </label>
    `;
  }).join("");
}


function createSearchResultPopup(result, name) {
  const prefecture = getPrefecture(result);
  const osmType = result.osm_type || "unknown";
  const osmId = String(result.osm_id || "");
  const lat = Number(result.lat);
  const lng = Number(result.lon);
  const registeredRallyIds = getStationMembershipRallyIds(result);
  const candidateRallies = getRalliesAvailableForStationAddition();
  const availableCount = candidateRallies.filter(
    rally => !registeredRallyIds.includes(rally.id)
  ).length;
  const stationKey = getSearchResultStationKey(result);

  return `
    <div class="popup-content">
      <div class="popup-title">${escapeHtml(name)}</div>
      <div class="popup-row">${escapeHtml(prefecture || "駅検索結果")}</div>

      <div class="search-popup-controls">
        <div>追加先ラリー（複数選択可）</div>
        <div class="rally-multi-select">
          ${buildRallyCheckboxOptions(
            `popup-${osmType}-${osmId}`,
            [],
            registeredRallyIds
          )}
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
          ${stampRallies.length === 0 || availableCount === 0 ? "disabled" : ""}
        >
          ${availableCount === 0 ? "すべてのラリーに登録済み" : "＋ 選択したラリーに追加"}
        </button>

        <button
          type="button"
          class="search-popup-ignore-button"
          data-name="${escapeHtml(name)}"
          data-lat="${lat}"
          data-lng="${lng}"
          data-osm-type="${escapeHtml(osmType)}"
          data-osm-id="${escapeHtml(osmId)}"
        >
          登録不要にする
        </button>
      </div>
    </div>
  `;
}

function ignoreStationFromSearchPopup(button) {
  const popupContent = button.closest(".popup-content");
  if (!popupContent) return;

  const result = {
    lat: button.dataset.lat,
    lon: button.dataset.lng,
    name: button.dataset.name || "",
    display_name: button.dataset.name || "",
    category: "railway",
    type: "station",
    osm_type: button.dataset.osmType || "unknown",
    osm_id: button.dataset.osmId || "",
    namedetails: { name: button.dataset.name || "" },
    address: {}
  };

  const marker = Object.values(searchLayer._layers || {}).find(layer => {
    if (!(layer instanceof L.Marker)) return false;
    const ll = layer.getLatLng();
    return Math.abs(ll.lat - Number(result.lat)) < 1e-7 &&
           Math.abs(ll.lng - Number(result.lon)) < 1e-7;
  });

  markStationIgnored(result, marker || null);
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



function sanitizeSearchResultForStorage(result) {
  return {
    lat: String(result.lat),
    lon: String(result.lon),
    name: result.name || result.namedetails?.name || "",
    display_name: result.display_name || "",
    category: result.category || "railway",
    type: result.type || "station",
    osm_type: result.osm_type || "unknown",
    osm_id: String(result.osm_id || ""),
    namedetails: { name: result.namedetails?.name || result.name || "" },
    address: result.address || {}
  };
}

function savePersistentSearchResults(results) {
  try {
    localStorage.setItem(
      SEARCH_RESULTS_STORAGE_KEY,
      JSON.stringify(results.map(sanitizeSearchResultForStorage))
    );
  } catch (error) {
    console.warn("駅検索結果の保存に失敗しました。", error);
  }
}

function loadPersistentSearchResults() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_RESULTS_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    console.warn("保存済み駅検索結果を読み込めませんでした。", error);
    return [];
  }
}

function restorePersistentSearchMarkers() {
  const saved = loadPersistentSearchResults()
    .filter(result => !isIgnoredStation(result));

  if (saved.length > 0) {
    showAreaSearchMarkers(saved, false);
  }
}

function showAreaSearchMarkers(results, persist = true) {
  searchLayer.clearLayers();

  if (persist) {
    savePersistentSearchResults(results);
  }

  results.forEach(result => {
    if (isIgnoredStation(result)) {
      return;
    }

    // すでにいずれかのラリーへ登録済みの駅は、
    // 既存の赤/緑マーカーをそのまま残し、青マーカーを重ねない。
    if (findExistingStationMatch(result)) {
      return;
    }

    const lat = Number(result.lat);
    const lng = Number(result.lon);
    const name = result.namedetails?.name || normalizeStationName(result);

    const marker = L.marker([lat, lng], {
      icon: createSearchIcon(),
      title: name
    }).addTo(searchLayer);

    marker.bindPopup(createSearchResultPopup(result, name));

    marker.on("popupopen", () => {
      marker.setPopupContent(createSearchResultPopup(result, name));
    });
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
    const stations = rawResults
      .filter(isLikelyStation)
      .filter(result => !isIgnoredStation(result));

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
    const registeredRallyIds = getStationMembershipRallyIds(result);
    const candidateRallies = getRalliesAvailableForStationAddition();
    const availableCount = candidateRallies.filter(
      rally => !registeredRallyIds.includes(rally.id)
    ).length;

    const card = document.createElement("div");
    card.className = "station-result-card";


    card.innerHTML = `
      <div class="station-result-name">${escapeHtml(name)}</div>
      <div class="station-result-address">${escapeHtml(addressText)}</div>

      <div class="rally-multi-select station-card-rallies">
        ${buildRallyCheckboxOptions(
          `card-${osmType}-${osmId}`,
          [],
          registeredRallyIds
        )}
      </div>

      <div class="station-result-actions">
        <div></div>
        <button
          type="button"
          class="add-station-button"
          ${stampRallies.length === 0 || availableCount === 0 ? "disabled" : ""}
        >
          ${availableCount === 0 ? "すべてのラリーに登録済み" : "＋ 選択したラリーに追加"}
        </button>
      </div>

      <div class="station-result-subactions">
        <button type="button" class="show-station-button">地図で表示</button>
      </div>

      <div class="station-result-status-row">
        <button type="button" class="station-ignore-button">登録不要にする</button>
      </div>
    `;

    const showButton = card.querySelector(".show-station-button");
    const addButton = card.querySelector(".add-station-button");
    const ignoreButton = card.querySelector(".station-ignore-button");

    showButton.addEventListener("click", () => {
      showSearchResultOnMap(result, name);
    });

    ignoreButton.addEventListener("click", () => {
      markStationIgnored(result, null);
      card.remove();

      const remainingCards = container.querySelectorAll(".station-result-card").length;
      const status = document.getElementById("searchStatus");
      if (status) {
        status.textContent = remainingCards > 0
          ? `${remainingCards}件の候補を表示しています。`
          : "表示できる駅候補がありません。";
      }

      // 地図上の同駅の青マーカーも消す
      Object.values(searchLayer._layers || {}).forEach(layer => {
        if (!(layer instanceof L.Marker)) return;
        const ll = layer.getLatLng();
        if (Math.abs(ll.lat - Number(result.lat)) < 1e-7 &&
            Math.abs(ll.lng - Number(result.lon)) < 1e-7) {
          searchLayer.removeLayer(layer);
        }
      });
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

  if (isIgnoredStation(result)) {
    return;
  }

  const existing = findExistingStationMatch(result);
  if (existing) {
    const layer = rallyLayers[existing.rally.id];
    if (layer && !map.hasLayer(layer)) {
      layer.addTo(map);
      buildFilters();
    }

    map.setView(
      [existing.checkpoint.lat, existing.checkpoint.lng],
      15
    );

    const marker = checkpointMarkers[existing.checkpoint.id];
    if (marker) marker.openPopup();
    return;
  }

  savePersistentSearchResults([result]);

  const marker = L.marker([lat, lng], {
    icon: createSearchIcon(),
    title: name
  }).addTo(searchLayer);

  marker.bindPopup(createSearchResultPopup(result, name));

  marker.on("popupopen", () => {
    marker.setPopupContent(createSearchResultPopup(result, name));
  });

  marker.openPopup();
  map.setView([lat, lng], 15);
}

function addStationToRally(station, button) {
  const rally = stampRallies.find(r => r.id === station.rallyId);
  if (!rally) return false;

  const existingMatch = findExistingStationMatch(station);

  const canonicalOsmType = existingMatch
    ? existingMatch.checkpoint.osmType
    : station.osmType;

  const canonicalOsmId = existingMatch
    ? existingMatch.checkpoint.osmId
    : station.osmId;

  const stationKey = existingMatch
    ? getCheckpointVisitKey(existingMatch.checkpoint)
    : makeStationKey(canonicalOsmType, canonicalOsmId);

  const id = makeCustomCheckpointId(
    station.rallyId,
    canonicalOsmType,
    canonicalOsmId
  );

  if (rally.checkpoints.some(cp => getCheckpointVisitKey(cp) === stationKey)) {
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
    name: existingMatch ? existingMatch.checkpoint.name : station.name,
    prefecture: existingMatch ? existingMatch.checkpoint.prefecture : station.prefecture,
    lat: existingMatch ? existingMatch.checkpoint.lat : station.lat,
    lng: existingMatch ? existingMatch.checkpoint.lng : station.lng,
    visited: sharedVisitedCheckpoint ? sharedVisitedCheckpoint.visited : false,
    custom: true,
    osmType: canonicalOsmType,
    osmId: canonicalOsmId,
    stationKey
  };

  rally.checkpoints.push(checkpoint);
  newlyCreatedEmptyRallyIds.delete(rally.id);
  addCheckpointMarker(rally, checkpoint);

  saveCustomCheckpoints();
  saveVisitedStates();
  buildProgress();
  buildRallyManager();
  buildRegisteredStationList();

  const storedSearchResults = loadPersistentSearchResults();
  if (storedSearchResults.length > 0) {
    showAreaSearchMarkers(storedSearchResults, false);
  }

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

  const registeredRemoveButton = event.target.closest(".registered-remove-button");
  if (registeredRemoveButton) {
    removeStationFromCurrentRally(registeredRemoveButton);
    return;
  }

  const registeredIgnoreButton = event.target.closest(".registered-ignore-button");
  if (registeredIgnoreButton) {
    changeRegisteredStationToIgnored(registeredIgnoreButton);
    return;
  }

  const existingRallySyncButton = event.target.closest(".existing-rally-sync-button");
  if (existingRallySyncButton) {
    syncExistingStationRallies(existingRallySyncButton);
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

  const ignoredRestoreButton = event.target.closest(".ignored-station-restore");
  if (ignoredRestoreButton) {
    restoreIgnoredStation(ignoredRestoreButton.dataset.stationKey);
    return;
  }

  const registeredMoveButton = event.target.closest(".registered-station-move");
  if (registeredMoveButton) {
    moveRegisteredStation(
      registeredMoveButton.dataset.rallyId,
      registeredMoveButton.dataset.checkpointId,
      registeredMoveButton.dataset.direction
    );
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

  const searchIgnoreButton = event.target.closest(".search-popup-ignore-button");
  if (searchIgnoreButton) {
    ignoreStationFromSearchPopup(searchIgnoreButton);
    return;
  }

  const searchAddButton = event.target.closest(".search-popup-add-button");
  if (searchAddButton) {
    addStationFromSearchPopup(searchAddButton);
  }
});

document.getElementById("createRallyButton").addEventListener("click", createRally);

document.getElementById("rallyListFilter").addEventListener("input", () => {
  applyRallyFiltersEverywhere();
});

document.getElementById("rallyListFilter").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.target.value = "";
    applyRallyFiltersEverywhere();
  }
});

document.getElementById("clearRallyListFilter").addEventListener("click", () => {
  const input = document.getElementById("rallyListFilter");
  input.value = "";
  document.getElementById("rallyAchievementFilter").value = "all";
  document.getElementById("showAllRalliesCheckbox").checked = false;
  applyRallyFiltersEverywhere();
  input.focus();
});

document.getElementById("rallyAchievementFilter").addEventListener("change", () => {
  applyRallyFiltersEverywhere();
});

document.getElementById("showAllRalliesCheckbox").addEventListener("change", () => {
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
});

document.getElementById("visibleRalliesMasterCheckbox").addEventListener("change", event => {
  setAllVisibleRalliesMapVisibility(event.target.checked);
});

document.getElementById("newRallyName").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    createRally();
  }
});


map.on("moveend zoomend", () => {
  buildFilters();
  buildProgress();
  buildRegisteredStationList();
  buildIgnoredStationList();
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
buildIgnoredStationList();
restorePersistentSearchMarkers();
