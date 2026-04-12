# OverAI Video Editor 🎬

A modern, high-performance, intelligent desktop video editing suite built with **Tauri**, **React**, **TypeScript**, and **Rust**. Powered under the hood by **FFmpeg** for professional-grade media parsing and processing.

## 🌟 Key Features

### Intelligent Magnetic Timeline
- **Native OS Drag & Drop:** Seamlessly drag entire batches of videos, audio, or images directly from your computer into the timeline.
- **Ripple Editing:** Advanced clip collision logic ensuring that altering speeds or trimming clips shifts subsequent media dynamically to prevent overlaps.
- **Magnetic Snapping Guides:** A global engine that analyzes every single track simultaneously. When your mouse aligns a dragging clip with another clip's boundaries anywhere on the timeline, an illuminated red snap guide locks you precisely into place.
- **Flexible Playhead Integration:** Click or scrub anywhere on the interactive time-ruler. The playhead perfectly tracks floating point physics across native DOM render ticks.

### Connected Clip Management
- **Group Linking & Absorption:** Link multiple video and audio clips across multiple tracks. Need to add one more to the set later? Select it alongside any existing group member, and the editor elegantly merges them into a singular connected block!
- **Granular Group Controls:** Instantly dissolve an entire group with **"Unlink All"** or selectively pop off a single clip while preserving the rest of the herd with **"Unlink"**. 
- **Ghost-Drag Visualization:** An intelligent rendering loop that renders a transparent "ghost" outline for *every single item* in your linked group when moving it, guaranteeing you explicitly see exactly what boundary is blocking your path if you hit a wall.

### Next-Gen Audio Engine
- **Web Audio API Multi-Track Mixing:** Real-time processing for dynamic volume control, fading, and synchronization across discrete audio environments.
- **Smart Audio Ducking:** Advanced priority-layered routing guarantees background music gracefully softens when a primary clip begins dictating playback.
- **Background Waveform Extraction:** Uses Rust-bound asynchronous threads to natively build audio amplitude arrays into rich canvas waveforms for high spatial awareness.

### Dynamic Rendering & Extraction
- **Frame Strips:** Real-time asynchronous asset thumbnailing generating contiguous frame strips per-clip across tracks. 
- **Unified Preview Engine:** Intelligently switches rendering targets dynamically between HTML5 Video surfaces to standard Canvas images if static media commands priority.

## 🛠 Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Vanilla CSS (Custom Design System, Dark Mode)
- **State Management:** Zustand (Immutable History, Undo/Redo Engine)
- **Desktop Container:** Tauri V2
- **Systems Core:** Rust
- **Media Transcoding:** FFmpeg

## 🚀 Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and an installation of [FFmpeg](https://ffmpeg.org/) mapped to your system `PATH`.

### Installation

1. Install Frontend Dependencies:
```bash
npm install
```

2. Start the Desktop App (Development Mode):
```bash
npm run tauri dev
```

3. Build for Production:
```bash
npm run tauri build
```

## ⌨️ Shortcuts

- <kbd>Space</kbd>: Play / Pause playback
- <kbd>S</kbd>: Split selected clip at playhead
- <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>: Undo / Redo edit modifications
- <kbd>Ctrl+C</kbd> / <kbd>Ctrl+V</kbd>: Copy / Paste selection at playhead

## 🎨 Design Philosophy
The entire user interface operates on sleek, minimal, hardware-accelerated CSS animations. Highlights include subtle frosted-glass interactive toolbars, intelligent cross-track guides, non-invasive dark scrollbars, and neon glow effects for highlighted clip elements that provide clear visual clarity during complex multi-track sequencing.

---

*Engineered for real-time creative flow.*
