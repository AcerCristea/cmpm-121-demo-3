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
const NULL_ISLAND = leaflet.latLng(0, 0); // Null Island at 0°N, 0°E
const OAKES_CLASSROOM = leaflet.latLng(36.98949379578401, -122.06277128548504); // Oakes Classroom coordinates
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 0.0001; // Size of each cell in degrees
const NEIGHBORHOOD_SIZE = 8;
const CACHE_SPAWN_PROBABILITY = 0.1;

let playerPosition = OAKES_CLASSROOM; // Initaial starting position

// ChatGPT helped come up with the idea of a CacheManager and how to implement it using a Momento interface

class CacheManager {
  private cacheStates: Map<string, string> = new Map(); // Stores cache states as mementos
  private activeCaches: Map<string, Cache> = new Map(); // Active caches visible on the map

  constructor(
    private readonly board: Board,
    private readonly map: leaflet.Map,
  ) {}

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

        if (!this.activeCaches.has(key)) {
          // Restore state if memento exists, otherwise generate a new cache
          let cache: Cache | null = null;
          if (this.cacheStates.has(key)) {
            cache = new Cache(cell);
            cache.fromMomento(this.cacheStates.get(key)!);
          } else {
            // Generate new cache
            const generatedCache = generateCache(cell);
            if (generatedCache) {
              cache = new Cache(generatedCache.cell, generatedCache.coins);
            }
          }
          if (cache) {
            this.activeCaches.set(key, cache);
            displayCacheOnMap(cache);
          }
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
    .map((coin) => `{i: ${coin.cell.i}, j: ${coin.cell.j}, #${coin.serial}}`)
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

// Update the caches to spawn at playerPosition
cacheManager.updateVisibleCaches(playerPosition, NEIGHBORHOOD_SIZE);

// Update player position and marker
function updatePlayerPosition(latChange: number, lngChange: number) {
  playerPosition = leaflet.latLng(
    playerPosition.lat + latChange,
    playerPosition.lng + lngChange,
  );

  playerMarker.setLatLng(playerPosition);
  map.panTo(playerPosition); // Keep the map centered on the player

  cacheManager.updateVisibleCaches(playerPosition, NEIGHBORHOOD_SIZE);
}

// Event listeners for directional buttons
document.getElementById("north")!.addEventListener("click", () => {
  updatePlayerPosition(MOVEMENT_STEP, 0); // Move north
});

document.getElementById("south")!.addEventListener("click", () => {
  updatePlayerPosition(-MOVEMENT_STEP, 0); // Move south
});

document.getElementById("west")!.addEventListener("click", () => {
  updatePlayerPosition(0, -MOVEMENT_STEP); // Move west
});

document.getElementById("east")!.addEventListener("click", () => {
  updatePlayerPosition(0, MOVEMENT_STEP); // Move east
});
