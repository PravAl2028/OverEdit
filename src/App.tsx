import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { useMediaStore, type MediaAsset } from './store/useMediaStore';
import { useTimelineStore, type Clip, type Track } from './store/useTimelineStore';
import { listen } from '@tauri-apps/api/event';

// --- CSS INJECTIONS FOR TOOLS (Normally would be in index.css) ---
const INLINE_STYLES = `
  .timeline-dropzone { transition: background 0.2s ease; }
  .timeline-dropzone.drag-over { background: rgba(255, 255, 255, 0.05); }
  .floating-toolbar { 
      display: none; 
      opacity: 0; 
      transition: opacity 0.2s ease; 
      animation: slide-up 0.2s ease forwards;
  }
  .clip-container:hover .floating-toolbar { display: flex; opacity: 1; }
  @keyframes slide-up { from { transform: translate(-50%, 4px); } to { transform: translate(-50%, 0); } }

  .toolbar-pill {
      background: rgba(20, 20, 20, 0.95) !important;
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5) !important;
      border-radius: 24px !important;
      padding: 4px 12px !important;
      gap: 12px !important;
  }
  
  .toolbar-btn {
      display: flex; 
      align-items: center; 
      gap: 4px; 
      font-size: 11px !important; 
      background: transparent !important; 
      color: #ddd !important;
      border: none !important;
      padding: 6px 8px !important;
      border-radius: 6px !important;
      transition: all 0.2s ease;
      cursor: pointer;
  }
  .toolbar-btn:hover { background: rgba(255, 255, 255, 0.1) !important; color: #fff !important; }
  .toolbar-btn.del:hover { background: rgba(255, 68, 68, 0.2) !important; color: #ff6666 !important; }

  .neon-glow { box-shadow: 0 0 10px rgba(59, 130, 246, 0.8), 0 0 20px rgba(59, 130, 246, 0.4); z-index: 50 !important; }
  .drag-block { cursor: grab; }
  .drag-block:active { cursor: grabbing; }
  .dragging-visual { opacity: 0.7; pointer-events: none; z-index: 1000 !important; filter: brightness(1.1) saturate(1.2); }
  .settlement-ghost { border: 2px dashed var(--accent); opacity: 0.3; pointer-events: none; z-index: 5; background: rgba(255,255,255,0.03); border-radius: 6px; }

  /* Custom Sleek Dark Scrollbar */
  ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
  }
  ::-webkit-scrollbar-track {
      background: transparent;
  }
  ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      border: 1px solid rgba(0, 0, 0, 0.3);
  }
  ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.25);
  }
  
  /* Corner piece where horizontal and vertical scrollbars overlap */
  ::-webkit-scrollbar-corner {
      background: transparent;
  }
`;

const App: React.FC = () => {
  const [status, setStatus] = useState<string>("Ready");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // Playback & Context Engine
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewFocus, setPreviewFocus] = useState<'timeline' | 'asset'>('timeline');

  // UI States
  const [draggingClip, setDraggingClip] = useState<{ trackId: string; clipId: string; startX: number; origStart: number; visualStart: number; clickOffsetSec: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; clipId: string } | null>(null);
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [isDraggingOverTimeline, setIsDraggingOverTimeline] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Web Audio Context & Node Pool
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Map of clip.id -> { audio, source, gain }
  const audioNodeMapRef = useRef<Map<string, { audio: HTMLAudioElement, gain: GainNode, source: MediaElementAudioSourceNode }>>(new Map());
  const activeAudioHashRef = useRef<string>("");

  useEffect(() => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current = ctx;
    return () => { ctx.close(); };
  }, []);

  const { assets, addAsset, selectedAssetId, selectAsset } = useMediaStore();
  const {
    tracks, frameStrips, clipboard, zoomLevel, selectedClipId, isRippleEnabled,
    setFrameStrip, splitAtPlayhead, trimClipStart, trimClipEnd, setRippleEnabled,
    setClipSpeed, setClipVolume, setClipPriority, setClipWaveform, removeClip, moveClip, copyClip, pasteClip,
    duplicateClip, undo, redo, setZoomLevel, setSelectedClipId, insertClipAtTime, setLinkedGroupId
  } = useTimelineStore();

  const PX_PER_SEC = zoomLevel;
  const TRACK_LABEL_WIDTH = 60;

  // Sync / Boot
  useEffect(() => {
    async function testConnection() {
      try {
        const response: string = await invoke('test_backend_connection', { message: 'React Frontend' });
        setStatus(response);
      } catch (e) {
        setStatus("Backend System: Online");
      }
    }
    testConnection();
    const documentStyle = document.createElement('style');
    documentStyle.innerHTML = INLINE_STYLES;
    document.head.appendChild(documentStyle);

    const unlisten = listen<number>('export-progress', (event) => setExportProgress(Math.round(event.payload * 100)));
    return () => {
      unlisten.then(f => f());
      document.head.removeChild(documentStyle);
    };
  }, []);

  const selectedAsset = assets.find(a => a.id === selectedAssetId);

  // Global Context Clearing
  const clearSelection = useCallback(() => {
    setSelectedClipId(null);
    setMultiSelectedIds([]);
  }, [setSelectedClipId]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === ' ' && !draggingClip) {
        e.preventDefault();
        setIsPlaying(p => !p);
      }
      if (e.key === 's' || e.key === 'S') {
        splitAtPlayhead(currentTime);
        setPreviewFocus('timeline');
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) {
          const track = tracks.find(t => t.clips.some(c => c.id === selectedClipId));
          if (track) removeClip(track.id, selectedClipId);
        }
      }

      if (e.ctrlKey || e.metaKey) {
        // Undo / Redo (Standard & Windows Conventions)
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          redo();
        }

        // Copy / Paste
        else if (e.key === 'c' || e.key === 'C') {
          if (selectedClipId) {
            const track = tracks.find(t => t.clips.some(c => c.id === selectedClipId));
            if (track) { copyClip(track.id, selectedClipId); setStatus("Clip copied"); }
          }
        } else if (e.key === 'v' || e.key === 'V') {
          if (clipboard) {
            pasteClip(clipboard.trackId, currentTime);
            setStatus("Clip pasted at playhead");
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tracks, currentTime, clipboard, undo, redo, copyClip, pasteClip, draggingClip, selectedClipId, removeClip, splitAtPlayhead]);

  const processImportedFiles = useCallback(async (files: string[], targetTrackId: 'video-1' | 'audio-1' | null = null) => {
    for (const file of files) {
      try {
        setStatus(`Importing ${file.split('\\').pop()}...`);
        const asset: MediaAsset = await invoke('import_media_asset', { file_path: file });
        addAsset(asset);

        let finalTrackId = targetTrackId;
        const ext = file.toLowerCase();
        const isIndependentAudio = ext.endsWith('.mp3') || ext.endsWith('.wav');
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].some(e => ext.endsWith(e));
        if (!finalTrackId) {
          finalTrackId = isIndependentAudio ? 'audio-1' : 'video-1';
        }
        // Images always go to video track
        if (isImage) finalTrackId = 'video-1';

        // Calculate the absolute end using the LATEST store state to append sequentially!
        const currentTracks = useTimelineStore.getState().tracks;
        const targetTrack = currentTracks.find(t => t.id === finalTrackId);
        let maxTimelineEnd = 0;
        if (targetTrack && !isIndependentAudio) {
          maxTimelineEnd = targetTrack.clips.reduce((max, clip) => {
            const dur = (clip.sourceEnd - clip.sourceStart) / clip.playbackSpeed;
            return Math.max(max, clip.timelineStart + dur);
          }, 0);
        }

        insertClipAtTime(finalTrackId, asset.id, asset.duration, maxTimelineEnd, asset.hasAudio, isIndependentAudio);

        if (isImage) {
          setStatus(`Image imported (${asset.duration}s)`);
        } else {
          try {
            // Attempt frame strip generation. Will fail silently for pure audio.
            const paths: string[] = await invoke('generate_frame_strip', {
              file_path: asset.filePath, asset_id: asset.id, interval_sec: asset.duration > 120 ? 2.0 : 1.0, duration: asset.duration,
            });
            setFrameStrip(asset.id, paths);
            setStatus(`Media imported (${paths.length} frames)`);
          } catch (frameErr) {
            setStatus("Media Imported (Audio / No frames)");
          }
        }

        // --- PHASE 4: AUDIO WAVEFORM GENERATION (Backgrounded) ---
        if (asset.hasAudio) {
          setStatus(`Imported ${asset.filePath.split('\\').pop()} (Analysis in background...)`);
          invoke<string>('generate_waveform', { file_path: asset.filePath, asset_id: asset.id })
            .then((waveformPath) => {
              const storeTracks = useTimelineStore.getState().tracks;
              const relevantClips = storeTracks.flatMap(t => t.clips).filter(c => c.assetId === asset.id);
              relevantClips.forEach(c => setClipWaveform(c.id, waveformPath));
              setStatus("Waveforms synchronized");
            })
            .catch((err: any) => {
              console.error("Waveform failed", err);
              setStatus(`Waveform error: ${err}`);
            });
        }
      } catch (err) {
        console.error("Failed importing file:", file, err);
      }
    }
    setStatus(`Successfully imported ${files.length} items`);
  }, [addAsset, insertClipAtTime, setStatus]);

  useEffect(() => {
    const setupDragDrop = async () => {
      const unlisten = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          await processImportedFiles(paths);
        }
      });
      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupDragDrop().then(unlistenFn => { cleanup = unlistenFn; });

    return () => {
      if (cleanup) cleanup();
    };
  }, [processImportedFiles]);

  const handleImportMedia = async (targetTrackId: 'video-1' | 'audio-1' | null = null) => {
    try {
      const selected = await open({ multiple: true, filters: [{ name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'avi', 'mp3', 'wav', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }] });
      if (selected) {
        const files = Array.isArray(selected) ? selected : [selected];
        await processImportedFiles(files, targetTrackId);
      }
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err}`);
    }
  };

  const handleExport = async () => {
    try {
      const outputPath = await save({ defaultPath: 'export.mp4', filters: [{ name: 'Video', extensions: ['mp4'] }] });
      if (!outputPath) return;
      setIsExporting(true); setExportProgress(0); setStatus("Exporting timeline...");
      const projectData = JSON.stringify(tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, filePath: assets.find(a => a.id === c.assetId)?.filePath || '' })) })));
      const finalPath: string = await invoke('export_timeline', { project_json: projectData, output_path: outputPath });
      setStatus(`Export complete: ${finalPath}`);
    } catch (err) { setStatus(`Export error: ${err}`); } finally { setIsExporting(false); }
  };

  const getClipTimelineDuration = (clip: Clip) => (clip.sourceEnd - clip.sourceStart) / clip.playbackSpeed;

  const totalTimelineDuration = tracks.reduce((maxDur, track) => {
    const trackEnd = track.clips.reduce((max, clip) => Math.max(max, clip.timelineStart + getClipTimelineDuration(clip)), 0);
    return Math.max(maxDur, trackEnd);
  }, 0);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    const f = Math.floor((seconds % 1) * 30).toString().padStart(2, '0');
    return `${m}:${s}:${f}`;
  };

  // --- UNIFIED PREVIEW ENGINE ---
  useEffect(() => {
    if (isPlaying) setPreviewFocus('timeline'); // Context rule: Rule 3
  }, [isPlaying]);

  const rAF = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  const updatePreviewMedia = useCallback((time: number, isEnginePlaying: boolean) => {
    if (previewFocus === 'asset') return;

    const videoTrack = tracks.find(t => t.id === 'video-1');
    const audioTracks = tracks.filter(t => t.type === 'audio');

    const activeVideo = videoTrack?.clips.find(c => time >= c.timelineStart && time < c.timelineStart + getClipTimelineDuration(c));

    // Find the topmost active audio clip across all dynamic tracks
    let activeAudio: Clip | undefined;
    for (let t of audioTracks) {
      activeAudio = t.clips.find(c => time >= c.timelineStart && time < c.timelineStart + getClipTimelineDuration(c));
      if (activeAudio) break;
    }

    if (videoRef.current && imageRef.current) {
      if (activeVideo) {
        const asset = assets.find(a => a.id === activeVideo.assetId);
        if (asset) {
          const src = convertFileSrc(asset.filePath);
          const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].some(e => asset.filePath.toLowerCase().endsWith(e));

          if (isImage) {
            // Show Image, Hide Video
            videoRef.current.style.display = 'none';
            imageRef.current.style.display = 'block';
            if (imageRef.current.src !== src) {
              imageRef.current.src = src;
            }
            if (!videoRef.current.paused) videoRef.current.pause();
          } else {
            // Show Video, Hide Image
            videoRef.current.style.display = 'block';
            imageRef.current.style.display = 'none';

            const srcPathOnly = videoRef.current.src.split('?')[0];
            const expectedPathOnly = src.split('?')[0];
            if (srcPathOnly !== expectedPathOnly && decodeURIComponent(srcPathOnly) !== decodeURIComponent(expectedPathOnly)) {
              videoRef.current.src = src;
            }

            videoRef.current.playbackRate = activeVideo.playbackSpeed;
            // Dynamically mute the root video player if ANY audio clip is dictating playback at this time!
            videoRef.current.muted = !!activeAudio;

            const sourceTime = activeVideo.sourceStart + ((time - activeVideo.timelineStart) * activeVideo.playbackSpeed);

            if (Math.abs(videoRef.current.currentTime - sourceTime) > 0.1 || !isEnginePlaying) {
              videoRef.current.currentTime = sourceTime;
            }
            if (isEnginePlaying && videoRef.current.paused) videoRef.current.play().catch(() => { });
            if (!isEnginePlaying && !videoRef.current.paused) videoRef.current.pause();
          }
        }
      } else {
        if (!videoRef.current.paused) videoRef.current.pause();
        videoRef.current.style.display = 'block';
        imageRef.current.style.display = 'none';
      }
    }

    // WEB AUDIO API - MULTI-TRACK ENGINE
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (isEnginePlaying && ctx.state === 'suspended') ctx.resume();

    const allActiveAudioClips = audioTracks.flatMap(t => t.clips).filter(c => time >= c.timelineStart && time < c.timelineStart + getClipTimelineDuration(c));
    const nodeMap = audioNodeMapRef.current;

    // 1. Cleanup inactive source nodes to save memory
    for (const [id, node] of nodeMap.entries()) {
      if (!allActiveAudioClips.find(c => c.id === id)) {
        node.audio.pause();
        node.audio.removeAttribute('src');
        nodeMap.delete(id); // Garbage collection natively severs the AudioGraph
      }
    }

    // 2. Hydrate & Sync active nodes
    for (const clip of allActiveAudioClips) {
      let node = nodeMap.get(clip.id);
      if (!node) {
        const audio = new Audio();
        audio.crossOrigin = "anonymous";
        const asset = assets.find(a => a.id === clip.assetId);
        if (asset) audio.src = convertFileSrc(asset.filePath);

        const source = ctx.createMediaElementSource(audio);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(ctx.destination);

        node = { audio, gain, source };
        nodeMap.set(clip.id, node);
      }

      // Time synchronization
      node.audio.playbackRate = clip.playbackSpeed;
      const expectedSourceTime = clip.sourceStart + ((time - clip.timelineStart) * clip.playbackSpeed);
      if (Math.abs(node.audio.currentTime - expectedSourceTime) > 0.1 || (!isEnginePlaying && !node.audio.paused)) {
        node.audio.currentTime = expectedSourceTime;
      }

      if (isEnginePlaying && node.audio.paused) node.audio.play().catch(() => { });
      if (!isEnginePlaying && !node.audio.paused) node.audio.pause();
    }

    // 3. Ducking Mathematics (State-triggered)
    const currentHash = allActiveAudioClips.map(c => `${c.id}-${c.volume}-${c.priority}`).sort().join('|');
    if (activeAudioHashRef.current !== currentHash) {
      activeAudioHashRef.current = currentHash;

      if (allActiveAudioClips.length > 0) {
        const maxPriority = Math.max(...allActiveAudioClips.map(c => c.priority));
        const highestCount = allActiveAudioClips.filter(c => c.priority === maxPriority).length;

        for (const clip of allActiveAudioClips) {
          const node = nodeMap.get(clip.id);
          if (!node) continue;

          // Priority Ratio Equation
          let ratio = maxPriority === 0 ? 1 : (clip.priority / maxPriority);
          let targetGain = (clip.volume / 100) * ratio;

          // Equal Priority Scaling
          if (highestCount > 1 && clip.priority === maxPriority) {
            targetGain *= 0.9;
          }

          // Execute WebAudio Smooth Ducking Transition
          node.gain.gain.cancelScheduledValues(ctx.currentTime);
          node.gain.gain.setValueAtTime(node.gain.gain.value, ctx.currentTime);
          node.gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.15);
        }
      }
    }
  }, [tracks, assets, previewFocus]);

  useEffect(() => {
    if (previewFocus === 'asset') {
      if (rAF.current) { cancelAnimationFrame(rAF.current); rAF.current = null; }
      return;
    }

    if (isPlaying) {
      lastTimeRef.current = performance.now();
      const loop = (now: number) => {
        const delta = (now - lastTimeRef.current) / 1000;
        lastTimeRef.current = now;
        setCurrentTime(prev => {
          const next = prev + delta;
          if (next > totalTimelineDuration + 0.1 || tracks.length === 0) { setIsPlaying(false); return 0; }
          return next;
        });
        rAF.current = requestAnimationFrame(loop);
      };
      rAF.current = requestAnimationFrame(loop);
    } else {
      if (rAF.current) cancelAnimationFrame(rAF.current);
      updatePreviewMedia(currentTime, false);
    }
    return () => { if (rAF.current) cancelAnimationFrame(rAF.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, totalTimelineDuration, previewFocus, tracks.length]);

  useEffect(() => { if (previewFocus === 'timeline') updatePreviewMedia(currentTime, isPlaying); }, [currentTime, updatePreviewMedia, isPlaying, previewFocus]);

  const totalWidth = Math.max(totalTimelineDuration * PX_PER_SEC, 600) + 200;

  // --- DRAG TO TIMELINE LOGIC ---
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDraggingOverTimeline(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDraggingOverTimeline(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOverTimeline(false);
    const assetId = e.dataTransfer.getData('text/plain');
    if (!assetId) return;

    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;

    const scrollContainer = e.currentTarget.querySelector('.timeline-work-area');
    const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
    const rect = e.currentTarget.getBoundingClientRect();

    // Determine track via Y offset (heuristic: top half video, bottom half audio, assuming 2 tracks 50px each)
    const renderY = e.clientY - rect.top;
    // Rough detection: above ~100px from top inside timeline panel is video
    const targetTrackId = renderY < 80 ? 'video-1' : 'audio-1';

    // Drop X mapped to timeline seconds
    const clientX = e.clientX - rect.left + scrollLeft;
    let dropTime = Math.max(0, (clientX - TRACK_LABEL_WIDTH) / PX_PER_SEC);

    // Rule: Separate audio files always go to a new row at 0.0
    const isIndependentAudio = asset.filePath.toLowerCase().endsWith('.mp3') || asset.filePath.toLowerCase().endsWith('.wav');
    if (isIndependentAudio) dropTime = 0;

    insertClipAtTime(targetTrackId, asset.id, asset.duration, dropTime, asset.hasAudio, isIndependentAudio);
    setStatus(`Dropped ${asset.filePath.split('\\').pop()}`);
  };

  // --- INLINE CLIP DRAGGING ---
  const commitMove = useTimelineStore(s => s.commitMove);
  useEffect(() => {
    if (!draggingClip || !timelineRef.current) return;

    const container = timelineRef.current;
    const rect = container.getBoundingClientRect();

    const handleMouseMove = (e: MouseEvent) => {
      // Auto-Scrolling Logic
      const SCROLL_SPEED = 15;
      const EDGE_BUFFER = 60;
      if (e.clientX > rect.right - EDGE_BUFFER) {
        container.scrollLeft += SCROLL_SPEED;
      } else if (e.clientX < rect.left + EDGE_BUFFER + TRACK_LABEL_WIDTH) {
        container.scrollLeft -= SCROLL_SPEED;
      }

      // Relative Coordinate Math
      const mouseXInContainer = e.clientX - rect.left + container.scrollLeft;
      const requestedStart = (mouseXInContainer / PX_PER_SEC) - (TRACK_LABEL_WIDTH / PX_PER_SEC) - draggingClip.clickOffsetSec;

      let snappedStart = requestedStart;

      // Snapping Points calculation (for settlement)
      const TOLERANCE = 0.15; // 150ms snap threshold

      // GLOBAL SNAP POINTS - Collect from ALL tracks
      const others = tracks.flatMap(t => t.clips).filter(c => c.id !== draggingClip.clipId);
      const snapPoints = [0, currentTime];
      others.forEach(c => {
        snapPoints.push(c.timelineStart);
        const dur = (c.sourceEnd - c.sourceStart) / c.playbackSpeed;
        snapPoints.push(c.timelineStart + dur);
      });

      const targetClip = tracks.flatMap(t => t.clips).find(c => c.id === draggingClip.clipId);
      const clipDur = targetClip ? (targetClip.sourceEnd - targetClip.sourceStart) / targetClip.playbackSpeed : 0;

      let activeSnapPt: number | null = null;
      for (const pt of snapPoints) {
        if (Math.abs(requestedStart - pt) < TOLERANCE) {
          snappedStart = pt;
          activeSnapPt = pt;
          break;
        }
        if (Math.abs((requestedStart + clipDur) - pt) < TOLERANCE) {
          snappedStart = pt - clipDur;
          activeSnapPt = pt;
          break;
        }
      }

      setSnapGuideSec(activeSnapPt);
      setDraggingClip(prev => prev ? { ...prev, visualStart: requestedStart } : null);
      moveClip(draggingClip.trackId, draggingClip.clipId, snappedStart);
    };

    const handleMouseUp = () => {
      commitMove();
      setDraggingClip(null);
      setSnapGuideSec(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); };
  }, [draggingClip, PX_PER_SEC, moveClip, currentTime, tracks, commitMove]);


  const renderClip = (clip: Clip, track: Track) => {
    // Determine if this clip is being dragged, or is part of a linked group being dragged!
    const isDirectlyDragged = draggingClip?.clipId === clip.id;
    let isGroupDrag = false;
    let dragVisualOffsetSec = 0;
    
    if (draggingClip) {
       const draggedSourceClip = tracks.flatMap(t => t.clips).find(c => c.id === draggingClip.clipId);
       if (draggedSourceClip?.linkedGroupId && clip.linkedGroupId === draggedSourceClip.linkedGroupId) {
           isGroupDrag = true;
           dragVisualOffsetSec = draggingClip.visualStart - draggedSourceClip.timelineStart;
       } else if (isDirectlyDragged) {
           dragVisualOffsetSec = draggingClip.visualStart - clip.timelineStart;
       }
    }

    const isDragging = isDirectlyDragged || isGroupDrag;
    const isSelected = selectedClipId === clip.id || multiSelectedIds.includes(clip.id);
    const duration = getClipTimelineDuration(clip);
    const clipWidth = duration * PX_PER_SEC;

    // Settled position (from store, clamped/snapped)
    const settledLeft = TRACK_LABEL_WIDTH + clip.timelineStart * PX_PER_SEC;
    // Hovering position (if dragging, follows mouse raw based on group offset)
    const displayLeft = isDragging
      ? TRACK_LABEL_WIDTH + (clip.timelineStart + dragVisualOffsetSec) * PX_PER_SEC
      : settledLeft;

    const asset = assets.find(a => a.id === clip.assetId);
    const rawStrips = frameStrips[clip.assetId] || [];
    const validFrames = rawStrips.filter((_, i) => i >= clip.sourceStart && i <= clip.sourceEnd);

    // --- PERFORMANCE OPTIMIZATION: FRAME VIRTUALIZATION ---
    // Calculate max frames that visually fit without wasteful DOM rendering
    // Assume 48px is the minimum readable thumbnail width inside the clip
    const maxVisualFrames = Math.max(1, Math.ceil(clipWidth / 48));
    let displayFrames = validFrames;
    if (validFrames.length > maxVisualFrames) {
        const step = validFrames.length / maxVisualFrames;
        displayFrames = Array.from({ length: maxVisualFrames }).map((_, i) => validFrames[Math.floor(i * step)]);
    }

    const isVideo = track.type === 'video';
    const accentColor = isVideo ? 'var(--accent)' : 'rgba(59, 130, 246, 0.8)';

    return (
      <React.Fragment key={clip.id}>
        {/* Settlement Ghost Indicator */}
        {isDragging && (
          <div
            className="settlement-ghost"
            style={{
              position: 'absolute', left: `${settledLeft}px`, width: `${clipWidth}px`, height: '40px', top: '5px'
            }}
          />
        )}

        <div
          className={`clip-container ${isSelected ? 'neon-glow' : ''} ${isDragging ? 'dragging-visual' : 'drag-block'}`}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const rawX = e.clientX - rect.left;
            // Quantize movement to 30px steps for a more stable, premium feel
            const quantizedX = Math.round(rawX / 450) * 450
            setHoverInfo({ x: quantizedX, clipId: clip.id });
          }}
          onMouseLeave={() => setHoverInfo(null)}
          onMouseDown={(e) => {
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
              // Multi-select: toggle this clip in/out of selection
              setMultiSelectedIds(prev => {
                if (prev.includes(clip.id)) return prev.filter(id => id !== clip.id);
                const base = prev.length === 0 && selectedClipId && selectedClipId !== clip.id ? [selectedClipId] : prev;
                return [...base, clip.id];
              });
              setSelectedClipId(clip.id);
              setPreviewFocus('timeline');
              return; // Don't start drag on Ctrl+Click
            }
            setSelectedClipId(clip.id);
            setMultiSelectedIds([]);
            setPreviewFocus('timeline');
            if (e.target instanceof HTMLDivElement && e.target.style.cursor === 'col-resize') return;

            const rect = timelineRef.current?.getBoundingClientRect();
            const mouseX = e.clientX - (rect?.left || 0) + (timelineRef.current?.scrollLeft || 0);
            const clickTime = mouseX / PX_PER_SEC - TRACK_LABEL_WIDTH / PX_PER_SEC;
            const clickOffsetSec = clickTime - clip.timelineStart;

            setDraggingClip({
              trackId: track.id,
              clipId: clip.id,
              startX: e.clientX,
              origStart: clip.timelineStart,
              visualStart: clip.timelineStart,
              clickOffsetSec
            });
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setSelectedClipId(clip.id);
            setPreviewFocus('timeline');
          }}
          onContextMenu={(e) => {
            e.preventDefault(); e.stopPropagation();
            setSelectedClipId(clip.id);
            setPreviewFocus('timeline');
          }}
          style={{
            position: 'absolute', left: `${displayLeft}px`, width: `${clipWidth}px`, height: '40px', top: '5px',
            background: isVideo ? 'rgba(57, 255, 20, 0.12)' : 'rgba(59, 130, 246, 0.12)',
            border: `1px solid ${isSelected ? '#fff' : accentColor}`, borderRadius: '4px',
            overflow: 'visible', cursor: isDragging ? 'grabbing' : 'grab',
            display: 'flex', alignItems: 'center', userSelect: 'none',
            zIndex: isDragging ? 1000 : (isSelected ? 50 : 10),
            transition: isDragging ? 'none' : 'left 0.1s ease',
          }}
        >
          {/* Simplified Power Pill (Action Bar) - Dynamic Position & Track-Sensitive */}
          {!isDragging && (hoverInfo?.clipId === clip.id || isSelected) && (
            <>
              {/* Full-Width Interaction Guard: Ensures mouse never leaves the "hover system" */}
              <div style={{
                position: 'absolute',
                left: 0, right: 0,
                ...(isVideo ? { bottom: '-50px', height: '50px' } : { top: '-50px', height: '50px' }),
                zIndex: 190, background: 'transparent', cursor: 'default'
              }} />

              <div className="floating-toolbar toolbar-pill" style={{
                position: 'absolute',
                // VID tools below, AUD tools above
                ...(isVideo ? { bottom: '-46px' } : { top: '-46px' }),
                // Dynamically center pill at mouse hover position, but clamp within clip edges
                left: `${Math.max(40, Math.min(clipWidth - 40, (hoverInfo?.clipId === clip.id ? hoverInfo.x : clipWidth / 2)))}px`,
                transform: 'translateX(-50%)',
                zIndex: 200, pointerEvents: 'auto', display: 'flex', alignItems: 'center', minWidth: 'max-content',
                padding: '4px 10px'
              }}
                onMouseDown={e => e.stopPropagation()}
                onMouseMove={e => e.stopPropagation()} // STOP MOVING when hovering the bar itself
              >
                {/* CONTEXT-SENSITIVE PILL: Show different tools for multi-select vs single */}
                {multiSelectedIds.length >= 2 && multiSelectedIds.includes(clip.id) ? (
                  /* MULTI-SELECT MODE: Only show Link */
                  <>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginRight: '6px' }}>{multiSelectedIds.length} selected</span>
                    <button className="toolbar-btn" onClick={() => {
                      const newGroupId = `link-multi-${Date.now()}`;
                      
                      const allClips = tracks.flatMap(t => t.clips);
                      const existingGroupsToAbsorb = new Set(
                        allClips.filter(c => multiSelectedIds.includes(c.id) && c.linkedGroupId)
                                .map(c => c.linkedGroupId)
                      );
                      
                      const clipsToLink = allClips.filter(c => 
                        multiSelectedIds.includes(c.id) || 
                        (c.linkedGroupId && existingGroupsToAbsorb.has(c.linkedGroupId))
                      );

                      clipsToLink.forEach(c => {
                        const t = tracks.find(track => track.clips.some(trackClip => trackClip.id === c.id));
                        if (t) setLinkedGroupId(t.id, c.id, newGroupId);
                      });

                      setMultiSelectedIds([]);
                      setStatus(`Merged/Linked ${clipsToLink.length} clips`);
                    }} title="Link all selected clips together">
                      <span style={{ fontSize: '14px' }}>🔗</span> Link Selected
                    </button>
                    <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 8px' }} />
                    <button className="toolbar-btn" onClick={() => setMultiSelectedIds([])} title="Clear selection">
                      <span style={{ fontSize: '14px' }}>✕</span> Clear
                    </button>
                  </>
                ) : (
                  /* SINGLE CLIP MODE: Normal tools */
                  <>
                    <button className="toolbar-btn" onClick={() => splitAtPlayhead(currentTime, track.id)} title="Split at Playhead">
                      <span style={{ fontSize: '14px' }}>✂️</span> Split
                    </button>

                    <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 8px' }} />

                    <button className="toolbar-btn" onClick={() => duplicateClip(track.id, clip.id)} title="Duplicate Clip">
                      <span style={{ fontSize: '14px' }}>👥</span> Duplicate
                    </button>

                    <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 8px' }} />

                    <button className="toolbar-btn" onClick={() => removeClip(track.id, clip.id)} title="Delete Clip" style={{ color: '#ff5555' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                        <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                      <span style={{ fontWeight: 'bold' }}>Delete</span>
                    </button>

                    {/* Unlink Options: Only visible when clip IS linked */}
                    {clip.linkedGroupId && (
                      <>
                        <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 8px' }} />
                        
                        <button className="toolbar-btn" onClick={() => {
                            setLinkedGroupId(track.id, clip.id, null);
                            setStatus(`Unlinked clip from group`);
                        }} title="Remove this clip from the linked group">
                          <span style={{ fontSize: '14px' }}>⛓️</span> Unlink
                        </button>

                        <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 8px' }} />

                        <button className="toolbar-btn" onClick={() => {
                          const groupToUnlink = tracks.flatMap(t => t.clips).filter(c => c.linkedGroupId === clip.linkedGroupId);
                          groupToUnlink.forEach(c => {
                            const t = tracks.find(trackObj => trackObj.clips.some(clipObj => clipObj.id === c.id));
                            if (t) setLinkedGroupId(t.id, c.id, null);
                          });
                          setStatus(`Dissolved linked group`);
                        }} title="Unlink all clips in this group">
                          <span style={{ fontSize: '14px' }}>💔</span> Unlink All
                        </button>
                      </>
                    )}
                  </>
                )}

                {/* Small Arrow Pointer (Dynamic) */}
                <div style={{
                  position: 'absolute',
                  left: '50%', transform: 'translateX(-50%)', width: '0', height: '0',
                  borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                  // VID arrow at top pointing UP, AUD arrow at bottom pointing DOWN
                  ...(isVideo ? {
                    top: '-6px',
                    borderBottom: '6px solid rgba(20, 20, 20, 0.95)'
                  } : {
                    bottom: '-6px',
                    borderTop: '6px solid rgba(20, 20, 20, 0.95)'
                  })
                }} />
              </div>
            </>
          )}

          <div style={{ overflow: 'hidden', position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: '4px' }}>
            {isVideo && displayFrames.length > 0 && (
              <div style={{ display: 'flex', height: '100%', width: '100%', opacity: 0.5, pointerEvents: 'none' }}>
                {displayFrames.map((path, i) => (
                  <img key={i} src={convertFileSrc(path)} alt="" style={{ height: '100%', width: `${100 / displayFrames.length}%`, objectFit: 'cover' }} draggable={false} />
                ))}
              </div>
            )}
            {/* Image clip fallback: show thumbnail as full background */}
            {isVideo && displayFrames.length === 0 && asset?.thumbnailData && (
              <div style={{
                height: '100%', width: '100%', opacity: 0.6, pointerEvents: 'none',
                backgroundImage: `url(${asset.thumbnailData})`,
                backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat'
              }} />
            )}
            {!isVideo && (
              <div style={{
                height: '100%',
                width: '100%',
                background: 'linear-gradient(180deg, rgba(30,40,60,0.9) 0%, rgba(15,20,35,0.95) 100%)',
                position: 'relative',
                pointerEvents: 'none'
              }}>
                {clip.waveformPath && (
                  <img
                    src={convertFileSrc(clip.waveformPath)}
                    alt=""
                    draggable={false}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'fill',
                      opacity: 0.85,
                      filter: 'brightness(1.2) contrast(1.3)'
                    }}
                  />
                )}
              </div>
            )}
          </div>

          <div style={{ position: 'relative', zIndex: 2, paddingLeft: '6px', fontSize: '9px', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', fontWeight: 'bold', textShadow: '0 0 4px #000, 0 0 4px #000', display: 'flex', alignItems: 'center', gap: '4px' }}>
            {isVideo ? (validFrames.length === 0 && asset?.thumbnailData ? '🖼️' : '🎬') : '🔊'}
            {clip.linkedGroupId && <span title="Linked Sync" style={{ color: 'var(--accent)' }}>🔗</span>}
            {clip.name || asset?.filePath.split('\\').pop()?.slice(0, 15)}
            {clip.playbackSpeed !== 1 && `(${clip.playbackSpeed}x)`}
          </div>

          {/* Trim Handles - Only visible if selected! */}
          {isSelected && (
            <>
              <div
                onMouseDown={(e) => {
                  e.stopPropagation(); setPreviewFocus('timeline'); const startX = e.clientX; const origStart = clip.sourceStart;
                  const handler = (moveE: MouseEvent) => trimClipStart(track.id, clip.id, Math.max(0, origStart + ((moveE.clientX - startX) / PX_PER_SEC * clip.playbackSpeed)));
                  const up = () => { window.removeEventListener('mousemove', handler); window.removeEventListener('mouseup', up); };
                  window.addEventListener('mousemove', handler); window.addEventListener('mouseup', up);
                }}
                style={{ position: 'absolute', left: -2, top: 0, bottom: 0, width: '8px', cursor: 'col-resize', background: accentColor, borderRadius: '4px 0 0 4px' }}
              />
              <div
                onMouseDown={(e) => {
                  e.stopPropagation(); setPreviewFocus('timeline'); const startX = e.clientX; const origEnd = clip.sourceEnd;
                  const handler = (moveE: MouseEvent) => trimClipEnd(track.id, clip.id, origEnd + ((moveE.clientX - startX) / PX_PER_SEC * clip.playbackSpeed));
                  const up = () => { window.removeEventListener('mousemove', handler); window.removeEventListener('mouseup', up); };
                  window.addEventListener('mousemove', handler); window.addEventListener('mouseup', up);
                }}
                style={{ position: 'absolute', right: -2, top: 0, bottom: 0, width: '8px', cursor: 'col-resize', background: accentColor, borderRadius: '0 4px 4px 0' }}
              />
            </>
          )}
        </div>
      </React.Fragment>
    );
  };

  const selectedClip = tracks.flatMap(t => t.clips).find(c => c.id === selectedClipId);
  const selectedTrack = tracks.find(t => t.clips.some(c => c.id === selectedClipId));

  return (
    <Group id="overai-layout" orientation="vertical" className="panelGroup" onClick={clearSelection}>
      <Panel defaultSize={60} minSize={30}>
        <Group id="overai-top-row" orientation="horizontal">

          {/* MEDIA LIBRARY (LEFT) */}
          <Panel defaultSize={20} minSize={15} className="panel">
            <div className="panel-header">Media Library</div>
            <div className="panel-content" style={{ padding: '8px', display: 'flex', flexDirection: 'column' }}>
              <button onClick={() => handleImportMedia(null)} style={{ width: '100%', marginBottom: '16px', padding: '10px 8px', background: 'var(--accent)', color: '#000', fontWeight: 'bold' }}>+ Import Media</button>

              <button onClick={handleExport} disabled={isExporting || tracks.length === 0} style={{ width: '100%', marginBottom: '16px', padding: '8px', background: isExporting ? '#333' : '#4ade80', color: '#000', fontWeight: 'bold' }}>
                {isExporting ? `Exporting (${exportProgress}%)...` : '🎬 Export Project'}
              </button>

              <div className="asset-list" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {assets.map((asset) => (
                  <div
                    key={asset.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', asset.id)}
                    onClick={(e) => { e.stopPropagation(); selectAsset(asset.id); setPreviewFocus('asset'); setIsPlaying(false); clearSelection(); }}
                    style={{ padding: '8px', background: selectedAssetId === asset.id ? 'var(--bg-hover)' : 'var(--bg-elevated)', border: selectedAssetId === asset.id ? '1px solid var(--accent)' : '1px solid transparent', borderRadius: '4px', cursor: 'grab', display: 'flex', gap: '12px', alignItems: 'center' }}
                  >
                    {asset.thumbnailData ? <img src={asset.thumbnailData} alt="thumb" style={{ width: '60px', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '2px', pointerEvents: 'none' }} /> : <div style={{ width: '60px', aspectRatio: '16/9', backgroundColor: '#333' }} />}
                    <div style={{ overflow: 'hidden' }}><div style={{ fontSize: '11px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontWeight: 'bold', pointerEvents: 'none' }}>{asset.filePath.split('\\').pop() || asset.filePath.split('/').pop()}</div></div>
                  </div>
                ))}
                {assets.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px', marginTop: '20px' }}>Library is empty.<br />Import media or drag files here.</div>}
              </div>
              <div style={{ fontSize: '10px', marginTop: '12px', color: 'var(--text-muted)' }}>Status: <span className="text-accent">{status}</span></div>
            </div>
          </Panel>

          <Separator className="resize-handle-horizontal" />

          {/* PREVIEW COMPONENT (CENTER) */}
          <Panel defaultSize={60} minSize={30} className="panel">
            <div className="panel-header" style={{ justifyContent: 'space-between', background: previewFocus === 'asset' ? '#331111' : 'var(--bg-header)' }}>
              <span>{previewFocus === 'timeline' ? "Sequence Preview" : "Direct Asset Preview"}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{previewFocus === 'timeline' ? formatTime(currentTime) : ''}</span>
            </div>
            <div className="preview-container">
              <div className="preview-canvas" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>

                {/* UNIFIED VIDEO ENGINE */}
                {previewFocus === 'timeline' ? (
                  <>
                    <video ref={videoRef} style={{ width: '100%', flex: 1, objectFit: 'contain', background: '#000' }} />
                    <img ref={imageRef} style={{ width: '100%', flex: 1, objectFit: 'contain', background: '#000', display: 'none' }} alt="" />

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-color)' }}>
                      <button onClick={(e) => { e.stopPropagation(); setIsPlaying(p => !p); }} style={{ padding: '4px 12px', fontSize: '11px', cursor: 'pointer' }}>{isPlaying ? '⏸ Pause' : '▶ Play'}</button>
                      <input type="range" min={0} max={Math.max(0.1, totalTimelineDuration)} step={0.1} value={currentTime} onChange={(e) => { setPreviewFocus('timeline'); setCurrentTime(parseFloat(e.target.value)); }} style={{ flex: 1, accentColor: 'var(--accent)' }} onClick={e => e.stopPropagation()} />
                    </div>
                  </>
                ) : selectedAsset ? (
                  <>
                    {['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].some(e => selectedAsset.filePath.toLowerCase().endsWith(e)) ? (
                      <img src={convertFileSrc(selectedAsset.filePath)} style={{ width: '100%', flex: 1, objectFit: 'contain', background: '#000' }} alt="" />
                    ) : (
                      <video src={convertFileSrc(selectedAsset.filePath)} controls autoPlay style={{ width: '100%', flex: 1, objectFit: 'contain', background: '#000' }} />
                    )}
                  </>
                ) : (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Select an asset to preview, or scrub the timeline</div>
                )}
              </div>
            </div>
          </Panel>

          <Separator className="resize-handle-horizontal" />

          {/* DYNAMIC PROPERTIES (RIGHT) */}
          <Panel defaultSize={20} minSize={15} className="panel" onClick={e => e.stopPropagation()}>
            <div className="panel-header">Properties</div>
            <div className="panel-content" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {selectedClip && selectedTrack ? (
                // CLIP SELECTED CONTEXT
                <>
                  <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '8px' }}>
                    <h4 style={{ margin: 0, fontSize: '12px', color: 'var(--accent)' }}>Selected Clip</h4>
                    <p style={{ margin: '4px 0 0 0', fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {assets.find(a => a.id === selectedClip.assetId)?.filePath.split('\\').pop()}
                    </p>
                  </div>

                  <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>Speed <span style={{ color: 'var(--text-muted)' }}>{selectedClip.playbackSpeed}x</span></div>
                    <input type="range" min={0.25} max={4} step={0.25} value={selectedClip.playbackSpeed} onChange={(e) => setClipSpeed(selectedTrack.id, selectedClip.id, parseFloat(e.target.value))} />
                  </label>

                  <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>Volume {selectedClip.volume > 100 && <span style={{ color: 'var(--accent)', fontSize: '9px', fontWeight: 'bold' }}>BOOST</span>} <span style={{ color: selectedClip.volume > 100 ? 'var(--accent)' : 'var(--text-muted)' }}>{selectedClip.volume}%</span></div>
                    <input type="range" min={0} max={400} value={selectedClip.volume} onChange={(e) => setClipVolume(selectedTrack.id, selectedClip.id, parseInt(e.target.value))} />
                  </label>

                  <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>Priority <span style={{ color: 'var(--text-muted)' }}>{selectedClip.priority} / 100</span></div>
                    <input type="range" min={0} max={100} value={selectedClip.priority} onChange={(e) => setClipPriority(selectedTrack.id, selectedClip.id, parseInt(e.target.value))} />
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Higher ducks lower.</div>
                  </label>

                  <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>Opacity <span style={{ color: 'var(--text-muted)' }}>100%</span></div>
                    <input type="range" min={0} max={100} value={100} onChange={() => { }} />
                  </label>
                </>
              ) : (
                // GLOBAL CONTEXT
                <>
                  <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '8px' }}>
                    <h4 style={{ margin: 0, fontSize: '12px' }}>Project Settings</h4>
                  </div>
                  <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>Timeline Zoom <span style={{ color: 'var(--text-muted)' }}>{zoomLevel}px/s</span></div>
                    <input type="range" min={2} max={40} value={zoomLevel} onChange={(e) => setZoomLevel(parseInt(e.target.value))} />
                  </label>

                  <div style={{ fontSize: '10px', lineHeight: '1.8', marginTop: '16px' }}>
                    <p style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>SHORTCUTS</p>
                    <div><kbd>Space</kbd> Play / Pause</div>
                    <div><kbd>S</kbd> Split clip</div>
                    <div><kbd>Ctrl+Z</kbd> Undo / Redo</div>
                    <div><kbd>Ctrl+C</kbd> Copy</div>
                    <div><kbd>Ctrl+V</kbd> Paste</div>
                  </div>
                </>
              )}
            </div>
          </Panel>

        </Group>
      </Panel>

      <Separator className="resize-handle-vertical" />

      {/* TIMELINE */}
      <Panel defaultSize={40} minSize={20} className="panel">
        <div className="panel-header" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span>Sequence Timeline</span>
            <div style={{ width: '1px', height: '14px', background: '#444' }} />
            <button onClick={undo} style={{ padding: '2px 8px', fontSize: '10px', cursor: 'pointer', background: 'transparent', border: '1px solid #444', color: '#fff' }}>↩ Undo</button>
            <button onClick={redo} style={{ padding: '2px 8px', fontSize: '10px', cursor: 'pointer', background: 'transparent', border: '1px solid #444', color: '#fff' }}>↪ Redo</button>
            <div style={{ width: '1px', height: '14px', background: '#444' }} />
            <button
              onClick={() => setRippleEnabled(!isRippleEnabled)}
              title="Ripple Editing: Automatically shifts clips when one is deleted"
              style={{ padding: '2px 8px', fontSize: '10px', cursor: 'pointer', background: isRippleEnabled ? 'var(--accent)' : 'transparent', border: '1px solid #444', color: isRippleEnabled ? '#000' : '#fff', borderRadius: '2px', fontWeight: isRippleEnabled ? 'bold' : 'normal' }}
            >
              🌊 Ripple: {isRippleEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>


        {/* Dropzone Wrapper */}
        <div
          ref={timelineRef}
          className={`timeline-work-area timeline-dropzone ${isDraggingOverTimeline ? 'drag-over' : ''}`}
          style={{ overflowX: 'auto', overflowY: 'auto' }}
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
          onClick={() => { setPreviewFocus('timeline'); }}>

          <div style={{ minWidth: `${totalWidth}px`, position: 'relative', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>

            <div style={{ position: 'absolute', left: `${TRACK_LABEL_WIDTH + currentTime * PX_PER_SEC}px`, top: 0, bottom: 0, width: '2px', background: '#ff3333', zIndex: 100, pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', top: 0, left: '-5px', borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '8px solid #ff3333' }} />
            </div>

            {snapGuideSec !== null && (
              <div style={{ position: 'absolute', left: `${TRACK_LABEL_WIDTH + snapGuideSec * PX_PER_SEC}px`, top: '28px', bottom: 0, width: '1px', background: 'rgba(255, 50, 50, 0.9)', zIndex: 90, pointerEvents: 'none', boxShadow: '0 0 4px rgba(255,0,0,0.5)' }} />
            )}

            <div onClick={(e) => { e.stopPropagation(); setPreviewFocus('timeline'); const x = e.clientX - e.currentTarget.getBoundingClientRect().left; if (x > TRACK_LABEL_WIDTH) setCurrentTime((x - TRACK_LABEL_WIDTH) / PX_PER_SEC); }}
              style={{ height: '28px', minHeight: '28px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-elevated)', cursor: 'pointer', position: 'sticky', top: 0, zIndex: 5 }}>
              <div style={{ width: `${TRACK_LABEL_WIDTH}px`, position: 'absolute' }}></div>
              {Array.from({ length: Math.floor(totalTimelineDuration / (zoomLevel < 10 ? 10 : 5)) + 2 }).map((_, i) => {
                const sec = i * (zoomLevel < 10 ? 10 : 5);
                return (
                  <div key={i} style={{ position: 'absolute', left: `${TRACK_LABEL_WIDTH + sec * PX_PER_SEC}px`, bottom: '2px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{formatTime(sec)}</span>
                    <div style={{ width: '1px', height: '6px', background: 'var(--border-color)', marginTop: '1px' }} />
                  </div>
                )
              })}
            </div>

            {tracks.map(track => {
              const isTrackActive = track.clips.some(c => c.id === hoverInfo?.clipId || c.id === selectedClipId);
              return (
                <div key={track.id} style={{
                  minHeight: '60px', borderBottom: '1px solid var(--border-color)',
                  display: 'flex', alignItems: 'center', position: 'relative',
                  background: 'var(--bg-panel)',
                  zIndex: isTrackActive ? 100 : 10 // Dynamic elevation
                }}>
                  <div style={{ width: `${TRACK_LABEL_WIDTH}px`, minWidth: `${TRACK_LABEL_WIDTH}px`, borderRight: '1px solid var(--border-color)', height: '100%', position: 'absolute', left: 0, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', fontSize: '10px', fontWeight: 'bold', zIndex: 30, background: 'var(--bg-elevated)' }}>
                    <div>{track.type === 'video' ? '🎬 VID' : '🔊 AUD'}</div>
                    <button onClick={(e) => { e.stopPropagation(); handleImportMedia(track.id as 'video-1' | 'audio-1'); }} style={{ fontSize: '8px', padding: '2px 6px', background: 'var(--accent)', color: '#000', borderRadius: '4px' }}>+ Add</button>
                  </div>

                  {/* Empty Video Track UX */}
                  {track.type === 'video' && track.clips.length === 0 && (
                    <div onClick={(e) => { e.stopPropagation(); handleImportMedia('video-1'); }} style={{ position: 'absolute', left: TRACK_LABEL_WIDTH + 20, right: 20, top: 10, bottom: 10, border: '1px dashed var(--border-color)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer' }} onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'} onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}>
                      + Add Video / Drag file here
                    </div>
                  )}

                  {/* Empty Audio Track UX */}
                  {track.type === 'audio' && track.clips.length === 0 && (
                    <div onClick={(e) => { e.stopPropagation(); handleImportMedia('audio-1'); }} style={{ position: 'absolute', left: TRACK_LABEL_WIDTH + 20, right: 20, top: 10, bottom: 10, border: '1px dashed var(--border-color)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer' }} onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'} onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}>
                      + Add Audio / Drag file here
                    </div>
                  )}

                  {track.clips.map(clip => renderClip(clip, track))}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    </Group>
  );
};

export default App;
