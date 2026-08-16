import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';
import { cn } from '../lib/utils';

interface VoiceMessageProps {
  url: string;
  isMe?: boolean;
  className?: string;
}

export function VoiceMessage({ url, isMe, className }: VoiceMessageProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;

    audio.onloadedmetadata = () => setDuration(audio.duration);
    audio.ontimeupdate = () => setProgress((audio.currentTime / audio.duration) * 100);
    audio.onended = () => {
      setIsPlaying(false);
      setProgress(0);
    };

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [url]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => {
        setIsPlaying(true);
      }).catch(err => {
        console.error('Audio play failed:', err);
        setIsPlaying(false);
      });
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return '0:00';
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className={cn("flex items-center gap-3 py-2 min-w-[200px]", className)}>
      <button 
        onClick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
        className={cn(
          "w-10 h-10 rounded-full flex items-center justify-center transition-colors shadow-sm active:scale-90",
          isMe ? "bg-surface-3 text-white hover:bg-surface-3" : "bg-accent/20 text-accent hover:bg-accent/30"
        )}
      >
        {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
      </button>
      
      <div className="flex-1 flex flex-col gap-1.5">
        <div className={cn("h-1.5 w-full rounded-full overflow-hidden", isMe ? "bg-surface-3" : "bg-accent/10")}>
          <div 
            className={cn("h-full transition-colors duration-100", isMe ? "bg-white" : "bg-accent")}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between items-center text-muted">
           <span className="text-xs font-black tracking-widest uppercase text-white">
             {isPlaying ? formatTime(audioRef.current?.currentTime || 0) : 'Voice'}
           </span>
           <span className="text-xs font-black tracking-widest uppercase text-white">{formatTime(duration)}</span>
        </div>
      </div>
      <Volume2 size={14} className="text-muted" />
    </div>
  );
}
