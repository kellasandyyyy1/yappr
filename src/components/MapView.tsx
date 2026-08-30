import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Plus, Loader2, AlertCircle, Trash2, Users as UsersIcon, MapPin as MapPinIcon } from 'lucide-react';
import { PinMap, useCurrentLocation, spaceColor } from './PinMap';
import { CreatePinModal } from './CreatePinModal';
import { CreateSpaceModal } from './CreateSpaceModal';
import { LocationSearch } from './LocationSearch';
import { VideoPlayer } from './VideoPlayer';
import { ThemeSongCard } from './ThemeSongCard';
import { ImageViewer } from './ImageViewer';
import { Modal, ModalHeader, ModalBody, ConfirmDialog } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from './ToastContext';
import { pins as pinsApi, spaces as spacesApi, Pin, PinMedia, MapSpace } from '../lib/pins';
import { formatTimeAgo, describeError, cn } from '../lib/utils';
import { reverseGeocode } from '../lib/geocode';
import { AnimatePresence } from 'motion/react';
import type { User } from '../types';

interface MapViewProps {
  user: User;
  onUserClick?: (uid: string) => void;
}

/**
 * Shared map spaces.
 *
 * ── ALL SPACES AT ONCE, WITH A FILTER ───────────────────────────────────────
 * The default view combines every space the viewer belongs to on one map,
 * colour-coded, with a chip row to narrow to one. That way round because the
 * question a map answers is "what is near here", and a space-first UI makes
 * you pick a space before it will answer it. The filter is there for when
 * several spaces overlap the same city and the combined view gets noisy.
 *
 * Nothing here filters by membership — RLS does (0017). A second filter could
 * only ever hide something a member is entitled to see.
 */
export function MapView({ user, onUserClick }: MapViewProps) {
  const [spaces, setSpaces] = useState<MapSpace[] | null>(null);
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null); // null = all
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [pinningTo, setPinningTo] = useState<MapSpace | null>(null);
  const [openPin, setOpenPin] = useState<Pin | null>(null);
  const [resolved, setResolved] = useState<PinMedia[] | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Set when a place is chosen from search, so the map pans there.
  const [searchCenter, setSearchCenter] = useState<[number, number] | null>(null);
  // "Westminster, London" for the open pin. Null until it resolves, and
  // null forever if it cannot — the card falls back to coordinates.
  const [placeName, setPlaceName] = useState<string | null>(null);
  const { center } = useCurrentLocation();
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const [mySpaces, myPins] = await Promise.all([spacesApi.mine(), pinsApi.visible()]);
      setSpaces(mySpaces);
      setPins(myPins);
      setError(null);
    } catch (err) {
      // A failed fetch is not an empty map. Saying "no spaces yet" when the
      // query failed is the conflation that made a broken comment query look
      // like missing data.
      console.error('Error loading map:', err);
      setError(describeError(err));
      setSpaces([]);
      setPins([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Media is signed on open, not on load: a map of thirty pins would otherwise
  // mint a signed URL for every photo nobody has looked at.
  useEffect(() => {
    if (!openPin) { setResolved(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const media = await pinsApi.resolveMedia(openPin.media);
        if (!cancelled) setResolved(media);
      } catch (err) {
        console.error('Error resolving pin media:', err);
        if (!cancelled) setResolved(openPin.media);
      }
    })();
    return () => { cancelled = true; };
  }, [openPin]);

  // One reverse lookup per opened pin, aborted if the pin closes first.
  // Nominatim allows 1 request/second for the whole app, so this must not
  // run for every pin on the map — only the one being read.
  useEffect(() => {
    setPlaceName(null);
    if (!openPin) return;
    const controller = new AbortController();
    reverseGeocode(openPin.latitude, openPin.longitude, controller.signal).then((name) => {
      if (!controller.signal.aborted) setPlaceName(name);
    });
    return () => controller.abort();
  }, [openPin]);

  /** Stable colour per space, by list position. */
  const colorOf = useMemo(() => {
    const byId = new Map<string, string>();
    (spaces ?? []).forEach((s, i) => byId.set(s.id, spaceColor(i)));
    return byId;
  }, [spaces]);

  /**
   * The picture a pin's marker shows: its first photo, or a video's poster.
   *
   * Only public-bucket URLs are used. Pin photos go to `posts` and videos to
   * `post-videos`, both public, so these need no signing — which matters,
   * because a marker cannot await a signed URL.
   */
  const pictureOf = (pin: Pin): string | undefined => {
    const photo = pin.media.find((m) => m.type === 'photo' && m.url);
    if (photo?.url) return photo.url;
    const video = pin.media.find((m) => m.type === 'video' && m.posterUrl);
    return video?.posterUrl;
  };

  const visiblePins = (pins ?? []).filter((p) => !activeSpaceId || p.spaceId === activeSpaceId);
  const activeSpace = (spaces ?? []).find((s) => s.id === activeSpaceId) ?? null;
  const spaceOf = (id: string) => (spaces ?? []).find((s) => s.id === id) ?? null;

  const handleDeletePin = async (id: string) => {
    try {
      await pinsApi.remove(id);
      setOpenPin(null);
      setPins((prev) => prev?.filter((p) => p.id !== id) ?? null);
      toast('Pin removed', 'info');
    } catch (err) {
      console.error('Error deleting pin:', err);
      toast(describeError(err), 'error');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-fg">Map</h1>
          <p className="truncate text-xs text-muted">
            {spaces === null
              ? 'Loading…'
              : spaces.length === 0
                ? 'No spaces yet'
                : `${visiblePins.length} pin${visiblePins.length === 1 ? '' : 's'} in ${activeSpace ? activeSpace.name : `${spaces.length} space${spaces.length === 1 ? '' : 's'}`}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setCreatingSpace(true)}
            className="btn-secondary flex h-10 items-center gap-2 px-3 text-sm"
          >
            <UsersIcon size={15} />
            <span className="hidden sm:inline">New space</span>
          </button>
          <button
            onClick={() => setPinningTo(activeSpace ?? spaces?.[0] ?? null)}
            disabled={!spaces?.length}
            title={spaces?.length ? 'Add a pin' : 'Create a space first'}
            className="btn-primary flex h-10 items-center gap-2 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">New pin</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-danger">Couldn't load the map</p>
            <p className="mt-0.5 text-xs leading-relaxed text-danger/90">{error}</p>
          </div>
        </div>
      )}

      {/* Space filter. "All" first, then one chip per space in its own colour,
          so the chip and its markers are visibly the same thing. */}
      {spaces && spaces.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
          <button
            onClick={() => setActiveSpaceId(null)}
            className={cn(
              'flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors',
              activeSpaceId === null
                ? 'border-accent bg-accent/15 text-fg'
                : 'border-line text-muted hover:text-fg'
            )}
          >
            All
          </button>
          {spaces.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSpaceId(s.id === activeSpaceId ? null : s.id)}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
                s.id === activeSpaceId ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
              )}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colorOf.get(s.id) }}
              />
              {s.name}
              <span className="text-subtle">{s.members.length}</span>
            </button>
          ))}
        </div>
      )}

      {/* Browsing a space: search pans the map, it does not drop anything.
          Dropping happens in the pin composer, which has its own search. */}
      {spaces && spaces.length > 0 && (
        <LocationSearch
          userId={user.uid}
          placeholder="Find a place on the map…"
          onPick={(place) => setSearchCenter([place.latitude, place.longitude])}
        />
      )}

      {spaces === null ? (
        <div className="flex min-h-[300px] flex-1 items-center justify-center rounded-2xl border border-line bg-surface-2">
          <Loader2 size={22} className="animate-spin text-subtle" />
        </div>
      ) : spaces.length === 0 ? (
        <div className="flex min-h-[300px] flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-subtle">
            <MapPinIcon size={22} />
          </div>
          <div>
            <p className="text-sm font-semibold text-fg">No map spaces yet</p>
            <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-muted">
              A space is a shared map. Everyone in it sees every pin, and can keep adding.
            </p>
          </div>
          <button onClick={() => setCreatingSpace(true)} className="btn-primary h-10 px-4 text-sm">
            Create one
          </button>
        </div>
      ) : (
        <PinMap
          center={searchCenter ?? center}
          zoom={searchCenter ? 14 : undefined}
          className="min-h-[320px] flex-1"
          pins={visiblePins.map((p) => ({
            id: p.id,
            latitude: p.latitude,
            longitude: p.longitude,
            color: colorOf.get(p.spaceId),
            // Someone else's pin is dimmed, so "mine" and "theirs" read apart
            // without opening anything.
            muted: p.creatorId !== user.uid,
            // Photo first; the creator's avatar when the pin has no picture
            // — a song-only pin still needs a face rather than an empty box.
            photoUrl: pictureOf(p),
            avatarUrl: p.creator?.photoURL,
            initial: (p.name || p.creator?.displayName || '?').charAt(0).toUpperCase(),
          }))}
          onPinClick={(id) => setOpenPin(visiblePins.find((p) => p.id === id) ?? null)}
        />
      )}

      {spaces !== null && spaces.length > 0 && visiblePins.length === 0 && !error && (
        <p className="text-center text-sm text-muted">
          {activeSpace ? `No pins in ${activeSpace.name} yet.` : 'No pins yet. Drop one to remember a place.'}
        </p>
      )}

      <AnimatePresence>
        {creatingSpace && (
          <CreateSpaceModal user={user} onClose={() => setCreatingSpace(false)} onCreated={load} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pinningTo && (
          <CreatePinModal
            user={user}
            space={pinningTo}
            onClose={() => setPinningTo(null)}
            onCreated={load}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {openPin && (
          <Modal onClose={() => setOpenPin(null)} size="lg" labelledBy="pin-detail" className="sm:h-[80vh]">
            {/* The bar carries the SPACE; the pin's own name is the heading
                in the body. Both showed the name before, which printed it
                twice, one above the other. The body keeps it because that is
                where it can be large and sit beside the picture. */}
            <ModalHeader
              title={spaceOf(openPin.spaceId)?.name ?? 'Space'}
              onClose={() => setOpenPin(null)}
            >
              {/* A member removes their own pin; the space owner can remove
                  any. RLS enforces both — this only mirrors it. */}
              {(openPin.creatorId === user.uid || spaceOf(openPin.spaceId)?.createdBy === user.uid) && (
                <button
                  onClick={() => setConfirmDelete(openPin.id)}
                  aria-label="Delete pin"
                  title="Delete pin"
                  className="shrink-0 p-2 text-subtle transition-colors hover:text-danger"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </ModalHeader>

            <ModalBody className="scrollbar-thin space-y-4 pb-8">
              {/* Locket header: the picture, then the name and where it is.

                  Rounded-SQUARE for a photo, CIRCLE for an avatar fallback —
                  the same distinction the map markers make, so a pin looks
                  like the same object in both places. */}
              <div className="flex items-center gap-3">
                {(() => {
                  const picture = resolved?.find((m) => m.type === 'photo' && m.url)?.url
                    ?? resolved?.find((m) => m.type === 'video' && m.posterUrl)?.posterUrl;
                  return picture ? (
                    <img
                      src={picture}
                      alt=""
                      className="h-16 w-16 shrink-0 rounded-2xl border-2 object-cover"
                      style={{ borderColor: colorOf.get(openPin.spaceId) }}
                    />
                  ) : (
                    <span
                      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2"
                      style={{ borderColor: colorOf.get(openPin.spaceId) }}
                    >
                      <Avatar user={openPin.creator} size="xl" />
                    </span>
                  );
                })()}

                <div className="min-w-0 flex-1">
                  <h2 id="pin-detail" className="truncate text-xl font-bold leading-tight text-fg">
                    {openPin.name || openPin.caption || 'A place'}
                  </h2>
                  {/* Reverse-geocoded where it resolves, coordinates where it
                      does not. The sea has no name and that is fine. */}
                  <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted">
                    <MapPinIcon size={13} className="shrink-0 text-accent" />
                    <span className="truncate">
                      {placeName ?? `${openPin.latitude.toFixed(4)}, ${openPin.longitude.toFixed(4)}`}
                    </span>
                  </p>
                </div>
              </div>

              {/* 2. Who and when. */}
              <div className="flex items-center gap-2.5">
                <button onClick={() => onUserClick?.(openPin.creatorId)} className="press shrink-0">
                  <Avatar user={openPin.creator} size="sm" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">
                    {openPin.creatorId === user.uid ? 'You' : openPin.creator?.displayName ?? 'Someone'}
                  </p>
                  <p className="truncate text-xs text-muted">added {formatTimeAgo(openPin.createdAt)}</p>
                </div>

                {/* The song rides this row instead of owning a block under
                    the cover. A pin has one mood, and it belongs with who
                    set it down and when — not as a third full-width slab
                    between the cover and the pictures.

                    The composer appends songs without a cap, so more than
                    one is possible. They wrap rather than being dropped:
                    losing the second song to a tidier row would be data
                    loss dressed up as design. */}
                {resolved && resolved.some((m) => m.type === 'song' && m.youtubeVideoId) && (
                  <div className="flex min-w-0 shrink flex-wrap justify-end gap-1">
                    {resolved.filter((m) => m.type === 'song' && m.youtubeVideoId).map((m) => (
                      <div key={m.id} className="min-w-0">
                        <ThemeSongCard
                          variant="inline"
                          song={{
                            youtubeId: m.youtubeVideoId!,
                            title: 'Attached song',
                            artist: '',
                            coverUrl: `https://i.ytimg.com/vi/${m.youtubeVideoId}/mqdefault.jpg`,
                            startTime: 0,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. The note, if there is one. Only shown when it is not
                  already doing duty as the title above. */}
              {openPin.caption && openPin.name && (
                /* Italic, not a serif: this app has no serif anywhere, and
                   introducing one for a single paragraph would read as a
                   mistake rather than as a voice. Italic is already how the
                   app writes quoted and spoken text elsewhere. */
                <p className="whitespace-pre-wrap text-[15px] italic leading-relaxed text-fg/90">
                  {openPin.caption}
                </p>
              )}

              {/* The content of the memory: a cover, the song, then the
                  pictures at full size.

                  The banner is decoration, not the photo viewer. It crops the
                  first picture to a strip so the card opens on something of
                  the place rather than on text — the actual photos live in the
                  grid below, uncropped, where a portrait shot is not sliced
                  through the middle. One photo therefore appears twice, as the
                  cover and again in the grid, which is deliberate: every pin
                  then has the same shape whether it holds one picture or six. */}
              {resolved === null ? (
                <div className="flex justify-center py-6">
                  <Loader2 size={18} className="animate-spin text-subtle" />
                </div>
              ) : resolved.length === 0 ? null : (
                (() => {
                  const photos = resolved.filter((m) => m.type === 'photo' && m.url);
                  const videos = resolved.filter((m) => m.type === 'video' && m.url);
                  const cover = photos[0]?.url;

                  return (
                    <div className="space-y-2">
                      {/* Cover. Not a button: tapping it would duplicate the
                          grid image directly below and give the same picture
                          two hit targets a thumb-width apart. */}
                      {cover && (
                        <div className="relative h-28 w-full overflow-hidden rounded-xl border border-line bg-black">
                          <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
                          {/* Without this the cover was indistinguishable from
                              a first grid tile that had drifted upwards. The
                              gradient is what tells the eye it is a header:
                              headers are darkened at the bottom because text
                              usually sits there, so the shape reads as chrome
                              even with no text on it. */}
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/20 to-transparent"
                          />
                        </div>
                      )}

                      {/* The gallery: an index of what is attached, in uniform
                          square cells.

                          Mixed aspect ratios made this look broken — rows of
                          different heights with gaps between them, which reads
                          as a layout bug rather than as photographs. Squares
                          crop, but only the THUMBNAIL: tapping opens the
                          original whole. That is the difference from the 150px
                          banner this replaced, where the crop was the only view
                          of the picture there was. */}
                      {photos.length > 0 && (
                        <div
                          className={cn(
                            'grid gap-2',
                            photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
                          )}
                        >
                          {photos.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setViewingImage(m.url!)}
                              aria-label="Open photo full size"
                              className="group/shot relative block aspect-square overflow-hidden rounded-xl border border-line bg-elev/60"
                            >
                              <img
                                src={m.url}
                                alt=""
                                loading="lazy"
                                className="h-full w-full cursor-zoom-in object-cover transition-transform duration-200 group-hover/shot:scale-[1.02]"
                              />
                              <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover/shot:opacity-100">
                                Tap to expand
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Video keeps its own full-width block. It is played, not
                          browsed, so it does not belong in a thumbnail grid. */}
                      {videos.map((m) => (
                        <div key={m.id}>
                          <VideoPlayer
                            src={m.url!}
                            poster={m.posterUrl}
                            className="max-h-[240px] border border-line"
                          />
                        </div>
                      ))}
                    </div>
                  );
                })()
              )}

              {/* 5. The map, last and small. It is context for the name, not
                  the subject — 128px rather than the 160px+ that made it read
                  as the main content. Coordinates live under it, which is the
                  only place they are shown at all now. */}
              <div className="pt-1">
                <PinMap
                  center={[openPin.latitude, openPin.longitude]}
                  zoom={15}
                  pins={[{
                    id: openPin.id,
                    latitude: openPin.latitude,
                    longitude: openPin.longitude,
                    color: colorOf.get(openPin.spaceId),
                  }]}
                  className="h-32"
                />
                <p className="mt-1.5 text-[11px] tabular-nums text-subtle">
                  {openPin.latitude.toFixed(5)}, {openPin.longitude.toFixed(5)}
                </p>
              </div>

              {/* A fade pinned to the bottom edge of the scroll area, so a
                  half-visible row of photos reads as "keep scrolling" rather
                  than as an image that failed to load.

                  sticky, not absolute: the scroll container has no positioned
                  ancestor to hang an overlay from, and a sticky last child
                  sits against the visible bottom edge for free. The negative
                  margin pulls it over the content instead of adding to the
                  scroll height, which would leave a strip nothing can reach. */}
              <div
                aria-hidden="true"
                className="pointer-events-none sticky bottom-0 -mt-8 h-8 bg-gradient-to-t from-surface to-transparent"
              />
            </ModalBody>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {viewingImage && <ImageViewer url={viewingImage} onClose={() => setViewingImage(null)} />}
      </AnimatePresence>

      <AnimatePresence>
        {confirmDelete && (
          <ConfirmDialog
            title="Delete this pin?"
            description="It disappears for everyone in the space."
            confirmLabel="Delete pin"
            destructive
            icon={<Trash2 size={26} />}
            onConfirm={() => { handleDeletePin(confirmDelete); setConfirmDelete(null); }}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
