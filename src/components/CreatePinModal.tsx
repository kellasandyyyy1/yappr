import React, { useState, useRef, useEffect } from 'react';
import { MapPin as MapPinIcon, Image as ImageIcon, Video as VideoIcon, Music, X, Loader2 } from './icons';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
import { PinMap, useCurrentLocation } from './PinMap';
import { LocationSearch } from './LocationSearch';
import { ThemeSongSearch } from './ThemeSongSearch';
import { VideoPlayer } from './VideoPlayer';
import { useToast } from './ToastContext';
import { uploadFile, uploadFileWithProgress, UploadError } from '../lib/supabase';
import { pins as pinsApi, PinMediaType, MapSpace } from '../lib/pins';
import { validateVideo, extractPoster, VIDEO_ACCEPT } from '../lib/video';
import { describeError } from '../lib/utils';
import type { User, ThemeSong } from '../types';

interface CreatePinModalProps {
  user: User;
  /** The pin is scoped to this space; membership decides who sees it. */
  space: MapSpace;
  onClose: () => void;
  onCreated?: (pinId: string) => void;
}

interface DraftMedia {
  key: string;
  type: PinMediaType;
  previewUrl?: string;
  file?: File;
  posterBlob?: Blob;
  song?: ThemeSong;
}

/**
 * Drop a pin into a space, and attach media to it.
 *
 * Two steps, not three: there is no recipient picker any more. The space's
 * membership already decides who sees this, which is the point of spaces.
 */
export function CreatePinModal({ user, space, onClose, onCreated }: CreatePinModalProps) {
  const [step, setStep] = useState<'place' | 'attach'>('place');
  const [draft, setDraft] = useState<{ latitude: number; longitude: number } | null>(null);
  const [placeName, setPlaceName] = useState('');
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<DraftMedia[]>([]);
  const [showSongSearch, setShowSongSearch] = useState(false);
  const [saving, setSaving] = useState(false);
  // Set when a search result is chosen, so the map recentres on it.
  const [searchCenter, setSearchCenter] = useState<[number, number] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { center, asking } = useCurrentLocation();

  useEffect(
    () => () => media.forEach((m) => m.previewUrl && URL.revokeObjectURL(m.previewUrl)),
    [media]
  );

  const addPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMedia((prev) => [
      ...prev,
      { key: `p${Date.now()}`, type: 'photo', file, previewUrl: URL.createObjectURL(file) },
    ]);
  };

  const addVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const problem = validateVideo(file);
    if (problem) { toast(problem, 'error'); return; }

    try {
      const poster = await extractPoster(file);
      setMedia((prev) => [
        ...prev,
        { key: `v${Date.now()}`, type: 'video', file, previewUrl: URL.createObjectURL(file), posterBlob: poster.blob },
      ]);
      URL.revokeObjectURL(poster.objectUrl);
    } catch (err) {
      console.error('[pin] poster extraction failed', { name: file.name, err });
      toast(describeError(err), 'error');
    }
  };

  const removeMedia = (key: string) =>
    setMedia((prev) => {
      const gone = prev.find((m) => m.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((m) => m.key !== key);
    });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const stamp = Date.now();
      const uploaded: Array<{
        type: PinMediaType;
        url?: string;
        youtubeVideoId?: string;
        songTitle?: string;
        songArtist?: string;
        posterUrl?: string;
      }> = [];

      for (const [i, m] of media.entries()) {
        if (m.type === 'song' && m.song) {
          // The title was being dropped here: the picker knows it, the
          // database had nowhere to put it, so every pin showed "Attached
          // song". 0021 added the columns.
          uploaded.push({
            type: 'song',
            youtubeVideoId: m.song.youtubeId,
            songTitle: m.song.title,
            songArtist: m.song.artist || undefined,
          });
          continue;
        }
        if (!m.file) continue;

        if (m.type === 'photo') {
          const url = await uploadFile('posts', `${user.uid}/pin-${stamp}-${i}-${m.file.name}`, m.file, m.file.type);
          uploaded.push({ type: 'photo', url });
        } else {
          setProgress(0);
          const extension = m.file.name.split('.').pop()?.toLowerCase() || 'mp4';
          const url = await uploadFileWithProgress(
            'post-videos',
            `${user.uid}/pin-${stamp}-${i}.${extension}`,
            m.file,
            setProgress,
            m.file.type || 'video/mp4'
          );
          let posterUrl: string | undefined;
          if (m.posterBlob) {
            posterUrl = await uploadFile('post-videos', `${user.uid}/pin-${stamp}-${i}.poster.jpg`, m.posterBlob, 'image/jpeg');
          }
          uploaded.push({ type: 'video', url, posterUrl });
          setProgress(null);
        }
      }

      const pinId = await pinsApi.create({
        spaceId: space.id,
        creatorId: user.uid,
        latitude: draft.latitude,
        longitude: draft.longitude,
        name: placeName,
        caption,
        media: uploaded,
      });

      toast(`Pinned to ${space.name}`, 'success');
      onCreated?.(pinId);
      onClose();
    } catch (err) {
      console.error('Error creating pin:', err);
      toast(err instanceof UploadError ? err.message : describeError(err), 'error');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  return (
    <Modal onClose={onClose} size="lg" labelledBy="pin-title" className="sm:h-[85vh]">
      <ModalHeader
        title="New pin"
        subtitle={
          step === 'place'
            ? `Tap the map — everyone in ${space.name} will see it`
            : 'Attach photos, videos or a song'
        }
        onClose={onClose}
        id="pin-title"
      />

      <ModalBody className="scrollbar-thin">
        {step === 'place' ? (
          <div className="space-y-3">
            {/* Choosing a result recentres the map AND drops the pin there.
                Searching a place then having to find and tap it again is
                busywork — the tap is still available to adjust. */}
            <LocationSearch
              userId={user.uid}
              onPick={(place) => {
                setSearchCenter([place.latitude, place.longitude]);
                setDraft({ latitude: place.latitude, longitude: place.longitude });
              }}
            />

            <PinMap
              center={searchCenter ?? center}
              zoom={searchCenter ? 15 : undefined}
              draft={draft}
              onPick={(latitude, longitude) => setDraft({ latitude, longitude })}
              className="h-[45vh] min-h-[260px]"
            />
            {asking && (
              <p className="flex items-center gap-1.5 text-xs text-subtle">
                <Loader2 size={12} className="animate-spin" />
                Finding your location…
              </p>
            )}
            {draft ? (
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <MapPinIcon size={12} className="text-accent" />
                {draft.latitude.toFixed(5)}, {draft.longitude.toFixed(5)}
              </p>
            ) : (
              <p className="text-xs text-subtle">
                No location permission is needed — you can pan and tap anywhere.
              </p>
            )}
            {/* The name leads, because it is what the pin means. The
                coordinates are a footnote below the map. */}
            <input
              value={placeName}
              onChange={(e) => setPlaceName(e.target.value)}
              maxLength={80}
              placeholder="Name this place — 'Where we watched the fireworks'"
              className="field text-base font-semibold"
            />

            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="A few words about it… (optional)"
              className="field resize-none"
            />
          </div>
        ) : (
          <div className="space-y-3">
            <input type="file" ref={photoRef} onChange={addPhoto} accept="image/*" className="hidden" />
            <input type="file" ref={videoRef} onChange={addVideo} accept={VIDEO_ACCEPT} className="hidden" />

            <div className="flex gap-2">
              {([
                ['Photo', ImageIcon, () => photoRef.current?.click()],
                ['Video', VideoIcon, () => videoRef.current?.click()],
                ['Song', Music, () => setShowSongSearch(true)],
              ] as const).map(([label, Icon, onClick]) => (
                <button
                  key={label}
                  type="button"
                  onClick={onClick}
                  className="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-line bg-surface-2 py-3 text-muted transition-colors hover:text-fg"
                >
                  <Icon size={18} />
                  <span className="text-[11px] font-medium">{label}</span>
                </button>
              ))}
            </div>

            {media.length === 0 ? (
              <p className="py-8 text-center text-sm text-subtle">Nothing attached yet.</p>
            ) : (
              <ul className="space-y-2">
                {media.map((m) => (
                  <li key={m.key} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-2">
                    {m.type === 'photo' && m.previewUrl && (
                      <img src={m.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                    )}
                    {m.type === 'video' && m.previewUrl && (
                      <div className="h-12 w-16 shrink-0 overflow-hidden rounded-lg">
                        <VideoPlayer src={m.previewUrl} className="h-full" />
                      </div>
                    )}
                    {m.type === 'song' && m.song && (
                      <img src={m.song.coverUrl} alt="" referrerPolicy="no-referrer" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fg">{m.song?.title ?? m.file?.name ?? m.type}</p>
                      <p className="text-xs capitalize text-subtle">{m.type}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeMedia(m.key)}
                      aria-label="Remove"
                      className="shrink-0 p-1 text-subtle transition-colors hover:text-danger"
                    >
                      <X size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        {progress !== null && (
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="text-muted">Uploading video</span>
              <span className="tabular-nums text-subtle">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          {step === 'attach' && (
            <button type="button" onClick={() => setStep('place')} className="btn-secondary h-11 px-4 text-sm">
              Back
            </button>
          )}
          <button
            type="button"
            disabled={!draft || saving}
            onClick={() => (step === 'place' ? setStep('attach') : save())}
            className="btn-primary ml-auto flex h-11 items-center justify-center gap-2 px-5 text-sm"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {step === 'place' ? 'Next' : saving ? 'Saving…' : 'Drop pin'}
          </button>
        </div>
      </ModalFooter>

      {showSongSearch && (
        <Modal onClose={() => setShowSongSearch(false)} size="lg" nested>
          <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
            <ThemeSongSearch
              onClose={() => setShowSongSearch(false)}
              onSelect={(song) => {
                setMedia((prev) => [...prev, { key: `s${Date.now()}`, type: 'song', song }]);
                setShowSongSearch(false);
              }}
            />
          </div>
        </Modal>
      )}
    </Modal>
  );
}
