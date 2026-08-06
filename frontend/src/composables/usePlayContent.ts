import { usePlayerStore } from "@/stores/player";
import api from "@/api";

function sub(albumRes: any): any[] {
  return albumRes?.data?.["subsonic-response"]?.album?.song || [];
}

export function usePlayContent() {
  const player = usePlayerStore();
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
    if (songs.length) player.playQueue(songs, 0);
    return songs.length;
  }
  async function playAlbum(id: string) {
    const songs = await fetchAlbumSongs(id);
    if (songs.length) player.playQueue(songs, 0);
    return songs.length;
  }
  async function playArtist(id: string) {
    const songs = await fetchArtistSongs(id);
    if (songs.length) player.playQueue(songs, 0);
    return songs.length;
  }

  return { fetchPlaylistSongs, fetchAlbumSongs, fetchArtistSongs, playPlaylist, playAlbum, playArtist };
}
