import leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./leafletWorkaround.ts"; // Fix missing marker images
import luck from "./luck.ts"; // Deterministic random number generator

// Interfaces
interface Cell {
  i: number; // Latitude-based index
  j: number; // Longitude-based index
}

interface Coin {
  cell: Cell;
  serial: number; // Unique identifier
}

// Allows the state of the object to be saved and restored
interface Momento<T> {
  toMomento(): T;
  fromMomento(momento: T): void;
}

class Cache implements Momento<string> {
  cell: Cell;
  coins: Coin[];

  constructor(cell: Cell, coins: Coin[] = []) {
    this.cell = cell;
    this.coins = coins;
  }

  // Encode the state of the cache into a string
  public toMomento(): string {
    return JSON.stringify({ cell: this.cell, coins: this.coins });
  }

  // Restore the state of the cache from a string
  public fromMomento(momento: string): void {
    const data = JSON.parse(momento);
    this.cell = data.cell;
    this.coins = data.coins;
  }
}

// Constants
const NULL_ISLAND = leaflet.latLng(0, 0);
const OAKES_CLASSROOM = leaflet.latLng(36.98949379578401, -122.06277128548504);
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 0.0001; // Size of each cell in degrees
const NEIGHBORHOOD_SIZE = 8;
const CACHE_SPAWN_PROBABILITY = 0.1;
const INITIAL_LAT = 36.98949379578401;
const INITIAL_LNG = -122.06277128548504;
let playerPosition = OAKES_CLASSROOM; // Initaial starting position
const GAME_STATE_KEY = "gameState";

// ChatGPT helped come up with the idea of a CacheManager and how to implement it using a Momento interface

class CacheManager {
  public cacheStates: Map<string, string> = new Map(); // Stores cache states as mementos
  public activeCaches: Map<string, Cache> = new Map(); // Active caches visible on the map

  constructor(
    private readonly board: Board,
    private readonly map: leaflet.Map,
  ) {}

  public getCellFromKey(key: string): Cell {
    const [i, j] = key.split(",").map(Number);
    return { i, j };
  }

  // Get key for a cell
  private getCellKey(cell: Cell): string {
    return `${cell.i},${cell.j}`;
  }

  // Regenerate caches near the player's position
  public updateVisibleCaches(
    playerPosition: leaflet.LatLng,
    visibilityRadius: number,
  ) {
    const playerCell = this.board.getCellForPoint(playerPosition);

    // Define bounds of visible cells
    const minI = playerCell.i - visibilityRadius;
    const maxI = playerCell.i + visibilityRadius;
    const minJ = playerCell.j - visibilityRadius;
    const maxJ = playerCell.j + visibilityRadius;

    // Iterate through visible cells
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const cell = this.board.getCanonicalCell({ i, j });
        const key = this.getCellKey(cell);

        if (this.activeCaches.has(key)) continue;

        // Restore from saved state if available
        if (this.cacheStates.has(key)) {
          const cache = new Cache(cell);
          cache.fromMomento(this.cacheStates.get(key)!);
          this.activeCaches.set(key, cache);
          displayCacheOnMap(cache);
          continue;
        }

        // Generate a new cache if no saved state exists
        const generatedCache = generateCache(cell);
        if (generatedCache) {
          const cache = new Cache(generatedCache.cell, generatedCache.coins);
          this.activeCaches.set(key, cache);
          displayCacheOnMap(cache);
        }
      }
    }

    // Had to ask chatGPT how to remove caches as they become not visible.
    // Remove caches outside of the visibility radius
    const cellsToRemove: string[] = [];
    this.activeCaches.forEach((cache, key) => {
      const { i, j } = cache.cell;
      if (i < minI || i > maxI || j < minJ || j > maxJ) {
        this.cacheStates.set(key, cache.toMomento());
        cellsToRemove.push(key);
      }
    });

    // Cleanup removed caches
    cellsToRemove.forEach((key) => {
      const cache = this.activeCaches.get(key);
      this.map.eachLayer((layer: leaflet.Layer) => {
        if (
          layer instanceof leaflet.Rectangle &&
          layer.getBounds().equals(this.board.getCellBounds(cache!.cell))
        ) {
          this.map.removeLayer(layer);
        }
      });
      this.activeCaches.delete(key);
    });
  }
}

class Board {
  private readonly knownCells: Map<string, Cell> = new Map();

  constructor(
    private readonly tileWidth: number,
    private readonly visibilityRadius: number,
  ) {}

  // Flyweight method to return a shared instance of a Cell
  public getCanonicalCell(cell: Cell): Cell {
    const key = `${cell.i},${cell.j}`;
    if (!this.knownCells.has(key)) {
      this.knownCells.set(key, cell); // Create new cell if not already present
    }
    return this.knownCells.get(key)!;
  }

  // Grid cell anchored at Null Island
  public getCellForPoint(point: leaflet.LatLng): Cell {
    const i = Math.floor((point.lat - NULL_ISLAND.lat) / TILE_DEGREES);
    const j = Math.floor((point.lng - NULL_ISLAND.lng) / TILE_DEGREES);
    return this.getCanonicalCell({ i, j });
  }

  // Get the bounds of a cell in coordinates
  public getCellBounds(cell: Cell): leaflet.LatLngBounds {
    const { i, j } = cell;
    const sw = leaflet.latLng(i * TILE_DEGREES, j * TILE_DEGREES); // Southwest corner
    const ne = leaflet.latLng((i + 1) * TILE_DEGREES, (j + 1) * TILE_DEGREES); // Northeast corner
    return leaflet.latLngBounds(sw, ne);
  }
}

// Main game logic (map initialization, event listeners, cache management)
const map = leaflet.map("map", {
  center: playerPosition,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: 6,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: true,
  scrollWheelZoom: true,
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: GAMEPLAY_ZOOM_LEVEL,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

const playerMarker = leaflet.marker(playerPosition);
playerMarker.bindTooltip("You're Here!");
playerMarker.addTo(map);

const board = new Board(TILE_DEGREES, NEIGHBORHOOD_SIZE);
let playerCoins = 0;
const statusPanel = document.getElementById("statusPanel")!;
const cacheManager = new CacheManager(board, map);
let movementHistory: leaflet.LatLng[] = [playerPosition];
const movementPolyline = leaflet
  .polyline(movementHistory, { color: "blue" })
  .addTo(map);

// Use luck function to determine cache generation and coin count
function generateCache(cell: Cell): Cache | null {
  if (luck(`${cell.i},${cell.j}`) < CACHE_SPAWN_PROBABILITY) {
    const coinCount = Math.floor(luck(`${cell.i},${cell.j},coins`) * 10);
    const coins: Coin[] = Array.from({ length: coinCount }, (_, serial) => ({
      cell,
      serial,
    }));
    return new Cache(cell, coins);
  }
  return null;
}

// Function to update the list of coins as you collect and deposit
function updatePopupCoinList(popupDiv: HTMLDivElement, coins: Coin[]) {
  const coinListDiv = popupDiv.querySelector("#coin-list")!;
  const coinList = coins
    .map((coin) => `i: ${coin.cell.i}, j: ${coin.cell.j}, #${coin.serial}`)
    .join("<br>");
  coinListDiv.innerHTML = coinList;
}

// Displays a cache on the map with an interactive popup
function displayCacheOnMap(cache: Cache) {
  const bounds = board.getCellBounds(cache.cell);
  const rect = leaflet.rectangle(bounds).addTo(map);

  rect.bindPopup(() => {
    const popupDiv = document.createElement("div");
    popupDiv.innerHTML = `
      <div>Cache at ${cache.cell.i},${cache.cell.j}</div>
      <button id="collect">Collect</button>
      <button id="deposit">Deposit</button>
      <div id="coin-count">Coins: ${cache.coins.length}</div>
      <div id="coin-list"></div>
    `;

    updatePopupCoinList(popupDiv, cache.coins);

    popupDiv.querySelector("#collect")!.addEventListener("click", () => {
      collectCoin(cache, popupDiv);
    });
    popupDiv.querySelector("#deposit")!.addEventListener("click", () => {
      depositCoin(cache, popupDiv);
    });

    return popupDiv;
  });
}

// Cache Interaction
function updateCoinUI(popupDiv: HTMLDivElement, cache: Cache) {
  const coinCountElement = popupDiv.querySelector("#coin-count");
  if (coinCountElement) {
    coinCountElement.textContent = `Coins: ${cache.coins.length}`;
  }
  updatePopupCoinList(popupDiv, cache.coins);
}

function collectCoin(cache: Cache, popupDiv: HTMLDivElement) {
  if (cache.coins.length > 0) {
    cache.coins.pop();
    playerCoins++;
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );
    updateCoinUI(popupDiv, cache);
    saveGameState();
  }
}

function depositCoin(cache: Cache, popupDiv: HTMLDivElement) {
  if (playerCoins > 0) {
    cache.coins.push({ cell: cache.cell, serial: cache.coins.length });
    playerCoins--;
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );
    updateCoinUI(popupDiv, cache);
    saveGameState();
  }
}

type InventoryChangedEvent = CustomEvent<{ coins: number }>;

document.addEventListener("player-inventory-changed", (e) => {
  const event = e as InventoryChangedEvent; // Type assertion
  statusPanel.innerHTML = `Coins: ${event.detail.coins}`;
});

// Event listener for inventory updates
document.addEventListener("player-inventory-changed", (e) => {
  const event = e as InventoryChangedEvent;
  statusPanel.innerHTML = `Coins: ${event.detail.coins}`;
});

// Movement step size (in degrees)
const MOVEMENT_STEP = TILE_DEGREES;

// Update player position and marker
function updatePlayerPosition(
  latChange: number,
  lngChange: number,
  isAbsolute: boolean = false,
) {
  if (isAbsolute) {
    playerPosition = leaflet.latLng(latChange, lngChange);
  } else {
    playerPosition = leaflet.latLng(
      playerPosition.lat + latChange,
      playerPosition.lng + lngChange,
    );
  }

  playerMarker.setLatLng(playerPosition);
  map.panTo(playerPosition); // Keep the map centered on the player

  movementHistory.push(playerPosition);
  movementPolyline.setLatLngs(movementHistory); // Update the polyline path

  cacheManager.updateVisibleCaches(playerPosition, NEIGHBORHOOD_SIZE);
  saveGameState();
}

// Event listeners for directional buttons
document.getElementById("north")!.addEventListener("click", () => {
  updatePlayerPosition(MOVEMENT_STEP, 0, false); // Move north
});

document.getElementById("south")!.addEventListener("click", () => {
  updatePlayerPosition(-MOVEMENT_STEP, 0, false); // Move south
});

document.getElementById("west")!.addEventListener("click", () => {
  updatePlayerPosition(0, -MOVEMENT_STEP, false); // Move west
});

document.getElementById("east")!.addEventListener("click", () => {
  updatePlayerPosition(0, MOVEMENT_STEP, false); // Move east
});

document.getElementById("sensor")!.addEventListener("click", () => {
  navigator.geolocation.getCurrentPosition(
    (position) => {
      playerPosition = leaflet.latLng(
        position.coords.latitude,
        position.coords.longitude,
      );
      playerMarker.setLatLng(playerPosition);
      map.panTo(playerPosition);
      cacheManager.updateVisibleCaches(playerPosition, NEIGHBORHOOD_SIZE);
      saveGameState();
    },
    (error) => {
      console.error("Geolocation error:", error);
    },
  );
});

function saveGameState() {
  const allCaches = new Map(cacheManager.cacheStates); // Start with saved caches
  cacheManager.activeCaches.forEach((cache, key) => {
    allCaches.set(key, cache.toMomento()); // Add active caches
  });

  const state = {
    playerPosition: { lat: playerPosition.lat, lng: playerPosition.lng },
    playerCoins,
    cacheStates: Array.from(allCaches.entries()), // Save all caches
    movementHistory: movementHistory.map((latLng) => ({
      lat: latLng.lat,
      lng: latLng.lng,
    })),
  };

  localStorage.setItem(GAME_STATE_KEY, JSON.stringify(state));
  console.log("Game state saved:", state);
}

// Function to load the game state
function loadGameState() {
  const savedState = localStorage.getItem(GAME_STATE_KEY);
  if (!savedState) {
    console.log("No saved game state found.");
    return;
  }

  try {
    const state = JSON.parse(savedState);
    console.log("Loaded game state:", state);

    // Restore player position
    playerPosition = leaflet.latLng(
      state.playerPosition.lat,
      state.playerPosition.lng,
    );
    playerMarker.setLatLng(playerPosition);
    map.panTo(playerPosition);

    // Restore movement history
    movementHistory = state.movementHistory.map(
      (point: { lat: number; lng: number }) =>
        leaflet.latLng(point.lat, point.lng),
    );
    movementPolyline.setLatLngs(movementHistory); // Restore the polyline path

    // Restore player's coins
    playerCoins = state.playerCoins;
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );

    cacheManager.activeCaches.clear(); // Ensure old active caches are cleared before restoring new ones

    // Restore saved cache states
    cacheManager.cacheStates = new Map(state.cacheStates);

    // Update visible caches for cells not covered by saved state
    cacheManager.updateVisibleCaches(playerPosition, NEIGHBORHOOD_SIZE);
  } catch (error) {
    console.error("Failed to load game state:", error);
  }
}

document.getElementById("reset")!.addEventListener("click", () => {
  if (prompt("Are you sure you want to reset? (yes / no)") === "yes") {
    localStorage.clear();
    playerCoins = 0;
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );
    playerPosition = OAKES_CLASSROOM;

    updatePlayerPosition(INITIAL_LAT, INITIAL_LNG, true);

    movementHistory = [];
    movementPolyline.setLatLngs([]);

    cacheManager.cacheStates.clear();
    cacheManager.activeCaches.clear();
  }
});

loadGameState();
