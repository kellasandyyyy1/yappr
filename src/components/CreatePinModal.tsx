import React, { useState, useRef, useEffect } from 'react';
import { MapPin as MapPinIcon, Image as ImageIcon, Video as VideoIcon, Music, X, Loader2, Check, Users as UsersIcon, Search } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
import { PinMap, useCurrentLocation } from './PinMap';
import { ThemeSongSearch } from './ThemeSongSearch';
import { VideoPlayer } from './VideoPlayer';
import { useToast } from './ToastContext';
import { uploadFile, uploadFileWithProgress, UploadError } from '../lib/supabase';
import { chats as chatsApi, follows as followsApi } from '../lib/db';
import { pins as pinsApi, PinMediaType } from '../lib/pins';
import { validateVideo, extractPoster, VIDEO_ACCEPT } from '../lib/video';
import { cn } from '../lib/utils';
import type { User, Chat, ThemeSong } from '../types';

interface CreatePinModalProps {
  user: User;
  onClose: () => void;
  onCreated?: (pinId: string) => void;
}

interface DraftMedia {
  key: string;
  type: PinMediaType;
  /** Local preview while composing. */
  previewUrl?: string;
  file?: File;
  posterBlob?: Blob;
  song?: ThemeSong;
}

type Step = 'place' | 'attach' | 'share';

/**
 * Drop a pin, attach media to it, choose who sees it.
 *
 * Three steps rather than one screen: placing a pin is a map interaction that
 * wants the whole panel, and the share step is the one that actually matters
 * for privacy, so it gets its own moment rather than being a control the user
 * scrolls past.
 */
export function CreatePinModal({ user, onClose, onCreated }: CreatePinModalProps) {
  const [step, setStep] = useState<Step>('place');
  const [draft, setDraft] = useState<{ latitude: number; longitude: number } | null>(null);
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<DraftMedia[]>([]);
  const [showSongSearch, setShowSongSearch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const [people, setPeople] = useState<User[]>([]);
  const [conversations, setConversations] = useState<Chat[]>([]);
  const [pickedUsers, setPickedUsers] = useState<Set<string>>(new Set());
  const [pickedChats, setPickedChats] = useState<Set<string>>(new Set());
  const [shareQuery, setShareQuery] = useState('');

  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { center, asking } = useCurrentLocation();

  // Share targets are loaded up front so the last step never waits.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mutuals, chats] = await Promise.all([
          followsApi.mentionable(user.uid),
          chatsApi.list(user.uid),
        ]);
        if (cancelled) return;
        setPeople(mutuals);
        setConversations(chats.filter((c) => c.type === 'group'));
      } catch (err) {
        console.error('Error loading share targets:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user.uid]);

  // Object URLs outlive the component unless revoked, and a few video blobs is
  // real memory.
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
      const message = err instanceof Error ? err.message : 'Could not read that video.';
      console.error('[pin] poster extraction failed', { name: file.name, err });
      toast(message, 'error');
    }
  };

  const removeMedia = (key: string) =>
    setMedia((prev) => {
      const gone = prev.find((m) => m.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((m) => m.key !== key);
    });

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    apply(next);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const stamp = Date.now();
      const uploaded: Array<{ type: PinMediaType; url?: string; youtubeVideoId?: string; posterUrl?: string }> = [];

      for (const [i, m] of media.entries()) {
        if (m.type === 'song' && m.song) {
          uploaded.push({ type: 'song', youtubeVideoId: m.song.youtubeId });
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
        creatorId: user.uid,
        latitude: draft.latitude,
        longitude: draft.longitude,
        caption,
        media: uploaded,
        shareWithUserIds: [...pickedUsers],
        shareWithConversationIds: [...pickedChats],
      });

      toast('Memory pinned', 'success');
      onCreated?.(pinId);
      onClose();
    } catch (err) {
      console.error('Error creating pin:', err);
      toast(err instanceof UploadError ? err.message : 'Could not save that pin', 'error');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const filteredPeople = people.filter((p) =>
    `${p.displayName} ${p.username}`.toLowerCase().includes(shareQuery.toLowerCase())
  );
  const shareCount = pickedUsers.size + pickedChats.size;

  return (
    <Modal onClose={onClose} size="lg" labelledBy="pin-title" className="sm:h-[85vh]">
      <ModalHeader
        title="Memory pin"
        subtitle={
          step === 'place' ? 'Tap the map to drop a pin'
          : step === 'attach' ? 'Attach photos, videos or a song'
          : 'Choose who can see it'
        }
        onClose={onClose}
        id="pin-title"
      />

      <ModalBody className="scrollbar-thin">
        {step === 'place' && (
          <div className="space-y-3">
            <PinMap
              center={center}
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
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={500}
              placeholder="What happened here? (optional)"
              className="field"
            />
          </div>
        )}

        {step === 'attach' && (
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
                      <p className="truncate text-sm text-fg">
                        {m.song?.title ?? m.file?.name ?? m.type}
                      </p>
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

        {step === 'share' && (
          <div className="space-y-3">
            {/* A pin has no public state. Sharing with nobody is allowed and
                means exactly that: only you will ever see it. */}
            <p className="text-xs leading-relaxed text-muted">
              Pins are private. Only the people and groups you pick here will see this one.
            </p>

            <div className="relative">
              <input
                value={shareQuery}
                onChange={(e) => setShareQuery(e.target.value)}
                placeholder="Search people…"
                className="field pl-10"
              />
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
            </div>

            {conversations.length > 0 && (
              <>
                <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-subtle">Groups</h3>
                <ul className="space-y-1">
                  {conversations.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => toggle(pickedChats, c.id, setPickedChats)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors',
                          pickedChats.has(c.id) ? 'bg-accent/10' : 'hover:bg-surface-2'
                        )}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted">
                          <UsersIcon size={16} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{c.name ?? 'Group'}</span>
                        {pickedChats.has(c.id) && <Check size={16} className="shrink-0 text-accent" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-subtle">People</h3>
            {filteredPeople.length === 0 ? (
              <p className="py-6 text-center text-sm text-subtle">No one to show.</p>
            ) : (
              <ul className="space-y-1">
                {filteredPeople.map((p) => (
                  <li key={p.uid}>
                    <button
                      type="button"
                      onClick={() => toggle(pickedUsers, p.uid, setPickedUsers)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors',
                        pickedUsers.has(p.uid) ? 'bg-accent/10' : 'hover:bg-surface-2'
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{p.displayName}</span>
                        <span className="block truncate text-xs text-muted">@{p.username}</span>
                      </span>
                      {pickedUsers.has(p.uid) && <Check size={16} className="shrink-0 text-accent" />}
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
          {step !== 'place' && (
            <button
              type="button"
              onClick={() => setStep(step === 'share' ? 'attach' : 'place')}
              className="btn-secondary h-11 px-4 text-sm"
            >
              Back
            </button>
          )}
          <button
            type="button"
            disabled={!draft || saving}
            onClick={() => (step === 'share' ? save() : setStep(step === 'place' ? 'attach' : 'share'))}
            className="btn-primary ml-auto flex h-11 items-center justify-center gap-2 px-5 text-sm"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {step === 'share'
              ? saving ? 'Saving…' : shareCount > 0 ? `Share with ${shareCount}` : 'Save privately'
              : 'Next'}
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
