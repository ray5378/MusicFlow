/**
 * 零依赖 QR 码编码器（纯计算，不 import 任何第三方包，不做文件/网络 IO）。
 *
 * 严格按 ISO/IEC 18004 实现以下能力：
 * - byte（8-bit）编码模式，输入按 UTF-8 编码
 * - ECC 等级 L / M / Q / H（默认 M）
 * - 版本 1-10 自适应（也支持显式指定）
 * - Reed-Solomon 纠错（GF(256)，本原多项式 0x11D）
 * - 块拆分与交织（含短块处理）
 * - 定位图案 + 分隔符、时序图案、暗模块、校正图案
 * - 格式信息 BCH(15,5)、版本信息 BCH(18,6)（版本 >= 7）
 * - 8 种掩码 + 标准惩罚打分自动选优；可显式覆写掩码
 */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrOptions {
  ecc?: QrEcc;
  /** 显式覆写掩码（0-7），格式信息会反映该掩码 */
  mask?: number;
  /** 四周留白模块数，默认 4 */
  border?: number;
  /** 显式指定版本（1-10），容量不够时抛错 */
  version?: number;
}

export interface QrSvgOptions extends QrOptions {
  moduleSize?: number;
  dark?: string;
  light?: string;
}

const MIN_VERSION = 1;
const MAX_VERSION = 10;
const ECC_LEVELS: readonly QrEcc[] = ["L", "M", "Q", "H"];

// ---------------------------------------------------------------------------
// GF(256) 与 Reed-Solomon
// ---------------------------------------------------------------------------

/** GF(256) 乘法，域多项式 0x11D */
function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** 生成 degree 次的 RS 生成多项式系数（低次在前） */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 2);
  }
  return result;
}

/** 计算数据码字除以生成多项式的余数（即 ECC 码字） */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = (b ^ (result.shift() as number)) & 0xff;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= rsMultiply(divisor[i], factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 版本 / 容量表（ISO/IEC 18004）
// ---------------------------------------------------------------------------

/** 每块 ECC 码字数，按 [L, M, Q, H] x [版本 1..10] */
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

/** RS 块数量，按 [L, M, Q, H] x [版本 1..10] */
const NUM_ECC_BLOCKS: Record<QrEcc, number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

/** 校正图案中心坐标（版本 1..10，索引 = version - 1） */
const ALIGNMENT_POSITIONS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** 格式信息中 ECC 等级对应的 2 bit：L=01, M=00, Q=11, H=10 */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** 版本的总数据模块数（不含格式/版本信息开销），按标准公式计算 */
function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver: number, ecc: QrEcc): number {
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][ver - 1] * NUM_ECC_BLOCKS[ecc][ver - 1]
  );
}

/** byte 模式下该版本/ECC 可容纳的最大 UTF-8 字节数 */
function maxByteLength(ver: number, ecc: QrEcc): number {
  const ccBits = ver <= 9 ? 8 : 16;
  return Math.floor((numDataCodewords(ver, ecc) * 8 - 4 - ccBits) / 8);
}

// ---------------------------------------------------------------------------
// 数据码字生成（byte 模式 + RS + 交织）
// ---------------------------------------------------------------------------

function makeDataCodewords(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const ccBits = version <= 9 ? 8 : 16;
  if (bytes.length > maxByteLength(version, ecc)) {
    throw new Error(
      `QR: ${bytes.length} 字节超出版本 ${version} / ECC ${ecc} 的容量（最多 ${maxByteLength(version, ecc)} 字节）`
    );
  }

  const bits: number[] = [];
  const appendBits = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  appendBits(0x4, 4); // byte 模式指示符 0100
  appendBits(bytes.length, ccBits);
  for (const b of bytes) appendBits(b, 8);

  // 终止符（最多 4 个 0）
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);
  // 填充码字 0xEC / 0x11 交替
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(pad, 8);
  }

  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

/** RS 纠错 + 块拆分 + 列优先交织 */
function addEccAndInterleave(data: number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_ECC_BLOCKS[ecc][version - 1];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version - 1];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(offset, offset + dataLen);
    offset += dataLen;
    const eccBytes = rsRemainder(dat, divisor);
    // 短块在数据尾部垫一个占位字节，保证所有块等长；交织时跳过
    const block = [...dat, ...(i < numShortBlocks ? [0] : []), ...eccBytes];
    blocks.push(block);
  }
  if (offset !== data.length) {
    throw new Error("QR: 数据码字长度与块结构不符（内部错误）");
  }

  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        out.push(blocks[j][i]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 矩阵构建
// ---------------------------------------------------------------------------

type SetFn = (x: number, y: number, dark: boolean) => void;

function drawFunctionPatterns(setFn: SetFn, version: number): void {
  const size = version * 4 + 17;

  // 定位图案（7x7）+ 分隔符（1 模块亮边），以 finder 中心为基准：
  // dist 0/1 = 深色中心，dist 2 = 白环，dist 3 = 外圈深色，dist 4 = 分隔符
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  // 时序图案
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0);
    setFn(6, i, i % 2 === 0);
  }

  // 校正图案（5x5），跳过与定位图案重叠的三处
  const positions = ALIGNMENT_POSITIONS[version - 1];
  const last = size - 7;
  for (const cy of positions) {
    for (const cx of positions) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cx === last && cy === 6)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // 暗模块
  setFn(8, size - 8, true);

  // 版本信息（版本 >= 7），BCH(18,6)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  // 预留格式信息区域（占位，稍后由 drawFormatBits 填入真实值）
  reserveFormatArea(setFn, size, () => false);
}

/** 按标准位置遍历全部 30 个格式信息槽位（两份各 15 bit，含重叠的 (8,8) 附近） */
function forEachFormatCell(size: number, fn: (x: number, y: number, i: number) => void): void {
  // 第一份：col 8, rows 0-5 / 7 / 8，以及 row 8, cols 5-0
  for (let i = 0; i <= 5; i++) fn(8, i, i);
  fn(8, 7, 6);
  fn(8, 8, 7);
  fn(7, 8, 8);
  for (let i = 9; i < 15; i++) fn(14 - i, 8, i);
  // 第二份：row 8, cols size-1..size-8，以及 col 8, rows size-7..size-1
  for (let i = 0; i < 8; i++) fn(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i++) fn(8, size - 15 + i, i);
}

function reserveFormatArea(setFn: SetFn, size: number, value: (i: number) => boolean): void {
  forEachFormatCell(size, (x, y, i) => setFn(x, y, value(i)));
}

/** 绘制格式信息：BCH(15,5)，数据 = eccBits<<3 | mask，掩码 0x5412 */
function drawFormatBits(setFn: SetFn, size: number, ecc: QrEcc, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  forEachFormatCell(size, (x, y, i) => setFn(x, y, ((bits >>> i) & 1) !== 0));
}

/** 之字形（zigzag）放入数据码字 */
function drawCodewords(
  modules: boolean[][],
  isFunction: boolean[][],
  codewords: number[],
  size: number
): void {
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) {
          if (bitIndex < totalBits) {
            modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
            bitIndex++;
          }
          // 码字位用尽后，剩余数据区模块保持 false（标准允许，且参与掩码翻转）
        }
      }
    }
  }
  if (bitIndex !== totalBits) {
    throw new Error("QR: 数据位未全部放入矩阵（内部错误）");
  }
}

/** 掩码函数（row = 行，col = 列），按 ISO/IEC 18004 第 8.8.2 节 */
function getMaskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
    default:
      throw new Error(`QR: 无效掩码编号 ${mask}`);
  }
}

function applyMask(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  mask: number
): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && getMaskBit(mask, y, x)) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

function buildMatrix(version: number, allCodewords: number[], ecc: QrEcc, mask: number): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = [];
  const isFunction: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    modules.push(new Array<boolean>(size).fill(false));
    isFunction.push(new Array<boolean>(size).fill(false));
  }
  const setFn: SetFn = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  drawFunctionPatterns(setFn, version);
  drawCodewords(modules, isFunction, allCodewords, size);
  applyMask(modules, isFunction, size, mask);
  drawFormatBits(setFn, size, ecc, mask);
  return modules;
}

// ---------------------------------------------------------------------------
// 掩码惩罚打分（ISO/IEC 18004 四条规则）
// ---------------------------------------------------------------------------

const FINDER_PATTERNS = ["00001011101", "10111010000"];

/** 在位串中统计 finder 类似模式（允许重叠） */
function countFinderLike(bitStr: string): number {
  let count = 0;
  for (const p of FINDER_PATTERNS) {
    let idx = bitStr.indexOf(p);
    while (idx !== -1) {
      count++;
      idx = bitStr.indexOf(p, idx + 1);
    }
  }
  return count;
}

function linePenalty(get: (i: number) => boolean, size: number): number {
  let penalty = 0;
  // 规则 1：连续同色模块
  let runColor = get(0);
  let runLen = 1;
  for (let i = 1; i < size; i++) {
    if (get(i) === runColor) {
      runLen++;
      if (runLen === 5) penalty += 3;
      else if (runLen > 5) penalty += 1;
    } else {
      runColor = get(i);
      runLen = 1;
    }
  }
  // 规则 3：1:1:3:1:1 finder 模式（两侧延伸 4 个亮模块）
  let s = "0000";
  for (let i = 0; i < size; i++) s += get(i) ? "1" : "0";
  s += "0000";
  penalty += countFinderLike(s) * 40;
  return penalty;
}

function computePenalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let result = 0;

  for (let y = 0; y < size; y++) {
    result += linePenalty((i) => matrix[y][i], size);
  }
  for (let x = 0; x < size; x++) {
    result += linePenalty((i) => matrix[i][x], size);
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = matrix[y][x];
      if (c === matrix[y][x + 1] && c === matrix[y + 1][x] && c === matrix[y + 1][x + 1]) {
        result += 3;
      }
    }
  }

  // 规则 4：深色模块比例
  let dark = 0;
  for (const row of matrix) {
    for (const m of row) {
      if (m) dark++;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(k, 0) * 10;

  return result;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

function pickVersion(byteLen: number, ecc: QrEcc): number {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    if (byteLen <= maxByteLength(v, ecc)) return v;
  }
  throw new Error(
    `QR: ${byteLen} 字节超出所有支持版本（1-${MAX_VERSION}）在 ECC ${ecc} 下的容量`
  );
}

function withBorder(matrix: boolean[][], border: number): boolean[][] {
  if (border === 0) return matrix;
  const size = matrix.length + border * 2;
  const out: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    out.push(new Array<boolean>(size).fill(false));
  }
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix.length; x++) {
      out[y + border][x + border] = matrix[y][x];
    }
  }
  return out;
}

/**
 * 将文本编码为 QR 模块矩阵。
 * 返回矩阵尺寸 = (版本边长 + 2*border)；true = 深色模块。
 */
export function encodeQrMatrix(text: string, opts?: QrOptions): boolean[][] {
  const ecc: QrEcc = opts?.ecc ?? "M";
  if (!ECC_LEVELS.includes(ecc)) {
    throw new Error(`QR: 无效 ECC 等级 "${ecc}"（应为 L/M/Q/H）`);
  }
  const mask = opts?.mask;
  if (mask !== undefined && (!Number.isInteger(mask) || mask < 0 || mask > 7)) {
    throw new Error(`QR: 无效掩码 ${mask}（应为 0-7）`);
  }
  const border = opts?.border ?? 4;
  if (!Number.isInteger(border) || border < 0) {
    throw new Error(`QR: 无效 border ${border}（应为非负整数）`);
  }

  const bytes = Buffer.from(text, "utf8");

  let version: number;
  if (opts?.version !== undefined) {
    version = opts.version;
    if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
      throw new Error(`QR: 版本必须在 ${MIN_VERSION}-${MAX_VERSION} 之间，收到 ${version}`);
    }
  } else {
    version = pickVersion(bytes.length, ecc);
  }

  const dataCodewords = makeDataCodewords(bytes, version, ecc);
  const allCodewords = addEccAndInterleave(dataCodewords, version, ecc);

  // 显式掩码：直接使用
  if (mask !== undefined) {
    return withBorder(buildMatrix(version, allCodewords, ecc, mask), border);
  }

  // 自动掩码：8 种掩码按惩罚打分取最优
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix: boolean[][] | null = null;
  for (let m = 0; m < 8; m++) {
    const matrix = buildMatrix(version, allCodewords, ecc, m);
    const penalty = computePenalty(matrix);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = m;
      bestMatrix = matrix;
    }
  }
  void bestMask;
  return withBorder(bestMatrix as boolean[][], border);
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 将文本编码为自包含 SVG 字符串（无外部引用、无脚本）。
 */
export function qrToSvg(text: string, opts?: QrSvgOptions): string {
  const moduleSize = opts?.moduleSize ?? 8;
  if (!Number.isFinite(moduleSize) || moduleSize <= 0) {
    throw new Error(`QR: 无效 moduleSize ${moduleSize}`);
  }
  const dark = opts?.dark ?? "#000000";
  const light = opts?.light ?? "#ffffff";
  const matrix = encodeQrMatrix(text, opts);
  const dim = matrix.length;
  const size = dim * moduleSize;

  let path = "";
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      if (matrix[y][x]) {
        path += `M${x * moduleSize} ${y * moduleSize}h${moduleSize}v${moduleSize}h${-moduleSize}z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${escapeXmlAttr(light)}"/>` +
    `<path d="${path}" fill="${escapeXmlAttr(dark)}"/>` +
    `</svg>`
  );
}
