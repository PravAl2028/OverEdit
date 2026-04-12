import { create } from 'zustand';

export interface MediaAsset {
  id: string;
  filePath: string;
  thumbnailData: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

interface MediaState {
  assets: MediaAsset[];
  selectedAssetId: string | null;
  addAsset: (asset: MediaAsset) => void;
  removeAsset: (id: string) => void;
  selectAsset: (id: string | null) => void;
}

export const useMediaStore = create<MediaState>((set) => ({
  assets: [],
  selectedAssetId: null,
  addAsset: (asset) => 
    set((state) => ({ 
      assets: [...state.assets.filter(a => a.filePath !== asset.filePath), asset] 
    })),
  removeAsset: (id) => 
    set((state) => ({ 
      assets: state.assets.filter((a) => a.id !== id),
      selectedAssetId: state.selectedAssetId === id ? null : state.selectedAssetId
    })),
  selectAsset: (id) => set({ selectedAssetId: id }),
}));
