import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cn } from '../lib/utils';

/**
 * Leaflet map, styled for this app.
 *
 * OpenStreetMap data via CartoDB's dark basemap: free, no key, no billing, and
 * dark enough not to be a white rectangle in the middle of a dark app. The
 * light default would have been the only bright surface in the product.
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
 * A teardrop pin drawn as SVG. `divIcon` rather than `icon` so there is no
 * network request and no bundler asset resolution to get wrong.
 */
const pinIcon = (color: string, dimmed = false) =>
  L.divIcon({
    className: '', // suppress Leaflet's own styling hooks
    html: `
      <div style="
        transform: translate(-50%, -100%);
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));
        opacity: ${dimmed ? 0.55 : 1};
      ">
        <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 0C6.27 0 0 6.27 0 14c0 9.8 12.35 21.2 12.88 21.68a1.67 1.67 0 0 0 2.24 0C15.65 35.2 28 23.8 28 14 28 6.27 21.73 0 14 0Z" fill="${color}"/>
          <circle cx="14" cy="13.5" r="5" fill="#0d0d12"/>
        </svg>
      </div>`,
    iconSize: [28, 36],
    // The anchor is handled by the transform above, so Leaflet's own offset is
    // zero — mixing the two puts the point of the pin in the wrong place.
    iconAnchor: [0, 0],
  });

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

export interface MapPin {
  id: string;
  latitude: number;
  longitude: number;
  /** Renders in a muted colour — used for pins someone else shared. */
  muted?: boolean;
}

interface PinMapProps {
  pins?: MapPin[];
  /** Where the pin being placed currently sits. */
  draft?: { latitude: number; longitude: number } | null;
  onPick?: (lat: number, lng: number) => void;
  onPinClick?: (id: string) => void;
  center?: [number, number] | null;
  zoom?: number;
  className?: string;
}

export function PinMap({
  pins = [],
  draft,
  onPick,
  onPinClick,
  center,
  zoom = DEFAULT_ZOOM,
  className,
}: PinMapProps) {
  const icons = useMemo(
    () => ({ own: pinIcon(ACCENT), shared: pinIcon(ACCENT, true), draft: pinIcon('#f87171') }),
    []
  );

  return (
    <div className={cn('relative overflow-hidden rounded-2xl border border-line', className)}>
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
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          // OpenStreetMap's licence requires attribution, and CartoDB's terms
          // require crediting them for the tiles. Not optional.
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={20}
        />

        <Recenter center={center ?? null} zoom={zoom} />
        {onPick && <TapHandler onPick={onPick} />}

        {pins.map((p) => (
          <Marker
            key={p.id}
            position={[p.latitude, p.longitude]}
            icon={p.muted ? icons.shared : icons.own}
            eventHandlers={onPinClick ? { click: () => onPinClick(p.id) } : undefined}
          />
        ))}

        {draft && (
          <Marker position={[draft.latitude, draft.longitude]} icon={icons.draft} />
        )}
      </MapContainer>
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
