import { usePlayerStore } from "@/stores/player";
import api from "@/api";

function sub(albumRes: any): any[] {
  return albumRes?.data?.["subsonic-response"]?.album?.song || [];
}

/** `/v1/play` 的 type 取值（与后端 services/content.ts 一一对应）。 */
type ContentType = "playlist" | "album" | "artist";

export function usePlayContent() {
  const player = usePlayerStore();

  // 「整份内容一次点播」的统一入口：先声明队列来源，再起播。
  //
  // 为什么要声明：投屏（DLNA/群组）起播有两条通道 ——
  //   主通道 POST /rest/api/v1/play {peerId, type, id, songId}（几百字节）
  //   兜底通道 POST /v1/peers/:id/queue/play {items, startIndex}（整队，MB 级）
  // 声明了来源，startCastPlayback 才能走主通道；不声明就退化成整队推送，
  // 而整队推送在公网入口会被 Lucky WAF 的体积闸门 403 掉（≈300 首即触发）。
  //
  // 本机播放时 contentOrigin 只是被忽略（无副作用），故无需分支。
  function playWholeContent(type: ContentType, id: string, songs: any[]) {
    player.setContentOrigin(type, id);
    player.playQueue(songs, 0);
  }

  async function fetchPlaylistSongs(id: string): Promise<any[]> {
    const songs: any[] = [];
    const pageSize = 100;
    let total = Infinity;
    for (let page = 1; (page - 1) * pageSize < total; page++) {
      const res = await api.get(`/rest/api/v1/playlists/${id}/tracks`, {
        params: { page, pageSize },
      });
      const data = res.data || {};
      total = data.total || 0;
      const items = (data.items || []).filter((s: any) => s.playable);
      if (songs.length + items.length >= total) { songs.push(...items); break; }
      songs.push(...items);
    }
    return songs;
  }

  async function fetchAlbumSongs(id: string): Promise<any[]> {
    const res = await api.get(`/rest/getAlbum?id=${id}&f=json`);
    return sub(res);
  }

  // Artist songs = union of every album's tracks (mirrors Artists/Detail playAllSongs).
  async function fetchArtistSongs(id: string): Promise<any[]> {
    const res = await api.get(`/rest/getArtist?id=${id}&f=json`);
    const albums = res.data?.["subsonic-response"]?.artist?.album || [];
    const all: any[] = [];
    for (const al of albums) {
      const r = await api.get(`/rest/getAlbum?id=${al.id}&f=json`);
      all.push(...sub(r));
    }
    return all;
  }

  async function playPlaylist(id: string) {
    const songs = await fetchPlaylistSongs(id);
    if (songs.length) playWholeContent("playlist", id, songs);
    return songs.length;
  }
  async function playAlbum(id: string) {
    const songs = await fetchAlbumSongs(id);
    if (songs.length) playWholeContent("album", id, songs);
    return songs.length;
  }
  async function playArtist(id: string) {
    const songs = await fetchArtistSongs(id);
    if (songs.length) playWholeContent("artist", id, songs);
    return songs.length;
  }

  return { fetchPlaylistSongs, fetchAlbumSongs, fetchArtistSongs, playPlaylist, playAlbum, playArtist };
}
