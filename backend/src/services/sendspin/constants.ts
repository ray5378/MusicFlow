export const PROTOCOL_VERSION = 1;
export const WS_PATH = "/sendspin";
export const WS_PORT = 8927;
export const LEGACY_WS_PORT = 8928;
export const MDNS_TYPE_SERVER = "sendspin-server"; // _sendspin-server._tcp.local.
export const MDNS_TYPE_CLIENT = "sendspin"; // _sendspin._tcp.local.

export type NoiseSuite = "25519_ChaChaPoly_SHA256" | "25519_AESGCM_SHA256";
export const NOISE_SUITES: NoiseSuite[] = ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"];

export const SENTINEL_PSK_HEX = "1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3";
export const SENTINEL_PSK_ID_HEX = "185b15f6d2da4909bd1dc156a4ab206103abef0153bcd52d926170b95cf7ce8a";

export const MAX_TRANSPORT_PLAINTEXT = 65519; // 65535 - 16 (AEAD tag)
export const MAX_FRAGMENT_FIRST = MAX_TRANSPORT_PLAINTEXT - 2;
export const MAX_FRAGMENT_NEXT = MAX_TRANSPORT_PLAINTEXT - 1;
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** 解密后 plaintext[0] 类型字节 */
export const BIN_JSON = 0;
export const BIN_FRAGMENT_MORE = 2;
export const BIN_FRAGMENT_END = 3;
export const BIN_PLAYER_AUDIO = 4; // 0x04
export const BIN_ARTWORK_BASE = 8; // 8..11
export const BIN_SOURCE_AUDIO = 12;
export const BIN_VISUALIZER_BASE = 16; // 16..21

export type PskCategory = "lt" | "pr" | "sn";