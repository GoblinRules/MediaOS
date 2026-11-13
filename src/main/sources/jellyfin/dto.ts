/** The parts of Jellyfin 10.9+ responses used by MediaOS. Unrequested fields remain on the server. */
export interface MediaStream {
  Index: number; Type: string; Codec?: string; Language?: string; DisplayTitle?: string; Title?: string
  Channels?: number; ChannelLayout?: string; IsDefault?: boolean; IsForced?: boolean; IsExternal?: boolean
  IsTextSubtitleStream?: boolean; DeliveryUrl?: string; Width?: number; Height?: number; VideoRange?: string
  VideoRangeType?: string
}
export interface MediaSourceDto {
  Id: string; MediaStreams?: MediaStream[]; TranscodingUrl?: string
  DefaultAudioStreamIndex?: number; DefaultSubtitleStreamIndex?: number
}
export interface ItemDto {
  Id: string; Name: string; Type: string; CollectionType?: string | null; ChildCount?: number
  RunTimeTicks?: number; ProductionYear?: number; Overview?: string; IndexNumber?: number; ParentIndexNumber?: number
  SeriesId?: string; SeriesName?: string; SeasonId?: string; ParentId?: string; OfficialRating?: string
  CommunityRating?: number; Genres?: string[]; ProviderIds?: Record<string, string>; DateCreated?: string; PremiereDate?: string
  ImageTags?: Record<string, string>; BackdropImageTags?: string[]; ParentBackdropItemId?: string
  ParentBackdropImageTags?: string[]; SeriesPrimaryImageTag?: string; ParentPrimaryImageTag?: string; ParentPrimaryImageItemId?: string
  ParentThumbItemId?: string; ParentThumbImageTag?: string; SeriesThumbImageTag?: string
  ParentLogoItemId?: string; ParentLogoImageTag?: string; SeriesLogoImageTag?: string
  UserData?: { PlaybackPositionTicks?: number; PlayedPercentage?: number; Played?: boolean; IsFavorite?: boolean
    UnplayedItemCount?: number; LastPlayedDate?: string }
  MediaSources?: MediaSourceDto[]; People?: { Name: string; Type?: string; Role?: string }[]
  Taglines?: string[]; Studios?: { Name: string }[]
}
export interface ItemsDto { Items?: ItemDto[]; TotalRecordCount?: number }
export interface PlaybackInfoDto { PlaySessionId?: string; MediaSources?: MediaSourceDto[] }
