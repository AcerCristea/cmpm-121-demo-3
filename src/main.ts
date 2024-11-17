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

interface Cache {
  cell: Cell;
  coins: Coin[]; // Coins available in this cache
}

// Constants
const NULL_ISLAND = leaflet.latLng(0, 0); // Null Island at 0°N, 0°E
const OAKES_CLASSROOM = leaflet.latLng(36.98949379578401, -122.06277128548504); // Oakes Classroom coordinates
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 0.0001; // Size of each cell in degrees
const NEIGHBORHOOD_SIZE = 8;
const CACHE_SPAWN_PROBABILITY = 0.1;

const playerPosition = OAKES_CLASSROOM; // Initaial starting position

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

// Use luck function to determine cache generation and coin count
function generateCache(cell: Cell): Cache | null {
  if (luck(`${cell.i},${cell.j}`) < CACHE_SPAWN_PROBABILITY) {
    const coinCount = Math.floor(luck(`${cell.i},${cell.j},coins`) * 10);
    const coins: Coin[] = Array.from({ length: coinCount }, (_, serial) => ({
      cell,
      serial,
    }));
    return { cell, coins };
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
function collectCoin(cache: Cache, popupDiv: HTMLDivElement) {
  if (cache.coins.length > 0) {
    cache.coins.pop();
    playerCoins++;
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );
    const coinCountElement = popupDiv.querySelector("#coin-count");
    if (coinCountElement) {
      coinCountElement.textContent = `Coins: ${cache.coins.length}`;
    } else {
      console.error("coin-count element not found in popupDiv");
    }
    updatePopupCoinList(popupDiv, cache.coins);
  }
}

function depositCoin(cache: Cache, popupDiv: HTMLDivElement) {
  if (playerCoins > 0) {
    const newCoin: Coin = { cell: cache.cell, serial: cache.coins.length };
    playerCoins--;
    cache.coins.push(newCoin);
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );
    const coinCountElement = popupDiv.querySelector("#coin-count");
    if (coinCountElement) {
      coinCountElement.textContent = `Coins: ${cache.coins.length}`;
    } else {
      console.error("coin-count element not found in popupDiv");
    }
    updatePopupCoinList(popupDiv, cache.coins);
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

// Generate nearby caches centered around playerPosition
const startCell = board.getCellForPoint(playerPosition);

for (
  let i = startCell.i - NEIGHBORHOOD_SIZE;
  i <= startCell.i + NEIGHBORHOOD_SIZE;
  i++
) {
  for (
    let j = startCell.j - NEIGHBORHOOD_SIZE;
    j <= startCell.j + NEIGHBORHOOD_SIZE;
    j++
  ) {
    const cell = board.getCanonicalCell({ i, j });
    const cache = generateCache(cell);
    if (cache) displayCacheOnMap(cache);
  }
}
