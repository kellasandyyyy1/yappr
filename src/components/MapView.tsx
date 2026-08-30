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

  /** Stable colour per space, by list position. */
  const colorOf = useMemo(() => {
    const byId = new Map<string, string>();
    (spaces ?? []).forEach((s, i) => byId.set(s.id, spaceColor(i)));
    return byId;
  }, [spaces]);

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
            <ModalHeader
              title={openPin.caption || 'Pin'}
              subtitle={`${spaceOf(openPin.spaceId)?.name ?? 'Space'} · ${openPin.latitude.toFixed(5)}, ${openPin.longitude.toFixed(5)}`}
              onClose={() => setOpenPin(null)}
              id="pin-detail"
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

            <ModalBody className="scrollbar-thin space-y-3">
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
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: colorOf.get(openPin.spaceId) }}
                />
              </div>

              <PinMap
                center={[openPin.latitude, openPin.longitude]}
                zoom={15}
                pins={[{
                  id: openPin.id,
                  latitude: openPin.latitude,
                  longitude: openPin.longitude,
                  color: colorOf.get(openPin.spaceId),
                }]}
                className="h-40"
              />

              {resolved === null ? (
                <div className="flex justify-center py-6">
                  <Loader2 size={18} className="animate-spin text-subtle" />
                </div>
              ) : resolved.length === 0 ? (
                <p className="py-4 text-center text-sm text-subtle">No media on this pin.</p>
              ) : (
                <div className="space-y-2">
                  {resolved.map((m) => (
                    <div key={m.id}>
                      {m.type === 'photo' && m.url && (
                        <img
                          src={m.url}
                          alt=""
                          onClick={() => setViewingImage(m.url!)}
                          className="w-full cursor-zoom-in rounded-xl border border-line object-cover"
                          loading="lazy"
                        />
                      )}
                      {m.type === 'video' && m.url && (
                        <VideoPlayer src={m.url} poster={m.posterUrl} className="border border-line" />
                      )}
                      {m.type === 'song' && m.youtubeVideoId && (
                        <ThemeSongCard
                          song={{
                            youtubeId: m.youtubeVideoId,
                            title: 'Attached song',
                            artist: '',
                            coverUrl: `https://i.ytimg.com/vi/${m.youtubeVideoId}/mqdefault.jpg`,
                            startTime: 0,
                          }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
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
