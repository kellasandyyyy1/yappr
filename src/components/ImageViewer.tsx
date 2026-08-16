import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ZoomIn, ZoomOut, Download, RotateCw } from 'lucide-react';
import { cn } from '../lib/utils';

interface ImageViewerProps {
  url: string;
  onClose: () => void;
}

export function ImageViewer({ url, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.5, 4));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.5, 0.5));
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);

  const handleDownload = () => {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = `image-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{ zIndex: "var(--z-nested-modal)" }} className="fixed inset-0 bg-black/95 flex flex-col items-center justify-center p-4 lg:p-12"
    >
      {/* Controls Overlay */}
      <div className="absolute top-0 inset-x-0 p-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-2">
          <button
            onClick={handleZoomIn}
            className="w-12 h-12 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg hover:bg-surface-3 transition-colors active:scale-90"
            title="Zoom In"
          >
            <ZoomIn size={20} />
          </button>
          <button
            onClick={handleZoomOut}
            className="w-12 h-12 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg hover:bg-surface-3 transition-colors active:scale-90"
            title="Zoom Out"
          >
            <ZoomOut size={20} />
          </button>
          <button
            onClick={handleRotate}
            className="w-12 h-12 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg hover:bg-surface-3 transition-colors active:scale-90"
            title="Rotate"
          >
            <RotateCw size={20} />
          </button>
          <button
            onClick={handleDownload}
            className="w-12 h-12 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg hover:bg-surface-3 transition-colors active:scale-90"
            title="Download"
          >
            <Download size={20} />
          </button>
        </div>

        <button
          onClick={onClose}
          className="w-12 h-12 rounded-full bg-surface-3 border border-line-strong flex items-center justify-center text-white hover:bg-white hover:text-black transition-colors active:scale-90"
          title="Close"
        >
          <X size={24} />
        </button>
      </div>

      {/* Image Container */}
      <div className="relative w-full h-full flex items-center justify-center overflow-hidden cursor-zoom-in">
        <motion.img
          src={url}
          alt="Preview"
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale, rotate: rotation, opacity: 1 }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          className="max-w-full max-h-full object-contain shadow-2xl rounded-sm"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {/* Zoom indicator */}
      <div className="absolute bottom-10 px-4 py-2 rounded-full bg-surface-2 border border-line text-xs font-black tracking-[0.3em] text-subtle">
        {Math.round(scale * 100)}% ZOOM
      </div>
    </motion.div>
  );
}
