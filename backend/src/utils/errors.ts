// ==================== 统一业务错误码 ====================
//
// 背景:业务 API 之前只有 `success:false + 中文 message`,前端只能匹配中文字符串,
// 脆弱且无分类。这里定义全库共享的 BusinessErrorCode 枚举,错误响应统一携带
// `code` 字段(保留 `message` 与 `success` 语义,向后兼容,前端可渐进消费 code)。
//
// 契约:
//   - 所有新代码/新端点必须用 apiError(code, message) 返回错误,禁止裸造
//     { success:false, error } 而不带 code。
//   - code 用**稳定字符串**而非数字(可读、可扩展、无版本冲突)。
//   - 鉴权失败(401/403)仍走 OpenSubsonic subsonic-response 格式(code 40/50),
//     不归本枚举管。
export enum BusinessErrorCode {
  /** 入参缺失 / 类型错误 / 越界(空值、非法枚举、数值范围) */
  INVALID_PARAM = "INVALID_PARAM",
  /** 资源不存在(id 查不到行) */
  NOT_FOUND = "NOT_FOUND",
  /** 状态冲突:正在运行 / 已存在 / 非法状态迁移(如重复扫描、重复导入) */
  CONFLICT = "CONFLICT",
  /** 资源被占用 / 超出并发上限(如批量锁被占、任务已在跑) */
  BUSY = "BUSY",
  /** 权限不足(非 admin 访问 admin 端点、跨用户访问) */
  FORBIDDEN = "FORBIDDEN",
  /** 外部依赖失败(插件调用 / 上游服务 / 网络) */
  UPSTREAM_ERROR = "UPSTREAM_ERROR",
  /** 未预期异常(兜底,通常伴随 Error 日志) */
  INTERNAL = "INTERNAL",
}

/** 业务 API 错误响应体(与既有 { success:false, error } 兼容,新增 code 字段)。 */
export interface ApiErrorBody {
  success: false;
  code: BusinessErrorCode;
  error: string;
}

/** 构造统一业务错误响应体。message 保持中文可读(前端既有匹配不受影响)。 */
export function apiError(code: BusinessErrorCode, message: string): ApiErrorBody {
  return { success: false, code, error: message };
}

/** 构造统一成功响应体(可选附加 data)。 */
export function apiOk(data?: Record<string, unknown>): { success: true } & Record<string, unknown> {
  return { success: true, ...(data || {}) };
}
