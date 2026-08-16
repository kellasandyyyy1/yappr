import React, { useState, useRef, useEffect } from 'react';
import {
  users as usersApi,
  posts as postsApi,
  follows as followsApi,
  songs as songsApi,
  notifications as notificationsApi,
} from '../lib/db';
import { uploadFile } from '../lib/supabase';
import { User, ThemeSong, PostVisibility } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { X, Image as ImageIcon, Loader2, Mic, Square, Trash2, AtSign, Music, Globe, Users as UsersIcon, Lock, Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { sendPushNotification } from '../lib/sendPush';
import { VoiceMessage } from './VoiceMessage';
import { useToast } from './ToastContext';
import { ThemeSongSearch } from './ThemeSongSearch';
import { Avatar } from './Avatar';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';

const VISIBILITY_OPTIONS: {
  id: PostVisibility;
  label: string;
  description: string;
  icon: typeof Globe;
}[] = [
  { id: 'public', label: 'Public', description: 'Anyone on Yappr can see this', icon: Globe },
  { id: 'followers', label: 'Followers', description: 'Only people who follow you', icon: UsersIcon },
  { id: 'private', label: 'Only me', description: 'Visible on your profile only', icon: Lock },
];

interface CreatePostModalProps {
  user: User;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreatePostModal({ user, onClose, onSuccess }: CreatePostModalProps) {
  const [content, setContent] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [pendingVoice, setPendingVoice] = useState<{ url: string; blob: Blob } | null>(null);
  const [selectedSong, setSelectedSong] = useState<ThemeSong | null>(null);
  const [showMusicSearch, setShowMusicSearch] = useState(false);
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false);
  const [justPosted, setJustPosted] = useState(false);
  const [followings, setFollowings] = useState<User[]>([]);
  const [mentionSearch, setMentionSearch] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchFollowings = async () => {
      try {
        // One join instead of a getDoc per followed account.
        setFollowings(await followsApi.list(user.uid, 'following'));
      } catch (err) {
        console.error('Error fetching followings for mentions:', err);
      }
    };
    fetchFollowings();
  }, [user.uid]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);

    const cursorPosition = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPosition);
    const words = textBeforeCursor.split(/\s/);
    const lastWord = words[words.length - 1];

    if (lastWord.startsWith('@')) {
      setMentionSearch(lastWord.slice(1).toLowerCase());
      setShowMentions(true);
      setMentionPosition({ top: e.target.offsetTop + 40, left: 0 });
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (targetUser: User) => {
    const cursorPosition = textareaRef.current?.selectionStart || 0;
    const textBeforeCursor = content.slice(0, cursorPosition);
    const textAfterCursor = content.slice(cursorPosition);
    
    const words = textBeforeCursor.split(/\s/);
    words[words.length - 1] = `@${targetUser.username} `;
    
    const newContent = words.join(' ') + textAfterCursor;
    setContent(newContent);
    setShowMentions(false);
    
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      if (selectedImages.length + files.length > 10) {
        alert('You can only upload up to 10 images.');
        return;
      }
      
      const newSelectedImages = [...selectedImages, ...files];
      setSelectedImages(newSelectedImages);
      
      const newPreviews: string[] = [];
      let loaded = 0;
      files.forEach((file: File) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          newPreviews.push(reader.result as string);
          loaded++;
          if (loaded === files.length) {
            setImagePreviews(prev => [...prev, ...newPreviews]);
          }
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const removeImage = (index: number) => {
    setSelectedImages(prev => prev.filter((_, i) => i !== index));
    setImagePreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() && selectedImages.length === 0 && !pendingVoice && !selectedSong) return;
    
    setIsPosting(true);
    try {
      // Images upload in parallel — the old loop was strictly sequential, so a
      // four-image post waited out four round trips end to end.
      const imageUrls = await Promise.all(
        selectedImages.map((file, index) =>
          uploadFile('posts', `${user.uid}/${Date.now()}-${index}-${file.name}`, file, file.type)
        )
      );

      // A voice note used to be stored as a base64 data URL inside the post
      // document. Postgres has no 1MB row ceiling to trip over, but a text
      // column is still the wrong place for audio.
      let voiceUrl: string | null = null;
      if (pendingVoice) {
        voiceUrl = await uploadFile(
          'posts',
          `${user.uid}/${Date.now()}-voice.webm`,
          pendingVoice.blob,
          pendingVoice.blob.type || 'audio/webm'
        );
      }

      // Songs are shared rows keyed on the YouTube id, not copied into
      // every post that references the same track.
      const songId = selectedSong ? await songsApi.upsert(selectedSong) : null;

      const postId = await postsApi.create({
        userId: user.uid,
        content: content || (pendingVoice ? 'Shared a voice message' : (selectedSong ? 'Soundtrack for today' : '')),
        type: pendingVoice ? 'voice' : (selectedImages.length > 0 ? 'image' : 'text'),
        visibility,
        imageUrls,
        voiceUrl,
        songId,
      });

      // One query for every @name, not one per name.
      const matches = content.match(/@(\w+)/g);
      if (matches) {
        const mentioned = await usersApi.byUsernames(matches.map(m => m.slice(1)));
        await Promise.all(
          mentioned
            .filter(target => target.uid !== user.uid)
            .map(async (target) => {
              await notificationsApi.create({
                recipientId: target.uid,
                actorId: user.uid,
                type: 'mention',
                postId,
              });
              sendPushNotification(
                target.uid,
                'You were mentioned',
                `${user.displayName} mentioned you in a post`,
                `/post/${postId}`
              );
            })
        );
      }

      setContent('');
      // Brief in-modal confirmation before handing back to the feed, so the
      // action visibly completes rather than the sheet just vanishing.
      setJustPosted(true);
      toast('Post shared', 'success');
      setTimeout(onSuccess, 650);
    } catch (err) {
      toast("Couldn't share your post", 'error');
      console.error('Error creating post:', err);
    } finally {
      setIsPosting(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          setPendingVoice({
            url: reader.result as string,
            blob: audioBlob
          });
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Mic error:', err);
      let errorMessage = 'Could not access microphone. Ensure no other app is using it.';
      
      const isPermissionError = err.name === 'NotAllowedError' || 
                               err.name === 'PermissionDeniedError' || 
                               err.message?.toLowerCase().includes('permission') ||
                               err.message?.toLowerCase().includes('dismissed');

      if (isPermissionError) {
        errorMessage = 'Microphone access denied or dismissed. Please allow access in your browser settings or try opening the app in a new tab.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMessage = 'No microphone found on this device.';
      }
      
      toast(errorMessage, 'error');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.onstop = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        audioChunksRef.current = [];
      };
      setIsRecording(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const canSubmit =
    !!content.trim() || selectedImages.length > 0 || !!pendingVoice || !!selectedSong;
  const activeVisibility =
    VISIBILITY_OPTIONS.find((o) => o.id === visibility) ?? VISIBILITY_OPTIONS[0];
  const VisibilityIcon = activeVisibility.icon;

  return (
    <Modal onClose={onClose} size="lg" labelledBy="new-post-title">
      <ModalHeader title="New post" onClose={onClose} id="new-post-title" />

      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        {/* Body grows with its content instead of filling a fixed-height
            sheet, so the toolbar sits just under the text rather than
            floating at the bottom of an empty modal. */}
        <ModalBody className="relative space-y-4">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={handleInputChange}
              placeholder={isRecording ? "Recording…" : "What's on your mind?"}
              disabled={isRecording || !!pendingVoice}
              rows={3}
              className="w-full resize-none bg-transparent text-[17px] leading-relaxed text-fg placeholder:text-subtle focus:outline-none disabled:opacity-50"
              autoFocus
            />

            <AnimatePresence>
              {isRecording && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="flex items-center justify-between rounded-2xl border border-danger/20 bg-danger/10 p-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
                    <span className="text-sm font-semibold text-danger">Recording {formatDuration(recordingTime)}</span>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={cancelRecording} aria-label="Discard recording" className="tap rounded-full text-muted transition-colors duration-100 hover:text-danger"><Trash2 size={18} /></button>
                    <button type="button" onClick={stopRecording} aria-label="Stop recording" className="tap rounded-full bg-danger text-black"><Square size={15} fill="currentColor" /></button>
                  </div>
                </motion.div>
              )}

              {pendingVoice && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="space-y-3 rounded-2xl border border-accent/20 bg-accent/10 p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-accent">Voice note</span>
                    <button type="button" onClick={() => setPendingVoice(null)} aria-label="Remove voice note" className="text-muted transition-colors duration-100 hover:text-fg"><X size={16} /></button>
                  </div>
                  <VoiceMessage url={pendingVoice.url} />
                </motion.div>
              )}

              {selectedSong && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="rounded-2xl border border-accent/20 bg-accent/5 p-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-line">
                      <img src={selectedSong.coverUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" loading="lazy" decoding="async" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-0.5 flex items-center gap-1.5">
                        <Music size={12} className="text-accent" />
                        <span className="text-xs font-semibold text-accent">Song</span>
                      </div>
                      <p className="truncate text-sm font-semibold text-fg">{selectedSong.title}</p>
                      <p className="truncate text-sm text-muted">{selectedSong.artist}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedSong(null)}
                      aria-label="Remove song"
                      className="tap shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-danger"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Attached photos. The remove control is always visible — a
                hover-only "x" is unreachable on touch. */}
            {imagePreviews.length > 0 && (
              <div>
                <p className="mb-2 text-sm text-muted">
                  {imagePreviews.length} photo{imagePreviews.length === 1 ? '' : 's'} attached
                </p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {imagePreviews.map((preview, index) => (
                    <div
                      key={index}
                      className="relative aspect-square overflow-hidden rounded-xl border border-line"
                    >
                      <img src={preview} alt={`Attachment ${index + 1}`} className="h-full w-full object-cover" loading="lazy" decoding="async" />
                      <button
                        type="button"
                        onClick={() => removeImage(index)}
                        aria-label={`Remove photo ${index + 1}`}
                        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/75 text-white transition-colors duration-100 hover:bg-danger hover:text-black"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <AnimatePresence>
              {showMentions && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.12 }}
                  style={{ zIndex: 'var(--z-popover)' }}
                  className="absolute inset-x-5 top-24 max-h-[200px] overflow-y-auto rounded-2xl border border-line bg-surface-2 shadow-xl sm:inset-x-6"
                >
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                    <AtSign size={13} className="text-accent" />
                    <span className="text-sm font-semibold text-muted">Mention someone</span>
                  </div>
                  {followings
                    .filter(f => f.username.toLowerCase().includes(mentionSearch) || f.displayName.toLowerCase().includes(mentionSearch))
                    .map(f => (
                      <button
                        key={f.uid}
                        type="button"
                        onClick={() => insertMention(f)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-100 hover:bg-surface-3"
                      >
                        <Avatar user={f} size="md" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-fg">{f.displayName}</span>
                          <span className="block truncate text-sm text-muted">@{f.username}</span>
                        </span>
                      </button>
                    ))}
                </motion.div>
              )}
            </AnimatePresence>
        </ModalBody>

        <ModalFooter className="space-y-3">
          {/* Visibility is a labelled control, not a bare icon — the current
              audience is spelled out in words at all times. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowVisibilityMenu((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={showVisibilityMenu}
              className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left transition-colors duration-100 hover:bg-surface-3"
            >
              <VisibilityIcon size={16} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">
                  Visible to: {activeVisibility.label}
                </span>
                <span className="block truncate text-xs text-muted">
                  {activeVisibility.description}
                </span>
              </span>
              <ChevronDown
                size={16}
                className={cn(
                  'shrink-0 text-muted transition-transform duration-150',
                  showVisibilityMenu && 'rotate-180'
                )}
              />
            </button>

            <AnimatePresence>
              {showVisibilityMenu && (
                <motion.ul
                  role="listbox"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.12 }}
                  style={{ zIndex: 'var(--z-popover)' }}
                  className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface-2 shadow-xl"
                >
                  {VISIBILITY_OPTIONS.map((option) => {
                    const OptionIcon = option.icon;
                    const isActive = option.id === visibility;
                    return (
                      <li key={option.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          onClick={() => {
                            setVisibility(option.id);
                            setShowVisibilityMenu(false);
                          }}
                          className={cn(
                            'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-100 hover:bg-surface-3',
                            isActive && 'bg-accent/10'
                          )}
                        >
                          <OptionIcon size={16} className={isActive ? 'text-accent' : 'text-muted'} />
                          <span className="min-w-0 flex-1">
                            <span className={cn('block text-sm font-semibold', isActive ? 'text-accent' : 'text-fg')}>
                              {option.label}
                            </span>
                            <span className="block text-xs text-muted">{option.description}</span>
                          </span>
                          {isActive && <Check size={16} className="shrink-0 text-accent" />}
                        </button>
                      </li>
                    );
                  })}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageSelect}
              accept="image/*"
              multiple
              className="hidden"
            />
            {/* Each attachment control carries a text label, not just a glyph. */}
            <button
              type="button"
              disabled={isRecording || !!pendingVoice || selectedImages.length >= 10}
              onClick={() => fileInputRef.current?.click()}
              title="Attach photos"
              className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 text-sm font-medium text-muted transition-colors duration-100 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ImageIcon size={18} />
              <span className="hidden sm:inline">Photo</span>
              {selectedImages.length > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-white">
                  {selectedImages.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={startRecording}
              disabled={isRecording || !!pendingVoice || selectedImages.length > 0}
              title="Record a voice note"
              className={cn(
                'flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40',
                isRecording
                  ? 'border-danger bg-danger text-black'
                  : 'border-line bg-surface-2 text-muted hover:text-fg'
              )}
            >
              <Mic size={18} />
              <span className="hidden sm:inline">Voice</span>
            </button>

            <button
              type="button"
              onClick={() => setShowMusicSearch(true)}
              disabled={isRecording || !!pendingVoice}
              title="Attach a song"
              className={cn(
                'flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40',
                selectedSong
                  ? 'border-accent bg-accent text-white'
                  : 'border-line bg-surface-2 text-muted hover:text-fg'
              )}
            >
              <Music size={18} />
              <span className="hidden sm:inline">Song</span>
            </button>

            <button
              disabled={isPosting || justPosted || !canSubmit}
              className="btn-primary ml-auto flex h-11 min-w-[110px] items-center justify-center gap-2 px-5 text-sm"
            >
              {justPosted ? (
                <>
                  <Check size={16} />
                  Posted
                </>
              ) : isPosting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Posting…
                </>
              ) : (
                'Post'
              )}
            </button>
          </div>
        </ModalFooter>
      </form>

      <AnimatePresence>
        {showMusicSearch && (
          <Modal onClose={() => setShowMusicSearch(false)} size="lg" nested>
            <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
              <ThemeSongSearch
                onClose={() => setShowMusicSearch(false)}
                onSelect={(song) => {
                  setSelectedSong(song);
                  setShowMusicSearch(false);
                }}
                initialSong={selectedSong || undefined}
              />
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </Modal>
  );
}

