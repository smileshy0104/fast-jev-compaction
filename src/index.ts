// 这里是本包对外导出的唯一入口（package.json 的 `exports` 指向 `dist/index.js`）：
// 逐层把「类型定义 → HTTP 请求构造/校验 → Jev 客户端 → state 拟合 →
// 压缩主流程 → 便捷函数」全部重导出，使用者只需 `import ... from 'fast-jev-compaction'`。
//
// 注意：修改本文件即修改公共 API 面，新增/移除导出属于破坏性变更。
export * from './types.js';
export * from './request.js';
export * from './client.js';
export * from './state.js';
export * from './compact.js';
export * from './messages.js';
