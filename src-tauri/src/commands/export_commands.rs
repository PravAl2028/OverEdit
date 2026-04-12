use std::collections::HashMap;
use serde::Deserialize;
use tauri::{command, AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use std::process::Stdio;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    pub file_path: String,
    pub source_start: f64,
    pub source_end: f64,
    pub timeline_start: f64,
    pub playback_speed: f64,
    pub volume: Option<f64>,
    pub priority: Option<f64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportTrack {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: String, // "video" or "audio"
    pub clips: Vec<ExportClip>,
}

pub fn get_atempo_filter(mut speed: f64) -> String {
    let mut filters = Vec::new();
    while speed > 2.0 {
        filters.push("atempo=2.0".to_string());
        speed /= 2.0;
    }
    while speed < 0.5 {
        filters.push("atempo=0.5".to_string());
        speed /= 0.5;
    }
    if speed != 1.0 {
        filters.push(format!("atempo={:.2}", speed));
    }
    if filters.is_empty() {
        "atempo=1.0".to_string()
    } else {
        filters.join(",")
    }
}

#[command(rename_all = "snake_case")]
pub async fn export_timeline(
    app: AppHandle,
    project_json: String,
    output_path: String,
) -> Result<String, String> {
    let mut tracks: Vec<ExportTrack> = serde_json::from_str(&project_json)
        .map_err(|e| format!("Failed to parse project data: {}", e))?;

    let mut unique_files = HashMap::new();
    let mut file_inputs = Vec::new();

    // Sort clips and extract unique files
    for track in &mut tracks {
        track.clips.sort_by(|a, b| a.timeline_start.partial_cmp(&b.timeline_start).unwrap());
        for clip in &track.clips {
            if !unique_files.contains_key(&clip.file_path) {
                unique_files.insert(clip.file_path.clone(), file_inputs.len());
                file_inputs.push(clip.file_path.clone());
            }
        }
    }

    let mut filter_complex = String::new();
    let mut video_segments = Vec::new();
    let mut audio_concat_outputs = Vec::new(); // stores [outa_1], [outa_2], etc.

    let mut out_idx = 0;
    let gap_color = "color=c=black:s=1280x720:r=30";
    let gap_audio = "anullsrc=r=48000:cl=stereo";

    // Build video track concat
    if let Some(v_track) = tracks.iter().find(|t| t.track_type == "video") {
        let mut current_time = 0.0;
        for clip in &v_track.clips {
            if clip.timeline_start > current_time + 0.01 {
                let gap_dur = clip.timeline_start - current_time;
                let gap_lbl = format!("[v_gap{}]", out_idx);
                filter_complex.push_str(&format!("{}:d={:.3} {};\n", gap_color, gap_dur, gap_lbl));
                video_segments.push(gap_lbl);
                out_idx += 1;
            }

            let file_idx = unique_files.get(&clip.file_path).unwrap();
            let effective_dur = (clip.source_end - clip.source_start) / clip.playback_speed;
            let v_lbl = format!("[v_clip{}]", out_idx);
            filter_complex.push_str(&format!(
                "[{}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,setpts=PTS/{:.3} {};\n",
                file_idx, clip.source_start, clip.source_end, clip.playback_speed, v_lbl
            ));
            video_segments.push(v_lbl);
            out_idx += 1;
            current_time = clip.timeline_start + effective_dur;
        }
    }

    // Collect all audio clips across all tracks for priority analysis
    let all_audio_clips: Vec<_> = tracks.iter()
        .filter(|t| t.track_type == "audio")
        .flat_map(|t| t.clips.iter().map(move |c| (t.id.clone(), c)))
        .collect();

    let audio_tracks: Vec<_> = tracks.iter().filter(|t| t.track_type == "audio").collect();
    let mut t_idx = 0;
    
    for a_track in audio_tracks {
        let mut audio_segments = Vec::new();
        let mut current_time = 0.0;
        
        for clip in &a_track.clips {
            if clip.timeline_start > current_time + 0.01 {
                let gap_dur = clip.timeline_start - current_time;
                let gap_lbl = format!("[a_gap{}_{}]", t_idx, out_idx);
                filter_complex.push_str(&format!("{}:d={:.3} {};\n", gap_audio, gap_dur, gap_lbl));
                audio_segments.push(gap_lbl);
                out_idx += 1;
            }

            let file_idx = unique_files.get(&clip.file_path).unwrap();
            let effective_dur = (clip.source_end - clip.source_start) / clip.playback_speed;
            let a_lbl = format!("[a_clip{}_{}]", t_idx, out_idx);
            let atempo = get_atempo_filter(clip.playback_speed);
            
            // --- PRIORITY DUCKING CALCULATION ---
            let base_vol = clip.volume.unwrap_or(100.0) / 100.0;
            let my_priority = clip.priority.unwrap_or(100.0);
            
            // Construct a volume expression: volume='base_vol * if(between(t, S, E), DuckRatio, 1.0)'
            // We search for segments where OTHER tracks have higher priority
            let mut volume_expr = format!("{:.3}", base_vol);
            
            // Find overlaps
            let overlaps: Vec<_> = all_audio_clips.iter()
                .filter(|(tid, other)| {
                    *tid != a_track.id && // Only consider other tracks
                    other.timeline_start < (clip.timeline_start + effective_dur) &&
                    (other.timeline_start + (other.source_end - other.source_start) / other.playback_speed) > clip.timeline_start
                })
                .collect();

            // DEBUG DUCK
            let mut debug_info = format!("Clip {} (Priority {}) Overlaps: ", a_lbl, my_priority);
            for (tid, o) in &overlaps {
                debug_info.push_str(&format!("{} (Pri {}), ", tid, o.priority.unwrap_or(100.0)));
            }
            println!("{}", debug_info);

            if !overlaps.is_empty() {
                // To keep it clean and performant, we find segments where max_priority changes
                // But for a robust MVP, we'll build a nested IF structure for each significant overlap
                for (_, other) in overlaps {
                    let other_dur = (other.source_end - other.source_start) / other.playback_speed;
                    let other_end = other.timeline_start + other_dur;
                    let other_priority = other.priority.unwrap_or(100.0);
                    
                    if other_priority > my_priority {
                        let duck_ratio = my_priority / other_priority;
                        
                        // Timings relative to this clip's start (since asetpts=PTS-STARTPTS)
                        let start_rel = (other.timeline_start - clip.timeline_start).max(0.0);
                        let end_rel = (other_end - clip.timeline_start).min(effective_dur);
                        
                        if start_rel < end_rel - 0.01 {
                           volume_expr = format!("if(between(t,{:.3},{:.3}),{}*{:.3},{})", start_rel, end_rel, volume_expr, duck_ratio, volume_expr);
                        }
                    } else if other_priority == my_priority {
                        // Parity ducking (0.9x)
                        let start_rel = (other.timeline_start - clip.timeline_start).max(0.0);
                        let end_rel = (other_end - clip.timeline_start).min(effective_dur);
                        if start_rel < end_rel - 0.01 {
                           volume_expr = format!("if(between(t,{:.3},{:.3}),{}*0.9,{})", start_rel, end_rel, volume_expr, volume_expr);
                        }
                    }
                }
            }

            filter_complex.push_str(&format!(
                "[{}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,{},volume='{}':eval=frame {};\n",
                file_idx, clip.source_start, clip.source_end, atempo, volume_expr, a_lbl
            ));
            
            audio_segments.push(a_lbl);
            out_idx += 1;
            current_time = clip.timeline_start + effective_dur;
        }
        
        if !audio_segments.is_empty() {
            let concat_input = audio_segments.join("");
            let out_lbl = format!("[outa_{}]", t_idx);
            filter_complex.push_str(&format!("{}concat=n={}:v=0:a=1 {};\n", concat_input, audio_segments.len(), out_lbl));
            audio_concat_outputs.push(out_lbl);
        }
        t_idx += 1;
    }

    // Concat video segments if they exist
    if !video_segments.is_empty() {
        let concat_input = video_segments.join("");
        filter_complex.push_str(&format!("{}concat=n={}:v=1:a=0 [outv];\n", concat_input, video_segments.len()));
    }

    // Final Mixdown of Audio Tracks
    if !audio_concat_outputs.is_empty() {
        let amix_inputs = audio_concat_outputs.join("");
        filter_complex.push_str(&format!("{}amix=inputs={}:duration=longest:normalize=0 [outa];\n", amix_inputs, audio_concat_outputs.len()));
    } else {
        filter_complex.push_str("anullsrc=r=48000:cl=stereo[outa];\n");
    }

    // Prepare FFmpeg args
    let mut args = vec!["-y".to_string()];
    for file in &file_inputs {
        args.push("-i".to_string());
        args.push(file.to_string());
    }

    if !filter_complex.is_empty() {
        args.push("-filter_complex".to_string());
        args.push(filter_complex);
        
        if !video_segments.is_empty() {
            args.push("-map".to_string());
            args.push("[outv]".to_string());
        }
        if !audio_concat_outputs.is_empty() {
            args.push("-map".to_string());
            args.push("[outa]".to_string());
        }
    } else {
        return Err("Timeline is empty".to_string());
    }

    args.push("-c:v".to_string());
    args.push("libx264".to_string());
    args.push("-preset".to_string());
    args.push("ultrafast".to_string()); // fast export for dev
    args.push("-y".to_string());
    args.push(output_path.clone());

    println!("Starting FFmpeg Export: ffmpeg {}", args.join(" "));

    let mut child = tokio::process::Command::new("ffmpeg")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped()) // ffmpeg writes progress to stderr
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let mut reader = BufReader::new(stderr).lines();

    // Try to guess total duration (max timeline end)
    let total_dur = tracks.iter().flat_map(|t| t.clips.iter()).fold(0.0f64, |acc, c| {
        let dur = c.timeline_start + (c.source_end - c.source_start) / c.playback_speed;
        acc.max(dur)
    });

    // Parse FFmpeg stderr for time=00:00:12.34
    while let Ok(Some(line)) = reader.next_line().await {
        // e.g. frame=  123 fps=0.0 q=28.0 size=     512kB time=00:00:04.12 bitrate=...
        if let Some(time_idx) = line.find("time=") {
            let time_str = &line[time_idx + 5..];
            if let Some(space_idx) = time_str.find(' ') {
                let time_val = &time_str[..space_idx]; // 00:00:04.12
                let parts: Vec<&str> = time_val.split(':').collect();
                if parts.len() == 3 {
                    if let (Ok(h), Ok(m), Ok(s)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>(), parts[2].parse::<f64>()) {
                        let sec = (h * 3600.0) + (m * 60.0) + s;
                        let mut progress = sec / total_dur;
                        if progress > 1.0 { progress = 1.0; }
                        
                        // Emit progress to frontend
                        let _ = app.emit("export-progress", progress);
                    }
                }
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;

    if status.success() {
        let _ = app.emit("export-progress", 1.0);
        Ok(output_path)
    } else {
        Err("FFmpeg export failed".to_string())
    }
}
