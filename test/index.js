/**
 * test/index.js — 测试聚合入口（只为让 `node --test test/` 在 Node 24 下可用）
 * ============================================================================
 * Node 24 的 test runner 把位置参数当 **glob 模式**处理，不再自动展开目录：
 * `node --test test/` 会把 `test` 目录本身当成一个测试文件去 spawn，
 * 报 `Cannot find module ...\test`。这个目录没有自己的包，Node 的目录入口
 * 解析会落到 `test/index.js`，于是这里把两个测试文件聚合进来。
 *
 * 等价运行方式（任选其一）：
 *   node --test test/                 # 本文件聚合，33 条
 *   node --test test/store.test.mjs
 *   node --test test/guard.test.mjs
 *   node --test "test/*.test.mjs"
 * 注意：`node --test`（不带参数、自动发现）会同时发现 index.js 与两个测试文件，
 * 结果仍全部通过，只是测试数会翻倍（33→66）；CI 请用上面带路径的写法。
 * ============================================================================
 */
import './store.test.mjs'
import './guard.test.mjs'
