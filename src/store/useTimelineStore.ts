import { create } from 'zustand';

export interface Clip {
  id: string;
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  playbackSpeed: number;
  volume: number;
  priority: number;
  linkedGroupId?: string;
  clipType?: 'linked' | 'independent';
  waveformPath?: string;
  name?: string;
}

export interface Track {
  id: string;
  type: 'video' | 'audio';
  clips: Clip[];
}

export interface ProjectState {
  tracks: Track[];
  frameStrips: Record<string, string[]>;
  clipboard: { trackId: string; clip: Clip } | null;
  zoomLevel: number;
  selectedClipId: string | null;
  past: Track[][];
  future: Track[][];
  isRippleEnabled: boolean;
  
  setRippleEnabled: (enabled: boolean) => void;
  setZoomLevel: (zoom: number) => void;
  setSelectedClipId: (id: string | null) => void;
  insertClipAtTime: (targetTrackId: string, assetId: string, duration: number, timelineStart: number, hasAudio?: boolean, forceNewTrack?: boolean) => void;
  setFrameStrip: (assetId: string, paths: string[]) => void;
  splitAtPlayhead: (currentTime: number, trackId?: string) => void;
  trimClipStart: (trackId: string, clipId: string, newSourceStart: number) => void;
  trimClipEnd: (trackId: string, clipId: string, newSourceEnd: number) => void;
  setClipSpeed: (trackId: string, clipId: string, speed: number) => void;
  setClipVolume: (trackId: string, clipId: string, volume: number) => void;
  setClipPriority: (trackId: string, clipId: string, priority: number) => void;
  setClipName: (trackId: string, clipId: string, name: string) => void;
  setClipWaveform: (clipId: string, path: string) => void;
  setLinkedGroupId: (trackId: string, clipId: string, groupId: string | null) => void;
  removeClip: (trackId: string, clipId: string) => void;
  moveClip: (trackId: string, clipId: string, newTimelineStart: number) => void;
  undo: () => void;
  redo: () => void;
  copyClip: (trackId: string, clipId: string) => void;
  pasteClip: (trackId: string, timelineStart: number) => void;
  duplicateClip: (trackId: string, clipId: string) => void;
  commitMove: () => void;
}

let clipCounter = Date.now();
export const nextClipId = () => `clip-${++clipCounter}`;
export const nextLinkedGroupId = () => `lg-${++clipCounter}`;

const getEffectiveDuration = (c: Clip) => (c.sourceEnd - c.sourceStart) / c.playbackSpeed;

const pushHistory = (state: ProjectState, newTracks: Track[]): Partial<ProjectState> => {
  const newPast = [...state.past, state.tracks].slice(-50);
  return { tracks: newTracks, past: newPast, future: [] };
};

// Helper and neighbor logic for collision detection
const getClipNeighbors = (track: Track, clipId: string) => {
   const otherClips = track.clips.filter(c => c.id !== clipId).sort((a,b) => a.timelineStart - b.timelineStart);
   const currentClip = track.clips.find(c => c.id === clipId);
   if (!currentClip) return { prev: null, next: null };

   let prev = null;
   let next = null;

   for (let i = 0; i < otherClips.length; i++) {
       if (otherClips[i].timelineStart < currentClip.timelineStart) {
           prev = otherClips[i];
       } else if (otherClips[i].timelineStart > currentClip.timelineStart) {
           next = otherClips[i];
           break;
       }
   }
   return { prev, next };
};

const fitsInTrack = (track: Track, start: number, duration: number, ignoreClipIds?: string | string[]) => {
   const ignoreArray = Array.isArray(ignoreClipIds) ? ignoreClipIds : (ignoreClipIds ? [ignoreClipIds] : []);
   return !track.clips.some(c => {
       if (ignoreArray.includes(c.id)) return false;
       const end = c.timelineStart + getEffectiveDuration(c);
       return (start < end - 0.001) && (start + duration > c.timelineStart + 0.001);
   });
};

const findAvailableGap = (track: Track, duration: number, start: number, ignoreClipIds?: string | string[]) => {
   const ignoreArray = Array.isArray(ignoreClipIds) ? ignoreClipIds : (ignoreClipIds ? [ignoreClipIds] : []);
   if (fitsInTrack(track, start, duration, ignoreClipIds)) return start;
   
   // Try snapping to end of current clips
   const sortedClips = track.clips.filter(c => !ignoreArray.includes(c.id)).sort((a,b) => a.timelineStart - b.timelineStart);
   for (let i = 0; i < sortedClips.length; i++) {
       const potentialStart = sortedClips[i].timelineStart + getEffectiveDuration(sortedClips[i]);
       if (potentialStart >= start && fitsInTrack(track, potentialStart, duration, ignoreClipIds)) {
           return potentialStart;
       }
   }

   // Or try previous gaps if we moved backwards
   for (let i = sortedClips.length - 1; i >= 0; i--) {
       const potentialStart = sortedClips[i].timelineStart - duration;
       if (potentialStart >= 0 && potentialStart <= start && fitsInTrack(track, potentialStart, duration, ignoreClipIds)) {
           return potentialStart;
       }
   }
   
   // Otherwise, at the very end
   if (sortedClips.length === 0) return 0;
   const lastClip = sortedClips[sortedClips.length - 1];
   return lastClip.timelineStart + getEffectiveDuration(lastClip);
};

const getTargetAudioTracks = (tracks: Track[], timelineStart: number, duration: number, forceNewTrack = false): Track[] => {
   let newTracks = [...tracks];
   let targetAudioTrackId: string | null = null;
   
   if (!forceNewTrack) {
       for (let t of newTracks) {
           if (t.type === 'audio' && fitsInTrack(t, timelineStart, duration)) {
               targetAudioTrackId = t.id;
               break;
           }
       }
   }

   if (!targetAudioTrackId) {
       const audioTracksCount = newTracks.filter(t => t.type === 'audio').length;
       const newAudioTrack: Track = { id: `audio-${audioTracksCount + 1}`, type: 'audio', clips: [] };
       newTracks.push(newAudioTrack);
   }
   
   return newTracks;
};

export const useTimelineStore = create<ProjectState>((set) => ({
  tracks: [
     { id: 'video-1', type: 'video', clips: [] },
     { id: 'audio-1', type: 'audio', clips: [] }
  ],
  frameStrips: {},
  clipboard: null,
  zoomLevel: 8,
  selectedClipId: null,
  past: [],
  future: [],
  isRippleEnabled: true,

  setRippleEnabled: (enabled) => set({ isRippleEnabled: enabled }),
  setZoomLevel: (zoom) => set({ zoomLevel: zoom }),
  setSelectedClipId: (id) => set({ selectedClipId: id }),

  undo: () => set((state) => {
    if (state.past.length === 0) return {};
    const previous = state.past[state.past.length - 1];
    return {
      tracks: previous,
      past: state.past.slice(0, -1),
      future: [state.tracks, ...state.future]
    };
  }),

  redo: () => set((state) => {
    if (state.future.length === 0) return {};
    const next = state.future[0];
    return {
      tracks: next,
      past: [...state.past, state.tracks],
      future: state.future.slice(1)
    };
  }),

  copyClip: (trackId, clipId) => set((state) => {
    const track = state.tracks.find(t => t.id === trackId);
    if (!track) return {};
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return {};
    return { clipboard: { trackId, clip: { ...clip } } };
  }),

  pasteClip: (trackId, timelineStart) => set((state) => {
    if (!state.clipboard) return {};
    const dur = getEffectiveDuration(state.clipboard.clip);
    let currentTracks = state.tracks;
    let finalStart = timelineStart;

    const targetTrack = currentTracks.find(t => t.id === trackId);
    if (targetTrack) {
        finalStart = findAvailableGap(targetTrack, dur, timelineStart);
    }

    const newClip: Clip = { ...state.clipboard.clip, id: nextClipId(), timelineStart: finalStart, linkedGroupId: undefined, clipType: 'independent' };
    
    if (newClip.assetId.includes('audio') || trackId.includes('audio')) {
         currentTracks = getTargetAudioTracks(currentTracks, finalStart, dur);
         const audioTrack = currentTracks.find(t => t.type === 'audio' && fitsInTrack(t, finalStart, dur));
         if (audioTrack) {
            currentTracks = currentTracks.map(t => t.id === audioTrack.id ? { ...t, clips: [...t.clips, newClip] } : t);
         }
    } else {
         currentTracks = currentTracks.map(track => track.id === trackId ? { ...track, clips: [...track.clips, newClip] } : track);
    }
    return pushHistory(state, currentTracks);
  }),

  duplicateClip: (trackId, clipId) => set((state) => {
     const track = state.tracks.find(t => t.id === trackId);
     if (!track) return {};
     const clip = track.clips.find(c => c.id === clipId);
     if (!clip) return {};
     
     const dur = getEffectiveDuration(clip);
     const requestedStart = clip.timelineStart + dur;
     const finalStart = findAvailableGap(track, dur, requestedStart);

     // Duplicates are structurally unlinked
     const newClip: Clip = { 
        ...clip, 
        id: nextClipId(), 
        timelineStart: finalStart,
        linkedGroupId: undefined,
        clipType: 'independent'
     };

     let currentTracks = state.tracks;
     if (track.type === 'audio') {
         currentTracks = getTargetAudioTracks(currentTracks, finalStart, dur);
         const audioTrack = currentTracks.find(t => t.type === 'audio' && fitsInTrack(t, finalStart, dur));
         if (audioTrack) {
             currentTracks = currentTracks.map(t => t.id === audioTrack.id ? { ...t, clips: [...t.clips, newClip] } : t);
         }
     } else {
         currentTracks = currentTracks.map(t => t.id !== trackId ? t : { ...t, clips: [...t.clips, newClip] });
     }

     return pushHistory(state, currentTracks);
  }),

  insertClipAtTime: (targetTrackId, assetId, duration, timelineStart, hasAudio, forceNewTrack) =>
    set((state) => {
      let currentTracks = [...state.tracks];
      const isDynamicAudioAllocation = targetTrackId.startsWith('audio');
      
      const targetTrack = currentTracks.find(t => t.id === targetTrackId);
      let finalVideoStart = timelineStart;
      if (targetTrack && targetTrackId.startsWith('video')) {
          finalVideoStart = findAvailableGap(targetTrack, duration, timelineStart);
      }

      if (targetTrackId.startsWith('video')) {
          const videoClip: Clip = { 
             id: nextClipId(), assetId, sourceStart: 0, sourceEnd: duration, timelineStart: finalVideoStart, playbackSpeed: 1.0, 
             volume: 100, priority: 50,
             clipType: 'independent'
          };
          currentTracks = currentTracks.map(t => t.id === targetTrackId ? { ...t, clips: [...t.clips, videoClip] } : t);

          if (hasAudio) {
              const requestedAudioStart = finalVideoStart;
              currentTracks = getTargetAudioTracks(currentTracks, requestedAudioStart, duration, false);
              const audioTrack = currentTracks.find(t => t.type === 'audio' && fitsInTrack(t, requestedAudioStart, duration));
              
              if (audioTrack) {
                  const finalAudioStart = findAvailableGap(audioTrack, duration, requestedAudioStart);
                  const audioClip: Clip = { 
                     id: nextClipId(), assetId, sourceStart: 0, sourceEnd: duration, timelineStart: finalAudioStart, playbackSpeed: 1.0, 
                     volume: 100, priority: 50,
                     clipType: 'independent'
                  };
                  currentTracks = currentTracks.map(t => t.id === audioTrack.id ? { ...t, clips: [...t.clips, audioClip] } : t);
              }
          }
      } else if (isDynamicAudioAllocation) {
          // Independent audio (MP3/WAV file) — no linking needed
          const requestedAudioStart = forceNewTrack ? 0 : finalVideoStart;
          const p = 50; 
          
          currentTracks = getTargetAudioTracks(currentTracks, requestedAudioStart, duration, !!forceNewTrack);
          const audioTrack = currentTracks.find(t => t.type === 'audio' && (forceNewTrack ? t.id === `audio-${currentTracks.filter(x=>x.type==='audio').length}` : fitsInTrack(t, requestedAudioStart, duration)));
          
          if (audioTrack) {
              const finalAudioStart = findAvailableGap(audioTrack, duration, requestedAudioStart);
              const audioClip: Clip = { 
                 id: nextClipId(), assetId, sourceStart: 0, sourceEnd: duration, timelineStart: finalAudioStart, playbackSpeed: 1.0, 
                 volume: 100, priority: p,
                 clipType: 'independent' 
              };
              currentTracks = currentTracks.map(t => t.id === audioTrack.id ? { ...t, clips: [...t.clips, audioClip] } : t);
          }
      }

      return pushHistory(state, currentTracks);
    }),

  setFrameStrip: (assetId, paths) => set((state) => ({ frameStrips: { ...state.frameStrips, [assetId]: paths } })),

  splitAtPlayhead: (currentTime, trackId) =>
    set((state) => {
      let madeModification = false;
      const newTracks = state.tracks.map(track => {
        // If trackId is provided, ONLY split that track. Otherwise split all.
        if (trackId && track.id !== trackId) return track;
        
        const clipIdx = track.clips.findIndex(c => currentTime > c.timelineStart + 0.05 && currentTime < c.timelineStart + getEffectiveDuration(c) - 0.05);
        if (clipIdx === -1) return track;

        madeModification = true;
        const clip = track.clips[clipIdx];
        const splitSourceTime = clip.sourceStart + ((currentTime - clip.timelineStart) * clip.playbackSpeed);

        const leftClip: Clip = { ...clip, id: clip.id, sourceEnd: splitSourceTime };
        // right clip retains linkedGroupId! So subsequent operations remain synced
        const rightClip: Clip = { ...clip, id: nextClipId(), sourceStart: splitSourceTime, timelineStart: currentTime };

        const newClips = [...track.clips];
        newClips.splice(clipIdx, 1, leftClip, rightClip);
        return { ...track, clips: newClips };
      });

      if (!madeModification) return {};
      return pushHistory(state, newTracks);
    }),

  trimClipStart: (_trackId, clipId, newSourceStart) =>
    set((state) => {
      const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      const track = state.tracks.find(t => t.clips.some(c => c.id === clipId));
      if (!targetClip || !track) return {};

      const { prev } = getClipNeighbors(track, clipId);
      const minTimelineStart = prev ? prev.timelineStart + getEffectiveDuration(prev) : 0;

      const newTracks = state.tracks.map(t => {
        if (t.id !== track.id) return t;
        const newClips = t.clips.map(clip => {
          if (clip.id === clipId) {
             if (newSourceStart < 0 || newSourceStart >= clip.sourceEnd) return clip;
             const trimDeltaTimeline = (newSourceStart - clip.sourceStart) / clip.playbackSpeed;
             let requestedStart = clip.timelineStart + trimDeltaTimeline;
             
             // Clamp trim start so we don't eat into the previous clip
             if (requestedStart < minTimelineStart) {
                 return clip; 
             }

             return { ...clip, sourceStart: newSourceStart, timelineStart: requestedStart };
          }
          return clip;
        });
        return { ...t, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  trimClipEnd: (_trackId, clipId, newSourceEnd) =>
    set((state) => {
      const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      const track = state.tracks.find(t => t.clips.some(c => c.id === clipId));
      if (!targetClip || !track) return {};

      if (newSourceEnd <= targetClip.sourceStart) return {};
      const oldDur = getEffectiveDuration(targetClip);
      const newDur = (newSourceEnd - targetClip.sourceStart) / targetClip.playbackSpeed;
      const delta = newDur - oldDur;

      const newTracks = state.tracks.map(t => {
        if (t.id !== track.id) return t; // Only ripple the active track
        const newClips = t.clips.map(clip => {
          if (clip.id === clipId) {
             return { ...clip, sourceEnd: newSourceEnd };
          }
          // Shift all subsequent clips right/left by the delta
          if (clip.timelineStart >= targetClip.timelineStart + oldDur - 0.001) {
             return { ...clip, timelineStart: Math.max(0, clip.timelineStart + delta) };
          }
          return clip;
        });
        return { ...t, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  setClipSpeed: (_trackId, clipId, speed) =>
    set((state) => {
      const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      const track = state.tracks.find(t => t.clips.some(c => c.id === clipId));
      if (!targetClip || !track) return {};

      const oldDur = getEffectiveDuration(targetClip);
      const newSpeed = Math.max(0.1, speed);
      const newDur = (targetClip.sourceEnd - targetClip.sourceStart) / newSpeed;
      const delta = newDur - oldDur;

      const newTracks = state.tracks.map(t => {
        if (t.id !== track.id) return t; // Only ripple the active track
        const newClips = t.clips.map(clip => {
           if (clip.id === clipId) {
               return { ...clip, playbackSpeed: newSpeed };
           }
           // Shift all subsequent clips right/left by the delta
           if (clip.timelineStart >= targetClip.timelineStart + oldDur - 0.001) {
               return { ...clip, timelineStart: Math.max(0, clip.timelineStart + delta) };
           }
           return clip;
        });
        return { ...t, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  setClipVolume: (_trackId, clipId, volume) =>
    set((state) => {
      const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      if (!targetClip) return {};

      const newTracks = state.tracks.map(track => {
        const newClips = track.clips.map(clip => {
           if (clip.id === clipId) {
               return { ...clip, volume: Math.max(0, Math.min(400, volume)) };
           }
           return clip;
        });
        return { ...track, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  setClipPriority: (_trackId, clipId, priority) =>
    set((state) => {
      const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      if (!targetClip) return {};

      const newTracks = state.tracks.map(track => {
        const newClips = track.clips.map(clip => {
           if (clip.id === clipId) {
               return { ...clip, priority: Math.max(0, Math.min(100, priority)) };
           }
           return clip;
        });
        return { ...track, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  setClipName: (_trackId, clipId, name) =>
    set((state) => {
      const newTracks = state.tracks.map(track => {
        const newClips = track.clips.map(clip => {
           if (clip.id === clipId) return { ...clip, name };
           return clip;
        });
        return { ...track, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  setClipWaveform: (clipId, path) =>
    set((state) => {
      const newTracks = state.tracks.map(track => {
        const newClips = track.clips.map(clip => {
           if (clip.id === clipId) return { ...clip, waveformPath: path };
           return clip;
        });
        return { ...track, clips: newClips };
      });
      // We don't push to history for purely cosmetic visual metadata updates
      return { tracks: newTracks };
    }),

  setLinkedGroupId: (_trackId, clipId, groupId) =>
    set((state) => {
      const newTracks = state.tracks.map(track => {
        const newClips = track.clips.map(clip => {
           if (clip.id === clipId) return { ...clip, linkedGroupId: groupId || undefined };
           return clip;
        });
        return { ...track, clips: newClips };
      });
      return pushHistory(state, newTracks);
    }),

  removeClip: (_trackId, clipId) =>
    set((state) => {
      const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      if (!targetClip) return {};

      // 1. Identify all clips to remove (Linked Deletion)
      const clipsToRemoveIds = new Set<string>();
      clipsToRemoveIds.add(clipId);
      if (targetClip.linkedGroupId) {
        state.tracks.flatMap(t => t.clips)
          .filter(c => c.linkedGroupId === targetClip.linkedGroupId)
          .forEach(c => clipsToRemoveIds.add(c.id));
      }

      // 2. Remove clips and apply Ripple per track
      const newTracks = state.tracks.map(track => {
        const deletedInThisTrack = track.clips.filter(c => clipsToRemoveIds.has(c.id));
        if (deletedInThisTrack.length === 0) return track;

        // For simplicity in ripple, we handle the primary removal or group removal
        // Note: If multiple clips are deleted on one track (unlikely in basic A/V sync), 
        // we take the earliest start and total duration.
        const earliestStart = Math.min(...deletedInThisTrack.map(c => c.timelineStart));
        const totalDeletedDuration = deletedInThisTrack.reduce((acc, c) => acc + getEffectiveDuration(c), 0);

        let newClips = track.clips.filter(c => !clipsToRemoveIds.has(c.id));

        if (state.isRippleEnabled) {
          newClips = newClips.map(clip => {
            if (clip.timelineStart > earliestStart) {
              return { ...clip, timelineStart: Math.max(0, clip.timelineStart - totalDeletedDuration) };
            }
            return clip;
          });
        }

        return { ...track, clips: newClips };
      });
      
      const stillSelected = state.selectedClipId && !clipsToRemoveIds.has(state.selectedClipId);

      return {
         ...pushHistory(state, newTracks),
         selectedClipId: stillSelected ? state.selectedClipId : null
      };
    }),

  moveClip: (_trackId, clipId, newTimelineStart) => 
    set((state) => {
       const targetClip = state.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
       if (!targetClip) return {};

       const deltaX = newTimelineStart - targetClip.timelineStart;
       
       // 1. Identify all clips in the group
       const linkedClips = targetClip.linkedGroupId 
        ? state.tracks.flatMap(t => t.clips.map(c => ({ clip: c, track: t }))).filter(obj => obj.clip.linkedGroupId === targetClip.linkedGroupId)
        : [{ clip: targetClip, track: state.tracks.find(t => t.clips.some(c => c.id === clipId))! }];

       const groupClipIds = linkedClips.map(obj => obj.clip.id);

       // 2. Validate move for EVERY clip in the pack (Group Collision)
       let isBlocked = false;
       for (const { clip, track } of linkedClips) {
           const dur = getEffectiveDuration(clip);
           const requestedStart = clip.timelineStart + deltaX;
           
           // If any clip in the pack hits a boundary or starts < 0, block the whole pack
           if (requestedStart < 0 || !fitsInTrack(track, requestedStart, dur, groupClipIds)) {
               isBlocked = true;
               break;
           }
       }

       if (isBlocked) return {};

       // 3. Apply moves to all tracks
       const newTracks = state.tracks.map(t => {
          const newClips = t.clips.map(c => {
             const isInGroup = linkedClips.some(lc => lc.clip.id === c.id);
             if (isInGroup) {
                 return { ...c, timelineStart: c.timelineStart + deltaX };
             }
             return c;
          });
          return { ...t, clips: newClips };
       });

       return { tracks: newTracks };
    }),

  commitMove: () => set((state) => pushHistory(state, state.tracks))
}));
