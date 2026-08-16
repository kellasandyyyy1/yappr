import React, { useState, useEffect } from 'react';
import { users as usersApi, chats as chatsApi } from '../lib/db';
import { uploadFile } from '../lib/supabase';
import { User } from '../types';
import { X, Search, Users, Check, Camera, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { RowSkeleton } from './Skeleton';
import { Avatar } from './Avatar';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';

interface CreateGroupModalProps {
  user: User;
  onClose: () => void;
  onCreated: (chat: any) => void;
}

export function CreateGroupModal({ user, onClose, onCreated }: CreateGroupModalProps) {
  const [groupName, setGroupName] = useState('');
  // Preview is a local data URL; the actual bytes go to Storage on submit
  // rather than being inlined into the row.
  const [groupPhoto, setGroupPhoto] = useState<string | null>(null);
  const [groupPhotoFile, setGroupPhotoFile] = useState<File | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.trim().length < 2) {
        setSearchResults([]);
        return;
      }

      setLoading(true);
      try {
        // Substring match on username *or* display name. The Firestore range
        // trick could only do prefix-on-username, so "smith" never found
        // @johnsmith.
        setSearchResults(await usersApi.search(searchQuery.trim(), user.uid, 10));
      } catch (err) {
        console.error('Error searching users:', err);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, user.uid]);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setGroupPhotoFile(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setGroupPhoto(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const toggleUser = (user: User) => {
    if (selectedUsers.find(u => u.uid === user.uid)) {
      setSelectedUsers(selectedUsers.filter(u => u.uid !== user.uid));
    } else {
      setSelectedUsers([...selectedUsers, user]);
    }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim() || selectedUsers.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const conversationId = await chatsApi.createGroup({
        name: groupName.trim(),
        createdBy: user.uid,
        memberIds: selectedUsers.map(u => u.uid),
      });

      // Uploaded after the row exists so the object path can be keyed on the
      // conversation id. Group photos live in the public `posts` bucket
      // because they render next to every inbox row.
      if (groupPhotoFile) {
        const photoUrl = await uploadFile(
          'posts',
          `groups/${conversationId}-${Date.now()}`,
          groupPhotoFile,
          groupPhotoFile.type
        );
        await chatsApi.updateGroup(conversationId, { photoUrl });
      }

      // sender_id is null on a system message rather than the literal string
      // 'system', which had no matching user row and broke the author join.
      await chatsApi.sendSystem(conversationId, `${user.displayName} created "${groupName.trim()}"`);

      const chat = await chatsApi.get(conversationId, user.uid);
      if (chat) onCreated(chat);
      onClose();
    } catch (err) {
      console.error('Error creating group:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} size="md" labelledBy="new-group-title">
      <ModalHeader
        title="New group"
        subtitle="Create a group chat"
        onClose={onClose}
        id="new-group-title"
      />

      <div className="shrink-0 space-y-4 border-b border-line px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={handlePhotoUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Add a group photo"
            className="group flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-surface-2 text-muted"
          >
            {groupPhoto ? (
              <img src={groupPhoto} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
            ) : (
              <Camera size={22} className="transition-colors duration-100 group-hover:text-fg" />
            )}
          </button>
          <div className="flex-1">
            <label htmlFor="group-name" className="field-label">
              Group name
            </label>
            <input
              id="group-name"
              type="text"
              placeholder="e.g. Weekend plans"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              className="field"
            />
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" size={16} />
          <input
            type="search"
            placeholder="Search for people to add"
            aria-label="Search for people to add"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="field pl-11"
          />
        </div>
      </div>

      <ModalBody className="space-y-3">
        {searchResults.length > 0 ? (
          searchResults.map(user => {
            const isSelected = !!selectedUsers.find(u => u.uid === user.uid);
            return (
              <button
                key={user.uid}
                onClick={() => toggleUser(user)}
                aria-pressed={isSelected}
                className={cn(
                  "flex w-full items-center gap-3 rounded-2xl border p-3 transition-colors duration-100",
                  isSelected ? "border-accent/50 bg-accent/10" : "border-line bg-surface-2 hover:bg-surface-3"
                )}
              >
                <Avatar user={user} size="lg" />
                <div className="min-w-0 flex-1 text-left">
                  <h4 className="truncate text-[15px] font-semibold text-fg">{user.displayName}</h4>
                  <p className="truncate text-sm text-muted">@{user.username}</p>
                </div>
                <div className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-100",
                  isSelected ? "border-accent bg-accent text-white" : "border-line-strong text-transparent"
                )}>
                  <Check size={14} />
                </div>
              </button>
            );
          })
        ) : searchQuery.length >= 2 && !loading ? (
          <p className="py-8 text-center text-sm text-muted">No people found.</p>
        ) : loading ? (
           <div className="space-y-3">
             <RowSkeleton />
             <RowSkeleton />
             <RowSkeleton />
           </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Users size={32} className="text-muted" />
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              Search for people to add to this group.
            </p>
          </div>
        )}
      </ModalBody>

      <ModalFooter className="space-y-3">
        {/* Live roster of who's in the group, right above the action. */}
        {selectedUsers.length > 0 && (
          <div>
            <p className="mb-2 text-sm text-muted">
              {selectedUsers.length} {selectedUsers.length === 1 ? 'person' : 'people'} selected
            </p>
            <ul className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
              {selectedUsers.map(member => (
                <li key={member.uid}>
                  <button
                    onClick={() => toggleUser(member)}
                    aria-label={`Remove ${member.displayName}`}
                    className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 py-1 pl-1 pr-2.5 text-sm font-medium text-accent transition-colors duration-100 hover:bg-accent/20"
                  >
                    <Avatar user={member} size="xs" />
                    <span className="max-w-[120px] truncate">{member.displayName}</span>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          disabled={!groupName.trim() || selectedUsers.length === 0 || isSubmitting}
          onClick={handleCreateGroup}
          className="btn-primary flex h-12 w-full items-center justify-center gap-2 text-sm"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="animate-spin" size={16} />
              Creating…
            </>
          ) : (
            'Create group'
          )}
        </button>
      </ModalFooter>
    </Modal>
  );
}
