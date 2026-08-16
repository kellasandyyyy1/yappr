import React, { useState, useEffect } from 'react';
import { follows as followsApi } from '../lib/db';
import { User } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Users } from 'lucide-react';
import { Modal, ModalHeader, ModalBody } from './Modal';
import { Avatar } from './Avatar';
import { RowSkeleton } from './Skeleton';

interface UsersListModalProps {
  title: string;
  userId: string;
  type: 'followers' | 'following';
  onClose: () => void;
  onUserClick?: (uid: string) => void;
}

export function UsersListModal({ title, userId, type, onClose, onUserClick }: UsersListModalProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      try {
        // One join. The Firestore version fanned out a getDoc per follow row,
        // then hand-deduplicated because `addDoc` had allowed duplicate follows
        // — the composite primary key rules those out at the source now.
        setUsers(await followsApi.list(userId, type));
      } catch (err) {
        console.error('Error fetching users:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [userId, type]);

  const displayTitle = type === 'followers' ? 'Followers' : 'Following';

  return (
    <Modal onClose={onClose} size="md" labelledBy="users-list-title" className="sm:h-[70vh]">
      <ModalHeader title={displayTitle} onClose={onClose} id="users-list-title" />

      <ModalBody>

          {loading ? (
            <div className="space-y-3">
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </div>
          ) : users.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3">
              <Users size={32} className="text-muted" />
              <p className="text-center text-sm text-muted">Nobody here yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {users.map((user) => (
                <div
                  key={user.uid}
                  className="flex items-center gap-3 p-3 rounded-2xl bg-surface border border-line group cursor-pointer hover:bg-surface-2 transition-colors duration-100"
                  onClick={() => {
                    if (onUserClick) {
                      onUserClick(user.uid);
                      onClose();
                    }
                  }}
                >
                  <Avatar user={user} size="lg" />
                  <div className="flex-1 min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-fg">{user.displayName}</h3>
                    <p className="truncate text-sm text-muted">@{user.username}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
      </ModalBody>
    </Modal>
  );
}
