// ==================== Sendspin 配对记录存储 ====================
//
// pairing_store.json (MA 同款布局,放 MUSICFLOW_DATA_DIR/sendspin/ 下):
//   records: client_id → { psk(hex 64), psk_id(b64url), createdAt, lastUsedAt }
//   unpairedApproved: client_id → approvedAt(ms,运营商手工批准未配对访问)
// 长配对 PSK 用于握手 msg1 的 psk_id 引用;未配对批准供前端展示/后续门控。
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha256.js";
import { b64urlEncode } from "./util.js";

export interface PairingRecord {
  pskHex: string; // 64 hex chars
  pskId: string; // b64url(sha256("sendspin-psk-id-v1" + psk))
  createdAt: number;
  lastUsedAt: number;
}

interface StoreFile {
  records: Record<string, PairingRecord>;
  unpairedApproved: Record<string, number>;
}

export function pskIdForHex(pskHex: string): string {
  // 与 aiosendspin psk_id_for 一致:psk_id = b64url(sha256("sendspin-psk-id-v1" || psk))
  const psk = Buffer.from(pskHex, "hex");
  const d = sha256(new Uint8Array([...Buffer.from("sendspin-psk-id-v1", "utf8"), ...psk]));
  return b64urlEncode(d);
}

export class PairingStore {
  private file: string;
  private records = new Map<string, PairingRecord>();
  private approved = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(file: string) {
    this.file = file;
  }

  static async open(dir: string): Promise<PairingStore> {
    const file = path.join(dir, "sendspin", "pairing_store.json");
    const st = new PairingStore(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<StoreFile>;
      for (const [k, v] of Object.entries(raw.records ?? {})) {
        if (v && typeof v.pskHex === "string" && v.pskHex.length === 64) st.records.set(k, v as PairingRecord);
      }
      for (const [k, v] of Object.entries(raw.unpairedApproved ?? {})) {
        if (typeof v === "number") st.approved.set(k, v);
      }
    } catch { /* 缺文件即空库 */ }
    return st;
  }

  getRecord(clientId: string): PairingRecord | undefined {
    return this.records.get(clientId);
  }

  listRecords(): Array<{ clientId: string } & PairingRecord> {
    return [...this.records.entries()].map(([clientId, r]) => ({ clientId, ...r }));
  }

  async putRecord(clientId: string, pskHex: string): Promise<PairingRecord> {
    const now = Date.now();
    const rec: PairingRecord = {
      pskHex,
      pskId: pskIdForHex(pskHex),
      createdAt: this.records.get(clientId)?.createdAt ?? now,
      lastUsedAt: now,
    };
    this.records.set(clientId, rec);
    // 配对成功即丢弃未配对批准(见 spec:批准 MUST be discarded on pairing)
    this.approved.delete(clientId);
    this.scheduleSave();
    return rec;
  }

  async touchRecord(clientId: string): Promise<void> {
    const r = this.records.get(clientId);
    if (r) {
      r.lastUsedAt = Date.now();
      this.scheduleSave();
    }
  }

  async removeRecord(clientId: string): Promise<boolean> {
    const ok = this.records.delete(clientId);
    if (ok) this.scheduleSave();
    return ok;
  }

  isApproved(clientId: string): boolean {
    return this.approved.has(clientId);
  }

  listApproved(): Array<{ clientId: string; approvedAt: number }> {
    return [...this.approved.entries()].map(([clientId, approvedAt]) => ({ clientId, approvedAt }));
  }

  async setApproved(clientId: string, approved: boolean): Promise<void> {
    if (approved) this.approved.set(clientId, Date.now());
    else this.approved.delete(clientId);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const data: StoreFile = {
        records: Object.fromEntries(this.records),
        unpairedApproved: Object.fromEntries(this.approved),
      };
      fs.writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600 }).catch(() => {});
    }, 200);
  }
}
