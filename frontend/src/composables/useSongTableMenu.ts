import type { Ref } from "vue";
import { useItemActions } from "./useItemActions";

/**
 * 给 <el-table> 形式的歌曲列表加上：
 *  - 桌面端右键弹出菜单（@row-contextmenu）
 *  - 移动端长按弹出操作面板（容器上 v-longpress，按行分发）
 *
 * 用法：
 *   const { onRowContextMenu, onTableLongPress } = useSongTableMenu(songs);
 *   <div v-longpress="onTableLongPress">
 *     <el-table @row-contextmenu="onRowContextMenu" ...>
 */
export function useSongTableMenu(songs: Ref<any[]>) {
  const { openContextMenu, openActionSheet, songActions } = useItemActions();

  const subOf = (song: any) =>
    [song.artist, song.album].filter(Boolean).join(" · ");

  function onRowContextMenu(row: any, _column: any, event: MouseEvent) {
    if (!row) return;
    openContextMenu(event, songActions(row), row.title, subOf(row));
  }

  function onTableLongPress(target?: EventTarget | null) {
    const el = target as HTMLElement | null;
    const rowEl = el?.closest?.(".el-table__row") as HTMLElement | null;
    if (!rowEl || !rowEl.parentElement) return;
    const idx = Array.prototype.indexOf.call(rowEl.parentElement.children, rowEl);
    const song = songs.value[idx];
    if (!song) return;
    openActionSheet(songActions(song), song.title, subOf(song));
  }

  return { onRowContextMenu, onTableLongPress };
}
