import leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

// Fix missing marker images
import "./leafletWorkaround.ts";

// Deterministic random number generator
import luck from "./luck.ts";

// Interfaces
interface Cell {
  i: number;
  j: number;
}

interface Coin {
  cell: Cell;
  serial: number;
}

interface Cache {
  cell: Cell;
  coins: number; // Integer count for simplicity
}

// Event types
type CacheUpdatedEvent = CustomEvent<{ cache: Cache }>;
// type PlayerMovedEvent = CustomEvent<{ cell: Cell }>;
type InventoryChangedEvent = CustomEvent<{ coins: number }>;

const OAKES_CLASSROOM = leaflet.latLng(36.98949379578401, -122.06277128548504);
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 0.0001;
const NEIGHBORHOOD_SIZE = 8;
const CACHE_SPAWN_PROBABILITY = 0.1;

// Initialize the map
const map = leaflet.map("map", {
  center: OAKES_CLASSROOM,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: GAMEPLAY_ZOOM_LEVEL,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: false,
  scrollWheelZoom: false,
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: GAMEPLAY_ZOOM_LEVEL,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

// Add a marker to represent the player
const playerMarker = leaflet.marker(OAKES_CLASSROOM);
playerMarker.bindTooltip("You're Here!");
playerMarker.addTo(map);

// Use luck function to determine cache generation and coin count
function generateCache(cell: Cell): Cache | null {
  if (luck(`${cell.i},${cell.j}`) < CACHE_SPAWN_PROBABILITY) {
    const coinCount = Math.floor(luck(`${cell.i},${cell.j},coins`) * 100);
    return { cell, coins: coinCount };
  }
  return null;
}

let playerCoins = 0;
const statusPanel = document.getElementById("statusPanel")!;

// // Move Player
// function movePlayer(newCell: Cell) {
//   const event = new CustomEvent("player-moved", { detail: { cell: newCell } });
//   document.dispatchEvent(event);
// }

// Cache Interaction
function collectCoin(cache: Cache, popupDiv: HTMLDivElement) {
  if (cache.coins > 0) {
    cache.coins--;
    playerCoins++;
    document.dispatchEvent(
      new CustomEvent("cache-updated", { detail: { cache } }),
    );
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );

    popupDiv.querySelector("#coin-count")!.textContent = cache.coins.toString();
  }
}

function depositCoin(cache: Cache, popupDiv: HTMLDivElement) {
  if (playerCoins > 0) {
    playerCoins--;
    cache.coins++;
    document.dispatchEvent(
      new CustomEvent("cache-updated", { detail: { cache } }),
    );
    document.dispatchEvent(
      new CustomEvent("player-inventory-changed", {
        detail: { coins: playerCoins },
      }),
    );

    popupDiv.querySelector("#coin-count")!.textContent = cache.coins.toString();
  }
}

document.addEventListener("player-inventory-changed", (e) => {
  const event = e as InventoryChangedEvent; // Type assertion
  statusPanel.innerHTML = `Coins: ${event.detail.coins}`;
});

// Update event listener to refresh the map display when a cache is updated
document.addEventListener("cache-updated", (e) => {
  const event = e as CacheUpdatedEvent;
  displayCacheOnMap(event.detail.cache); // Redisplay the cache to reflect changes
});

function displayCacheOnMap(cache: Cache) {
  const bounds = leaflet.latLngBounds([
    [
      OAKES_CLASSROOM.lat + cache.cell.i * TILE_DEGREES,
      OAKES_CLASSROOM.lng + cache.cell.j * TILE_DEGREES,
    ],
    [
      OAKES_CLASSROOM.lat + (cache.cell.i + 1) * TILE_DEGREES,
      OAKES_CLASSROOM.lng + (cache.cell.j + 1) * TILE_DEGREES,
    ],
  ]);

  const rect = leaflet.rectangle(bounds).addTo(map);

  rect.bindPopup(() => {
    const popupDiv = document.createElement("div");
    popupDiv.innerHTML = `
      <div>Cache at ${cache.cell.i},${cache.cell.j} - Coins: <span id="coin-count">${cache.coins}</span></div>
      <button id="collect">Collect</button>
      <button id="deposit">Deposit</button>
    `;

    popupDiv
      .querySelector("#collect")!
      .addEventListener("click", () => collectCoin(cache, popupDiv));
    popupDiv
      .querySelector("#deposit")!
      .addEventListener("click", () => depositCoin(cache, popupDiv));

    return popupDiv;
  });
}

// Generate nearby caches
for (let i = -NEIGHBORHOOD_SIZE; i <= NEIGHBORHOOD_SIZE; i++) {
  for (let j = -NEIGHBORHOOD_SIZE; j <= NEIGHBORHOOD_SIZE; j++) {
    const cell = { i, j };
    const cache = generateCache(cell);
    if (cache) displayCacheOnMap(cache);
  }
}
