import React, { useEffect, useState, useCallback } from 'react';
import { MapPin as MapPinIcon, Plus, X, Loader2, AlertCircle, Trash2, Users as UsersIcon } from 'lucide-react';
import { PinMap, useCurrentLocation } from './PinMap';
import { CreatePinModal } from './CreatePinModal';
import { VideoPlayer } from './VideoPlayer';
import { ThemeSongCard } from './ThemeSongCard';
import { ImageViewer } from './ImageViewer';
import { Modal, ModalHeader, ModalBody, ConfirmDialog } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from './ToastContext';
import { pins as pinsApi, Pin, PinMedia } from '../lib/pins';
import { formatTimeAgo, describeError } from '../lib/utils';
import { AnimatePresence } from 'motion/react';
import type { User } from '../types';

interface MapViewProps {
  user: User;
  onUserClick?: (uid: string) => void;
}

/**
 * The map: every pin the viewer can reach — their own, plus anything shared
 * with them directly or through a group they are in.
 *
 * The list comes straight from `pins.visible()` with no client-side filter.
 * RLS decides what is returned; filtering again here could only ever hide
 * something that was legitimately shared.
 */
export function MapView({ user, onUserClick }: MapViewProps) {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openPin, setOpenPin] = useState<Pin | null>(null);
  const [resolved, setResolved] = useState<PinMedia[] | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { center } = useCurrentLocation();
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      setPins(await pinsApi.visible());
      setError(null);
    } catch (err) {
      // A failed fetch is not an empty map. Saying "no pins yet" when the
      // query failed is the same conflation that made a broken comment query
      // look like missing data.
      console.error('Error loading pins:', err);
      setError(describeError(err));
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

  const handleDelete = async (id: string) => {
    try {
      await pinsApi.remove(id);
      setOpenPin(null);
      setPins((prev) => prev?.filter((p) => p.id !== id) ?? null);
      toast('Pin removed', 'info');
    } catch (err) {
      console.error('Error deleting pin:', err);
      toast('Could not remove that pin', 'error');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-fg">Map</h1>
          <p className="truncate text-xs text-muted">
            {pins === null ? 'Loading…' : `${pins.length} pin${pins.length === 1 ? '' : 's'} you can see`}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="btn-primary flex h-10 shrink-0 items-center gap-2 px-4 text-sm"
        >
          <Plus size={16} />
          New pin
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-danger">Couldn't load pins</p>
            <p className="mt-0.5 text-xs leading-relaxed text-danger/90">{error}</p>
          </div>
        </div>
      )}

      {pins === null ? (
        <div className="flex min-h-[300px] flex-1 items-center justify-center rounded-2xl border border-line bg-surface-2">
          <Loader2 size={22} className="animate-spin text-subtle" />
        </div>
      ) : (
        <PinMap
          center={center}
          className="min-h-[320px] flex-1"
          pins={pins.map((p) => ({
            id: p.id,
            latitude: p.latitude,
            longitude: p.longitude,
            // Someone else's pin is dimmed, so "mine" and "shared with me" are
            // distinguishable without opening anything.
            muted: p.creatorId !== user.uid,
          }))}
          onPinClick={(id) => setOpenPin(pins.find((p) => p.id === id) ?? null)}
        />
      )}

      {pins !== null && pins.length === 0 && !error && (
        <p className="text-center text-sm text-muted">
          No pins yet. Drop one to remember a place.
        </p>
      )}

      <AnimatePresence>
        {creating && (
          <CreatePinModal user={user} onClose={() => setCreating(false)} onCreated={load} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {openPin && (
          <Modal onClose={() => setOpenPin(null)} size="lg" labelledBy="pin-detail" className="sm:h-[80vh]">
            <ModalHeader
              title={openPin.caption || 'Memory pin'}
              subtitle={`${openPin.latitude.toFixed(5)}, ${openPin.longitude.toFixed(5)}`}
              onClose={() => setOpenPin(null)}
              id="pin-detail"
            >
              {openPin.creatorId === user.uid && (
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
                  <p className="truncate text-xs text-muted">
                    pinned {formatTimeAgo(openPin.createdAt)}
                  </p>
                </div>
                {openPin.shares.length > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-subtle">
                    <UsersIcon size={12} />
                    {openPin.shares.length}
                  </span>
                )}
              </div>

              <PinMap
                center={[openPin.latitude, openPin.longitude]}
                zoom={15}
                pins={[{ id: openPin.id, latitude: openPin.latitude, longitude: openPin.longitude }]}
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
            description="Its media and everyone it was shared with go with it."
            confirmLabel="Delete pin"
            destructive
            icon={<Trash2 size={26} />}
            onConfirm={() => { handleDelete(confirmDelete); setConfirmDelete(null); }}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
