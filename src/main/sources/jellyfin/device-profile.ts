export function deviceProfile() {
  return {
    Name: 'MediaOS mpv', MaxStreamingBitrate: 120_000_000,
    DirectPlayProfiles: [{ Type: 'Video' }],
    TranscodingProfiles: [{ Type: 'Video', Container: 'ts', Protocol: 'hls', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3' }],
    SubtitleProfiles: [
      ...['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'ttml', 'mov_text', 'text'].map((Format) => ({ Format, Method: 'External' })),
      ...['pgs', 'pgssub', 'dvdsub', 'vobsub', 'dvbsub'].map((Format) => ({ Format, Method: 'Embed' })),
    ],
  }
}
