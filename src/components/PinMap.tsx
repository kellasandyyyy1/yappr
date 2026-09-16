import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap, AttributionControl } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cn } from '../lib/utils';

/**
 * Leaflet map, styled for this app.
 *
 * OpenStreetMap's own tiles, darkened by a CSS filter on the tile pane (see
 * .map-dark in index.css). CARTO's dark basemap was the original choice on the
 * understanding it was keyless; it now stamps unauthenticated tiles with a
 * diagonal "API KEY REQUIRED", so it is not usable without one.
 *
 * Leaflet's own marker is a red PNG loaded from the package's dist folder,
 * which both clashes with the accent colour and breaks under a bundler that
 * rewrites asset paths. Markers here are inline SVG divIcons instead — no
 * image requests at all, and they take the app's colours.
 */

/** Somewhere recognisable, for when geolocation is refused or unavailable. */
const FALLBACK_CENTER: [number, number] = [51.5074, -0.1278]; // London
const DEFAULT_ZOOM = 13;

const ACCENT = '#3b82f6';

/**
 * Per-space marker colours for the combined map.
 *
 * Chosen to stay apart on a dark basemap and to remain distinguishable to the
 * common forms of colour blindness — no red/green pair carries meaning on its
 * own. A space is assigned one by index, so the same space keeps its colour
 * for as long as the list order holds.
 */
export const SPACE_COLORS = [
  '#3b82f6', // blue   — the app accent, so a single space looks native
  '#f59e0b', // amber
  '#a855f7', // purple
  '#14b8a6', // teal
  '#ec4899', // pink
  '#84cc16', // lime
];

export const spaceColor = (index: number) => SPACE_COLORS[index % SPACE_COLORS.length];

/** HTML-escapes a value going into a divIcon string. The description on a
 *  GIPHY result or a display name can contain quotes, and divIcon takes raw
 *  HTML — an unescaped one closes the attribute and breaks the marker. */
const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A photo bubble: a white rounded-square frame around the pin's first photo,
 * with a pointer tail beneath.
 *
 * divIcon rather than icon, so there is no marker sprite to load and no
 * bundler asset path to get wrong — Leaflet's default is a red PNG resolved
 * from its own dist folder, which breaks under a bundler that rewrites asset
 * URLs and clashes with the palette even when it does not.
 *
 * A photo is a rounded SQUARE and an avatar fallback is a CIRCLE. That is the
 * same distinction the detail card makes, so the two read as one system.
 */
const photoBubble = (opts: {
  photoUrl?: string;
  avatarUrl?: string;
  initial?: string;
  color: string;
  dimmed?: boolean;
}) => {
  const { photoUrl, avatarUrl, initial = '?', color, dimmed } = opts;
  const hasPhoto = !!photoUrl;
  const src = photoUrl || avatarUrl || '';
  // Square for a photo, round for an avatar — the fallback should not
  // pretend to be a picture of the place.
  const innerRadius = hasPhoto ? '9px' : '999px';

  // onerror rather than a load check: a dead storage URL would otherwise
  // leave a broken-image glyph inside the frame, which looks like a bug
  // rather than an absence. Hiding it reveals the initial underneath.
  const inner = src
    ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer" loading="lazy"
           onerror="this.style.display='none'"
           style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:${innerRadius};" />`
    : '';

  return L.divIcon({
    className: '', // suppress Leaflet's own styling hooks
    html: `
      <div style="
        transform: translate(-50%, -100%);
        opacity: ${dimmed ? 0.75 : 1};
        filter: drop-shadow(0 3px 6px rgba(0,0,0,0.55));
      ">
        <div style="
          width:60px; height:56px; box-sizing:border-box;
          background:#fff; border-radius:14px; padding:4px;
          border:2px solid ${color};
        ">
          <div style="
            position:relative; width:100%; height:100%;
            border-radius:${innerRadius}; overflow:hidden;
            background:#1e1e27;
            display:flex; align-items:center; justify-content:center;
            font:600 16px/1 Inter, system-ui, sans-serif; color:#a1a1aa;
          ">${esc(initial)}${inner}</div>
        </div>
        <div style="
          width:0; height:0; margin:-1px auto 0;
          border-left:7px solid transparent;
          border-right:7px solid transparent;
          border-top:9px solid ${color};
        "></div>
      </div>`,
    iconSize: [60, 65],
    // The transform above does the anchoring, so Leaflet's own offset stays
    // zero — applying both puts the tail somewhere other than the location.
    iconAnchor: [0, 0],
  });
};

/** Reports taps so the create flow can drop a pin where the user pressed. */
function TapHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * Recentres when the target changes.
 *
 * MapContainer's `center` is read once, at mount — changing the prop later
 * does nothing, which is a common way for "the map ignores my location" to
 * happen.
 */
function Recenter({ center, zoom }: { center: [number, number] | null; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.setView(center, zoom ?? map.getZoom());
  }, [center, zoom, map]);
  return null;
}

/** Two pins a few metres apart would otherwise fit to street level. */
const FIT_MAX_ZOOM = 16;
/** A single pin has no extent, so it gets a view rather than a fit. */
const SINGLE_PIN_ZOOM = 15;

/**
 * Frames a set of pins when `fitKey` changes.
 *
 * Keyed rather than reactive to the pins themselves: refitting on every
 * render would yank the map back the moment anyone panned, and refitting on
 * array identity would do it on every poll. The key changes when the space
 * selection changes, and when the number of pins in that selection changes
 * — so it frames on switching tabs, and on the pins arriving for the first
 * time, which is the same moment as far as a reader is concerned.
 */
function FitToPins({ points, fitKey }: { points: Array<[number, number]>; fitKey?: string }) {
  const map = useMap();
  useEffect(() => {
    if (fitKey === undefined) return;
    // An empty space keeps whatever view it had. Fitting to nothing throws,
    // and defaulting to 0,0 would drop the reader in the Atlantic.
    if (points.length === 0) return;

    if (points.length === 1) {
      map.setView(points[0], Math.max(map.getZoom(), SINGLE_PIN_ZOOM));
      return;
    }
    map.fitBounds(L.latLngBounds(points), {
      padding: [48, 48],
      maxZoom: FIT_MAX_ZOOM,
    });
    // points is derived from the same data the key summarises.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  return null;
}

export interface MapPin {
  id: string;
  latitude: number;
  longitude: number;
  /** Frame colour — the space this pin belongs to. */
  color?: string;
  /** Dimmed — used for pins someone else added. */
  muted?: boolean;
  /** The pin's first photo, or a video's poster. Shown square. */
  photoUrl?: string;
  /** The creator's avatar, used when the pin has no picture. Shown round. */
  avatarUrl?: string;
  /** Last resort when there is neither: one character. */
  initial?: string;
}

interface PinMapProps {
  pins?: MapPin[];
  /** Where the pin being placed currently sits. */
  draft?: { latitude: number; longitude: number } | null;
  onPick?: (lat: number, lng: number) => void;
  onPinClick?: (id: string) => void;
  center?: [number, number] | null;
  zoom?: number;
  /**
   * Changing this frames every pin currently passed in. Undefined leaves
   * the viewport alone entirely, which is what the pin composer wants —
   * it is placing a pin, not surveying them.
   */
  fitKey?: string;
  className?: string;
}

export function PinMap({
  pins = [],
  draft,
  onPick,
  onPinClick,
  center,
  zoom = DEFAULT_ZOOM,
  fitKey,
  className,
}: PinMapProps) {
  // Icons are cached per colour+dimmed pair: divIcon builds an HTML string,
  // and rebuilding one per marker per render is wasted work on a busy map.
  const iconCache = useMemo(() => new Map<string, L.DivIcon>(), []);
  const iconFor = (pin: MapPin) => {
    const color = pin.color ?? ACCENT;
    // Every input that changes the rendered HTML is in the key, or two pins
    // with different photos would share one cached bubble.
    const key = `${color}|${!!pin.muted}|${pin.photoUrl ?? ""}|${pin.avatarUrl ?? ""}|${pin.initial ?? ""}`;
    let icon = iconCache.get(key);
    if (!icon) {
      icon = photoBubble({
        photoUrl: pin.photoUrl,
        avatarUrl: pin.avatarUrl,
        initial: pin.initial,
        color,
        dimmed: pin.muted,
      });
      iconCache.set(key, icon);
    }
    return icon;
  };

  // The pin being placed: a plain frame in the danger colour, so it reads as
  // provisional rather than as something already saved.
  const draftIcon = useMemo(() => photoBubble({ color: '#f87171', initial: '+' }), []);

  // Tiles either arrive or they do not, and when they do not the map is an
  // empty black rectangle that looks identical to "no pins here". Leaflet
  // fires tileerror for a failed tile image — including one blocked by CSP,
  // which is the usual cause and produces no other visible signal.
  const [tilesFailed, setTilesFailed] = useState(false);
  const tileStats = useRef({ loaded: 0, failed: 0 });

  return (
    <div className={cn('map-dark relative overflow-hidden rounded-2xl border border-line', className)}>
      <MapContainer
        center={center ?? FALLBACK_CENTER}
        zoom={zoom}
        scrollWheelZoom
        // absolute inset-0, NOT h-full.
        //
        // Callers size this wrapper with min-h-[…] plus flex-1, which leaves
        // its computed `height` as `auto`. A percentage height — which is what
        // h-full is — resolves against `auto` as `auto`, so the map div
        // collapsed to its content height, which for an uninitialised Leaflet
        // container is zero. The bordered box was the right size and the map
        // inside it was 0px tall: Leaflet's most common blank-map cause.
        //
        // An absolutely positioned box sizes against the padding box of its
        // positioned ancestor, whose USED height is real (320px from the
        // min-height). That sidesteps percentage resolution entirely and works
        // whether the caller sizes the wrapper with a height, a min-height or
        // a flex basis.
        className="absolute inset-0"
        // Leaflet paints its own light background behind the tiles, which
        // flashes white while they load.
        style={{ background: '#0d0d12' }}
        // Replaced below by one with no "Leaflet" prefix. The default control
        // is added at construction, so it has to be refused here rather than
        // reconfigured afterwards.
        attributionControl={false}
      >
        {/* The attribution, minus Leaflet's own branding.

            "© OpenStreetMap contributors" stays, and is not ours to drop: the
            tiles are ODbL-licensed and crediting them is a condition of the
            licence, not a courtesy. The "Leaflet" prefix is different — that
            is the library advertising itself, it carries no licence weight,
            and prefix={false} is the supported way to decline it.

            What remains is styled down to a hairline in .map-dark (index.css)
            so it reads as a credit rather than a caption. */}
        <AttributionControl position="bottomright" prefix={false} />

        {/* OpenStreetMap's own tiles. CARTO's dark basemap was used here
            first, on the understanding it needed no key — it now watermarks
            unauthenticated tiles with a diagonal "API KEY REQUIRED", which is
            what was showing on the map. These need no key; the .map-dark
            filter on the wrapper does the darkening.

            OSM's tile usage policy asks for a valid identifying User-Agent
            and rules out heavy use. A browser cannot set User-Agent, so this
            relies on the Referer the browser sends — fine at this scale, not
            something to lean on if the app grows. */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
          eventHandlers={{
            tileload: () => {
              tileStats.current.loaded += 1;
              setTilesFailed(false);
            },
            tileerror: () => {
              tileStats.current.failed += 1;
              // Three failures with nothing loaded, not one: a single tile
              // missing at the edge of coverage is ordinary, while every
              // tile failing is a blocked host.
              if (tileStats.current.loaded === 0 && tileStats.current.failed >= 3) {
                setTilesFailed(true);
                console.error('[PinMap] map tiles are not loading', {
                  host: 'tile.openstreetmap.org',
                  failed: tileStats.current.failed,
                  hint: 'Almost always CSP: img-src must allow https://tile.openstreetmap.org. Check the Content-Security-Policy header actually being served — a dev server started before the header changed will still send the old one.',
                });
              }
            },
          }}
        />

        <Recenter center={center ?? null} zoom={zoom} />

        <FitToPins
          points={pins.map((p) => [p.latitude, p.longitude] as [number, number])}
          fitKey={fitKey}
        />
        {onPick && <TapHandler onPick={onPick} />}

        {pins.map((p, i) => (
          <Marker
            key={p.id}
            position={[p.latitude, p.longitude]}
            icon={iconFor(p)}
            // Later pins in the list draw above earlier ones, so the newest
            // is the one on top when bubbles overlap.
            zIndexOffset={i}
            eventHandlers={onPinClick ? { click: () => onPinClick(p.id) } : undefined}
          />
        ))}

        {draft && (
          <Marker position={[draft.latitude, draft.longitude]} icon={draftIcon} />
        )}
      </MapContainer>

      {tilesFailed && (
        <div
          style={{ zIndex: 500 }}
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/80 px-6 text-center"
        >
          <div>
            <p className="text-sm font-semibold text-fg">Map tiles didn't load</p>
            <p className="mx-auto mt-1 max-w-[260px] text-xs leading-relaxed text-muted">
              The map is working but its imagery is being blocked. The console has the detail.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The browser's location, if the user allows it.
 *
 * Resolves to null rather than rejecting on refusal: a declined permission is
 * an ordinary answer, and the map has a fallback centre for exactly this.
 */
export function useCurrentLocation() {
  const [center, setCenter] = useState<[number, number] | null>(null);
  const [asking, setAsking] = useState(true);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setAsking(false);
      return;
    }
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setCenter([pos.coords.latitude, pos.coords.longitude]);
        setAsking(false);
      },
      () => {
        if (!cancelled) setAsking(false);
      },
      { timeout: 8000, maximumAge: 60_000 }
    );
    return () => { cancelled = true; };
  }, []);

  return { center, asking };
}
